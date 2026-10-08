import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { significantDeep } from './dealerPositioningShaping.js';
import { summarizeLiveBars } from './liveBarsShaping.js';

/**
 * One session of intraday bars from the proxy's /live/bars route: the one
 * tool with minute bars, the session VWAP, and indicators on them. Every
 * other price tool is end-of-day.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_intraday_bars',
    {
      title: 'Intraday Bars and VWAP (Pro)',
      description:
        'Get one session\'s LIVE intraday bars (1, 5, 15 or 30 minutes) for a stock, ETF or index from the broker credential stored on your Options Analysis Suite account, with the session VWAP and its one-standard-deviation band, a session summary (open, high, low, close, volume) and any Stock Charts indicators asked for, computed on the same bars. '
        + 'This is the only tool with intraday price bars and a session VWAP; get_stock_prices is end-of-day bars, and get_live_quote is the quote now with the session range but no bars. '
        + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Tradier and Schwab only: tastytrade and Public publish no REST candles, so with one of those stored the call is refused as BARS_NOT_SUPPORTED, naming the two that can, before anything is spent; name `provider` when more than one credential is stored. Tradier\'s 30-minute bars are built from its 15-minute bars on the New York half hour; there are no 1-hour bars. '
        + '`date` is a New York trading day (default today, or the most recent trading day before it when today is not one); `session` is "regular" (09:30 to 16:00 New York, the default) or "extended" (04:00 to 20:00). The window ends at the close or now, whichever is earlier, so a call during the session returns the bars so far. Every bar time is ISO on the New York wall clock with its offset (2026-09-17T09:30:00-04:00). '
        + 'Only bars that START inside the session window are returned (a broker\'s 16:00 closing print beside the session is dropped). An index\'s bars carry no volume (null, never a zero-fill), so its VWAP is withheld with reason "no-volume". '
        + 'VWAP is the typical price (high, low and close over three) weighted by volume, cumulative from the session\'s first returned bar (`vwap.anchor`; with `session: "extended"` that is the first pre-market bar, so ask for "regular" for the regular-hours VWAP), with `stdev` the volume-weighted standard deviation about it and `upper`/`lower` one deviation either side, as the platform\'s Stock Charts computes it; each bar carries its own `vwap` as of that bar. When the broker publishes no volume for the symbol (Schwab publishes none for an index such as SPX), `vwap.value` is null with `reason: "no-volume"`, never zero. '
        + '`indicators` is a list of up to six {name, params} entries computed on the session\'s bars, named by the Stock Charts catalogue type (sma, ema, vwma, rsi, macd, bollinger, atr, ...) with the chart\'s own parameter names; an unknown name or parameter is refused naming what would have worked. Each comes back with the parameters used, `latest` (the newest finite value of every plot, null when a plot has none) and the last `indicatorPoints` points per plot. One session is a short warm-up: an SMA of 200 on five-minute bars has no value until 200 bars exist. '
        + 'The bars go out as columns and rows (`bars.columns`, `bars.rows`), newest last, at most `maxBars` (default 120) and fewer when the response budget binds, in which case the OLDEST bars are dropped and `barsMeta` says how many were returned of how many, whether the list was trimmed and by what, and the first returned bar\'s time; the summary, the VWAP line and each indicator\'s latest value are computed on the whole session before any trimming. '
        + '`asOf` is when the bars were FETCHED. A repeat for the same symbol, date, interval and session on the same broker, by the same account, within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account\'s call never shares it. '
        + 'Cost: 1 request on Tradier or Schwab, against the per-broker budget below. '
        + '`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker\'s own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; an error answered after the live-broker limiter ran carries it as `rateLimit` beside `code`, whether one it charged for (an unlisted expiration, a broker failure) or its own rate-limit refusal (RATE_LIMITED, which charges nothing), and one refused before it (the Pro tier gate, a malformed date, a missing credential) carries none. The budget is each broker\'s own documented quota, never less: 120 requests a minute on Tradier and Schwab, 600 on Public (10 a second), and 120 on tastytrade, which publishes no figure, so that one is a conservative stand-in. The broker\'s own rate limit is reported as BROKER_RATE_LIMITED, retryable, with `retryAfterSeconds` when the broker said how long (Tradier\'s window reset, Schwab\'s Retry-After) and null with a backoff note when it did not; wait before retrying. '
        + 'Every number goes out at 15 significant digits at most. There is no end-of-day fallback: if the broker cannot answer, this reports the failure and whether retrying can help. A broker that does not answer is reported as BROKER_UNAVAILABLE, with `brokerFailure` saying what kind of failure it was ("http-status" with the broker\'s `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" when it answered with no price, strikes or spot to use, or "other"); no broker text is passed on. A broker that refuses the request itself (an HTTP 4xx other than 408, 409, 425 and 429, and neither a credential refusal nor a failed sign-in; Public answers a symbol it does not list with a 400) is reported as BROKER_REJECTED, not retryable, with `brokerFailure` "http-status" and its `brokerStatus`: retrying will not help, another broker may.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, SPX)'),
        // Every provider a stored credential may name; the proxy refuses the
        // two without candles by name, so the enum stays the full list.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected; bars need Tradier or Schwab.'),
        interval: z.enum(['1min', '5min', '15min', '30min']).default('5min').describe('Bar interval (default 5min)'),
        session: z.enum(['regular', 'extended']).default('regular').describe('regular (09:30 to 16:00 New York, default) or extended (04:00 to 20:00)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('A New York trading day, YYYY-MM-DD. Defaults to today, or the most recent trading day before it when today is not one.'),
        maxBars: z.number().int().min(1).max(400).default(120).describe('Bars to return at most, newest last (default 120)'),
        indicators: z.array(z.object({
          name: z.string().describe('A Stock Charts catalogue type: sma, ema, vwma, rsi, macd, bollinger, atr, ...'),
          params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional()
            .describe('The chart\'s own parameter names for that indicator (period, source, multiplier, fastPeriod, ...); omitted ones take the chart\'s defaults'),
        })).max(6).optional().describe('Indicators to compute on the session\'s bars (at most six)'),
        indicatorPoints: z.number().int().min(0).max(60).default(10).describe('Points to keep per indicator plot, newest last (default 10); `latest` is always reported'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, provider, interval, session, date, maxBars, indicators, indicatorPoints }) => {
      const params: Record<string, string> = { interval: interval ?? '5min', session: session ?? 'regular' };
      if (provider) params.provider = provider;
      if (date) params.date = date;
      if (indicators && indicators.length > 0) params.indicators = JSON.stringify(indicators);
      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/bars/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as Record<string, unknown>;
      return significantDeep({ ...summarizeLiveBars(res, { maxBars, indicatorPoints }), rateLimit: budget.rateLimit });
    }),
  );
}
