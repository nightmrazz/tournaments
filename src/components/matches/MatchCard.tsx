import { Clock, Monitor, Pencil, Shield } from 'lucide-react';
import { Badge } from '@/components/ui/primitives';
import { t } from '@/i18n';
import { cn, formatDateTime } from '@/lib/utils';
import type { Match, MatchStatus, Participant } from '@/types/domain';

export type NameMap = Map<string, Participant>;
export const nameMap = (ps: Participant[]): NameMap => new Map(ps.map((p) => [p.id, p]));

const STATUS: Record<MatchStatus, { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }> = {
  scheduled: { label: 'Scheduled', tone: 'neutral' },
  in_progress: { label: 'Live', tone: 'info' },
  completed: { label: 'Final', tone: 'success' },
  postponed: { label: 'Postponed', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'danger' },
};

export function MatchStatusBadge({ status, walkover }: { status: MatchStatus; walkover?: boolean }) {
  const s = STATUS[status];
  return <Badge tone={s.tone} dot={status === 'in_progress'}>{walkover ? t('Walkover') : t(s.label)}</Badge>;
}

/** Small "club" line under a player's name. */
export function TeamLine({ team, className }: { team: string | null | undefined; className?: string }) {
  if (!team) return null;
  return (
    <p className={cn('flex min-w-0 items-center gap-1 text-xs text-subtle', className)}>
      <Shield className="h-3 w-3 shrink-0" aria-hidden /><span className="sr-only">{t('Team')}:</span><span className="truncate">{team}</span>
    </p>
  );
}

function Side({ id, names, align, won }: { id: string | null; names: NameMap; align: 'left' | 'right'; won: boolean }) {
  const p = id ? names.get(id) : null;
  return (
    <div className={cn('min-w-0 flex-1', align === 'right' && 'text-right')}>
      <p className={cn('truncate text-sm font-medium', !p && 'italic text-subtle', won && 'text-accent')}>{p?.displayName ?? t('To be decided')}</p>
      <TeamLine team={p?.team} className={align === 'right' ? 'justify-end' : undefined} />
    </div>
  );
}

export function Score({ m }: { m: Match }) {
  const has = m.homeScore !== null && m.awayScore !== null;
  return (
    <div className="flex w-20 shrink-0 flex-col items-center">
      <div className={cn(
        'flex h-9 min-w-16 items-center justify-center gap-1.5 rounded-md px-2 font-mono text-base font-semibold tabular',
        has ? 'bg-surface-3' : 'border border-dashed border-line text-subtle',
        m.status === 'in_progress' && 'text-info',
      )} aria-label={has ? t('Score {home} to {away}', { home: m.homeScore ?? 0, away: m.awayScore ?? 0 }) : t('No score yet')}>
        {has ? <>{m.homeScore}<span className="text-subtle">:</span>{m.awayScore}</> : t('vs')}
      </div>
      {m.homePens !== null && m.awayPens !== null && (
        <span className="mt-0.5 text-[11px] tabular text-muted">{t('pens {home}–{away}', { home: m.homePens, away: m.awayPens })}</span>
      )}
    </div>
  );
}

export function MatchCard({ m, names, label, onEdit }: { m: Match; names: NameMap; label?: string; onEdit?: (m: Match) => void }) {
  const homeWon = m.status === 'completed' && !!m.winnerId && m.winnerId === m.homeId;
  const awayWon = m.status === 'completed' && !!m.winnerId && m.winnerId === m.awayId;
  const tbd = t('TBD');
  return (
    <div className={cn('rounded-[var(--radius-control)] border border-line bg-surface px-3 py-2.5', m.status === 'cancelled' && 'opacity-60')} data-testid="match-card">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-subtle">
        <span className="flex items-center gap-3">
          {label && <span className="font-medium text-muted">{label}</span>}
          {m.station && <span className="flex items-center gap-1"><Monitor className="h-3.5 w-3.5" aria-hidden />{m.station}</span>}
          {m.scheduledAt && <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" aria-hidden />{formatDateTime(m.scheduledAt)}</span>}
        </span>
        <span className="flex items-center gap-2">
          <MatchStatusBadge status={m.status} walkover={m.walkover} />
          {onEdit && (
            <button
              onClick={() => onEdit(m)}
              disabled={!m.homeId || !m.awayId}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-line px-2 text-xs font-medium text-muted hover:border-accent/50 hover:text-accent disabled:opacity-40"
              aria-label={t('Edit match {home} versus {away}', { home: names.get(m.homeId ?? '')?.displayName ?? tbd, away: names.get(m.awayId ?? '')?.displayName ?? tbd })}
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />{t('Edit')}
            </button>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Side id={m.homeId} names={names} align="left" won={homeWon} />
        <Score m={m} />
        <Side id={m.awayId} names={names} align="right" won={awayWon} />
      </div>
    </div>
  );
}
