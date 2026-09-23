/**
 * One rule for which expirations an end-of-day summary shows.
 *
 * A file can hold twenty-five expirations; a summary shows six. Taking the
 * first six by date gave the IV surface a "term structure" of 0 to 12 days
 * with no 30, 60 or 90-day point, while the chain beside it spread its six
 * from 2 to 184 days. The chain's rule now serves both: one expiration per
 * tenor bucket, nearest first, then the earliest remaining until the cap.
 *
 * SAME-DAY EXPIRY. An end-of-day file carries the expiry that ended that
 * session, at zero time to expiry (AAPL on 2026-09-16 held 47 rows expiring
 * 2026-09-16). Its "ATM" and "25-delta" contracts are the same contract, its
 * wing IVs are 80% to 180%, and its smoothed IV sits outside both sides. It is
 * not a point on a term structure and is skipped whenever a later expiration
 * exists. A file that holds only the same-day expiry is still that file, so
 * with nothing later it stays: an empty summary of data that exists is the
 * wrong answer.
 */

export type ExpirationSample = {
  expiration: string;
  /** Calendar days to expiry; a group whose days are unknown ranks last and is never treated as same-day. */
  dte: number;
};

const TENOR_BUCKETS: Array<{ minDte: number; maxDte: number }> = [
  { minDte: 0, maxDte: 7 },
  { minDte: 8, maxDte: 21 },
  { minDte: 22, maxDte: 45 },
  { minDte: 46, maxDte: 90 },
  { minDte: 91, maxDte: 180 },
  { minDte: 181, maxDte: Number.POSITIVE_INFINITY },
];

/** Same-day means under one calendar day to expiry; unknown is not same-day. */
export function isSameDayExpiry(dte: number | null | undefined): boolean {
  return typeof dte === 'number' && Number.isFinite(dte) && dte < 1;
}

export function compareByDte<T extends ExpirationSample>(left: T, right: T): number {
  if (left.dte !== right.dte) return left.dte - right.dte;
  return left.expiration.localeCompare(right.expiration);
}

/**
 * Pick up to `max` groups across the curve, in DTE order. The first group in
 * `allGroups` order that falls in each tenor bucket is taken, so callers that
 * want the nearest expiration per bucket pass their groups sorted by DTE.
 */
export function sampleExpirationsAcrossCurve<T extends ExpirationSample>(allGroups: T[], max: number): T[] {
  const selected = new Map<string, T>();
  const later = allGroups.filter((group) => !isSameDayExpiry(group.dte));
  const groups = later.length > 0 ? later : allGroups;

  for (const bucket of TENOR_BUCKETS) {
    const match = groups.find((group) => group.dte >= bucket.minDte && group.dte <= bucket.maxDte);
    if (match) selected.set(match.expiration, match);
  }

  if (selected.size < max) {
    for (const group of groups) {
      if (selected.size >= max) break;
      if (!selected.has(group.expiration)) selected.set(group.expiration, group);
    }
  }

  return Array.from(selected.values()).sort(compareByDte).slice(0, max);
}
