-- Flexible registration: waitlist, cancellations, time-limited payment reservations,
-- min/target/max capacity, paused / scheduled / late registration.
--
-- Status values (participants.payment_status) — existing values are kept so existing rows stay valid:
--   awaiting_payment ("pending_payment") | awaiting_review ("payment_review") | confirmed
--   | waitlisted | rejected | cancelled
--
-- A registration HOLDS A PLACE when it is confirmed, awaiting_review, or awaiting_payment with
-- reserved_until in the future. Expired reservations release their place automatically (no job
-- needed). Every operation that can take a place runs under SELECT ... FOR UPDATE on the
-- tournament row, and the participants trigger re-checks capacity, so the last place cannot be
-- taken twice.
--
-- New tournament settings (jsonb, read with defaults): minParticipants, targetParticipants,
-- registrationOpensAt, registrationPaused, waitlistEnabled, allowLateRegistration,
-- reservationMinutes (default 30), cancellationPolicy.

alter table public.participants drop constraint if exists participants_payment_status_check;
alter table public.participants add constraint participants_payment_status_check
  check (payment_status in ('awaiting_payment', 'awaiting_review', 'confirmed', 'waitlisted', 'rejected', 'cancelled'));

alter table public.participants add column reserved_until timestamptz;
alter table public.participants add column status_changed_at timestamptz not null default now();
update public.participants set status_changed_at = created_at;
-- Before this migration unpaid applications did not hold a place; keep that by treating them as expired.
update public.participants set reserved_until = now() where payment_status = 'awaiting_payment';

create index participants_status_idx on public.participants (tournament_id, payment_status);

-- Places currently taken in a tournament.
create or replace function public.places_held(p_tournament_id uuid, p_except uuid default null) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.participants
  where tournament_id = p_tournament_id
    and (p_except is null or id <> p_except)
    and (payment_status in ('confirmed', 'awaiting_review')
         or (payment_status = 'awaiting_payment' and reserved_until > now()))
$$;

create or replace function public.holds_place(p_status text, p_reserved_until timestamptz) returns boolean
language sql stable as $$
  select p_status in ('confirmed', 'awaiting_review') or (p_status = 'awaiting_payment' and p_reserved_until > now())
$$;

create or replace function public.guard_participant_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  t public.tournaments;
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
  if tg_op in ('INSERT', 'UPDATE') then
    if tg_op = 'INSERT' or new.payment_status is distinct from old.payment_status then
      new.status_changed_at := now();
    end if;
    -- Taking a place (from not holding one) requires a free place.
    if public.holds_place(new.payment_status, new.reserved_until)
       and (tg_op = 'INSERT' or not public.holds_place(old.payment_status, old.reserved_until)) then
      if public.places_held(t.id, new.id) >= t.max_participants then
        raise exception 'This tournament is full.' using errcode = '22023';
      end if;
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
  pid uuid;
  v_name text := trim(p_display_name);
  v_status text;
  v_until timestamptz;
  v_minutes int;
begin
  if auth.uid() is null then
    raise exception 'Sign in to register' using errcode = '42501';
  end if;
  if char_length(v_name) < 2 or char_length(v_name) > 32 then
    raise exception 'Name: 2–32 characters.' using errcode = '22023';
  end if;
  select * into t from public.tournaments where id = p_tournament_id for update;
  if not found or t.status = 'draft' then
    raise exception 'Tournament not found' using errcode = 'P0002';
  end if;
  if t.status = 'cancelled' then raise exception 'This tournament has been cancelled.' using errcode = '22023'; end if;
  if t.status <> 'registration_open' then raise exception 'Registration is currently closed.' using errcode = '22023'; end if;
  if coalesce((t.settings ->> 'registrationPaused')::boolean, false) then
    raise exception 'Registration is paused by the organizer.' using errcode = '22023';
  end if;
  if nullif(t.settings ->> 'registrationOpensAt', '') is not null and (t.settings ->> 'registrationOpensAt')::timestamptz > now() then
    raise exception 'Registration has not opened yet.' using errcode = '22023';
  end if;
  if t.registration_deadline is not null and t.registration_deadline < now()
     and not coalesce((t.settings ->> 'allowLateRegistration')::boolean, false) then
    raise exception 'The registration deadline has passed.' using errcode = '22023';
  end if;
  if exists (select 1 from public.participants where tournament_id = t.id and user_id = auth.uid()) then
    raise exception 'You are already registered for this tournament.' using errcode = '23505';
  end if;
  if exists (select 1 from public.participants where tournament_id = t.id
             and (lower(trim(display_name)) = lower(v_name) or lower(trim(gamertag)) = lower(v_name))) then
    raise exception 'This name is already registered.' using errcode = '23505';
  end if;
  if coalesce((t.settings ->> 'requireContact')::boolean, false) and coalesce(trim(p_contact), '') = '' then
    raise exception 'The organizer requires contact information.' using errcode = '22023';
  end if;
  v_minutes := greatest(1, coalesce((t.settings ->> 'reservationMinutes')::int, 30));
  if public.places_held(t.id) >= t.max_participants then
    if coalesce((t.settings ->> 'waitlistEnabled')::boolean, false) then
      v_status := 'waitlisted';
    else
      raise exception 'This tournament is full.' using errcode = '22023';
    end if;
  elsif coalesce((t.settings ->> 'requirePayment')::boolean, false) then
    v_status := 'awaiting_payment';
    v_until := now() + make_interval(mins => v_minutes);
  else
    v_status := 'confirmed';
  end if;
  insert into public.participants (tournament_id, display_name, gamertag, user_id, payment_status, reserved_until)
  values (t.id, v_name, v_name, auth.uid(), v_status, v_until) returning id into pid;
  if coalesce(trim(p_contact), '') <> '' then
    insert into public.participant_contacts (participant_id, tournament_id, contact) values (pid, t.id, left(trim(p_contact), 120));
  end if;
  return pid;
end $$;

drop function if exists public.mark_receipt_sent(uuid);

-- The applicant reports the receipt. Keeps a live reservation; with an expired one, takes a free
-- place if there is one, otherwise joins the waitlist (or fails when there is none). Never confirms.
create or replace function public.mark_receipt_sent(p_participant_id uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  p public.participants;
  t public.tournaments;
  v_status text;
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  select * into p from public.participants where id = p_participant_id and user_id = auth.uid();
  if not found then
    raise exception 'Application not found.' using errcode = 'P0002';
  end if;
  select * into t from public.tournaments where id = p.tournament_id for update;
  select * into p from public.participants where id = p_participant_id; -- re-read under the lock
  if p.payment_status not in ('awaiting_payment', 'rejected') then
    raise exception 'This application is already being reviewed or is confirmed.' using errcode = '22023';
  end if;
  if public.holds_place(p.payment_status, p.reserved_until) or public.places_held(t.id, p.id) < t.max_participants then
    v_status := 'awaiting_review';
  elsif coalesce((t.settings ->> 'waitlistEnabled')::boolean, false) then
    v_status := 'waitlisted';
  else
    raise exception 'No places are left in this tournament.' using errcode = '22023';
  end if;
  update public.participants set payment_status = v_status, reserved_until = null where id = p.id;
  return v_status;
end $$;

-- The player withdraws their own registration (before the draw; the trigger enforces that).
create or replace function public.cancel_my_registration(p_participant_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in first' using errcode = '42501';
  end if;
  update public.participants set payment_status = 'cancelled', reserved_until = null
  where id = p_participant_id and user_id = auth.uid() and payment_status <> 'cancelled';
  if not found then
    raise exception 'Registration not found or already cancelled.' using errcode = '22023';
  end if;
end $$;

-- Public place counts for a visible tournament (no personal data).
create or replace function public.tournament_counts(p_tournament_id uuid)
returns table (confirmed int, holding int, waitlisted int)
language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where payment_status = 'confirmed')::int,
    count(*) filter (where public.holds_place(payment_status, reserved_until))::int,
    count(*) filter (where payment_status = 'waitlisted')::int
  from public.participants
  where tournament_id = p_tournament_id and public.tournament_visible(p_tournament_id)
$$;

-- Waitlist position for the applicant themself (or a manager).
create or replace function public.waitlist_position(p_participant_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select case when p.payment_status <> 'waitlisted' then null else (
    select count(*)::int from public.participants q
    where q.tournament_id = p.tournament_id and q.payment_status = 'waitlisted'
      and (q.status_changed_at, q.created_at, q.id) <= (p.status_changed_at, p.created_at, p.id)
  ) end
  from public.participants p
  where p.id = p_participant_id and (p.user_id = auth.uid() or public.can_manage(p.tournament_id))
$$;

revoke execute on function public.mark_receipt_sent(uuid) from anon;
revoke execute on function public.cancel_my_registration(uuid) from anon;
revoke execute on function public.register_for_tournament(uuid, text, text, text) from anon;

-- Capacity may be lowered only down to the places that are already confirmed or paid-and-under-review.
create or replace function public.guard_tournament_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  has_matches boolean;
  n_locked int;
  s_min int;
  s_target int;
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
  select count(*) into n_locked from public.participants
    where tournament_id = new.id and payment_status in ('confirmed', 'awaiting_review');
  if new.max_participants < n_locked then
    raise exception 'Capacity cannot be lower than the current number of participants (%)', n_locked using errcode = '22023';
  end if;
  s_min := coalesce((new.settings ->> 'minParticipants')::int, 0);
  s_target := coalesce((new.settings ->> 'targetParticipants')::int, 0);
  if s_min < 0 or s_target < 0 or s_min > new.max_participants or s_target > new.max_participants
     or (s_min > 0 and s_target > 0 and s_min > s_target) then
    raise exception 'Capacity must satisfy minimum ≤ target ≤ maximum.' using errcode = '22023';
  end if;
  if coalesce((new.settings ->> 'reservationMinutes')::int, 30) not between 1 and 10080 then
    raise exception 'Reservation time must be between 1 minute and 7 days.' using errcode = '22023';
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
