import type { Participant, RegistrationStatus, Tournament, TournamentFormat, TournamentSettings } from '@/types/domain';
import { EngineError } from './errors';
import { groupConfigProblems, knockoutShapeNote } from './groups';
import { countCapacity, holdsSlot, isConfirmed, registrationState } from './lifecycle';

export interface RegistrationInput {
  displayName: string;
  contact?: string | null;
}

/** Status a registration change resolves to, plus the payment reservation it carries. */
export interface RegistrationOutcome {
  status: RegistrationStatus;
  reservedUntil: string | null;
}

export const normalizeName = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const reservation = (t: Tournament, now: Date) =>
  new Date(now.getTime() + Math.max(1, t.settings.reservationMinutes || 30) * 60_000).toISOString();

/**
 * Decides what a new registration becomes. Mirrored by the `register_for_tournament` SQL function,
 * which runs under a row lock so two players cannot take the same last place.
 *  - free place, entry fee  → awaiting_payment, place reserved for reservationMinutes
 *  - free place, no fee     → confirmed
 *  - no free place          → waitlisted (if the waitlist is on), otherwise "full"
 * `asOrganizer` adds a player directly (paid offline): confirmed, needs a free place, ignores the window.
 */
export function planRegistration(
  t: Tournament,
  existing: readonly Participant[],
  input: RegistrationInput,
  opts: { userId: string | null; asOrganizer: boolean; now?: Date },
): RegistrationOutcome {
  const now = opts.now ?? new Date();
  const { holding } = countCapacity(existing, now);
  let waitlist = false;
  if (opts.asOrganizer) {
    if (t.status === 'cancelled' || t.status === 'completed') throw new EngineError('INVALID_STATE', 'Participants cannot be added to a finished tournament.');
    if (t.status === 'in_progress') throw new EngineError('INVALID_STATE', 'Participants cannot be added after fixtures have been generated.');
  } else {
    const state = registrationState(t, holding, now);
    if (!state.open) throw new EngineError('INVALID_STATE', state.reason ?? 'Registration is currently closed.');
    waitlist = state.waitlistOnly;
    if (opts.userId && existing.some((p) => p.userId === opts.userId))
      throw new EngineError('DUPLICATE', 'You are already registered for this tournament.');
  }
  if (existing.some((p) => normalizeName(p.displayName) === normalizeName(input.displayName)))
    throw new EngineError('DUPLICATE', 'This name is already registered.');
  if (t.settings.requireContact && !opts.asOrganizer && !input.contact?.trim())
    throw new EngineError('INVALID_STATE', 'The organizer requires contact information.');
  if (opts.asOrganizer) {
    if (holding >= t.maxParticipants) throw new EngineError('INVALID_STATE', 'This tournament is full.');
    return { status: 'confirmed', reservedUntil: null };
  }
  if (waitlist) return { status: 'waitlisted', reservedUntil: null };
  return t.settings.requirePayment
    ? { status: 'awaiting_payment', reservedUntil: reservation(t, now) }
    : { status: 'confirmed', reservedUntil: null };
}

/** @deprecated kept for callers that only validate; use planRegistration. */
export function assertCanRegister(t: Tournament, existing: readonly Participant[], input: RegistrationInput, opts: { userId: string | null; asOrganizer: boolean; now?: Date }): void {
  planRegistration(t, existing, input, opts);
}

/** Players who pay an entry fee start as applications; organizer-added players and free events are confirmed at once. */
export function initialRegistrationStatus(t: Tournament, asOrganizer: boolean): RegistrationStatus {
  return asOrganizer || !t.settings.requirePayment ? 'confirmed' : 'awaiting_payment';
}

const closedOrDrawn = (t: Tournament, hasFixtures: boolean) => {
  if (t.status === 'completed' || t.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This tournament is closed.');
  if (hasFixtures) throw new EngineError('INVALID_STATE', 'Registration status cannot change after the draw.');
};

/** Free places right now, not counting `except` (a registration that is being moved). */
function freePlaces(t: Tournament, all: readonly Participant[], except: Participant, now: Date) {
  return t.maxParticipants - all.filter((p) => p.id !== except.id && holdsSlot(p, now)).length;
}

/**
 * The player reports that the receipt was sent (allowed while awaiting payment or after a rejection).
 * A live reservation keeps its place; an expired one gets a place only if one is free, otherwise the
 * application joins the waitlist (or is refused when there is no waitlist). Never confirms.
 */
export function planReceiptSent(t: Tournament, all: readonly Participant[], p: Participant, hasFixtures: boolean, now = new Date()): RegistrationOutcome {
  closedOrDrawn(t, hasFixtures);
  if (p.status !== 'awaiting_payment' && p.status !== 'rejected')
    throw new EngineError('INVALID_STATE', 'This application is already being reviewed or is confirmed.');
  if (holdsSlot(p, now) || freePlaces(t, all, p, now) > 0) return { status: 'awaiting_review', reservedUntil: null };
  if (t.settings.waitlistEnabled) return { status: 'waitlisted', reservedUntil: null };
  throw new EngineError('INVALID_STATE', 'No places are left in this tournament.');
}

/** @deprecated use planReceiptSent */
export function assertCanMarkReceiptSent(participant: Participant): void {
  if (participant.status !== 'awaiting_payment' && participant.status !== 'rejected')
    throw new EngineError('INVALID_STATE', 'This application is already being reviewed or is confirmed.');
}

/** Organizer actions on a registration. */
export type AdminRegistrationAction =
  | 'confirm' // payment verified / registration approved
  | 'reject' // payment or registration rejected
  | 'waitlist' // move to the waitlist
  | 'offer' // give a free place to a waitlisted / rejected / cancelled player (payment still required)
  | 'cancel'; // cancel the registration

/**
 * Organizer transitions. Confirming or offering needs a free place (a registration that already
 * holds one keeps it). Offering never confirms a paid registration: it starts a new payment
 * reservation, so the usual receipt check still applies. Only before the draw.
 */
export function planAdminAction(t: Tournament, all: readonly Participant[], p: Participant, action: AdminRegistrationAction, hasFixtures: boolean, now = new Date()): RegistrationOutcome {
  closedOrDrawn(t, hasFixtures);
  const free = holdsSlot(p, now) || freePlaces(t, all, p, now) > 0;
  switch (action) {
    case 'confirm':
      if (!free) throw new EngineError('INVALID_STATE', 'This tournament is full.');
      return { status: 'confirmed', reservedUntil: null };
    case 'offer':
      if (p.status === 'confirmed' || p.status === 'awaiting_review') throw new EngineError('INVALID_STATE', 'This registration already holds a place.');
      if (!free) throw new EngineError('INVALID_STATE', 'This tournament is full.');
      return t.settings.requirePayment ? { status: 'awaiting_payment', reservedUntil: reservation(t, now) } : { status: 'confirmed', reservedUntil: null };
    case 'waitlist':
      return { status: 'waitlisted', reservedUntil: null };
    case 'reject':
      return { status: 'rejected', reservedUntil: null };
    case 'cancel':
      return { status: 'cancelled', reservedUntil: null };
  }
}

/** Backwards-compatible wrapper used by older callers: confirm / reject / any status. */
export function assertCanSetRegistrationStatus(t: Tournament, existing: readonly Participant[], participant: Participant, to: RegistrationStatus, hasFixtures: boolean): void {
  const action: AdminRegistrationAction = to === 'confirmed' ? 'confirm' : to === 'rejected' ? 'reject' : to === 'waitlisted' ? 'waitlist' : to === 'cancelled' ? 'cancel' : 'offer';
  planAdminAction(t, existing, participant, action, hasFixtures);
}

/** A player withdraws their own registration (before the draw). */
export function assertCanCancelOwn(t: Tournament, p: Participant, hasFixtures: boolean): void {
  closedOrDrawn(t, hasFixtures);
  if (p.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This registration is already cancelled.');
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

/* ------------------------------------------------------------ roster */

export interface FormatOption {
  format: TournamentFormat;
  groupCount: number;
  advancePerGroup: number;
  /** Short description, e.g. "4 groups of 4 → quarter-finals". */
  label: string;
}

export interface RosterReport {
  confirmed: number;
  min: number;
  target: number;
  max: number;
  /** Problems that make the configured format impossible — the draw is refused. */
  blocking: string[];
  /** Things the organizer should know before confirming the draw. */
  warnings: string[];
  /** Formats that work with exactly `confirmed` players, best first. */
  suggestions: FormatOption[];
}

const POW2 = new Set([2, 4, 8, 16, 32, 64]);

/** Group-stage configurations that fit `n` players: 3–6 per group, qualifiers a power of two. */
export function suggestFormats(n: number): FormatOption[] {
  const out: (FormatOption & { score: number })[] = [];
  for (let g = 1; g <= 16; g++) {
    const small = Math.floor(n / g);
    if (small < 3 || Math.ceil(n / g) > 6) continue;
    for (let a = 1; a <= Math.min(4, small - 1); a++) {
      const q = g * a;
      if (!POW2.has(q) || q < 2 || groupConfigProblems(n, { groupCount: g, advancePerGroup: a }).length) continue;
      const even = n % g === 0;
      const score = (even ? 0 : 2) + Math.abs(small - 4) + (a === 2 ? 0 : 1);
      out.push({ format: 'groups_knockout', groupCount: g, advancePerGroup: a, score, label: `${g}×${even ? small : `${small}–${small + 1}`} → ${q}` });
    }
  }
  out.sort((x, y) => x.score - y.score);
  const result: FormatOption[] = out.slice(0, 4).map(({ score: _s, ...o }) => o);
  if (n >= 2) result.push({ format: 'single_elimination', groupCount: 0, advancePerGroup: 0, label: knockoutShapeNote(n) ?? `knockout of ${n}` });
  return result;
}

/** Checks before the draw: participant count vs min/target/max and whether the chosen format fits. */
export function rosterReport(t: Tournament, participants: readonly Participant[], now = new Date()): RosterReport {
  const s: TournamentSettings = t.settings;
  const counts = countCapacity(participants, now);
  const n = participants.filter(isConfirmed).length;
  const blocking: string[] = [];
  const warnings: string[] = [];
  if (t.format === 'groups_knockout') blocking.push(...groupConfigProblems(n, s));
  else if (n < 2) blocking.push('At least 2 participants are needed.');
  if (s.minParticipants && n < s.minParticipants) warnings.push(`Only ${n} confirmed participants — below the minimum of ${s.minParticipants}.`);
  if (s.targetParticipants && n < s.targetParticipants && n >= (s.minParticipants || 0)) warnings.push(`${n} confirmed participants — below the target of ${s.targetParticipants}.`);
  const review = participants.filter((p) => p.status === 'awaiting_review').length;
  const unpaid = participants.filter((p) => p.status === 'awaiting_payment' && holdsSlot(p, now)).length;
  if (review) warnings.push(`${review} receipts are still waiting for your check — they will not be in the draw.`);
  if (unpaid) warnings.push(`${unpaid} players reserved a place but have not paid — they will not be in the draw.`);
  if (counts.waitlisted) warnings.push(`${counts.waitlisted} players are on the waitlist.`);
  if (t.status === 'registration_open') warnings.push('Registration is still open. Close it before the draw.');
  return { confirmed: n, min: s.minParticipants, target: s.targetParticipants, max: t.maxParticipants, blocking, warnings, suggestions: suggestFormats(n) };
}
