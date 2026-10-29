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
 * Application lifecycle when the organizer requires an entry fee:
 * awaiting_payment → (player says the receipt was sent) awaiting_review → confirmed | rejected.
 * Without an entry fee, registrations are confirmed immediately.
 */
export const REGISTRATION_STATUSES = ['awaiting_payment', 'awaiting_review', 'confirmed', 'rejected'] as const;
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
};
