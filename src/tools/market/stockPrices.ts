import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { HISTORY_STATE_HEADER, summarizeStockPrices } from './stockPriceShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_stock_prices',
    {
      title: 'Stock Prices',
      description: 'Get historical OHLCV price data for a stock or ETF with a compact trend summary plus the requested daily bars. Each bar\'s `confirmed` is true when a verified price-history snapshot stands behind it and false when none does yet, which is the case for most symbols until their history has been verified; the price is the stored price either way, and `unconfirmedSessions` counts the false ones. It is null for an index, future or crypto symbol, which carry no confirmation, and for every bar when the symbol\'s history state could not be read (`historyState` null), which means unknown, not unconfirmed. `historyState` is "current", "pending_split" (a split is due and its refresh has not run, so bars before it may be on the pre-split scale), "held" (the price history is held for review) or "not_applicable" (null when it could not be read), with `historyNote` explaining the two that need it. '
        + '`interval` is daily (default), weekly or monthly, and `days` then counts bars of that interval (a weekly bar is dated on its week\'s Monday, a holiday week included, a monthly one by its month\'s first day); `summary.interval` echoes it, and the summary\'s "sessions" count bars. '
        + '`indicators` is a list of up to six {name, params} entries computed with the same math as the platform\'s Stock Charts on the returned bars plus up to 250 earlier bars of warm-up (so a recursive indicator\'s latest value is the chart\'s, not a short-window seed), published for the returned bars only, named by the chart\'s catalogue type (sma, ema, vwma, bollinger, rsi, macd, stochastic, atr, adx, obv, mfi and the rest of the 58) with the chart\'s own parameter names (period, source, multiplier, fastPeriod, slowPeriod, signalPeriod, and so on); an unknown name or parameter is refused naming what would have worked. Each entry comes back with the parameters used, `latest` (the newest finite value of every plot, null when a plot has none), the last `indicatorPoints` points per plot, and how many there were. Warm-up bars are omitted, a long period on a short window has no value, and a bar with a missing price is skipped (`indicatorsMeta.barsSkipped`), never computed on zero. '
        + '`summary.volumeWeightedAverage` is the typical price (high, low and close over three) weighted by volume over the returned bars, with its note beside it: it is not a session VWAP, which needs intraday bars.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(60).default(30).describe('Number of bars (trading days at the daily interval; default 30, max 60)'),
        interval: z.enum(['daily', 'weekly', 'monthly']).default('daily').describe('Bar interval (default daily)'),
        indicators: z.array(z.object({
          name: z.string().describe('A Stock Charts catalogue type: sma, ema, vwma, rsi, macd, bollinger, atr, ...'),
          params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional()
            .describe('The chart\'s own parameter names for that indicator (period, source, multiplier, fastPeriod, ...); omitted ones take the chart\'s defaults'),
        })).max(6).optional().describe('Indicators to compute on the returned bars (at most six)'),
        indicatorPoints: z.number().int().min(0).max(60).default(10).describe('Points to keep per indicator plot, newest last (default 10); `latest` is always reported'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, interval, indicators, indicatorPoints }) => {
      // The proxy names the symbol's history state in a header; each row
      // carries its own confirmation. The daily default sends
      // no interval, so the request is the one it always was.
      const params: Record<string, string> = { symbol: symbol.toUpperCase(), limit: String(days) };
      if (interval && interval !== 'daily') params.interval = interval;
      if (indicators && indicators.length > 0) params.indicators = JSON.stringify(indicators);
      const { body, headers } = await client.getWithHeaders<any>('/stock-prices', params, [HISTORY_STATE_HEADER]);
      // A bare array, or { data, indicators, indicatorsMeta } when indicators were asked for.
      const payload = Array.isArray(body)
        ? body.slice(-days)
        : body != null && typeof body === 'object' && Array.isArray(body.data)
          ? { ...body, data: body.data.slice(-days) }
          : [];
      return summarizeStockPrices(payload, days, headers[HISTORY_STATE_HEADER] ?? null, { interval: interval ?? 'daily', indicatorPoints });
    }, { keepOnEmpty: ['historyState', 'historyNote', 'summary', 'indicators', 'indicatorsMeta'] }),
  );
}
