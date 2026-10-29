import { describe, expect, it } from 'vitest';
import { computeGroupStandings, fallbackInfo } from '@/engine';
import { DEFAULT_SETTINGS, type TournamentSettings } from '@/types/domain';
import { groupMatch, makeParticipants } from './helpers';

const P = makeParticipants(4);
const ids = P.map((p) => p.id); // p01..p04
const info = fallbackInfo(P);
const base: TournamentSettings = { ...DEFAULT_SETTINGS, advancePerGroup: 2 };
type TB = TournamentSettings['tiebreakers'];

describe('group standings', () => {
  it('awards 3/1/0 points and computes goal difference', () => {
    const matches = [groupMatch('p01', 'p02', 3, 1), groupMatch('p03', 'p04', 2, 2)];
    const { rows } = computeGroupStandings(ids, matches, base, info);
    const r = Object.fromEntries(rows.map((x) => [x.participantId, x]));
    expect(r.p01).toMatchObject({ played: 1, won: 1, points: 3, goalsFor: 3, goalsAgainst: 1, goalDiff: 2 });
    expect(r.p02).toMatchObject({ played: 1, lost: 1, points: 0, goalDiff: -2 });
    expect(r.p03).toMatchObject({ drawn: 1, points: 1, goalDiff: 0 });
    expect(rows[0].participantId).toBe('p01');
    expect(rows[3].participantId).toBe('p02');
  });

  it('uses configurable points', () => {
    const matches = [groupMatch('p01', 'p02', 1, 0), groupMatch('p03', 'p04', 0, 0)];
    const { rows } = computeGroupStandings(ids, matches, { ...base, pointsWin: 2 }, info);
    expect(rows.find((r) => r.participantId === 'p01')?.points).toBe(2);
  });

  it('ignores cancelled, scheduled and in-progress matches', () => {
    const matches = [
      groupMatch('p01', 'p02', 5, 0, { status: 'cancelled' }),
      groupMatch('p01', 'p03', 2, 0, { status: 'in_progress' }),
      groupMatch('p01', 'p04', null, null),
    ];
    const s = computeGroupStandings(ids, matches, base, info);
    expect(s.rows.every((r) => r.played === 0)).toBe(true);
    expect(s.complete).toBe(false);
    expect(s.totalMatches).toBe(2); // the cancelled match is excluded
    expect(s.rows.every((r) => r.qualification === 'pending')).toBe(true);
  });

  it('sorts by points, then goal difference, then goals scored', () => {
    const matches = [
      groupMatch('p01', 'p03', 1, 0), // p01 +1
      groupMatch('p02', 'p04', 4, 0), // p02 +4
      groupMatch('p03', 'p04', 3, 3), // p03 GD -1, p04 GD -4
    ];
    const { rows } = computeGroupStandings(ids, matches, base, info);
    expect(rows.map((r) => r.participantId)).toEqual(['p02', 'p01', 'p03', 'p04']);
  });

  it('separates equal goal difference by goals scored', () => {
    const matches = [groupMatch('p01', 'p03', 3, 2), groupMatch('p02', 'p04', 1, 0)];
    const { rows } = computeGroupStandings(ids, matches, base, info);
    expect(rows[0].participantId).toBe('p01');
    expect(rows[0].decidedByFallback).toBe(false);
  });

  it('applies head-to-head before goal difference when configured first', () => {
    const matches = [
      groupMatch('p01', 'p02', 1, 0),
      groupMatch('p02', 'p03', 5, 0),
      groupMatch('p03', 'p01', 1, 0),
      groupMatch('p04', 'p01', 0, 0), groupMatch('p04', 'p02', 0, 0), groupMatch('p04', 'p03', 0, 3),
    ];
    // p03: 6 pts. p01: 4 pts GD 0, beat p02. p02: 4 pts GD +4.
    const h2hFirst = { ...base, tiebreakers: ['h2h_points', 'goal_diff', 'goals_for'] as TB };
    expect(computeGroupStandings(ids, matches, h2hFirst, info).rows.map((r) => r.participantId).slice(0, 3)).toEqual(['p03', 'p01', 'p02']);
    const gdFirst = { ...base, tiebreakers: ['goal_diff', 'h2h_points'] as TB };
    expect(computeGroupStandings(ids, matches, gdFirst, info).rows.map((r) => r.participantId).slice(0, 3)).toEqual(['p03', 'p02', 'p01']);
  });

  it('resolves a three-way tie with a head-to-head mini-table and re-applies it to the remaining pair', () => {
    const matches = [
      groupMatch('p01', 'p04', 1, 0), groupMatch('p02', 'p04', 1, 0), groupMatch('p03', 'p04', 1, 0),
      groupMatch('p01', 'p02', 3, 0),
      groupMatch('p02', 'p03', 1, 0),
      groupMatch('p03', 'p01', 2, 0),
    ];
    // Mini-table p01/p02/p03: all 3 pts; GD p01 +1, p02 -2, p03 +1.
    const s = { ...base, tiebreakers: ['h2h_points', 'h2h_goal_diff', 'h2h_goals_for', 'goals_for'] as TB };
    const { rows } = computeGroupStandings(ids, matches, s, info);
    // {p01,p03} is re-ranked on its own: p03 won the direct meeting.
    expect(rows.map((r) => r.participantId)).toEqual(['p03', 'p01', 'p02', 'p04']);
    expect(rows.every((r) => !r.decidedByFallback)).toBe(true);
  });

  it('uses the deterministic fallback (seed, then registration order) when everything is equal and flags it', () => {
    const seeded = makeParticipants(4).map((p) => (p.id === 'p02' ? { ...p, seed: 1 } : p));
    const matches = [groupMatch('p01', 'p02', 1, 1), groupMatch('p03', 'p04', 1, 1)];
    const { rows } = computeGroupStandings(ids, matches, base, fallbackInfo(seeded));
    expect(rows.map((r) => r.participantId)).toEqual(['p02', 'p01', 'p03', 'p04']);
    expect(rows.every((r) => r.decidedByFallback)).toBe(true);
    const reversed = computeGroupStandings([...ids].reverse(), [...matches].reverse(), base, fallbackInfo(seeded));
    expect(reversed.rows.map((r) => r.participantId)).toEqual(['p02', 'p01', 'p03', 'p04']);
  });

  it('marks qualification once the group is complete', () => {
    const matches = [
      groupMatch('p01', 'p02', 1, 0), groupMatch('p03', 'p04', 1, 0), groupMatch('p01', 'p03', 1, 0),
      groupMatch('p02', 'p04', 1, 0), groupMatch('p01', 'p04', 1, 0), groupMatch('p02', 'p03', 1, 0),
    ];
    const s = computeGroupStandings(ids, matches, base, info);
    expect(s.complete).toBe(true);
    expect(s.rows.map((r) => [r.participantId, r.qualification])).toEqual([
      ['p01', 'qualified'], ['p02', 'qualified'], ['p03', 'eliminated'], ['p04', 'eliminated'],
    ]);
  });

  it('reflects an edited result', () => {
    const m = groupMatch('p01', 'p02', 2, 0);
    expect(computeGroupStandings(ids, [m], base, info).rows[0].participantId).toBe('p01');
    expect(computeGroupStandings(ids, [{ ...m, homeScore: 0, awayScore: 2 }], base, info).rows[0].participantId).toBe('p02');
  });
});
