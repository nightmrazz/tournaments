import { describe, expect, it } from 'vitest';
import {
  applyMutation, assertCanAssignTeam, assertCanRegister, EngineError, finalMatch, groupStageComplete, groupTables, knockoutMatches, knockoutRounds,
  planGroupStage, planKnockoutFromGroups, planMatchChange, planResetGroupStage, planSingleElimination, planStatusChange,
  podium, previewDraw, stageProgress, type Mutation,
} from '@/engine';
import type { Match, Participant, TournamentBundle } from '@/types/domain';
import { ctx, makeBundle, makeParticipants, makeTournament, NOW } from './helpers';

const apply = (b: TournamentBundle, m: Mutation) => applyMutation(b, m, NOW);

function withGroups(n = 16, settings = {}) {
  const b = makeBundle(n, {}, settings);
  const draw = previewDraw(b, 7);
  return apply(b, planGroupStage(b, draw, ctx()).mutation);
}

/** Plays every open match of a stage: lower participant id wins 2-0 (deterministic). */
function playAll(b: TournamentBundle, stage: Match['stage']): TournamentBundle {
  let cur = b;
  for (;;) {
    const m = cur.matches.find((x) => x.stage === stage && x.status !== 'completed' && x.homeId && x.awayId);
    if (!m) return cur;
    const homeWins = (m.homeId as string) < (m.awayId as string);
    cur = apply(cur, planMatchChange(cur, m.id, { type: 'result', input: { homeScore: homeWins ? 2 : 0, awayScore: homeWins ? 0 : 2, status: 'completed' } }, ctx()).mutation);
  }
}

describe('group stage generation', () => {
  it('draws 16 participants into 4 groups of 4 with 24 unique fixtures', () => {
    const b = withGroups();
    expect(b.groups).toHaveLength(4);
    expect(b.groupMembers).toHaveLength(16);
    expect(new Set(b.groupMembers.map((m) => m.participantId)).size).toBe(16);
    expect(b.matches).toHaveLength(24);
    const keys = b.matches.map((m) => [m.homeId, m.awayId].sort().join('|'));
    expect(new Set(keys).size).toBe(24);
    for (const m of b.matches) {
      const g = b.groupMembers.filter((x) => x.groupId === m.groupId).map((x) => x.participantId);
      expect(g).toContain(m.homeId);
      expect(g).toContain(m.awayId);
    }
    expect(b.tournament.status).toBe('in_progress');
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    const b = makeBundle(16);
    expect(previewDraw(b, 99)).toEqual(previewDraw(b, 99));
    expect(previewDraw(b, 99)).not.toEqual(previewDraw(b, 100));
  });

  it('spreads manual seeds across different groups', () => {
    const b = makeBundle(16);
    b.participants = b.participants.map((p, i) => (i < 4 ? { ...p, seed: i + 1 } : p));
    const draw = previewDraw(b, 3);
    draw.forEach((g, i) => expect(g[0]).toBe(`p0${i + 1}`));
  });

  it('validates feasibility and preconditions', () => {
    expect(() => previewDraw(makeBundle(6), 1)).toThrow(EngineError); // 6 players cannot fill 4 groups
    const open = makeBundle(16, { status: 'registration_open' });
    expect(() => planGroupStage(open, previewDraw(open, 1), ctx())).toThrow(/Close registration/);
    const b = makeBundle(16);
    const draw = previewDraw(b, 1);
    const changed = { ...b, participants: b.participants.slice(1) };
    expect(() => planGroupStage(changed, draw, ctx())).toThrow();
    const generated = apply(b, planGroupStage(b, draw, ctx()).mutation);
    expect(() => planGroupStage({ ...generated, tournament: { ...generated.tournament, status: 'registration_closed' } }, draw, ctx())).toThrow(/already/);
  });

  it('prevents redrawing once results exist', () => {
    let b = withGroups();
    expect(() => planResetGroupStage(b)).not.toThrow();
    b = apply(b, planMatchChange(b, b.matches[0].id, { type: 'result', input: { homeScore: 1, awayScore: 0, status: 'completed' } }, ctx()).mutation);
    expect(() => planResetGroupStage(b)).toThrow(/Results/);
  });
});

describe('group stage → knockout → champion', () => {
  it('refuses to start the knockout while group matches are unfinished', () => {
    const b = withGroups();
    expect(() => planKnockoutFromGroups(b, ctx())).toThrow(/All group matches/);
  });

  it('runs a full 16-player tournament to a champion', () => {
    let b = playAll(withGroups(), 'group');
    expect(groupStageComplete(b)).toBe(true);
    const tables = groupTables(b);
    const qualified = tables.flatMap((t) => t.standings.rows.filter((r) => r.qualification === 'qualified').map((r) => r.participantId));
    expect(qualified).toHaveLength(8);

    b = apply(b, planKnockoutFromGroups(b, ctx()).mutation);
    const rounds = knockoutRounds(b);
    expect(rounds.map((r) => r.name)).toEqual(['Quarter-finals', 'Semi-finals', 'Final', 'Third-place match']);
    const qf = rounds[0].matches.flatMap((m) => [m.homeId, m.awayId]);
    expect(new Set(qf)).toEqual(new Set(qualified));
    // Group winners face runners-up from another group.
    const winners = new Set(tables.map((t) => t.standings.rows[0].participantId));
    for (const m of rounds[0].matches) expect(winners.has(m.homeId as string)).toBe(true);

    expect(() => planKnockoutFromGroups(b, ctx())).toThrow(/already exists/);
    expect(() => planStatusChange(b, 'completed')).toThrow(/final/);

    b = playAll(b, 'knockout');
    const p = podium(b);
    expect(p.champion).toBe(finalMatch(b)?.winnerId);
    expect(p.runnerUp).not.toBeNull();
    expect(p.third).not.toBeNull();
    b = apply(b, planStatusChange(b, 'completed').mutation);
    expect(b.tournament.status).toBe('completed');
    expect(stageProgress(b).every((s) => s.state === 'done')).toBe(true);
    // A completed tournament is read-only until reopened.
    expect(() => planMatchChange(b, b.matches[0].id, { type: 'clear' }, ctx())).toThrow(/completed/);
  });

  it('detects group-result edits that invalidate the bracket and only resets it with confirmation', () => {
    let b = playAll(withGroups(), 'group');
    b = apply(b, planKnockoutFromGroups(b, ctx()).mutation);
    const table = groupTables(b)[0];
    const second = table.standings.rows[1].participantId;
    const third = table.standings.rows[2].participantId;
    // Make the 3rd-placed participant win every group match → qualification changes.
    const theirs = b.matches.filter((m) => m.stage === 'group' && (m.homeId === third || m.awayId === third));
    let edited = b;
    let conflict: unknown = null;
    for (const m of theirs) {
      const input = { homeScore: m.homeId === third ? 9 : 0, awayScore: m.awayId === third ? 9 : 0, status: 'completed' as const };
      try {
        edited = apply(edited, planMatchChange(edited, m.id, { type: 'result', input }, ctx()).mutation);
      } catch (e) {
        conflict = e;
        const r = planMatchChange(edited, m.id, { type: 'result', input }, ctx(), { resetKnockoutIfInvalid: true });
        expect(r.mutation.deleteMatchIds).toHaveLength(knockoutMatches(edited).length);
        edited = apply(edited, r.mutation);
      }
    }
    expect(conflict).toBeInstanceOf(EngineError);
    expect((conflict as EngineError).code).toBe('KNOCKOUT_CONFLICT');
    expect(knockoutMatches(edited)).toHaveLength(0);
    expect(groupTables(edited)[0].standings.rows.slice(0, 2).map((r) => r.participantId)).toContain(third);
    void second;
  });

  it('allows score corrections that do not change qualification without touching the bracket', () => {
    let b = playAll(withGroups(), 'group');
    b = apply(b, planKnockoutFromGroups(b, ctx()).mutation);
    const m = b.matches.find((x) => x.stage === 'group' && x.status === 'completed') as Match;
    const bigger = { homeScore: (m.homeScore as number) > 0 ? 3 : 0, awayScore: (m.awayScore as number) > 0 ? 3 : 0, status: 'completed' as const };
    const r = planMatchChange(b, m.id, { type: 'result', input: bigger }, ctx());
    expect(r.mutation.deleteMatchIds).toHaveLength(0);
  });

  it('forbids cancelling knockout matches and changing completed matches without clearing first', () => {
    let b = playAll(withGroups(), 'group');
    b = apply(b, planKnockoutFromGroups(b, ctx()).mutation);
    const ko = knockoutRounds(b)[0].matches[0];
    expect(() => planMatchChange(b, ko.id, { type: 'meta', status: 'cancelled' }, ctx())).toThrow(/walkover/);
    const g = b.matches.find((x) => x.stage === 'group') as Match;
    expect(() => planMatchChange(b, g.id, { type: 'meta', status: 'postponed' }, ctx())).toThrow(/Clear the result/);
  });
});

describe('single elimination', () => {
  it('builds a bracket with byes for 6 participants and plays to a champion', () => {
    let b = makeBundle(6, { format: 'single_elimination', maxParticipants: 8 });
    b = apply(b, planSingleElimination(b, 5, ctx()).mutation);
    expect(knockoutRounds(b).map((r) => r.name)).toEqual(['Quarter-finals', 'Semi-finals', 'Final', 'Third-place match']);
    b = playAll(b, 'knockout');
    expect(podium(b).champion).not.toBeNull();
  });
});

describe('registration rules', () => {
  const t = makeTournament({ status: 'registration_open', maxParticipants: 3 });
  const existing: Participant[] = makeParticipants(2).map((p, i) => ({ ...p, userId: `u${i}` }));
  const reg = (input: { displayName: string; contact?: string }, userId: string | null = 'new', tt = t, ex = existing) =>
    assertCanRegister(tt, ex, input, { userId, asOrganizer: false });

  it('accepts a valid registration', () => expect(() => reg({ displayName: 'New' })).not.toThrow());
  it('prevents duplicate names (case- and space-insensitive) and duplicate accounts', () => {
    expect(() => reg({ displayName: '  player   1 ' })).toThrow(/already registered/);
    expect(() => reg({ displayName: 'Other' }, 'u0')).toThrow(/already registered/);
  });
  it('respects capacity, status and deadline', () => {
    expect(() => reg({ displayName: 'X' }, 'n', t, makeParticipants(3))).toThrow(/full/);
    expect(() => reg({ displayName: 'X' }, 'n', { ...t, status: 'registration_closed' })).toThrow(/closed/);
    expect(() => reg({ displayName: 'X' }, 'n', { ...t, status: 'cancelled' })).toThrow(/cancelled/);
    expect(() => reg({ displayName: 'X' }, 'n', { ...t, registrationDeadline: '2020-01-01T00:00:00Z' })).toThrow(/deadline/);
  });
  it('requires contact info when the organizer asks for it', () => {
    const tc = { ...t, settings: { ...t.settings, requireContact: true } };
    expect(() => reg({ displayName: 'X' }, 'n', tc)).toThrow(/contact/);
    expect(() => reg({ displayName: 'X', contact: '@x' }, 'n', tc)).not.toThrow();
  });
});

describe('team assignment', () => {
  it('is only possible after the draw and until the tournament ends', () => {
    expect(() => assertCanAssignTeam(makeTournament(), false)).toThrow(/after the draw/);
    expect(() => assertCanAssignTeam(makeTournament({ status: 'in_progress' }), true)).not.toThrow();
    expect(() => assertCanAssignTeam(makeTournament({ status: 'completed' }), true)).toThrow(/closed/);
    expect(() => assertCanAssignTeam(makeTournament({ status: 'cancelled' }), true)).toThrow(/closed/);
  });
});

describe('status transitions', () => {
  it('blocks invalid transitions and reopening registration after fixtures exist', () => {
    const b = makeBundle(4, { status: 'draft' });
    expect(() => planStatusChange(b, 'completed')).toThrow(/Cannot change/);
    expect(planStatusChange(b, 'registration_open').mutation.tournamentStatus).toBe('registration_open');
    const started = withGroups();
    expect(() => planStatusChange(started, 'registration_open')).toThrow();
    const cancelled = { ...b, tournament: { ...b.tournament, status: 'cancelled' as const } };
    expect(() => planStatusChange(cancelled, 'draft')).toThrow();
  });
});
