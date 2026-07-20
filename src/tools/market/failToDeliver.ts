import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeFailToDeliver } from './failToDeliverShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_fail_to_deliver',
    {
      title: 'Fail-to-Deliver',
      description: 'Get SEC Failure-to-Deliver (FTD) data for a symbol. Default response returns a compact summary with recent history, notable spikes, and threshold overlap. Default window is 180 days because SEC FTD publication lags by about 21 days.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        days: z.number().int().min(1).max(1095).default(180).describe('Number of calendar days to return. Default 180 because FTD publication lags by about 21 days.'),
        full: z.boolean().optional().describe('Return the raw FTD history instead of the compact summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, full }) => {
      const response = await client.get(`/sec/fail-to-deliver/${encodeURIComponent(symbol.toUpperCase())}`, {
        days: String(days),
      });
      if (full) {
        return { _skipSizeGuard: true, data: response };
      }
      return summarizeFailToDeliver(response);
    }),
  );
}
