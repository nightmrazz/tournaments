import { describe, expect, it } from 'vitest';
import {
  applicationCode, applyMutation, assertCanCancelOwn, capacityOf, countCapacity, holdsSlot, planAdminAction, planGroupStage,
  planReceiptSent, planRegistration, previewDraw, registrationState, reservationExpired, rosterReport, suggestFormats, waitlistPosition,
} from '@/engine';
import type { Participant, Tournament, TournamentSettings } from '@/types/domain';
import { ctx, makeBundle, makeParticipants, makeTournament, NOW } from './helpers';

const now = new Date(NOW);
const later = (min: number) => new Date(now.getTime() + min * 60_000).toISOString();
const paid = (over: Partial<Tournament> = {}, s: Partial<TournamentSettings> = {}) =>
  makeTournament({ status: 'registration_open', maxParticipants: 3, ...over }, { requirePayment: true, entryFee: '7 000 ₸', reservationMinutes: 30, ...s });
const reg = (t: Tournament, ps: Participant[], name: string, userId: string | null = null) =>
  planRegistration(t, ps, { displayName: name }, { userId, asOrganizer: false, now });
const players = (statuses: Participant['status'][], reservedUntil: (string | null)[] = []) =>
  makeParticipants(statuses.length).map((p, i) => ({ ...p, status: statuses[i], reservedUntil: reservedUntil[i] ?? (statuses[i] === 'awaiting_payment' ? later(10) : null) }));

describe('1–2. registration with and without free places', () => {
  it('reserves a place for the payment window when places are free', () => {
    const o = reg(paid(), players(['confirmed']), 'New');
    expect(o.status).toBe('awaiting_payment');
    expect(o.reservedUntil).toBe(later(30));
  });

  it('confirms at once in a free tournament', () => {
    expect(reg(paid({}, { requirePayment: false }), [], 'Free').status).toBe('confirmed');
  });

  it('refuses when full without a waitlist, and waitlists when it is enabled', () => {
    const full = players(['confirmed', 'awaiting_review', 'awaiting_payment']);
    expect(() => reg(paid(), full, 'Late')).toThrow(/full/);
    expect(reg(paid({}, { waitlistEnabled: true }), full, 'Late')).toEqual({ status: 'waitlisted', reservedUntil: null });
    expect(registrationState(paid({}, { waitlistEnabled: true }), 3, now)).toMatchObject({ open: true, waitlistOnly: true });
  });

  it('prevents duplicate registrations by account and by name', () => {
    const ps = players(['confirmed']).map((p) => ({ ...p, userId: 'u1' }));
    expect(() => reg(paid(), ps, 'Other', 'u1')).toThrow(/already registered/);
    expect(() => reg(paid(), ps, ' player 1 ')).toThrow(/already registered/);
  });

  it('organizer-added players are confirmed but still need a free place', () => {
    const t = paid();
    expect(planRegistration(t, players(['confirmed']), { displayName: 'Cash' }, { userId: null, asOrganizer: true, now }).status).toBe('confirmed');
    expect(() => planRegistration(t, players(['confirmed', 'confirmed', 'confirmed']), { displayName: 'Cash' }, { userId: null, asOrganizer: true, now })).toThrow(/full/);
  });
});

describe('4. expired unpaid reservations release their place', () => {
  it('stops holding the place after the reservation window', () => {
    const [p] = players(['awaiting_payment'], [later(-1)]);
    expect(holdsSlot(p, now)).toBe(false);
    expect(reservationExpired(p, now)).toBe(true);
    const full = players(['confirmed', 'confirmed', 'awaiting_payment'], [null, null, later(-5)]);
    expect(countCapacity(full, now).holding).toBe(2);
    expect(reg(paid(), full, 'Newcomer').status).toBe('awaiting_payment');
  });

  it('a player with an expired reservation still gets a free place when sending the receipt…', () => {
    const ps = players(['confirmed', 'awaiting_payment'], [null, later(-1)]);
    expect(planReceiptSent(paid(), ps, ps[1], false, now).status).toBe('awaiting_review');
  });

  it('…or joins the waitlist when the place was taken meanwhile (never confirmed)', () => {
    const ps = players(['confirmed', 'confirmed', 'confirmed', 'awaiting_payment'], [null, null, null, later(-1)]);
    expect(() => planReceiptSent(paid(), ps, ps[3], false, now)).toThrow(/No places/);
    expect(planReceiptSent(paid({}, { waitlistEnabled: true }), ps, ps[3], false, now).status).toBe('waitlisted');
  });
});

describe('5–7. receipts and payment verification', () => {
  it('5. a sent receipt keeps the place until the organizer decides, however long it takes', () => {
    const ps = players(['awaiting_payment']);
    const o = planReceiptSent(paid(), ps, ps[0], false, now);
    expect(o).toEqual({ status: 'awaiting_review', reservedUntil: null });
    expect(holdsSlot({ ...ps[0], ...o }, new Date('2030-01-01'))).toBe(true);
  });

  it('6. only the organizer confirms, and only with a place available', () => {
    const ps = players(['awaiting_review', 'confirmed', 'confirmed']);
    expect(planAdminAction(paid(), ps, ps[0], 'confirm', false, now).status).toBe('confirmed');
    const waiting = players(['confirmed', 'confirmed', 'confirmed', 'waitlisted']);
    expect(() => planAdminAction(paid(), waiting, waiting[3], 'confirm', false, now)).toThrow(/full/);
    expect(() => planReceiptSent(paid(), ps, { ...ps[0], status: 'awaiting_review' }, false, now)).toThrow(/already being reviewed/);
  });

  it('7. a rejection frees the place and lets the player send the receipt again', () => {
    const ps = players(['awaiting_review', 'confirmed', 'confirmed']);
    const o = planAdminAction(paid(), ps, ps[0], 'reject', false, now);
    expect(o.status).toBe('rejected');
    const after = ps.map((p, i) => (i === 0 ? { ...p, ...o } : p));
    expect(countCapacity(after, now).holding).toBe(2);
    expect(planReceiptSent(paid(), after, after[0], false, now).status).toBe('awaiting_review');
  });
});

describe('8. cancellation and waitlist promotion', () => {
  it('a cancelled place can be offered to the first waitlisted player, who must still pay', () => {
    const t = paid({}, { waitlistEnabled: true });
    let ps = players(['confirmed', 'confirmed', 'confirmed', 'waitlisted', 'waitlisted']);
    ps[3] = { ...ps[3], statusChangedAt: '2026-10-02T00:00:00.000Z' };
    ps[4] = { ...ps[4], statusChangedAt: '2026-10-01T00:00:00.000Z' };
    expect(waitlistPosition(ps, ps[4].id)).toBe(1);
    expect(waitlistPosition(ps, ps[3].id)).toBe(2);
    expect(() => planAdminAction(t, ps, ps[4], 'offer', false, now)).toThrow(/full/);

    assertCanCancelOwn(t, ps[0], false);
    ps = ps.map((p, i) => (i === 0 ? { ...p, status: 'cancelled' as const } : p));
    const offer = planAdminAction(t, ps, ps[4], 'offer', false, now);
    expect(offer).toEqual({ status: 'awaiting_payment', reservedUntil: later(30) });
    // Offering in a free tournament confirms directly (no payment to verify).
    expect(planAdminAction({ ...t, settings: { ...t.settings, requirePayment: false } }, ps, ps[4], 'offer', false, now).status).toBe('confirmed');
  });

  it('cannot cancel twice or after the draw', () => {
    const [p] = players(['confirmed']);
    expect(() => assertCanCancelOwn(paid(), { ...p, status: 'cancelled' }, false)).toThrow(/already cancelled/);
    expect(() => assertCanCancelOwn(paid(), p, true)).toThrow(/after the draw/);
    expect(() => planAdminAction(paid(), [p], p, 'cancel', true, now)).toThrow(/after the draw/);
  });
});

describe('9. registration window controls', () => {
  it('closed, paused, not yet open, past the deadline (with and without late registration)', () => {
    expect(registrationState(paid({ status: 'registration_closed' }), 0, now)).toMatchObject({ open: false, reason: 'Registration is currently closed.' });
    expect(registrationState(paid({}, { registrationPaused: true }), 0, now).reason).toMatch(/paused/);
    expect(registrationState(paid({}, { registrationOpensAt: later(60) }), 0, now).reason).toMatch(/not opened/);
    expect(registrationState(paid({ registrationDeadline: later(-60) }), 0, now).reason).toMatch(/deadline/);
    expect(registrationState(paid({ registrationDeadline: later(-60) }, { allowLateRegistration: true }), 0, now)).toMatchObject({ open: true, late: true });
    expect(() => reg(paid({}, { registrationPaused: true }), [], 'X')).toThrow(/paused/);
  });
});

describe('10. capacity changes after registrations exist', () => {
  it('raising the maximum frees places; lowering it never confirms anyone beyond the limit', () => {
    const ps = players(['confirmed', 'confirmed', 'confirmed', 'waitlisted']);
    expect(() => planAdminAction(paid(), ps, ps[3], 'offer', false, now)).toThrow(/full/);
    expect(planAdminAction(paid({ maxParticipants: 4 }), ps, ps[3], 'offer', false, now).status).toBe('awaiting_payment');
    expect(reg(paid({ maxParticipants: 2 }, { waitlistEnabled: true }), ps.slice(0, 3), 'Y').status).toBe('waitlisted');
  });
  it('server counts win over what a public viewer can see', () => {
    const b = { participants: players(['confirmed']), counts: { confirmed: 1, holding: 3, waitlisted: 2 } };
    expect(capacityOf(b).holding).toBe(3);
  });
});

describe('11. roster finalization and format', () => {
  it('reports min/target shortfalls, pending work and invalid formats', () => {
    const t = makeTournament({ maxParticipants: 16 }, { minParticipants: 12, targetParticipants: 16, groupCount: 2, advancePerGroup: 2 });
    const ps: Participant[] = players([...Array(10).fill('confirmed'), 'awaiting_review', 'waitlisted'] as Participant['status'][]);
    const r = rosterReport(t, ps, now);
    expect(r.confirmed).toBe(10);
    expect(r.warnings.join(' ')).toMatch(/below the minimum of 12/);
    expect(r.warnings.join(' ')).toMatch(/1 receipts are still waiting/);
    expect(r.warnings.join(' ')).toMatch(/1 players are on the waitlist/);
    expect(r.blocking).toEqual([]); // 10 players fit 2 groups of 5
    expect(rosterReport({ ...t, settings: { ...t.settings, groupCount: 8 } }, ps, now).blocking.length).toBeGreaterThan(0);
  });

  it('suggests formats that fit the actual number of confirmed players', () => {
    const s12 = suggestFormats(12).filter((o) => o.format === 'groups_knockout');
    expect(s12.length).toBeGreaterThan(0);
    for (const o of s12) expect(o.groupCount * o.advancePerGroup & (o.groupCount * o.advancePerGroup - 1)).toBe(0);
    expect(suggestFormats(16)[0]).toMatchObject({ groupCount: 4, advancePerGroup: 2 });
    expect(suggestFormats(5).at(-1)?.format).toBe('single_elimination');
  });

  it('only confirmed players enter the draw, never pending or waitlisted ones', () => {
    const b = makeBundle(10, {}, { groupCount: 2 });
    b.participants = b.participants.map((p, i) => (i >= 8 ? { ...p, status: i === 8 ? 'awaiting_review' : 'waitlisted' } : p));
    const drawn = previewDraw(b, 3).flat();
    expect(drawn).toHaveLength(8);
    const after = applyMutation(b, planGroupStage(b, previewDraw(b, 3), ctx()).mutation, NOW);
    expect(after.groupMembers).toHaveLength(8);
    // After the draw every registration change is refused.
    expect(() => planAdminAction(after.tournament, after.participants, after.participants[8], 'confirm', true, now)).toThrow(/after the draw/);
  });

  it('gives every application a short, stable ID', () => {
    expect(applicationCode('4f7a1c9e-1234-4abc-8def-000000000000')).toBe('4F7A1C9E');
  });
});
