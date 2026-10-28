// High-level tournament operations. Each one validates the current bundle and returns a
// Mutation describing exactly what must be written. Backends persist a Mutation atomically,
// so the rules live in one place and are unit-testable without a database.

import type { Group, GroupMember, Match, MatchStatus, Tournament, TournamentBundle, TournamentStatus } from '@/types/domain';
import { EngineError } from './errors';
import { buildGroupStage, drawGroups, groupConfigProblems, type GroupDraw } from './groups';
import type { IdFactory } from './ids';
import { buildKnockout, entryPlacements, samePlacements, seedsForSingleElimination, seedsFromGroups } from './knockout';
import { allowedTransitions, groupMatches, groupStageComplete, groupTables, knockoutMatches, podium, STATUS_LABEL } from './lifecycle';
import { BracketEditor, clearedResultPatch, hasResult, normalizeResult, type ResultInput } from './results';

export interface Mutation {
  insertGroups: Group[];
  insertMembers: GroupMember[];
  insertMatches: Match[];
  updateMatches: Match[];
  deleteMatchIds: string[];
  /** Deleting a group also deletes its memberships. */
  deleteGroupIds: string[];
  tournamentStatus: TournamentStatus | null;
}

export const emptyMutation = (): Mutation => ({
  insertGroups: [], insertMembers: [], insertMatches: [], updateMatches: [], deleteMatchIds: [], deleteGroupIds: [], tournamentStatus: null,
});

export interface CommandContext {
  ids: IdFactory;
  now: string;
}

export interface CommandResult {
  mutation: Mutation;
  /** Non-blocking notes for the organizer (e.g. a tie decided by fallback, downstream results cleared). */
  warnings: string[];
}

function requireEditable(t: Tournament) {
  if (t.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This tournament is cancelled.');
  if (t.status === 'completed') throw new EngineError('INVALID_STATE', 'This tournament is completed. Reopen it to make changes.');
}

/* ------------------------------------------------------------------ status */

export function planStatusChange(b: TournamentBundle, to: TournamentStatus): CommandResult {
  const t = b.tournament;
  if (t.status === to) return { mutation: emptyMutation(), warnings: [] };
  if (!allowedTransitions(t.status).includes(to))
    throw new EngineError('INVALID_STATE', `Cannot change status from "${STATUS_LABEL[t.status]}" to "${STATUS_LABEL[to]}".`);
  if (to === 'completed' && !podium(b).champion)
    throw new EngineError('STAGE_INCOMPLETE', 'The final must be completed before the tournament can be marked completed.');
  if (to === 'completed' && knockoutMatches(b).some((m) => m.status !== 'completed'))
    throw new EngineError('STAGE_INCOMPLETE', 'All knockout matches (including the third-place match) must be completed first.');
  if ((to === 'registration_open' || to === 'draft') && b.matches.length > 0)
    throw new EngineError('INVALID_STATE', 'Fixtures already exist. Reset them before reopening registration.');
  return { mutation: { ...emptyMutation(), tournamentStatus: to }, warnings: [] };
}

/* ------------------------------------------------------------- generation */

function requireReadyToStart(b: TournamentBundle) {
  requireEditable(b.tournament);
  if (b.tournament.status !== 'registration_closed')
    throw new EngineError('INVALID_STATE', 'Close registration before generating fixtures.');
  if (b.matches.length || b.groups.length) throw new EngineError('INVALID_STATE', 'Fixtures have already been generated.');
}

/** Produces a reviewable draw. Nothing is persisted until planGroupStage is called with it. */
export function previewDraw(b: TournamentBundle, drawSeed: number): GroupDraw {
  const problems = groupConfigProblems(b.participants.length, b.tournament.settings);
  if (problems.length) throw new EngineError('INVALID_CONFIG', problems.join(' '));
  return drawGroups(b.participants, b.tournament.settings.groupCount, drawSeed);
}

export function planGroupStage(b: TournamentBundle, draw: GroupDraw, ctx: CommandContext): CommandResult {
  if (b.tournament.format !== 'groups_knockout') throw new EngineError('INVALID_CONFIG', 'This tournament does not have a group stage.');
  requireReadyToStart(b);
  const problems = groupConfigProblems(b.participants.length, b.tournament.settings);
  if (problems.length) throw new EngineError('INVALID_CONFIG', problems.join(' '));
  if (draw.length !== b.tournament.settings.groupCount) throw new EngineError('INVALID_CONFIG', 'The draw does not match the configured number of groups.');
  const drawn = draw.flat();
  const ids = new Set(b.participants.map((p) => p.id));
  if (drawn.length !== ids.size || drawn.some((id) => !ids.has(id)))
    throw new EngineError('INVALID_STATE', 'The participant list changed since the draw was made. Draw again.');
  const s = b.tournament.settings;
  const built = buildGroupStage(draw, { tournamentId: b.tournament.id, doubleRoundRobin: s.doubleRoundRobin, ids: ctx.ids, now: ctx.now, stations: s.stations });
  return {
    mutation: { ...emptyMutation(), insertGroups: built.groups, insertMembers: built.members, insertMatches: built.matches, tournamentStatus: 'in_progress' },
    warnings: [],
  };
}

export function planSingleElimination(b: TournamentBundle, drawSeed: number, ctx: CommandContext): CommandResult {
  if (b.tournament.format !== 'single_elimination') throw new EngineError('INVALID_CONFIG', 'This tournament uses a group stage.');
  requireReadyToStart(b);
  if (b.participants.length < 2) throw new EngineError('INVALID_CONFIG', 'At least 2 participants are needed.');
  const seeds = seedsForSingleElimination(b.participants, drawSeed);
  const matches = buildKnockout(seeds, { tournamentId: b.tournament.id, thirdPlace: b.tournament.settings.thirdPlaceMatch, ids: ctx.ids, now: ctx.now });
  return { mutation: { ...emptyMutation(), insertMatches: matches, tournamentStatus: 'in_progress' }, warnings: [] };
}

/** Qualifier seed list from the current group tables, with warnings for fallback-decided cut-offs. */
export function knockoutSeedsFromGroups(b: TournamentBundle): { seeds: string[]; warnings: string[] } {
  const tables = groupTables(b);
  const k = b.tournament.settings.advancePerGroup;
  const warnings: string[] = [];
  for (const t of tables) {
    const rows = t.standings.rows;
    // A fallback decision matters if it separates a qualifier from a non-qualifier, or decides seeding positions.
    if (rows.some((r) => r.decidedByFallback && r.rank <= k + 1)) {
      warnings.push(`${t.name}: some positions are tied on every criterion and were ordered by seed/registration order.`);
    }
  }
  return { seeds: seedsFromGroups(tables.map((t) => t.standings.rows.map((r) => r.participantId)), k), warnings };
}

export function planKnockoutFromGroups(b: TournamentBundle, ctx: CommandContext): CommandResult {
  requireEditable(b.tournament);
  if (b.tournament.format !== 'groups_knockout') throw new EngineError('INVALID_CONFIG', 'This tournament does not have a group stage.');
  if (!b.groups.length) throw new EngineError('STAGE_INCOMPLETE', 'Generate the group stage first.');
  if (knockoutMatches(b).length) throw new EngineError('INVALID_STATE', 'The knockout bracket already exists.');
  if (!groupStageComplete(b)) throw new EngineError('STAGE_INCOMPLETE', 'All group matches must be completed (or cancelled) before the knockout stage can start.');
  const { seeds, warnings } = knockoutSeedsFromGroups(b);
  const matches = buildKnockout(seeds, { tournamentId: b.tournament.id, thirdPlace: b.tournament.settings.thirdPlaceMatch, ids: ctx.ids, now: ctx.now });
  return { mutation: { ...emptyMutation(), insertMatches: matches }, warnings };
}

/** Deletes the knockout bracket. For a straight knockout this returns the tournament to "registration closed". */
export function planResetKnockout(b: TournamentBundle): CommandResult {
  requireEditable(b.tournament);
  const ko = knockoutMatches(b);
  if (!ko.length) throw new EngineError('INVALID_STATE', 'There is no knockout bracket to reset.');
  return {
    mutation: {
      ...emptyMutation(),
      deleteMatchIds: ko.map((m) => m.id),
      tournamentStatus: b.tournament.format === 'single_elimination' ? 'registration_closed' : null,
    },
    warnings: [],
  };
}

/** Deletes groups and all fixtures. Refused once any result exists, to protect recorded data. */
export function planResetGroupStage(b: TournamentBundle): CommandResult {
  requireEditable(b.tournament);
  if (!b.groups.length) throw new EngineError('INVALID_STATE', 'There is no group stage to reset.');
  if (b.matches.some((m) => hasResult(m) || m.status === 'completed'))
    throw new EngineError('INVALID_STATE', 'Results have already been recorded. Clear them before redrawing the groups.');
  return {
    mutation: { ...emptyMutation(), deleteMatchIds: b.matches.map((m) => m.id), deleteGroupIds: b.groups.map((g) => g.id), tournamentStatus: 'registration_closed' },
    warnings: [],
  };
}

/* ---------------------------------------------------------------- matches */

export type MatchChange =
  | { type: 'result'; input: ResultInput }
  | { type: 'clear' }
  | { type: 'meta'; scheduledAt?: string | null; station?: string | null; status?: Exclude<MatchStatus, 'completed'> };

export interface MatchChangeOptions {
  /** Confirmed by the organizer: delete a knockout bracket that no longer matches the group tables. */
  resetKnockoutIfInvalid?: boolean;
}

export function planMatchChange(b: TournamentBundle, matchId: string, change: MatchChange, ctx: CommandContext, opts: MatchChangeOptions = {}): CommandResult {
  const t = b.tournament;
  requireEditable(t);
  if (t.status !== 'in_progress') throw new EngineError('INVALID_STATE', 'Matches can only be updated while the tournament is in progress.');
  const match = b.matches.find((m) => m.id === matchId);
  if (!match) throw new EngineError('NOT_FOUND', 'Match not found.');

  let patch: Partial<Match>;
  if (change.type === 'result') {
    patch = normalizeResult(match, change.input, t.settings);
  } else if (change.type === 'clear') {
    patch = clearedResultPatch();
  } else {
    patch = {};
    if (change.scheduledAt !== undefined) patch.scheduledAt = change.scheduledAt;
    if (change.station !== undefined) patch.station = change.station?.trim() ? change.station.trim().slice(0, 40) : null;
    if (change.status !== undefined && change.status !== match.status) {
      if (match.status === 'completed') throw new EngineError('INVALID_STATE', 'Clear the result before changing the status of a completed match.');
      if (change.status === 'cancelled' && match.stage === 'knockout')
        throw new EngineError('INVALID_STATE', 'Knockout matches cannot be cancelled — record a walkover instead.');
      patch.status = change.status;
      if (change.status === 'scheduled' || change.status === 'postponed' || change.status === 'cancelled') {
        Object.assign(patch, { homeScore: null, awayScore: null, homePens: null, awayPens: null, winnerId: null, walkover: false });
      }
    }
  }

  const warnings: string[] = [];
  const mutation = emptyMutation();

  if (match.stage === 'knockout') {
    const editor = new BracketEditor(b.matches, ctx.now);
    editor.update(match.id, patch);
    mutation.updateMatches = [...editor.changed.values()];
    const cleared = editor.invalidated.filter((id) => id !== match.id);
    if (cleared.length) warnings.push(`${cleared.length} later match result(s) were cleared because the participants changed.`);
    return { mutation, warnings };
  }

  // Group match: if a knockout already exists, make sure it still reflects the group tables.
  const updated: Match = { ...match, ...patch, updatedAt: ctx.now };
  mutation.updateMatches = [updated];
  const ko = knockoutMatches(b);
  if (ko.length) {
    const after: TournamentBundle = { ...b, matches: b.matches.map((m) => (m.id === match.id ? updated : m)) };
    let stillValid = groupStageComplete(after);
    if (stillValid) {
      const { seeds } = knockoutSeedsFromGroups(after);
      const rebuilt = buildKnockout(seeds, { tournamentId: t.id, thirdPlace: t.settings.thirdPlaceMatch, ids: ctx.ids, now: ctx.now });
      // Compare by structure (round/slot/side) because the rebuilt bracket has fresh ids.
      stillValid = samePlacements(entryPlacements(ko), entryPlacements(rebuilt));
    }
    if (!stillValid) {
      if (!opts.resetKnockoutIfInvalid) {
        const played = ko.filter((m) => m.status === 'completed').length;
        throw new EngineError(
          'KNOCKOUT_CONFLICT',
          `This change alters which participants qualify or how they are seeded. The knockout bracket (${ko.length} matches, ${played} with results) must be deleted and generated again.`,
        );
      }
      mutation.deleteMatchIds = ko.map((m) => m.id);
      warnings.push('The knockout bracket was deleted. Generate it again once the group stage is final.');
    }
  }
  return { mutation, warnings };
}

export function groupStageSummary(b: TournamentBundle) {
  const gm = groupMatches(b);
  return { total: gm.filter((m) => m.status !== 'cancelled').length, completed: gm.filter((m) => m.status === 'completed').length };
}
