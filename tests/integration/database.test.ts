// @vitest-environment node
// Runs the real Supabase migration in PGlite and checks RLS, procedures and constraints.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { groupTables, planGroupStage, planMatchChange, previewDraw, uuid, type Mutation } from '@/engine';
import { toDbMutation, toGroup, toGroupMember, toMatch, toParticipant, toTournament, type GroupMemberRow, type GroupRow, type MatchRow, type ParticipantRow, type TournamentRow } from '@/data/mappers';
import type { TournamentBundle } from '@/types/domain';

const ORGANIZER = '11111111-1111-4111-8111-111111111111';
const STRANGER = '22222222-2222-4222-8222-222222222222';
const players = Array.from({ length: 8 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);

let db: PGlite;

type Who = 'anon' | string;
async function as<T>(who: Who, fn: (tx: Transaction) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    if (who === 'anon') {
      await tx.exec(`set local role anon; select set_config('request.jwt.claim.sub', '', true);`);
    } else {
      await tx.exec(`set local role authenticated; select set_config('request.jwt.claim.sub', '${who}', true);`);
    }
    return fn(tx);
  });
}

async function loadBundle(id: string): Promise<TournamentBundle> {
  const t = await db.query<TournamentRow>('select * from tournaments where id = $1', [id]);
  const p = await db.query<ParticipantRow>('select * from participants where tournament_id = $1 order by created_at', [id]);
  const g = await db.query<GroupRow>('select * from groups where tournament_id = $1', [id]);
  const gm = await db.query<GroupMemberRow>('select * from group_members where tournament_id = $1', [id]);
  const m = await db.query<MatchRow>('select * from matches where tournament_id = $1', [id]);
  const iso = <R extends object>(r: R) => JSON.parse(JSON.stringify(r)) as R; // Date → ISO strings
  return {
    tournament: toTournament(iso(t.rows[0])),
    participants: p.rows.map((r) => toParticipant(iso(r))),
    groups: g.rows.map(toGroup),
    groupMembers: gm.rows.map(toGroupMember),
    matches: m.rows.map((r) => toMatch(iso(r))),
  };
}

const applyAs = (who: Who, b: TournamentBundle, m: Mutation, version = b.tournament.version) =>
  as(who, (tx) => tx.query<{ v: number }>('select apply_tournament_mutation($1, $2, $3::jsonb) as v', [b.tournament.id, version, JSON.stringify(toDbMutation(m))]));

const ctx = () => ({ ids: uuid, now: new Date().toISOString() });
let tid = '';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(resolve(__dirname, 'supabase-stub.sql'), 'utf8'));
  const dir = resolve(__dirname, '../../supabase/migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(resolve(dir, file), 'utf8'));
  }
  for (const id of [ORGANIZER, STRANGER, ...players]) {
    await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id.slice(0, 4)}-${id.slice(-2)}@example.test`]);
  }
  await db.query(`update profiles set role = 'organizer' where id = $1`, [ORGANIZER]);
}, 60_000);

describe('roles and tournament ownership', () => {
  it('creates a profile for every new auth user', async () => {
    const r = await db.query<{ n: number }>('select count(*)::int as n from profiles');
    expect(r.rows[0].n).toBe(10);
  });

  it('does not let users promote themselves', async () => {
    await expect(as(STRANGER, (tx) => tx.query(`update profiles set role = 'organizer' where id = $1`, [STRANGER]))).rejects.toThrow();
    await expect(as(STRANGER, (tx) => tx.query(`select set_user_role($1, 'organizer')`, [STRANGER]))).rejects.toThrow(/administrators/);
    await as(STRANGER, (tx) => tx.query(`update profiles set display_name = 'Renamed' where id = $1`, [STRANGER]));
    const r = await db.query<{ role: string; display_name: string }>('select role, display_name from profiles where id = $1', [STRANGER]);
    expect(r.rows[0]).toEqual({ role: 'user', display_name: 'Renamed' });
  });

  it('only organizers can create tournaments', async () => {
    const insert = `insert into tournaments (name, format, max_participants, settings, owner_id) values ($1, 'groups_knockout', 8, $2::jsonb, $3) returning id`;
    const settings = JSON.stringify({ groupCount: 2, advancePerGroup: 2 });
    await expect(as(STRANGER, (tx) => tx.query(insert, ['Not allowed', settings, STRANGER]))).rejects.toThrow(/row-level security/);
    const r = await as(ORGANIZER, (tx) => tx.query<{ id: string }>(insert, ['Campus Cup', settings, ORGANIZER]));
    tid = r.rows[0].id;
    expect(tid).toBeTruthy();
  });

  it('hides drafts from the public and blocks edits by non-managers', async () => {
    const anon = await as('anon', (tx) => tx.query('select id from tournaments where id = $1', [tid]));
    expect(anon.rows).toHaveLength(0);
    const upd = await as(STRANGER, (tx) => tx.query(`update tournaments set name = 'Hijacked' where id = $1`, [tid]));
    expect(upd.affectedRows ?? 0).toBe(0);
    await as(ORGANIZER, (tx) => tx.query(`update tournaments set status = 'registration_open' where id = $1`, [tid]));
    const visible = await as('anon', (tx) => tx.query<{ name: string }>('select name from tournaments where id = $1', [tid]));
    expect(visible.rows[0].name).toBe('Campus Cup');
  });

  it('rejects invalid status transitions server-side', async () => {
    await expect(as(ORGANIZER, (tx) => tx.query(`update tournaments set status = 'completed' where id = $1`, [tid]))).rejects.toThrow(/Invalid status/);
  });
});

describe('registration', () => {
  it('requires sign-in', async () => {
    await expect(as('anon', (tx) => tx.query(`select register_for_tournament($1, 'Anon', 'anon')`, [tid]))).rejects.toThrow();
  });

  it('registers players, rejects duplicates and enforces capacity', async () => {
    for (const [i, p] of players.entries()) {
      await as(p, (tx) => tx.query(`select register_for_tournament($1, $2, $3, $4)`, [tid, `Player ${i}`, `Gamer${i}`, `@player${i}`]));
    }
    await expect(as(players[0], (tx) => tx.query(`select register_for_tournament($1, 'Again', 'Other')`, [tid]))).rejects.toThrow(/already registered/);
    // Display names are unique per tournament (case- and whitespace-insensitive).
    await expect(as(STRANGER, (tx) => tx.query(`select register_for_tournament($1, ' player 3 ')`, [tid]))).rejects.toThrow(/already registered/);
    await expect(as(STRANGER, (tx) => tx.query(`select register_for_tournament($1, 'Late', 'late')`, [tid]))).rejects.toThrow(/full/);
  });

  it('does not accept teams before the draw', async () => {
    const b = await loadBundle(tid);
    await expect(as(ORGANIZER, (tx) => tx.query(`update participants set team = 'Arsenal' where id = $1`, [b.participants[0].id]))).rejects.toThrow(/after the draw/);
    await expect(as(ORGANIZER, (tx) => tx.query(
      `insert into participants (tournament_id, display_name, gamertag, team) values ($1, 'Late', 'Late', 'Chelsea')`, [tid]))).rejects.toThrow(/after the draw/);
  });

  it('keeps contact details private', async () => {
    const anon = await as('anon', (tx) => tx.query('select * from participant_contacts'));
    expect(anon.rows).toHaveLength(0);
    const stranger = await as(STRANGER, (tx) => tx.query('select * from participant_contacts'));
    expect(stranger.rows).toHaveLength(0);
    const self = await as(players[2], (tx) => tx.query<{ contact: string }>('select contact from participant_contacts'));
    expect(self.rows.map((r) => r.contact)).toEqual(['@player2']);
    const organizer = await as(ORGANIZER, (tx) => tx.query('select * from participant_contacts'));
    expect(organizer.rows).toHaveLength(8);
  });
});

describe('structural changes through apply_tournament_mutation', () => {
  it('blocks direct writes to matches', async () => {
    const b = await loadBundle(tid);
    await expect(as(ORGANIZER, (tx) => tx.query(
      `insert into matches (tournament_id, stage, group_id, round, slot, home_id, away_id) values ($1, 'knockout', null, 1, 0, $2, $3)`,
      [tid, b.participants[0].id, b.participants[1].id]))).rejects.toThrow(/row-level security/);
  });

  it('generates the group stage atomically, only for managers', async () => {
    await as(ORGANIZER, (tx) => tx.query(`update tournaments set status = 'registration_closed' where id = $1`, [tid]));
    const b = await loadBundle(tid);
    const plan = planGroupStage(b, previewDraw(b, 11), ctx());
    await expect(applyAs(STRANGER, b, plan.mutation)).rejects.toThrow(/not allowed/);
    await applyAs(ORGANIZER, b, plan.mutation);
    const after = await loadBundle(tid);
    expect(after.tournament.status).toBe('in_progress');
    expect(after.tournament.version).toBe(b.tournament.version + 1);
    expect(after.groups).toHaveLength(2);
    expect(after.matches).toHaveLength(12);
    const publicView = await as('anon', (tx) => tx.query('select id from matches where tournament_id = $1', [tid]));
    expect(publicView.rows).toHaveLength(12);
  });

  it('rejects stale versions (concurrent edits)', async () => {
    const b = await loadBundle(tid);
    const m = b.matches[0];
    const plan = planMatchChange(b, m.id, { type: 'result', input: { homeScore: 1, awayScore: 0, status: 'completed' } }, ctx());
    await expect(applyAs(ORGANIZER, b, plan.mutation, b.tournament.version - 1)).rejects.toThrow(/changed by someone else/);
  });

  it('enforces score integrity even if a client sends a bad payload', async () => {
    const b = await loadBundle(tid);
    const m = b.matches[0];
    const bad: Mutation = { insertGroups: [], insertMembers: [], insertMatches: [], deleteMatchIds: [], deleteGroupIds: [], tournamentStatus: null,
      updateMatches: [{ ...m, status: 'completed', homeScore: 1, awayScore: 0, winnerId: m.awayId }] };
    await expect(applyAs(ORGANIZER, b, bad)).rejects.toThrow(/matches_winner_consistent/);
    const noScore = { ...bad, updateMatches: [{ ...m, status: 'completed' as const, homeScore: null, awayScore: null }] };
    await expect(applyAs(ORGANIZER, b, noScore)).rejects.toThrow(/matches_completed_has_score/);
  });

  it('prevents participant changes after fixtures exist', async () => {
    const b = await loadBundle(tid);
    await expect(as(ORGANIZER, (tx) => tx.query('delete from participants where id = $1', [b.participants[0].id]))).rejects.toThrow(/fixtures/);
    await expect(as(ORGANIZER, (tx) => tx.query(`update participants set display_name = 'Renamed' where id = $1`, [b.participants[0].id]))).rejects.toThrow(/fixtures/);
  });

  it('still lets managers (and only managers) assign teams after the draw', async () => {
    const b = await loadBundle(tid);
    const pid = b.participants[0].id;
    await as(ORGANIZER, (tx) => tx.query(`update participants set team = 'Real Madrid' where id = $1`, [pid]));
    const upd = await as(STRANGER, (tx) => tx.query(`update participants set team = 'Hacked FC' where id = $1`, [pid]));
    expect(upd.affectedRows ?? 0).toBe(0);
    const r = await db.query<{ team: string }>('select team from participants where id = $1', [pid]);
    expect(r.rows[0].team).toBe('Real Madrid');
  });

  it('records results, audits them and standings follow the stored data', async () => {
    let b = await loadBundle(tid);
    for (const m of b.matches) {
      const plan = planMatchChange(b, m.id, { type: 'result', input: { homeScore: 2, awayScore: 1, status: 'completed' } }, ctx());
      await applyAs(ORGANIZER, b, plan.mutation);
      b = await loadBundle(tid);
    }
    const tables = groupTables(b);
    expect(tables.every((t) => t.standings.complete)).toBe(true);
    const totalPoints = tables.flatMap((t) => t.standings.rows).reduce((s, r) => s + r.points, 0);
    expect(totalPoints).toBe(12 * 3);
    const audit = await as(ORGANIZER, (tx) => tx.query('select * from match_result_audit where tournament_id = $1', [tid]));
    expect(audit.rows).toHaveLength(12);
    const auditPublic = await as('anon', (tx) => tx.query('select * from match_result_audit'));
    expect(auditPublic.rows).toHaveLength(0);
  });

  it('lets the owner delete the whole tournament (cascade)', async () => {
    await as(ORGANIZER, (tx) => tx.query('delete from tournaments where id = $1', [tid]));
    const left = await db.query<{ n: number }>('select (select count(*) from participants)::int + (select count(*) from matches)::int as n');
    expect(left.rows[0].n).toBe(0);
  });
});

describe('flexible registration (database)', () => {
  let tid2 = '';
  const U = Array.from({ length: 6 }, (_, i) => `55555555-5555-4555-8555-00000000000${i}`);
  const settings = (extra: Record<string, unknown> = {}) => JSON.stringify({
    groupCount: 1, advancePerGroup: 1, requirePayment: true, entryFee: '7 000 ₸', paymentDetails: 'Kaspi 1234',
    telegramUsername: 'temcch_org', reservationMinutes: 30, waitlistEnabled: false, ...extra,
  });
  const register = (u: string, name: string) => as(u, (tx) => tx.query<{ id: string }>('select register_for_tournament($1, $2) as id', [tid2, name]));
  const statusOf = async (u: string) =>
    (await db.query<{ id: string; payment_status: string; reserved_until: string | null }>('select id, payment_status, reserved_until from participants where tournament_id = $1 and user_id = $2', [tid2, u])).rows[0];
  const setSettings = (extra: Record<string, unknown>) =>
    as(ORGANIZER, (tx) => tx.query(`update tournaments set settings = settings || $2::jsonb where id = $1`, [tid2, JSON.stringify(extra)]));

  beforeAll(async () => {
    for (const id of U) await db.query('insert into auth.users (id, email) values ($1, $2)', [id, `${id.slice(-4)}@flex.test`]);
    const r = await as(ORGANIZER, (tx) => tx.query<{ id: string }>(
      `insert into tournaments (name, format, max_participants, settings, owner_id) values ('Flex Cup', 'single_elimination', 2, $1::jsonb, $2) returning id`,
      [settings(), ORGANIZER]));
    tid2 = r.rows[0].id;
    await as(ORGANIZER, (tx) => tx.query(`update tournaments set status = 'registration_open' where id = $1`, [tid2]));
  });

  it('1. registration with free places reserves a place for the payment window', async () => {
    await register(U[0], 'Alpha');
    const s = await statusOf(U[0]);
    expect(s.payment_status).toBe('awaiting_payment');
    const minutes = (new Date(s.reserved_until as string).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThanOrEqual(30);
  });

  it('3. two players racing for the last place: exactly one gets it', async () => {
    const results = await Promise.allSettled([register(U[1], 'Bravo'), register(U[2], 'Charlie')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/full/);
    const held = await db.query<{ n: number }>('select places_held($1) as n', [tid2]);
    expect(held.rows[0].n).toBe(2);
  });

  it('2. when full: refused without a waitlist, waitlisted with one (and shown publicly as counts only)', async () => {
    await expect(register(U[3], 'Delta')).rejects.toThrow(/full/);
    await setSettings({ waitlistEnabled: true });
    await register(U[3], 'Delta');
    expect((await statusOf(U[3])).payment_status).toBe('waitlisted');
    const pos = await as(U[3], (tx) => tx.query<{ p: number }>('select waitlist_position(id) as p from participants where user_id = $1', [U[3]]));
    expect(pos.rows[0].p).toBe(1);
    const counts = await as('anon', (tx) => tx.query<{ confirmed: number; holding: number; waitlisted: number }>('select * from tournament_counts($1)', [tid2]));
    expect(counts.rows[0]).toEqual({ confirmed: 0, holding: 2, waitlisted: 1 });
    expect((await as('anon', (tx) => tx.query('select id from participants where tournament_id = $1', [tid2]))).rows).toHaveLength(0);
  });

  it('4. an expired reservation releases its place; a new player can take it', async () => {
    const winner = (await statusOf(U[1]))?.id ? U[1] : U[2];
    await db.query(`update participants set reserved_until = now() - interval '1 minute' where tournament_id = $1 and user_id = $2`, [tid2, winner]);
    expect((await db.query<{ n: number }>('select places_held($1) as n', [tid2])).rows[0].n).toBe(1);
    await setSettings({ waitlistEnabled: false });
    await register(U[4], 'Echo');
    expect((await statusOf(U[4])).payment_status).toBe('awaiting_payment');
    // The expired player now finds no place: with no waitlist the receipt is refused…
    const p = await statusOf(winner);
    await expect(as(winner, (tx) => tx.query('select mark_receipt_sent($1)', [p.id]))).rejects.toThrow(/No places/);
    // …with the waitlist on, they join it instead of being silently dropped.
    await setSettings({ waitlistEnabled: true });
    const r = await as(winner, (tx) => tx.query<{ s: string }>('select mark_receipt_sent($1) as s', [p.id]));
    expect(r.rows[0].s).toBe('waitlisted');
  });

  it('5–6. receipt → under review (place kept) → organizer confirms', async () => {
    const p = await statusOf(U[0]);
    const r = await as(U[0], (tx) => tx.query<{ s: string }>('select mark_receipt_sent($1) as s', [p.id]));
    expect(r.rows[0].s).toBe('awaiting_review');
    expect((await statusOf(U[0])).reserved_until).toBeNull();
    await as(ORGANIZER, (tx) => tx.query(`update participants set payment_status = 'confirmed' where id = $1`, [p.id]));
    expect((await statusOf(U[0])).payment_status).toBe('confirmed');
    expect((await as('anon', (tx) => tx.query('select display_name from participants where tournament_id = $1', [tid2]))).rows).toEqual([{ display_name: 'Alpha' }]);
  });

  it('7. organizer rejects a payment; the player may send the receipt again', async () => {
    const p = await statusOf(U[4]);
    await as(U[4], (tx) => tx.query('select mark_receipt_sent($1)', [p.id]));
    await as(ORGANIZER, (tx) => tx.query(`update participants set payment_status = 'rejected' where id = $1`, [p.id]));
    expect((await statusOf(U[4])).payment_status).toBe('rejected');
    const r = await as(U[4], (tx) => tx.query<{ s: string }>('select mark_receipt_sent($1) as s', [p.id]));
    expect(r.rows[0].s).toBe('awaiting_review');
  });

  it('12. players cannot confirm, waitlist-jump or touch others’ registrations', async () => {
    const mine = await statusOf(U[3]);
    const self = await as(U[3], (tx) => tx.query(`update participants set payment_status = 'confirmed' where id = $1`, [mine.id]));
    expect(self.affectedRows ?? 0).toBe(0);
    const other = await statusOf(U[4]);
    await expect(as(U[3], (tx) => tx.query('select mark_receipt_sent($1)', [other.id]))).rejects.toThrow(/not found/);
    await expect(as(U[3], (tx) => tx.query('select cancel_my_registration($1)', [other.id]))).rejects.toThrow(/not found or already cancelled/);
    const stranger = await as(STRANGER, (tx) => tx.query(`update participants set payment_status = 'cancelled' where id = $1`, [other.id]));
    expect(stranger.affectedRows ?? 0).toBe(0);
    expect((await as(STRANGER, (tx) => tx.query<{ p: number | null }>('select waitlist_position($1) as p', [mine.id]))).rows[0]?.p ?? null).toBeNull();
    expect((await statusOf(U[3])).payment_status).toBe('waitlisted');
  });

  it('8. a confirmed player cancels; the organizer offers the place to the next waitlisted player', async () => {
    // Places now: Alpha confirmed, Echo under review → full.
    const next = await statusOf(U[3]);
    await expect(as(ORGANIZER, (tx) => tx.query(`update participants set payment_status = 'awaiting_payment', reserved_until = now() + interval '30 minutes' where id = $1`, [next.id]))).rejects.toThrow(/full/);
    const alpha = await statusOf(U[0]);
    await as(U[0], (tx) => tx.query('select cancel_my_registration($1)', [alpha.id]));
    expect((await statusOf(U[0])).payment_status).toBe('cancelled');
    await as(ORGANIZER, (tx) => tx.query(`update participants set payment_status = 'awaiting_payment', reserved_until = now() + interval '30 minutes' where id = $1`, [next.id]));
    expect((await statusOf(U[3])).payment_status).toBe('awaiting_payment'); // offered, still has to pay — not confirmed
  });

  it('10. capacity changes: lowering below confirmed/under-review is refused; raising frees places', async () => {
    await expect(setSettings({ minParticipants: 5 })).rejects.toThrow(/minimum ≤ target ≤ maximum/);
    await as(ORGANIZER, (tx) => tx.query('update tournaments set max_participants = 4 where id = $1', [tid2]));
    await setSettings({ minParticipants: 2, targetParticipants: 4 });
    await register(U[5], 'Foxtrot');
    expect((await statusOf(U[5])).payment_status).toBe('awaiting_payment');
  });

  it('9. paused, not-yet-open and closed registration are refused by the server', async () => {
    await setSettings({ registrationPaused: true });
    await expect(register(STRANGER, 'Golf')).rejects.toThrow(/paused/);
    await setSettings({ registrationPaused: false, registrationOpensAt: new Date(Date.now() + 3_600_000).toISOString() });
    await expect(register(STRANGER, 'Golf')).rejects.toThrow(/not opened/);
    await setSettings({ registrationOpensAt: null });
    await as(ORGANIZER, (tx) => tx.query(`update tournaments set status = 'registration_closed' where id = $1`, [tid2]));
    await expect(register(STRANGER, 'Golf')).rejects.toThrow(/closed/);
    await as(ORGANIZER, (tx) => tx.query('delete from tournaments where id = $1', [tid2]));
  });
});

describe('nicknames', () => {
  it('are unique, validated, and changeable by their owner only', async () => {
    await as(players[0], (tx) => tx.query(`update profiles set display_name = 'Temcch_Pro' where id = $1`, [players[0]]));
    await expect(as(players[1], (tx) => tx.query(`update profiles set display_name = 'temcch_pro' where id = $1`, [players[1]]))).rejects.toThrow(/profiles_nickname_unique/);
    await expect(as(players[1], (tx) => tx.query(`update profiles set display_name = 'a b' where id = $1`, [players[1]]))).rejects.toThrow(/Nickname/);
    const other = await as(players[1], (tx) => tx.query(`update profiles set display_name = 'Hijack' where id = $1`, [players[0]]));
    expect(other.affectedRows ?? 0).toBe(0);
    const free = await as('anon', (tx) => tx.query<{ ok: boolean }>(`select nickname_available('TEMCCH_PRO') as ok`));
    expect(free.rows[0].ok).toBe(false);
  });

  it('gives new accounts their chosen nickname, adding a suffix when taken', async () => {
    const a = '44444444-4444-4444-8444-000000000001';
    const b = '44444444-4444-4444-8444-000000000002';
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'x1@example.test', '{"display_name":"Striker"}')`, [a]);
    await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, 'x2@example.test', '{"display_name":"striker"}')`, [b]);
    const r = await db.query<{ id: string; display_name: string }>('select id, display_name from profiles where id in ($1, $2) order by id', [a, b]);
    expect(r.rows[0].display_name).toBe('Striker');
    expect(r.rows[1].display_name).toMatch(/^striker_[0-9a-f]{4}$/);
  });
});

describe('seed script', () => {
  it('runs against the migrated schema and creates the labelled demo tournament', async () => {
    await db.exec(readFileSync(resolve(__dirname, '../../supabase/seed.sql'), 'utf8'));
    const r = await db.query<{ name: string; status: string; n: number }>(
      `select t.name, t.status, (select count(*) from participants p where p.tournament_id = t.id)::int as n from tournaments t`);
    expect(r.rows).toEqual([{ name: 'Demo Campus Cup (sample data)', status: 'registration_closed', n: 16 }]);
  });
});
