import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeFundamentals } from './fundamentalsShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_fundamentals',
    {
      title: 'Fundamentals',
      description: 'Get company fundamentals: market cap, P/E ratio, EPS, revenue, profit margins, dividend yield, beta, sector, and industry. Useful for assessing whether an options strategy aligns with the fundamental picture. Default response returns compact company metadata, curated TTM ratios/key metrics, and one summarized recent statement entry per financial statement.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        full: z.boolean().optional().describe('Include the full raw financial statements payload (annual + quarterly). Default false returns a compact fundamentals summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const [res, companyProfile, dividendYield] = await Promise.all([
        client.get(`/fundamentals/${upperSymbol}`),
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
        // Trailing dividend yield from the shared /dividend-yield endpoint (ratios-ttm for
        // companies, profile last_div / close for funds) - reused, not re-derived. Funds carry no
        // ratios-ttm dividendYieldTTM, so this is the only place an ETF yield surfaces here.
        client.get(`/dividend-yield/${upperSymbol}`).catch(() => null),
      ]);
      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeFundamentals(res, companyProfile, dividendYield);
    }),
  );
}
