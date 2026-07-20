import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeSymbolTradingHalts, summarizeTradingHalts } from './tradingHaltsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_trading_halts',
    {
      title: 'Trading Halts',
      description: 'Get current and recent trading halts. Default view condenses duplicate feed rows, prioritizes the latest active halt state, and highlights material recent news/regulatory events.',
      inputSchema: {
        symbol: z.string().optional().describe('Ticker symbol (optional — omit for all current halts)'),
        full: z.boolean().optional().describe('Return the raw halt feed instead of the compact active/recent summary. Default false.'),
      },
      // OpenAI app review treats openWorldHint as public-state mutation. This
      // tool may read public NASDAQ/NYSE halt feeds through the proxy, but it
      // cannot publish notices or change public or third-party systems.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      if (symbol) {
        const res = await client.get(`/market/trading-halts/${encodeURIComponent(symbol.toUpperCase())}`);
        return full ? { _skipSizeGuard: true, data: res } : summarizeSymbolTradingHalts(res);
      }
      const res = await client.get('/market/trading-halts');
      return full ? { _skipSizeGuard: true, data: res } : summarizeTradingHalts(res);
    }),
  );
}
