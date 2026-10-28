import type { Match, Participant, Tiebreaker, TournamentSettings } from '@/types/domain';

export type QualificationStatus = 'qualified' | 'eliminated' | 'pending';

export interface StandingRow {
  participantId: string;
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /** Most recent last, 'W' | 'D' | 'L'. */
  form: ('W' | 'D' | 'L')[];
  /** True when this row's position was decided only by the deterministic fallback (seed / registration order). */
  decidedByFallback: boolean;
  qualification: QualificationStatus;
  /** Inside the advancing zone (provisional while the group is unfinished). */
  inQualifyingZone: boolean;
}

export interface GroupStandings {
  rows: StandingRow[];
  /** Every scheduled (non-cancelled) match in the group has a completed result. */
  complete: boolean;
  playedMatches: number;
  totalMatches: number;
}

type Stats = Omit<StandingRow, 'rank' | 'decidedByFallback' | 'qualification' | 'inQualifyingZone'>;

/** A match counts for standings only when it is completed with a full score. Cancelled matches never count. */
export function countsForStandings(m: Match): boolean {
  return m.status === 'completed' && m.homeScore !== null && m.awayScore !== null && !!m.homeId && !!m.awayId;
}

function emptyStats(id: string): Stats {
  return { participantId: id, played: 0, won: 0, drawn: 0, lost: 0, goalsFor: 0, goalsAgainst: 0, goalDiff: 0, points: 0, form: [] };
}

function tally(ids: readonly string[], matches: readonly Match[], s: Pick<TournamentSettings, 'pointsWin' | 'pointsDraw' | 'pointsLoss'>): Map<string, Stats> {
  const table = new Map<string, Stats>(ids.map((id) => [id, emptyStats(id)]));
  const ordered = [...matches].sort((a, b) => a.round - b.round || a.slot - b.slot);
  for (const m of ordered) {
    if (!countsForStandings(m)) continue;
    const home = table.get(m.homeId as string);
    const away = table.get(m.awayId as string);
    if (!home || !away) continue; // match outside the considered set (e.g. head-to-head subset)
    const hs = m.homeScore as number;
    const as = m.awayScore as number;
    home.played++; away.played++;
    home.goalsFor += hs; home.goalsAgainst += as;
    away.goalsFor += as; away.goalsAgainst += hs;
    if (hs > as) {
      home.won++; away.lost++; home.points += s.pointsWin; away.points += s.pointsLoss;
      home.form.push('W'); away.form.push('L');
    } else if (hs < as) {
      away.won++; home.lost++; away.points += s.pointsWin; home.points += s.pointsLoss;
      away.form.push('W'); home.form.push('L');
    } else {
      home.drawn++; away.drawn++; home.points += s.pointsDraw; away.points += s.pointsDraw;
      home.form.push('D'); away.form.push('D');
    }
  }
  for (const st of table.values()) st.goalDiff = st.goalsFor - st.goalsAgainst;
  return table;
}

const isH2H = (t: Tiebreaker) => t.startsWith('h2h_');

/**
 * Orders a set of participants that are level on points.
 *
 * Criteria are applied in the configured order. Head-to-head criteria are computed from a
 * mini-table containing ONLY the matches between the members of the current tied set. When any
 * criterion splits the set, each smaller sub-set that is still tied is re-ranked from the first
 * criterion again with its own head-to-head mini-table (the UEFA "re-apply" approach). This makes
 * three-way and larger ties well defined: e.g. if A, B and C are level and A wins the 3-way mini
 * table, B and C are then separated by their direct meeting only.
 *
 * Returns ordered buckets; a bucket with >1 element could not be separated by any criterion.
 */
function breakTie(
  set: string[],
  overall: Map<string, Stats>,
  groupMatches: readonly Match[],
  settings: TournamentSettings,
): string[][] {
  if (set.length <= 1) return [set];
  const h2hTable = settings.tiebreakers.some(isH2H) ? tally(set, groupMatches, settings) : null;
  for (const criterion of settings.tiebreakers) {
    const value = (id: string): number => {
      const o = overall.get(id) as Stats;
      const h = h2hTable?.get(id);
      switch (criterion) {
        case 'goal_diff': return o.goalDiff;
        case 'goals_for': return o.goalsFor;
        case 'wins': return o.won;
        case 'h2h_points': return h ? h.points : 0;
        case 'h2h_goal_diff': return h ? h.goalDiff : 0;
        case 'h2h_goals_for': return h ? h.goalsFor : 0;
      }
    };
    const buckets = new Map<number, string[]>();
    for (const id of set) {
      const v = value(id);
      buckets.set(v, [...(buckets.get(v) ?? []), id]);
    }
    if (buckets.size === 1) continue; // criterion does not separate anyone
    const ordered = [...buckets.entries()].sort((a, b) => b[0] - a[0]).map(([, ids]) => ids);
    return ordered.flatMap((bucket) => breakTie(bucket, overall, groupMatches, settings));
  }
  return [set];
}

export interface FallbackInfo {
  seed: number | null;
  createdAt: string;
}

/** Final deterministic fallback: manual seed (lower first, unseeded last), then registration time, then id. */
export function fallbackCompare(a: string, b: string, info: Map<string, FallbackInfo>): number {
  const ia = info.get(a);
  const ib = info.get(b);
  const sa = ia?.seed ?? Number.MAX_SAFE_INTEGER;
  const sb = ib?.seed ?? Number.MAX_SAFE_INTEGER;
  if (sa !== sb) return sa - sb;
  const ca = ia?.createdAt ?? '';
  const cb = ib?.createdAt ?? '';
  if (ca !== cb) return ca < cb ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function fallbackInfo(participants: readonly Participant[]): Map<string, FallbackInfo> {
  return new Map(participants.map((p) => [p.id, { seed: p.seed, createdAt: p.createdAt }]));
}

/**
 * Computes a group table purely from persisted match results.
 * Order: points → configured tie-breakers (see breakTie) → deterministic fallback.
 */
export function computeGroupStandings(
  memberIds: readonly string[],
  groupMatches: readonly Match[],
  settings: TournamentSettings,
  info: Map<string, FallbackInfo>,
): GroupStandings {
  const overall = tally(memberIds, groupMatches, settings);
  const byPoints = new Map<number, string[]>();
  for (const id of memberIds) {
    const p = (overall.get(id) as Stats).points;
    byPoints.set(p, [...(byPoints.get(p) ?? []), id]);
  }
  const ordered: { id: string; fallback: boolean }[] = [];
  for (const [, ids] of [...byPoints.entries()].sort((a, b) => b[0] - a[0])) {
    for (const bucket of breakTie(ids, overall, groupMatches, settings)) {
      const sorted = [...bucket].sort((a, b) => fallbackCompare(a, b, info));
      for (const id of sorted) ordered.push({ id, fallback: bucket.length > 1 });
    }
  }
  const relevant = groupMatches.filter((m) => m.status !== 'cancelled');
  const played = relevant.filter(countsForStandings).length;
  const complete = relevant.length > 0 && played === relevant.length;
  const advance = settings.advancePerGroup;
  const rows: StandingRow[] = ordered.map(({ id, fallback }, i) => {
    const inZone = i < advance;
    return {
      ...(overall.get(id) as Stats),
      rank: i + 1,
      decidedByFallback: fallback,
      inQualifyingZone: inZone,
      qualification: complete ? (inZone ? 'qualified' : 'eliminated') : 'pending',
    };
  });
  return { rows, complete, playedMatches: played, totalMatches: relevant.length };
}
