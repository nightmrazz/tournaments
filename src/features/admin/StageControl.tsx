import { CheckCircle2, GitBranch, Lock, RotateCcw, Shuffle, Sparkles } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { nameMap } from '@/components/matches/MatchCard';
import { useConfirm, useToast } from '@/components/ui/overlay';
import { Alert, Button, Card, CardHeader } from '@/components/ui/primitives';
import {
  buildKnockout, confirmedParticipants, EngineError, rosterReport, groupConfigProblems, groupLetter, groupStageComplete, groupStageSummary, knockoutMatches,
  knockoutSeedsFromGroups, knockoutShapeNote, newSeed, previewDraw, roundRobinMatchCount, seedsForSingleElimination, sequentialIds,
} from '@/engine';
import { useTournamentActions } from '@/features/tournaments/queries';
import { RosterFinalizer } from './RosterFinalizer';
import { TeamAssignment } from './TeamAssignment';
import { t, tr } from '@/i18n';
import { errorMessage } from '@/lib/utils';
import type { TournamentBundle } from '@/types/domain';

function Step({ n, title, state, children }: { n: number; title: string; state: 'done' | 'active' | 'locked'; children?: ReactNode }) {
  return (
    <li className="relative pl-10">
      <span className={`absolute left-0 top-0 grid h-7 w-7 place-items-center rounded-full text-xs font-semibold ${state === 'done' ? 'bg-accent text-accent-ink' : state === 'active' ? 'border border-accent text-accent' : 'border border-line-strong text-subtle'}`}>
        {state === 'done' ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : state === 'locked' ? <Lock className="h-3.5 w-3.5" aria-hidden /> : n}
      </span>
      <h3 className={`text-sm font-semibold ${state === 'locked' ? 'text-muted' : ''}`}>{title}</h3>
      {children && <div className="mt-2 space-y-3 text-sm text-muted">{children}</div>}
    </li>
  );
}

export function StageControl({ b }: { b: TournamentBundle }) {
  const tour = b.tournament;
  const actions = useTournamentActions(tour.id);
  const confirm = useConfirm();
  const toast = useToast();
  const [seed, setSeed] = useState(tour.settings.drawSeed);
  const [previewOpen, setPreviewOpen] = useState(false);
  const names = useMemo(() => nameMap(b.participants), [b.participants]);
  const confirmed = useMemo(() => confirmedParticipants(b), [b]);
  const unconfirmed = b.participants.length - confirmed.length;
  const ko = knockoutMatches(b);
  const closed = tour.status === 'completed' || tour.status === 'cancelled';
  const ready = tour.status === 'registration_closed';

  const handle = async (p: Promise<string[] | void>, ok: string) => {
    try {
      const warnings = (await p) ?? [];
      warnings.forEach((w) => toast('warning', tr(w)));
      toast('success', ok);
    } catch (e) {
      toast('error', errorMessage(e));
    }
  };

  const draw = useMemo(() => {
    if (!previewOpen) return null;
    try { return { groups: previewDraw(b, seed), error: null }; } catch (e) { return { groups: null, error: e instanceof EngineError ? tr(e.message) : errorMessage(e) }; }
  }, [previewOpen, b, seed]);

  const bracketPreview = useMemo(() => {
    if (!previewOpen || tour.format !== 'single_elimination' || confirmed.length < 2) return null;
    const ms = buildKnockout(seedsForSingleElimination(confirmed, seed), { tournamentId: tour.id, thirdPlace: false, ids: sequentialIds('p'), now: '' });
    return ms.filter((m) => m.round === 1).sort((a, c) => a.slot - c.slot);
  }, [previewOpen, confirmed, seed, tour.format, tour.id]);

  const resetKnockout = async () => {
    const played = ko.filter((m) => m.status === 'completed').length;
    if (await confirm({ title: t('Delete the knockout bracket?'), body: played ? t('All {n} knockout matches, including {played} recorded result(s), will be deleted.', { n: ko.length, played }) : t('All {n} knockout matches will be deleted.', { n: ko.length }), confirmLabel: t('Delete bracket'), destructive: true }))
      await handle(actions.resetKnockout.mutateAsync(), t('Knockout bracket deleted.'));
  };
  const resetGroups = async () => {
    if (await confirm({ title: t('Undo the group draw?'), body: t('All groups and fixtures will be deleted and the tournament returns to "Registration closed". This is only possible before any result is recorded.'), confirmLabel: t('Delete groups'), destructive: true }))
      await handle(actions.resetGroups.mutateAsync(), t('Group stage deleted.'));
  };

  if (closed) return <Alert tone="info" title={tour.status === 'completed' ? t('This tournament is completed.') : t('This tournament is cancelled.')}>{tour.status === 'completed' ? t('Reopen it from the status menu to correct results.') : t('No further changes are possible.')}</Alert>;

  const drawn = b.matches.length > 0;
  const allTeams = confirmed.length > 0 && confirmed.every((p) => p.team);
  const teamStep = (n: number) => (
    <Step n={n} title={t('Assign teams')} state={!drawn ? 'locked' : allTeams ? 'done' : 'active'}>
      {drawn ? <TeamAssignment b={b} /> : <p>{t('Available right after the draw: give every player a club manually.')}</p>}
    </Step>
  );

  /** Explicit confirmation before fixtures are created — lists everything the organizer should know. */
  const confirmRoster = () => {
    const r = rosterReport(tour, b.participants);
    return confirm({
      title: t('Generate fixtures for {n} participants?', { n: r.confirmed }),
      body: (
        <div className="space-y-2">
          <p>{t('The participant list is frozen after this step. Only confirmed registrations take part.')}</p>
          {r.warnings.length > 0 && <ul className="list-inside list-disc text-warning">{r.warnings.map((w) => <li key={w}>{tr(w)}</li>)}</ul>}
        </div>
      ),
      confirmLabel: t('Generate'),
      destructive: r.warnings.some((w) => w.includes('below the minimum')),
    });
  };

  const registrationStep = (
    <Step n={1} title={t('Close registration and finalize the roster')} state={b.matches.length ? 'done' : 'active'}>
      {(tour.status === 'draft' || tour.status === 'registration_open') && <p>{t('Fixtures can be generated once registration is closed. Use the status controls above.')}</p>}
      {!b.matches.length && <RosterFinalizer b={b} />}
      {unconfirmed > 0 && !b.matches.length && <p className="text-xs">{t('Unconfirmed registrations are managed in the Participants tab.')}</p>}
    </Step>
  );

  if (tour.format === 'single_elimination') {
    return (
      <Card>
        <CardHeader title={t('Stage control')} description={t('Follow the steps in order. Each step unlocks when the previous one is complete.')} />
        <ol className="space-y-6 p-4 sm:p-5">
          {registrationStep}
          <Step n={2} title={t('Seed and generate the bracket')} state={ko.length ? 'done' : ready ? 'active' : 'locked'}>
            {ko.length ? (
              <Button size="sm" variant="danger" onClick={resetKnockout} loading={actions.resetKnockout.isPending}><RotateCcw className="h-4 w-4" />{t('Reset bracket')}</Button>
            ) : ready && (
              <>
                <p>{t('Players with a manual seed are placed first; the rest are drawn with seed #{seed}.', { seed })} {tr(knockoutShapeNote(confirmed.length) ?? '')}</p>
                {!previewOpen ? <Button variant="primary" size="sm" onClick={() => setPreviewOpen(true)}><Sparkles className="h-4 w-4" />{t('Preview bracket')}</Button> : (
                  <>
                    <ul className="grid gap-1.5 sm:grid-cols-2">
                      {bracketPreview?.map((m) => <li key={m.id} className="rounded-md border border-line bg-surface-2 px-3 py-2 text-fg">{names.get(m.homeId ?? '')?.displayName} <span className="text-subtle">{t('vs')}</span> {names.get(m.awayId ?? '')?.displayName}</li>)}
                    </ul>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setSeed(newSeed())}><Shuffle className="h-4 w-4" />{t('Redraw')}</Button>
                      <Button size="sm" variant="primary" loading={actions.generateBracket.isPending} onClick={async () => { if (await confirmRoster()) await handle(actions.generateBracket.mutateAsync(seed), t('Bracket generated. The tournament is now in progress.')); }}>{t('Confirm and generate')}</Button>
                    </div>
                  </>
                )}
              </>
            )}
          </Step>
          {teamStep(3)}
          <Step n={4} title={t('Play the knockout')} state={!ko.length ? 'locked' : ko.every((m) => m.status === 'completed') ? 'done' : 'active'}>
            {ko.length > 0 && <p>{t('{done}/{total} matches completed. Enter results in the Matches or Bracket tab.', { done: ko.filter((m) => m.status === 'completed').length, total: ko.length })}</p>}
          </Step>
        </ol>
      </Card>
    );
  }

  const s = tour.settings;
  const problems = groupConfigProblems(confirmed.length, s);
  const gs = groupStageSummary(b);
  const groupsDone = groupStageComplete(b);
  const seedsInfo = groupsDone && !ko.length ? knockoutSeedsFromGroups(b) : null;
  const hasResults = b.matches.some((m) => m.status === 'completed' || m.homeScore !== null);

  return (
    <Card>
      <CardHeader title={t('Stage control')} description={t('Follow the steps in order. Each step unlocks when the previous one is complete.')} />
      <ol className="space-y-6 p-4 sm:p-5">
        {registrationStep}
        <Step n={2} title={t('Draw groups and generate fixtures')} state={b.groups.length ? 'done' : ready ? 'active' : 'locked'}>
          {b.groups.length > 0 ? (
            <div className="flex flex-wrap items-center gap-3">
              <span>{t('{groups} groups, {n} fixtures.', { groups: b.groups.length, n: gs.total })}</span>
              {!hasResults && <Button size="sm" variant="danger" onClick={resetGroups} loading={actions.resetGroups.isPending}><RotateCcw className="h-4 w-4" />{t('Undo draw')}</Button>}
            </div>
          ) : ready && (
            problems.length ? <Alert tone="warning" title={t('Cannot draw groups')}>{problems.map(tr).join(' ')} {t('Adjust the format in Settings.')}</Alert> : (
              <>
                <p>{t('{n} players into {groups} groups. Manual seeds are spread across groups first; the rest are drawn randomly (draw #{seed}). Review before confirming — nothing is saved until you do.', { n: confirmed.length, groups: s.groupCount, seed })}</p>
                {!previewOpen ? <Button variant="primary" size="sm" onClick={() => setPreviewOpen(true)}><Sparkles className="h-4 w-4" />{t('Preview draw')}</Button> : draw?.error ? <Alert tone="danger" title={draw.error} /> : (
                  <>
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4" data-testid="draw-preview">
                      {draw?.groups?.map((g, i) => (
                        <div key={i} className="rounded-md border border-line bg-surface-2 p-3">
                          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-accent">{t('Group {letter}', { letter: groupLetter(i) })}</p>
                          <ul className="space-y-1 text-fg">{g.map((id) => <li key={id} className="truncate">{names.get(id)?.displayName}</li>)}</ul>
                          <p className="mt-2 text-xs text-subtle">{t('Matches: {n}', { n: roundRobinMatchCount(g.length, s.doubleRoundRobin) })}</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => setSeed(newSeed())}><Shuffle className="h-4 w-4" />{t('Redraw')}</Button>
                      <Button size="sm" variant="primary" loading={actions.generateGroups.isPending} disabled={!draw?.groups}
                        onClick={async () => { if (draw?.groups && await confirmRoster()) await handle(actions.generateGroups.mutateAsync(draw.groups), t('Groups and fixtures created. The tournament is now in progress.')); }}>
                        {t('Confirm draw and generate fixtures')}
                      </Button>
                    </div>
                  </>
                )}
              </>
            )
          )}
        </Step>
        {teamStep(3)}
        <Step n={4} title={t('Play the group stage')} state={!b.groups.length ? 'locked' : groupsDone ? 'done' : 'active'}>
          {b.groups.length > 0 && <p>{t('{done}/{total} group matches completed.', { done: gs.completed, total: gs.total })}{!groupsDone && ` ${t('The knockout stage unlocks when every group match is completed or cancelled.')}`}</p>}
        </Step>
        <Step n={5} title={t('Generate the knockout bracket')} state={ko.length ? 'done' : groupsDone ? 'active' : 'locked'}>
          {ko.length > 0 ? (
            <Button size="sm" variant="danger" onClick={resetKnockout} loading={actions.resetKnockout.isPending}><RotateCcw className="h-4 w-4" />{t('Reset bracket')}</Button>
          ) : groupsDone && seedsInfo && (
            <>
              <p>{t('{n} qualifiers: group winners are seeded first and meet runners-up from other groups.', { n: seedsInfo.seeds.length })} {tr(knockoutShapeNote(seedsInfo.seeds.length) ?? '')}</p>
              {seedsInfo.warnings.map((w) => <Alert key={w} tone="warning" title={t('Tie decided by fallback')}>{tr(w)} {t('Check the standings before generating the bracket.')}</Alert>)}
              <Button variant="primary" size="sm" loading={actions.generateKnockout.isPending} onClick={() => handle(actions.generateKnockout.mutateAsync(), t('Knockout bracket generated.'))}>
                <GitBranch className="h-4 w-4" />{t('Generate knockout bracket')}
              </Button>
            </>
          )}
        </Step>
        <Step n={6} title={t('Play the knockout')} state={!ko.length ? 'locked' : ko.every((m) => m.status === 'completed') ? 'done' : 'active'}>
          {ko.length > 0 && <p>{t('{done}/{total} knockout matches completed.', { done: ko.filter((m) => m.status === 'completed').length, total: ko.length })}</p>}
        </Step>
      </ol>
    </Card>
  );
}
