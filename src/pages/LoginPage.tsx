import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { PageContainer } from '@/components/layout/AppShell';
import { Alert, Button, Card, Field, Input } from '@/components/ui/primitives';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { t } from '@/i18n';
import { errorMessage } from '@/lib/utils';

const makeSchema = () => z.object({
  email: z.email(t('Enter a valid email address')),
  password: z.string().min(8, t('At least 8 characters')),
  displayName: z.string().trim().max(40).optional(),
});
type Form = z.infer<ReturnType<typeof makeSchema>>;

/** Only allow in-app redirects after sign-in (prevents open redirects). */
const safeNext = (next: string | null) => (next && next.startsWith('/') && !next.startsWith('//') ? next : '/');

export function LoginPage() {
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<Form>({ resolver: zodResolver(makeSchema()) });
  const next = safeNext(params.get('next'));

  if (service.mode === 'local') {
    return (
      <PageContainer className="max-w-lg">
        <Alert tone="warning" title={t('Accounts are disabled in local mode')}>
          {t('This build has no Supabase configuration, so everyone using this browser acts as the local organizer. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable real sign-in.')}
        </Alert>
        <Link to="/" className="mt-4 inline-block text-sm text-accent">{t('Back to home')}</Link>
      </PageContainer>
    );
  }
  if (user) return <Navigate to={next} replace />;

  const onSubmit = async (v: Form) => {
    setError(null); setInfo(null);
    try {
      if (mode === 'signin') {
        await service.auth.signIn(v.email, v.password);
        await qc.invalidateQueries();
        toast('success', t('Signed in.'));
        navigate(next, { replace: true });
      } else {
        const r = await service.auth.signUp(v.email, v.password, v.displayName || v.email.split('@')[0]);
        if (r.needsConfirmation) setInfo(t('Check your inbox to confirm your email, then sign in.'));
        else { await qc.invalidateQueries(); navigate(next, { replace: true }); }
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <PageContainer className="max-w-md py-12">
      <Card className="p-6">
        <h1 className="text-2xl font-bold">{mode === 'signin' ? t('Sign in') : t('Create account')}</h1>
        <p className="mt-1 text-sm text-muted">{mode === 'signin' ? t('Register for tournaments and manage your events.') : t('Players can register for tournaments. Organizer access is granted by a platform administrator.')}</p>
        <form onSubmit={handleSubmit(onSubmit)} className="mt-6 space-y-4" noValidate>
          {error && <Alert tone="danger" title={error} />}
          {info && <Alert tone="success" title={info} />}
          {mode === 'signup' && <Field label={t('Display name')} error={errors.displayName?.message}>{(p) => <Input {...p} {...register('displayName')} autoComplete="nickname" />}</Field>}
          <Field label={t('Email')} error={errors.email?.message}>{(p) => <Input {...p} {...register('email')} type="email" autoComplete="email" />}</Field>
          <Field label={t('Password')} error={errors.password?.message}>{(p) => <Input {...p} {...register('password')} type="password" autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} />}</Field>
          <Button type="submit" variant="primary" className="w-full" loading={isSubmitting}>{mode === 'signin' ? t('Sign in') : t('Create account')}</Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          {mode === 'signin' ? t('New here?') : t('Already have an account?')}{' '}
          <button className="font-medium text-accent hover:underline" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(null); setInfo(null); }}>
            {mode === 'signin' ? t('Create an account') : t('Sign in')}
          </button>
        </p>
      </Card>
    </PageContainer>
  );
}

export function NotFoundPage() {
  return (
    <PageContainer className="py-20 text-center">
      <p className="font-mono text-sm text-accent">404</p>
      <h1 className="mt-2 text-3xl font-bold">{t('Page not found')}</h1>
      <p className="mt-2 text-muted">{t('The page you are looking for does not exist or has moved.')}</p>
      <Link to="/" className="mt-6 inline-block"><Button variant="primary">{t('Go home')}</Button></Link>
    </PageContainer>
  );
}
