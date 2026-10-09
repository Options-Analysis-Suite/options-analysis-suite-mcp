/**
 * Rows the broker sent that a live chain could not use (the proxy's omittedRows): a
 * row that failed validation, one with an unusable strike, one the broker itself marked failed, a contract whose
 * quote could not be read. Every live tool here is shaped by hand, so each carries it on purpose: a count the totals
 * leave out must never be only in the proxy's log.
 */
export interface OmittedRows {
  total: number;
  quarantined: number;
  invalidStrike: number;
  notSuccess: number;
  unquoted: number;
}

const KEYS = ['total', 'quarantined', 'invalidStrike', 'notSuccess', 'unquoted'] as const;

/** The proxy's omittedRows, or null when absent, empty or not that shape (never a guessed count). */
export function readOmittedRows(value: unknown): OmittedRows | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const out = {} as OmittedRows;
  for (const key of KEYS) {
    const n = raw[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) return null;
    out[key] = n;
  }
  return out.total > 0 ? out : null;
}

/** The count in words, and what leaves them out. */
export function omittedRowsSentence(omitted: OmittedRows, leftOutOf = 'the totals'): string {
  const parts = [
    omitted.quarantined > 0 ? `${omitted.quarantined} failed validation` : null,
    omitted.invalidStrike > 0 ? `${omitted.invalidStrike} with an unusable strike` : null,
    omitted.notSuccess > 0 ? `${omitted.notSuccess} the broker marked failed` : null,
    omitted.unquoted > 0 ? `${omitted.unquoted} whose quotes could not be read` : null,
  ].filter((part): part is string => part !== null);
  return `The broker sent ${omitted.total} ${omitted.total === 1 ? 'row' : 'rows'} that could not be used (${parts.join(', ')}); ${leftOutOf} leave them out.`;
}
