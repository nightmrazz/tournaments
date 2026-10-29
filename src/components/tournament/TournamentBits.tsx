import { CalendarDays, ChevronRight, MapPin, Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge, Card, Skeleton } from '@/components/ui/primitives';
import type { TournamentSummary } from '@/data';
import { FORMAT_LABEL, STATUS_LABEL, type StageStep } from '@/engine';
import { t, tr } from '@/i18n';
import { cn, formatDate, formatTime } from '@/lib/utils';
import type { TournamentStatus } from '@/types/domain';

const statusTone: Record<TournamentStatus, 'neutral' | 'accent' | 'info' | 'warning' | 'danger' | 'success'> = {
  draft: 'neutral',
  registration_open: 'accent',
  registration_closed: 'warning',
  in_progress: 'info',
  completed: 'success',
  cancelled: 'danger',
};

export function StatusBadge({ status }: { status: TournamentStatus }) {
  return <Badge tone={statusTone[status]} dot={status === 'in_progress' || status === 'registration_open'}>{t(STATUS_LABEL[status])}</Badge>;
}

export function TournamentCard({ t: tour }: { t: TournamentSummary }) {
  const fill = Math.min(100, Math.round((tour.participantCount / tour.maxParticipants) * 100));
  return (
    <Link to={`/tournaments/${tour.id}`} className="group block rounded-[var(--radius-card)] focus-visible:outline-offset-4">
      <Card className="flex h-full flex-col p-4 transition-colors duration-150 group-hover:border-line-strong group-hover:bg-surface-2">
        <div className="flex items-start justify-between gap-3">
          <StatusBadge status={tour.status} />
          <span className="text-xs text-subtle">{t(FORMAT_LABEL[tour.format])}</span>
        </div>
        <h3 className="mt-3 line-clamp-2 text-lg font-semibold leading-snug group-hover:text-accent">{tour.name}</h3>
        <dl className="mt-3 space-y-1.5 text-sm text-muted">
          <div className="flex items-center gap-2"><CalendarDays className="h-4 w-4 shrink-0" aria-hidden /><dt className="sr-only">{t('Date')}</dt><dd>{formatDate(tour.startsAt)}{tour.startsAt && ` · ${formatTime(tour.startsAt)}`}</dd></div>
          {tour.venue && <div className="flex items-center gap-2"><MapPin className="h-4 w-4 shrink-0" aria-hidden /><dt className="sr-only">{t('Venue')}</dt><dd className="truncate">{tour.venue}</dd></div>}
        </dl>
        <div className="mt-auto pt-4">
          <div className="flex items-center justify-between text-xs text-muted">
            <span className="flex items-center gap-1.5"><Users className="h-3.5 w-3.5" aria-hidden /><span className="tabular">{t('{count}/{max} players', { count: tour.participantCount, max: tour.maxParticipants })}</span></span>
            <ChevronRight className="h-4 w-4 text-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-accent" aria-hidden />
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={fill} aria-valuemin={0} aria-valuemax={100} aria-label={t('Slots filled')}>
            <div className="h-full rounded-full bg-accent/70" style={{ width: `${fill}%` }} />
          </div>
        </div>
      </Card>
    </Link>
  );
}

export function TournamentCardSkeleton() {
  return (
    <Card className="p-4">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="mt-4 h-6 w-3/4" />
      <Skeleton className="mt-3 h-4 w-1/2" />
      <Skeleton className="mt-6 h-1 w-full" />
    </Card>
  );
}

export function StageProgress({ steps }: { steps: StageStep[] }) {
  return (
    <ol className="relative -mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:thin] sm:mx-0 sm:grid sm:grid-cols-3 sm:px-0 lg:grid-cols-4 xl:grid-cols-7" aria-label={t('Tournament progress')}>
      {steps.map((s, i) => (
        <li
          key={s.key}
          aria-current={s.state === 'current' ? 'step' : undefined}
          className={cn(
            'relative flex min-w-40 shrink-0 items-center gap-3 rounded-[var(--radius-control)] border px-3 py-2.5 sm:min-w-0',
            s.state === 'done' && 'border-line bg-surface',
            s.state === 'current' && 'border-accent/50 bg-surface-2',
            s.state === 'upcoming' && 'border-line border-dashed',
          )}
        >
          <span className={cn(
            'grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular',
            s.state === 'done' && 'bg-accent text-accent-ink',
            s.state === 'current' && 'border border-accent text-accent',
            s.state === 'upcoming' && 'border border-line-strong text-subtle',
          )}>
            {s.state === 'done' ? <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" /></svg> : i + 1}
          </span>
          <span className="min-w-0">
            <span className={cn('block truncate text-sm font-medium', s.state === 'upcoming' && 'text-muted')}>{tr(s.label)}</span>
            {s.detail && <span className="block text-xs tabular text-subtle">{s.detail}</span>}
            <span className="sr-only">{s.state === 'done' ? t('(completed)') : s.state === 'current' ? t('(current stage)') : t('(upcoming)')}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
