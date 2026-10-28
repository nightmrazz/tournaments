export type IdFactory = () => string;

export const uuid: IdFactory = () => crypto.randomUUID();

/** Deterministic ids for tests: prefix-1, prefix-2, ... */
export function sequentialIds(prefix = 'id'): IdFactory {
  let n = 0;
  return () => `${prefix}-${++n}`;
}
