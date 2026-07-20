import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shouldSummarizeIvHistory, summarizeIvHistory, trimIvHistoryToRecent } from './ivHistoryShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_iv_history',
    {
      title: 'IV History',
      description: 'Get historical implied volatility (IV) and historical volatility (HV) for a stock or ETF. Shows how option-implied expected moves and realized moves have evolved. High IV relative to HV suggests options are expensive; low IV relative to HV suggests options are cheap. Large windows return a compact recent/trend summary by default.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(1095).default(90).describe('Days of history (default 90). The default 90-day view returns the 30 most recent entries; larger windows may be summarized unless full=true.'),
        full: z.boolean().optional().describe('Return less-summarized IV history (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, full }) => {
      const res = await client.get('/scanner/history', { symbol: symbol.toUpperCase(), days: String(days) }) as any;
      if (full) return { _skipSizeGuard: true, data: res };

      if (days === 90) {
        return trimIvHistoryToRecent(res, 30);
      }

      if (shouldSummarizeIvHistory(res)) {
        return summarizeIvHistory(res);
      }

      return trimIvHistoryToRecent(res, Number.MAX_SAFE_INTEGER);
    }),
  );
}
