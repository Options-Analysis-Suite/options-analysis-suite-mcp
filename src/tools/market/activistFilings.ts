import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeActivistFilingsResponse } from './activistFilingsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_activist_filings',
    {
      title: 'Activist Filings',
      description: 'Get Schedule 13D/13G beneficial-ownership filings for a symbol. Default response prioritizes the latest above-threshold holder snapshot per filer and summarizes below-threshold amendments separately so current holders stay visible.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        full: z.boolean().optional().describe('Return the raw filing list instead of the compact current-holder summary.'),
      },
      // OpenAI app review treats openWorldHint as public-state mutation. This
      // tool may read public SEC EDGAR ownership filings through the proxy, but
      // it cannot submit filings or change public or third-party systems.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const response = await client.get(`/activist-filings/${encodeURIComponent(symbol.toUpperCase())}`) as any;
      if (full) return { _skipSizeGuard: true, data: response };
      return shapeActivistFilingsResponse(response);
    }),
  );
}
