import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeAnalystData } from './analystDataShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_analyst_data',
    {
      title: 'Analyst Data',
      description: 'Get Wall Street analyst ratings, price targets, and consensus estimates for a symbol. Default response keeps the nearest forward estimate periods, price-target summaries, rating snapshot, summarized rating-history streaks, and recent rating changes.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, TSLA)'),
        full: z.boolean().optional().describe('Include the full raw analyst payload, including complete estimate and rating-history arrays. Default false returns a compact summary view.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const [res, companyProfile] = await Promise.all([
        client.get(`/analyst-data/${upperSymbol}`),
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
      ]);
      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeAnalystData(res, undefined, undefined, undefined, undefined, companyProfile);
    }),
  );
}
