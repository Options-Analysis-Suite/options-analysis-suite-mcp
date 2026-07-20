type DividendHistoryPoint = {
  date?: string;
  dividend?: number | null;
  adjDividend?: number | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  declarationDate?: string | null;
};

type SplitHistoryPoint = {
  date?: string;
  numerator?: number | null;
  denominator?: number | null;
  label?: string | null;
};

type IpoCalendarPoint = {
  date?: string;
  company?: string | null;
  symbol?: string | null;
  exchange?: string | null;
  actions?: string | null;
  priceRange?: string | null;
  shares?: number | null;
  marketCap?: number | null;
};

type DividendCalendarPoint = {
  date?: string;
  symbol?: string | null;
  dividend?: number | null;
  adjDividend?: number | null;
  recordDate?: string | null;
  paymentDate?: string | null;
  declarationDate?: string | null;
};

type SplitCalendarPoint = {
  date?: string;
  symbol?: string | null;
  numerator?: number | null;
  denominator?: number | null;
  label?: string | null;
};

function addTrimNote(result: Record<string, unknown>, key: string, total: number, limit: number, _noun: string): Record<string, unknown> {
  if (total > limit) {
    result[`_${key}_meta`] = { showing: limit, total, truncated: true };
  }
  return result;
}

export function shapeDividendHistory(payload: unknown, limit = 20): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as { symbol?: string; historical?: unknown };
  const historical = Array.isArray(data.historical) ? data.historical as DividendHistoryPoint[] : [];
  const trimmed = historical.slice(0, limit).map((row) => ({
    date: row.date,
    dividend: row.dividend,
    adjDividend: row.adjDividend,
    recordDate: row.recordDate,
    paymentDate: row.paymentDate,
    declarationDate: row.declarationDate,
  }));

  return addTrimNote(
    { symbol: data.symbol, historical: trimmed },
    'historical',
    historical.length,
    limit,
    'dividend records',
  );
}

export function shapeSplitHistory(payload: unknown, limit = 20): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as { symbol?: string; historical?: unknown };
  const historical = Array.isArray(data.historical) ? data.historical as SplitHistoryPoint[] : [];
  const trimmed = historical.slice(0, limit).map((row) => ({
    date: row.date,
    numerator: row.numerator,
    denominator: row.denominator,
    label: row.label,
  }));

  return addTrimNote(
    { symbol: data.symbol, historical: trimmed },
    'historical',
    historical.length,
    limit,
    'split records',
  );
}

export function shapeIpoCalendar(rows: unknown, limit = 50, symbol?: string): Record<string, unknown> {
  const data = Array.isArray(rows) ? rows as IpoCalendarPoint[] : [];
  const filtered = symbol
    ? data.filter((row) => row.symbol?.toUpperCase() === symbol.toUpperCase())
    : data;
  const trimmed = filtered.slice(0, limit).map((row) => ({
    date: row.date,
    company: row.company,
    symbol: row.symbol,
    exchange: row.exchange,
    actions: row.actions,
    priceRange: row.priceRange,
    shares: row.shares,
    marketCap: row.marketCap,
  }));

  return addTrimNote({ ipoCalendar: trimmed }, 'ipoCalendar', filtered.length, limit, 'IPO events');
}

export function shapeDividendCalendar(rows: unknown, limit = 100, symbol?: string): Record<string, unknown> {
  const data = Array.isArray(rows) ? rows as DividendCalendarPoint[] : [];
  const filtered = symbol
    ? data.filter((row) => row.symbol?.toUpperCase() === symbol.toUpperCase())
    : data;
  const trimmed = filtered.slice(0, limit).map((row) => ({
    date: row.date,
    symbol: row.symbol,
    dividend: row.dividend,
    adjDividend: row.adjDividend,
    recordDate: row.recordDate,
    paymentDate: row.paymentDate,
    declarationDate: row.declarationDate,
  }));

  return addTrimNote({ dividendCalendar: trimmed }, 'dividendCalendar', filtered.length, limit, 'dividend events');
}

export function shapeSplitCalendar(rows: unknown, limit = 100, symbol?: string): Record<string, unknown> {
  const data = Array.isArray(rows) ? rows as SplitCalendarPoint[] : [];
  const filtered = symbol
    ? data.filter((row) => row.symbol?.toUpperCase() === symbol.toUpperCase())
    : data;
  const trimmed = filtered.slice(0, limit).map((row) => ({
    date: row.date,
    symbol: row.symbol,
    numerator: row.numerator,
    denominator: row.denominator,
    label: row.label,
  }));

  return addTrimNote({ splitCalendar: trimmed }, 'splitCalendar', filtered.length, limit, 'split events');
}
