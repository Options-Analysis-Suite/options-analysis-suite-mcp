import { collapseProvenance } from './provenanceShaping.js';
import { bookOfWire, charmBasisOf, COVERAGE_METRICS, hoistCommonFields, isWireBases, publicSnapshotId, publicUnavailable, qualifierText, v2ReasonText, V2_BOOK_TEXT, type CoverageMetric, type WireBases } from '../exposureMethodology.js';

type OptionsAnalyticsPoint = {
  date?: string;
  spot_price?: number;
  max_pain?: number;
  atm_iv?: number;
  atm_iv_30d?: number;
  hv_20d?: number;
  hv_60d?: number;
  iv_rank?: number;
  iv_percentile?: number;
  put_call_ratio?: number;
  expected_move_pct?: number;
  term_structure_slope?: number;
  iv_skew_25d?: number;
  vwiv?: number;
  dividend_yield?: number;
  risk_free_rate?: number;
};

type OptionsAnalyticsPayload = {
  [key: string]: unknown;
  symbol?: string;
  interval?: string;
  count?: number;
  data?: unknown;
  history?: unknown;
};

const DEFAULT_RECENT_CAP = 20;
const DEFAULT_TREND_CAP = 12;
const DEFAULT_SUMMARY_POINT_CAP = 90;

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function getPreferredAtmIv(point: OptionsAnalyticsPoint): number | undefined {
  if (typeof point.atm_iv_30d === 'number' && Number.isFinite(point.atm_iv_30d)) {
    return point.atm_iv_30d;
  }
  if (typeof point.atm_iv === 'number' && Number.isFinite(point.atm_iv)) {
    return point.atm_iv;
  }
  return undefined;
}

function getPointDate(point: OptionsAnalyticsPoint): string | undefined {
  return point.date;
}

function comparePointsNewestFirst(left: OptionsAnalyticsPoint, right: OptionsAnalyticsPoint): number {
  return (right.date ?? '').localeCompare(left.date ?? '');
}

function getPointArrayKey(response: OptionsAnalyticsPayload): 'data' | 'history' | null {
  if (Array.isArray(response.data)) return 'data';
  if (Array.isArray(response.history)) return 'history';
  return null;
}

/**
 * option_ticker_snapshots.expected_move_pct is iv * sqrt(30 / 365): a decimal
 * FRACTION of spot over 30 calendar days despite the column name. Stated once
 * and attached to every response shape this tool can return.
 */
export const OPTIONS_ANALYTICS_UNITS = {
  expectedMove30dFraction: 'decimal fraction of spot over the next 30 calendar days (0.018 = 1.8%); '
    + 'expectedMove30dFraction on each point, avgExpectedMove30dFraction and maxExpectedMove30dFraction in the summary shape (returned only past 90 rows)',
} as const;

/**
 * Rename the column on every point and attach the units, for the response
 * paths that do NOT go through summarizeOptionsAnalyticsHistory: the `full`
 * path and the ordinary short window (90 rows or fewer). A first fix renamed
 * the field only in the summary, so a 30-day request - the default - still
 * published 0.018 under a name ending in "pct". Everything else on the row
 * and on the payload is passed through as the proxy sent it.
 */
/**
 * UNWRITTEN_COLUMNS: option_ticker_snapshots.dividend_yield is 0 on every row
 * the producer has ever written (24 positive rows in 21.3 million on
 * 2026-09-18), because scan_strikes.div_rate, which it is the median of, is
 * the data vendor's per-strike divRate and that is 0 on all 1,009,414 rows of a session.
 * Published, AAPL read as "pays no dividend" on every path of this tool: the
 * compact point, the earliest/latest, the two aggregates, and the raw rows the
 * short and `full` paths carry. The snapshot tool withholds it for the same
 * reason (optionsSnapshotShaping SCALARS). Nothing here says the yield is
 * zero until the stored value is real.
 */
export function labelOptionsAnalyticsHistory<T>(payload: T): T {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const response = payload as OptionsAnalyticsPayload;
  const key = getPointArrayKey(response);
  if (!key) return payload;
  const rows = (response[key] as unknown[]).map((row) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return row;
    // dividend_yield is withheld on every path (see UNWRITTEN_COLUMNS); the
    // expected move is renamed to its unit.
    const { expected_move_pct, dividend_yield: _unwritten, ...rest } = row as Record<string, unknown>;
    if (!('expected_move_pct' in row)) return rest;
    return { ...rest, expected_move_30d_fraction: expected_move_pct };
  });
  // Every raw path ends here, so this is where the raw shape says which way
  // it runs (the proxy sorts ascending, history-backtest.ts), beside the
  // trim meta the 30-day default writes first. The summary says its own.
  const metaKey = `_${key}_meta`;
  const meta = response[metaKey];
  const priorMeta = meta != null && typeof meta === 'object' && !Array.isArray(meta) ? meta as Record<string, unknown> : {};
  return {
    ...collapseProvenance(response),
    [key]: rows,
    [metaKey]: { ...priorMeta, order: 'oldest first' },
    units: OPTIONS_ANALYTICS_UNITS,
  } as T;
}


// ---------------------------------------------------------------------------------------------------------------
// The exposure columns are the assumed dealer book. The route's rows (asked with `exposure=v2`, proxy/routes/history-backtest.ts)
// carry the levels engine's net columns AND the book: a day's resolved bases (proxy/lib/historyExposureV2.ts
// dailyExposureV2) or a bucket's averaged ones (bucketExposureV2). Each row's net columns go (the per-strike gamma
// concentration with them: no past session keeps the book's strike curve), and the assumed dealer book's six numbers
// stand in their place through the book() twin, with what they cover where it is not everything.

/** The net columns the route still sends beside the book, never forwarded */
export const NET_EXPOSURE_COLUMNS = ['net_gex', 'net_dex', 'net_vex', 'net_vanna', 'net_charm', 'net_vomma', 'gamma_concentration'] as const;
/** The book's six numbers on a point, in the compact shape's order */
export const BOOK_POINT_KEYS = ['gex', 'putMinusCallDeltaBalance', 'vegaExposure', 'vanna', 'charmFlow', 'vomma'] as const;
const BOOK_NAME: Record<CoverageMetric, (typeof BOOK_POINT_KEYS)[number]> = {
  gamma: 'gex', delta: 'putMinusCallDeltaBalance', vega: 'vegaExposure', vanna: 'vanna', charm: 'charmFlow', vomma: 'vomma',
};

// The route's refusals are fixed transport texts (historyExposureV2.ts NO_ROW, READ_FAILED and the BUCKET_ ones), read
// here into words that name no calculation; any other reason is the stored row's own (fromStoredBases) and goes out as
// one fixed phrase.
const ROUTE_REASON_WORDS: Record<string, string> = {
  'no methodology-2 row': v2ReasonText('no methodology-2 row'),
  'the methodology-2 rows could not be read': v2ReasonText('the methodology-2 rows could not be read'),
  'no methodology-2 row in this period': 'the assumed dealer book is not published for any session in this period',
  'every methodology-2 row in this period is unreadable': 'every stored book in this period is unreadable',
  'no readable methodology-2 row in this period': 'no stored book in this period could be read',
};
const UNREADABLE_ROW = 'the stored book is unreadable';
const NO_BOOK_IN_ANSWER = 'the answer carries no book for this point';

const ROLL_WORDS: Record<string, string> = { fitted: 'fitted', insufficientData: 'insufficient data', rejectedFit: 'fit rejected', notApplicable: 'not applicable' };


/** The six numbers and what they cover, from wire bases; the coverage only where not complete */
function bookFields(bases: WireBases): { values: Record<string, number | null>; coverage: Record<string, unknown> | null } {
  const book = bookOfWire(bases);
  const values: Record<string, number | null> = { ...book.assumedDealerBook, putMinusCallDeltaBalance: book.putMinusCallDeltaBalance };
  const coverage: Record<string, unknown> = {};
  for (const metric of COVERAGE_METRICS) {
    const pair = book.coverage[metric];
    if (pair.status !== 'complete') coverage[BOOK_NAME[metric]] = { status: pair.status, included: pair.included, total: pair.total };
  }
  return { values: Object.fromEntries(BOOK_POINT_KEYS.map((key) => [key, values[key] ?? null])), coverage: Object.keys(coverage).length > 0 ? coverage : null };
}

function referenceFields(referenceKind: unknown, roll: { status?: unknown; carry?: unknown } | undefined): Record<string, unknown> {
  const kind = typeof referenceKind === 'string' ? referenceKind : 'unknown';
  const status = typeof roll?.status === 'string' ? roll.status : 'notApplicable';
  return {
    referenceKind: kind,
    charmBasis: charmBasisOf(kind, status),
    ...(kind !== 'spot' ? { roll: ROLL_WORDS[status] ?? status, ...(status === 'fitted' && typeof roll?.carry === 'number' ? { carry: roll.carry } : {}) } : {}),
  };
}

const nullValues = (): Record<string, null> => Object.fromEntries(BOOK_POINT_KEYS.map((key) => [key, null]));

/** One row's book fields from the route's book (a day's or a bucket's) */
function bookFieldsOf(raw: unknown): Record<string, unknown> {
  const answer = raw as Record<string, any> | null;
  if (!answer || typeof answer !== 'object') return { ...nullValues(), exposureUnavailable: NO_BOOK_IN_ANSWER };
  const isBucket = typeof answer.days === 'number';
  const days = isBucket ? { exposureDays: { days: answer.days, withRow: answer.rows, missing: answer.missing, unreadable: answer.unreadable } } : {};
  const reasonOf = (reason: unknown) => (typeof reason === 'string' && Object.hasOwn(ROUTE_REASON_WORDS, reason) ? ROUTE_REASON_WORDS[reason] : UNREADABLE_ROW);
  if (answer.available !== true || !isWireBases(answer.bases)) {
    return { ...nullValues(), exposureUnavailable: answer.available === true ? UNREADABLE_ROW : reasonOf(answer.reason), ...days };
  }
  const { values, coverage } = bookFields(answer.bases);
  const status: Record<string, unknown> = {};
  if (coverage) status.coverage = coverage;
  if (isBucket) {
    // a metric averaged over fewer days than the bucket has rows, or over a partial day
    const metricDays: Record<string, unknown> = {};
    for (const metric of COVERAGE_METRICS) {
      const d = answer.metricDays?.[metric];
      if (d && (d.partial > 0 || d.unavailable > 0)) metricDays[BOOK_NAME[metric]] = { averaged: d.complete + d.partial, partial: d.partial, unavailable: d.unavailable };
    }
    if (Object.keys(metricDays).length > 0) status.metricDays = metricDays;
    const q = answer.expiryQualified ?? {};
    const qualified = Object.fromEntries(Object.entries({ mayInclude: q.mayInclude, affected: q.affected, unscoped: q.unscoped }).filter(([, n]) => typeof n === 'number' && n > 0));
    if (Object.keys(qualified).length > 0) status.expiryQualifiedDays = qualified;
    const rolls = Object.entries(answer.rolls ?? {}).filter(([, n]) => typeof n === 'number' && n > 0);
    if (rolls.length > 1) status.rolls = Object.fromEntries(rolls.map(([s, n]) => [ROLL_WORDS[s] ?? s, n]));
  } else {
    const qualifier = qualifierText(answer.expiryQualifier);
    if (qualifier) status.expiryQualifier = qualifier;
  }
  let reference: Record<string, unknown> = {};
  if (!isBucket) reference = referenceFields(answer.referenceKind, answer.roll);
  else {
    // a period's days by reference kind (the route's referenceKinds) and by roll: one charm basis only when
    // every day has the same of each, else their counts (an older answer without the kinds states no reference)
    const counted = (record: unknown) => Object.entries((record ?? {}) as Record<string, unknown>).filter(([, n]) => typeof n === 'number' && n > 0);
    const kinds = counted(answer.referenceKinds);
    const rolls = counted(answer.rolls);
    if (kinds.length === 1 && rolls.length === 1) reference = referenceFields(kinds[0][0], { status: rolls[0][0] });
    else if (kinds.length > 1) status.referenceKinds = Object.fromEntries(kinds);
  }
  return { ...values, ...reference, ...(Object.keys(status).length > 0 ? { exposureStatus: status } : {}), ...days };
}

/** Whether a point's book numbers are short of complete (partial legs, partial or missing days), qualified, or unavailable */
export function bookPointStanding(point: Record<string, any>): 'unavailable' | 'qualified' | 'partial' | 'complete' {
  if (typeof point.exposureUnavailable === 'string') return 'unavailable';
  const status = point.exposureStatus;
  if (status?.expiryQualifier || status?.expiryQualifiedDays) return 'qualified';
  if (status?.coverage || status?.metricDays) return 'partial';
  // a period missing a day, or with one unreadable, averages fewer days than it spans
  const days = point.exposureDays;
  if (days && (days.missing > 0 || days.unreadable > 0)) return 'partial';
  return 'complete';
}

/**
 * The route's answer as the book's rows: every row's net columns and its route book replaced by the six numbers and
 * their standing, and the reference fields every row shares sent once as `exposuresCommon`.
 */
export function bookHistory<T>(payload: T): T {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const response = payload as OptionsAnalyticsPayload;
  const key = getPointArrayKey(response);
  if (!key) return payload;
  const rows = (response[key] as unknown[]).map((row) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return row;
    const { exposureV2: routeBook, ...rest } = row as Record<string, unknown>;
    for (const column of NET_EXPOSURE_COLUMNS) delete rest[column];
    return { ...rest, ...bookFieldsOf(routeBook) };
  });
  // a point without book numbers has no reference to share; one with numbers and no reference keeps every row's
  const common = hoistCommonFields(rows.filter((row) => !!row && typeof row === 'object' && typeof (row as Record<string, unknown>).exposureUnavailable !== 'string'));
  // a read of the stored books that failed (the route's partial, unavailable: ['exposureV2']): named as `exposures`, with
  // what it means for the points
  const bookUnread = Array.isArray(response.unavailable) && response.unavailable.includes('exposureV2');
  // the provenance identifiers, wherever the route repeats them (top level, metadata, provenance), in their public form
  const record = response as Record<string, unknown>;
  const ids: Record<string, unknown> = {};
  for (const key of ['historySnapshotId', 'snapshotId'] as const) if (typeof record[key] === 'string') ids[key] = publicSnapshotId(record[key]);
  for (const nested of ['metadata', 'provenance'] as const) {
    const block = record[nested];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const copy = { ...(block as Record<string, unknown>) };
      for (const key of ['historySnapshotId', 'snapshotId'] as const) if (typeof copy[key] === 'string') copy[key] = publicSnapshotId(copy[key]);
      ids[nested] = copy;
    }
  }
  return {
    ...response,
    [key]: rows,
    ...ids,
    ...(common ? { exposuresCommon: common } : {}),
    ...(Array.isArray(response.unavailable) ? { unavailable: publicUnavailable(response.unavailable) } : {}),
    ...(bookUnread ? { partialNote: HISTORY_BOOK_UNREAD } : {}),
  } as T;
}

/** What a failed read of the stored books means for the answer */
export const HISTORY_BOOK_UNREAD = 'The stored books could not be read on this call, so the points\' exposures are missing (null, with exposureUnavailable), not zero.';

/** The history's book note, sent once on every answer as `bookNote` */
export const HISTORY_BOOK_NOTE = 'Each point carries ' + V2_BOOK_TEXT + ', and putMinusCallDeltaBalance '
  + '(USD, underlying-equivalent), over every expiration after the session where the expiry rule is proven (a point whose '
  + 'exposureStatus carries an expiryQualifier may count contracts expiring that day); gamma concentration is not sent '
  + '(no past session keeps the book\'s strike curve). referenceKind and '
  + 'charmBasis ("cash": charm on the cash price; "fixed reference": on the forward or future held fixed) are the point\'s, or '
  + '`exposuresCommon`\'s when every point shares them. `exposureStatus`, only where a point is not complete and proven: coverage '
  + '(a number summing only the legs included), expiryQualifier (a day whose values may count what the expiry rule leaves out), '
  + 'and on a weekly, biweekly or monthly point metricDays (a number averaged over fewer days than the point has rows, or over '
  + 'partial days: averaged, partial, unavailable), expiryQualifiedDays, and rolls and referenceKinds (the days of each, when they '
  + 'differ: then no one charmBasis holds for the period). A period point is the mean of its days\' books and carries '
  + 'exposureDays {days, withRow, missing, unreadable}. A point without a stored book is a gap: its six numbers are null and '
  + 'exposureUnavailable says why.';

export function sortOptionsAnalyticsPoints(points: unknown): OptionsAnalyticsPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is OptionsAnalyticsPoint => point != null && typeof point === 'object')
    .slice()
    .sort(comparePointsNewestFirst);
}

function pickEvenlySpaced<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return [];
  if (count === 1) return [items[0]];
  if (items.length <= count) return items;
  const chosen: T[] = [];
  const used = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const position = Math.round((index * (items.length - 1)) / (count - 1));
    if (used.has(position)) continue;
    used.add(position);
    chosen.push(items[position]);
  }
  return chosen;
}

function getNumberSeries(points: OptionsAnalyticsPoint[], mapper: (point: OptionsAnalyticsPoint) => number | undefined): number[] {
  return points
    .map(mapper)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxAbs(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.max(...values.map((value) => Math.abs(value)));
}

// a point's own reference and standing, kept on the compact shape as it came
const BOOK_POINT_PASSTHROUGH = ['referenceKind', 'charmBasis', 'roll', 'carry', 'exposureStatus', 'exposureDays', 'exposureUnavailable'] as const;

export function compactOptionsAnalyticsPoint(point: OptionsAnalyticsPoint): Record<string, unknown> {
  const book = point as Record<string, unknown>;
  return {
    ...compactBasePoint(point),
    // a null is a point without that book number (exposureUnavailable or its coverage says why), never omitted
    ...Object.fromEntries(BOOK_POINT_KEYS.map((key) => [key, book[key] === null ? null : round(book[key], 0)])),
    ...Object.fromEntries(BOOK_POINT_PASSTHROUGH.filter((key) => book[key] !== undefined).map((key) => [key, book[key]])),
  };
}

function compactBasePoint(point: OptionsAnalyticsPoint): Record<string, unknown> {
  return {
    date: getPointDate(point),
    spot_price: round(point.spot_price, 2),
    max_pain: round(point.max_pain, 2),
    atm_iv: round(getPreferredAtmIv(point)),
    hv_20d: round(point.hv_20d),
    hv_60d: round(point.hv_60d),
    iv_rank: round(point.iv_rank),
    iv_percentile: round(point.iv_percentile),
    put_call_ratio: round(point.put_call_ratio),
    // The column is iv * sqrt(30 / 365): a decimal FRACTION of spot over 30
    // calendar days despite its name, so the name does not reach the reader.
    expected_move_30d_fraction: round(point.expected_move_pct),
    term_structure_slope: round(point.term_structure_slope, 5),
    iv_skew_25d: round(point.iv_skew_25d),
    vwiv: round(point.vwiv),
    // No dividend_yield: see UNWRITTEN_COLUMNS.
    risk_free_rate: round(point.risk_free_rate, 5),
  };
}

export function getOptionsAnalyticsPointCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const response = payload as OptionsAnalyticsPayload;
  const dataKey = getPointArrayKey(response);
  if (!dataKey) return 0;
  return sortOptionsAnalyticsPoints(response[dataKey]).length;
}

export function shouldSummarizeOptionsAnalyticsHistory(payload: unknown, pointCap = DEFAULT_SUMMARY_POINT_CAP): boolean {
  return getOptionsAnalyticsPointCount(payload) > pointCap;
}

export function summarizeOptionsAnalyticsHistory(
  payload: unknown,
  recentCap = DEFAULT_RECENT_CAP,
  trendCap = DEFAULT_TREND_CAP,
): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as OptionsAnalyticsPayload;
  const dataKey = getPointArrayKey(response);
  if (!dataKey) return payload;

  const sorted = sortOptionsAnalyticsPoints(response[dataKey]);
  if (sorted.length === 0) return payload;

  const latest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const recent = sorted.slice(0, recentCap);
  const recentDates = new Set(recent.map((point) => getPointDate(point)));
  const trendSample = pickEvenlySpaced(sorted, trendCap)
    .filter((point) => !recentDates.has(getPointDate(point)))
    .map((point) => compactOptionsAnalyticsPoint(point));

  const atmIvSeries = getNumberSeries(sorted, getPreferredAtmIv);
  const hv20Series = getNumberSeries(sorted, (point) => point.hv_20d);
  const putCallSeries = getNumberSeries(sorted, (point) => point.put_call_ratio);
  const expectedMoveSeries = getNumberSeries(sorted, (point) => point.expected_move_pct);
  const spotSeries = getNumberSeries(sorted, (point) => point.spot_price);
  const bookSeries = (key: (typeof BOOK_POINT_KEYS)[number]) => getNumberSeries(sorted, (point) => {
    const value = (point as Record<string, unknown>)[key];
    return typeof value === 'number' ? value : undefined;
  });
  // the extremes say how many points they stand on were short of complete
  const standings = sorted.map((point) => bookPointStanding(point as Record<string, any>));
  const exposureExtremes = {
    maxAbsGex: round(maxAbs(bookSeries('gex')), 0),
    maxAbsPutMinusCallDeltaBalance: round(maxAbs(bookSeries('putMinusCallDeltaBalance')), 0),
    maxAbsVegaExposure: round(maxAbs(bookSeries('vegaExposure')), 0),
    maxAbsVanna: round(maxAbs(bookSeries('vanna')), 0),
    maxAbsCharmFlow: round(maxAbs(bookSeries('charmFlow')), 0),
    maxAbsVomma: round(maxAbs(bookSeries('vomma')), 0),
    exposurePoints: {
      total: standings.length,
      partial: standings.filter((s) => s === 'partial').length,
      qualified: standings.filter((s) => s === 'qualified').length,
      unavailable: standings.filter((s) => s === 'unavailable').length,
    },
  };
  const riskFreeRateSeries = getNumberSeries(sorted, (point) => point.risk_free_rate);
  const latestAtmIv = getPreferredAtmIv(latest);
  const earliestAtmIv = getPreferredAtmIv(earliest);
  // Collapsed here as on the raw path: a first fix reached only
  // labelOptionsAnalyticsHistory, and a 400-day request still carried the
  // provenance three times.
  const { data, history, ...rest } = collapseProvenance(response);

  return {
    ...rest,
    count: sorted.length,
    startDate: getPointDate(earliest),
    endDate: getPointDate(latest),
    latest: compactOptionsAnalyticsPoint(latest),
    earliest: compactOptionsAnalyticsPoint(earliest),
    units: OPTIONS_ANALYTICS_UNITS,
    summary: {
      avgAtmIv: round(avg(atmIvSeries)),
      minAtmIv: round(atmIvSeries.length ? Math.min(...atmIvSeries) : undefined),
      maxAtmIv: round(atmIvSeries.length ? Math.max(...atmIvSeries) : undefined),
      atmIvChange: round(
        typeof latestAtmIv === 'number' && typeof earliestAtmIv === 'number'
          ? latestAtmIv - earliestAtmIv
          : undefined,
      ),
      avgHv20d: round(avg(hv20Series)),
      avgPutCallRatio: round(avg(putCallSeries)),
      avgExpectedMove30dFraction: round(avg(expectedMoveSeries)),
      maxExpectedMove30dFraction: round(expectedMoveSeries.length ? Math.max(...expectedMoveSeries) : undefined),
      avgRiskFreeRate: round(avg(riskFreeRateSeries), 5),
      latestRiskFreeRate: round(latest.risk_free_rate, 5),
      spotChangePct: round(
        typeof latest.spot_price === 'number'
          && typeof earliest.spot_price === 'number'
          && earliest.spot_price !== 0
          ? ((latest.spot_price - earliest.spot_price) / earliest.spot_price) * 100
          : undefined,
        2,
      ),
      latestIvRank: round(latest.iv_rank),
      latestIvPercentile: round(latest.iv_percentile),
      ...exposureExtremes,
    },
    [dataKey]: recent.map((point) => compactOptionsAnalyticsPoint(point)),
    trendSample,
    [`_${dataKey}_meta`]: {
      summarized: true,
      // The raw shape is the proxy's ascending order; this one is not.
      order: 'newest first',
      recent: recent.length,
      trend_samples: trendSample.length,
      total_snapshots: sorted.length,
    },
  };
}
