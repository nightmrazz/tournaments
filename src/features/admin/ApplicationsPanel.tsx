import { Ban, Check, Clock, Copy, Download, Hourglass, ListPlus, MessageCircle, Receipt, Undo2, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RegistrationStatusBadge } from '@/components/tournament/RegistrationStatusBadge';
import { useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader } from '@/components/ui/primitives';
import { service } from '@/data';
import {
  applicationCode, countCapacity, holdsSlot, REGISTRATION_STATUS_LABEL, reservationExpired, waitlistQueue, type AdminRegistrationAction,
} from '@/engine';
import { useInvalidateTournament } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { cn, errorMessage, formatDateTime, formatTime } from '@/lib/utils';
import type { Participant, RegistrationStatus, TournamentBundle } from '@/types/domain';

type Filter = 'awaiting_review' | 'awaiting_payment' | 'waitlisted' | 'rejected' | 'cancelled';
const FILTERS: Filter[] = ['awaiting_review', 'awaiting_payment', 'waitlisted', 'rejected', 'cancelled'];

/** Link to reach a player through the contact they left: Telegram, phone or email. */
export function contactHref(contact: string): string | null {
  const c = contact.trim();
  if (/^@[A-Za-z0-9_]{5,32}$/.test(c)) return `https://t.me/${c.slice(1)}`;
  if (/^(https?:\/\/)?t\.me\/[A-Za-z0-9_]{5,32}$/.test(c)) return c.startsWith('http') ? c : `https://${c}`;
  if (/^\+?[\d\s()-]{7,20}$/.test(c)) return `tel:${c.replace(/[^\d+]/g, '')}`;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) return `mailto:${c}`;
  return null;
}

/** CSV with every registration (organizer-only data: includes contacts). */
export function registrationsCsv(b: TournamentBundle, contactOf: Map<string, string>): string {
  const esc = (v: string | number | null | undefined) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['ID', 'Name', 'Status', 'Team', 'Seed', 'Contact', 'Registered', 'Status changed'];
  const order: RegistrationStatus[] = ['confirmed', 'awaiting_review', 'awaiting_payment', 'waitlisted', 'rejected', 'cancelled'];
  const rows = [...b.participants]
    .sort((a, c) => order.indexOf(a.status) - order.indexOf(c.status) || a.createdAt.localeCompare(c.createdAt))
    .map((p) => [applicationCode(p.id), p.displayName, REGISTRATION_STATUS_LABEL[p.status], p.team, p.seed, contactOf.get(p.id), p.createdAt, p.statusChangedAt].map(esc).join(','));
  return [header.map(esc).join(','), ...rows].join('\r\n');
}

function downloadCsv(name: string, csv: string) {
  // BOM so Excel opens Cyrillic correctly.
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'accent' | 'warning' }) {
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2">
      <p className="text-xs text-subtle">{label}</p>
      <p className={cn('text-lg font-semibold tabular', tone === 'accent' && 'text-accent', tone === 'warning' && 'text-warning')}>{value}</p>
    </div>
  );
}

/**
 * Organizer's registration management: counts, every registration by status, and the actions
 * confirm / reject / waitlist / offer a place / cancel. Status changes only before the draw;
 * capacity is re-checked by the database for every change.
 */
export function ApplicationsPanel({ b, contactOf }: { b: TournamentBundle; contactOf: Map<string, string> }) {
  const tour = b.tournament;
  const s = tour.settings;
  const invalidate = useInvalidateTournament(tour.id);
  const toast = useToast();
  const confirm = useConfirm();
  const now = new Date();
  const counts = countCapacity(b.participants, now);
  const free = Math.max(0, tour.maxParticipants - counts.holding);
  const byStatus = (st: RegistrationStatus) => b.participants.filter((p) => p.status === st);
  const live = byStatus('awaiting_payment').filter((p) => holdsSlot(p, now)).length;
  const firstOpen = FILTERS.find((f) => byStatus(f).length > 0) ?? 'awaiting_review';
  const [filter, setFilter] = useState<Filter>(firstOpen);
  const [busy, setBusy] = useState<string | null>(null);
  const drawn = b.matches.length > 0;
  const closed = tour.status === 'completed' || tour.status === 'cancelled';
  const canAct = !drawn && !closed;
  const queue = waitlistQueue(b.participants);

  const shown = filter === 'waitlisted'
    ? queue
    : byStatus(filter).sort((a, c) => a.statusChangedAt.localeCompare(c.statusChangedAt));

  const DESTRUCTIVE: Partial<Record<AdminRegistrationAction, { title: string; body: string; label: string }>> = {
    reject: { title: t('Reject the registration of {name}?'), body: t('The player sees the status "Rejected" and loses any reserved place. They can send the receipt again.'), label: t('Reject') },
    cancel: { title: t('Cancel the registration of {name}?'), body: t('The player sees the status "Cancelled" and the place is released. You can restore them to the waitlist later.'), label: t('Cancel registration') },
  };

  const act = async (p: Participant, action: AdminRegistrationAction) => {
    const d = DESTRUCTIVE[action];
    if (d && !(await confirm({ title: d.title.replace('{name}', p.displayName), body: d.body, confirmLabel: d.label, destructive: true }))) return;
    setBusy(p.id + action);
    try {
      await service.registrationAction(p.id, action);
      await invalidate();
      const msg: Record<AdminRegistrationAction, string> = {
        confirm: t('{name} is confirmed as a participant.', { name: p.displayName }),
        reject: t('Registration of {name} rejected.', { name: p.displayName }),
        waitlist: t('{name} moved to the waitlist.', { name: p.displayName }),
        offer: s.requirePayment
          ? t('A place was offered to {name}. They have {n} min to pay.', { name: p.displayName, n: s.reservationMinutes })
          : t('{name} is confirmed as a participant.', { name: p.displayName }),
        cancel: t('Registration of {name} cancelled.', { name: p.displayName }),
      };
      toast(action === 'reject' || action === 'cancel' ? 'warning' : 'success', msg[action]);
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); toast('info', t('Copied: {text}', { text: code })); } catch { /* clipboard unavailable */ }
  };

  const actions = (p: Participant): { action: AdminRegistrationAction; label: string; icon: ReactNode; variant: 'primary' | 'secondary' | 'danger' | 'ghost'; needsPlace?: boolean }[] => {
    const offerLabel = s.requirePayment ? t('Offer a place') : t('Confirm');
    switch (p.status) {
      case 'awaiting_review':
        return [
          { action: 'confirm', label: t('Confirm payment'), icon: <Check className="h-4 w-4" />, variant: 'primary' },
          { action: 'reject', label: t('Reject'), icon: <X className="h-4 w-4" />, variant: 'danger' },
          { action: 'cancel', label: t('Cancel'), icon: <Ban className="h-4 w-4" />, variant: 'ghost' },
        ];
      case 'awaiting_payment':
        return [
          { action: 'confirm', label: t('Confirm payment'), icon: <Check className="h-4 w-4" />, variant: 'primary', needsPlace: !holdsSlot(p, now) },
          { action: 'waitlist', label: t('To waitlist'), icon: <ListPlus className="h-4 w-4" />, variant: 'secondary' },
          { action: 'reject', label: t('Reject'), icon: <X className="h-4 w-4" />, variant: 'danger' },
          { action: 'cancel', label: t('Cancel'), icon: <Ban className="h-4 w-4" />, variant: 'ghost' },
        ];
      case 'waitlisted':
        return [
          { action: 'offer', label: offerLabel, icon: <Check className="h-4 w-4" />, variant: 'primary', needsPlace: true },
          { action: 'cancel', label: t('Cancel'), icon: <Ban className="h-4 w-4" />, variant: 'ghost' },
        ];
      case 'rejected':
        return [
          { action: 'offer', label: offerLabel, icon: <Undo2 className="h-4 w-4" />, variant: 'secondary', needsPlace: true },
          { action: 'waitlist', label: t('To waitlist'), icon: <ListPlus className="h-4 w-4" />, variant: 'secondary' },
          { action: 'cancel', label: t('Cancel'), icon: <Ban className="h-4 w-4" />, variant: 'ghost' },
        ];
      case 'cancelled':
        return [{ action: 'waitlist', label: t('Restore to waitlist'), icon: <Undo2 className="h-4 w-4" />, variant: 'secondary' }];
      default:
        return [];
    }
  };

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Receipt className="h-4 w-4 text-accent" aria-hidden />{t('Registration management')}</span>}
        description={t('Find the receipt in Telegram by its application ID, then confirm or reject. Only confirmed registrations become participants.')}
        action={
          <Button size="sm" variant="secondary" onClick={() => downloadCsv(`${tour.name.replace(/[^\p{L}\p{N}]+/gu, '-')}-registrations.csv`, registrationsCsv(b, contactOf))} disabled={!b.participants.length}>
            <Download className="h-4 w-4" />{t('Export CSV')}
          </Button>
        }
      />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" data-testid="registration-stats">
          <Stat label={t('Confirmed players')} value={`${counts.confirmed}/${tour.maxParticipants}`} tone="accent" />
          <Stat label={t('Places taken')} value={counts.holding} />
          <Stat label={t('Free places')} value={free} tone={free === 0 ? 'warning' : undefined} />
          <Stat label={t('Receipts to check')} value={byStatus('awaiting_review').length} tone={byStatus('awaiting_review').length ? 'warning' : undefined} />
          <Stat label={t('Unpaid reservations')} value={live} />
          <Stat label={t('Waitlist')} value={counts.waitlisted} />
        </div>
        {(s.minParticipants > 0 || s.targetParticipants > 0) && (
          <p className="text-sm text-muted">
            {s.minParticipants > 0 && t('Minimum {n}', { n: s.minParticipants })}
            {s.minParticipants > 0 && s.targetParticipants > 0 && ' · '}
            {s.targetParticipants > 0 && t('Target {n}', { n: s.targetParticipants })}
            {' · '}{t('Maximum {n}', { n: tour.maxParticipants })}
            {s.minParticipants > 0 && counts.confirmed < s.minParticipants && <span className="text-warning"> · {t('{n} more needed to reach the minimum', { n: s.minParticipants - counts.confirmed })}</span>}
          </p>
        )}
        {drawn && b.participants.some((p) => p.status !== 'confirmed') && (
          <Alert tone="info" title={t('The draw is done')}>{t('Registration statuses are frozen. Unconfirmed registrations did not take part in the draw.')}</Alert>
        )}

        <div className="flex flex-wrap gap-1" role="tablist" aria-label={t('Registrations by status')}>
          {FILTERS.map((f) => {
            const n = byStatus(f).length;
            return (
              <button key={f} role="tab" aria-selected={filter === f} onClick={() => setFilter(f)}
                className={cn('h-9 rounded-md px-3 text-sm font-medium transition-colors', filter === f ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}>
                {t(REGISTRATION_STATUS_LABEL[f])} <span className="ml-1 tabular text-subtle">{n}</span>
              </button>
            );
          })}
        </div>

        {!shown.length ? (
          <p className="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{t('No registrations here.')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="applications">
            {shown.map((p, i) => {
              const code = applicationCode(p.id);
              const contact = contactOf.get(p.id);
              const href = contact ? contactHref(contact) : null;
              const late = !!tour.registrationDeadline && p.createdAt > tour.registrationDeadline;
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      {p.status === 'waitlisted' && <span className="grid h-6 min-w-6 place-items-center rounded bg-surface-3 px-1 text-xs font-semibold tabular" title={t('Waitlist position')}>{i + 1}</span>}
                      <span className="font-medium">{p.displayName}</span>
                      <RegistrationStatusBadge status={p.status} />
                      {reservationExpired(p, now) && <span className="inline-flex items-center gap-1 text-xs text-warning"><Hourglass className="h-3 w-3" aria-hidden />{t('Reservation expired')}</span>}
                      {p.status === 'awaiting_payment' && holdsSlot(p, now) && p.reservedUntil && <span className="inline-flex items-center gap-1 text-xs text-subtle"><Clock className="h-3 w-3" aria-hidden />{t('Place held until {time}', { time: formatTime(p.reservedUntil) })}</span>}
                      {late && <span className="text-xs text-warning">{t('Late')}</span>}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-subtle">
                      <button className="inline-flex items-center gap-1 font-mono text-muted hover:text-accent" onClick={() => copy(code)} aria-label={t('Copy application ID {code}', { code })}>
                        ID {code}<Copy className="h-3 w-3" aria-hidden />
                      </button>
                      <span>{formatDateTime(p.createdAt)}</span>
                      {contact && (href
                        ? <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted hover:text-accent"><MessageCircle className="h-3 w-3" aria-hidden />{contact}</a>
                        : <span>{contact}</span>)}
                    </p>
                  </div>
                  {canAct && (
                    <div className="flex flex-wrap gap-2">
                      {actions(p).map((a) => (
                        <Button key={a.action} size="sm" variant={a.variant} onClick={() => act(p, a.action)} loading={busy === p.id + a.action}
                          disabled={!!busy || (a.needsPlace && free === 0)} title={a.needsPlace && free === 0 ? t('No free places') : undefined}
                          aria-label={`${a.label}: ${p.displayName}`}>
                          {a.icon}{a.label}
                        </Button>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
