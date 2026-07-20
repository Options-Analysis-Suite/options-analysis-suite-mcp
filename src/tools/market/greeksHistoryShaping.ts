type GreeksHistoryPoint = {
  market_date?: string;
  delta?: number;
  gamma?: number;
  theta?: number;
  vega?: number;
};

type GreeksHistoryPayload = {
  [key: string]: unknown;
  symbol?: string;
  startDate?: string | null;
  endDate?: string | null;
  dteMin?: number;
  dteMax?: number;
  moneyness?: string;
  data?: unknown;
};

const DEFAULT_RECENT_CAP = 20;
const DEFAULT_TREND_CAP = 12;
const DEFAULT_SUMMARY_POINT_CAP = 90;

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function getPointDate(point: GreeksHistoryPoint): string | undefined {
  return point.market_date;
}

function comparePointsNewestFirst(left: GreeksHistoryPoint, right: GreeksHistoryPoint): number {
  const leftDate = getPointDate(left) ?? '';
  const rightDate = getPointDate(right) ?? '';
  return rightDate.localeCompare(leftDate);
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

function getNumberSeries(points: GreeksHistoryPoint[], key: keyof GreeksHistoryPoint): number[] {
  return points
    .map((point) => point[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function sortGreeksHistoryPoints(points: unknown): GreeksHistoryPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is GreeksHistoryPoint => point != null && typeof point === 'object')
    .slice()
    .sort(comparePointsNewestFirst);
}

export function compactGreeksHistoryPoint(point: GreeksHistoryPoint): Record<string, unknown> {
  return {
    market_date: getPointDate(point),
    delta: round(point.delta),
    gamma: round(point.gamma, 6),
    theta: round(point.theta),
    vega: round(point.vega),
  };
}

export function getGreeksHistoryPointCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const response = payload as GreeksHistoryPayload;
  return sortGreeksHistoryPoints(response.data).length;
}

export function shouldSummarizeGreeksHistory(
  payload: unknown,
  pointCap = DEFAULT_SUMMARY_POINT_CAP,
): boolean {
  return getGreeksHistoryPointCount(payload) > pointCap;
}

export function summarizeGreeksHistory(
  payload: unknown,
  recentCap = DEFAULT_RECENT_CAP,
  trendCap = DEFAULT_TREND_CAP,
): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as GreeksHistoryPayload;
  const sorted = sortGreeksHistoryPoints(response.data);
  if (sorted.length === 0) return payload;

  const latest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const recent = sorted.slice(0, recentCap);
  const recentDates = new Set(recent.map((point) => getPointDate(point)));
  const trendSample = pickEvenlySpaced(sorted, trendCap)
    .filter((point) => !recentDates.has(getPointDate(point)))
    .map(compactGreeksHistoryPoint);

  const deltaSeries = getNumberSeries(sorted, 'delta');
  const gammaSeries = getNumberSeries(sorted, 'gamma');
  const thetaSeries = getNumberSeries(sorted, 'theta');
  const vegaSeries = getNumberSeries(sorted, 'vega');
  const { data, ...rest } = response;

  return {
    ...rest,
    startDate: response.startDate ?? getPointDate(earliest),
    endDate: response.endDate ?? getPointDate(latest),
    pointCount: sorted.length,
    latest: compactGreeksHistoryPoint(latest),
    earliest: compactGreeksHistoryPoint(earliest),
    summary: {
      avgDelta: round(avg(deltaSeries)),
      avgGamma: round(avg(gammaSeries), 6),
      avgTheta: round(avg(thetaSeries)),
      avgVega: round(avg(vegaSeries)),
      deltaChange: round(
        typeof latest.delta === 'number' && typeof earliest.delta === 'number'
          ? latest.delta - earliest.delta
          : undefined,
      ),
      gammaChange: round(
        typeof latest.gamma === 'number' && typeof earliest.gamma === 'number'
          ? latest.gamma - earliest.gamma
          : undefined,
        6,
      ),
      thetaChange: round(
        typeof latest.theta === 'number' && typeof earliest.theta === 'number'
          ? latest.theta - earliest.theta
          : undefined,
      ),
      vegaChange: round(
        typeof latest.vega === 'number' && typeof earliest.vega === 'number'
          ? latest.vega - earliest.vega
          : undefined,
      ),
      maxGamma: round(gammaSeries.length ? Math.max(...gammaSeries) : undefined, 6),
      maxVega: round(vegaSeries.length ? Math.max(...vegaSeries) : undefined),
    },
    data: recent.map(compactGreeksHistoryPoint),
    trendSample,
    _data_meta: {
      summarized: true,
      recent: recent.length,
      trend_samples: trendSample.length,
      total_trading_days: sorted.length,
    },
  };
}

export function trimGreeksHistoryToRecent(payload: unknown, cap: number): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as GreeksHistoryPayload;
  const sorted = sortGreeksHistoryPoints(response.data);
  const { data, ...rest } = response;

  if (sorted.length <= cap) {
    return {
      ...rest,
      data: sorted,
    };
  }

  return {
    ...rest,
    data: sorted.slice(0, cap),
    _data_meta: { showing: cap, total: sorted.length, truncated: true },
  };
}
