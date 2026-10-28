-- Teams assigned by the organizer, and registration by display name only (no in-game id field).

alter table public.participants
  add column team text check (team is null or char_length(trim(team)) between 1 and 40);

-- gamertag is kept as a column (filled with the display name) so existing data and the unique
-- index keep working; display names must now be unique per tournament as well.
create unique index participants_name_unique on public.participants (tournament_id, lower(trim(display_name)));

-- Same guard as before, plus the team rule: the organizer assigns teams (clubs) only AFTER the
-- draw (i.e. once fixtures exist) and may change them until the tournament is completed or
-- cancelled. Changing ONLY the team is therefore the one update allowed once fixtures exist.
create or replace function public.guard_participant_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  n int;
begin
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 then
    return old;
  end if;
  select * into t from public.tournaments where id = coalesce(new.tournament_id, old.tournament_id) for update;
  if tg_op = 'INSERT' and new.team is not null then
    raise exception 'Teams are assigned after the draw.' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and new.team is distinct from old.team then
    if t.status in ('completed', 'cancelled') then
      raise exception 'This tournament is closed.' using errcode = '22023';
    end if;
    if not exists (select 1 from public.matches where tournament_id = t.id) then
      raise exception 'Teams are assigned after the draw.' using errcode = '22023';
    end if;
  end if;
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'team') = (to_jsonb(old) - 'team') then
    return new;
  end if;
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

create or replace function public.register_for_tournament(
  p_tournament_id uuid, p_display_name text, p_gamertag text default null, p_contact text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
  n int;
  pid uuid;
  v_name text := trim(p_display_name);
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
  if exists (select 1 from public.participants where tournament_id = t.id
             and (lower(trim(display_name)) = lower(v_name) or lower(trim(gamertag)) = lower(v_name))) then
    raise exception 'This name is already registered.' using errcode = '23505';
  end if;
  select count(*) into n from public.participants where tournament_id = t.id;
  if n >= t.max_participants then raise exception 'This tournament is full.' using errcode = '22023'; end if;
  if coalesce((t.settings ->> 'requireContact')::boolean, false) and coalesce(trim(p_contact), '') = '' then
    raise exception 'The organizer requires contact information.' using errcode = '22023';
  end if;
  insert into public.participants (tournament_id, display_name, gamertag, user_id)
  values (t.id, v_name, v_name, auth.uid()) returning id into pid;
  if coalesce(trim(p_contact), '') <> '' then
    insert into public.participant_contacts (participant_id, tournament_id, contact) values (pid, t.id, trim(p_contact));
  end if;
  return pid;
end $$;

revoke execute on function public.register_for_tournament(uuid, text, text, text) from anon;
