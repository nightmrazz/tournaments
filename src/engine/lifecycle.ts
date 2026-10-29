import type { CapacityCounts, Match, Participant, RegistrationStatus, Tournament, TournamentBundle, TournamentStatus } from '@/types/domain';
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
  /** New applications are accepted (possibly only onto the waitlist). */
  open: boolean;
  reason: string | null;
  /** All places are taken: new applicants go to the waitlist. */
  waitlistOnly: boolean;
  /** Past the deadline but late registration is allowed. */
  late: boolean;
}

/**
 * Whether new registrations are accepted right now, and why not.
 * `holding` = places currently taken (confirmed + receipts under review + live payment reservations).
 */
export function registrationState(t: Tournament, holding: number, now = new Date()): RegistrationState {
  const closed = (reason: string): RegistrationState => ({ open: false, reason, waitlistOnly: false, late: false });
  const s = t.settings;
  if (t.status === 'cancelled') return closed('This tournament has been cancelled.');
  if (t.status !== 'registration_open') return closed('Registration is currently closed.');
  if (s.registrationPaused) return closed('Registration is paused by the organizer.');
  if (s.registrationOpensAt && new Date(s.registrationOpensAt) > now) return closed('Registration has not opened yet.');
  const late = !!t.registrationDeadline && new Date(t.registrationDeadline) < now;
  if (late && !s.allowLateRegistration) return closed('The registration deadline has passed.');
  if (holding >= t.maxParticipants) {
    return s.waitlistEnabled ? { open: true, reason: null, waitlistOnly: true, late } : closed('This tournament is full.');
  }
  return { open: true, reason: null, waitlistOnly: false, late };
}

/** True when this registration currently occupies one of the tournament's places. */
export function holdsSlot(p: Pick<Participant, 'status' | 'reservedUntil'>, now = new Date()): boolean {
  if (p.status === 'confirmed' || p.status === 'awaiting_review') return true;
  return p.status === 'awaiting_payment' && !!p.reservedUntil && new Date(p.reservedUntil) > now;
}

/** An unpaid application whose reservation ran out (it no longer holds a place). */
export const reservationExpired = (p: Pick<Participant, 'status' | 'reservedUntil'>, now = new Date()) =>
  p.status === 'awaiting_payment' && !holdsSlot(p, now);

export function countCapacity(participants: readonly Participant[], now = new Date()): CapacityCounts {
  return {
    confirmed: participants.filter((p) => p.status === 'confirmed').length,
    holding: participants.filter((p) => holdsSlot(p, now)).length,
    waitlisted: participants.filter((p) => p.status === 'waitlisted').length,
  };
}

/** Place counts: server-provided when present (public viewers cannot see others' applications). */
export function capacityOf(b: Pick<TournamentBundle, 'participants' | 'counts'>, now = new Date()): CapacityCounts {
  return b.counts ?? countCapacity(b.participants, now);
}

/** Waitlisted applications in queue order (who was waitlisted first). */
export function waitlistQueue(participants: readonly Participant[]): Participant[] {
  return participants
    .filter((p) => p.status === 'waitlisted')
    .sort((a, c) => a.statusChangedAt.localeCompare(c.statusChangedAt) || a.createdAt.localeCompare(c.createdAt) || a.id.localeCompare(c.id));
}

/** 1-based waitlist position, or null when the participant is not waitlisted. */
export function waitlistPosition(participants: readonly Participant[], participantId: string): number | null {
  const i = waitlistQueue(participants).findIndex((p) => p.id === participantId);
  return i < 0 ? null : i + 1;
}

/** Only confirmed registrations are tournament participants (draw, capacity, public lists). */
export const isConfirmed = (p: Pick<Participant, 'status'>) => p.status === 'confirmed';
export const confirmedParticipants = (b: Pick<TournamentBundle, 'participants'>) => b.participants.filter(isConfirmed);

/** Short, human-friendly application ID shown to players and quoted with payment receipts. */
export const applicationCode = (participantId: string) => participantId.replace(/-/g, '').slice(0, 8).toUpperCase();

export const REGISTRATION_STATUS_LABEL: Record<RegistrationStatus, string> = {
  awaiting_payment: 'Awaiting payment',
  awaiting_review: 'Awaiting receipt check',
  confirmed: 'Confirmed',
  waitlisted: 'Waitlisted',
  rejected: 'Rejected',
  cancelled: 'Withdrawn',
};

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
  const steps: Omit<StageStep, 'state'>[] = [{ key: 'registration', label: 'Registration', detail: `${confirmedParticipants(b).length}/${t.maxParticipants}` }];
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
