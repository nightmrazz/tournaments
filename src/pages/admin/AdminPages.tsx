import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, FlaskConical, Pause, Play, Plus, ShieldAlert, Trash2, Trophy } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { nameMap } from '@/components/matches/MatchCard';
import { PageContainer } from '@/components/layout/AppShell';
import { StageProgress, StatusBadge } from '@/components/tournament/TournamentBits';
import { MatchesView, PlayoffsView } from '@/components/tournament/Views';
import { TabPanel, Tabs, useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, EmptyState, Skeleton, Spinner } from '@/components/ui/primitives';
import { service } from '@/data';
import { allowedTransitions, FORMAT_LABEL, knockoutComplete, podium, stageProgress } from '@/engine';
import { ParticipantManager } from '@/features/admin/ParticipantManager';
import { StageControl } from '@/features/admin/StageControl';
import { useAuth } from '@/features/auth/AuthProvider';
import { MatchEditorDialog } from '@/features/matches/MatchEditorDialog';
import { keys, useBundle, useInvalidateTournament, useManagedTournaments, useTournamentActions } from '@/features/tournaments/queries';
import { TournamentForm } from '@/features/tournaments/TournamentForm';
import { t } from '@/i18n';
import { errorMessage, formatDate } from '@/lib/utils';
import { DEFAULT_SETTINGS, type Match, type TournamentStatus } from '@/types/domain';

/** Client-side gate for a friendly UX. Real enforcement is RLS + SQL functions on the server. */
export function RequireOrganizer({ children }: { children: ReactNode }) {
  const { user, loading, isOrganizer } = useAuth();
  const location = useLocation();
  if (loading) return <PageContainer><Spinner label={t('Checking access')} /></PageContainer>;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (!isOrganizer) {
    return (
      <PageContainer className="max-w-xl">
        <EmptyState icon={<ShieldAlert className="h-8 w-8" />} title={t('Organizer access required')}
          description={t('Your account can register for tournaments but cannot create them. Ask a platform administrator to grant you the organizer role.')} />
      </PageContainer>
    );
  }
  return <>{children}</>;
}

async function createDemoTournament() {
  const tour = await service.createTournament({
    name: t('Demo Campus Cup (sample data)'),
    description: t('Demonstration tournament with fictional players, created from the organizer dashboard. Delete it at any time.'),
    rules: t('6-minute halves, Legendary difficulty, any club. Bring your own controller.'),
    venue: t('Demo venue'),
    startsAt: new Date(Date.now() + 3 * 86400000).toISOString(),
    registrationDeadline: null,
    format: 'groups_knockout',
    maxParticipants: 16,
    settings: { ...DEFAULT_SETTINGS, drawSeed: 2027 },
  });
  for (let i = 1; i <= 16; i++) {
    await service.addParticipant(tour.id, { displayName: t('Demo Player {n}', { n: i }), contact: null, seed: i <= 4 ? i : null });
  }
  await service.setStatus(tour.id, 'registration_closed');
  return tour;
}

export function AdminDashboardPage() {
  const { user } = useAuth();
  const { data, isLoading, error, refetch } = useManagedTournaments(user?.id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [demoBusy, setDemoBusy] = useState(false);

  const demo = async () => {
    setDemoBusy(true);
    try {
      const tour = await createDemoTournament();
      await qc.invalidateQueries();
      toast('success', t('Demo tournament created with 16 fictional players.'));
      navigate(`/admin/tournaments/${tour.id}`);
    } catch (e) { toast('error', errorMessage(e)); }
    finally { setDemoBusy(false); }
  };

  const newButton = <Link to="/admin/tournaments/new"><Button variant="primary"><Plus className="h-4 w-4" />{t('New tournament')}</Button></Link>;

  return (
    <PageContainer className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{t('Organizer')}</h1>
          <p className="mt-1 text-muted">{t('Tournaments you own or manage, including unpublished drafts.')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {service.mode === 'local' && <Button onClick={demo} loading={demoBusy}><FlaskConical className="h-4 w-4" />{t('Create demo tournament')}</Button>}
          {newButton}
        </div>
      </div>
      {error ? <Alert tone="danger" title={t('Could not load your tournaments')} action={<Button size="sm" onClick={() => refetch()}>{t('Retry')}</Button>}>{errorMessage(error)}</Alert>
        : isLoading ? <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
        : !data?.length ? <EmptyState icon={<Trophy className="h-8 w-8" />} title={t('You have no tournaments yet')} description={t('Create one to configure the format, open registration and run the draw.')} action={newButton} />
        : (
          <Card className="divide-y divide-line">
            {data.map((x) => (
              <Link key={x.id} to={`/admin/tournaments/${x.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-surface-2 sm:px-5">
                <div className="min-w-0">
                  <p className="truncate font-medium">{x.name}</p>
                  <p className="text-xs text-muted">{t(FORMAT_LABEL[x.format])} · {formatDate(x.startsAt)} · <span className="tabular">{t('{count}/{max} players', { count: x.participantCount, max: x.maxParticipants })}</span></p>
                </div>
                <StatusBadge status={x.status} />
              </Link>
            ))}
          </Card>
        )}
    </PageContainer>
  );
}

export function AdminNewTournamentPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  return (
    <PageContainer className="max-w-3xl space-y-6">
      <Link to="/admin" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" />{t('Organizer')}</Link>
      <div>
        <h1 className="text-3xl font-bold">{t('New tournament')}</h1>
        <p className="mt-1 text-muted">{t('It is saved as a private draft. Publish it when you are ready to open registration.')}</p>
      </div>
      <TournamentForm submitLabel={t('Create draft')} onSubmit={async (input) => {
        const tour = await service.createTournament(input);
        await qc.invalidateQueries({ queryKey: keys.list });
        toast('success', t('Draft created.'));
        navigate(`/admin/tournaments/${tour.id}`);
      }} />
    </PageContainer>
  );
}

const STATUS_ACTIONS: Record<TournamentStatus, { label: string; variant: 'primary' | 'secondary' | 'danger'; confirm?: string }> = {
  registration_open: { label: 'Open registration', variant: 'primary' },
  registration_closed: { label: 'Close registration', variant: 'secondary' },
  draft: { label: 'Unpublish (back to draft)', variant: 'secondary', confirm: 'The tournament will be hidden from the public until you publish it again.' },
  in_progress: { label: 'Reopen for corrections', variant: 'secondary', confirm: 'The tournament returns to "In progress" so results can be corrected. Mark it completed again afterwards.' },
  completed: { label: 'Mark completed', variant: 'primary', confirm: 'The tournament will be locked and the champion shown as final.' },
  cancelled: { label: 'Cancel tournament', variant: 'danger', confirm: 'Players will see the tournament as cancelled. This cannot be undone.' },
};

export function AdminTournamentPage() {
  const { id = '' } = useParams();
  const { data: b, isLoading, error, refetch } = useBundle(id);
  const { canManage } = useAuth();
  const actions = useTournamentActions(id);
  const invalidate = useInvalidateTournament(id);
  const confirm = useConfirm();
  const toast = useToast();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<Match | null>(null);
  const tab = params.get('tab') ?? 'control';
  const setTab = (v: string) => setParams({ tab: v }, { replace: true });

  if (isLoading) return <PageContainer className="space-y-3"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-64" /></PageContainer>;
  if (error || !b) return <PageContainer><Alert tone="danger" title={t('Tournament unavailable')} action={<Button size="sm" onClick={() => refetch()}>{t('Retry')}</Button>}>{errorMessage(error)}</Alert></PageContainer>;
  const tour = b.tournament;
  if (!canManage(tour)) return <PageContainer><EmptyState icon={<ShieldAlert className="h-8 w-8" />} title={t('You cannot manage this tournament')} description={t('Only its organizers can change it.')} /></PageContainer>;

  const names = nameMap(b.participants);
  const transitions = allowedTransitions(tour.status).filter((s) => !(s === 'completed' && !(podium(b).champion && knockoutComplete(b))));
  const canEditMatches = tour.status === 'in_progress';

  const actionLabel = (s: TournamentStatus) =>
    tour.status === 'draft' && s === 'registration_open' ? t('Publish & open registration')
      : tour.status === 'draft' && s === 'registration_closed' ? t('Publish (registration closed)')
      : tour.status === 'registration_closed' && s === 'registration_open' ? t('Reopen registration')
      : t(STATUS_ACTIONS[s].label);

  const changeStatus = async (to: TournamentStatus) => {
    const a = STATUS_ACTIONS[to];
    const label = t(a.label);
    if (a.confirm && !(await confirm({ title: `${label}?`, body: t(a.confirm), confirmLabel: label, destructive: to === 'cancelled' }))) return;
    try { await actions.setStatus.mutateAsync(to); toast('success', t('Status changed: {status}.', { status: actionLabel(to).toLowerCase() })); }
    catch (e) { toast('error', errorMessage(e)); }
  };

  const paused = tour.settings.registrationPaused;
  const togglePause = async () => {
    try {
      await service.updateTournament(tour.id, { settings: { ...tour.settings, registrationPaused: !paused } });
      await invalidate();
      toast(paused ? 'success' : 'warning', paused ? t('Registration resumed.') : t('Registration paused. Existing registrations are kept.'));
    } catch (e) { toast('error', errorMessage(e)); }
  };

  const remove = async () => {
    if (!(await confirm({ title: t('Delete this tournament?'), body: t('"{name}" and all its participants, fixtures and results will be permanently deleted.', { name: tour.name }), confirmLabel: t('Delete permanently'), destructive: true }))) return;
    try { await service.deleteTournament(tour.id); await qc.invalidateQueries(); toast('success', t('Tournament deleted.')); navigate('/admin'); }
    catch (e) { toast('error', errorMessage(e)); }
  };

  const tabs = [
    { id: 'control', label: t('Stage control') },
    { id: 'participants', label: t('Participants'), count: b.participants.length },
    { id: 'matches', label: t('Matches'), count: b.matches.length || undefined },
    { id: 'bracket', label: t('Bracket') },
    { id: 'settings', label: t('Settings') },
  ];
  const champion = podium(b).champion;

  return (
    <PageContainer className="space-y-5">
      <Link to="/admin" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-accent"><ArrowLeft className="h-4 w-4" />{t('Organizer')}</Link>
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2"><StatusBadge status={tour.status} /><span className="text-sm text-muted">{t(FORMAT_LABEL[tour.format])}</span></div>
            <h1 className="mt-2 break-words text-2xl font-bold sm:text-3xl">{tour.name}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            {tour.status !== 'draft' && <Link to={`/tournaments/${tour.id}`}><Button variant="ghost"><ExternalLink className="h-4 w-4" />{t('Public page')}</Button></Link>}
            {tour.status === 'registration_open' && (
              <Button variant="secondary" onClick={togglePause}>
                {paused ? <Play className="h-4 w-4" aria-hidden /> : <Pause className="h-4 w-4" aria-hidden />}
                {paused ? t('Resume registration') : t('Pause registration')}
              </Button>
            )}
            {transitions.map((s) => (
              <Button key={s} variant={STATUS_ACTIONS[s].variant} onClick={() => changeStatus(s)} loading={actions.setStatus.isPending && actions.setStatus.variables === s}>
                {actionLabel(s)}
              </Button>
            ))}
            <Button variant="ghost" size="icon" onClick={remove} aria-label={t('Delete tournament')}><Trash2 className="h-4 w-4" /></Button>
          </div>
        </div>
        {tour.status === 'registration_open' && paused && <Alert tone="warning" title={t('Registration is paused.')}>{t('New players cannot register until you resume. Existing registrations, receipts and the waitlist are kept.')}</Alert>}
        {tour.status === 'draft' && <Alert tone="info" title={t('Draft — only organizers can see this tournament.')}>{t('Publish it to make the public page visible and, optionally, open registration.')}</Alert>}
        {tour.status === 'in_progress' && knockoutComplete(b) && champion && (
          <Alert tone="success" title={t('{name} won the final.', { name: names.get(champion)?.displayName ?? '' })}>{t('Mark the tournament completed to lock the results.')}</Alert>
        )}
        <StageProgress steps={stageProgress(b)} />
      </header>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t('Management sections')} />
      <TabPanel id={tab}>
        {tab === 'control' && <StageControl b={b} />}
        {tab === 'participants' && <ParticipantManager b={b} />}
        {tab === 'matches' && (
          <div className="space-y-3">
            {!canEditMatches && b.matches.length > 0 && (
              <Alert tone="info" title={t('Results are read-only')}>{tour.status === 'completed' ? t('Reopen the tournament to correct results.') : t('Matches can only be edited while the tournament is in progress.')}</Alert>
            )}
            <MatchesView b={b} onEdit={canEditMatches ? setEditing : undefined} />
          </div>
        )}
        {tab === 'bracket' && <PlayoffsView b={b} onEdit={canEditMatches ? setEditing : undefined} />}
        {tab === 'settings' && (
          <div className="max-w-3xl">
            <TournamentForm key={tour.updatedAt} initial={tour} locked={b.matches.length > 0} submitLabel={t('Save changes')} onSubmit={async (input) => {
              await service.updateTournament(tour.id, input);
              await invalidate();
              toast('success', t('Settings saved.'));
            }} />
          </div>
        )}
      </TabPanel>
      <MatchEditorDialog tournamentId={tour.id} match={editing} names={names} onClose={() => setEditing(null)} />
    </PageContainer>
  );
}
