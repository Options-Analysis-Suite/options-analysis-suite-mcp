import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import {
  shouldSummarizeGreeksHistory,
  summarizeGreeksHistory,
  trimGreeksHistoryToRecent,
} from './greeksHistoryShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_greeks_history',
    {
      title: 'Greeks History',
      description: 'Get historical options Greeks (delta, gamma, theta, vega) for a symbol. Shows how sensitivity profiles and dealer hedging pressure have shifted over time. Large windows return a compact recent/trend summary by default.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        start: z.string().describe('Start date (YYYY-MM-DD)'),
        end: z.string().describe('End date (YYYY-MM-DD)'),
        dteMin: z.number().int().min(0).optional().describe('Minimum days to expiration filter. Default 0.'),
        dteMax: z.number().int().min(0).optional().describe('Maximum days to expiration filter. Default 999.'),
        moneyness: z.enum(['all', 'atm', 'otm', 'itm']).optional().describe('Filter strikes by delta-based moneyness bucket. Default all.'),
        full: z.boolean().optional().describe('Return less-summarized Greeks history (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, start, end, dteMin, dteMax, moneyness, full }) => {
      const res = await client.get(`/scanner/greeks-history/${encodeURIComponent(symbol.toUpperCase())}`, {
        start,
        end,
        dteMin: String(dteMin ?? 0),
        dteMax: String(dteMax ?? 999),
        moneyness: moneyness ?? 'all',
      }) as any;

      if (full) return { _skipSizeGuard: true, data: res };

      if (shouldSummarizeGreeksHistory(res)) {
        return summarizeGreeksHistory(res);
      }

      return trimGreeksHistoryToRecent(res, Number.MAX_SAFE_INTEGER);
    }),
  );
}
