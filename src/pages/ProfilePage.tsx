import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { Inbox, UserRound } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, Navigate } from 'react-router-dom';
import { z } from 'zod';
import { PageContainer } from '@/components/layout/AppShell';
import { RegistrationStatusBadge } from '@/components/tournament/RegistrationStatusBadge';
import { useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader, EmptyState, Field, Input, Skeleton, Spinner } from '@/components/ui/primitives';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { makeNicknameSchema } from '@/features/auth/nickname';
import { PaymentCard } from '@/features/participants/PaymentCard';
import { useMyApplications } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { errorMessage, formatDate } from '@/lib/utils';

function NicknameCard({ current }: { current: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const schema = z.object({ nickname: makeNicknameSchema() });
  const { register, handleSubmit, formState: { errors, isSubmitting, isDirty } } = useForm<{ nickname: string }>({
    resolver: zodResolver(schema), defaultValues: { nickname: current },
  });
  const save = async (v: { nickname: string }) => {
    setError(null);
    try {
      await service.auth.updateNickname(v.nickname);
      await qc.invalidateQueries({ queryKey: ['auth-user'] });
      toast('success', t('Nickname changed to {name}.', { name: v.nickname }));
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <Card>
      <CardHeader title={t('Nickname')} description={t('Your public name on the site. You can change it at any time; it must be unique.')} />
      <form onSubmit={handleSubmit(save)} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:p-5" noValidate>
        <Field label={t('Nickname')} error={errors.nickname?.message ?? error ?? undefined} hint={t('3–24 letters, digits, _ . -')} className="flex-1">
          {(p) => <Input {...p} {...register('nickname')} autoComplete="nickname" />}
        </Field>
        <Button type="submit" variant="primary" loading={isSubmitting} disabled={!isDirty} className="sm:mt-7">{t('Save')}</Button>
      </form>
    </Card>
  );
}

export function ProfilePage() {
  const { user, loading } = useAuth();
  const local = service.mode === 'local';
  const apps = useMyApplications(local || !!user);

  if (loading) return <PageContainer><Spinner /></PageContainer>;
  if (!local && !user) return <Navigate to="/login?next=/profile" replace />;

  return (
    <PageContainer className="max-w-3xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-3xl font-bold"><UserRound className="h-7 w-7 text-accent" aria-hidden />{t('My cabinet')}</h1>
        <p className="mt-1 text-muted">{local ? t('Applications made from this browser.') : user?.email}</p>
      </div>

      {local
        ? <Alert tone="warning" title={t('Accounts are disabled in local mode')}>{t('Nicknames become available once Supabase is connected.')}</Alert>
        : user && <NicknameCard key={user.displayName} current={user.displayName} />}

      <section className="space-y-3" aria-label={t('My applications')}>
        <h2 className="text-lg font-semibold">{t('My applications')}</h2>
        {apps.error ? <Alert tone="danger" title={t('Could not load your applications')}>{errorMessage(apps.error)}</Alert>
          : apps.isLoading ? <Skeleton className="h-40" />
          : !apps.data?.length ? (
            <EmptyState icon={<Inbox className="h-8 w-8" />} title={t('You have no applications yet')} description={t('Open a tournament and register — your application and its status will appear here.')}
              action={<Link to="/tournaments"><Button variant="primary">{t('Explore tournaments')}</Button></Link>} />
          ) : apps.data.map(({ participant, tournament }) => (
            <Card key={participant.id} className="p-4 sm:p-5">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <Link to={`/tournaments/${tournament.id}`} className="font-semibold hover:text-accent">{tournament.name}</Link>
                  <p className="text-xs text-subtle">{formatDate(tournament.startsAt)} · {participant.displayName}</p>
                </div>
                <RegistrationStatusBadge status={participant.status} />
              </div>
              <PaymentCard participant={participant} tournament={tournament} />
            </Card>
          ))}
      </section>
    </PageContainer>
  );
}
