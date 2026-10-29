import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AppError, service } from '@/data';
import {
  EngineError, planGroupStage, planKnockoutFromGroups, planMatchChange, planResetGroupStage, planResetKnockout,
  planSingleElimination, planStatusChange, uuid, type CommandResult, type GroupDraw, type MatchChange, type MatchChangeOptions,
} from '@/engine';
import type { TournamentBundle, TournamentStatus } from '@/types/domain';

export const keys = {
  list: ['tournaments'] as const,
  managed: (uid: string) => ['tournaments', 'managed', uid] as const,
  bundle: (id: string) => ['tournament', id] as const,
  contacts: (id: string) => ['tournament', id, 'contacts'] as const,
  mine: ['my-applications'] as const,
};

export function useTournaments() {
  return useQuery({ queryKey: keys.list, queryFn: () => service.listTournaments() });
}

export function useManagedTournaments(userId: string | undefined) {
  return useQuery({ queryKey: keys.managed(userId ?? ''), queryFn: () => service.listManagedTournaments(userId as string), enabled: !!userId });
}

/** Public pages poll so spectators see results without reloading. */
export function useBundle(id: string, opts: { poll?: boolean } = {}) {
  return useQuery({
    queryKey: keys.bundle(id),
    queryFn: async () => {
      const b = await service.getBundle(id);
      if (!b) throw new AppError('This tournament does not exist or is not public.', 'NOT_FOUND');
      return b;
    },
    refetchInterval: opts.poll ? 20_000 : false,
    retry: (n, e) => !(e instanceof AppError && e.code === 'NOT_FOUND') && n < 2,
  });
}

/** The current player's applications. Polled so a confirmation shows up without reloading. */
export function useMyApplications(enabled: boolean) {
  return useQuery({ queryKey: keys.mine, queryFn: () => service.listMyApplications(), enabled, refetchInterval: 30_000 });
}

export function useContacts(id: string, enabled: boolean) {
  return useQuery({ queryKey: keys.contacts(id), queryFn: () => service.listContacts(id), enabled });
}

/**
 * Runs an engine command against a FRESH copy of the tournament and persists the resulting
 * mutation with the version it was computed from, so concurrent edits fail instead of clobbering.
 */
async function runCommand(id: string, plan: (b: TournamentBundle) => CommandResult): Promise<string[]> {
  const b = await service.getBundle(id);
  if (!b) throw new AppError('Tournament not found.');
  let result: CommandResult;
  try {
    result = plan(b);
  } catch (e) {
    if (e instanceof EngineError) throw new AppError(e.message, e.code);
    throw e;
  }
  await service.applyMutation(id, b.tournament.version, result.mutation);
  return result.warnings;
}

const ctx = () => ({ ids: uuid, now: new Date().toISOString() });

export function useTournamentActions(id: string) {
  const qc = useQueryClient();
  const done = () => Promise.all([qc.invalidateQueries({ queryKey: keys.bundle(id) }), qc.invalidateQueries({ queryKey: keys.list })]);
  const m = <A,>(fn: (a: A) => Promise<string[] | void>) => useMutation({ mutationFn: fn, onSettled: done });

  return {
    setStatus: m(async (to: TournamentStatus) => {
      const b = await service.getBundle(id);
      if (!b) throw new AppError('Tournament not found.');
      try { planStatusChange(b, to); } catch (e) { if (e instanceof EngineError) throw new AppError(e.message, e.code); throw e; }
      await service.setStatus(id, to);
    }),
    generateGroups: m((draw: GroupDraw) => runCommand(id, (b) => planGroupStage(b, draw, ctx()))),
    generateBracket: m((seed: number) => runCommand(id, (b) => planSingleElimination(b, seed, ctx()))),
    generateKnockout: m(() => runCommand(id, (b) => planKnockoutFromGroups(b, ctx()))),
    resetKnockout: m(() => runCommand(id, planResetKnockout)),
    resetGroups: m(() => runCommand(id, planResetGroupStage)),
    changeMatch: m(({ matchId, change, options }: { matchId: string; change: MatchChange; options?: MatchChangeOptions }) =>
      runCommand(id, (b) => planMatchChange(b, matchId, change, ctx(), options))),
  };
}

export function useInvalidateTournament(id: string) {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: keys.bundle(id) }),
    qc.invalidateQueries({ queryKey: keys.list }),
    qc.invalidateQueries({ queryKey: keys.contacts(id) }),
    qc.invalidateQueries({ queryKey: keys.mine }),
  ]);
}
