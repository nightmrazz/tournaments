import type { Mutation, RegistrationInput } from '@/engine';
import type { Participant, ParticipantContact, RegistrationStatus, Tournament, TournamentBundle, TournamentFormat, TournamentSettings, TournamentStatus, UserIdentity } from '@/types/domain';

export interface TournamentSummary extends Tournament {
  participantCount: number;
}

export interface TournamentInput {
  name: string;
  description: string;
  rules: string;
  venue: string;
  startsAt: string | null;
  registrationDeadline: string | null;
  format: TournamentFormat;
  maxParticipants: number;
  settings: TournamentSettings;
}

/** A registration as seen by the player who made it (personal cabinet). */
export interface MyApplication {
  participant: Participant;
  tournament: Pick<Tournament, 'id' | 'name' | 'status' | 'startsAt' | 'settings'>;
}

export interface ParticipantPatch {
  displayName?: string;
  seed?: number | null;
  /** Only allowed once the draw is done; the other fields are frozen then. */
  team?: string | null;
}

/** Error with a message that is safe and useful to show to the user. */
export class AppError extends Error {
  readonly code: string;
  constructor(message: string, code = 'ERROR') {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export interface AuthApi {
  getUser(): Promise<UserIdentity | null>;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string, displayName: string): Promise<{ needsConfirmation: boolean }>;
  signOut(): Promise<void>;
  /** Change the signed-in player's nickname (unique, 3–24 chars). */
  updateNickname(nickname: string): Promise<void>;
  /** Whether a nickname is still free (for the sign-up form). */
  nicknameAvailable(nickname: string): Promise<boolean>;
  onChange(cb: () => void): () => void;
}

/**
 * Persistence boundary. Rules live in the engine; the service only stores data.
 * The Supabase implementation additionally relies on RLS + SQL functions for security.
 */
export interface DataService {
  readonly mode: 'local' | 'supabase';
  readonly auth: AuthApi;
  listTournaments(): Promise<TournamentSummary[]>;
  listManagedTournaments(userId: string): Promise<TournamentSummary[]>;
  getBundle(id: string): Promise<TournamentBundle | null>;
  createTournament(input: TournamentInput): Promise<Tournament>;
  updateTournament(id: string, input: Partial<TournamentInput>): Promise<Tournament>;
  setStatus(id: string, status: TournamentStatus): Promise<void>;
  deleteTournament(id: string): Promise<void>;
  /** Self-registration by the signed-in user (or anonymous in local mode). */
  register(tournamentId: string, input: RegistrationInput): Promise<Participant>;
  /** Organizer adds a participant manually. New participants never have a team; teams are assigned after the draw. */
  addParticipant(tournamentId: string, input: RegistrationInput & { seed?: number | null }): Promise<Participant>;
  updateParticipant(participantId: string, patch: ParticipantPatch): Promise<void>;
  removeParticipant(participantId: string): Promise<void>;
  listContacts(tournamentId: string): Promise<ParticipantContact[]>;
  /** Organizer confirms or rejects a paid application (before the draw). */
  setRegistrationStatus(participantId: string, status: RegistrationStatus): Promise<void>;
  /** Applicant reports that the payment receipt was sent → awaiting_review. */
  markReceiptSent(participantId: string): Promise<void>;
  /** The current player's applications across tournaments (local mode: made in this browser). */
  listMyApplications(): Promise<MyApplication[]>;
  /** Atomically applies an engine mutation if the tournament is still at `expectedVersion`. */
  applyMutation(tournamentId: string, expectedVersion: number, mutation: Mutation): Promise<void>;
}
