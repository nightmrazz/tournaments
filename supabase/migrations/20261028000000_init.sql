-- temcch tournaments — EA SPORTS FC 27 tournament platform
-- Schema, integrity constraints, Row Level Security and server-side procedures.
--
-- Security model
--   * Everyone (anon) can read tournaments that are not drafts, plus their participants,
--     groups and matches. Contact details live in a separate table only managers can read.
--   * Only users whose profiles.role is 'organizer' or 'admin' can create tournaments.
--     Roles can NOT be changed by users themselves (column privilege + trigger); they are
--     assigned with the service role (SQL editor) or by an admin via set_user_role().
--   * A tournament is managed by its owner, explicit co-managers (tournament_managers) and admins.
--   * Groups, group members and matches are never written directly by clients: all structural
--     changes go through apply_tournament_mutation(), which checks permissions, locks the
--     tournament row, verifies the expected version (optimistic concurrency) and applies the
--     whole change in one transaction. Table constraints reject invalid data regardless of caller.
--   * Self-registration goes through register_for_tournament(), which enforces status, deadline,
--     capacity and duplicates under a row lock.

-- gen_random_uuid() is built into PostgreSQL 13+, so no extension is required.

-- ---------------------------------------------------------------- profiles

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 40),
  role text not null default 'user' check (role in ('user', 'organizer', 'admin')),
  created_at timestamptz not null default now()
);

-- Users may only change their display name, never their role.
revoke update on public.profiles from authenticated, anon;
grant update (display_name) on public.profiles to authenticated;

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1), ''), 40))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.current_role_name() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()), 'anon')
$$;

create or replace function public.is_organizer() returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_role_name() in ('organizer', 'admin')
$$;

-- Belt and braces: even a privileged grant mistake cannot let a user change their own role.
create or replace function public.guard_profile_role() returns trigger
language plpgsql as $$
begin
  if new.role is distinct from old.role and auth.uid() is not null and current_setting('app.role_change', true) is distinct from 'allowed' then
    raise exception 'Roles can only be assigned by an administrator' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard_role before update on public.profiles
  for each row execute function public.guard_profile_role();

-- Admin-only role assignment.
create or replace function public.set_user_role(p_user_id uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role_name() <> 'admin' then
    raise exception 'Only administrators can assign roles' using errcode = '42501';
  end if;
  if p_role not in ('user', 'organizer', 'admin') then
    raise exception 'Unknown role %', p_role using errcode = '22023';
  end if;
  perform set_config('app.role_change', 'allowed', true);
  update public.profiles set role = p_role where id = p_user_id;
end $$;

-- ------------------------------------------------------------- tournaments

create table public.tournaments (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users (id) on delete restrict,
  name text not null check (char_length(name) between 3 and 80),
  description text not null default '' check (char_length(description) <= 2000),
  rules text not null default '' check (char_length(rules) <= 5000),
  venue text not null default '' check (char_length(venue) <= 120),
  starts_at timestamptz,
  registration_deadline timestamptz,
  format text not null check (format in ('groups_knockout', 'single_elimination')),
  status text not null default 'draft'
    check (status in ('draft', 'registration_open', 'registration_closed', 'in_progress', 'completed', 'cancelled')),
  max_participants int not null check (max_participants between 2 and 256),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  version int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tournaments_status_idx on public.tournaments (status, starts_at);

create table public.tournament_managers (
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);

create or replace function public.can_manage(p_tournament_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    exists (select 1 from public.tournaments t where t.id = p_tournament_id and t.owner_id = auth.uid())
    or exists (select 1 from public.tournament_managers m where m.tournament_id = p_tournament_id and m.user_id = auth.uid())
    or public.current_role_name() = 'admin'
  )
$$;

create or replace function public.tournament_visible(p_tournament_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.tournaments t where t.id = p_tournament_id and t.status <> 'draft')
      or public.can_manage(p_tournament_id)
$$;

-- Server-side guard for direct updates (settings, status, details).
create or replace function public.guard_tournament_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  has_matches boolean;
  n_participants int;
begin
  if new.owner_id <> old.owner_id then
    raise exception 'Ownership cannot be changed' using errcode = '42501';
  end if;
  new.created_at := old.created_at;
  new.updated_at := now();
  select exists (select 1 from public.matches where tournament_id = new.id) into has_matches;
  if has_matches and (new.format <> old.format or new.settings is distinct from old.settings and (
      new.settings -> 'groupCount' is distinct from old.settings -> 'groupCount'
      or new.settings -> 'advancePerGroup' is distinct from old.settings -> 'advancePerGroup'
      or new.settings -> 'doubleRoundRobin' is distinct from old.settings -> 'doubleRoundRobin'
      or new.settings -> 'thirdPlaceMatch' is distinct from old.settings -> 'thirdPlaceMatch')) then
    raise exception 'Format and structure settings cannot change after fixtures exist' using errcode = '22023';
  end if;
  select count(*) into n_participants from public.participants where tournament_id = new.id;
  if new.max_participants < n_participants then
    raise exception 'Capacity cannot be lower than the current number of participants (%)', n_participants using errcode = '22023';
  end if;
  if new.status <> old.status then
    if not (
      (old.status = 'draft' and new.status in ('registration_open', 'registration_closed', 'cancelled')) or
      (old.status = 'registration_open' and new.status in ('registration_closed', 'draft', 'cancelled')) or
      (old.status = 'registration_closed' and new.status in ('registration_open', 'in_progress', 'cancelled')) or
      (old.status = 'in_progress' and new.status in ('completed', 'cancelled', 'registration_closed')) or
      (old.status = 'completed' and new.status = 'in_progress')
    ) then
      raise exception 'Invalid status change from % to %', old.status, new.status using errcode = '22023';
    end if;
    if new.status in ('registration_open', 'draft') and has_matches then
      raise exception 'Reset fixtures before reopening registration' using errcode = '22023';
    end if;
    if new.status = 'in_progress' and old.status = 'registration_closed' and not has_matches
       and current_setting('app.structural_change', true) is distinct from 'allowed' then
      raise exception 'Generate fixtures to start the tournament' using errcode = '22023';
    end if;
    if new.status = 'completed' and exists (
      select 1 from public.matches where tournament_id = new.id and stage = 'knockout' and status <> 'completed'
    ) or new.status = 'completed' and not exists (
      select 1 from public.matches where tournament_id = new.id and stage = 'knockout'
    ) then
      raise exception 'All knockout matches must be completed first' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger tournaments_guard before update on public.tournaments
  for each row execute function public.guard_tournament_update();

-- ------------------------------------------------------------ participants

create table public.participants (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  display_name text not null check (char_length(trim(display_name)) between 2 and 32),
  gamertag text not null check (char_length(trim(gamertag)) between 2 and 32),
  seed int check (seed between 1 and 256),
  user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tournament_id, id)
);
create unique index participants_tag_unique on public.participants (tournament_id, lower(trim(gamertag)));
create unique index participants_user_unique on public.participants (tournament_id, user_id) where user_id is not null;

-- Private: only managers and the participant themself can read it.
create table public.participant_contacts (
  participant_id uuid primary key references public.participants (id) on delete cascade,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  contact text not null check (char_length(contact) between 1 and 120)
);

create or replace function public.guard_participant_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  n int;
begin
  -- Rows removed by a cascading tournament delete need no checks.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  -- Lock the tournament so concurrent registrations cannot exceed capacity.
  select * into t from public.tournaments where id = coalesce(new.tournament_id, old.tournament_id) for update;
  if t.status in ('in_progress', 'completed', 'cancelled') or exists (select 1 from public.matches where tournament_id = t.id) then
    raise exception 'Participants cannot change after fixtures have been generated' using errcode = '22023';
  end if;
  if tg_op = 'INSERT' then
    select count(*) into n from public.participants where tournament_id = t.id;
    if n >= t.max_participants then
      raise exception 'This tournament is full' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'UPDATE' and (new.tournament_id <> old.tournament_id or new.user_id is distinct from old.user_id) then
    raise exception 'Participant ownership cannot change' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger participants_guard before insert or update or delete on public.participants
  for each row execute function public.guard_participant_change();

-- --------------------------------------------------------- groups & matches

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  name text not null check (char_length(name) <= 20),
  index int not null check (index >= 0),
  unique (tournament_id, index),
  unique (tournament_id, id)
);

create table public.group_members (
  group_id uuid not null,
  participant_id uuid not null,
  tournament_id uuid not null,
  position int not null check (position >= 0),
  primary key (group_id, participant_id),
  -- A participant can only be in one group per tournament.
  unique (tournament_id, participant_id),
  foreign key (tournament_id, group_id) references public.groups (tournament_id, id) on delete cascade,
  -- Cascade only matters when a whole tournament is deleted; single deletions are blocked by guard_participant_change once fixtures exist.
  foreign key (tournament_id, participant_id) references public.participants (tournament_id, id) on delete cascade
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  stage text not null check (stage in ('group', 'knockout')),
  group_id uuid,
  round int not null check (round >= 1),
  slot int not null check (slot >= 0),
  is_third_place boolean not null default false,
  home_id uuid,
  away_id uuid,
  home_score int check (home_score between 0 and 99),
  away_score int check (away_score between 0 and 99),
  home_pens int check (home_pens between 0 and 99),
  away_pens int check (away_pens between 0 and 99),
  winner_id uuid,
  walkover boolean not null default false,
  status text not null default 'scheduled' check (status in ('scheduled', 'in_progress', 'completed', 'postponed', 'cancelled')),
  scheduled_at timestamptz,
  station text check (char_length(station) <= 40),
  next_match_id uuid references public.matches (id) on delete set null deferrable initially deferred,
  next_slot text check (next_slot in ('home', 'away')),
  loser_next_match_id uuid references public.matches (id) on delete set null deferrable initially deferred,
  loser_next_slot text check (loser_next_slot in ('home', 'away')),
  updated_at timestamptz not null default now(),
  foreign key (tournament_id, group_id) references public.groups (tournament_id, id) on delete cascade,
  foreign key (tournament_id, home_id) references public.participants (tournament_id, id) on delete cascade,
  foreign key (tournament_id, away_id) references public.participants (tournament_id, id) on delete cascade,
  foreign key (tournament_id, winner_id) references public.participants (tournament_id, id) on delete cascade,
  constraint matches_distinct_sides check (home_id is null or away_id is null or home_id <> away_id),
  constraint matches_stage_group check ((stage = 'group') = (group_id is not null)),
  constraint matches_completed_has_score check (
    status <> 'completed' or (home_id is not null and away_id is not null and home_score is not null and away_score is not null)),
  constraint matches_winner_is_participant check (winner_id is null or winner_id = home_id or winner_id = away_id),
  constraint matches_knockout_winner check (stage <> 'knockout' or status <> 'completed' or winner_id is not null),
  constraint matches_pens_only_level_knockout check (
    (home_pens is null and away_pens is null) or
    (stage = 'knockout' and home_pens is not null and away_pens is not null and home_score = away_score and home_pens <> away_pens)),
  constraint matches_winner_consistent check (
    winner_id is null or walkover or
    (home_score > away_score and winner_id = home_id) or (away_score > home_score and winner_id = away_id) or
    (home_score = away_score and home_pens is not null and
      ((home_pens > away_pens and winner_id = home_id) or (away_pens > home_pens and winner_id = away_id))))
);
-- No duplicate fixtures in the same position.
create unique index matches_position_unique on public.matches (
  tournament_id, stage, coalesce(group_id, '00000000-0000-0000-0000-000000000000'::uuid), round, slot, is_third_place);
-- No pair plays twice in the same group matchday list (single round robin): same pair + same group + same orientation.
create unique index matches_group_pair_unique on public.matches (group_id, home_id, away_id) where stage = 'group';
create index matches_tournament_idx on public.matches (tournament_id, stage, round);

-- Audit trail for result changes (who changed what, when).
create table public.match_result_audit (
  id bigint generated always as identity primary key,
  match_id uuid not null,
  tournament_id uuid not null references public.tournaments (id) on delete cascade,
  changed_by uuid,
  changed_at timestamptz not null default now(),
  old_result jsonb,
  new_result jsonb
);

create or replace function public.audit_match_result() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if (old.home_score, old.away_score, old.home_pens, old.away_pens, old.winner_id, old.status, old.walkover)
     is distinct from (new.home_score, new.away_score, new.home_pens, new.away_pens, new.winner_id, new.status, new.walkover) then
    insert into public.match_result_audit (match_id, tournament_id, changed_by, old_result, new_result)
    values (new.id, new.tournament_id, auth.uid(),
      jsonb_build_object('home', old.home_id, 'away', old.away_id, 'home_score', old.home_score, 'away_score', old.away_score,
        'home_pens', old.home_pens, 'away_pens', old.away_pens, 'winner', old.winner_id, 'status', old.status),
      jsonb_build_object('home', new.home_id, 'away', new.away_id, 'home_score', new.home_score, 'away_score', new.away_score,
        'home_pens', new.home_pens, 'away_pens', new.away_pens, 'winner', new.winner_id, 'status', new.status));
  end if;
  return new;
end $$;
create trigger matches_audit after update on public.matches
  for each row execute function public.audit_match_result();

-- ------------------------------------------------------------------- RLS

alter table public.profiles enable row level security;
alter table public.tournaments enable row level security;
alter table public.tournament_managers enable row level security;
alter table public.participants enable row level security;
alter table public.participant_contacts enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.matches enable row level security;
alter table public.match_result_audit enable row level security;

create policy profiles_select_self on public.profiles for select using (id = auth.uid() or public.current_role_name() = 'admin');
create policy profiles_update_self on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

-- owner_id is checked inline because can_manage() cannot see a row inside its own INSERT ... RETURNING.
create policy tournaments_select on public.tournaments for select
  using (status <> 'draft' or owner_id = auth.uid() or public.can_manage(id));
create policy tournaments_insert on public.tournaments for insert to authenticated
  with check (public.is_organizer() and owner_id = auth.uid() and version = 1);
create policy tournaments_update on public.tournaments for update to authenticated
  using (public.can_manage(id)) with check (public.can_manage(id));
create policy tournaments_delete on public.tournaments for delete to authenticated
  using (owner_id = auth.uid() or public.current_role_name() = 'admin');

create policy managers_select on public.tournament_managers for select to authenticated using (public.can_manage(tournament_id));
create policy managers_write on public.tournament_managers for all to authenticated
  using (exists (select 1 from public.tournaments t where t.id = tournament_id and t.owner_id = auth.uid()))
  with check (exists (select 1 from public.tournaments t where t.id = tournament_id and t.owner_id = auth.uid()));

create policy participants_select on public.participants for select using (public.tournament_visible(tournament_id));
create policy participants_insert on public.participants for insert to authenticated with check (public.can_manage(tournament_id));
create policy participants_update on public.participants for update to authenticated
  using (public.can_manage(tournament_id)) with check (public.can_manage(tournament_id));
create policy participants_delete on public.participants for delete to authenticated using (public.can_manage(tournament_id));

create policy contacts_select on public.participant_contacts for select to authenticated using (
  public.can_manage(tournament_id)
  or exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid()));
create policy contacts_write on public.participant_contacts for all to authenticated
  using (public.can_manage(tournament_id)) with check (public.can_manage(tournament_id));

create policy groups_select on public.groups for select using (public.tournament_visible(tournament_id));
create policy group_members_select on public.group_members for select using (public.tournament_visible(tournament_id));
create policy matches_select on public.matches for select using (public.tournament_visible(tournament_id));
create policy audit_select on public.match_result_audit for select to authenticated using (public.can_manage(tournament_id));
-- No insert/update/delete policies on groups, group_members, matches and audit:
-- clients cannot write them directly; apply_tournament_mutation() is the only path.

-- ------------------------------------------------------------ procedures

create or replace function public.register_for_tournament(
  p_tournament_id uuid, p_display_name text, p_gamertag text, p_contact text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  n int;
  pid uuid;
begin
  if auth.uid() is null then
    raise exception 'Sign in to register' using errcode = '42501';
  end if;
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found or t.status = 'draft' then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if t.status = 'cancelled' then raise exception 'This tournament has been cancelled.' using errcode = '22023'; end if;
  if t.status <> 'registration_open' then raise exception 'Registration is currently closed.' using errcode = '22023'; end if;
  if t.registration_deadline is not null and t.registration_deadline < now() then
    raise exception 'The registration deadline has passed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.participants where tournament_id = t.id and user_id = auth.uid()) then
    raise exception 'You are already registered for this tournament.' using errcode = '23505';
  end if;
  if exists (select 1 from public.participants where tournament_id = t.id and lower(trim(gamertag)) = lower(trim(p_gamertag))) then
    raise exception 'This EA SPORTS FC username is already registered.' using errcode = '23505';
  end if;
  select count(*) into n from public.participants where tournament_id = t.id;
  if n >= t.max_participants then raise exception 'This tournament is full.' using errcode = '22023'; end if;
  if coalesce((t.settings ->> 'requireContact')::boolean, false) and coalesce(trim(p_contact), '') = '' then
    raise exception 'The organizer requires contact information.' using errcode = '22023';
  end if;
  insert into public.participants (tournament_id, display_name, gamertag, user_id)
  values (t.id, trim(p_display_name), trim(p_gamertag), auth.uid()) returning id into pid;
  if coalesce(trim(p_contact), '') <> '' then
    insert into public.participant_contacts (participant_id, tournament_id, contact) values (pid, t.id, trim(p_contact));
  end if;
  return pid;
end $$;

create or replace function public.withdraw_registration(p_tournament_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'Sign in first' using errcode = '42501'; end if;
  delete from public.participants where tournament_id = p_tournament_id and user_id = auth.uid();
end $$;

/*
  Applies a structural change computed by the tournament engine (src/engine/commands.ts):
  {
    "insert_groups":  [ {id, name, index} ],
    "insert_members": [ {group_id, participant_id, position} ],
    "insert_matches": [ {match row in snake_case} ],
    "update_matches": [ {match row in snake_case} ],
    "delete_match_ids": [uuid], "delete_group_ids": [uuid],
    "tournament_status": "in_progress" | null
  }
  Every row is forced into p_tournament_id, so a manager of one tournament can never touch another.
*/
create or replace function public.apply_tournament_mutation(
  p_tournament_id uuid, p_expected_version int, p_mutation jsonb
) returns int
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  r jsonb;
  new_version int;
begin
  if not public.can_manage(p_tournament_id) then
    raise exception 'You are not allowed to manage this tournament' using errcode = '42501';
  end if;
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found then raise exception 'Tournament not found' using errcode = 'P0002'; end if;
  if t.version <> p_expected_version then
    raise exception 'This tournament was changed by someone else. Reload and try again.' using errcode = '40001';
  end if;
  if t.status in ('completed', 'cancelled') then
    raise exception 'This tournament is closed for changes' using errcode = '22023';
  end if;

  delete from public.matches where tournament_id = t.id
    and id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p_mutation -> 'delete_match_ids', '[]')) x);
  delete from public.groups where tournament_id = t.id
    and id in (select (x #>> '{}')::uuid from jsonb_array_elements(coalesce(p_mutation -> 'delete_group_ids', '[]')) x);

  for r in select * from jsonb_array_elements(coalesce(p_mutation -> 'insert_groups', '[]')) loop
    insert into public.groups (id, tournament_id, name, index)
    values ((r ->> 'id')::uuid, t.id, r ->> 'name', (r ->> 'index')::int);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_mutation -> 'insert_members', '[]')) loop
    insert into public.group_members (group_id, participant_id, tournament_id, position)
    values ((r ->> 'group_id')::uuid, (r ->> 'participant_id')::uuid, t.id, (r ->> 'position')::int);
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_mutation -> 'insert_matches', '[]')) loop
    insert into public.matches (id, tournament_id, stage, group_id, round, slot, is_third_place, home_id, away_id,
      home_score, away_score, home_pens, away_pens, winner_id, walkover, status, scheduled_at, station,
      next_match_id, next_slot, loser_next_match_id, loser_next_slot, updated_at)
    values ((r ->> 'id')::uuid, t.id, r ->> 'stage', (r ->> 'group_id')::uuid, (r ->> 'round')::int, (r ->> 'slot')::int,
      coalesce((r ->> 'is_third_place')::boolean, false), (r ->> 'home_id')::uuid, (r ->> 'away_id')::uuid,
      (r ->> 'home_score')::int, (r ->> 'away_score')::int, (r ->> 'home_pens')::int, (r ->> 'away_pens')::int,
      (r ->> 'winner_id')::uuid, coalesce((r ->> 'walkover')::boolean, false), coalesce(r ->> 'status', 'scheduled'),
      (r ->> 'scheduled_at')::timestamptz, r ->> 'station', (r ->> 'next_match_id')::uuid, r ->> 'next_slot',
      (r ->> 'loser_next_match_id')::uuid, r ->> 'loser_next_slot', now());
  end loop;
  for r in select * from jsonb_array_elements(coalesce(p_mutation -> 'update_matches', '[]')) loop
    update public.matches set
      home_id = (r ->> 'home_id')::uuid, away_id = (r ->> 'away_id')::uuid,
      home_score = (r ->> 'home_score')::int, away_score = (r ->> 'away_score')::int,
      home_pens = (r ->> 'home_pens')::int, away_pens = (r ->> 'away_pens')::int,
      winner_id = (r ->> 'winner_id')::uuid, walkover = coalesce((r ->> 'walkover')::boolean, false),
      status = r ->> 'status', scheduled_at = (r ->> 'scheduled_at')::timestamptz, station = r ->> 'station',
      updated_at = now()
    where id = (r ->> 'id')::uuid and tournament_id = t.id;
    if not found then raise exception 'Match % does not belong to this tournament', r ->> 'id' using errcode = '22023'; end if;
  end loop;

  -- Knockout wiring must stay inside the tournament.
  if exists (
    select 1 from public.matches m
    left join public.matches n on n.id = m.next_match_id
    left join public.matches l on l.id = m.loser_next_match_id
    where m.tournament_id = t.id and ((m.next_match_id is not null and n.tournament_id is distinct from t.id)
      or (m.loser_next_match_id is not null and l.tournament_id is distinct from t.id))
  ) then
    raise exception 'Invalid bracket wiring' using errcode = '22023';
  end if;

  perform set_config('app.structural_change', 'allowed', true);
  new_version := t.version + 1;
  update public.tournaments set
    version = new_version,
    status = coalesce(p_mutation ->> 'tournament_status', status)
  where id = t.id;
  return new_version;
end $$;

-- Only the procedures above are callable by clients; everything else is internal.
revoke execute on function public.set_user_role(uuid, text) from anon;
revoke execute on function public.register_for_tournament(uuid, text, text, text) from anon;
revoke execute on function public.withdraw_registration(uuid) from anon;
revoke execute on function public.apply_tournament_mutation(uuid, int, jsonb) from anon;
