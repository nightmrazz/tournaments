import { useEffect } from 'react';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { useMyApplications } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import type { RegistrationStatus } from '@/types/domain';

const key = (id: string) => `temcch:notified:${id}`;

type Tone = 'success' | 'error' | 'info' | 'warning';

/** Message for a status change the player has not seen yet (null = nothing to announce). */
function messageFor(prev: RegistrationStatus | null, now: RegistrationStatus, tournament: string): [Tone, string] | null {
  if (prev === null) {
    // First time this browser sees the application: only announce outcomes, not the submission itself.
    if (now === 'rejected') return ['error', t('Your registration for "{tournament}" was rejected. Open My cabinet for details.', { tournament })];
    return null;
  }
  switch (now) {
    case 'confirmed':
      return ['success', t('Your registration for "{tournament}" is confirmed!', { tournament })];
    case 'awaiting_payment':
      return prev === 'waitlisted' || prev === 'rejected' || prev === 'cancelled'
        ? ['success', t('A place became available in "{tournament}"! Pay and send the receipt to keep it.', { tournament })]
        : null;
    case 'awaiting_review':
      return null; // the player just did this themselves
    case 'waitlisted':
      return ['warning', t('You are on the waitlist for "{tournament}".', { tournament })];
    case 'rejected':
      return ['error', t('Your registration for "{tournament}" was rejected. Open My cabinet for details.', { tournament })];
    case 'cancelled':
      return ['warning', t('Your registration for "{tournament}" was cancelled.', { tournament })];
  }
}

/**
 * In-site notifications: when one of the player's registrations changes status since this browser
 * last saw it, show a toast once. Applications are polled every 30 s. (No email / Telegram bot.)
 */
export function ApplicationNotifier() {
  const { user } = useAuth();
  const apps = useMyApplications(service.mode === 'local' || !!user);
  const toast = useToast();

  useEffect(() => {
    for (const { participant: p, tournament } of apps.data ?? []) {
      let seen: string | null = null;
      try { seen = localStorage.getItem(key(p.id)); } catch { /* storage unavailable */ }
      if (seen === p.status) continue;
      const msg = messageFor(seen as RegistrationStatus | null, p.status, tournament.name);
      if (msg) toast(msg[0], msg[1]);
      try { localStorage.setItem(key(p.id), p.status); } catch { /* not persisted */ }
    }
  }, [apps.data, toast]);

  return null;
}
