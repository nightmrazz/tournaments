import { describe, expect, it } from 'vitest';
import { roundRobin, roundRobinMatchCount } from '@/engine';

const ids = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);
const pairKey = (a: string, b: string) => [a, b].sort().join('|');

describe('round robin fixture generation', () => {
  it.each([2, 3, 4, 5, 6, 7, 8])('every pair meets exactly once for %i entrants', (n) => {
    const fixtures = roundRobin(ids(n));
    expect(fixtures).toHaveLength(roundRobinMatchCount(n));
    const keys = fixtures.map((f) => pairKey(f.home, f.away));
    expect(new Set(keys).size).toBe(keys.length);
    expect(fixtures.every((f) => f.home !== f.away)).toBe(true);
  });

  it('produces n-1 matchdays for even n and n for odd n, with nobody playing twice per matchday', () => {
    for (const n of [4, 5, 6]) {
      const fixtures = roundRobin(ids(n));
      const rounds = new Set(fixtures.map((f) => f.round));
      expect(rounds.size).toBe(n % 2 === 0 ? n - 1 : n);
      for (const r of rounds) {
        const players = fixtures.filter((f) => f.round === r).flatMap((f) => [f.home, f.away]);
        expect(new Set(players).size).toBe(players.length);
      }
    }
  });

  it('double round robin plays each pair twice with swapped sides', () => {
    const fixtures = roundRobin(ids(4), true);
    expect(fixtures).toHaveLength(12);
    const directed = fixtures.map((f) => `${f.home}>${f.away}`);
    expect(new Set(directed).size).toBe(12);
  });

  it('is deterministic and rejects duplicates', () => {
    expect(roundRobin(ids(6))).toEqual(roundRobin(ids(6)));
    expect(() => roundRobin(['a', 'a', 'b'])).toThrow();
  });

  it('balances home and away appearances', () => {
    const fixtures = roundRobin(ids(4));
    for (const id of ids(4)) {
      const home = fixtures.filter((f) => f.home === id).length;
      expect(home).toBeGreaterThanOrEqual(1);
      expect(home).toBeLessThanOrEqual(2);
    }
  });
});
