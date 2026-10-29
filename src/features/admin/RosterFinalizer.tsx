import { AlertTriangle, CheckCircle2, Users } from 'lucide-react';
import { useState } from 'react';
import { useToast } from '@/components/ui/overlay';
import { Alert, Button, Field, Input, Select } from '@/components/ui/primitives';
import { service } from '@/data';
import { FORMAT_LABEL, groupConfigProblems, knockoutShapeNote, rosterReport, roundName, type FormatOption } from '@/engine';
import { useInvalidateTournament } from '@/features/tournaments/queries';
import { t, tr } from '@/i18n';
import { cn, errorMessage } from '@/lib/utils';
import type { TournamentBundle, TournamentFormat } from '@/types/domain';

/**
 * Before the draw: confirmed count vs min / target / max, warnings, and the final format.
 * The organizer picks (or types) a format that fits the actual number of confirmed players;
 * nothing is generated here — the draw step below still needs an explicit confirmation.
 */
export function RosterFinalizer({ b }: { b: TournamentBundle }) {
  const tour = b.tournament;
  const s = tour.settings;
  const report = rosterReport(tour, b.participants);
  const invalidate = useInvalidateTournament(tour.id);
  const toast = useToast();
  const [format, setFormat] = useState<TournamentFormat>(tour.format);
  const [groups, setGroups] = useState(s.groupCount);
  const [advance, setAdvance] = useState(s.advancePerGroup);
  const [saving, setSaving] = useState(false);
  const n = report.confirmed;
  const dirty = format !== tour.format || (format === 'groups_knockout' && (groups !== s.groupCount || advance !== s.advancePerGroup));
  const draftProblems = format === 'groups_knockout' ? groupConfigProblems(n, { groupCount: groups, advancePerGroup: advance }) : n < 2 ? ['At least 2 participants are needed.'] : [];
  const shape = format === 'groups_knockout' ? (draftProblems.length ? null : knockoutShapeNote(groups * advance)) : knockoutShapeNote(n);

  const save = async (o?: FormatOption) => {
    const f = o?.format ?? format;
    const g = o ? (o.format === 'groups_knockout' ? o.groupCount : s.groupCount) : groups;
    const a = o ? (o.format === 'groups_knockout' ? o.advancePerGroup : s.advancePerGroup) : advance;
    setSaving(true);
    try {
      await service.updateTournament(tour.id, { format: f, settings: { ...s, groupCount: g, advancePerGroup: a } });
      setFormat(f); setGroups(g); setAdvance(a);
      await invalidate();
      toast('success', t('Format saved: {format}.', { format: f === 'groups_knockout' ? t('{g} groups, top {a} advance', { g, a }) : t(FORMAT_LABEL[f]) }));
    } catch (e) {
      toast('error', errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const pct = (v: number) => `${Math.min(100, (v / Math.max(1, report.max)) * 100)}%`;

  return (
    <div className="space-y-3" data-testid="roster-finalizer">
      <div>
        <p className="flex items-center gap-2 text-fg"><Users className="h-4 w-4 text-accent" aria-hidden />
          <span className="tabular">{t('Confirmed participants: {n} of {max}', { n, max: report.max })}</span>
        </p>
        <div className="relative mt-2 h-2 rounded-full bg-surface-3" aria-hidden>
          <div className="h-full rounded-full bg-accent/70" style={{ width: pct(n) }} />
          {report.min > 0 && <span className="absolute -top-1 h-4 w-0.5 bg-warning" style={{ left: pct(report.min) }} title={t('Minimum {n}', { n: report.min })} />}
          {report.target > 0 && <span className="absolute -top-1 h-4 w-0.5 bg-fg" style={{ left: pct(report.target) }} title={t('Target {n}', { n: report.target })} />}
        </div>
        {(report.min > 0 || report.target > 0) && (
          <p className="mt-1 text-xs text-subtle">
            {report.min > 0 && <span className="text-warning">▍{t('Minimum {n}', { n: report.min })}</span>}{' '}
            {report.target > 0 && <span className="text-fg">▍{t('Target {n}', { n: report.target })}</span>}
          </p>
        )}
      </div>

      {report.warnings.length > 0 && (
        <ul className="space-y-1">
          {report.warnings.map((w) => <li key={w} className="flex items-start gap-2 text-warning"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />{tr(w)}</li>)}
        </ul>
      )}

      <div className="rounded-md border border-line bg-surface-2 p-3">
        <p className="mb-2 font-semibold text-fg">{t('Final format')}</p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t('Format')}>
            {(p) => (
              <Select {...p} value={format} onChange={(e) => setFormat(e.target.value as TournamentFormat)}>
                <option value="groups_knockout">{t('Group stage + knockout')}</option>
                <option value="single_elimination">{t('Single elimination')}</option>
              </Select>
            )}
          </Field>
          {format === 'groups_knockout' && (
            <>
              <Field label={t('Number of groups')}>{(p) => <Input {...p} type="number" min={1} value={groups} onChange={(e) => setGroups(Math.max(1, Number(e.target.value) || 1))} />}</Field>
              <Field label={t('Qualifiers per group')}>{(p) => <Input {...p} type="number" min={1} value={advance} onChange={(e) => setAdvance(Math.max(1, Number(e.target.value) || 1))} />}</Field>
            </>
          )}
        </div>
        <div className="mt-2 space-y-2">
          {draftProblems.length > 0
            ? <Alert tone="danger" title={t('This format does not fit {n} confirmed participants', { n })}>{draftProblems.map(tr).join(' ')}</Alert>
            : <p className="flex items-center gap-2 text-sm text-success"><CheckCircle2 className="h-4 w-4" aria-hidden />{t('Fits {n} confirmed participants.', { n })} {shape && <span className="text-muted">{tr(shape)}</span>}</p>}
          {dirty && <Button size="sm" variant="primary" onClick={() => save()} loading={saving} disabled={draftProblems.length > 0}>{t('Save format')}</Button>}
        </div>
        {report.suggestions.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs text-subtle">{t('Formats that fit exactly {n} players:', { n })}</p>
            <div className="flex flex-wrap gap-2">
              {report.suggestions.map((o) => {
                const active = o.format === tour.format && (o.format === 'single_elimination' || (o.groupCount === s.groupCount && o.advancePerGroup === s.advancePerGroup));
                return (
                  <button key={`${o.format}-${o.groupCount}-${o.advancePerGroup}`} onClick={() => save(o)} disabled={saving || active}
                    className={cn('rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors', active ? 'border-accent/60 text-fg' : 'border-line text-muted hover:border-line-strong hover:text-fg')}>
                    <span className="font-medium">{t(FORMAT_LABEL[o.format])}</span>{o.format === 'groups_knockout' && <span className="ml-1"><span className="font-mono">{o.label}</span> ({tr(roundName((o.groupCount * o.advancePerGroup) / 2))})</span>}
                    {o.format === 'single_elimination' && o.label && <span className="ml-1">{tr(o.label)}</span>}
                    {active && <span className="ml-1 text-accent">✓</span>}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
