import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeEarnings, summarizeEarningsMoves } from './earningsShaping.js';

/**
 * Earnings history and estimates, and with `includeMoves` the realized and
 * implied moves around each past report from the proxy's moves route. The
 * moves are a second request with its own refusals (a symbol with no report
 * on file, an outage of the closes), and a refusal there is reported in the
 * answer beside the history the caller also asked for, never in place of it.
 */
export function register(server: McpServer, client: ProxyClient, liveClient: LiveApiClient): void {
  server.registerTool(
    'get_earnings',
    {
      title: 'Earnings',
      description: 'Get earnings history and estimates for a company. Returns actual EPS, estimates, revenue, and surprise percentages. Earnings events are the largest source of overnight gap risk for options - check if an upcoming earnings date falls within an option\'s expiration window. Shows last 8 quarters by default. '
        + 'With `includeMoves: true`, also returns the realized and implied moves around each of the last eight past reports: both one-session moves (prior close to report-day close, and report-day close to next close, because the report\'s time of day is often not on file; `timing` says when it is), the implied move from the stored at-the-money straddle on the session before the report when that chain is on file (`impliedSource: "straddle"`, within the last twelve months of stored chains) else from the stored ATM IV as a one-day approximation (`"atmIv"`) else null with the reason, the IV crush across the report on one tenor, and realized-over-implied ratios; the summary counts each implied source. '
        + 'A symbol with no report on file, or an outage of the price history, is reported under `moves` with its code while the history still returns.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        includeMoves: z.boolean().default(false).describe('Add the realized and implied moves around each past report (one more request).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, includeMoves }) => {
      const upper = symbol.toUpperCase();
      const res = await client.get(`/earnings/${encodeURIComponent(upper)}`) as any;
      const history = summarizeEarnings(res, 8);
      if (includeMoves !== true) return history;
      let moves: unknown;
      try {
        moves = summarizeEarningsMoves(await liveClient.get(`/earnings/${encodeURIComponent(upper)}/moves`));
      } catch (error) {
        if (!(error instanceof LiveApiError)) throw error;
        moves = { dataAvailable: false, code: error.code ?? null, message: error.message };
      }
      return { ...(history as Record<string, unknown>), moves };
    }),
  );
}
