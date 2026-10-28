import type { Participant, Tournament } from '@/types/domain';
import { EngineError } from './errors';
import { registrationState } from './lifecycle';

export interface RegistrationInput {
  displayName: string;
  contact?: string | null;
}

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Registration rules shared by the local backend (and mirrored by the
 * `register_for_tournament` SQL function for Supabase):
 * open status, before the deadline, unique display name, one entry per account, then capacity.
 * `asOrganizer` lets the organizer add people while registration is closed (but never beyond capacity).
 */
export function assertCanRegister(
  t: Tournament,
  existing: readonly Participant[],
  input: RegistrationInput,
  opts: { userId: string | null; asOrganizer: boolean; now?: Date },
): void {
  if (opts.asOrganizer) {
    if (t.status === 'cancelled' || t.status === 'completed') throw new EngineError('INVALID_STATE', 'Participants cannot be added to a finished tournament.');
    if (t.status === 'in_progress') throw new EngineError('INVALID_STATE', 'Participants cannot be added after fixtures have been generated.');
  } else {
    const state = registrationState(t, 0, opts.now);
    if (!state.open) throw new EngineError('INVALID_STATE', state.reason ?? 'Registration is currently closed.');
    if (opts.userId && existing.some((p) => p.userId === opts.userId))
      throw new EngineError('DUPLICATE', 'You are already registered for this tournament.');
  }
  if (existing.some((p) => normalizeName(p.displayName) === normalizeName(input.displayName)))
    throw new EngineError('DUPLICATE', 'This name is already registered.');
  if (existing.length >= t.maxParticipants) throw new EngineError('INVALID_STATE', 'This tournament is full.');
  if (t.settings.requireContact && !opts.asOrganizer && !input.contact?.trim())
    throw new EngineError('INVALID_STATE', 'The organizer requires contact information.');
}

export function assertCanRemoveParticipant(t: Tournament, hasFixtures: boolean): void {
  if (t.status === 'completed' || t.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This tournament is closed.');
  if (hasFixtures) throw new EngineError('INVALID_STATE', 'Participants cannot be removed after fixtures have been generated. Reset the fixtures first.');
}

/**
 * Teams (clubs) are assigned by the organizer after the draw (group draw, or bracket for a straight
 * knockout) and can be changed until the tournament is finished.
 */
export function assertCanAssignTeam(t: Tournament, drawDone: boolean): void {
  if (t.status === 'completed' || t.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This tournament is closed.');
  if (!drawDone) throw new EngineError('INVALID_STATE', 'Teams are assigned after the draw.');
}
