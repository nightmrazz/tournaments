import { describe, expect, it } from 'vitest';
import { buildKnockout, roundName, seedPositions, seedsFromGroups, seedsForSingleElimination, sequentialIds } from '@/engine';
import { makeParticipants, NOW } from './helpers';

const opts = (thirdPlace = false) => ({ tournamentId: 't1', thirdPlace, ids: sequentialIds('k'), now: NOW });
const seeds = (n: number) => Array.from({ length: n }, (_, i) => `s${i + 1}`);

describe('knockout bracket generation', () => {
  it('uses the standard seed order', () => {
    expect(seedPositions(2)).toEqual([1, 2]);
    expect(seedPositions(4)).toEqual([1, 4, 2, 3]);
    expect(seedPositions(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    expect(() => seedPositions(6)).toThrow();
  });

  it('builds 7 wired matches for 8 entrants with seeds 1 and 2 in opposite halves', () => {
    const ms = buildKnockout(seeds(8), opts());
    expect(ms).toHaveLength(7);
    const r1 = ms.filter((m) => m.round === 1).sort((a, b) => a.slot - b.slot);
    expect(r1.map((m) => [m.homeId, m.awayId])).toEqual([['s1', 's8'], ['s4', 's5'], ['s2', 's7'], ['s3', 's6']]);
    const final = ms.find((m) => m.round === 3);
    expect(final?.nextMatchId).toBeNull();
    // Every non-final match feeds exactly one slot, no slot is fed twice.
    const fed = ms.filter((m) => m.nextMatchId).map((m) => `${m.nextMatchId}:${m.nextSlot}`);
    expect(new Set(fed).size).toBe(6);
  });

  it('gives byes to the top seeds when the field is not a power of two', () => {
    const ms = buildKnockout(seeds(6), opts());
    const r1 = ms.filter((m) => m.round === 1);
    const r2 = ms.filter((m) => m.round === 2).sort((a, b) => a.slot - b.slot);
    expect(r1).toHaveLength(2);
    expect(r2[0].homeId).toBe('s1');
    expect(r2[1].homeId).toBe('s2');
    const placed = ms.flatMap((m) => [m.homeId, m.awayId]).filter(Boolean);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed).toHaveLength(6);
  });

  it('adds a third-place match fed by the semi-final losers', () => {
    const ms = buildKnockout(seeds(8), opts(true));
    const third = ms.find((m) => m.isThirdPlace);
    expect(third).toBeDefined();
    const semis = ms.filter((m) => m.round === 2);
    expect(semis.map((m) => [m.loserNextMatchId, m.loserNextSlot])).toEqual([[third?.id, 'home'], [third?.id, 'away']]);
    expect(buildKnockout(seeds(3), opts(true)).some((m) => m.isThirdPlace)).toBe(false);
  });

  it('rejects duplicate participants and tiny fields', () => {
    expect(() => buildKnockout(['a', 'b', 'a', 'c'], opts())).toThrow(/twice/);
    expect(() => buildKnockout(['a'], opts())).toThrow();
  });

  it('names rounds by the number of matches', () => {
    expect([8, 4, 2, 1].map((n) => roundName(n))).toEqual(['Round of 16', 'Quarter-finals', 'Semi-finals', 'Final']);
  });
});

describe('qualification into the bracket', () => {
  it('crosses groups so group-mates do not meet in round one (4 groups × top 2 → quarter-finals)', () => {
    const groups = ['A', 'B', 'C', 'D'].map((g) => [`${g}1`, `${g}2`, `${g}3`, `${g}4`]);
    const s = seedsFromGroups(groups, 2);
    expect(s).toEqual(['A1', 'B1', 'C1', 'D1', 'A2', 'B2', 'C2', 'D2']);
    const ms = buildKnockout(s, opts());
    const pairs = ms.filter((m) => m.round === 1).map((m) => [m.homeId?.[0], m.awayId?.[0]]);
    expect(pairs.every(([a, b]) => a !== b)).toBe(true);
    expect(ms.filter((m) => m.round === 1).map((m) => [m.homeId, m.awayId])).toEqual([['A1', 'D2'], ['D1', 'A2'], ['B1', 'C2'], ['C1', 'B2']]);
  });

  it('seeds a straight knockout deterministically from the draw seed, manual seeds first', () => {
    const ps = makeParticipants(8).map((p) => (p.id === 'p05' ? { ...p, seed: 1 } : p));
    const a = seedsForSingleElimination(ps, 42);
    expect(a[0]).toBe('p05');
    expect(seedsForSingleElimination(ps, 42)).toEqual(a);
    expect(new Set(a).size).toBe(8);
  });
});
