import { describe, expect, it } from 'vitest';
import { BracketEditor, buildKnockout, normalizeResult, sequentialIds, type ResultInput } from '@/engine';
import type { Match } from '@/types/domain';
import { groupMatch, NOW } from './helpers';

const settings = { walkoverGoals: 3 };
const done = (h: number, a: number, extra: Partial<ResultInput> = {}): ResultInput => ({ homeScore: h, awayScore: a, status: 'completed', ...extra });

function bracket(n = 4, thirdPlace = false) {
  return buildKnockout(Array.from({ length: n }, (_, i) => `s${i + 1}`), { tournamentId: 't1', thirdPlace, ids: sequentialIds('k'), now: NOW });
}
const find = (ms: Match[], round: number, slot = 0, third = false) => ms.find((m) => m.round === round && m.slot === slot && m.isThirdPlace === third) as Match;

function record(ms: Match[], id: string, input: ResultInput) {
  const editor = new BracketEditor(ms, NOW);
  editor.update(id, normalizeResult(editor.get(id), input, settings));
  const changed = editor.changed;
  return { matches: ms.map((m) => changed.get(m.id) ?? m), invalidated: editor.invalidated };
}

describe('score validation', () => {
  const g = groupMatch('a', 'b', null, null);
  it.each([[-1, 0], [1.5, 0], [100, 0], [Number.NaN, 1]])('rejects invalid score %s-%s', (h, a) => {
    expect(() => normalizeResult(g, done(h, a), settings)).toThrow(/whole numbers/);
  });
  it('rejects penalties in group matches and results without both participants', () => {
    expect(() => normalizeResult(g, done(1, 1, { homePens: 4, awayPens: 3 }), settings)).toThrow(/penalty/);
    expect(() => normalizeResult({ ...g, awayId: null }, done(1, 0), settings)).toThrow(/participants/);
  });
  it('requires a decisive shoot-out for a level knockout match', () => {
    const ko = find(bracket(), 1);
    expect(() => normalizeResult(ko, done(2, 2), settings)).toThrow(/penalty/);
    expect(() => normalizeResult(ko, done(2, 2, { homePens: 4, awayPens: 4 }), settings)).toThrow(/winner/);
    expect(() => normalizeResult(ko, done(2, 1, { homePens: 4, awayPens: 3 }), settings)).toThrow(/level/);
    expect(normalizeResult(ko, done(2, 2, { homePens: 3, awayPens: 5 }), settings).winnerId).toBe(ko.awayId);
  });
  it('records walkovers with the configured score', () => {
    const r = normalizeResult(g, { homeScore: 0, awayScore: 0, walkoverWinner: 'away', status: 'completed' }, settings);
    expect(r).toMatchObject({ homeScore: 0, awayScore: 3, walkover: true, winnerId: 'b', status: 'completed' });
  });
});

describe('winner advancement and downstream invalidation', () => {
  it('advances the winner into the correct slot of the next match', () => {
    let ms = bracket(4);
    ms = record(ms, find(ms, 1, 0).id, done(2, 0)).matches; // s1 beats s4
    ms = record(ms, find(ms, 1, 1).id, done(0, 1)).matches; // s3 beats s2
    expect([find(ms, 2).homeId, find(ms, 2).awayId]).toEqual(['s1', 's3']);
  });

  it('does not advance anyone from an in-progress (live) score', () => {
    let ms = bracket(4);
    ms = record(ms, find(ms, 1, 0).id, { homeScore: 1, awayScore: 0, status: 'in_progress' }).matches;
    expect(find(ms, 2).homeId).toBeNull();
  });

  it('keeps later rounds untouched when a correction does not change the winner', () => {
    let ms = bracket(4);
    ms = record(ms, find(ms, 1, 0).id, done(2, 0)).matches;
    ms = record(ms, find(ms, 1, 1).id, done(1, 0)).matches;
    ms = record(ms, find(ms, 2).id, done(3, 1)).matches;
    const { matches, invalidated } = record(ms, find(ms, 1, 0).id, done(5, 0));
    expect(invalidated).toHaveLength(0);
    expect(find(matches, 2)).toMatchObject({ homeScore: 3, awayScore: 1, status: 'completed', winnerId: 's1' });
  });

  it('clears dependent results when an earlier winner changes, cascading through the bracket', () => {
    let ms = bracket(8, true);
    for (let s = 0; s < 4; s++) ms = record(ms, find(ms, 1, s).id, done(1, 0)).matches; // seeds 1,4,2,3 win
    ms = record(ms, find(ms, 2, 0).id, done(1, 0)).matches; // s1 beats s4
    ms = record(ms, find(ms, 2, 1).id, done(1, 0)).matches; // s2 beats s3
    ms = record(ms, find(ms, 3, 0).id, done(2, 1)).matches; // final: s1 champion
    ms = record(ms, find(ms, 3, 1, true).id, done(0, 0, { homePens: 5, awayPens: 4 })).matches;
    expect(find(ms, 3).winnerId).toBe('s1');

    // Correct the first quarter-final: s8 actually beat s1.
    const { matches, invalidated } = record(ms, find(ms, 1, 0).id, done(0, 1));
    expect(find(matches, 2, 0)).toMatchObject({ homeId: 's8', status: 'scheduled', homeScore: null, winnerId: null });
    // The final loses s1 and its result; the other finalist (s2) stays in place.
    expect(find(matches, 3)).toMatchObject({ homeId: null, awayId: 's2', status: 'scheduled', winnerId: null });
    // The third-place match loses s4 (the old semi-final loser) and its result.
    expect(find(matches, 3, 1, true)).toMatchObject({ homeId: null, awayId: 's3', status: 'scheduled' });
    expect(new Set(invalidated)).toEqual(new Set([find(ms, 2, 0).id, find(ms, 3).id, find(ms, 3, 1, true).id]));
  });

  it('pulls a winner back out of the next round when a result is reopened', () => {
    let ms = bracket(4);
    ms = record(ms, find(ms, 1, 0).id, done(2, 0)).matches;
    const editor = new BracketEditor(ms, NOW);
    editor.update(find(ms, 1, 0).id, { status: 'scheduled', homeScore: null, awayScore: null, winnerId: null });
    expect(editor.get(find(ms, 2).id).homeId).toBeNull();
  });

  it('never places the same participant on both sides of a match', () => {
    const ms = bracket(4);
    const final = find(ms, 2);
    const tampered = ms.map((m) => (m.id === final.id ? { ...m, awayId: 's1' } : m));
    expect(() => record(tampered, find(tampered, 1, 0).id, done(1, 0))).toThrow(/both sides/);
  });
});
