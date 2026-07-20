import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeOptionsChain } from './optionsChainShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_options_chain',
    {
      title: 'Options Chain',
      description: 'Get the end-of-day options chain snapshot from the latest available completed trading session by default. Default view summarizes expirations, ATM term structure, skew, and representative near-money contracts across the curve while avoiding same-day expiry noise when later expirations exist; set date to query a specific session.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional market date in YYYY-MM-DD format. Defaults to the latest available options-chain session for this symbol.'),
        full: z.boolean().optional().describe('Return all contracts (can be 2000+ for broad ETFs). Default false — returns a compact summarized chain view.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, date, full }) => {
      const params: Record<string, string> = {
        ticker: symbol.toUpperCase(),
      };
      if (date) params.date = date;

      const res = await client.get('/scanner/options-chain', params) as any;

      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeOptionsChain(res);
    }),
  );
}
