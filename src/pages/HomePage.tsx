import { ArrowRight, GitBranch, ListOrdered, Plus, ShieldCheck, Trophy } from 'lucide-react';
import { Link } from 'react-router-dom';
import { PageContainer } from '@/components/layout/AppShell';
import { TournamentCard, TournamentCardSkeleton } from '@/components/tournament/TournamentBits';
import { Alert, Button, EmptyState } from '@/components/ui/primitives';
import type { TournamentSummary } from '@/data';
import { service } from '@/data';
import { useAuth } from '@/features/auth/AuthProvider';
import { useTournaments } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { errorMessage } from '@/lib/utils';

function Row({ title, items, loading, empty }: { title: string; items: TournamentSummary[]; loading: boolean; empty: string }) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold">{title}</h2>
        <Link to="/tournaments" className="text-sm text-muted hover:text-accent">{t('View all')}</Link>
      </div>
      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <TournamentCardSkeleton key={i} />)}</div>
      ) : items.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.slice(0, 3).map((x) => <TournamentCard key={x.id} t={x} />)}</div>
      ) : (
        <p className="rounded-[var(--radius-control)] border border-dashed border-line px-4 py-6 text-center text-sm text-muted">{empty}</p>
      )}
    </section>
  );
}

export function HomePage() {
  const { data, isLoading, error, refetch } = useTournaments();
  const { isOrganizer } = useAuth();
  const all = (data ?? []).filter((x) => x.status !== 'draft' && x.status !== 'cancelled');
  const live = all.filter((x) => x.status === 'in_progress');
  const upcoming = all.filter((x) => x.status === 'registration_open' || x.status === 'registration_closed')
    .sort((a, b) => (a.startsAt ?? '9').localeCompare(b.startsAt ?? '9'));
  const finished = all.filter((x) => x.status === 'completed').sort((a, b) => (b.startsAt ?? '').localeCompare(a.startsAt ?? ''));
  const canCreate = isOrganizer || service.mode === 'local';

  const features = [
    { icon: ListOrdered, title: t('Standings from results'), text: t('Points, goal difference and head-to-head tie-breakers are computed from recorded scores — never typed in by hand.') },
    { icon: GitBranch, title: t('Brackets that stay valid'), text: t('Winners advance automatically. Correct an old result and affected later matches are reset, not silently kept.') },
    { icon: ShieldCheck, title: t('Organizer controls'), text: t('Only a tournament’s organizers can draw groups or enter scores — enforced by the database, not just the UI.') },
  ];

  return (
    <>
      <section className="border-b border-line">
        <PageContainer className="grid gap-8 py-10 sm:py-14 lg:grid-cols-[1.2fr_1fr] lg:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">{t('EA SPORTS FC 27 · Local & campus events')}</p>
            <h1 className="mt-3 text-4xl font-bold leading-[1.05] sm:text-5xl">{t('Run the bracket.')}<br /><span className="neon-text">{t('Not the spreadsheet.')}</span></h1>
            <p className="mt-4 max-w-xl text-base text-muted">
              {t('Registration, group draws, fixtures, live standings and knockout brackets for FC 27 tournaments — with results that update for every player in the room.')}
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Link to="/tournaments"><Button variant="primary" size="lg">{t('Explore tournaments')}<ArrowRight className="h-4 w-4" aria-hidden /></Button></Link>
              {canCreate && <Link to="/admin/tournaments/new"><Button variant="outline" size="lg"><Plus className="h-4 w-4" aria-hidden />{t('Create tournament')}</Button></Link>}
            </div>
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
            {features.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4">
                <Icon className="mt-0.5 h-5 w-5 shrink-0 text-accent" aria-hidden />
                <div><p className="font-medium">{title}</p><p className="mt-1 text-sm text-muted">{text}</p></div>
              </li>
            ))}
          </ul>
        </PageContainer>
      </section>
      <PageContainer className="space-y-10">
        {error ? (
          <Alert tone="danger" title={t('Could not load tournaments')} action={<Button size="sm" onClick={() => refetch()}>{t('Retry')}</Button>}>{errorMessage(error)}</Alert>
        ) : !isLoading && all.length === 0 ? (
          <EmptyState
            icon={<Trophy className="h-10 w-10" />}
            title={t('No tournaments yet')}
            description={t('When an organizer publishes a tournament it will show up here.')}
            action={canCreate && <Link to="/admin/tournaments/new"><Button variant="primary"><Plus className="h-4 w-4" />{t('Create the first one')}</Button></Link>}
          />
        ) : (
          <>
            {(isLoading || live.length > 0) && <Row title={t('Live now')} items={live} loading={isLoading} empty="" />}
            <Row title={t('Upcoming')} items={upcoming} loading={isLoading} empty={t('No upcoming tournaments at the moment.')} />
            <Row title={t('Recently completed')} items={finished} loading={isLoading} empty={t('No completed tournaments yet.')} />
          </>
        )}
      </PageContainer>
    </>
  );
}
