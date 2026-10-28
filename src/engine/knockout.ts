import type { Match, Participant, Side } from '@/types/domain';
import { EngineError } from './errors';
import type { IdFactory } from './ids';
import { seededShuffle } from './random';

export function nextPowerOfTwo(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Standard bracket seed order: for size 8 → [1, 8, 4, 5, 2, 7, 3, 6].
 * Adjacent entries meet in round 1; seeds 1 and 2 can only meet in the final.
 */
export function seedPositions(size: number): number[] {
  if (size < 1 || (size & (size - 1)) !== 0) throw new EngineError('INVALID_CONFIG', 'Bracket size must be a power of two');
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2;
    order = order.flatMap((s) => [s, n + 1 - s]);
  }
  return order;
}

export function roundName(matchesInRound: number, isThirdPlace = false): string {
  if (isThirdPlace) return 'Third-place match';
  switch (matchesInRound) {
    case 1: return 'Final';
    case 2: return 'Semi-finals';
    case 4: return 'Quarter-finals';
    case 8: return 'Round of 16';
    case 16: return 'Round of 32';
    case 32: return 'Round of 64';
    default: return `Round of ${matchesInRound * 2}`;
  }
}

export function roundCount(entrants: number): number {
  return Math.log2(nextPowerOfTwo(entrants));
}

export interface BuildKnockoutOptions {
  tournamentId: string;
  thirdPlace: boolean;
  ids: IdFactory;
  now: string;
}

function blankMatch(id: string, tournamentId: string, round: number, slot: number, now: string): Match {
  return {
    id, tournamentId, stage: 'knockout', groupId: null, round, slot, isThirdPlace: false,
    homeId: null, awayId: null, homeScore: null, awayScore: null, homePens: null, awayPens: null,
    winnerId: null, walkover: false, status: 'scheduled', scheduledAt: null, station: null,
    nextMatchId: null, nextSlot: null, loserNextMatchId: null, loserNextSlot: null, updatedAt: now,
  };
}

/**
 * Builds a single-elimination bracket from an ordered seed list (index 0 = seed 1).
 * When the entrant count is not a power of two, the top seeds receive byes: their first-round
 * match is not created and they are placed straight into round 2.
 */
export function buildKnockout(seeds: readonly string[], opts: BuildKnockoutOptions): Match[] {
  if (seeds.length < 2) throw new EngineError('INVALID_CONFIG', 'A knockout needs at least 2 participants');
  if (new Set(seeds).size !== seeds.length) throw new EngineError('DUPLICATE', 'A participant appears twice in the knockout seeding');
  const size = nextPowerOfTwo(seeds.length);
  const rounds = Math.log2(size);
  const order = seedPositions(size);
  const byRound: Match[][] = [];
  for (let r = 1; r <= rounds; r++) {
    const count = size / 2 ** r;
    byRound.push(Array.from({ length: count }, (_, s) => blankMatch(opts.ids(), opts.tournamentId, r, s, opts.now)));
  }
  // Wire winners forward.
  for (let r = 0; r < rounds - 1; r++) {
    byRound[r].forEach((m, s) => {
      m.nextMatchId = byRound[r + 1][Math.floor(s / 2)].id;
      m.nextSlot = s % 2 === 0 ? 'home' : 'away';
    });
  }
  // Place entrants.
  const removed = new Set<string>();
  for (let s = 0; s < size / 2; s++) {
    const a = seeds[order[2 * s] - 1];
    const b = seeds[order[2 * s + 1] - 1];
    const m = byRound[0][s];
    if (a && b) {
      m.homeId = a;
      m.awayId = b;
    } else {
      // Bye: the present entrant goes straight to round 2.
      const present = (a ?? b) as string;
      const next = byRound[1][Math.floor(s / 2)];
      if (s % 2 === 0) next.homeId = present; else next.awayId = present;
      removed.add(m.id);
    }
  }
  const all = byRound.flat().filter((m) => !removed.has(m.id));
  if (opts.thirdPlace && seeds.length >= 4 && rounds >= 2) {
    const third = blankMatch(opts.ids(), opts.tournamentId, rounds, 1, opts.now);
    third.isThirdPlace = true;
    byRound[rounds - 2].forEach((semi, s) => {
      semi.loserNextMatchId = third.id;
      semi.loserNextSlot = s === 0 ? 'home' : 'away';
    });
    all.push(third);
  }
  return all;
}

/**
 * Seed list for the knockout after a group stage: all group winners (group A first), then all
 * runners-up, etc. Combined with the standard bracket order this pairs A1–D2, B1–C2, C1–B2, D1–A2
 * for 4 groups × 2, so teams from the same group cannot meet in the first round.
 */
export function seedsFromGroups(rankedGroups: readonly (readonly string[])[], advancePerGroup: number): string[] {
  const seeds: string[] = [];
  for (let pos = 0; pos < advancePerGroup; pos++) {
    for (const group of rankedGroups) {
      if (group[pos]) seeds.push(group[pos]);
    }
  }
  return seeds;
}

/** Seeding for a straight knockout: manual seeds first (ascending), the rest in a seeded random order. */
export function seedsForSingleElimination(participants: readonly Participant[], drawSeed: number): string[] {
  const seeded = participants.filter((p) => p.seed !== null).sort((a, b) => (a.seed as number) - (b.seed as number) || a.id.localeCompare(b.id));
  const unseeded = [...participants.filter((p) => p.seed === null)].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return [...seeded.map((p) => p.id), ...seededShuffle(unseeded.map((p) => p.id), drawSeed)];
}

/**
 * Where each entrant was originally placed, ignoring slots that are filled by advancement.
 * Two brackets with identical entry placements were seeded identically.
 */
export function entryPlacements(knockout: readonly Match[]): Map<string, string | null> {
  const fed = new Set<string>();
  for (const m of knockout) {
    if (m.nextMatchId && m.nextSlot) fed.add(`${m.nextMatchId}:${m.nextSlot}`);
    if (m.loserNextMatchId && m.loserNextSlot) fed.add(`${m.loserNextMatchId}:${m.loserNextSlot}`);
  }
  const out = new Map<string, string | null>();
  for (const m of knockout) {
    for (const side of ['home', 'away'] as Side[]) {
      if (fed.has(`${m.id}:${side}`)) continue;
      const key = `${m.isThirdPlace ? 'T' : 'R'}${m.round}:${m.slot}:${side}`;
      out.set(key, side === 'home' ? m.homeId : m.awayId);
    }
  }
  return out;
}

export function samePlacements(a: Map<string, string | null>, b: Map<string, string | null>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
