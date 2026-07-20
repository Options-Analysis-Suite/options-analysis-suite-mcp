import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeEarnings } from './earningsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_earnings',
    {
      title: 'Earnings',
      description: 'Get earnings history and estimates for a company. Returns actual EPS, estimates, revenue, and surprise percentages. Earnings events are the largest source of overnight gap risk for options — check if an upcoming earnings date falls within an option\'s expiration window. Shows last 8 quarters by default.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol }) => {
      const res = await client.get(`/earnings/${encodeURIComponent(symbol.toUpperCase())}`) as any;
      return summarizeEarnings(res, 8);
    }),
  );
}
