import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeIvSurface } from './ivSurfaceShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_iv_surface',
    {
      title: 'IV Surface',
      description: 'Get the IV surface/skew across strikes and expirations for a symbol. End-of-day data from the previous trading session. Default response returns a compact term-structure and smile summary.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        full: z.boolean().optional().describe('Return the less-summarized IV surface grid (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const res = await client.get(`/scanner/iv-surface/${encodeURIComponent(symbol.toUpperCase())}`);
      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeIvSurface(res);
    }),
  );
}
