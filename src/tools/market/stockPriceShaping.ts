type StockPriceRow = {
  [key: string]: unknown;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

/** The proxy's response header naming the symbol's stock history state. */
export const HISTORY_STATE_HEADER = 'X-Stock-History-State';
const HISTORY_STATES = new Set(['current', 'pending_split', 'held', 'not_applicable']);

/**
 * A line for the reader when the history may not be refreshed. `pending_split`:
 * a split is due with a refresh still outstanding for it (an earlier refresh
 * may already cover it; the requirement is what is known); `held`: the price
 * history is held for review (a review hold on the symbol, or its latest
 * refresh held). No vendor is named.
 */
const HISTORY_NOTES: Record<string, string> = {
  pending_split: 'A split for this symbol is due and still awaits a price history refresh; until that refresh runs, bars before the split may be on the pre-split scale.',
  held: 'This symbol\'s price history is held for review; bars may not reflect a recent split or correction yet.',
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * `historyState`, when given (the header's value, or null when the proxy sent
 * none), adds the state, a note when it is pending_split or held, and the
 * count of unconfirmed sessions. Rows keep their own `confirmed` flag (null
 * for index, future and crypto symbols, which carry no confirmation).
 */
export type StockPriceInterval = 'daily' | 'weekly' | 'monthly';

interface IndicatorPlotPoint { time: unknown; value: number }
interface ComputedIndicatorPayload {
  name?: unknown;
  params?: unknown;
  plots?: Record<string, IndicatorPlotPoint[]>;
}

/**
 * One computed indicator for the model: the latest finite value of every
 * plot, the last `keep` points, and how many there were. The proxy computed
 * the whole series on every returned bar; the model mostly needs where it
 * is now and how it got there, and sixty bars of five plots would not fit
 * the response budget beside the bars themselves.
 */
export function shapeIndicators(payload: unknown, keep: number): unknown[] {
  if (!Array.isArray(payload)) return [];
  const limit = Math.max(0, Math.floor(keep));
  return payload
    .filter((entry): entry is ComputedIndicatorPayload => entry != null && typeof entry === 'object')
    .map((entry) => {
      const plots = entry.plots != null && typeof entry.plots === 'object' ? entry.plots : {};
      const latest: Record<string, number | null> = {};
      const points: Record<string, IndicatorPlotPoint[]> = {};
      let kept = 0;
      let total = 0;
      for (const [key, series] of Object.entries(plots)) {
        const finite = (Array.isArray(series) ? series : []).filter((pt) => pt != null && typeof pt === 'object' && Number.isFinite((pt as IndicatorPlotPoint).value));
        const last = finite[finite.length - 1];
        latest[key] = last ? last.value : null;
        points[key] = limit > 0 ? finite.slice(-limit) : [];
        kept = Math.max(kept, points[key].length);
        total = Math.max(total, finite.length);
      }
      return { name: entry.name ?? null, params: entry.params ?? {}, latest, points, pointsKept: kept, pointsTotal: total };
    });
}

/** Typical price (hlc3) weighted by volume over the rows that carry both; null without volume. */
function volumeWeightedAverageOf(rows: StockPriceRow[]): number | null {
  let weighted = 0;
  let volume = 0;
  for (const row of rows) {
    const high = asFiniteNumber(row.high);
    const low = asFiniteNumber(row.low);
    const close = asFiniteNumber(row.close);
    const v = asFiniteNumber(row.volume);
    if (high == null || low == null || close == null || v == null || v <= 0) continue;
    weighted += ((high + low + close) / 3) * v;
    volume += v;
  }
  return volume > 0 ? roundTo(weighted / volume, 4) : null;
}

export const VOLUME_WEIGHTED_AVERAGE_NOTE = 'Typical price (high + low + close over three) weighted by volume over the returned bars; not a session VWAP, which needs intraday bars (get_intraday_bars).';

export interface StockPriceShapeOptions {
  interval?: StockPriceInterval;
  /** Points to keep per indicator plot. */
  indicatorPoints?: number;
}

export function summarizeStockPrices(payload: unknown, requestedDays?: number, historyState?: string | null, options: StockPriceShapeOptions = {}): unknown {
  // The proxy answers a bare row array, or an object carrying the rows
  // beside the indicators it computed on them.
  const envelope = payload != null && typeof payload === 'object' && !Array.isArray(payload)
    ? payload as { data?: unknown; indicators?: unknown; indicatorsMeta?: unknown }
    : null;
  const rawRows = envelope ? envelope.data : payload;
  const rows = Array.isArray(rawRows)
    ? rawRows.filter((row): row is StockPriceRow => row != null && typeof row === 'object')
    : [];
  const interval = options.interval ?? 'daily';
  const indicatorFields = envelope && Array.isArray(envelope.indicators)
    ? {
        indicators: shapeIndicators(envelope.indicators, options.indicatorPoints ?? 10),
        indicatorsMeta: envelope.indicatorsMeta ?? null,
      }
    : {};
  const state = historyState === undefined ? undefined
    : historyState != null && HISTORY_STATES.has(historyState) ? historyState : null;
  const history = state === undefined ? {} : {
    historyState: state,
    ...(state != null && HISTORY_NOTES[state] ? { historyNote: HISTORY_NOTES[state] } : {}),
  };
  const unconfirmed = state === undefined ? {} : { unconfirmedSessions: rows.filter((row) => row.confirmed === false).length };

  if (rows.length === 0) {
    return {
      data: [],
      ...history,
      ...indicatorFields,
      summary: {
        interval,
        sessionsReturned: 0,
        ...unconfirmed,
      },
    };
  }

  const first = rows[0];
  const latest = rows[rows.length - 1];
  const firstClose = asFiniteNumber(first.close);
  const latestClose = asFiniteNumber(latest.close);
  const closeReturnPct = firstClose != null && latestClose != null && firstClose !== 0
    ? ((latestClose - firstClose) / firstClose) * 100
    : null;

  const closes = rows
    .map((row) => asFiniteNumber(row.close))
    .filter((value): value is number => value != null);
  const volumes = rows
    .map((row) => asFiniteNumber(row.volume))
    .filter((value): value is number => value != null);

  const highestCloseRow = rows.reduce<StockPriceRow | null>((best, row) => {
    const close = asFiniteNumber(row.close);
    if (close == null) return best;
    if (!best || close > (asFiniteNumber(best.close) ?? -Infinity)) return row;
    return best;
  }, null);

  const lowestCloseRow = rows.reduce<StockPriceRow | null>((best, row) => {
    const close = asFiniteNumber(row.close);
    if (close == null) return best;
    if (!best || close < (asFiniteNumber(best.close) ?? Infinity)) return row;
    return best;
  }, null);

  const highestVolumeRow = rows.reduce<StockPriceRow | null>((best, row) => {
    const volume = asFiniteNumber(row.volume);
    if (volume == null) return best;
    if (!best || volume > (asFiniteNumber(best.volume) ?? -Infinity)) return row;
    return best;
  }, null);

  return {
    data: rows,
    latest: latest,
    ...history,
    ...indicatorFields,
    summary: {
      interval,
      sessionsReturned: rows.length,
      ...unconfirmed,
      startDate: first.date ?? null,
      endDate: latest.date ?? null,
      startClose: firstClose,
      latestClose: latestClose,
      closeReturnPct: roundTo(closeReturnPct, 2),
      highestClose: highestCloseRow
        ? { date: highestCloseRow.date ?? null, close: asFiniteNumber(highestCloseRow.close) }
        : null,
      lowestClose: lowestCloseRow
        ? { date: lowestCloseRow.date ?? null, close: asFiniteNumber(lowestCloseRow.close) }
        : null,
      averageClose: roundTo(
        closes.length > 0 ? closes.reduce((sum, value) => sum + value, 0) / closes.length : null,
        2,
      ),
      averageVolume: roundTo(
        volumes.length > 0 ? volumes.reduce((sum, value) => sum + value, 0) / volumes.length : null,
        0,
      ),
      highestVolumeDay: highestVolumeRow
        ? {
            date: highestVolumeRow.date ?? null,
            volume: asFiniteNumber(highestVolumeRow.volume),
            close: asFiniteNumber(highestVolumeRow.close),
          }
        : null,
      volumeWeightedAverage: volumeWeightedAverageOf(rows),
      volumeWeightedAverageNote: VOLUME_WEIGHTED_AVERAGE_NOTE,
    },
    _data_meta: requestedDays != null && rows.length >= requestedDays
      ? { showing: rows.length, requested_days: requestedDays }
      : undefined,
  };
}
