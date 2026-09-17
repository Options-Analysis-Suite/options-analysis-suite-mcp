import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeEodDealerPositioning } from './eodDealerPositioningShaping.js';

/**
 * End-of-day dealer positioning, from the stored options snapshot.
 *
 * This tool was cut from the live-data plan on the belief that the snapshot's
 * exposure summary covered only the ~125 regime symbols. Measured against
 * production on 2026-09-09: 5,568 tickers carry net_gex_0_60d and
 * dealer_regime. No Pro requirement (the server itself requires entitlement:
 * a subscription, or a developer or comped account, so nothing here is
 * free-tier), cached upstream by the nightly cron, no broker.
 *
 * A SEPARATE TOOL FROM get_live_dealer_positioning, deliberately, and never a
 * fallback inside it. A live gamma flip and a last-close one are different
 * claims: this one is the snapshot's coarse-grid level and carries no search
 * status or resolution, and the summary says so on every answer.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_dealer_positioning',
    {
      title: 'EOD Dealer Positioning / GEX',
      description:
        'Get END-OF-DAY dealer positioning for a symbol from the last completed session, over the 0-60 day expiration window: '
        + 'net GEX and DEX, the dealer regime (positive or negative gamma), the gamma flip, the call wall and put wall, the gamma magnet (largest absolute gamma strike), '
        + 'the 30-day expected move (as a decimal fraction of spot, and in dollars), and the top contributing strikes. Covers roughly 5,500 listed equities and ETFs. '
        + 'Positive net gamma means dealers hedge against moves and dampen them; negative means they hedge with moves and amplify them. '
        + 'The gamma flip here is a coarse-grid level from the stored snapshot with no search status or resolution; for the flip as of NOW, repriced from a live chain with its search status, use get_live_dealer_positioning (Pro and above), which is a different claim and is never substituted here. '
        + 'Pass `date` for a past session; omit it for the latest. A symbol with no exposure summary (a futures contract, or a session with no near-term options) reports not-found rather than a neutral regime. '
        + 'Distinct from get_regime with scope="symbol", which reports the daily regime classification and its authoritative Greek exposures.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Session date in YYYY-MM-DD. Defaults to the latest completed session.'),
        strikeLimit: z.number().int().min(1).max(10).optional()
          .describe('Contributing strikes to return, in stored order. Default 10, which is all the snapshot keeps.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, date, strikeLimit }) => {
      const params: Record<string, string> = {};
      if (date) params.date = date;

      const res = await client.get(
        `/eod/exposure/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
      ) as Record<string, unknown>;

      return summarizeEodDealerPositioning(res, { strikeLimit });
    }),
  );
}
