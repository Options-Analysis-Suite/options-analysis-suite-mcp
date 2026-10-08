/**
 * get_regime scope cot (phase H): the proxy's /cot/:symbol (a contract's
 * family market) and /market/cot (every mapped market), shaped for a model.
 * The proxy has already applied the units rule, the 3-year window and the
 * order; this keeps its numbers as they are and trims the history.
 */
const HISTORY_LIMIT = 13;
const COT_NOTE = 'CFTC Commitments of Traders, futures only. Positions are as of `reportDate`; CFTC publishes on the Friday after, later in holiday or delayed weeks. '
  + '`speculative` is leveraged funds (financial futures) or managed money (commodities), CFTC trader groups used as speculative positioning (not every position in them is speculative). '
  + '`range.reading` is a derived figure: where this report\'s speculative net sits between its 3-year low (0) and high (100) in the same contract units; null under 52 reports or when the low and high are equal. '
  + 'Totals are in the market\'s own `units`, never converted to another contract size.';

export function shapeCotSymbol(res: any): Record<string, unknown> {
  if (!res || typeof res !== 'object' || !res.speculative) return { cotStatus: 'No CFTC positioning on record for this contract.' };
  const history = Array.isArray(res.history) ? res.history : [];
  const kept = history.slice(-HISTORY_LIMIT);
  return {
    root: res.root, market: res.market, familyNote: res.note ?? null, reportDate: res.reportDate, firstSeenAt: res.firstSeenAt,
    openInterest: res.openInterest, changeOpenInterest: res.changeOpenInterest, speculative: res.speculative, groups: res.groups, range: res.range,
    history: kept,
    historyMeta: { limit: HISTORY_LIMIT, returned: kept.length, reportsInWindow: history.length, window: { start: res.range?.windowStart ?? null, end: res.range?.windowEnd ?? null }, order: 'oldest first' },
    cotNote: COT_NOTE,
  };
}

export function shapeCotMarket(res: any, opts: { sector?: string } = {}): Record<string, unknown> {
  if (!res || typeof res !== 'object' || !Array.isArray(res.markets)) return { cotStatus: 'No CFTC positioning on record yet.' };
  const markets = res.markets.filter((m: any) => !opts.sector || m.sector === opts.sector);
  return {
    asOf: res.asOf, asOfNote: 'The newest report on file; each market carries its own `reportDate` (a market can be a report behind).',
    order: 'by distance of range.reading from 50, most extreme first; markets without a reading last',
    markets, cotNote: COT_NOTE,
  };
}
