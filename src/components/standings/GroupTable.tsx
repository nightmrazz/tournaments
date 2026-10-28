import { AlertTriangle } from 'lucide-react';
import { TeamLine, type NameMap } from '@/components/matches/MatchCard';
import { Badge, Card } from '@/components/ui/primitives';
import type { GroupTable as GroupTableData } from '@/engine';
import { t, tr } from '@/i18n';
import { cn } from '@/lib/utils';

const formColor = { W: 'bg-success/80', D: 'bg-muted/60', L: 'bg-danger/70' };

function Col({ abbr, title, className }: { abbr: string; title: string; className?: string }) {
  return <th scope="col" className={cn('w-9 py-2 text-center font-medium', className)}><abbr title={t(title)}>{t(abbr)}</abbr></th>;
}

export function GroupTable({ table, names, advance }: { table: GroupTableData; names: NameMap; advance: number }) {
  const { standings: s } = table;
  const groupName = tr(table.name);
  const fallbackAtCut = s.complete && s.rows.some((r) => r.decidedByFallback && r.rank <= advance + 1);
  return (
    <Card className="overflow-hidden">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h3 className="font-semibold">{groupName}</h3>
        <span className="text-xs tabular text-muted">{s.complete ? t('Final') : t('{played}/{total} played', { played: s.playedMatches, total: s.totalMatches })}</span>
      </div>
      <div className="relative overflow-x-auto">
        <table className="w-full min-w-[18rem] text-sm">
          <caption className="sr-only">{t('{group} standings. Top {n} qualify.', { group: groupName, n: advance })}</caption>
          <thead>
            <tr className="text-xs text-subtle">
              <th scope="col" className="w-8 py-2 pl-4 text-left font-medium">#</th>
              <th scope="col" className="py-2 text-left font-medium">{t('Player')}</th>
              <Col abbr="P" title="Played" />
              <Col abbr="W" title="Won" />
              <Col abbr="D" title="Drawn" className="hidden sm:table-cell" />
              <Col abbr="L" title="Lost" className="hidden sm:table-cell" />
              <Col abbr="GF" title="Goals for" className="hidden w-10 sm:table-cell" />
              <Col abbr="GA" title="Goals against" className="hidden w-10 sm:table-cell" />
              <Col abbr="GD" title="Goal difference" className="w-10" />
              <Col abbr="Pts" title="Points" className="w-10 font-semibold text-fg" />
              <th scope="col" className="hidden w-24 py-2 pr-4 text-left font-medium md:table-cell">{t('Form')}</th>
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r) => {
              const p = names.get(r.participantId);
              return (
                <tr key={r.participantId} className={cn('border-t border-line', r.rank === advance && 'border-b border-b-accent/30')}>
                  <td className="py-2 pl-4">
                    <span className={cn('grid h-6 w-6 place-items-center rounded text-xs font-semibold tabular', r.inQualifyingZone ? 'bg-accent/15 text-accent' : 'text-muted')}>{r.rank}</span>
                  </td>
                  <td className="max-w-0 py-2 pr-2">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{p?.displayName ?? t('Unknown')}</span>
                      {r.qualification === 'qualified' && <Badge tone="accent" className="hidden px-1.5 py-0 sm:inline-flex" >{t('Q')}</Badge>}
                      {s.complete && r.decidedByFallback && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" aria-label={t('Tied on every criterion; ordered by seed or registration')} />}
                    </div>
                    <TeamLine team={p?.team} />
                  </td>
                  <td className="text-center tabular text-muted">{r.played}</td>
                  <td className="text-center tabular text-muted">{r.won}</td>
                  <td className="hidden text-center tabular text-muted sm:table-cell">{r.drawn}</td>
                  <td className="hidden text-center tabular text-muted sm:table-cell">{r.lost}</td>
                  <td className="hidden text-center tabular text-muted sm:table-cell">{r.goalsFor}</td>
                  <td className="hidden text-center tabular text-muted sm:table-cell">{r.goalsAgainst}</td>
                  <td className="text-center tabular text-muted">{r.goalDiff > 0 ? `+${r.goalDiff}` : r.goalDiff}</td>
                  <td className="text-center font-semibold tabular">{r.points}</td>
                  <td className="hidden py-2 pr-4 md:table-cell">
                    <span className="flex gap-1" aria-label={t('Form: {form}', { form: r.form.slice(-5).map((f) => t(f)).join(' ') || t('none') })}>
                      {r.form.slice(-5).map((f, i) => <span key={i} className={cn('h-2 w-3 rounded-sm', formColor[f])} title={t(f)} />)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {fallbackAtCut && (
        <p className="flex items-start gap-2 border-t border-line px-4 py-2 text-xs text-warning">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('Some positions are level on every tie-breaker and are ordered by seed, then registration time.')}
        </p>
      )}
    </Card>
  );
}
