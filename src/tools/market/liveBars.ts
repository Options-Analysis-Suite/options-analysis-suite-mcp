import { z } from 'zod';
import { INDICATOR_NAMES } from './indicatorNames.js';
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
      title: 'Intraday Bars and VWAP',
      description:
        'Get one session\'s LIVE intraday bars (1, 5, 15 or 30 minutes) for a stock, ETF or index from the broker credential stored on your Options Analysis Suite account, with the session VWAP and its one-standard-deviation band, a session summary (open, high, low, close, volume) and any Stock Charts indicators asked for, computed on the same bars. '
        + 'This is the only tool with intraday price bars and a session VWAP; get_stock_prices is end-of-day bars, and get_live_quote is the quote now with the session range but no bars. '
        + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Tradier and Schwab only: tastytrade, Public and moomoo are refused as BARS_NOT_SUPPORTED (no REST candles on tastytrade or Public; moomoo disabled here), naming the two that can, before anything is spent; name `provider` when more than one credential is stored. '
        + 'Tradier\'s 30-minute bars aggregate its 15-minute bars on the New York half hour; no 1-hour bars. '
        + '`date` is a New York trading day (default today, or the most recent trading day before it when today is not one); `session` is "regular" (09:30 to 16:00 New York, the default) or "extended" (04:00 to 20:00). '
        + 'The window ends at the close or now, whichever is earlier, so a call during the session returns the bars so far. '
        + 'Bar times are ISO on the New York wall clock with the offset and only bars that START inside the window are returned (16:00 is dropped from regular hours). '
        + 'VWAP is the typical price (high, low and close over three) weighted by volume, cumulative from the first usable session bar (`vwap.anchor`; with `session: "extended"` that is the first pre-market bar, so ask for "regular" for the regular-hours VWAP), with `stdev` the volume-weighted standard deviation about it and `upper`/`lower` one deviation either side, as Stock Charts computes it; each bar carries its own `vwap` as of that bar. '
        + 'When the broker publishes no volume (an index such as SPX: null volume, never a zero-fill), `vwap.value` is null with `reason: "no-volume"`, never zero. '
        + 'The bars go out as `bars.columns` and `bars.rows`, newest last, at most `maxBars` (default 120) and fewer when the response budget binds, dropping the OLDEST; `barsMeta` says how many were returned of how many, whether and by what they were trimmed, and the first returned bar\'s time. '
        + 'The summary, the VWAP line and each indicator\'s latest value cover the whole session. '
        + '`asOf` is when the bars were FETCHED. '
        + 'A repeat (same symbol, date, interval, session, broker and account) within 15 seconds can be answered from a short in-memory cache with the same `asOf`, spending no broker request, so it is not charged and is answered even when the budget is spent; the cache is per proxy instance, so a repeat can also be fetched afresh, and another account\'s call never shares it. '
        + 'Cold-call estimate, not actual spend or a cap: 1 request on Tradier or Schwab, each metering 120 a minute shared with the other live tools. '
        + '`rateLimit`: proxy snapshot per account and broker, shared by live tools; includes other calls and reservations. '
        + 'Null means unknown. '
        + '`limit` minus `remaining` is not this call\'s spend. '
        + 'After this call, it gives `remaining` of `limit` in broker requests (`provider` names the broker), resetting in `resetSeconds`; an error after the live-broker limiter ran carries it beside `code` (a charged failure, or its own RATE_LIMITED refusal, which charges nothing), one refused before it (a malformed date, a missing credential) none. '
        + 'There is no end-of-day fallback, and no broker text is passed on: a failure\'s code says what failed and whether retrying helps - BROKER_RATE_LIMITED (retryable; wait `retryAfterSeconds` when given), BROKER_UNAVAILABLE (`brokerFailure` says how: "http-status" with `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" or "other") or BROKER_REJECTED (the broker refused the request itself: not retryable, another broker may answer). '
        + 'Every number goes out at 15 significant digits at most.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, SPX)'),
        // Every provider a stored credential may name; the proxy refuses the
        // three without candles by name, so the enum stays the full list.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo; bars need Tradier or Schwab, so name one of them when another is stored first.'),
        interval: z.enum(['1min', '5min', '15min', '30min']).default('5min').describe('Bar interval (default 5min)'),
        session: z.enum(['regular', 'extended']).default('regular').describe('regular (09:30 to 16:00 New York, default) or extended (04:00 to 20:00)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('A New York trading day, YYYY-MM-DD. Defaults to today, or the most recent trading day before it when today is not one.'),
        maxBars: z.number().int().min(1).max(400).default(120).describe('Bars to return at most, newest last (default 120)'),
        indicators: z.array(z.object({
          name: z.enum(INDICATOR_NAMES).describe('A Stock Charts catalogue type, each a read-only computation on the returned bars'),
          params: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional()
            .describe('The chart\'s own parameter names for that indicator (period, source, multiplier, fastPeriod, ...); omitted ones take the chart\'s defaults'),
        })).max(6).optional().describe('Indicators to compute on the session\'s bars (at most six). '
          + 'Each comes back with the parameters used, `latest` (the newest finite value of every plot, null when a plot has none) and the last `indicatorPoints` points per plot; an unknown parameter is refused naming what would have worked. '
          + 'One session is a short warm-up: an SMA of 200 on five-minute bars has no value until 200 bars exist.'),
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
    }, { liveTool: 'bars' }),
  );
}
