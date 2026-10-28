-- Seed / bootstrap script. Run in the Supabase SQL editor (which uses a privileged role)
-- AFTER the migration and AFTER the people involved have signed up through the app.

-- 1. Grant organizer (or admin) rights. Users can never do this themselves.
--    Replace the email address with the organizer's account.
update public.profiles p
set role = 'organizer'
from auth.users u
where u.id = p.id and u.email = 'organizer@example.com';

-- Optional: make someone a platform administrator (can manage every tournament and assign roles
-- from SQL via: select public.set_user_role('<user uuid>', 'organizer');).
-- update public.profiles p set role = 'admin' from auth.users u where u.id = p.id and u.email = 'admin@example.com';

-- 2. Optional DEMO tournament with fictional players, owned by the first organizer.
--    Clearly labelled as demo data; delete it from the organizer dashboard when done.
do $$
declare
  org uuid;
  tid uuid;
begin
  select id into org from public.profiles where role in ('organizer', 'admin') order by created_at limit 1;
  if org is null then
    raise notice 'No organizer yet — skipping demo tournament.';
    return;
  end if;
  insert into public.tournaments (owner_id, name, description, venue, starts_at, format, status, max_participants, settings)
  values (org, 'Demo Campus Cup (sample data)', 'Demonstration tournament with fictional players.', 'Demo venue',
          now() + interval '3 days', 'groups_knockout', 'draft', 16,
          '{"groupCount":4,"advancePerGroup":2,"pointsWin":3,"pointsDraw":1,"pointsLoss":0,
            "tiebreakers":["goal_diff","goals_for","h2h_points","h2h_goal_diff","h2h_goals_for","wins"],
            "doubleRoundRobin":false,"thirdPlaceMatch":true,"walkoverGoals":3,"requireContact":false,"stations":4,"drawSeed":2027}')
  returning id into tid;
  insert into public.participants (tournament_id, display_name, gamertag, seed)
  select tid, 'Demo Player ' || g, 'demo_player_' || g, case when g <= 4 then g end
  from generate_series(1, 16) g;
  update public.tournaments set status = 'registration_closed' where id = tid;
end $$;
