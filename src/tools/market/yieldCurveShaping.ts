type CurvePoint = {
  term?: string | null;
  yield?: number | null;
  index?: number | null;
};

type HistoricalCurvePoint = {
  date?: string | null;
  curve?: CurvePoint[];
};

type YieldCurveResponse = {
  curve?: CurvePoint[];
  currentDate?: string;
  analysis?: {
    shape?: string;
    spread_2_10?: number;
    spread_3m_10y?: number;
    [key: string]: unknown;
  };
  historical?: HistoricalCurvePoint[];
  yieldCurve?: Record<string, unknown>;
  source?: string;
  [key: string]: unknown;
};

const DEFAULT_SAMPLE_COUNT = 4;
const KEY_TERMS = ['1M', '3M', '2Y', '10Y', '30Y'] as const;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(value: number | null, digits = 2): number | null {
  return value == null ? null : Number(value.toFixed(digits));
}

function curveToMap(curve: CurvePoint[] | undefined): Record<string, number | null> {
  const mapped: Record<string, number | null> = {};
  for (const point of Array.isArray(curve) ? curve : []) {
    if (typeof point.term === 'string' && point.term) {
      mapped[point.term] = toNumber(point.yield);
    }
  }
  return mapped;
}

function spread(curveByTerm: Record<string, number | null>, shortTerm: string, longTerm: string): number | null {
  const shortRate = curveByTerm[shortTerm];
  const longRate = curveByTerm[longTerm];
  if (shortRate == null || longRate == null) return null;
  return round(longRate - shortRate);
}

function pickEvenlySpaced<T>(rows: T[], count: number): T[] {
  if (count <= 0 || rows.length <= count) return rows.slice();
  if (count === 1) return [rows[0]];

  const picks: T[] = [];
  const step = (rows.length - 1) / (count - 1);
  const used = new Set<number>();

  for (let i = 0; i < count; i += 1) {
    const index = Math.round(i * step);
    if (!used.has(index)) {
      picks.push(rows[index]);
      used.add(index);
    }
  }

  return picks;
}

function summarizeHistoricalPoint(point: HistoricalCurvePoint): Record<string, unknown> {
  const curveByTerm = curveToMap(point.curve);
  return {
    date: point.date ?? null,
    keyRates: Object.fromEntries(KEY_TERMS.map((term) => [term, curveByTerm[term] ?? null])),
    spreads: {
      twoTen: spread(curveByTerm, '2Y', '10Y'),
      threeMonthTenYear: spread(curveByTerm, '3M', '10Y'),
    },
  };
}

function findCurveExtremes(curveByTerm: Record<string, number | null>): Record<string, unknown> {
  const points = Object.entries(curveByTerm)
    .filter(([, value]) => value != null) as Array<[string, number]>;

  if (points.length === 0) {
    return {
      highestYieldTerm: null,
      highestYield: null,
      lowestYieldTerm: null,
      lowestYield: null,
    };
  }

  const sorted = points.slice().sort((a, b) => a[1] - b[1]);
  const lowest = sorted[0];
  const highest = sorted[sorted.length - 1];

  return {
    highestYieldTerm: highest[0],
    highestYield: highest[1],
    lowestYieldTerm: lowest[0],
    lowestYield: lowest[1],
  };
}

export function summarizeYieldCurve(
  payload: YieldCurveResponse,
  sampleCount = DEFAULT_SAMPLE_COUNT,
): Record<string, unknown> {
  const curveByTerm = curveToMap(payload.curve);
  const curveEntries = Object.keys(curveByTerm).length;

  if (curveEntries === 0) {
    return {
      currentDate: payload.currentDate ?? null,
      curveShape: payload.analysis?.shape ?? null,
      keyRates: {
        '10Y': toNumber((payload.yieldCurve as Record<string, any> | undefined)?.['10Y']?.value) ?? null,
      },
      source: payload.source ?? null,
      _curve_note: 'Full Treasury curve data was not available in this payload; only the fallback benchmark rate was returned.',
    };
  }

  const historical = Array.isArray(payload.historical) ? payload.historical : [];
  const sampledHistory = historical.length > 0
    ? pickEvenlySpaced(historical.slice().reverse(), Math.min(sampleCount, historical.length)).map(summarizeHistoricalPoint)
    : [];
  const oldestHistorical = historical.length > 0 ? summarizeHistoricalPoint(historical[historical.length - 1]) as Record<string, any> : null;
  const currentTwoTen = toNumber(payload.analysis?.spread_2_10) ?? spread(curveByTerm, '2Y', '10Y');
  const currentThreeMonthTenYear = toNumber(payload.analysis?.spread_3m_10y) ?? spread(curveByTerm, '3M', '10Y');
  const oldestTwoTen = oldestHistorical?.spreads?.twoTen ?? null;
  const oldestThreeMonthTenYear = oldestHistorical?.spreads?.threeMonthTenYear ?? null;

  return {
    currentDate: payload.currentDate ?? null,
    curveShape: payload.analysis?.shape ?? null,
    keyRates: Object.fromEntries(KEY_TERMS.map((term) => [term, curveByTerm[term] ?? null])),
    curveByTerm,
    spreads: {
      twoTen: currentTwoTen,
      threeMonthTenYear: currentThreeMonthTenYear,
    },
    inversion: {
      twoTenInverted: currentTwoTen != null ? currentTwoTen < 0 : null,
      threeMonthTenYearInverted: currentThreeMonthTenYear != null ? currentThreeMonthTenYear < 0 : null,
    },
    curveExtremes: findCurveExtremes(curveByTerm),
    trendSummary: oldestHistorical
      ? {
          comparedToDate: oldestHistorical.date ?? null,
          twoTenChange: currentTwoTen != null && oldestTwoTen != null ? round(currentTwoTen - oldestTwoTen) : null,
          threeMonthTenYearChange: currentThreeMonthTenYear != null && oldestThreeMonthTenYear != null
            ? round(currentThreeMonthTenYear - oldestThreeMonthTenYear)
            : null,
          tenYearChange: curveByTerm['10Y'] != null && oldestHistorical.keyRates?.['10Y'] != null
            ? round((curveByTerm['10Y'] as number) - (oldestHistorical.keyRates['10Y'] as number))
            : null,
        }
      : null,
    historicalSample: sampledHistory,
    source: payload.source ?? null,
    ...(historical.length > sampledHistory.length
      ? { _historical_meta: { sampled: sampledHistory.length, total: historical.length, evenly_spaced: true } }
      : {}),
  };
}
