import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Clock, Copy, Send, XCircle } from 'lucide-react';
import { useState } from 'react';
import { RegistrationStatusBadge } from '@/components/tournament/RegistrationStatusBadge';
import { useToast } from '@/components/ui/overlay';
import { Alert, Button } from '@/components/ui/primitives';
import { service } from '@/data';
import { applicationCode } from '@/engine';
import { keys } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { cn, errorMessage } from '@/lib/utils';
import type { Participant, Tournament } from '@/types/domain';

/** Message the player pastes next to the receipt so the organizer can match the payment. */
export const receiptMessage = (p: Participant, tournamentName: string) =>
  t('Application {code} · {tournament} · {name}', { code: applicationCode(p.id), tournament: tournamentName, name: p.displayName });

/**
 * What a player sees for their own application: status, application ID and — while unpaid or
 * rejected — the fee, payment details, the organizer's Telegram and the "I paid" button.
 */
export function PaymentCard({ participant: p, tournament, className }: {
  participant: Participant;
  tournament: Pick<Tournament, 'id' | 'name' | 'settings'>;
  className?: string;
}) {
  const s = tournament.settings;
  const code = applicationCode(p.id);
  const toast = useToast();
  const qc = useQueryClient();
  const [sending, setSending] = useState(false);
  const needsPayment = p.status === 'awaiting_payment' || p.status === 'rejected';
  const tg = s.telegramUsername;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast('info', t('Copied: {text}', { text })); }
    catch { toast('error', t('Could not copy. Select the text and copy it manually.')); }
  };

  const markSent = async () => {
    setSending(true);
    try {
      await service.markReceiptSent(p.id);
      await Promise.all([qc.invalidateQueries({ queryKey: keys.bundle(tournament.id) }), qc.invalidateQueries({ queryKey: keys.mine })]);
      toast('success', t('Thank you! The organizer will check the receipt and confirm your registration.'));
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={cn('space-y-4 rounded-[var(--radius-control)] border border-line bg-surface-2 p-4', className)} data-testid="payment-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-subtle">{t('Application ID')}</p>
          <button onClick={() => copy(code)} className="inline-flex items-center gap-1.5 font-mono text-lg font-semibold tracking-wider text-fg hover:text-accent" aria-label={t('Copy application ID {code}', { code })}>
            {code}<Copy className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <RegistrationStatusBadge status={p.status} />
      </div>

      {p.status === 'confirmed' && (
        <Alert tone="success" title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{t('Registration confirmed')}</span>}>
          {t('You are a participant of the tournament. Your fixtures will appear in the Matches tab after the draw.')}
        </Alert>
      )}
      {p.status === 'awaiting_review' && (
        <Alert tone="info" title={<span className="flex items-center gap-2"><Clock className="h-4 w-4" />{t('Receipt is being checked')}</span>}>
          {t('The organizer will check your payment. You will see a notification on the site once it is confirmed.')}
        </Alert>
      )}
      {p.status === 'rejected' && (
        <Alert tone="danger" title={<span className="flex items-center gap-2"><XCircle className="h-4 w-4" />{t('Payment not confirmed')}</span>}>
          {t('The organizer could not confirm your payment. Check the details, send the receipt again and press the button below.')}
        </Alert>
      )}

      {needsPayment && (
        <ol className="space-y-4 text-sm">
          <li>
            <p className="font-semibold">{t('1. Pay the entry fee')}</p>
            {s.entryFee && <p className="mt-1 text-2xl font-bold text-accent">{s.entryFee}</p>}
            {s.paymentDetails && <p className="mt-2 whitespace-pre-line rounded-md border border-line bg-surface px-3 py-2 text-fg">{s.paymentDetails}</p>}
          </li>
          <li>
            <p className="font-semibold">{t('2. Send the receipt to the organizer in Telegram')}</p>
            <p className="mt-1 text-muted">{t('Add your application ID to the message so the organizer knows who paid:')}</p>
            <p className="mt-2 rounded-md border border-dashed border-line-strong bg-surface px-3 py-2 font-mono text-xs text-fg">{receiptMessage(p, tournament.name)}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {tg && (
                <a href={`https://t.me/${encodeURIComponent(tg)}`} target="_blank" rel="noopener noreferrer"
                  className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-semibold text-accent-ink glow-sm hover:bg-accent-strong">
                  <Send className="h-4 w-4" aria-hidden />{t('Send receipt in Telegram')} <span className="font-normal">@{tg}</span>
                </a>
              )}
              <Button variant="secondary" onClick={() => copy(receiptMessage(p, tournament.name))}><Copy className="h-4 w-4" />{t('Copy message')}</Button>
            </div>
          </li>
          <li>
            <p className="font-semibold">{t('3. Tell us the receipt was sent')}</p>
            <Button variant="outline" className="mt-2" onClick={markSent} loading={sending}><CheckCircle2 className="h-4 w-4" />{t('I paid and sent the receipt')}</Button>
          </li>
        </ol>
      )}
    </div>
  );
}
