import { Shield } from 'lucide-react';
import { useToast } from '@/components/ui/overlay';
import { service } from '@/data';
import { CLUBS } from '@/features/participants/clubs';
import { useInvalidateTournament } from '@/features/tournaments/queries';
import { t, tr } from '@/i18n';
import { cn, errorMessage } from '@/lib/utils';
import type { Participant, TournamentBundle } from '@/types/domain';
import { InlineField } from './InlineField';

export const CLUB_LIST_ID = 'club-suggestions';

export function ClubSuggestions() {
  return <datalist id={CLUB_LIST_ID}>{CLUBS.map((c) => <option key={c} value={c} />)}</datalist>;
}

/** Saves a team for one player; shared by the stage-control step and the participants tab. */
export function useSaveTeam(tournamentId: string) {
  const invalidate = useInvalidateTournament(tournamentId);
  const toast = useToast();
  return (p: Participant) => async (v: string) => {
    try {
      await service.updateParticipant(p.id, { team: v || null });
      await invalidate();
      toast('success', v ? t('{name} plays as {team}.', { name: p.displayName, team: v }) : t('Team removed for {name}.', { name: p.displayName }));
    } catch (e) {
      toast('error', errorMessage(e));
      throw e;
    }
  };
}

export function TeamInput({ p, onSave, disabled, duplicate }: { p: Participant; onSave: (v: string) => Promise<void>; disabled?: boolean; duplicate?: boolean }) {
  return (
    <div className="min-w-0">
      <InlineField
        key={`${p.id}-${p.team ?? ''}`}
        initial={p.team ?? ''} label={t('Team for {name}', { name: p.displayName })} disabled={disabled}
        placeholder={t('No team')} list={CLUB_LIST_ID} className="h-9 min-w-40" onSave={onSave}
      />
      {duplicate && <p className="mt-1 text-xs text-warning">{t('Also used by another player')}</p>}
    </div>
  );
}

export function duplicateTeams(ps: Participant[]): Set<string> {
  const count = new Map<string, number>();
  for (const p of ps) if (p.team) count.set(p.team.toLowerCase(), (count.get(p.team.toLowerCase()) ?? 0) + 1);
  return new Set([...count].filter(([, n]) => n > 1).map(([k]) => k));
}

/**
 * Stage-control step shown after the draw: the organizer assigns a club to every player,
 * grouped the way the draw placed them.
 */
export function TeamAssignment({ b }: { b: TournamentBundle }) {
  const save = useSaveTeam(b.tournament.id);
  const byId = new Map(b.participants.map((p) => [p.id, p]));
  const dups = duplicateTeams(b.participants);
  const assigned = b.participants.filter((p) => p.team).length;
  const sections: { key: string; title: string | null; players: Participant[] }[] = b.groups.length
    ? [...b.groups].sort((a, c) => a.index - c.index).map((g) => ({
        key: g.id,
        title: tr(g.name),
        players: b.groupMembers.filter((m) => m.groupId === g.id).sort((x, y) => x.position - y.position).map((m) => byId.get(m.participantId)).filter((p): p is Participant => !!p),
      }))
    : [{ key: 'all', title: null, players: [...b.participants].sort((a, c) => a.displayName.localeCompare(c.displayName)) }];

  return (
    <div className="space-y-3" data-testid="team-assignment">
      <ClubSuggestions />
      <p className="flex items-center gap-1.5">
        <Shield className="h-4 w-4 text-accent" aria-hidden />
        <span className={cn('tabular', assigned === b.participants.length ? 'text-success' : 'text-fg')}>{t('Teams assigned: {n}/{total}', { n: assigned, total: b.participants.length })}</span>
      </p>
      <p>{t('Type a club or pick a suggestion; it is saved when you leave the field. Teams can be changed until the tournament ends.')}</p>
      <div className={cn('grid gap-2', sections.length > 1 && 'md:grid-cols-2')}>
        {sections.map((s) => (
          <div key={s.key} className="rounded-md border border-line bg-surface-2 p-3">
            {s.title && <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">{s.title}</p>}
            <ul className="space-y-2">
              {s.players.map((p) => (
                <li key={p.id} className="grid grid-cols-[minmax(0,8rem)_1fr] items-start gap-2">
                  <span className="truncate pt-2 text-sm font-medium text-fg">{p.displayName}</span>
                  <TeamInput p={p} onSave={save(p)} duplicate={!!p.team && dups.has(p.team.toLowerCase())} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}
