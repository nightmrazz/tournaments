// Domain model shared by the UI, the tournament engine and both data backends.
// Field names are camelCase here; the Supabase adapter maps them to snake_case columns.

export const TOURNAMENT_STATUSES = [
  'draft',
  'registration_open',
  'registration_closed',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];

export const TOURNAMENT_FORMATS = ['groups_knockout', 'single_elimination'] as const;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];

export const MATCH_STATUSES = ['scheduled', 'in_progress', 'completed', 'postponed', 'cancelled'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/**
 * Registration lifecycle (stored in participants.payment_status):
 *   awaiting_payment  ("pending_payment") — submitted; holds a place until reservedUntil
 *   awaiting_review   ("payment_review")  — receipt sent; place held until the organizer decides
 *   confirmed         — payment verified (or free event): a participant
 *   waitlisted        — no free place when applying; ordered by statusChangedAt
 *   rejected          — payment / registration rejected by the organizer
 *   cancelled         — withdrawn by the player or cancelled by the organizer
 * Only the organizer can confirm. Without an entry fee, a free place confirms immediately.
 */
export const REGISTRATION_STATUSES = ['awaiting_payment', 'awaiting_review', 'confirmed', 'waitlisted', 'rejected', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

export type MatchStage = 'group' | 'knockout';
export type Side = 'home' | 'away';

/** Tie-breakers applied (in order) after points. h2h_* are computed inside the tied set only. */
export const TIEBREAKERS = ['h2h_points', 'h2h_goal_diff', 'h2h_goals_for', 'goal_diff', 'goals_for', 'wins'] as const;
export type Tiebreaker = (typeof TIEBREAKERS)[number];

export interface TournamentSettings {
  /** Number of groups (groups_knockout only). */
  groupCount: number;
  /** How many participants advance from each group. */
  advancePerGroup: number;
  pointsWin: number;
  pointsDraw: number;
  pointsLoss: number;
  tiebreakers: Tiebreaker[];
  /** Play each group opponent twice (home and away). */
  doubleRoundRobin: boolean;
  thirdPlaceMatch: boolean;
  /** Goals awarded to the winner of a walkover (loser gets 0). */
  walkoverGoals: number;
  /** Ask registrants for contact info (stored privately). */
  requireContact: boolean;
  /** Number of consoles/stations available (used for station assignment hints). */
  stations: number;
  /** Seed used for random draws, so draws are reproducible. */
  drawSeed: number;
  /** Players must pay an entry fee; the organizer confirms each application manually. */
  requirePayment: boolean;
  /** Free text shown to players, e.g. "7 000 ₸". */
  entryFee: string;
  /** Bank / card details for the transfer (shown after registering). */
  paymentDetails: string;
  /** Organizer's Telegram username (without @) that receives payment receipts. */
  telegramUsername: string;
  /** Capacity planning: the event can run from minParticipants; targetParticipants is the goal. 0 = not set. */
  minParticipants: number;
  targetParticipants: number;
  /** Registration window opens at (ISO); null = as soon as registration is opened. */
  registrationOpensAt: string | null;
  /** Temporarily stop accepting registrations without closing them. */
  registrationPaused: boolean;
  /** When all places are taken, new applicants join a waitlist instead of being turned away. */
  waitlistEnabled: boolean;
  /** Accept registrations after the deadline (until registration is closed). */
  allowLateRegistration: boolean;
  /** How long an unpaid application holds a place before the reservation expires. */
  reservationMinutes: number;
  /** Refund / cancellation policy shown to players. */
  cancellationPolicy: string;
}

/** Public place counts (no personal data). */
export interface CapacityCounts {
  confirmed: number;
  /** Places taken now: confirmed + receipts under review + unexpired payment reservations. */
  holding: number;
  waitlisted: number;
}

export interface Tournament {
  id: string;
  ownerId: string;
  name: string;
  description: string;
  rules: string;
  venue: string;
  startsAt: string | null;
  registrationDeadline: string | null;
  format: TournamentFormat;
  status: TournamentStatus;
  maxParticipants: number;
  settings: TournamentSettings;
  /** Monotonic version used for optimistic concurrency on structural changes. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface Participant {
  id: string;
  tournamentId: string;
  displayName: string;
  /** Legacy in-game id column; registration now fills it with the display name. */
  gamertag: string;
  /** Club/team assigned to this player by the organizer (e.g. "Real Madrid"). */
  team: string | null;
  /** Only `confirmed` entries are participants; the others are applications awaiting payment. */
  status: RegistrationStatus;
  /** For awaiting_payment: the place is reserved until this moment. Null = no active reservation. */
  reservedUntil: string | null;
  /** When the status last changed (waitlist order). */
  statusChangedAt: string;
  /** Optional manual seed (1 = strongest). */
  seed: number | null;
  userId: string | null;
  createdAt: string;
}

export interface ParticipantContact {
  participantId: string;
  contact: string;
}

export interface Group {
  id: string;
  tournamentId: string;
  name: string;
  index: number;
}

export interface GroupMember {
  groupId: string;
  participantId: string;
  tournamentId: string;
  /** Draw position inside the group (0-based). */
  position: number;
}

export interface Match {
  id: string;
  tournamentId: string;
  stage: MatchStage;
  groupId: string | null;
  /** Group matchday (1-based) or knockout round (1 = first round). */
  round: number;
  /** Position within the round (0-based). Unique per (stage, group, round). */
  slot: number;
  isThirdPlace: boolean;
  homeId: string | null;
  awayId: string | null;
  homeScore: number | null;
  awayScore: number | null;
  homePens: number | null;
  awayPens: number | null;
  winnerId: string | null;
  walkover: boolean;
  status: MatchStatus;
  scheduledAt: string | null;
  station: string | null;
  /** Knockout wiring: where the winner goes. */
  nextMatchId: string | null;
  nextSlot: Side | null;
  /** Knockout wiring: where the loser goes (semi-finals → third-place match). */
  loserNextMatchId: string | null;
  loserNextSlot: Side | null;
  updatedAt: string;
}

/** Everything needed to render or mutate a tournament. Contacts are never part of it. */
export interface TournamentBundle {
  tournament: Tournament;
  participants: Participant[];
  groups: Group[];
  groupMembers: GroupMember[];
  matches: Match[];
  /**
   * Server-computed place counts. Public viewers only see confirmed rows, so they cannot count
   * reservations themselves; when absent, counts are computed from `participants`.
   */
  counts?: CapacityCounts;
}

export interface UserIdentity {
  id: string;
  email: string | null;
  displayName: string;
  role: 'user' | 'organizer' | 'admin';
}

export const DEFAULT_SETTINGS: TournamentSettings = {
  groupCount: 4,
  advancePerGroup: 2,
  pointsWin: 3,
  pointsDraw: 1,
  pointsLoss: 0,
  tiebreakers: ['goal_diff', 'goals_for', 'h2h_points', 'h2h_goal_diff', 'h2h_goals_for', 'wins'],
  doubleRoundRobin: false,
  thirdPlaceMatch: true,
  walkoverGoals: 3,
  requireContact: false,
  stations: 4,
  drawSeed: 1,
  requirePayment: false,
  entryFee: '',
  paymentDetails: '',
  telegramUsername: '',
  minParticipants: 0,
  targetParticipants: 0,
  registrationOpensAt: null,
  registrationPaused: false,
  waitlistEnabled: false,
  allowLateRegistration: false,
  reservationMinutes: 30,
  cancellationPolicy: '',
};
