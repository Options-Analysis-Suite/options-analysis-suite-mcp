import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeDividendHistory } from './corporateActionsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_dividends',
    {
      title: 'Dividends',
      description: 'Get per-symbol dividend history synced into the platform. Useful for checking dividend cadence, recent ex-dates, and cash amounts when evaluating carry, assignment risk, or discrete-dividend assumptions.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, MSFT)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of dividend records to return (default 20, max 100).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, limit }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const response = await client.get(`/stock-dividends/${upperSymbol}`);
      return shapeDividendHistory(response, limit);
    }),
  );
}
