import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { Alert, Button, Card, CardHeader, Checkbox, Field, Input, Select, Textarea } from '@/components/ui/primitives';
import type { TournamentInput } from '@/data';
import { groupConfigProblems, knockoutShapeNote, newSeed } from '@/engine';
import { t, tr } from '@/i18n';
import { errorMessage, fromLocalInput, toLocalInput } from '@/lib/utils';
import { DEFAULT_SETTINGS, type Tiebreaker, type Tournament } from '@/types/domain';

const TIEBREAK_PRESETS: Record<string, { label: string; order: Tiebreaker[] }> = {
  overall: { label: 'Goal difference → goals scored → head-to-head', order: ['goal_diff', 'goals_for', 'h2h_points', 'h2h_goal_diff', 'h2h_goals_for', 'wins'] },
  h2h: { label: 'Head-to-head first (points → GD → goals), then overall GD → goals', order: ['h2h_points', 'h2h_goal_diff', 'h2h_goals_for', 'goal_diff', 'goals_for', 'wins'] },
};
const presetOf = (order: Tiebreaker[]) => (order[0]?.startsWith('h2h') ? 'h2h' : 'overall');

/** Telegram usernames: 5–32 chars, Latin letters, digits and underscores; a leading @ is allowed. */
const TELEGRAM_RE = /^@?[A-Za-z0-9_]{5,32}$/;
export const normalizeTelegram = (s: string) => s.trim().replace(/^@/, '');

const int = (min: number, max: number) =>
  z.number({ error: t('Enter a number') }).int(t('Whole numbers only')).min(min, t('Minimum {n}', { n: min })).max(max, t('Maximum {n}', { n: max }));

/** Built per render so validation messages follow the current language. */
const makeSchema = () => z.object({
  name: z.string().trim().min(3, t('At least 3 characters')).max(80),
  description: z.string().max(2000),
  rules: z.string().max(5000),
  venue: z.string().trim().max(120),
  startsAt: z.string(),
  registrationDeadline: z.string(),
  format: z.enum(['groups_knockout', 'single_elimination']),
  maxParticipants: int(2, 256),
  groupCount: int(1, 32),
  advancePerGroup: int(1, 8),
  pointsWin: int(0, 10),
  pointsDraw: int(0, 10),
  pointsLoss: int(0, 10),
  tiebreakPreset: z.enum(['overall', 'h2h']),
  doubleRoundRobin: z.boolean(),
  thirdPlaceMatch: z.boolean(),
  walkoverGoals: int(1, 10),
  requireContact: z.boolean(),
  stations: int(0, 64),
  requirePayment: z.boolean(),
  entryFee: z.string().trim().max(60, t('At most 60 characters')),
  paymentDetails: z.string().trim().max(1000, t('At most 1000 characters')),
  telegramUsername: z.string().trim().max(40),
}).refine((v) => !v.startsAt || !v.registrationDeadline || v.registrationDeadline <= v.startsAt, {
  path: ['registrationDeadline'], message: t('The deadline must be before the start time'),
}).refine((v) => v.pointsWin > v.pointsDraw && v.pointsDraw >= v.pointsLoss, {
  path: ['pointsWin'], message: t('A win must be worth more than a draw, and a draw at least as much as a loss'),
}).refine((v) => !v.requirePayment || v.entryFee.length > 0, {
  path: ['entryFee'], message: t('Enter the entry fee'),
}).refine((v) => !v.requirePayment || v.paymentDetails.length >= 5, {
  path: ['paymentDetails'], message: t('Enter the payment details'),
}).refine((v) => !v.requirePayment || TELEGRAM_RE.test(v.telegramUsername), {
  path: ['telegramUsername'], message: t('Telegram username: 5–32 Latin letters, digits or _'),
});
type FormValues = z.infer<ReturnType<typeof makeSchema>>;

function defaults(tour?: Tournament): FormValues {
  const s = tour?.settings ?? DEFAULT_SETTINGS;
  return {
    name: tour?.name ?? '', description: tour?.description ?? '', rules: tour?.rules ?? '', venue: tour?.venue ?? '',
    startsAt: toLocalInput(tour?.startsAt), registrationDeadline: toLocalInput(tour?.registrationDeadline),
    format: tour?.format ?? 'groups_knockout', maxParticipants: tour?.maxParticipants ?? 16,
    groupCount: s.groupCount, advancePerGroup: s.advancePerGroup, pointsWin: s.pointsWin, pointsDraw: s.pointsDraw, pointsLoss: s.pointsLoss,
    tiebreakPreset: presetOf(s.tiebreakers), doubleRoundRobin: s.doubleRoundRobin, thirdPlaceMatch: s.thirdPlaceMatch,
    walkoverGoals: s.walkoverGoals, requireContact: s.requireContact, stations: s.stations,
    requirePayment: s.requirePayment, entryFee: s.entryFee, paymentDetails: s.paymentDetails,
    telegramUsername: s.telegramUsername ? `@${s.telegramUsername}` : '',
  };
}

function pickStructure(d: FormValues) {
  const { format, maxParticipants, groupCount, advancePerGroup, pointsWin, pointsDraw, pointsLoss, tiebreakPreset, doubleRoundRobin, thirdPlaceMatch, walkoverGoals } = d;
  return { format, maxParticipants, groupCount, advancePerGroup, pointsWin, pointsDraw, pointsLoss, tiebreakPreset, doubleRoundRobin, thirdPlaceMatch, walkoverGoals };
}

function lockedSummary(v: FormValues): string {
  const parts: string[] = [];
  if (v.format === 'groups_knockout') {
    parts.push(t('{n} groups', { n: v.groupCount }), t('top {n} advance', { n: v.advancePerGroup }), t('{w}/{d}/{l} points', { w: v.pointsWin, d: v.pointsDraw, l: v.pointsLoss }));
    parts.push(v.doubleRoundRobin ? t('double round robin') : t('single round robin'));
  } else {
    parts.push(t('Single elimination'));
  }
  parts.push(t('max {n} players', { n: v.maxParticipants }), v.thirdPlaceMatch ? t('third-place match') : t('no third-place match'), t('walkover {n}–0', { n: v.walkoverGoals }));
  return parts.join(' · ');
}

export function TournamentForm({ initial, locked, onSubmit, submitLabel }: {
  initial?: Tournament;
  /** Structure is locked once fixtures exist (format, groups, qualifiers). */
  locked?: boolean;
  onSubmit: (input: TournamentInput) => Promise<void>;
  submitLabel: string;
}) {
  const [error, setError] = useState<string | null>(null);
  const { register, handleSubmit, watch, formState: { errors, isSubmitting, isDirty } } = useForm<FormValues>({ resolver: zodResolver(makeSchema()), defaultValues: defaults(initial) });
  const v = watch();
  const num = { valueAsNumber: true } as const;
  const problems = v.format === 'groups_knockout' ? groupConfigProblems(v.maxParticipants || 0, { groupCount: v.groupCount || 0, advancePerGroup: v.advancePerGroup || 0 }) : [];
  const qualifiers = (v.groupCount || 0) * (v.advancePerGroup || 0);
  const shape = v.format === 'groups_knockout' && qualifiers >= 2 ? knockoutShapeNote(qualifiers) : null;

  const submit = async (values: FormValues) => {
    setError(null);
    // The structure fields are not rendered when locked; keep the stored structure.
    const f = locked && initial ? { ...values, ...pickStructure(defaults(initial)) } : values;
    try {
      await onSubmit({
        name: f.name.trim(), description: f.description.trim(), rules: f.rules.trim(), venue: f.venue.trim(),
        startsAt: fromLocalInput(f.startsAt), registrationDeadline: fromLocalInput(f.registrationDeadline),
        format: f.format, maxParticipants: f.maxParticipants,
        settings: {
          groupCount: f.groupCount, advancePerGroup: f.advancePerGroup, pointsWin: f.pointsWin, pointsDraw: f.pointsDraw, pointsLoss: f.pointsLoss,
          tiebreakers: TIEBREAK_PRESETS[f.tiebreakPreset].order, doubleRoundRobin: f.doubleRoundRobin, thirdPlaceMatch: f.thirdPlaceMatch,
          walkoverGoals: f.walkoverGoals, requireContact: f.requireContact, stations: f.stations,
          drawSeed: initial?.settings.drawSeed ?? newSeed(),
          requirePayment: f.requirePayment, entryFee: f.entryFee.trim(), paymentDetails: f.paymentDetails.trim(),
          telegramUsername: normalizeTelegram(f.telegramUsername),
        },
      });
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  return (
    <form onSubmit={handleSubmit(submit)} className="space-y-5" noValidate>
      {error && <Alert tone="danger" title={t('Could not save')}>{error}</Alert>}
      <Card>
        <CardHeader title={t('Details')} />
        <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <Field label={t('Tournament name')} error={errors.name?.message} className="sm:col-span-2">{(p) => <Input {...p} {...register('name')} placeholder={t('e.g. Campus Cup — Autumn 2026')} />}</Field>
          <Field label={t('Venue')} error={errors.venue?.message} hint={t('Room, club or address')}>{(p) => <Input {...p} {...register('venue')} />}</Field>
          <Field label={t('Console stations')} error={errors.stations?.message} hint={t('Used to suggest a station for each match')}>{(p) => <Input {...p} type="number" min={0} {...register('stations', num)} />}</Field>
          <Field label={t('Start time')} error={errors.startsAt?.message}>{(p) => <Input {...p} type="datetime-local" {...register('startsAt')} />}</Field>
          <Field label={t('Registration deadline')} error={errors.registrationDeadline?.message} hint={t('Optional')}>{(p) => <Input {...p} type="datetime-local" {...register('registrationDeadline')} />}</Field>
          <Field label={t('Description')} error={errors.description?.message} className="sm:col-span-2">{(p) => <Textarea {...p} {...register('description')} placeholder={t('Prizes, schedule, what to bring…')} />}</Field>
          <Field label={t('Rules')} error={errors.rules?.message} className="sm:col-span-2" hint={t('Match length, difficulty, team restrictions…')}>{(p) => <Textarea {...p} {...register('rules')} />}</Field>
        </div>
      </Card>

      <Card>
        <CardHeader title={t('Format')} description={locked ? t('Fixtures exist, so the format and structure are locked. Reset fixtures to change them.') : undefined} />
        {locked ? (
          <p className="p-4 text-sm text-muted sm:p-5">{lockedSummary(v)}</p>
        ) : (
          <fieldset className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
            <Field label={t('Format')} error={errors.format?.message}>
              {(p) => (
                <Select {...p} {...register('format')}>
                  <option value="groups_knockout">{t('Group stage + knockout')}</option>
                  <option value="single_elimination">{t('Single elimination')}</option>
                </Select>
              )}
            </Field>
            <Field label={t('Maximum participants')} error={errors.maxParticipants?.message}>{(p) => <Input {...p} type="number" min={2} {...register('maxParticipants', num)} />}</Field>
            {v.format === 'groups_knockout' && (
              <>
                <Field label={t('Number of groups')} error={errors.groupCount?.message}>{(p) => <Input {...p} type="number" min={1} {...register('groupCount', num)} />}</Field>
                <Field label={t('Qualifiers per group')} error={errors.advancePerGroup?.message} hint={qualifiers >= 2 ? t('{n} players reach the knockout', { n: qualifiers }) : undefined}>{(p) => <Input {...p} type="number" min={1} {...register('advancePerGroup', num)} />}</Field>
                <div className="grid grid-cols-3 gap-3 sm:col-span-2">
                  <Field label={t('Win')} error={errors.pointsWin?.message}>{(p) => <Input {...p} type="number" min={0} {...register('pointsWin', num)} />}</Field>
                  <Field label={t('Draw')} error={errors.pointsDraw?.message}>{(p) => <Input {...p} type="number" min={0} {...register('pointsDraw', num)} />}</Field>
                  <Field label={t('Loss')} error={errors.pointsLoss?.message}>{(p) => <Input {...p} type="number" min={0} {...register('pointsLoss', num)} />}</Field>
                </div>
                <Field label={t('Tie-breakers (after points)')} className="sm:col-span-2" hint={t('Anything still level is ordered by seed, then registration time, and flagged for the organizer.')}>
                  {(p) => (
                    <Select {...p} {...register('tiebreakPreset')}>
                      {Object.entries(TIEBREAK_PRESETS).map(([k, x]) => <option key={k} value={k}>{t(x.label)}</option>)}
                    </Select>
                  )}
                </Field>
                <div className="sm:col-span-2"><Checkbox label={t('Double round robin')} description={t('Everyone plays each group opponent twice.')} {...register('doubleRoundRobin')} /></div>
              </>
            )}
            <div className="sm:col-span-2"><Checkbox label={t('Third-place match')} description={t('Semi-final losers play for third place.')} {...register('thirdPlaceMatch')} /></div>
            <Field label={t('Walkover score')} error={errors.walkoverGoals?.message} hint={t('Recorded as {n}–0', { n: v.walkoverGoals || 3 })}>{(p) => <Input {...p} type="number" min={1} {...register('walkoverGoals', num)} />}</Field>
            {(problems.length > 0 || shape) && (
              <div className="sm:col-span-2">
                {problems.length > 0
                  ? <Alert tone="warning" title={t('This configuration cannot be played at full capacity')}>{problems.map(tr).join(' ')}</Alert>
                  : <Alert tone="info" title={t('Knockout shape')}>{tr(shape ?? '')}</Alert>}
              </div>
            )}
          </fieldset>
        )}
      </Card>

      <Card>
        <CardHeader title={t('Registration')} />
        <div className="p-4 sm:p-5">
          <Checkbox label={t('Require contact information')} description={t('Players must leave a phone, Telegram or email. Only organizers can see it.')} {...register('requireContact')} />
        </div>
      </Card>

      <Card>
        <CardHeader title={t('Entry fee and payment')} description={t('Players see these details after submitting the registration form. You confirm each payment manually.')} />
        <div className="grid gap-4 p-4 sm:grid-cols-2 sm:p-5">
          <div className="sm:col-span-2">
            <Checkbox label={t('Require an entry fee')} description={t('A registration becomes a participant only after you confirm the payment receipt.')} {...register('requirePayment')} />
          </div>
          {v.requirePayment && (
            <>
              <Field label={t('Entry fee')} error={errors.entryFee?.message} hint={t('Shown to players as written')}>{(p) => <Input {...p} {...register('entryFee')} placeholder={t('e.g. 7 000 ₸')} />}</Field>
              <Field label={t('Telegram for receipts')} error={errors.telegramUsername?.message} hint={t('Players send the receipt to this username')}>{(p) => <Input {...p} {...register('telegramUsername')} placeholder="@username" autoComplete="off" />}</Field>
              <Field label={t('Payment details')} error={errors.paymentDetails?.message} className="sm:col-span-2" hint={t('Card number, bank, recipient name, Kaspi number — whatever players need for the transfer.')}>
                {(p) => <Textarea {...p} {...register('paymentDetails')} className="min-h-28" placeholder={t('e.g. Kaspi Gold 4400 4301 2345 6789, Temirkhan S.')} />}
              </Field>
            </>
          )}
        </div>
      </Card>

      <div className="flex justify-end gap-2">
        <Button type="submit" variant="primary" loading={isSubmitting} disabled={!!initial && !isDirty}>{submitLabel}</Button>
      </div>
    </form>
  );
}
