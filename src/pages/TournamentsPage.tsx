import { Search, Trophy } from 'lucide-react';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageContainer } from '@/components/layout/AppShell';
import { TournamentCard, TournamentCardSkeleton } from '@/components/tournament/TournamentBits';
import { Alert, Button, EmptyState, Input, Select } from '@/components/ui/primitives';
import { FORMAT_LABEL, STATUS_LABEL } from '@/engine';
import { useTournaments } from '@/features/tournaments/queries';
import { t } from '@/i18n';
import { errorMessage } from '@/lib/utils';
import { TOURNAMENT_FORMATS, TOURNAMENT_STATUSES } from '@/types/domain';

export function TournamentsPage() {
  const { data, isLoading, error, refetch } = useTournaments();
  // Filters live in the URL so they survive reloads and can be shared.
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? 'all';
  const format = params.get('format') ?? 'all';
  const sort = params.get('sort') ?? 'soonest';
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (!v || v === 'all' || (k === 'sort' && v === 'soonest')) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };

  const items = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data ?? [])
      .filter((x) => (status === 'all' ? x.status !== 'draft' : x.status === status))
      .filter((x) => format === 'all' || x.format === format)
      .filter((x) => !term || x.name.toLowerCase().includes(term) || x.venue.toLowerCase().includes(term))
      .sort((a, b) => {
        const da = a.startsAt ?? a.createdAt;
        const db = b.startsAt ?? b.createdAt;
        return sort === 'latest' ? db.localeCompare(da) : da.localeCompare(db);
      });
  }, [data, q, status, format, sort]);

  return (
    <PageContainer className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">{t('Tournaments')}</h1>
        <p className="mt-1 text-muted">{t('Find an event to join or follow live.')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-[1fr_auto_auto_auto]" role="search">
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input aria-label={t('Search tournaments')} placeholder={t('Search by name or venue')} value={q} onChange={(e) => set('q', e.target.value)} className="pl-9" />
        </div>
        <Select aria-label={t('Filter by status')} value={status} onChange={(e) => set('status', e.target.value)}>
          <option value="all">{t('All statuses')}</option>
          {TOURNAMENT_STATUSES.filter((s) => s !== 'draft').map((s) => <option key={s} value={s}>{t(STATUS_LABEL[s])}</option>)}
        </Select>
        <Select aria-label={t('Filter by format')} value={format} onChange={(e) => set('format', e.target.value)}>
          <option value="all">{t('All formats')}</option>
          {TOURNAMENT_FORMATS.map((f) => <option key={f} value={f}>{t(FORMAT_LABEL[f])}</option>)}
        </Select>
        <Select aria-label={t('Sort by date')} value={sort} onChange={(e) => set('sort', e.target.value)}>
          <option value="soonest">{t('Date: earliest first')}</option>
          <option value="latest">{t('Date: latest first')}</option>
        </Select>
      </div>
      {error ? (
        <Alert tone="danger" title={t('Could not load tournaments')} action={<Button size="sm" onClick={() => refetch()}>{t('Retry')}</Button>}>{errorMessage(error)}</Alert>
      ) : isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Array.from({ length: 6 }, (_, i) => <TournamentCardSkeleton key={i} />)}</div>
      ) : items.length ? (
        <>
          <p className="text-sm text-muted" aria-live="polite">{t('Tournaments found: {n}', { n: items.length })}</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{items.map((x) => <TournamentCard key={x.id} t={x} />)}</div>
        </>
      ) : (
        <EmptyState
          icon={<Trophy className="h-8 w-8" />}
          title={data?.length ? t('No tournaments match your filters') : t('No tournaments yet')}
          description={data?.length ? t('Try a different search or clear the filters.') : t('Published tournaments will appear here.')}
          action={data?.length ? <Button onClick={() => setParams({}, { replace: true })}>{t('Clear filters')}</Button> : undefined}
        />
      )}
    </PageContainer>
  );
}
