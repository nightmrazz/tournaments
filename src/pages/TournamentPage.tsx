import { ArrowLeft, CalendarDays, Clock, Layers, MapPin, Monitor, Settings2, Users, Wallet } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChampionBanner } from '@/components/bracket/Bracket';
import { nameMap } from '@/components/matches/MatchCard';
import { PageContainer } from '@/components/layout/AppShell';
import { StageProgress, StatusBadge } from '@/components/tournament/TournamentBits';
import { MatchesView, NextMatches, ParticipantsView, PlayoffsView, StandingsView } from '@/components/tournament/Views';
import { TabPanel, Tabs, type TabDef } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader, Skeleton } from '@/components/ui/primitives';
import { capacityOf, confirmedParticipants, FORMAT_LABEL, podium, registrationState, stageProgress } from '@/engine';
import { useAuth } from '@/features/auth/AuthProvider';
import { RegisterForm } from '@/features/participants/RegisterForm';
import { useBundle } from '@/features/tournaments/queries';
import { t, tr } from '@/i18n';
import { errorMessage, formatDate, formatDateTime, formatTime } from '@/lib/utils';
import type { TournamentBundle } from '@/types/domain';

export function tournamentTabs(b: TournamentBundle): TabDef[] {
  const tabs: TabDef[] = [
    { id: 'overview', label: t('Overview') },
    { id: 'participants', label: t('Participants'), count: confirmedParticipants(b).length },
  ];
  if (b.tournament.format === 'groups_knockout') tabs.push({ id: 'standings', label: t('Standings') });
  tabs.push({ id: 'matches', label: t('Matches'), count: b.matches.length || undefined });
  tabs.push({ id: 'playoffs', label: t('Playoffs') });
  return tabs;
}

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 text-subtle" aria-hidden>{icon}</span>
      <div><dt className="text-xs text-subtle">{label}</dt><dd className="text-sm font-medium">{children}</dd></div>
    </div>
  );
}

function Overview({ b }: { b: TournamentBundle }) {
  const tour = b.tournament;
  const s = tour.settings;
  const names = nameMap(b.participants);
  const counts = capacityOf(b);
  const confirmedCount = counts.confirmed;
  const free = Math.max(0, tour.maxParticipants - counts.holding);
  const reg = registrationState(tour, counts.holding);
  // Until the draw, the registration card also shows a player's own application and its payment status.
  const showRegistration = tour.status === 'registration_open' || tour.status === 'draft' || (tour.status === 'registration_closed' && !b.matches.length);
  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="min-w-0 space-y-5">
        <ChampionBanner podium={podium(b)} names={names} />
        {tour.status === 'cancelled' && <Alert tone="danger" title={t('This tournament has been cancelled.')} />}
        <StageProgress steps={stageProgress(b)} />
        <NextMatches b={b} />
        {showRegistration && (
          <Card>
            <CardHeader title={t('Register')} description={reg.open ? t('Enter your details to take a place in the draw.') : undefined} />
            <div className="p-4 sm:p-5"><RegisterForm b={b} /></div>
          </Card>
        )}
        {tour.description && (
          <Card><CardHeader title={t('About')} /><p className="whitespace-pre-line p-4 text-sm leading-relaxed text-muted sm:p-5">{tour.description}</p></Card>
        )}
        <Card>
          <CardHeader title={t('Rules')} />
          <div className="space-y-3 p-4 text-sm text-muted sm:p-5">
            {tour.rules && <p className="whitespace-pre-line leading-relaxed">{tour.rules}</p>}
            <ul className="list-inside list-disc space-y-1">
              {tour.format === 'groups_knockout' && (
                <li>{s.doubleRoundRobin
                  ? t('{groups} groups, double round robin; top {n} per group advance.', { groups: s.groupCount, n: s.advancePerGroup })
                  : t('{groups} groups, single round robin; top {n} per group advance.', { groups: s.groupCount, n: s.advancePerGroup })}</li>
              )}
              {tour.format === 'groups_knockout' && <li>{t('Points: win {w}, draw {d}, loss {l}.', { w: s.pointsWin, d: s.pointsDraw, l: s.pointsLoss })}</li>}
              <li>{t('Knockout matches level at full time are decided by penalties.')}</li>
              {s.thirdPlaceMatch && <li>{t('A third-place match is played.')}</li>}
              <li>{t('A walkover counts as a {n}–0 win.', { n: s.walkoverGoals })}</li>
            </ul>
            {s.cancellationPolicy && (
              <div>
                <p className="font-medium text-fg">{t('Cancellation and refund policy')}</p>
                <p className="whitespace-pre-line">{s.cancellationPolicy}</p>
              </div>
            )}
          </div>
        </Card>
      </div>
      <aside className="space-y-4">
        <Card className="p-4">
          <dl className="space-y-4">
            <Fact icon={<CalendarDays className="h-4 w-4" />} label={t('Starts')}>{tour.startsAt ? `${formatDate(tour.startsAt)} · ${formatTime(tour.startsAt)}` : t('To be announced')}</Fact>
            {tour.venue && <Fact icon={<MapPin className="h-4 w-4" />} label={t('Venue')}>{tour.venue}</Fact>}
            <Fact icon={<Layers className="h-4 w-4" />} label={t('Format')}>{t(FORMAT_LABEL[tour.format])}</Fact>
            <Fact icon={<Users className="h-4 w-4" />} label={t('Players')}>
              <span className="tabular" data-testid="player-count">{t('{n} confirmed of {max}', { n: confirmedCount, max: tour.maxParticipants })}</span>
              {!b.matches.length && tour.status !== 'cancelled' && (
                <span className="block text-xs font-normal text-subtle tabular">
                  {t('Free places: {n}', { n: free })}
                  {counts.waitlisted > 0 && ' · ' + t('waitlist: {n}', { n: counts.waitlisted })}
                  {s.minParticipants > 0 && ' · ' + t('min. {n}', { n: s.minParticipants })}
                </span>
              )}
            </Fact>
            {s.requirePayment && s.entryFee && <Fact icon={<Wallet className="h-4 w-4" />} label={t('Entry fee')}>{s.entryFee}</Fact>}
            <Fact icon={<Clock className="h-4 w-4" />} label={t('Registration')}>
              {reg.open
                ? reg.waitlistOnly ? t('Waitlist only — all places are taken')
                  : reg.late ? t('Late registration')
                  : tour.registrationDeadline ? t('Open until {date}', { date: formatDateTime(tour.registrationDeadline) }) : t('Open')
                : tr(reg.reason ?? '').replace(/\.$/, '')}
            </Fact>
            {s.stations > 0 && <Fact icon={<Monitor className="h-4 w-4" />} label={t('Consoles')}>{t('Stations: {n}', { n: s.stations })}</Fact>}
          </dl>
        </Card>
      </aside>
    </div>
  );
}

export function TournamentPage() {
  const { id = '' } = useParams();
  const { data: b, isLoading, error, refetch } = useBundle(id, { poll: true });
  const { canManage } = useAuth();
  const [params, setParams] = useSearchParams();
  const [tabState, setTabState] = useState(params.get('tab') ?? 'overview');

  if (isLoading) {
    return (
      <PageContainer className="space-y-4">
        <Skeleton className="h-5 w-32" /><Skeleton className="h-10 w-2/3" /><Skeleton className="h-11 w-full" />
        <div className="grid gap-3 sm:grid-cols-3"><Skeleton className="h-24" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div>
      </PageContainer>
    );
  }
  if (error || !b) {
    return (
      <PageContainer>
        <Alert tone="danger" title={t('Tournament unavailable')} action={<Button size="sm" onClick={() => refetch()}>{t('Retry')}</Button>}>{errorMessage(error)}</Alert>
        <Link to="/tournaments" className="mt-4 inline-flex items-center gap-2 text-sm text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" />{t('All tournaments')}</Link>
      </PageContainer>
    );
  }
  const tour = b.tournament;
  const tabs = tournamentTabs(b);
  const tab = tabs.some((x) => x.id === tabState) ? tabState : 'overview';
  const setTab = (v: string) => { setTabState(v); const n = new URLSearchParams(params); n.set('tab', v); setParams(n, { replace: true }); };

  return (
    <PageContainer className="space-y-5">
      <Link to="/tournaments" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" aria-hidden />{t('Tournaments')}</Link>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2"><StatusBadge status={tour.status} /><span className="text-sm text-muted">{t(FORMAT_LABEL[tour.format])}</span></div>
          <h1 className="mt-2 break-words text-3xl font-bold sm:text-4xl">{tour.name}</h1>
          <p className="mt-1 text-sm text-muted">{formatDate(tour.startsAt)}{tour.venue && ` · ${tour.venue}`} · <span className="tabular">{t('{count}/{max} players', { count: confirmedParticipants(b).length, max: tour.maxParticipants })}</span></p>
        </div>
        {canManage(tour) && <Link to={`/admin/tournaments/${tour.id}`}><Button variant="outline"><Settings2 className="h-4 w-4" aria-hidden />{t('Manage')}</Button></Link>}
      </header>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t('Tournament sections')} />
      <TabPanel id={tab}>
        {tab === 'overview' && <Overview b={b} />}
        {tab === 'participants' && <ParticipantsView b={b} />}
        {tab === 'standings' && <StandingsView b={b} />}
        {tab === 'matches' && <MatchesView b={b} />}
        {tab === 'playoffs' && <PlayoffsView b={b} />}
      </TabPanel>
    </PageContainer>
  );
}
