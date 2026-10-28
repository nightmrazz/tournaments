import type { Match, Tournament, TournamentBundle, TournamentStatus } from '@/types/domain';
import { roundName } from './knockout';
import { computeGroupStandings, fallbackInfo, type GroupStandings } from './standings';

/** Allowed manual status transitions. Draw/bracket generation moves to in_progress on its own. */
const TRANSITIONS: Record<TournamentStatus, TournamentStatus[]> = {
  draft: ['registration_open', 'registration_closed', 'cancelled'],
  registration_open: ['registration_closed', 'draft', 'cancelled'],
  registration_closed: ['registration_open', 'cancelled'],
  in_progress: ['completed', 'cancelled'],
  completed: ['in_progress'],
  cancelled: [],
};

export function allowedTransitions(status: TournamentStatus): TournamentStatus[] {
  return TRANSITIONS[status];
}

export const STATUS_LABEL: Record<TournamentStatus, string> = {
  draft: 'Draft',
  registration_open: 'Registration open',
  registration_closed: 'Registration closed',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const FORMAT_LABEL = {
  groups_knockout: 'Groups + Knockout',
  single_elimination: 'Single elimination',
} as const;

export interface RegistrationState {
  open: boolean;
  reason: string | null;
}

/** Whether new registrations are accepted right now, and why not. */
export function registrationState(t: Tournament, participantCount: number, now = new Date()): RegistrationState {
  if (t.status === 'cancelled') return { open: false, reason: 'This tournament has been cancelled.' };
  if (t.status !== 'registration_open') return { open: false, reason: 'Registration is currently closed.' };
  if (t.registrationDeadline && new Date(t.registrationDeadline) < now)
    return { open: false, reason: 'The registration deadline has passed.' };
  if (participantCount >= t.maxParticipants) return { open: false, reason: 'This tournament is full.' };
  return { open: true, reason: null };
}

export const groupMatches = (b: TournamentBundle) => b.matches.filter((m) => m.stage === 'group');
export const knockoutMatches = (b: TournamentBundle) => b.matches.filter((m) => m.stage === 'knockout');

export interface GroupTable {
  groupId: string;
  name: string;
  standings: GroupStandings;
}

export function groupTables(b: TournamentBundle): GroupTable[] {
  const info = fallbackInfo(b.participants);
  return [...b.groups]
    .sort((a, c) => a.index - c.index)
    .map((g) => {
      const memberIds = b.groupMembers.filter((m) => m.groupId === g.id).sort((x, y) => x.position - y.position).map((m) => m.participantId);
      const matches = b.matches.filter((m) => m.groupId === g.id);
      return { groupId: g.id, name: g.name, standings: computeGroupStandings(memberIds, matches, b.tournament.settings, info) };
    });
}

export function groupStageComplete(b: TournamentBundle): boolean {
  const tables = groupTables(b);
  return tables.length > 0 && tables.every((t) => t.standings.complete);
}

export interface KnockoutRound {
  round: number;
  name: string;
  matches: Match[];
}

/** Knockout matches grouped by round, the third-place match listed after the final. */
export function knockoutRounds(b: TournamentBundle): KnockoutRound[] {
  const ko = knockoutMatches(b);
  if (!ko.length) return [];
  const maxRound = Math.max(...ko.map((m) => m.round));
  const rounds: KnockoutRound[] = [];
  for (let r = 1; r <= maxRound; r++) {
    const matches = ko.filter((m) => m.round === r && !m.isThirdPlace).sort((a, c) => a.slot - c.slot);
    // Count slots by bracket size (byes remove round-1 matches, but the round keeps its name).
    const slotsInRound = 2 ** (maxRound - r);
    if (matches.length) rounds.push({ round: r, name: roundName(slotsInRound), matches });
  }
  const third = ko.find((m) => m.isThirdPlace);
  if (third) rounds.push({ round: third.round, name: roundName(1, true), matches: [third] });
  return rounds;
}

export function finalMatch(b: TournamentBundle): Match | null {
  const ko = knockoutMatches(b).filter((m) => !m.isThirdPlace);
  if (!ko.length) return null;
  const maxRound = Math.max(...ko.map((m) => m.round));
  return ko.find((m) => m.round === maxRound) ?? null;
}

export interface Podium {
  champion: string | null;
  runnerUp: string | null;
  third: string | null;
}

export function podium(b: TournamentBundle): Podium {
  const final = finalMatch(b);
  const champion = final?.status === 'completed' ? final.winnerId : null;
  const runnerUp = champion && final ? (final.homeId === champion ? final.awayId : final.homeId) : null;
  const tp = knockoutMatches(b).find((m) => m.isThirdPlace);
  const third = tp?.status === 'completed' ? tp.winnerId : null;
  return { champion, runnerUp, third };
}

export function knockoutComplete(b: TournamentBundle): boolean {
  const ko = knockoutMatches(b);
  return ko.length > 0 && ko.every((m) => m.status === 'completed');
}

export type StageKey = 'registration' | 'draw' | 'groups' | 'knockout' | 'complete';
export interface StageStep {
  key: string;
  label: string;
  state: 'done' | 'current' | 'upcoming';
  detail?: string;
}

/** Progress tracker shown on the overview: each stage is unlocked only when the previous one is finished. */
export function stageProgress(b: TournamentBundle): StageStep[] {
  const t = b.tournament;
  const steps: Omit<StageStep, 'state'>[] = [{ key: 'registration', label: 'Registration', detail: `${b.participants.length}/${t.maxParticipants}` }];
  const done: boolean[] = [t.status !== 'draft' && t.status !== 'registration_open'];
  if (t.format === 'groups_knockout') {
    const gm = groupMatches(b);
    steps.push({ key: 'draw', label: 'Group draw' });
    done.push(b.groups.length > 0);
    steps.push({ key: 'groups', label: 'Group stage', detail: gm.length ? `${gm.filter((m) => m.status === 'completed').length}/${gm.filter((m) => m.status !== 'cancelled').length}` : undefined });
    done.push(groupStageComplete(b));
  }
  const rounds = knockoutRounds(b);
  if (rounds.length) {
    for (const r of rounds) {
      steps.push({ key: `ko-${r.name}`, label: r.name });
      done.push(r.matches.every((m) => m.status === 'completed'));
    }
  } else {
    steps.push({ key: 'knockout', label: 'Knockout' });
    done.push(false);
  }
  steps.push({ key: 'complete', label: 'Champion' });
  done.push(t.status === 'completed' || podium(b).champion !== null);
  const firstOpen = done.findIndex((d) => !d);
  return steps.map((s, i) => ({ ...s, state: done[i] ? 'done' : i === firstOpen ? 'current' : 'upcoming' }));
}
