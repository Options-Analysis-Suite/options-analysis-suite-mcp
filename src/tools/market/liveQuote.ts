import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { significantDeep } from './dealerPositioningShaping.js';

/**
 * The underlying's quote now, from the proxy's /live/quote route: the one
 * tool that answers "what is SPY trading at right now" with the session's
 * open, high and low beside it. The live chain carries a spot at fetch time
 * and no session range; this carries the broker's own quote clocks.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_quote',
    {
      title: 'Live Quote (Pro)',
      description:
        'Get a LIVE quote for one underlying (a stock, ETF or index such as SPX or VIX), fetched in real time from the broker credential stored on your Options Analysis Suite account: last, bid, ask, bid and ask sizes, mid, the broker\'s mark, the session\'s open, high and low, the previous close, volume, and the broker\'s quote and trade times, with `change` and `changePercent` (the broker\'s own day change, or computed against the previous close; `changeBasis` says which). '
        + 'This is the only tool with the underlying\'s current quote and session range; get_live_options_chain reports a spot at fetch time with no range, and get_stock_prices is end-of-day bars. '
        + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'A null field means the broker published nothing for it, which is different from zero; a `last` of 0 is no trade and goes out null. `mid` is (bid + ask) / 2 only when both sides are quoted above zero, and null for an index (SPX, VIX), whose bid and ask are indicative and not an executable market (`midReason` "index-not-executable"; Tradier\'s SPX sides were 76 points apart on a Saturday); `mark` is the broker\'s own valuation where it publishes one (tastytrade, and Schwab for a stock or fund), not an executable quote; a computed `change` and `changePercent` (`changeBasis` "previous-close") are null when `last` or `previousClose` is missing, never computed from a stand-in; a broker-published change (`changeBasis` "broker") survives either absence. '
        + '`change` and `changePercent` are the broker\'s own day change where it publishes one (`changeBasis` "broker": Tradier, and Schwab from its regular-session figures where its quote carries them, so an after-hours trade does not move it, else its netChange) and otherwise computed from `previousClose` (`changeBasis` "previous-close"). A previous close rolls to the session\'s own close on some brokers once the session ends (Tradier\'s SPX all weekend, and Schwab\'s stocks and indices), so outside regular hours a quote whose previousClose equals its last, or the regular session\'s last where the broker keeps an extended-hours last apart (Schwab), with no broker-published change or a published change of 0, goes out with `change` and `changePercent` null, `changeBasis` null and `changeReason` "previous-close-rolled": the day\'s change cannot be read from it, and a session that genuinely closed flat reads the same and is withheld the same; a broker\'s own non-zero change is published whatever the previous close. A change computed from a stale quote (below) is withheld the same way with `changeReason` "stale-quote": it is that snapshot\'s move, not the day\'s (Public has answered a 04:00 pre-market print); a broker\'s own change is kept. `changeReason` is null otherwise. get_stock_prices has the prior close. '
        + '`stale` is true when both of the broker\'s clocks (quoteTime, tradeTime) predate `lastSessionOpen`, the 09:30 New York open of the last session that has started: a snapshot the broker never updated through the session (Public has answered a 04:00 pre-market print). Null with no clocks at all. tastytrade\'s one clock is its market-data clock, which moves without new prices (it ticked on a Saturday), so `stale` cannot catch a frozen tastytrade quote. An index has no size or volume: those are null, never a zero-fill. '
        + 'The fields follow each broker\'s own quote: Schwab\'s `previousClose` is its close, the previous regular session\'s during the session and that session\'s own once it ends, its `quoteTime` moves on a bid or ask update while `tradeTime` is the last print, and an index quote there has no bid, ask, mark or quote time; Tradier\'s `previousClose` is its prevclose, never its session close; tastytrade\'s `quoteTime` is its market-data clock (updated-at) and it publishes no trade time, so `tradeTime` is null there; Public publishes no open, high or low, so those are null there, and Tradier publishes none for an index quote (SPX, VIX), so they are null there too; a null is what the broker left out, never a stand-in. Outside regular hours `last` can be an extended-hours trade on any broker, and `open`, `high` and `low` describe the session the broker is in. '
        + '`asOf` is when the quote was FETCHED, not a quote time; the broker\'s own clocks are `quoteTime` and `tradeTime`. A repeat for the same symbol on the same broker, by the same account, within 5 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account\'s call never shares it. '
        + 'Cost: 1 request on every broker, against the per-broker budget below. '
        + '`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker\'s own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; an error answered after the live-broker limiter ran carries it as `rateLimit` beside `code`, whether one it charged for (an unlisted expiration, a broker failure) or its own rate-limit refusal (RATE_LIMITED, which charges nothing), and one refused before it (the Pro tier gate, a malformed date, a missing credential) carries none. The budget is each broker\'s own documented quota, never less: 120 requests a minute on Tradier and Schwab, 600 on Public (10 a second), and 120 on tastytrade, which publishes no figure, so that one is a conservative stand-in. The broker\'s own rate limit is reported as BROKER_RATE_LIMITED, retryable, with `retryAfterSeconds` when the broker said how long (Tradier\'s window reset, Schwab\'s Retry-After) and null with a backoff note when it did not; wait before retrying. '
        + 'Every number goes out at 15 significant digits at most, which drops binary noise in a computed mid or percent, while a decimal the broker printed with 15 or fewer digits and a whole number such as a size pass unchanged. '
        + 'There is no end-of-day fallback: if the broker cannot answer, this reports the failure and whether retrying can help; a broker that returns no price at all for the symbol is reported as not answering (BROKER_UNAVAILABLE), never as a quote of nulls. A broker that does not answer is reported as BROKER_UNAVAILABLE, with `brokerFailure` saying what kind of failure it was ("http-status" with the broker\'s `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" when it answered with no price, strikes or spot to use, or "other"); no broker text is passed on. A broker that refuses the request itself (an HTTP 4xx other than 408, 409, 425 and 429, and neither a credential refusal nor a failed sign-in; Public answers a symbol it does not list with a 400) is reported as BROKER_REJECTED, not retryable, with `brokerFailure` "http-status" and its `brokerStatus`: retrying will not help, another broker may.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, SPX, VIX)'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, provider }) => {
      const params: Record<string, string> = {};
      if (provider) params.provider = provider;
      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/quote/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as Record<string, unknown>;
      return significantDeep({ ...res, rateLimit: budget.rateLimit });
    }),
  );
}
