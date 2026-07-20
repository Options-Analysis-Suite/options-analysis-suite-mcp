import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeSplitHistory } from './corporateActionsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_stock_splits',
    {
      title: 'Stock Splits',
      description: 'Get per-symbol stock split history synced into the platform. Useful for checking historical split ratios and labels when reconciling price history, options deliverables, or unusual chart moves.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, TSLA)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of split records to return (default 20, max 100).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, limit }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const response = await client.get(`/stock-splits/${upperSymbol}`);
      return shapeSplitHistory(response, limit);
    }),
  );
}
