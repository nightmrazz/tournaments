import type { Match, Side, TournamentSettings } from '@/types/domain';
import { EngineError } from './errors';

export const MAX_GOALS = 99;

export interface ResultInput {
  homeScore: number;
  awayScore: number;
  /** Penalty shoot-out score; only for knockout matches that end level. */
  homePens?: number | null;
  awayPens?: number | null;
  /** Record a walkover won by this side. Scores are then set from settings.walkoverGoals. */
  walkoverWinner?: Side | null;
  /** 'in_progress' stores a live score that neither counts nor advances anyone. */
  status: 'completed' | 'in_progress';
}

const isGoalCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_GOALS;

/** Validates a result against the match and returns the normalized fields to store. */
export function normalizeResult(match: Match, input: ResultInput, settings: Pick<TournamentSettings, 'walkoverGoals'>): Pick<
  Match,
  'homeScore' | 'awayScore' | 'homePens' | 'awayPens' | 'winnerId' | 'walkover' | 'status'
> {
  if (!match.homeId || !match.awayId) throw new EngineError('INVALID_STATE', 'Both participants must be known before a result can be entered.');
  if (match.status === 'cancelled') throw new EngineError('INVALID_STATE', 'This match is cancelled. Restore it before entering a result.');
  if (input.walkoverWinner) {
    if (input.status !== 'completed') throw new EngineError('INVALID_SCORE', 'A walkover always completes the match.');
    const g = settings.walkoverGoals;
    const home = input.walkoverWinner === 'home';
    return {
      homeScore: home ? g : 0, awayScore: home ? 0 : g, homePens: null, awayPens: null,
      winnerId: home ? match.homeId : match.awayId, walkover: true, status: 'completed',
    };
  }
  if (!isGoalCount(input.homeScore) || !isGoalCount(input.awayScore))
    throw new EngineError('INVALID_SCORE', `Scores must be whole numbers between 0 and ${MAX_GOALS}.`);
  const hasPens = input.homePens != null || input.awayPens != null;
  const level = input.homeScore === input.awayScore;
  if (match.stage === 'group') {
    if (hasPens) throw new EngineError('INVALID_SCORE', 'Group matches cannot have a penalty shoot-out.');
    const winnerId = input.status !== 'completed' || level ? null : input.homeScore > input.awayScore ? match.homeId : match.awayId;
    return { homeScore: input.homeScore, awayScore: input.awayScore, homePens: null, awayPens: null, winnerId, walkover: false, status: input.status };
  }
  // Knockout: a completed match must produce a winner.
  if (hasPens && !level) throw new EngineError('INVALID_SCORE', 'Penalties can only be recorded when the score is level.');
  if (input.status === 'in_progress') {
    return { homeScore: input.homeScore, awayScore: input.awayScore, homePens: null, awayPens: null, winnerId: null, walkover: false, status: 'in_progress' };
  }
  if (!level) {
    return {
      homeScore: input.homeScore, awayScore: input.awayScore, homePens: null, awayPens: null,
      winnerId: input.homeScore > input.awayScore ? match.homeId : match.awayId, walkover: false, status: 'completed',
    };
  }
  if (!isGoalCount(input.homePens) || !isGoalCount(input.awayPens))
    throw new EngineError('INVALID_SCORE', 'A knockout match that ends level needs a penalty shoot-out result.');
  if (input.homePens === input.awayPens) throw new EngineError('INVALID_SCORE', 'The penalty shoot-out must have a winner.');
  return {
    homeScore: input.homeScore, awayScore: input.awayScore, homePens: input.homePens, awayPens: input.awayPens,
    winnerId: input.homePens > input.awayPens ? match.homeId : match.awayId, walkover: false, status: 'completed',
  };
}

const CLEARED = { homeScore: null, awayScore: null, homePens: null, awayPens: null, winnerId: null, walkover: false } as const;

export const hasResult = (m: Match) => m.homeScore !== null || m.awayScore !== null || m.winnerId !== null;

/**
 * Applies changes to knockout matches and keeps the bracket consistent.
 *
 * Only a *completed* match feeds participants forward. Whenever the participant in a downstream
 * slot changes, any result already stored on that downstream match is no longer valid: it is
 * cleared (status back to "scheduled") and the clearing cascades further down the bracket. A slot
 * that already holds the right participant is left untouched, so correcting a score without
 * changing the winner never disturbs later rounds and nobody is advanced twice.
 *
 * Returns every match that changed, keyed by id.
 */
export class BracketEditor {
  private readonly byId: Map<string, Match>;
  readonly changed = new Map<string, Match>();
  /** Matches whose stored result had to be discarded because an upstream result changed. */
  readonly invalidated: string[] = [];

  constructor(matches: readonly Match[], private readonly now: string) {
    this.byId = new Map(matches.map((m) => [m.id, { ...m }]));
  }

  get(id: string): Match {
    const m = this.byId.get(id);
    if (!m) throw new EngineError('NOT_FOUND', 'Match not found.');
    return m;
  }

  private touch(m: Match) {
    m.updatedAt = this.now;
    this.changed.set(m.id, m);
  }

  /** Replace fields on a match, then re-propagate its outcome. */
  update(id: string, patch: Partial<Match>) {
    const m = this.get(id);
    Object.assign(m, patch);
    this.touch(m);
    this.propagate(m);
  }

  private outcome(m: Match): { winner: string | null; loser: string | null } {
    if (m.stage !== 'knockout' || m.status !== 'completed' || !m.winnerId) return { winner: null, loser: null };
    const loser = m.winnerId === m.homeId ? m.awayId : m.homeId;
    return { winner: m.winnerId, loser };
  }

  private propagate(m: Match) {
    if (m.stage !== 'knockout') return;
    const { winner, loser } = this.outcome(m);
    if (m.nextMatchId && m.nextSlot) this.setSlot(m.nextMatchId, m.nextSlot, winner);
    if (m.loserNextMatchId && m.loserNextSlot) this.setSlot(m.loserNextMatchId, m.loserNextSlot, loser);
  }

  private setSlot(matchId: string, side: Side, participantId: string | null) {
    const target = this.get(matchId);
    const current = side === 'home' ? target.homeId : target.awayId;
    if (current === participantId) return;
    const other = side === 'home' ? target.awayId : target.homeId;
    if (participantId && other === participantId) throw new EngineError('DUPLICATE', 'A participant cannot occupy both sides of a match.');
    if (side === 'home') target.homeId = participantId; else target.awayId = participantId;
    if (hasResult(target) || target.status === 'completed' || target.status === 'in_progress') {
      Object.assign(target, CLEARED, { status: 'scheduled' as const });
      this.invalidated.push(target.id);
    }
    this.touch(target);
    this.propagate(target);
  }
}

export function clearedResultPatch(): Partial<Match> {
  return { ...CLEARED, status: 'scheduled' };
}
