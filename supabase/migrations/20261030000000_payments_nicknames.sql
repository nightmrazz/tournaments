-- Paid registration (applications confirmed manually by the organizer) and self-service nicknames.
--
-- Payment flow
--   * register_for_tournament() creates an application with payment_status 'awaiting_payment' when the
--     tournament's settings.requirePayment is true, otherwise 'confirmed'.
--   * The applicant calls mark_receipt_sent() → 'awaiting_review' (only for their own application).
--   * The organizer sets 'confirmed' or 'rejected' with a normal UPDATE (RLS: managers only).
--   * Only confirmed rows are participants: they count toward capacity and are publicly visible.
--     Applicants see their own row; managers see all.

alter table public.participants
  add column payment_status text not null default 'confirmed'
  check (payment_status in ('awaiting_payment', 'awaiting_review', 'confirmed', 'rejected'));

-- The short application ID shown to players is the first 8 hex chars of the UUID; keep it unique.
create unique index participants_application_code_unique on public.participants (upper(left(id::text, 8)));

drop policy participants_select on public.participants;
create policy participants_select on public.participants for select using (
  public.tournament_visible(tournament_id)
  and (payment_status = 'confirmed' or user_id = auth.uid() or public.can_manage(tournament_id))
);

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
  -- Capacity counts confirmed participants only.
  if tg_op in ('INSERT', 'UPDATE') and new.payment_status = 'confirmed'
     and (tg_op = 'INSERT' or old.payment_status <> 'confirmed') then
    select count(*) into n from public.participants
      where tournament_id = t.id and payment_status = 'confirmed' and id <> new.id;
    if n >= t.max_participants then
      raise exception 'This tournament is full.' using errcode = '22023';
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
  v_status text;
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
  select count(*) into n from public.participants where tournament_id = t.id and payment_status = 'confirmed';
  if n >= t.max_participants then raise exception 'This tournament is full.' using errcode = '22023'; end if;
  if coalesce((t.settings ->> 'requireContact')::boolean, false) and coalesce(trim(p_contact), '') = '' then
    raise exception 'The organizer requires contact information.' using errcode = '22023';
  end if;
  v_status := case when coalesce((t.settings ->> 'requirePayment')::boolean, false) then 'awaiting_payment' else 'confirmed' end;
  insert into public.participants (tournament_id, display_name, gamertag, user_id, payment_status)
  values (t.id, v_name, v_name, auth.uid(), v_status) returning id into pid;
  if coalesce(trim(p_contact), '') <> '' then
    insert into public.participant_contacts (participant_id, tournament_id, contact) values (pid, t.id, trim(p_contact));
  end if;
  return pid;
end $$;

-- The applicant reports that the receipt was sent. Never lets anyone confirm themselves.
create or replace function public.mark_receipt_sent(p_participant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.participants set payment_status = 'awaiting_review'
  where id = p_participant_id and user_id = auth.uid() and payment_status in ('awaiting_payment', 'rejected');
  if not found then
    raise exception 'This application is already being reviewed or is confirmed.' using errcode = '22023';
  end if;
end $$;

revoke execute on function public.mark_receipt_sent(uuid) from anon;
revoke execute on function public.register_for_tournament(uuid, text, text, text) from anon;

-- ------------------------------------------------------------------ nicknames
-- profiles.display_name is the player's nickname: unique (case-insensitive), changeable by the
-- player at any time (column privilege + RLS already allow self-updates of display_name only).

-- Make existing names unique before adding the index.
update public.profiles p
set display_name = left(p.display_name, 19) || '_' || left(replace(p.id::text, '-', ''), 4)
where exists (select 1 from public.profiles q where lower(q.display_name) = lower(p.display_name) and q.id < p.id);

create unique index profiles_nickname_unique on public.profiles (lower(display_name)) where display_name <> '';

create or replace function public.guard_profile_nickname() returns trigger
language plpgsql as $$
begin
  if new.display_name is distinct from old.display_name and auth.uid() is not null then
    new.display_name := trim(new.display_name);
    if new.display_name !~ '^[A-Za-z0-9А-Яа-яЁё_.-]{3,24}$' then
      raise exception 'Nickname: 3–24 letters, digits, _ . - (no spaces).' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
create trigger profiles_guard_nickname before update on public.profiles
  for each row execute function public.guard_profile_nickname();

-- New accounts get the nickname they chose; if it is taken, a short suffix is added.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  base text := left(regexp_replace(coalesce(nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''), split_part(new.email, '@', 1), 'player'), '[^A-Za-z0-9А-Яа-яЁё_.-]', '', 'g'), 19);
  candidate text;
begin
  if char_length(base) < 3 then base := base || 'player'; end if;
  candidate := base;
  while exists (select 1 from public.profiles where lower(display_name) = lower(candidate)) loop
    candidate := base || '_' || substr(md5(random()::text), 1, 4);
  end loop;
  insert into public.profiles (id, display_name) values (new.id, candidate) on conflict (id) do nothing;
  return new;
end $$;

-- Lets the sign-up form check a nickname before creating the account.
create or replace function public.nickname_available(p_nickname text) returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (select 1 from public.profiles where lower(display_name) = lower(trim(p_nickname)))
$$;
