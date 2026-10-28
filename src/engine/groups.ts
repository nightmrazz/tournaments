import type { Group, GroupMember, Match, Participant, TournamentSettings } from '@/types/domain';
import { EngineError } from './errors';
import type { IdFactory } from './ids';
import { nextPowerOfTwo } from './knockout';
import { seededShuffle } from './random';
import { roundRobin } from './roundRobin';

export const groupLetter = (index: number): string =>
  index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(65 + Math.floor(index / 26) - 1)}${String.fromCharCode(65 + (index % 26))}`;

/** Draw result the organizer reviews before it is persisted. Each inner array is one group, in draw order. */
export type GroupDraw = string[][];

/**
 * Checks that a group stage + knockout configuration is playable with `n` participants.
 * Returns a list of human-readable problems (empty = feasible).
 */
export function groupConfigProblems(n: number, s: Pick<TournamentSettings, 'groupCount' | 'advancePerGroup'>): string[] {
  const problems: string[] = [];
  if (!Number.isInteger(s.groupCount) || s.groupCount < 1) problems.push('Group count must be at least 1.');
  if (!Number.isInteger(s.advancePerGroup) || s.advancePerGroup < 1) problems.push('At least one participant must advance from each group.');
  if (problems.length) return problems;
  if (n < s.groupCount * 2) problems.push(`${n} participants cannot fill ${s.groupCount} groups (each group needs at least 2).`);
  const smallest = Math.floor(n / s.groupCount);
  if (s.advancePerGroup >= smallest && n >= s.groupCount * 2)
    problems.push(`Advancing ${s.advancePerGroup} per group leaves nobody eliminated in a group of ${smallest}.`);
  const qualifiers = s.groupCount * s.advancePerGroup;
  if (qualifiers < 2) problems.push('The knockout stage needs at least 2 qualifiers.');
  return problems;
}

/** Informational note about the knockout produced by a configuration (e.g. byes). */
export function knockoutShapeNote(qualifiers: number): string | null {
  const size = nextPowerOfTwo(qualifiers);
  if (size === qualifiers) return null;
  return `${qualifiers} qualifiers → bracket of ${size}; the top ${size - qualifiers} seeds receive a first-round bye.`;
}

/**
 * Distributes participants into groups.
 * Manually seeded participants are spread first using a snake order (1st seed → A, 2nd → B, …,
 * then back), so top seeds land in different groups. Unseeded participants are shuffled with the
 * draw seed and fill the remaining places in the same snake order. Same inputs → same draw.
 */
export function drawGroups(participants: readonly Participant[], groupCount: number, drawSeed: number): GroupDraw {
  const seeded = participants.filter((p) => p.seed !== null).sort((a, b) => (a.seed as number) - (b.seed as number) || a.id.localeCompare(b.id));
  const unseeded = participants.filter((p) => p.seed === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const order = [...seeded.map((p) => p.id), ...seededShuffle(unseeded.map((p) => p.id), drawSeed)];
  const groups: GroupDraw = Array.from({ length: groupCount }, () => []);
  order.forEach((id, i) => {
    const pass = Math.floor(i / groupCount);
    const pos = i % groupCount;
    const g = pass % 2 === 0 ? pos : groupCount - 1 - pos;
    groups[g].push(id);
  });
  return groups;
}

export interface BuiltGroupStage {
  groups: Group[];
  members: GroupMember[];
  matches: Match[];
}

/** Turns a confirmed draw into persisted groups, memberships and round-robin fixtures. */
export function buildGroupStage(
  draw: GroupDraw,
  opts: { tournamentId: string; doubleRoundRobin: boolean; ids: IdFactory; now: string; stations: number },
): BuiltGroupStage {
  const all = draw.flat();
  if (new Set(all).size !== all.length) throw new EngineError('DUPLICATE', 'A participant is assigned to more than one group');
  if (draw.some((g) => g.length < 2)) throw new EngineError('INVALID_CONFIG', 'Every group needs at least 2 participants');
  const groups: Group[] = [];
  const members: GroupMember[] = [];
  const matches: Match[] = [];
  draw.forEach((ids, index) => {
    const group: Group = { id: opts.ids(), tournamentId: opts.tournamentId, name: `Group ${groupLetter(index)}`, index };
    groups.push(group);
    ids.forEach((participantId, position) => members.push({ groupId: group.id, participantId, tournamentId: opts.tournamentId, position }));
    const slots = new Map<number, number>();
    for (const p of roundRobin(ids, opts.doubleRoundRobin)) {
      const slot = slots.get(p.round) ?? 0;
      slots.set(p.round, slot + 1);
      matches.push({
        id: opts.ids(), tournamentId: opts.tournamentId, stage: 'group', groupId: group.id, round: p.round, slot,
        isThirdPlace: false, homeId: p.home, awayId: p.away, homeScore: null, awayScore: null, homePens: null, awayPens: null,
        winnerId: null, walkover: false, status: 'scheduled', scheduledAt: null, station: null,
        nextMatchId: null, nextSlot: null, loserNextMatchId: null, loserNextSlot: null, updatedAt: opts.now,
      });
    }
  });
  assignStations(matches, opts.stations);
  return { groups, members, matches };
}

/**
 * Suggests console stations: matches of the same matchday are spread round-robin across stations.
 * Organizers can override any station afterwards.
 */
export function assignStations(matches: Match[], stations: number): void {
  if (stations < 1) return;
  const byRound = new Map<number, Match[]>();
  for (const m of matches) byRound.set(m.round, [...(byRound.get(m.round) ?? []), m]);
  for (const list of byRound.values()) {
    list.forEach((m, i) => { m.station = `Station ${(i % stations) + 1}`; });
  }
}
