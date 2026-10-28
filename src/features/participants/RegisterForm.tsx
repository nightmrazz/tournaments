import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation } from 'react-router-dom';
import { z } from 'zod';
import { Alert, Button, Field, Input } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { keys } from '@/features/tournaments/queries';
import { registrationState } from '@/engine';
import { t, tr } from '@/i18n';
import { errorMessage } from '@/lib/utils';
import type { TournamentBundle } from '@/types/domain';

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
  const [done, setDone] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const requireContact = b.tournament.settings.requireContact;
  const { register, handleSubmit, reset, formState: { errors, isSubmitting } } = useForm<ParticipantForm>({
    resolver: zodResolver(makeParticipantSchema(requireContact)),
    // Pre-fill only a signed-in player's own name; the local "organizer" identity is not a player.
    defaultValues: { displayName: service.mode === 'supabase' ? user?.displayName ?? '' : '', contact: '' },
  });

  const state = registrationState(b.tournament, b.participants.length);
  const alreadyIn = service.mode === 'supabase' && user && b.participants.some((p) => p.userId === user.id);

  if (alreadyIn) return <Alert tone="success" title={t('You are registered')}>{t('See you at kick-off. Your fixtures will appear in the Matches tab once the draw is made.')}</Alert>;
  if (!state.open) return <Alert tone="warning" title={t('Registration unavailable')}>{tr(state.reason ?? '')}</Alert>;
  if (service.mode === 'supabase' && !user) {
    return (
      <div className="space-y-3 text-sm text-muted">
        <p>{t('Sign in to register. Your account ensures nobody else can register or withdraw on your behalf.')}</p>
        <Link to={`/login?next=${encodeURIComponent(location.pathname)}`}><Button variant="primary"><LogIn className="h-4 w-4" aria-hidden />{t('Sign in to register')}</Button></Link>
      </div>
    );
  }

  const onSubmit = async (v: ParticipantForm) => {
    setServerError(null);
    try {
      const p = await service.register(b.tournament.id, { displayName: v.displayName, contact: v.contact || null });
      setDone(p.displayName);
      reset({ displayName: '', contact: '' });
      toast('success', t('{name} is registered.', { name: p.displayName }));
      await Promise.all([qc.invalidateQueries({ queryKey: keys.bundle(b.tournament.id) }), qc.invalidateQueries({ queryKey: keys.list })]);
    } catch (e) {
      setServerError(errorMessage(e));
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-4" noValidate aria-label={t('Register for this tournament')}>
      {done && <Alert tone="success" title={<span className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4" />{t('{name} is registered.', { name: done })}</span>} />}
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
        <p className="text-xs text-subtle tabular">{t('{left} of {max} places left', { left: b.tournament.maxParticipants - b.participants.length, max: b.tournament.maxParticipants })}</p>
        <Button type="submit" variant="primary" loading={isSubmitting}>{t('Register')}</Button>
      </div>
    </form>
  );
}
