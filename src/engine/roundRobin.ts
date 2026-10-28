export interface Pairing {
  round: number; // 1-based matchday
  home: string;
  away: string;
}

/**
 * Circle-method round robin. Every pair meets exactly once (twice with `double`, sides swapped).
 * With an odd number of entrants one entrant rests each matchday.
 * Home/away is alternated so nobody is "home" in every match.
 */
export function roundRobin(ids: readonly string[], double = false): Pairing[] {
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate participant in round robin');
  if (ids.length < 2) return [];
  const BYE = '\u0000bye';
  const list = ids.length % 2 === 0 ? [...ids] : [...ids, BYE];
  const n = list.length;
  const rounds = n - 1;
  const out: Pairing[] = [];
  const homeCount = new Map<string, number>(ids.map((id) => [id, 0]));
  const rotating = list.slice(1);
  for (let r = 0; r < rounds; r++) {
    const current = [list[0], ...rotating];
    for (let i = 0; i < n / 2; i++) {
      const a = current[i];
      const b = current[n - 1 - i];
      if (a === BYE || b === BYE) continue;
      // Whoever has hosted fewer matches so far plays at home; ties alternate by round parity.
      const ha = homeCount.get(a) as number;
      const hb = homeCount.get(b) as number;
      const aHome = ha !== hb ? ha < hb : (r + i) % 2 === 0;
      const home = aHome ? a : b;
      homeCount.set(home, (homeCount.get(home) as number) + 1);
      out.push({ round: r + 1, home, away: aHome ? b : a });
    }
    rotating.unshift(rotating.pop() as string);
  }
  if (double) {
    const second = out.map((p) => ({ round: p.round + rounds, home: p.away, away: p.home }));
    out.push(...second);
  }
  return out;
}

/** Number of fixtures a single round robin of n entrants produces. */
export function roundRobinMatchCount(n: number, double = false): number {
  const single = (n * (n - 1)) / 2;
  return double ? single * 2 : single;
}
