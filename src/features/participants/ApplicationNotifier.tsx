import { useEffect } from 'react';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { useMyApplications } from '@/features/tournaments/queries';
import { t } from '@/i18n';

const key = (id: string) => `temcch:notified:${id}`;

/**
 * In-site notification: when one of the player's applications becomes confirmed (or rejected)
 * since this browser last saw it, show a toast once. Applications are polled every 30 s.
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
      if (p.status === 'confirmed' && seen !== null) toast('success', t('Your registration for "{tournament}" is confirmed!', { tournament: tournament.name }));
      if (p.status === 'rejected') toast('error', t('Payment for "{tournament}" was not confirmed. Open My cabinet for details.', { tournament: tournament.name }));
      try { localStorage.setItem(key(p.id), p.status); } catch { /* not persisted */ }
    }
  }, [apps.data, toast]);

  return null;
}
