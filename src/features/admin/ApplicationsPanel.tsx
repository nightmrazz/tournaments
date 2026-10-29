import { Check, Copy, Receipt, X } from 'lucide-react';
import { useState } from 'react';
import { RegistrationStatusBadge } from '@/components/tournament/RegistrationStatusBadge';
import { useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader, Select } from '@/components/ui/primitives';
import { service } from '@/data';
import { applicationCode, isConfirmed } from '@/engine';
import { useInvalidateTournament } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { errorMessage, formatDateTime } from '@/lib/utils';
import type { Participant, RegistrationStatus, TournamentBundle } from '@/types/domain';

const ORDER: Record<RegistrationStatus, number> = { awaiting_review: 0, awaiting_payment: 1, rejected: 2, confirmed: 3 };

/**
 * Organizer view of paid applications: find a receipt by its application ID, then confirm or reject.
 * Only confirmed applications become participants (and count toward capacity).
 */
export function ApplicationsPanel({ b, contactOf }: { b: TournamentBundle; contactOf: Map<string, string> }) {
  const tour = b.tournament;
  const invalidate = useInvalidateTournament(tour.id);
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState<'open' | RegistrationStatus>('open');
  const [busy, setBusy] = useState<string | null>(null);
  const pending = b.participants.filter((p) => !isConfirmed(p));
  const confirmedCount = b.participants.length - pending.length;
  const full = confirmedCount >= tour.maxParticipants;
  const drawn = b.matches.length > 0;
  const closed = tour.status === 'completed' || tour.status === 'cancelled';
  const canAct = !drawn && !closed;

  const shown = pending
    .filter((p) => (filter === 'open' ? p.status !== 'rejected' : p.status === filter))
    .sort((a, c) => ORDER[a.status] - ORDER[c.status] || a.createdAt.localeCompare(c.createdAt));
  const counts = {
    review: pending.filter((p) => p.status === 'awaiting_review').length,
    payment: pending.filter((p) => p.status === 'awaiting_payment').length,
    rejected: pending.filter((p) => p.status === 'rejected').length,
  };

  const setStatus = async (p: Participant, to: RegistrationStatus) => {
    if (to === 'rejected' && !(await confirm({
      title: t('Reject the payment of {name}?', { name: p.displayName }),
      body: t('The application gets the status "Payment not confirmed". The player can send the receipt again.'),
      confirmLabel: t('Reject payment'), destructive: true,
    }))) return;
    setBusy(p.id);
    try {
      await service.setRegistrationStatus(p.id, to);
      await invalidate();
      toast(to === 'confirmed' ? 'success' : 'warning', to === 'confirmed'
        ? t('{name} is confirmed as a participant.', { name: p.displayName })
        : t('Payment of {name} marked as not confirmed.', { name: p.displayName }));
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); toast('info', t('Copied: {text}', { text: code })); } catch { /* clipboard unavailable */ }
  };

  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Receipt className="h-4 w-4 text-accent" aria-hidden />{t('Payment applications')}</span>}
        description={t('Find the receipt in Telegram by its application ID, then confirm or reject. Only confirmed applications become participants.')}
        action={
          <Select aria-label={t('Filter applications')} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} className="h-9 w-auto">
            <option value="open">{t('Open ({n})', { n: counts.review + counts.payment })}</option>
            <option value="awaiting_review">{t('Awaiting receipt check ({n})', { n: counts.review })}</option>
            <option value="awaiting_payment">{t('Awaiting payment ({n})', { n: counts.payment })}</option>
            <option value="rejected">{t('Payment not confirmed ({n})', { n: counts.rejected })}</option>
          </Select>
        }
      />
      <div className="space-y-3 p-4 sm:p-5">
        <p className="text-sm text-muted tabular">
          {t('Confirmed: {n}/{max} · awaiting check: {review} · awaiting payment: {payment}', { n: confirmedCount, max: tour.maxParticipants, review: counts.review, payment: counts.payment })}
        </p>
        {full && canAct && pending.length > 0 && <Alert tone="warning" title={t('All places are taken')}>{t('Raise the capacity in Settings or remove a participant to confirm more applications.')}</Alert>}
        {drawn && pending.length > 0 && <Alert tone="info" title={t('The draw is done')}>{t('Unconfirmed applications did not take part in the draw and can no longer be confirmed.')}</Alert>}
        {!shown.length ? (
          <p className="rounded-md border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{t('No applications here.')}</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line" data-testid="applications">
            {shown.map((p) => {
              const code = applicationCode(p.id);
              return (
                <li key={p.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{p.displayName}</span>
                      <RegistrationStatusBadge status={p.status} />
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-subtle">
                      <button className="inline-flex items-center gap-1 font-mono text-muted hover:text-accent" onClick={() => copy(code)} aria-label={t('Copy application ID {code}', { code })}>
                        ID {code}<Copy className="h-3 w-3" aria-hidden />
                      </button>
                      <span>{formatDateTime(p.createdAt)}</span>
                      {contactOf.get(p.id) && <span>{contactOf.get(p.id)}</span>}
                    </p>
                  </div>
                  {canAct && (
                    <div className="flex gap-2">
                      <Button size="sm" variant="primary" onClick={() => setStatus(p, 'confirmed')} loading={busy === p.id} disabled={full || !!busy}
                        aria-label={t('Confirm payment of {name}', { name: p.displayName })}>
                        <Check className="h-4 w-4" aria-hidden />{t('Confirm')}
                      </Button>
                      {p.status !== 'rejected' && (
                        <Button size="sm" variant="danger" onClick={() => setStatus(p, 'rejected')} disabled={!!busy}
                          aria-label={t('Reject payment of {name}', { name: p.displayName })}>
                          <X className="h-4 w-4" aria-hidden />{t('Reject')}
                        </Button>
                      )}
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
