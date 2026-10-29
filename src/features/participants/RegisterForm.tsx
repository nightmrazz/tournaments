import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'react-router-dom';
import { z } from 'zod';
import { Alert, Button, Field, Input } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { keys, useMyApplications } from '@/features/tournaments/queries';
import { applicationCode, confirmedParticipants, registrationState } from '@/engine';
import { t, tr } from '@/i18n';
import { errorMessage } from '@/lib/utils';
import type { TournamentBundle } from '@/types/domain';
import { PaymentCard } from './PaymentCard';

/** Built per render so validation messages follow the current language. */
export function makeParticipantSchema(requireContact = false) {
  return z.object({
    displayName: z.string().trim()
      .min(2, t('At least 2 characters'))
      .max(32, t('At most 32 characters'))
      .regex(/^[\p{L}\p{N} _.\-']+$/u, t('Letters, numbers, spaces, _ . - only')),
    contact: requireContact
      ? z.string().trim().min(3, t('Contact information is required')).max(120, t('At most 120 characters'))
      : z.string().trim().max(120, t('At most 120 characters')).optional(),
  });
}
export type ParticipantForm = z.infer<ReturnType<typeof makeParticipantSchema>>;

export function RegisterForm({ b }: { b: TournamentBundle }) {
  const { user } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const location = useLocation();
  const [serverError, setServerError] = useState<string | null>(null);
  const tour = b.tournament;
  const requireContact = tour.settings.requireContact;
  const paid = tour.settings.requirePayment;
  // Local mode has no accounts: "my" applications are the ones made from this browser.
  const mine = useMyApplications(service.mode === 'local');
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ParticipantForm>({
    resolver: zodResolver(makeParticipantSchema(requireContact)),
    // Pre-fill only a signed-in player's own name; the local "organizer" identity is not a player.
    defaultValues: { displayName: service.mode === 'supabase' ? user?.displayName ?? '' : '', contact: '' },
  });

  const confirmedCount = confirmedParticipants(b).length;
  const state = registrationState(tour, confirmedCount);
  const own = service.mode === 'supabase' && user ? b.participants.find((p) => p.userId === user.id) : undefined;
  const localMine = (mine.data ?? []).filter((a) => a.tournament.id === tour.id).map((a) => a.participant);

  // A signed-in player has at most one application per tournament: show its status instead of the form.
  if (own) return <PaymentCard participant={own} tournament={tour} />;
  if (!state.open) {
    return (
      <div className="space-y-3">
        {localMine.map((p) => <PaymentCard key={p.id} participant={p} tournament={tour} />)}
        <Alert tone="warning" title={t('Registration unavailable')}>{tr(state.reason ?? '')}</Alert>
      </div>
    );
  }
  if (service.mode === 'supabase' && !user) {
    return (
      <div className="space-y-3 text-sm text-muted">
        {paid && tour.settings.entryFee && <p className="text-fg">{t('Entry fee: {fee}', { fee: tour.settings.entryFee })}</p>}
        <p>{t('Sign in to register. Your account ensures nobody else can register or withdraw on your behalf.')}</p>
        <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}><Button variant="primary"><LogIn className="h-4 w-4" aria-hidden />{t('Sign in to register')}</Button></Link>
      </div>
    );
  }

  const onSubmit = async (v: ParticipantForm) => {
    setServerError(null);
    try {
      const p = await service.register(tour.id, { displayName: v.displayName, contact: v.contact || null });
      reset({ displayName: '', contact: '' });
      toast('success', p.status === 'confirmed'
        ? t('{name} is registered.', { name: p.displayName })
        : t('Application {code} sent. Follow the payment instructions.', { code: applicationCode(p.id) }));
      await Promise.all([
        qc.invalidateQueries({ queryKey: keys.bundle(tour.id) }),
        qc.invalidateQueries({ queryKey: keys.list }),
        qc.invalidateQueries({ queryKey: keys.mine }),
      ]);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      {localMine.map((p) => <PaymentCard key={p.id} participant={p} tournament={tour} />)}
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate aria-label={t('Register for this tournament')}>
        {paid && (
          <Alert tone="info" title={t('Entry fee: {fee}', { fee: tour.settings.entryFee || '—' })}>
            {t('After you submit the form you will see the payment details and your application ID. Your place is confirmed once the organizer checks the receipt.')}
          </Alert>
        )}
        {serverError && <Alert tone="danger" title={t('Registration failed')}>{serverError}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('Display name')} error={errors.displayName?.message} hint={t('Shown in tables and brackets. Must be unique in this tournament.')}>
            {(p) => <Input {...p} {...register('displayName')} autoComplete="nickname" placeholder={t('e.g. Aidar K.')} />}
          </Field>
          <Field label={requireContact ? t('Contact (required)') : t('Contact (optional)')} error={errors.contact?.message} hint={t('Telegram, phone or email. Only the organizer can see it.')}>
            {(p) => <Input {...p} {...register('contact')} autoComplete="off" placeholder={t('@telegram or +7…')} />}
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-subtle tabular">{t('{left} of {max} places left', { left: tour.maxParticipants - confirmedCount, max: tour.maxParticipants })}</p>
          <Button type="submit" variant="primary" loading={isSubmitting}>{paid ? t('Submit application') : t('Register')}</Button>
        </div>
      </form>
    </div>
  );
}
