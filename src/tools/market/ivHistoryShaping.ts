type IvHistoryPoint = {
  market_date?: string;
  date?: string;
  spot_price?: number;
  call_volume?: number;
  put_volume?: number;
  call_oi?: number;
  put_oi?: number;
  atm_iv?: number;
  atm_iv_30d?: number;
  put_call_ratio?: number;
  volume_oi_ratio?: number;
};

type IvHistoryPayload = {
  [key: string]: unknown;
  symbol?: string;
  days?: number;
  startDate?: string | null;
  endDate?: string | null;
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

function getPreferredIv(point: IvHistoryPoint): number | undefined {
  if (typeof point.atm_iv_30d === 'number' && Number.isFinite(point.atm_iv_30d)) {
    return point.atm_iv_30d;
  }
  if (typeof point.atm_iv === 'number' && Number.isFinite(point.atm_iv)) {
    return point.atm_iv;
  }
  return undefined;
}

function getPointDate(point: IvHistoryPoint): string | undefined {
  return point.market_date ?? point.date;
}

function comparePointsNewestFirst(left: IvHistoryPoint, right: IvHistoryPoint): number {
  const leftDate = getPointDate(left) ?? '';
  const rightDate = getPointDate(right) ?? '';
  return rightDate.localeCompare(leftDate);
}

export function sortIvHistoryPoints(points: unknown): IvHistoryPoint[] {
  if (!Array.isArray(points)) return [];
  return points
    .filter((point): point is IvHistoryPoint => point != null && typeof point === 'object')
    .slice()
    .sort(comparePointsNewestFirst);
}

export function compactIvHistoryPoint(point: IvHistoryPoint): Record<string, unknown> {
  return {
    market_date: getPointDate(point),
    spot_price: round(point.spot_price, 2),
    atm_iv: round(point.atm_iv),
    atm_iv_30d: round(point.atm_iv_30d),
    put_call_ratio: round(point.put_call_ratio),
    volume_oi_ratio: round(point.volume_oi_ratio),
  };
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

function getNumberSeries(points: IvHistoryPoint[], key: keyof IvHistoryPoint): number[] {
  return points
    .map((point) => point[key])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getPointArrayKey(response: IvHistoryPayload): 'data' | 'history' | null {
  if (Array.isArray(response.data)) return 'data';
  if (Array.isArray(response.history)) return 'history';
  return null;
}

export function getIvHistoryPointCount(payload: unknown): number {
  if (payload == null || typeof payload !== 'object') return 0;
  const response = payload as IvHistoryPayload;
  const dataKey = getPointArrayKey(response);
  if (!dataKey) return 0;
  return sortIvHistoryPoints(response[dataKey]).length;
}

export function shouldSummarizeIvHistory(payload: unknown, pointCap = DEFAULT_SUMMARY_POINT_CAP): boolean {
  return getIvHistoryPointCount(payload) > pointCap;
}

export function summarizeIvHistory(
  payload: unknown,
  recentCap = DEFAULT_RECENT_CAP,
  trendCap = DEFAULT_TREND_CAP,
): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as IvHistoryPayload;
  const dataKey = getPointArrayKey(response);
  if (!dataKey) return payload;

  const sorted = sortIvHistoryPoints(response[dataKey]);
  if (sorted.length === 0) return payload;

  const latest = sorted[0];
  const earliest = sorted[sorted.length - 1];
  const recent = sorted.slice(0, recentCap);
  const recentDates = new Set(recent.map((point) => getPointDate(point)));
  const trendSample = pickEvenlySpaced(sorted, trendCap)
    .filter((point) => !recentDates.has(getPointDate(point)))
    .map(compactIvHistoryPoint);

  const latestIv = getPreferredIv(latest);
  const earliestIv = getPreferredIv(earliest);
  const atmIvSeries = sorted
    .map(getPreferredIv)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const spotSeries = getNumberSeries(sorted, 'spot_price');
  const putCallSeries = getNumberSeries(sorted, 'put_call_ratio');
  const volumeOiSeries = getNumberSeries(sorted, 'volume_oi_ratio');
  const { data, history, ...rest } = response;

  return {
    ...rest,
    startDate: response.startDate ?? getPointDate(earliest),
    endDate: response.endDate ?? getPointDate(latest),
    pointCount: sorted.length,
    latest: compactIvHistoryPoint(latest),
    earliest: compactIvHistoryPoint(earliest),
    summary: {
      avgAtmIv: round(avg(atmIvSeries)),
      minAtmIv: round(atmIvSeries.length ? Math.min(...atmIvSeries) : undefined),
      maxAtmIv: round(atmIvSeries.length ? Math.max(...atmIvSeries) : undefined),
      atmIvChange: round(
        typeof latestIv === 'number' && typeof earliestIv === 'number'
          ? latestIv - earliestIv
          : undefined,
      ),
      avgSpotPrice: round(avg(spotSeries), 2),
      minSpotPrice: round(spotSeries.length ? Math.min(...spotSeries) : undefined, 2),
      maxSpotPrice: round(spotSeries.length ? Math.max(...spotSeries) : undefined, 2),
      spotChangePct: round(
        typeof latest.spot_price === 'number'
          && typeof earliest.spot_price === 'number'
          && earliest.spot_price !== 0
          ? ((latest.spot_price - earliest.spot_price) / earliest.spot_price) * 100
          : undefined,
        2,
      ),
      avgPutCallRatio: round(avg(putCallSeries)),
      maxVolumeOiRatio: round(volumeOiSeries.length ? Math.max(...volumeOiSeries) : undefined),
    },
    [dataKey]: recent.map(compactIvHistoryPoint),
    trendSample,
    [`_${dataKey}_meta`]: {
      summarized: true,
      recent: recent.length,
      trend_samples: trendSample.length,
      total_trading_days: sorted.length,
    },
  };
}

export function trimIvHistoryToRecent(payload: unknown, cap: number): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const response = payload as IvHistoryPayload;
  const dataKey = getPointArrayKey(response);
  if (!dataKey) return payload;

  const sorted = sortIvHistoryPoints(response[dataKey]);
  const { data, history, ...rest } = response;
  if (sorted.length <= cap) {
    return {
      ...rest,
      [dataKey]: sorted,
    };
  }

  return {
    ...rest,
    [dataKey]: sorted.slice(0, cap),
    [`_${dataKey}_meta`]: { showing: cap, total: sorted.length, truncated: true },
  };
}
