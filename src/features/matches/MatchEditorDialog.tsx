import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { NameMap } from '@/components/matches/MatchCard';
import { Dialog, useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Field, Input, Select } from '@/components/ui/primitives';
import { AppError } from '@/data';
import { MAX_GOALS, type MatchChange } from '@/engine';
import { useTournamentActions } from '@/features/tournaments/queries';
import { t, tr } from '@/i18n';
import { cn, errorMessage, fromLocalInput, toLocalInput } from '@/lib/utils';
import type { Match, Side } from '@/types/domain';

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label={label}>
      <Button size="icon" variant="secondary" aria-label={t('Decrease {label}', { label })} onClick={() => onChange(Math.max(0, value - 1))} disabled={value <= 0}><Minus className="h-4 w-4" /></Button>
      <Input
        aria-label={label}
        inputMode="numeric"
        value={String(value)}
        onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '')); onChange(Math.min(MAX_GOALS, Number.isFinite(n) ? n : 0)); }}
        className="h-12 w-14 text-center font-mono text-xl font-semibold tabular"
      />
      <Button size="icon" variant="secondary" aria-label={t('Increase {label}', { label })} onClick={() => onChange(Math.min(MAX_GOALS, value + 1))}><Plus className="h-4 w-4" /></Button>
    </div>
  );
}

type Mode = 'result' | 'walkover' | 'schedule';

export function MatchEditorDialog({ tournamentId, match, names, onClose }: { tournamentId: string; match: Match | null; names: NameMap; onClose: () => void }) {
  const actions = useTournamentActions(tournamentId);
  const confirm = useConfirm();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>('result');
  const [home, setHome] = useState(0);
  const [away, setAway] = useState(0);
  const [hp, setHp] = useState(0);
  const [ap, setAp] = useState(0);
  const [woSide, setWoSide] = useState<Side>('home');
  const [when, setWhen] = useState('');
  const [station, setStation] = useState('');
  const [status, setStatus] = useState<'scheduled' | 'postponed' | 'cancelled' | 'in_progress'>('scheduled');
  const [error, setError] = useState<string | null>(null);
  const [clicked, setClicked] = useState('');

  useEffect(() => {
    if (!match) return;
    setMode('result');
    setHome(match.homeScore ?? 0); setAway(match.awayScore ?? 0);
    setHp(match.homePens ?? 0); setAp(match.awayPens ?? 0);
    setWoSide(match.walkover && match.winnerId === match.awayId ? 'away' : 'home');
    setWhen(toLocalInput(match.scheduledAt)); setStation(match.station ?? '');
    setStatus(match.status === 'completed' ? 'scheduled' : match.status);
    setError(null);
  }, [match]);

  if (!match) return null;
  const ko = match.stage === 'knockout';
  const needsPens = ko && home === away;
  const hn = names.get(match.homeId ?? '')?.displayName ?? t('Home');
  const an = names.get(match.awayId ?? '')?.displayName ?? t('Away');
  const busy = actions.changeMatch.isPending;

  const run = async (change: MatchChange, success: string, which = '') => {
    setError(null);
    setClicked(which);
    try {
      const warnings = (await actions.changeMatch.mutateAsync({ matchId: match.id, change })) ?? [];
      warnings.forEach((w) => toast('warning', tr(w)));
      toast('success', success);
      onClose();
    } catch (e) {
      if (e instanceof AppError && e.code === 'KNOCKOUT_CONFLICT') {
        const ok = await confirm({ title: t('Reset the knockout bracket?'), body: `${tr(e.message)} ${t('This cannot be undone.')}`, confirmLabel: t('Save and delete bracket'), destructive: true });
        if (!ok) return;
        try {
          await actions.changeMatch.mutateAsync({ matchId: match.id, change, options: { resetKnockoutIfInvalid: true } });
          toast('warning', t('Result saved. The knockout bracket was deleted — generate it again when the group stage is final.'));
          onClose();
        } catch (e2) { setError(errorMessage(e2)); }
        return;
      }
      setError(errorMessage(e));
    }
  };

  const saveResult = (final: boolean) => run(
    { type: 'result', input: { homeScore: home, awayScore: away, homePens: final && needsPens ? hp : null, awayPens: final && needsPens ? ap : null, status: final ? 'completed' : 'in_progress' } },
    final ? t('Result saved.') : t('Live score saved.'),
    final ? 'final' : 'live',
  );

  const clear = async () => {
    const downstream = ko ? ` ${t('Later knockout matches that depend on it will be reset.')}` : '';
    if (await confirm({ title: t('Clear this result?'), body: `${t('The score of {home} vs {away} will be removed and the match set back to scheduled.', { home: hn, away: an })}${downstream}`, confirmLabel: t('Clear result'), destructive: true })) {
      await run({ type: 'clear' }, t('Result cleared.'));
    }
  };

  return (
    <Dialog
      open={!!match}
      onClose={onClose}
      title={t('{home} vs {away}', { home: hn, away: an })}
      description={ko ? t('Knockout match — a winner is required.') : t('Group match — draws allowed.')}
      footer={
        <>
          {match.status === 'completed' && <Button variant="danger" onClick={clear} disabled={busy} className="mr-auto">{t('Clear result')}</Button>}
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          {mode === 'result' && <Button variant="secondary" onClick={() => saveResult(false)} disabled={busy} loading={busy && clicked === 'live'}>{t('Save as live')}</Button>}
          {mode === 'result' && <Button variant="primary" onClick={() => saveResult(true)} disabled={busy} loading={busy && clicked === 'final'}>{t('Save final score')}</Button>}
          {mode === 'walkover' && <Button variant="primary" loading={busy} onClick={() => run({ type: 'result', input: { homeScore: 0, awayScore: 0, walkoverWinner: woSide, status: 'completed' } }, t('Walkover recorded.'))}>{t('Record walkover')}</Button>}
          {mode === 'schedule' && <Button variant="primary" loading={busy} onClick={() => run({ type: 'meta', scheduledAt: fromLocalInput(when), station, ...(match.status !== 'completed' ? { status } : {}) }, t('Match updated.'))}>{t('Save schedule')}</Button>}
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-1 rounded-[var(--radius-control)] bg-surface-2 p-1" role="radiogroup" aria-label={t('What to edit')}>
          {(['result', 'walkover', 'schedule'] as Mode[]).map((m) => (
            <button key={m} role="radio" aria-checked={mode === m} onClick={() => setMode(m)} className={cn('h-9 rounded-md text-sm font-medium', mode === m ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}>
              {m === 'result' ? t('Score') : m === 'walkover' ? t('Walkover') : t('Schedule')}
            </button>
          ))}
        </div>
        {error && <Alert tone="danger" title={t('Not saved')}>{error}</Alert>}

        {mode === 'result' && (
          <>
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:justify-between">
              <div className="text-center"><p className="mb-2 max-w-40 truncate text-sm font-medium">{hn}</p><Stepper label={t('{name} goals', { name: hn })} value={home} onChange={setHome} /></div>
              <span className="hidden text-subtle sm:block">–</span>
              <div className="text-center"><p className="mb-2 max-w-40 truncate text-sm font-medium">{an}</p><Stepper label={t('{name} goals', { name: an })} value={away} onChange={setAway} /></div>
            </div>
            {needsPens && (
              <div className="rounded-[var(--radius-control)] border border-warning/30 bg-warning/5 p-3">
                <p className="mb-3 text-sm font-medium text-warning">{t('Level after full time — enter the penalty shoot-out')}</p>
                <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-between">
                  <Stepper label={t('{name} penalties', { name: hn })} value={hp} onChange={setHp} />
                  <Stepper label={t('{name} penalties', { name: an })} value={ap} onChange={setAp} />
                </div>
              </div>
            )}
            <p className="text-xs text-subtle">{t('Enter the score after extra time if it was played. A live score is shown publicly but does not count for standings or advance anyone.')}</p>
          </>
        )}

        {mode === 'walkover' && (
          <Field label={t('Awarded to')} hint={t('The winner is credited with a walkover win; the score is stored as the configured walkover score.')}>
            {(p) => (
              <Select {...p} value={woSide} onChange={(e) => setWoSide(e.target.value as Side)}>
                <option value="home">{hn}</option>
                <option value="away">{an}</option>
              </Select>
            )}
          </Field>
        )}

        {mode === 'schedule' && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t('Date and time')}>{(p) => <Input {...p} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>
            <Field label={t('Station')} hint={t('Console or table')}>{(p) => <Input {...p} value={station} maxLength={40} onChange={(e) => setStation(e.target.value)} placeholder={t('Station 1')} />}</Field>
            {match.status !== 'completed' ? (
              <Field label={t('Status')} className="sm:col-span-2" hint={status === 'cancelled' ? t('Cancelled group matches are excluded from the standings.') : undefined}>
                {(p) => (
                  <Select {...p} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                    <option value="scheduled">{t('Scheduled')}</option>
                    <option value="in_progress">{t('In progress')}</option>
                    <option value="postponed">{t('Postponed')}</option>
                    {!ko && <option value="cancelled">{t('Cancelled')}</option>}
                  </Select>
                )}
              </Field>
            ) : <p className="text-xs text-subtle sm:col-span-2">{t('To change the status of a completed match, clear its result first.')}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
