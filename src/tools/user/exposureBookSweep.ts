/**
 * The AI Compute run's exposure sweep on the assumed dealer book, as the MCP server reads it (Greek exposure methodology v2
 * ). An INLINE copy of
 * packages/shared/src/compute/exposureBookSweep.ts: the MCP server imports nothing outside itself (its build context is
 * mcp-server/ alone, and the public mirror ships it without packages/shared), so exposureBookSweep.test.ts holds this
 * copy to the shared module's rules case by case.
 *
 * A run's sweep entries are of ONE calculation: the earlier dealer-hedging sweep (`spot`, `aggregateByStrike`, every
 * metric finite, no `exposureCalculation`), or the book entry (`exposureCalculation: 'assumedDealerBook'`, nullable
 * metrics with their coverage, `reference` in place of `spot`, `strikes`).
 */

type CoverageMetric = 'gamma' | 'delta' | 'vega' | 'vanna' | 'charm' | 'vomma';
type CoverageStatus = 'complete' | 'partial' | 'unavailable';
type ReportedMetric = 'gex' | 'vegaExposure' | 'vanna' | 'charmFlow' | 'vomma' | 'putMinusCallDeltaBalance';
type ReferenceKind = 'spot' | 'forward' | 'future';
type RollStatus = 'notApplicable' | 'fitted' | 'insufficientData' | 'rejectedFit';
const COVERAGE_METRICS: ReadonlyArray<CoverageMetric> = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'];
/** complete when every leg was included, unavailable when none was, else partial (the shared coverageStatus) */
function coverageStatus(pair: { included: number; total: number }): CoverageStatus {
  if (pair.included === pair.total) return 'complete';
  return pair.included === 0 ? 'unavailable' : 'partial';
}

export const ASSUMED_DEALER_BOOK = 'assumedDealerBook' as const;
export const EARLIER_DEALER_HEDGING = 'earlierDealerHedging' as const;
export type ExposureCalculation = typeof ASSUMED_DEALER_BOOK | typeof EARLIER_DEALER_HEDGING;

export interface BookSweepCoverage { status: CoverageStatus; included: number; total: number }
export interface BookSweepReported extends BookSweepCoverage { value: number | null }

/** One strike of the book: each side's part and the net, null where unavailable, with each metric's coverage */
export interface BookSweepStrike {
  strike: number;
  callGamma: number | null; putGamma: number | null; gamma: number | null;
  callDelta: number | null; putDelta: number | null; delta: number | null;
  callVega: number | null; putVega: number | null; vega: number | null;
  callVanna: number | null; putVanna: number | null; vanna: number | null;
  callCharm: number | null; putCharm: number | null; charm: number | null;
  callVomma: number | null; putVomma: number | null; vomma: number | null;
  coverage: Record<CoverageMetric, BookSweepCoverage>;
}

export interface BookSweepKeyLevels {
  callWall: number | null;
  putWall: number | null;
  gammaFlip: number | null;
  regime: 'positive-gamma' | 'negative-gamma' | 'unknown';
  gammaTilt: number | null;
}

export interface ExposureBookSweep {
  exposureCalculation: typeof ASSUMED_DEALER_BOOK;
  underlying: string;
  /** The level the book is priced on: the spot, a fitted forward, or the future */
  reference: { kind: ReferenceKind; price: number };
  /** The cash roll of the charm flow; carry a number exactly when fitted */
  roll: { status: RollStatus; carry: number | null };
  /** What the charm flow holds fixed: a cash level, or the forward or future itself */
  charmBasis: 'cash' | 'fixedReference';
  /** The contract multipliers of the chains it was computed from, distinct and ascending */
  multipliers: number[];
  /** The one instant the expiry scope was judged at (ms) */
  scopeAsOf: number;
  timestamp: number;
  keyLevels: BookSweepKeyLevels;
  totals: Record<ReportedMetric, BookSweepReported>;
  /** The strikes the book has; `strikes` may hold fewer (a bounded projection) or be absent (summary-only) */
  strikeCount: number;
  strikes?: BookSweepStrike[];
  strikesTruncated: boolean;
}

export const BOOK_SWEEP_REPORTED_METRICS: ReadonlyArray<ReportedMetric> = ['gex', 'vegaExposure', 'vanna', 'charmFlow', 'vomma', 'putMinusCallDeltaBalance'];
/** Each reported metric's coverage (its legs) */
export const BOOK_SWEEP_COVERAGE_OF: Readonly<Record<ReportedMetric, CoverageMetric>> = {
  gex: 'gamma', vegaExposure: 'vega', vanna: 'vanna', charmFlow: 'charm', vomma: 'vomma', putMinusCallDeltaBalance: 'delta',
};
/** A strike's three fields per coverage metric: the call part, the put part and the net */
export const BOOK_SWEEP_STRIKE_FIELDS: Readonly<Record<CoverageMetric, readonly [keyof BookSweepStrike, keyof BookSweepStrike, keyof BookSweepStrike]>> = {
  gamma: ['callGamma', 'putGamma', 'gamma'],
  delta: ['callDelta', 'putDelta', 'delta'],
  vega: ['callVega', 'putVega', 'vega'],
  vanna: ['callVanna', 'putVanna', 'vanna'],
  charm: ['callCharm', 'putCharm', 'charm'],
  vomma: ['callVomma', 'putVomma', 'vomma'],
};

/** The earlier sweep's charm, as every earlier export and reader has stated it (unchanged) */
export const EARLIER_SWEEP_CHARM_STATEMENT =
  'remaining-maturity sign, per calendar day (charm per year / 365), times open interest, multiplier and spot, '
  + 'negated for the dealer';

/** The book's charm: the hedge flow of the assumed dealer book, per calendar day, on what it holds fixed */
export function bookSweepCharmStatement(charmBasis: ExposureBookSweep['charmBasis']): string {
  return 'the calendar-day hedge flow of the assumed dealer book at 100% of open interest: the dollars of the '
    + 'underlying its hedger trades per calendar day to stay delta-neutral, positive meaning buying, holding '
    + (charmBasis === 'cash' ? 'a cash level fixed' : 'the forward (or the future) fixed');
}

const ROLL_STATUSES: ReadonlySet<string> = new Set(['notApplicable', 'fitted', 'insufficientData', 'rejectedFit']);
const REFERENCE_KINDS: ReadonlySet<string> = new Set(['spot', 'forward', 'future']);
const REGIMES: ReadonlySet<string> = new Set(['positive-gamma', 'negative-gamma', 'unknown']);
const COVERAGE_STATUSES: ReadonlySet<string> = new Set(['complete', 'partial', 'unavailable']);
const UNDERLYING_MAX_LENGTH = 100;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOwn = (v: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(v, key);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const nullableFinite = (v: unknown): v is number | null => v === null || finite(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isDenseArray = (v: unknown): v is unknown[] => Array.isArray(v) && v.every((_, i) => Object.prototype.hasOwnProperty.call(v, i));

/** Whether an entry claims the book (anything else is read as the earlier sweep, never inferred from its values) */
export const isBookSweepClaim = (entry: unknown): boolean => isObject(entry) && entry.exposureCalculation === ASSUMED_DEALER_BOOK;

/** A run's sweep calculation from its entries: none (no entries), one of the two, or mixed (refused everywhere) */
export function sweepCalculationOf(entries: ReadonlyArray<unknown>): ExposureCalculation | 'none' | 'mixed' {
  if (entries.length === 0) return 'none';
  const books = entries.filter(isBookSweepClaim).length;
  if (books === 0) return EARLIER_DEALER_HEDGING;
  return books === entries.length ? ASSUMED_DEALER_BOOK : 'mixed';
}

function coverageViolation(value: unknown): string | null {
  if (!isObject(value) || !COVERAGE_STATUSES.has(String(value.status)) || !count(value.included) || !count(value.total)
    || (value.included as number) > (value.total as number)) return 'malformed coverage';
  if (coverageStatus({ included: value.included as number, total: value.total as number }) !== value.status) return 'a coverage status that does not match its counts';
  return null;
}

/**
 * A metric is null exactly when it is unavailable - except DEX, the put-minus-call delta balance, which the shared book
 * reports as the chain's balance (bases dexBalance) whatever its delta coverage
 */
const nullTracksCoverage = (metric: CoverageMetric): boolean => metric !== 'delta';

function reportedViolation(value: unknown, metric: CoverageMetric): string | null {
  const coverage = coverageViolation(value);
  if (coverage) return coverage;
  const reported = value as Record<string, unknown>;
  if (!hasOwn(reported, 'value') || !nullableFinite(reported.value)) return 'a value that is neither finite nor null';
  if (nullTracksCoverage(metric) && (reported.value === null) !== (reported.status === 'unavailable')) return 'a value null other than exactly when unavailable';
  return null;
}

function strikeViolation(value: unknown): string | null {
  if (!isObject(value) || !finite(value.strike) || !isObject(value.coverage)) return 'a malformed strike';
  for (const metric of COVERAGE_METRICS) {
    const coverage = (value.coverage as Record<string, unknown>)[metric];
    const bad = coverageViolation(coverage);
    if (bad) return `strike ${String(value.strike)} ${metric}: ${bad}`;
    const [call, put, net] = BOOK_SWEEP_STRIKE_FIELDS[metric];
    for (const field of [call, put, net]) {
      if (!hasOwn(value, field) || !nullableFinite(value[field])) return `strike ${String(value.strike)} ${String(field)}: neither finite nor null`;
    }
    if (nullTracksCoverage(metric) && (value[net] === null) !== ((coverage as Record<string, unknown>).status === 'unavailable')) {
      return `strike ${String(value.strike)} ${String(net)}: null other than exactly when unavailable`;
    }
  }
  return null;
}

export type BookSweepStrikesRule = 'complete' | 'bounded' | 'absent';

/**
 * Why a value is not a book entry, or null when it is. `strikes`:
 *   - 'complete': a local record of the run that computed it - every strike present, none truncated;
 *   - 'bounded': a projection that kept the strike detail, possibly cut (strikesTruncated says so);
 *   - 'absent': a summary-only projection - no `strikes`, the count kept.
 */
export function bookSweepViolation(value: unknown, underlyings: ReadonlySet<string>, strikesRule: BookSweepStrikesRule): string | null {
  if (!isObject(value)) return 'not an object';
  if (value.exposureCalculation !== ASSUMED_DEALER_BOOK) return 'not a book entry';
  if (hasOwn(value, 'spot') || hasOwn(value, 'aggregateByStrike') || hasOwn(value, 'aggregateByStrikeTruncated')) return 'an earlier sweep field on a book entry';
  const underlying = value.underlying;
  if (typeof underlying !== 'string' || underlying.length === 0 || underlying.length > UNDERLYING_MAX_LENGTH
    || underlying !== underlying.trim().toUpperCase() || !underlyings.has(underlying)) return 'an underlying outside the run';
  const reference = value.reference;
  if (!isObject(reference) || !REFERENCE_KINDS.has(String(reference.kind)) || !finite(reference.price) || (reference.price as number) <= 0) return 'a malformed reference';
  const roll = value.roll;
  if (!isObject(roll) || !ROLL_STATUSES.has(String(roll.status)) || !hasOwn(roll, 'carry') || !nullableFinite(roll.carry)
    || ((roll.status === 'fitted') !== (roll.carry !== null))) return 'a malformed roll';
  if (value.charmBasis !== 'cash' && value.charmBasis !== 'fixedReference') return 'a malformed charm basis';
  const multipliers = value.multipliers;
  if (!isDenseArray(multipliers) || multipliers.length === 0
    || !multipliers.every((m, i) => finite(m) && m > 0 && (i === 0 || m > (multipliers[i - 1] as number)))) return 'malformed multipliers';
  if (!finite(value.scopeAsOf) || !finite(value.timestamp)) return 'a malformed instant';
  const levels = value.keyLevels;
  if (!isObject(levels) || !REGIMES.has(String(levels.regime))
    || !(['callWall', 'putWall', 'gammaFlip', 'gammaTilt'] as const).every((k) => hasOwn(levels, k) && nullableFinite(levels[k]))) return 'malformed key levels';
  const totals = value.totals;
  if (!isObject(totals)) return 'malformed totals';
  for (const metric of BOOK_SWEEP_REPORTED_METRICS) {
    const bad = reportedViolation(totals[metric], BOOK_SWEEP_COVERAGE_OF[metric]);
    if (bad) return `totals ${metric}: ${bad}`;
  }
  if (!count(value.strikeCount) || typeof value.strikesTruncated !== 'boolean') return 'malformed strike counts';
  const strikeCount = value.strikeCount as number;
  if (strikesRule === 'absent') {
    if (hasOwn(value, 'strikes')) return 'strike detail in a summary-only projection';
    return value.strikesTruncated === (strikeCount > 0) ? null : 'a truncation flag that contradicts the strike count';
  }
  const strikes = value.strikes;
  if (!isDenseArray(strikes)) return 'no strike detail';
  if (strikes.length > strikeCount || value.strikesTruncated !== (strikeCount > strikes.length)) return 'a truncation flag that contradicts the strike count';
  if (strikesRule === 'complete' && strikes.length !== strikeCount) return 'a local record with strikes left out';
  for (let i = 0; i < strikes.length; i += 1) {
    const bad = strikeViolation(strikes[i]);
    if (bad) return bad;
    if (i > 0 && !((strikes[i] as BookSweepStrike).strike > (strikes[i - 1] as BookSweepStrike).strike)) return 'strikes out of order';
  }
  return null;
}

/**
 * Why a run's `exposureSweep` (present) is not readable, or null: no entries, entries all earlier (left to the caller's
 * own earlier rule, `earlier`) or all book, never mixed; a summary-only stage holds no earlier entry. An empty sweep
 * reads in every stage (a restored summary-only record holds one); whether a wire projection may carry the field at
 * all is summaryOnlySweepPresenceOk's question.
 */
export function exposureSweepViolation(
  sweep: unknown,
  underlyings: ReadonlySet<string>,
  stage: 'local' | 'projection' | 'summaryOnly',
  earlier: (entry: unknown) => boolean,
): string | null {
  if (!isDenseArray(sweep)) return 'the sweep is not a dense array';
  const calculation = sweepCalculationOf(sweep);
  if (calculation === 'none') return null;
  if (calculation === 'mixed') return 'a sweep mixing calculations';
  if (calculation === ASSUMED_DEALER_BOOK) {
    const rule: BookSweepStrikesRule = stage === 'local' ? 'complete' : stage === 'projection' ? 'bounded' : 'absent';
    for (const entry of sweep) {
      const bad = bookSweepViolation(entry, underlyings, rule);
      if (bad) return bad;
    }
    return null;
  }
  if (stage === 'summaryOnly') return 'an earlier sweep in a summary-only projection';
  return sweep.every(earlier) ? null : 'a malformed earlier sweep entry';
}

/** Whether a summary-only projection's `exposureSweep` presence is right: present exactly for a book sweep */
export function summaryOnlySweepPresenceOk(data: Record<string, unknown>): boolean {
  if (!hasOwn(data, 'exposureSweep')) return true;
  const sweep = data.exposureSweep;
  return isDenseArray(sweep) && sweep.length > 0 && sweepCalculationOf(sweep) === ASSUMED_DEALER_BOOK;
}
