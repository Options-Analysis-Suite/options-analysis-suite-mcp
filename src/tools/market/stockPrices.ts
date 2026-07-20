import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeStockPrices } from './stockPriceShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_stock_prices',
    {
      title: 'Stock Prices',
      description: 'Get historical OHLCV price data for a stock or ETF with a compact trend summary plus the requested daily bars.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(60).default(30).describe('Number of trading days (default 30, max 60)'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days }) => {
      const res = await client.get('/stock-prices', {
        symbol: symbol.toUpperCase(),
        limit: String(days),
      }) as any;
      const rows = Array.isArray(res) ? res : [];
      return summarizeStockPrices(rows.slice(-days), days);
    }),
  );
}
