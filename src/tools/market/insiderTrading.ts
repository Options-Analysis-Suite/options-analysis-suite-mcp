import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeInsiderTradingResponse } from './insiderTradingShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_insider_trading',
    {
      title: 'Insider Trading',
      description: 'Get insider trading activity for a company. Default response focuses on economically meaningful open-market buys and sells, groups repeated filing rows into event-level summaries, and summarizes awards/exercises/tax withholding separately.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        full: z.boolean().optional().describe('Return the less-summarized insider-trading feed (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const [res, companyProfile] = await Promise.all([
        client.get(`/insider-trading/${upperSymbol}`) as Promise<any>,
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
      ]);
      if (full) return { _skipSizeGuard: true, data: res };
      return shapeInsiderTradingResponse(res, companyProfile);
    }),
  );
}
