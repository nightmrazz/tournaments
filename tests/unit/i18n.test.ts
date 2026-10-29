// @vitest-environment node
// Every literal passed to t('…') in the UI must have a Russian translation with the same placeholders.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ru, ruPatterns } from '@/i18n/ru';

const SRC = resolve(__dirname, '../../src');

export function collectKeys(dir = SRC): Set<string> {
  const keys = new Set<string>();
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== 'i18n') collectKeys(p).forEach((k) => keys.add(k));
    } else if (/\.tsx?$/.test(name)) {
      for (const m of readFileSync(p, 'utf8').matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) keys.add(m[1].replace(/\\'/g, "'"));
    }
  }
  return keys;
}

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

describe('Russian translations', () => {
  const keys = collectKeys();

  it('finds the UI strings', () => {
    expect(keys.size).toBeGreaterThan(200);
  });

  it('cover every UI string', () => {
    const missing = [...keys].filter((k) => !(k in ru));
    expect(missing).toEqual([]);
  });

  it('keep the same placeholders', () => {
    const broken = Object.entries(ru).filter(([k, v]) => placeholders(k) !== placeholders(v)).map(([k]) => k);
    expect(broken).toEqual([]);
  });

  it('translate engine and server messages with numbers', () => {
    const tr = (msg: string) => {
      for (const [re, fn] of ruPatterns) { const m = msg.match(re); if (m) return fn(m); }
      return null;
    };
    expect(tr('Group B')).toBe('Группа B');
    expect(tr('Round of 64')).toBe('1/32 финала');
    expect(tr('6 qualifiers → bracket of 8; the top 2 seeds receive a first-round bye.')).toContain('6');
    expect(tr('Capacity cannot be lower than the current number of participants (5).')).toContain('5');
  });
});
