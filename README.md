# temcch tournaments — EA SPORTS FC 27 tournament platform

A web app for running local and university FC 27 tournaments: registration, seeded group draws,
round-robin fixtures, standings computed from results, knockout brackets with automatic advancement,
and a public page that spectators can follow live.

> Independent project, not affiliated with Electronic Arts. Inspired by the purpose of
> svoy.up.railway.app; no code, branding or assets were copied.

## Features

**Public**
- Landing page with live, upcoming and recently completed tournaments (real data only, no invented stats).
- Discovery page with search, status and format filters, and date sorting. Filters are kept in the URL.
- Tournament page with tabs: Overview (stage tracker, next matches, champion, rules, facts),
  Participants, Standings (group format only), Matches (filter by stage, group and status), and Playoffs (bracket).
- Self-registration with just a display name (plus optional contact). Names are unique per tournament; capacity, deadline and status are checked. Contact details are private.
- Russian / English interface: RU-EN switch in the header, remembered per browser (defaults to the browser language). Strings live in `src/i18n/ru.ts`; a unit test fails if any UI string lacks a translation.
- Paid registration (optional per tournament): the organizer sets the entry fee, payment details and a Telegram username for receipts. A player's registration becomes an application with an 8-character ID and the status "Awaiting payment"; after paying, the player sends the receipt (quoting the ID) to the organizer in Telegram and presses "I paid" → "Awaiting receipt check". The organizer confirms or rejects ("Payment not confirmed") in the Participants tab. Only confirmed applications are participants: they are public, count toward capacity and enter the draw. Players see their status on the tournament page and in My cabinet (`/profile`), and get an on-site notification when it changes. Email / Telegram-bot notifications are not included.
- Nicknames: chosen at sign-up (unique, 3–24 letters/digits/_ . -) and changeable by the player in My cabinet.
- Public pages refresh every 20 s, so scores entered by the organizer show up without a reload.

**Organizer** (`/admin`)
- Create a tournament and edit its settings: format, capacity, groups, qualifiers per group, points,
  tie-breaker order, single or double round robin, third-place match, walkover score, required contact
  info, and number of console stations.
- Status workflow: Draft → Registration open/closed → In progress → Completed, with Cancel available
  throughout. Invalid transitions are rejected on both client and server.
- Teams: after the group draw (or the bracket draw for single elimination), Stage control shows an "Assign teams" step where the organizer gives every player a club by hand, grouped by group, with suggestions. Teams can be changed until the tournament ends; before the draw they are blocked (also enforced in SQL).
- Manage participants: add players manually, set seeds, remove players (only before fixtures exist),
  and view contact details.
- Stage control, a step-by-step flow that only unlocks the next stage once the current one is complete:
  - Preview the group draw (seeded snake distribution plus a reproducible random seed), redraw, then confirm.
  - Generate round-robin fixtures, with a station suggested for each match.
  - Generate the knockout bracket once every group match is completed or cancelled.
  - Straight knockout format: preview the seeding, then generate (byes go to the top seeds).
  - Reset the bracket or undo the draw, behind confirmation dialogs.
- Match editor:
  - Final or live score, with a penalty shoot-out required when a knockout match ends level.
  - Walkovers.
  - Reschedule: time, station, postponed or cancelled.
  - Clear a result.
- Safe corrections:
  - Changing an earlier knockout result clears the later results that depended on it.
  - A group-result change that alters qualification asks the organizer before deleting the stale bracket.

## Architecture

```
src/
  engine/        Pure TypeScript tournament logic (no React, no I/O) — fully unit-tested
    roundRobin.ts   circle-method fixtures, home/away balancing, double round robin
    groups.ts       feasibility checks, seeded snake draw, group stage builder, station hints
    standings.ts    table from results, tie-breakers incl. multi-way head-to-head, deterministic fallback
    knockout.ts     standard seed order, byes, wiring, third-place match, group→bracket crossover
    results.ts      score validation, BracketEditor (advancement + downstream invalidation)
    lifecycle.ts    status transitions, registration state, stage progress, podium
    commands.ts     high-level operations → a Mutation (what to insert/update/delete)
    registration.ts registration rules (mirrored by the SQL function)
  data/          DataService interface + two backends
    supabase.ts     Supabase (RLS + SQL functions); anon key only
    local.ts        browser-only development mode (localStorage)
    mappers.ts      row ⇄ domain mapping, Mutation → SQL payload
  features/      auth, tournaments (queries, form), participants, matches (editor), admin
  components/    ui (design system), layout, tournament, matches, standings, bracket
  pages/         route components (admin pages are lazy-loaded)
supabase/
  migrations/    schema, constraints, RLS policies, triggers, procedures
  seed.sql       role bootstrap + optional demo tournament (clearly labelled)
tests/
  unit/          engine tests
  integration/   real migration executed in PGlite (Postgres/WASM) — RLS, procedures, constraints
  e2e/           Playwright: full tournament journey in local mode
```

**How a change is made.** The UI never edits fixtures directly. An organizer action loads a fresh
copy of the tournament, runs an engine command (`planGroupStage`, `planMatchChange`, …) that
validates the rules and returns a `Mutation`, and the backend applies it atomically:
- In Supabase this goes through `apply_tournament_mutation()`. The function checks permission, locks
  the tournament row, rejects stale versions (optimistic concurrency), and writes everything in one
  transaction. Table constraints reject invalid rows regardless of what the client sends.
- The tournament rules live in one place (the engine). The database guarantees authorization and integrity.

**Standings are never stored.** Tables are always computed from persisted match results. Points,
goal difference and qualification can't drift from the scores.

### Tournament rules (documented decisions)

| Topic | Rule |
| --- | --- |
| Points | Configurable; default 3/1/0. |
| Tie-breakers | Points first, then the configured order: either **GD → goals → H2H points → H2H GD → H2H goals → wins** (default) or **H2H first**. |
| Multi-way head-to-head | H2H criteria use a mini-table of only the matches between the tied players. If a criterion splits the group, each still-tied subset is re-ranked from the first criterion with its own mini-table (UEFA-style re-application). |
| Final fallback | Manual seed (lower first), then registration time, then id. Rows decided this way are flagged; the organizer is warned before generating the bracket if this affects qualification. |
| Cancelled / unfinished matches | Ignored by standings. A group is complete when every non-cancelled match is completed. |
| Knockout seeding after groups | All group winners (A, B, C…), then all runners-up, and so on, placed into a standard bracket (1 v N, …). With 4 groups × top 2 this gives A1–D2, D1–A2, B1–C2, C1–B2, so group-mates can't meet in round one. |
| Byes | When the qualifier count isn't a power of two, the top seeds skip round one. |
| Knockout draws | The score (after extra time, if played) is stored separately from the penalty shoot-out. A level score requires a decisive shoot-out. |
| Walkover | Stored as a configurable N–0 win (default 3–0) and flagged as a walkover. |
| Live scores | `in_progress` scores are public but never count for standings or advance anyone. |
| Corrections | If a knockout winner changes, every downstream match that received the old winner is reset and the change cascades. Corrections that keep the same winner leave later rounds untouched. A group edit that changes qualification or seeding is blocked until the organizer confirms deleting the stale bracket. |
| Determinism | The same participants, settings and draw seed always produce the same groups, fixtures and bracket. |

## Running locally

Requirements: Node.js ≥ 20.19 (tested with Node 24).

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. Without Supabase variables the app starts in **local mode** (see below).
Go to *Organizer → Create demo tournament* for 16 fictional players, or create your own.

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm start` | Serve the build (`vite preview`, honours `$PORT`) |
| `npm run typecheck` | TypeScript only |
| `npm test` | Unit + integration tests (Vitest; integration runs the real migration in PGlite) |
| `npm run e2e` | Playwright end-to-end tests (builds and serves the app in local mode) |

Playwright uses the locally installed **Microsoft Edge** by default. To use Playwright's bundled
Chromium instead (for example in CI), run `npx playwright install chromium`, then `PW_CHANNEL=chromium npm run e2e`.

### Local mode — security implications

When `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` are missing:
- Data is stored in the browser's `localStorage` and isn't shared between devices.
- **There is no authentication or authorization.** Everyone using the browser is the "local organizer".
- A banner across the top of every page says so.

Use it for development, demos and tests only. Never deploy it as a real event site.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | for real use | Project URL (Settings → API). Public. |
| `VITE_SUPABASE_ANON_KEY` | for real use | `anon` public key. Safe in the browser — access is enforced by RLS. |
| `PREVIEW_ALLOWED_HOSTS` | optional | Extra host names for `npm start` (e.g. a custom domain on Railway). |

**Never** put the `service_role` key in any `VITE_*` variable or in the frontend. Copy `.env.example` to `private/.env.local` — the `private/` folder is git-ignored and Vite reads env files from it.

## Supabase setup

1. Create a Supabase project (PostgreSQL 15+).
2. Apply the migrations in `supabase/migrations/` in filename order (`20261028000000_init.sql`, `20261029000000_teams.sql`, then `20261030000000_payments_nicknames.sql`). Either paste them into the SQL
   editor, or use the CLI (`supabase link`, then `supabase db push`).
3. Authentication → Providers: enable **Email**. Decide whether email confirmation is required; the
   sign-up screen handles both cases. Add your site URL to Authentication → URL Configuration.
4. Set the two `VITE_` variables and restart the app.
5. Sign up through the app, then grant organizer rights in the SQL editor (see `supabase/seed.sql`):
   ```sql
   update public.profiles p set role = 'organizer' from auth.users u where u.id = p.id and u.email = 'you@example.com';
   ```
   Optionally run the rest of `seed.sql` to create a labelled demo tournament.

### Security model

- **Roles.** `profiles.role` is `user`, `organizer` or `admin`. Users can't change it: the column
  privilege is revoked, and a trigger blocks role changes. Roles are assigned from the SQL editor or by
  an admin through `set_user_role()`.
- **Ownership.**
  - Only organizers can create tournaments.
  - A tournament can be managed by its owner, co-managers listed in `tournament_managers`, and admins (`can_manage()`).
- **RLS on every table.**
  - Drafts are visible only to their managers. Published tournaments, participants, groups and matches are public.
  - `participant_contacts` is readable only by managers and the participant themself.
  - `match_result_audit` is readable only by managers.
- **No direct writes to fixtures.**
  - `groups`, `group_members` and `matches` have no write policies; `apply_tournament_mutation()` is the only path.
  - That function forces every row into the target tournament, checks `can_manage()`, uses `SELECT … FOR UPDATE` plus a version check, and validates bracket wiring.
- **Integrity constraints.**
  - Composite foreign keys keep every match participant and group member inside the same tournament.
  - A participant can be in only one group.
  - No duplicate fixture positions or duplicate group pairings.
  - Score range checks.
  - A completed match must have a full score.
  - The winner must be one of the two sides and must agree with the score or shoot-out.
  - Penalties are allowed only for a level knockout match.
- **Registration** (`register_for_tournament()`) requires sign-in and locks the tournament row. It then
  checks status, deadline, duplicates (per account and per case-insensitive username) and capacity.
  A trigger also enforces capacity and freezes the participant list once fixtures exist.
- **Audit trail.** Every result change is recorded in `match_result_audit` with the user and the old and new values.

The integration suite runs the real migration in PGlite and checks these rules: role escalation,
draft visibility, cross-user edits, registration limits, contact privacy, the direct-write ban, version
conflicts, constraint violations, the participant freeze, cascade delete and the seed script. PGlite
stands in for Supabase's `auth` schema and API roles with a small stub
(`tests/integration/supabase-stub.sql`). Re-check the policies against your real project before
calling it production-ready.

## Deployment

**Vercel**
- Import the repository; the framework preset is Vite.
- `vercel.json` sets up the SPA rewrites and a few security headers.
- Add `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in Project → Settings → Environment Variables, then redeploy.

**Railway**
- Create a service from the repository. `railway.json` builds with `npm ci && npm run build` and starts with `npm start`, which serves on `$PORT`.
- Add the two `VITE_` variables. They're read at build time, so redeploy after changing them.
- `*.up.railway.app` hosts are allowed by default; add a custom domain with `PREVIEW_ALLOWED_HOSTS`.

In both cases, add the deployed URL to Supabase Authentication → URL Configuration.

## Known limitations

- **No live Supabase testing yet.** This build was verified in local mode and against the migration in
  PGlite. It hasn't been run against a live Supabase project, because no credentials were available
  during development.
- **Formats.** Only group stage + knockout and single elimination are supported. The engine is modular
  (formats are command functions over the same match model), but round robin only and double
  elimination aren't implemented.
- **Ties after all criteria** are resolved by the deterministic fallback. There's no UI for drawing
  lots or manually overriding a position.
- **Spectator updates** use 20-second polling, not Supabase Realtime.
- **Not built:** player self-withdrawal in the UI (the SQL function exists), a co-manager invitation UI
  (the table and policies exist), and entry fees and prize tracking (the reference site has these).
- **Server-side rules.** The server enforces authorization, structure and integrity. The deeper
  tournament rules (e.g. which result triggers which bracket reset) are computed by the engine in the
  organizer's browser and applied atomically. A malicious organizer could only damage their own
  tournament, and constraints still block invalid data.
