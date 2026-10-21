import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { RefusedBeforeRequest } from '../liveGuide.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import {
  LIVE_SKEW_GEX_METRICS,
  LIVE_SKEW_GEX_RANK_BY,
  MAX_LIVE_SKEW_GEX_SYMBOLS,
  RANK_METRIC,
  shapeLiveSkewGex,
} from './liveSkewGexShaping.js';

export const LIVE_SKEW_GEX_DESCRIPTION =
  'Rank a WATCHLIST of 1 to 50 symbols LIVE by their 25-delta skew and net GEX (gamma exposure), each with its change since the prior session\'s close, computed in real time from the broker credential stored on your Options Analysis Suite account: the live counterpart of run_screener\'s end-of-day put-skew board and its dod-change boards for skew and gex (the website\'s Put Skew Leaders, Biggest Skew Change and Biggest GEX Change), for the symbols you name. '
  + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
  + 'Both sides of every change use this platform\'s own model (implied volatility solved from bid/ask mids, then Black-Scholes delta and gamma), not the broker\'s Greeks, so the change is like for like; skew is the 25-delta put IV minus the 25-delta call IV at the listed expiration nearest 30 days out among those at least 7 days out (`skew10d` the same at 10-delta, same expiration), and net GEX is in dollars per 1% move over the nearest four expirations that may still trade. '
  + 'Outside regular hours the chain is valued at the session\'s 4:00 PM New York close on quotes that can be stale or one-sided; on moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked. '
  + 'BUDGET: fresh fetches spend your own broker quota and MAY SPEND ALL OF IT. Further requests to that broker can then be refused (RATE_LIMITED) until the window resets; cache-only answers can still be served. '
  + 'Per-broker quota: 120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo. '
  + 'Cold-call estimates per symbol, not actual spend or caps: both metrics need the expirations list (1, cached 15 minutes) and four GEX chains, 9 requests on Tradier, Public and moomoo (moomoo reserved and settled to what it spent), 5 on Schwab, 49 reserved on tastytrade and settled to the real count; one more chain when the skew expiration is outside those four, as it often is on a symbol with weekly or daily expirations (2 more on Tradier and Public, so 11 a symbol; 1 on Schwab; 12 reserved on tastytrade; 2 reserved on moomoo), and one more when the first skew candidate fails its checks; `metrics` "skew" alone is the list and one chain (3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade, 3 reserved on moomoo). '
  + 'A long list takes several calls: with both metrics Tradier\'s 120 a minute covers about ten symbols and Schwab\'s about twenty, Public paces to about one symbol a second, moomoo\'s 30 about three fully cold ones (more once its contract lists are cached for the day), and tastytrade\'s reservation of 49 or more a symbol leaves room for two at a time. '
  + 'Call again with the SAME list after `retryAfterSeconds`, not in a tight loop. '
  + 'A cached metric younger than `maxAgeSeconds` is reused at no cost; its `ageSeconds` is the rounded computation age at the response\'s `asOf`, not a quote age. '
  + 'Later calls refresh the oldest rows their budget covers, so on a long list a row can be older than `maxAgeSeconds` (fifty symbols on Tradier take about five minutes a round): ask for fewer symbols for fresher rows. '
  + 'A failed credential-use audit ends the whole call; no further symbol is sent. '
  + 'A volatility index such as VIX, or an index whose stored dividend yield is unavailable, is refused per symbol in `errors` (RESOLUTION_FAILED) before anything is spent on it; get_live_dealer_positioning takes a supplied `q` for it. '
  + 'An `errors` entry\'s `status` is this tool\'s for that symbol, not an HTTP status from the broker: 404 NO_EXPIRATIONS means no usable expiration dates were obtained, not that the broker returned a 404 (`brokerStatus` carries the broker\'s). '
  + 'Use run_screener (put-skew, dod-change) for the market-wide end-of-day boards, get_options_snapshot for the end-of-day skew and GEX of up to 50 symbols at no broker cost, and get_live_dealer_positioning for one symbol\'s full live positioning (the broker\'s Greeks) with the gamma flip and walls.';

/**
 * The live watchlist ranking: the proxy's /live/skew-gex batch, shaped and
 * ranked here. Everything the batch did not answer (pending, errors, rows
 * past the limit or the ceiling) is said beside the rows.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'rank_live_skew_gex',
    {
      title: 'Live Watchlist Skew and GEX Ranking',
      description: LIVE_SKEW_GEX_DESCRIPTION,
      inputSchema: {
        symbols: z.string()
          .describe('A comma-separated list of 1 to 50 symbols (e.g., "SPY,QQQ,AAPL,NVDA,TSLA"); duplicates and letter case fold to one symbol, and an empty list or more than 50 distinct symbols is refused before any request. '
          + 'Call again with the SAME list to continue a list this call did not finish.'),
        rankBy: z.enum(LIVE_SKEW_GEX_RANK_BY).optional()
          .describe('Sort the answered rows by: skew (25-delta put minus call IV), skewChange (since the prior close), gex (net GEX), gexChange, or gexChangePercent (the change as a percent of the prior\'s size). '
          + 'A change sorts by its size with the sign kept. '
          + 'The ranked metric must be in `metrics` (skew and skewChange need skew; gex, gexChange and gexChangePercent need gex), otherwise the call is refused before any request. '
          + 'Absent keeps the order asked for.'),
        order: z.enum(['asc', 'desc']).optional()
          .describe('With rankBy: largest first (desc, default) or smallest first (asc).'),
        metrics: z.array(z.enum(LIVE_SKEW_GEX_METRICS)).min(1).optional()
          .describe('Which metrics to compute: skew, gex, or both (default). '
          + 'Skew alone reads the expirations list and one chain per symbol (one more when its first candidate fails its checks); both read the list and four chains, plus one for a skew expiration outside them.'),
        maxAgeSeconds: z.number().int().min(15).max(900).optional()
          .describe('Seconds, 15 to 900, default 120. A cached row younger than this is served again at no cost; only a row older than this is refreshed. This is not how long rows are cached (15 minutes per account, broker, symbol and session). Within a call the symbols with no cached value are queued first and the older rows after them, oldest first, dispatched concurrently as the call\'s budget and deadlines allow, without waiting for every symbol to have a value; a row not refreshed in time is served as it is, with its `ageSeconds`, marked `stale` and listed in `refreshPending`, so on a long list a row can be older than this.'),
        limit: z.number().int().min(1).max(MAX_LIVE_SKEW_GEX_SYMBOLS).optional()
          .describe('Keep only this many rows (1-50): the best-ranked with `rankBy`, otherwise the first in the order asked for. '
          + 'Default: every answered row. '
          + 'The rest are named in `omitted.byLimit`, not lost.'),
        // Every provider a stored credential may name, as the other live tools take them.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbols, rankBy, order, metrics, maxAgeSeconds, limit, provider }) => {
      const list = [...new Set(symbols.split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0))];
      if (list.length === 0) throw new RefusedBeforeRequest('symbols must name at least one ticker');
      if (list.length > MAX_LIVE_SKEW_GEX_SYMBOLS) {
        throw new RefusedBeforeRequest(`symbols accepts at most ${MAX_LIVE_SKEW_GEX_SYMBOLS} tickers; received ${list.length}`);
      }
      const asked = metrics && metrics.length > 0 ? [...new Set(metrics)] : [...LIVE_SKEW_GEX_METRICS];
      // Refused here, before any broker request: a ranking on a metric this call will not compute.
      if (rankBy && !asked.includes(RANK_METRIC[rankBy])) {
        throw new RefusedBeforeRequest(`rankBy ${rankBy} needs the ${RANK_METRIC[rankBy]} metric; add it to metrics or rank by a requested one`);
      }
      const params: Record<string, string> = {
        symbols: list.join(','),
        metrics: LIVE_SKEW_GEX_METRICS.filter((m) => asked.includes(m)).join(','),
      };
      if (maxAgeSeconds !== undefined) params.maxAgeSeconds = String(maxAgeSeconds);
      if (provider) params.provider = provider;
      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get('/live/skew-gex', params, (rateLimit) => { budget.rateLimit = rateLimit; });
      // The budget rides inside the fit with the rows and the guide, no longer added after it.
      return shapeLiveSkewGex(res, { requestedSymbols: list, rankBy, order, limit, rateLimit: budget.rateLimit });
    }, { liveTool: 'ranking' }),
  );
}
