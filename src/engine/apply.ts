import type { TournamentBundle } from '@/types/domain';
import type { Mutation } from './commands';

/** Applies a mutation to an in-memory bundle (used by the local backend and by tests). */
export function applyMutation(b: TournamentBundle, m: Mutation, now: string): TournamentBundle {
  const deletedGroups = new Set(m.deleteGroupIds);
  const deletedMatches = new Set(m.deleteMatchIds);
  const updates = new Map(m.updateMatches.map((x) => [x.id, x]));
  return {
    tournament: m.tournamentStatus
      ? { ...b.tournament, status: m.tournamentStatus, version: b.tournament.version + 1, updatedAt: now }
      : { ...b.tournament, version: b.tournament.version + 1, updatedAt: now },
    participants: b.participants,
    groups: [...b.groups.filter((g) => !deletedGroups.has(g.id)), ...m.insertGroups],
    groupMembers: [...b.groupMembers.filter((gm) => !deletedGroups.has(gm.groupId)), ...m.insertMembers],
    matches: [
      ...b.matches.filter((x) => !deletedMatches.has(x.id)).map((x) => updates.get(x.id) ?? x),
      ...m.insertMatches,
    ],
  };
}
