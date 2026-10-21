import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeDealerPositioning } from './dealerPositioningShaping.js';
import { plainDecimal } from './strategyScan.js';

/**
 * Dealer positioning, computed live from the caller's own broker chain.
 *
 * The computation is not new - it is the same engine behind the WebSocket
 * exposure stream and the paid /v1/compute/exposure endpoint. What was missing
 * was a way to REACH it: /v1/compute/exposure requires the caller to POST up to
 * five thousand strike rows, which an assistant cannot produce. The data
 * existed and the computation existed, and nothing joined them. The proxy's
 * /live/exposure route joins them, from the stored broker credential.
 *
 * NO END-OF-DAY FALLBACK INSIDE THIS TOOL. A live gamma flip and an end-of-day
 * one are different claims, and a caller must be able to tell them apart; a
 * failure here reports the failure, never a quiet substitute.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_dealer_positioning',
    {
      title: 'Live Dealer Positioning / GEX',
      description:
        'Get LIVE dealer positioning (GEX, gamma exposure) for one symbol, computed in real time from the broker credential stored on your Options Analysis Suite account: net GEX and DEX, net vega, vanna, charm and vomma, the repriced gamma flip, the call wall and put wall, a gamma magnet, gamma concentration, a dealer regime (normally the sign of net gamma at spot; net GEX is the fallback with fewer than two gamma-bearing strikes or no recognized regime, and the flip side does not determine it) and per-strike rows near spot. '
        + 'For the most recent session on file (0-60 days), free and without a broker, use get_dealer_positioning; its coarse-grid gamma flip is a different claim from the repriced one here. '
        + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Per expiration it adds its own GEX, DEX and gross-gamma share (0DTE concentration), its at-the-money straddle expected move and the earnings and ex-dividend dates on file, also in the top-level `events` (none on file, here or in a separate earnings or dividends lookup, is not none scheduled: a fund rarely has earnings on file, and its ex-dividend date often appears only on or after the day, so for a fund neither rules one out); `spotSides` splits open interest above and below spot (a squeeze argument\'s inputs). '
        + 'The gamma flip is the crossing nearest spot that a sampled search found (a fine step, 0.0005% of spot growing to at most 0.02% farther out), not necessarily the only one; a null flip beside a complete `levelStatus.gammaFlip` is the result of a search over every counted leg (read `coverage.gammaFlipSearchStatus` when reported), not withheld and not proof of no flip. '
        + 'It reflects the current session, not the most recent session on file; on moomoo, option quotes are real time only once the account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked. '
        + 'Without `expiration` it covers the first four listed expirations that may still trade (on a monthly-listed name that can span months; get_dealer_positioning covers 0-60 days from the most recent session on file; its window and session can differ from this live answer, so comparing them does not isolate today\'s longer-dated book); with `expiration` every total (netCharm included), level and row is computed over that one listed date alone, the way to see a same-day (0DTE) or single-week book. '
        + 'EXPENSIVE: broker requests spend your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools. '
        + 'Cold-call estimates, not actual spend or upper bounds: a default call reads the expirations list and four chains: 9 requests on Tradier and Public, 5 on Schwab, 49 reserved on tastytrade and settled to the real count, and 9 reserved on moomoo and settled to what it spent (about three fully cold calls a minute on its 30, more once its contract lists are cached for the day); with `expiration` it reads the list and one chain: 3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade, and 3 reserved on moomoo and settled to what it spent. '
        + 'Counts vary with the broker\'s caches, and a long tastytrade or moomoo chain reserves more once its count is known and is refused RATE_LIMITED when the budget cannot hold it. '
        + 'Do not call it in a loop or for a list of symbols. '
        + 'A repeat within 15 seconds for the same symbol, broker, `expiration`, `r` and `q` can be answered from a short cache, uncharged, with the same `asOf`; `strikeRange`, `strikeWindowPct` and `strikeWindowDelta` only choose which computed rows are returned, so widening a cached window spends no broker requests.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, MU)'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('One expiration in YYYY-MM-DD to compute over instead of the default window (the nearest four that may still trade), for example the same-day expiration, before or after its close; it can be named while the broker still lists it, and the list is cached 15 minutes, so for that long after the listing ends. '
          + 'It must be one the broker lists: otherwise the refusal names the listed ones and never substitutes the nearest. '
          + 'A value not written YYYY-MM-DD is refused by this tool\'s input check before any request, and a well-formed date that is not a calendar date (2026-02-30) by the proxy as INVALID_EXPIRATION, before anything is charged.'),
        r: z.number().min(-0.1).max(1).optional()
          .describe('Risk-free rate to price with, as a decimal fraction (0.0425 is 4.25%), from -0.1 to 1, used as given instead of the resolved one and never checked against the market; `resolved.r.source` is then "supplied" with no date, and q is resolved as usual. '
          + 'A value outside that range is refused by this tool\'s input check before any request.'),
        q: z.number().min(0).max(1).optional()
          .describe('Dividend yield to price with, as a decimal fraction (0.012 is 1.2%), from 0 to 1, used as given instead of the resolved one and never checked against the market; `resolved.q.source` is then "supplied" with no date, and r is resolved as usual. '
          + 'An index\'s resolved yield is its basket-derived estimate (`resolved.q.source` "index_constituents"); a volatility index such as VIX has none, and an index whose estimate is unavailable has none either, so a call on one needs this: without it the call is refused (RESOLUTION_FAILED, naming what is missing) before the session opens and before anything is charged. '
          + 'A value outside that range is refused by this tool\'s input check before any request.'),
        strikeRange: z.number().int().min(1).max(150).optional()
          .describe('TOTAL per-strike rows nearest spot, the cap when `strikeWindowPct` or `strikeWindowDelta` is given. '
          + 'Default 10 (150 with either), max 150. '
          + 'Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage.'),
        strikeWindowPct: z.number().positive().max(50).optional()
          .describe('Return every strike within this percent of spot instead of a fixed count, nearest first up to `strikeRange` (for example 10 for strikes within 10% of spot); above 0, at most 50. '
          + 'With no spot price from the broker no percent window is applied: the rows are then the first strikes in strike order up to the cap, and the answer says so.'),
        strikeWindowDelta: z.number().gt(0).lt(0.5).optional()
          .describe('Return every strike inside a delta band instead of a fixed count, nearest spot first up to `strikeRange`: 0.1 keeps the strikes from the 10-delta put to the 10-delta call, a call delta from 0.1 to 0.9 or a put delta from -0.9 to -0.1, ends included. '
          + 'The deltas are the broker\'s per-contract deltas; either leg qualifies a strike on its own, and a missing one is never derived from the other, so a strike with no usable delta on either leg is outside. '
          + 'Over several expirations a strike qualifies when at least one of them prices it inside the band, so the farthest expiration, whose deltas sit nearest 0.5, usually sets how far out the band reaches. '
          + 'Strictly between 0 and 0.5. '
          + 'It takes the place of `strikeWindowPct`, and passing both is refused before any request.'),
      },
      outputSchema: marketDataOutputSchema,
      // Unlike every other tool here except the live chain, this reaches a
      // third party: the user's own broker.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, expiration, provider, r, q, strikeRange, strikeWindowPct, strikeWindowDelta }) => {
      // Both choose the rows returned, and there is no one answer for both;
      // refused here, before anything is requested or charged.
      if (strikeWindowPct !== undefined && strikeWindowDelta !== undefined) {
        throw new LiveApiError(
          'Pass strikeWindowDelta or strikeWindowPct, not both: each chooses which strikes are returned, and they cannot be combined.',
          400, 'INVALID_REQUEST', false, undefined, undefined,
        );
      }
      const params: Record<string, string> = {};
      if (expiration) params.expiration = expiration;
      if (provider) params.provider = provider;
      // Plain decimals: the route refuses an exponent (1e-2) by design.
      if (r !== undefined) params.r = plainDecimal(r);
      if (q !== undefined) params.q = plainDecimal(q);

      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/exposure/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as Record<string, unknown>;

      // The budget rides inside the fit with the rows and the guide, no longer added after it.
      return summarizeDealerPositioning(res, { strikeRange, strikeWindowPct, strikeWindowDelta, rateLimit: budget.rateLimit });
      // The two echoes are the values the rows were chosen with, so they go
      // out as asked: rounded, 0.10000000000000002 would read 0.1, a band
      // that keeps a strike at 0.1 which this one did not.
    }, { exactPaths: ['strikes.windowPct', 'strikes.deltaBand'], liveTool: 'dealer' }),
  );
}
