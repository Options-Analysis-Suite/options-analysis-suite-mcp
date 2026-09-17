type OptionsAnalyticsPoint = {
  date?: string;
  spot_price?: number;
  max_pain?: number;
  net_gex?: number;
  net_dex?: number;
  net_vex?: number;
  net_vanna?: number;
  net_charm?: number;
  net_vomma?: number;
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
    + 'expected_move_30d_fraction on each point, avgExpectedMove30dFraction and maxExpectedMove30dFraction in summary',
} as const;

/**
 * Rename the column on every point and attach the units, for the response
 * paths that do NOT go through summarizeOptionsAnalyticsHistory: the `full`
 * path and the ordinary short window (90 rows or fewer). A first fix renamed
 * the field only in the summary, so a 30-day request - the default - still
 * published 0.018 under a name ending in "pct". Everything else on the row
 * and on the payload is passed through as the proxy sent it.
 */
export function labelOptionsAnalyticsHistory<T>(payload: T): T {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const response = payload as OptionsAnalyticsPayload;
  const key = getPointArrayKey(response);
  if (!key) return payload;
  const rows = (response[key] as unknown[]).map((row) => {
    if (row == null || typeof row !== 'object' || Array.isArray(row)) return row;
    if (!('expected_move_pct' in row)) return row;
    const { expected_move_pct, ...rest } = row as Record<string, unknown>;
    return { ...rest, expected_move_30d_fraction: expected_move_pct };
  });
  return { ...response, [key]: rows, units: OPTIONS_ANALYTICS_UNITS } as T;
}

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

export function compactOptionsAnalyticsPoint(point: OptionsAnalyticsPoint): Record<string, unknown> {
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
    dividend_yield: round(point.dividend_yield, 5),
    risk_free_rate: round(point.risk_free_rate, 5),
    net_gex: round(point.net_gex, 0),
    net_dex: round(point.net_dex, 0),
    net_vex: round(point.net_vex, 0),
    net_vanna: round(point.net_vanna, 0),
    net_charm: round(point.net_charm, 0),
    net_vomma: round(point.net_vomma, 0),
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
    .map(compactOptionsAnalyticsPoint);

  const atmIvSeries = getNumberSeries(sorted, getPreferredAtmIv);
  const hv20Series = getNumberSeries(sorted, (point) => point.hv_20d);
  const putCallSeries = getNumberSeries(sorted, (point) => point.put_call_ratio);
  const expectedMoveSeries = getNumberSeries(sorted, (point) => point.expected_move_pct);
  const spotSeries = getNumberSeries(sorted, (point) => point.spot_price);
  const gexSeries = getNumberSeries(sorted, (point) => point.net_gex);
  const dexSeries = getNumberSeries(sorted, (point) => point.net_dex);
  const vexSeries = getNumberSeries(sorted, (point) => point.net_vex);
  const vannaSeries = getNumberSeries(sorted, (point) => point.net_vanna);
  const charmSeries = getNumberSeries(sorted, (point) => point.net_charm);
  const vommaSeries = getNumberSeries(sorted, (point) => point.net_vomma);
  const dividendYieldSeries = getNumberSeries(sorted, (point) => point.dividend_yield);
  const riskFreeRateSeries = getNumberSeries(sorted, (point) => point.risk_free_rate);
  const latestAtmIv = getPreferredAtmIv(latest);
  const earliestAtmIv = getPreferredAtmIv(earliest);
  const { data, history, ...rest } = response;

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
      avgDividendYield: round(avg(dividendYieldSeries), 5),
      latestDividendYield: round(latest.dividend_yield, 5),
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
      maxAbsNetGex: round(maxAbs(gexSeries), 0),
      maxAbsNetDex: round(maxAbs(dexSeries), 0),
      maxAbsNetVex: round(maxAbs(vexSeries), 0),
      maxAbsNetVanna: round(maxAbs(vannaSeries), 0),
      maxAbsNetCharm: round(maxAbs(charmSeries), 0),
      maxAbsNetVomma: round(maxAbs(vommaSeries), 0),
    },
    [dataKey]: recent.map(compactOptionsAnalyticsPoint),
    trendSample,
    [`_${dataKey}_meta`]: {
      summarized: true,
      recent: recent.length,
      trend_samples: trendSample.length,
      total_snapshots: sorted.length,
    },
  };
}
