import type { Participant, RegistrationStatus, Tournament } from '@/types/domain';
import { EngineError } from './errors';
import { isConfirmed, registrationState } from './lifecycle';

export interface RegistrationInput {
  displayName: string;
  contact?: string | null;
}

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Registration rules shared by the local backend (and mirrored by the
 * `register_for_tournament` SQL function for Supabase):
 * open status, before the deadline, unique display name, one entry per account, then capacity.
 * Capacity counts CONFIRMED participants only — unpaid applications do not hold a place.
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
  if (existing.filter(isConfirmed).length >= t.maxParticipants) throw new EngineError('INVALID_STATE', 'This tournament is full.');
  if (t.settings.requireContact && !opts.asOrganizer && !input.contact?.trim())
    throw new EngineError('INVALID_STATE', 'The organizer requires contact information.');
}

/** Players who pay an entry fee start as applications; organizer-added players and free events are confirmed at once. */
export function initialRegistrationStatus(t: Tournament, asOrganizer: boolean): RegistrationStatus {
  return asOrganizer || !t.settings.requirePayment ? 'confirmed' : 'awaiting_payment';
}

/** Organizer confirms / rejects an application (or puts it back to review). Only before the draw. */
export function assertCanSetRegistrationStatus(
  t: Tournament,
  existing: readonly Participant[],
  participant: Participant,
  to: RegistrationStatus,
  hasFixtures: boolean,
): void {
  if (t.status === 'completed' || t.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This tournament is closed.');
  if (hasFixtures) throw new EngineError('INVALID_STATE', 'Registration status cannot change after the draw.');
  if (to === 'confirmed' && participant.status !== 'confirmed') {
    const confirmed = existing.filter((p) => isConfirmed(p) && p.id !== participant.id).length;
    if (confirmed >= t.maxParticipants) throw new EngineError('INVALID_STATE', 'This tournament is full.');
  }
}

/** A player reports that the receipt was sent: allowed while awaiting payment or after a rejection. */
export function assertCanMarkReceiptSent(participant: Participant): void {
  if (participant.status !== 'awaiting_payment' && participant.status !== 'rejected')
    throw new EngineError('INVALID_STATE', 'This application is already being reviewed or is confirmed.');
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
