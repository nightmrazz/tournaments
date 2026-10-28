import { Crown, Medal, Trophy } from 'lucide-react';
import type { NameMap } from '@/components/matches/MatchCard';
import type { KnockoutRound, Podium } from '@/engine';
import { t, tr } from '@/i18n';
import { cn } from '@/lib/utils';
import type { Match } from '@/types/domain';

function BracketSlot({ id, score, pens, won, names, lost }: { id: string | null; score: number | null; pens: number | null; won: boolean; lost: boolean; names: NameMap }) {
  const p = id ? names.get(id) : null;
  const label = p ? (p.team ? `${p.displayName} — ${p.team}` : p.displayName) : undefined;
  return (
    <div className={cn('flex h-9 items-center justify-between gap-2 px-2.5', won && 'bg-accent/8')} title={label}>
      <span className={cn('truncate text-sm', !p && 'italic text-subtle', won && 'font-semibold text-fg', lost && 'text-muted')}>{p?.displayName ?? t('TBD')}</span>
      <span className={cn('shrink-0 font-mono text-sm tabular', won ? 'text-accent' : 'text-muted')}>
        {score ?? ''}{pens !== null && <sup className="ml-0.5 text-[10px]">({pens})</sup>}
      </span>
    </div>
  );
}

function BracketMatch({ m, names, onEdit }: { m: Match; names: NameMap; onEdit?: (m: Match) => void }) {
  const done = m.status === 'completed';
  const body = (
    <>
      <BracketSlot id={m.homeId} score={m.homeScore} pens={m.homePens} names={names} won={done && m.winnerId === m.homeId} lost={done && m.winnerId !== m.homeId} />
      <div className="h-px bg-line" />
      <BracketSlot id={m.awayId} score={m.awayScore} pens={m.awayPens} names={names} won={done && m.winnerId === m.awayId} lost={done && m.winnerId !== m.awayId} />
    </>
  );
  const cls = cn('block w-full overflow-hidden rounded-[var(--radius-control)] border bg-surface text-left', m.status === 'in_progress' ? 'border-info/50' : 'border-line');
  if (onEdit && m.homeId && m.awayId) {
    return <button className={cn(cls, 'hover:border-accent/50')} onClick={() => onEdit(m)} aria-label={t('Edit {home} versus {away}', { home: names.get(m.homeId)?.displayName ?? '', away: names.get(m.awayId)?.displayName ?? '' })}>{body}</button>;
  }
  return <div className={cls}>{body}</div>;
}

/** Horizontal bracket: one column per round; the third-place match sits under the final. */
export function Bracket({ rounds, names, onEdit }: { rounds: KnockoutRound[]; names: NameMap; onEdit?: (m: Match) => void }) {
  const main = rounds.filter((r) => !r.matches[0]?.isThirdPlace);
  const third = rounds.find((r) => r.matches[0]?.isThirdPlace);
  return (
    <div className="relative -mx-4 overflow-x-auto px-4 pb-2" role="region" aria-label={t('Knockout bracket')} tabIndex={0}>
      <div className="flex min-w-max gap-6">
        {main.map((r, ri) => (
          <section key={r.round} className="flex w-56 flex-col" aria-label={tr(r.name)}>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{tr(r.name)}</h3>
            <div className="flex flex-1 flex-col justify-around gap-4">
              {r.matches.map((m) => <BracketMatch key={m.id} m={m} names={names} onEdit={onEdit} />)}
              {ri === main.length - 1 && third && (
                <div className="mt-6">
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">{tr(third.name)}</h3>
                  <BracketMatch m={third.matches[0]} names={names} onEdit={onEdit} />
                </div>
              )}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

export function ChampionBanner({ podium, names }: { podium: Podium; names: NameMap }) {
  if (!podium.champion) return null;
  const c = names.get(podium.champion);
  return (
    <div className="relative overflow-hidden rounded-[var(--radius-card)] border border-accent/50 bg-gradient-to-br from-accent/18 via-surface to-neon/8 glow p-5 sm:p-6" data-testid="champion-banner">
      <Trophy className="absolute -right-4 -top-4 h-32 w-32 text-accent/8" aria-hidden />
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent text-glow"><Crown className="h-4 w-4" aria-hidden />{t('Champion')}</p>
      <p className="mt-2 font-display text-3xl font-bold sm:text-4xl">{c?.displayName}</p>
      {c?.team && <p className="text-sm text-muted">{c.team}</p>}
      <dl className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        {podium.runnerUp && <div className="flex items-center gap-1.5"><Medal className="h-4 w-4 text-muted" aria-hidden /><dt className="text-muted">{t('Runner-up')}</dt><dd className="font-medium">{names.get(podium.runnerUp)?.displayName}</dd></div>}
        {podium.third && <div className="flex items-center gap-1.5"><Medal className="h-4 w-4 text-warning/80" aria-hidden /><dt className="text-muted">{t('Third')}</dt><dd className="font-medium">{names.get(podium.third)?.displayName}</dd></div>}
      </dl>
    </div>
  );
}
