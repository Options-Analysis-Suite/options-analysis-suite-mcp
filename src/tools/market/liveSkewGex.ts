import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import {
  LIVE_SKEW_GEX_METRICS,
  LIVE_SKEW_GEX_RANK_BY,
  MAX_LIVE_SKEW_GEX_SYMBOLS,
  RANK_METRIC,
  shapeLiveSkewGex,
} from './liveSkewGexShaping.js';

export const LIVE_SKEW_GEX_DESCRIPTION =
  'Rank a WATCHLIST of up to 50 symbols LIVE by their 25-delta skew and net GEX, each with its change since the prior session\'s close, computed in real time from the broker credential stored on your Options Analysis Suite account: the live counterpart of run_screener\'s end-of-day put-skew board and its dod-change boards for skew and gex (the website\'s Put Skew Leaders, Biggest Skew Change and Biggest GEX Change), for the symbols you name. '
  + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
  + 'METHOD, the same on both sides of every change: implied volatility is solved from each option\'s bid/ask mid (a zero bid, a crossed quote or a missing side has none), one IV per strike from its out-of-the-money side judged against the forward, a strike with no out-of-the-money market interpolated in strike between its neighbours, then Black-Scholes delta and gamma with the resolved dividend yield. The prior side is the prior session\'s stored chain AS RECORDED, recomputed by this same method over the same expirations at the live call\'s rate and yield, so the change is like for like on every broker. American exercise, discrete dividends and AM settlement are not modelled. '
  + 'SKEW is the 25-delta put IV minus the 25-delta call IV at the listed expiration nearest 30 days out among those at least 7 days out, interpolated in call-delta space (the end-of-day put-skew board\'s definition, on these IVs). When that expiration fails a check the next one is tried, and when every one tried fails, `skew.value` is null and `skew.status` names the check the expiration nearest 30 days out failed, with that `expiration` and `dte`: "curve-gate" (fewer than 5 strikes with a usable IV), "delta-gate" (fewer than 5 strikes with a delta) or "wing-iv" (no usable IV at the 25-delta call or put) - one-sided or missing quotes, more often outside regular hours. "no-qualifying-expiration", with both null, means no listed expiration is 7 days out. A live skew that failed has no prior (`priorStatus` "not-measured-live"); a prior that fails a check on the stored chain is null with that check in `priorStatus`. It is a decimal: 0.05 is 5 volatility points. Its level differs from the end-of-day board\'s, which reads published implied volatilities rather than solving its own, by about 0.75 volatility points typically (median size on 200 tickers, 2026-10-06; the same expiration chosen for 197 of 199), about the size of a typical day\'s skew change, which is why the prior is recomputed here rather than read from the board. '
  + 'NET GEX is gamma x open interest x 100 x spot^2 x 1%, calls positive and puts negative, in dollars per 1% move, over the nearest four expirations that may still trade (from 4:15 PM New York time on an expiration day, that day\'s is left out unless the broker lists nothing else). It is this model\'s gamma, not the broker\'s: get_live_dealer_positioning sums the broker\'s published Greeks over the same window and the two can differ; get_options_snapshot\'s netGex covers all expirations on file and get_dealer_positioning\'s 0-60 days, so neither can be subtracted from this. `gex.status` is "complete" when every leg with open interest (above zero, or not published) got a gamma, "partial" when some did not (`legCoverage`, sent unless complete, counts them; `oiShare` is the share of open interest sized), and "unmeasured" with a null value when none did - never a measured 0; a change on a withheld level is withheld with it. `gex.openInterestUnpublishedExpirations` names expirations whose open interest the broker did not publish (a zero on every contract, which Schwab has printed on index options): their legs are counted and left out. `gex.strikes` sorts the window\'s strikes by where their IV came from: `otmSide` (their own out-of-the-money quote), `filled` (interpolated between neighbours) and `noIv` (none: left out). `gex.emptyExpirations` names a window date whose chain came back with no strikes; it is left out of both sides. '
  + '`gex.omittedRows` counts the rows the broker sent for the window\'s chains that could not be used (`quarantined`, `invalidStrike`, `notSuccess`, `unquoted`, `total`), left out of the GEX, and `skew.omittedRows` those of the skew expiration\'s chain; absent when there are none. `gex.partial` is true when the window could not be read whole: a date in `gex.emptyExpirations`, or contracts whose quotes could not be read (`omittedRows.unquoted`), and `skew.partial` when the skew expiration lost quotes; with unread quotes the change is withheld (null), since the prior session holds those strikes. '
  + 'OPEN INTEREST TIMING: the live open interest is the count published before today\'s session (as of the prior close) and the prior side\'s is the count stored for that session (as of the close before it), so the GEX change is one session of new positions plus the price moves since - the live counterpart of the end-of-day dod-change gex board. The prior session is the most recent one on file before the live session, up to two more back when an import is missing (`baseline.sessionsSkipped`, sent when above 0); `baseline.status` "none-on-file" or "unavailable" leaves every prior null, and a live expiration the prior session did not store makes that metric\'s prior null with `priorStatus` "baseline-expiration-missing" (a new weekly, for instance) and is named in `baseline.missingExpirations`. '
  + 'Outside regular hours the chain is valued at the live session\'s 4:00 PM New York close (`session.valuation` "session-close") and its quotes may be stale or one-sided, so coverage falls; a row valued otherwise (a cached row computed before the close) carries its own `valuation`. `spotTime` is the spot\'s trade time where the spot is a last trade the broker timed (null otherwise, and always on tastytrade); `spotStale` is true when the spot printed before the last session\'s open. '
  + 'An index (SPX, NDX, RUT) uses its stored basket-derived dividend yield; a volatility index such as VIX has none, and an index whose stored estimate is unavailable is treated the same: refused per symbol in `errors` (RESOLUTION_FAILED) before anything is spent on it; get_live_dealer_positioning takes a supplied `q` for it. '
  + 'BUDGET: this spends your own broker quota and MAY SPEND ALL OF IT, after which the other live tools refuse (RATE_LIMITED) until the window resets. Per symbol, in the broker\'s own requests: the expirations list (1, cached 15 minutes) and the four GEX chains - 9 on Tradier and Public, 5 on Schwab, and on tastytrade 49 reserved and settled to the real count (2 plus one per 100 contracts per chain) - plus one more chain for the skew when its expiration is outside those four (2, 1, 2, or 12 reserved on tastytrade), and one more when the first skew candidate fails its gates; `metrics` "skew" alone is the list and one chain (3, 2, 3, 13 reserved). On Public, whose cap is 10 requests a second, a skew chain outside the window waits for the next second rather than make an eleventh request inside one. Three symbols run at a time. A request counts when it is sent, answered or not: a chain the broker does not answer in time still spends its share. '
  + 'RE-CALL WITH THE SAME LIST: each answer is cached per account, broker, symbol and live session for 15 minutes; a row younger than `maxAgeSeconds` (default 120, 15 to 900) is served again at no cost, an older one is served as it is, with its `ageSeconds`, marked `stale` and listed in `refreshPending`, and is refreshed oldest first once every symbol has a value. What this call could not answer at all is in `pending` with its reason: "budget" (the per-broker quota ran out, or a skew chain could not be afforded - the GEX is answered without it), "time" (no new symbol starts after 15 seconds and the answer comes by 25), "in-progress" (still computing; it finishes and lands in the cache), or "broker-rate-limited" (the broker\'s own 429: that symbol and the rest wait, the broker\'s wait, else 60 seconds). `complete` is true once every symbol has a value for every requested metric or an error, stale rows included, and `retryAfterSeconds` says when the next call can make progress, on pending symbols or on stale rows: call again with the SAME list after it, not in a tight loop. A long list takes several calls to complete: with both metrics Tradier\'s 120 a minute covers about ten symbols and Schwab\'s about twenty, Public\'s 10 a second paces it to about one symbol a second, and tastytrade\'s reservation of 49 or more a symbol leaves room for two at a time until each settles. After that each call refreshes the oldest rows its budget covers, so on a long list a row can be older than `maxAgeSeconds` (fifty symbols on Tradier take about five minutes a round): ask for fewer symbols for fresher rows. A concurrent call for the same symbol on the same account and broker waits for the running computation instead of paying for it twice. '
  + 'One symbol\'s failure never fails the list: it is an entry in `errors` with its code and whether retrying can help, and `complete` does not wait for it - ask for a retryable one again later. A symbol the broker lists no expirations for (an unknown ticker, or one without options) is NO_EXPIRATIONS, not retryable. A broker that does not answer is reported as BROKER_UNAVAILABLE, with `brokerFailure` saying what kind of failure it was ("http-status" with the broker\'s `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" when it answered with no price, strikes or spot to use, or "other"); no broker text is passed on. A broker that refuses the request itself (an HTTP 4xx other than 408, 409, 425 and 429, and neither a credential refusal nor a failed sign-in; Public answers a symbol it does not list with a 400) is reported as BROKER_REJECTED, not retryable, with `brokerFailure` "http-status" and its `brokerStatus`: retrying will not help, another broker may. A dead credential (BROKER_CREDENTIAL_INVALID) or a failed record of the credential\'s use ends the whole call, since no further symbol may be sent. '
  + '`rankBy` sorts the answered rows: "skew" and "gex" by value (largest first unless `order` is "asc"), "skewChange", "gexChange" and "gexChangePercent" by the size of the change with its sign kept in the value, so the biggest movers either way come first; a row without the figure sorts last and is named in `rankMeta.unrankedSymbols`, ties stay in the order asked for. `limit` keeps the best-ranked rows, and the rest, or any the response ceiling cannot hold (fifty rows fit; the ceiling bites only beside many errors), are named in `omitted`: ask for those symbols in a separate call, served from the cache at no cost while younger than `maxAgeSeconds`. '
  + '`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker\'s own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; a call ended by a dead credential or a failed record of its use carries it as `rateLimit` beside `code`, and one refused before the broker opened (the Pro tier gate, a malformed parameter, a missing credential) carries none. A symbol still finishing when the answer goes out holds its reservation until it settles, so `remaining` can read low for a moment. The budget is each broker\'s own documented quota, never less: 120 requests a minute on Tradier and Schwab, 600 on Public (10 a second), and 120 on tastytrade, which publishes no figure, so that one is a conservative stand-in. '
  + 'Skews, IVs, yields, shares and percentages go out at 6 significant digits and GEX in whole dollars; prices as the broker quoted them. Use run_screener (put-skew, dod-change) for the market-wide end-of-day boards, get_options_snapshot for the end-of-day skew and GEX of up to 50 symbols at no broker cost, and get_live_dealer_positioning for one symbol\'s full live positioning with the gamma flip and walls.';

/**
 * The live watchlist ranking: the proxy's /live/skew-gex batch, shaped and
 * ranked here. Everything the batch did not answer (pending, errors, rows
 * past the limit or the ceiling) is said beside the rows.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'rank_live_skew_gex',
    {
      title: 'Live Watchlist Skew and GEX Ranking (Pro)',
      description: LIVE_SKEW_GEX_DESCRIPTION,
      inputSchema: {
        symbols: z.string()
          .describe('A comma-separated list of 1 to 50 symbols (e.g., "SPY,QQQ,AAPL,NVDA,TSLA"). Call again with the SAME list to continue a list this call did not finish.'),
        rankBy: z.enum(LIVE_SKEW_GEX_RANK_BY).optional()
          .describe('Sort the answered rows by: skew (25-delta put minus call IV), skewChange (since the prior close), gex (net GEX), gexChange, or gexChangePercent. A change sorts by its size with the sign kept. Absent keeps the order asked for.'),
        order: z.enum(['asc', 'desc']).optional()
          .describe('With rankBy: largest first (desc, default) or smallest first (asc).'),
        metrics: z.array(z.enum(LIVE_SKEW_GEX_METRICS)).min(1).optional()
          .describe('Which metrics to compute: skew, gex, or both (default). Skew alone costs one chain per symbol instead of four or five.'),
        maxAgeSeconds: z.number().int().min(15).max(900).optional()
          .describe('A cached row younger than this is served again at no cost; older rows are refreshed. Default 120.'),
        limit: z.number().int().min(1).max(MAX_LIVE_SKEW_GEX_SYMBOLS).optional()
          .describe('Keep only this many best-ranked rows (1-50). Default: every answered row.'),
        // Every provider a stored credential may name, as the other live tools take them.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbols, rankBy, order, metrics, maxAgeSeconds, limit, provider }) => {
      const list = [...new Set(symbols.split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0))];
      if (list.length === 0) throw new Error('symbols must name at least one ticker');
      if (list.length > MAX_LIVE_SKEW_GEX_SYMBOLS) {
        throw new Error(`symbols accepts at most ${MAX_LIVE_SKEW_GEX_SYMBOLS} tickers; received ${list.length}`);
      }
      const asked = metrics && metrics.length > 0 ? [...new Set(metrics)] : [...LIVE_SKEW_GEX_METRICS];
      // Refused here, before any broker request: a ranking on a metric this call will not compute.
      if (rankBy && !asked.includes(RANK_METRIC[rankBy])) {
        throw new Error(`rankBy ${rankBy} needs the ${RANK_METRIC[rankBy]} metric; add it to metrics or rank by a requested one`);
      }
      const params: Record<string, string> = {
        symbols: list.join(','),
        metrics: LIVE_SKEW_GEX_METRICS.filter((m) => asked.includes(m)).join(','),
      };
      if (maxAgeSeconds !== undefined) params.maxAgeSeconds = String(maxAgeSeconds);
      if (provider) params.provider = provider;
      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get('/live/skew-gex', params, (rateLimit) => { budget.rateLimit = rateLimit; });
      return {
        ...shapeLiveSkewGex(res, { requestedSymbols: list, rankBy, order, limit }),
        rateLimit: budget.rateLimit,
      };
    }),
  );
}
