type StockPriceRow = {
  [key: string]: unknown;
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
};

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function roundTo(value: number | null, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function summarizeStockPrices(payload: unknown, requestedDays?: number): unknown {
  const rows = Array.isArray(payload)
    ? payload.filter((row): row is StockPriceRow => row != null && typeof row === 'object')
    : [];

  if (rows.length === 0) {
    return {
      data: [],
      summary: {
        sessionsReturned: 0,
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
    summary: {
      sessionsReturned: rows.length,
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
