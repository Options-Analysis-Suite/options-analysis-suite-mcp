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
 * may already cover it; the requirement is what is known); `held`: the latest
 * refresh was held for review. No vendor is named.
 */
const HISTORY_NOTES: Record<string, string> = {
  pending_split: 'A split for this symbol is due and still awaits a price history refresh; until that refresh runs, bars before the split may be on the pre-split scale.',
  held: 'The latest refresh of this symbol\'s price history was held for review; bars may not reflect a recent split or correction yet.',
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
export function summarizeStockPrices(payload: unknown, requestedDays?: number, historyState?: string | null): unknown {
  const rows = Array.isArray(payload)
    ? payload.filter((row): row is StockPriceRow => row != null && typeof row === 'object')
    : [];
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
      summary: {
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
    summary: {
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
    },
    _data_meta: requestedDays != null && rows.length >= requestedDays
      ? { showing: rows.length, requested_days: requestedDays }
      : undefined,
  };
}
