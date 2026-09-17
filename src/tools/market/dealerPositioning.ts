import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeDealerPositioning } from './dealerPositioningShaping.js';

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
 * NO END-OF-DAY FALLBACK INSIDE THIS TOOL. A live gamma flip and a last-close
 * one are different claims, and a caller must be able to tell them apart; a
 * failure here reports the failure, never a quiet substitute.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_dealer_positioning',
    {
      title: 'Live Dealer Positioning / GEX (Pro)',
      description:
        'Get LIVE dealer positioning for a symbol, computed in real time from the broker credential stored on your Options Analysis Suite account. '
        + 'Returns net GEX and DEX plus net vega, vanna, charm and vomma; the gamma flip (the repriced regime-change level), the call wall and put wall (the gamma levels that act as resistance and support), a gamma magnet, gamma concentration, a dealer regime of positive or negative gamma, and per-strike gamma and delta contributions around spot. '
        + 'Positive net gamma means dealers hedge against moves and dampen them; negative means they hedge with moves and amplify them. '
        + 'The gamma flip is found by repricing the book across a range of spot levels. `coverage.gammaFlipMethod` says how: "repriced" recomputes gamma from implied volatility at every level, while "frozen-gamma" means at least one leg had no IV and its published gamma was held constant, which is an approximation that can materially move the level or create one where there was none. Say which was used when quoting it. '
        + 'The gamma-flip search samples prices within 20% of spot. A pair of crossings within one sampling interval can be missed; no detected flip does not prove that no crossing exists within or beyond that range. '
        + '`coverage.gammaFlipResolution` is the local sampling bracket width where the flip was found, not a confidence interval or an error bound. The reported flip is the nearest crossing detected by that search, and the resolution is null when no level is reported. '
        + '`coverage.gammaFlipSearchStatus` describes the search on supported legs: "found" detected a crossing, "not-found" detected none in the sampled range, and "unresolved" means numerical signs or crossing order could not be established reliably. An unresolved null gives no conclusion about whether a crossing exists; a null status means the response did not report a recognized search status. '
        + 'Computed over the nearest four expirations of the live chain, so it reflects the current session rather than the last close. '
        + 'Metric coverage and statuses distinguish complete, partial, unmeasured, empty and unknown results. Partial values sum only supported option legs; they are not measurements of the whole book. Unmeasured or unknown values are null. Gamma-derived levels require complete coverage; the gamma flip uses its own repricing coverage, including usable IV. '
        + 'EXPENSIVE: each call is charged five weighted units against the 10-unit-per-minute live-broker limit, so at most two calls a minute. A cold request reads the expirations list and up to four chains; actual upstream request counts vary with the provider and cache state. Do not call it in a loop or for a list of symbols. '
        + 'The risk-free rate and dividend yield are resolved from real market data and never defaulted, because the gamma flip is a repricing that depends on them; `resolved` reports what was used. '
        + 'Requires a Pro subscription or above and a broker connected under Account -> Broker. '
        + 'For the last completed session\'s positioning over 0-60 days, free and without a broker, use get_dealer_positioning; its gamma flip is a coarse-grid level and is a different claim from the repriced one here.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, MU)'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
        strikeRange: z.number().int().min(1).max(40).optional()
          .describe('TOTAL per-strike rows nearest spot. Default 10. Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage.'),
      },
      outputSchema: marketDataOutputSchema,
      // Unlike every other tool here except the live chain, this reaches a
      // third party: the user's own broker.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, provider, strikeRange }) => {
      const params: Record<string, string> = {};
      if (provider) params.provider = provider;

      const res = await client.get(
        `/live/exposure/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
      ) as Record<string, unknown>;

      return summarizeDealerPositioning(res, { strikeRange });
    }),
  );
}
