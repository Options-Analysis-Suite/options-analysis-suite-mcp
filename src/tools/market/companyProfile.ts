import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeCompanyProfileResponse } from './companyProfileShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_company_profile',
    {
      title: 'Company Profile',
      description: 'Get company profile data for a symbol with a compact normalized default view. Returns sector, industry, market cap, float metrics, key identifiers, and a trimmed business description.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, TSLA)'),
        full: z.boolean().optional().describe('Return the raw synced company-profile row instead of the compact normalized summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const res = await client.get(`/company-profile/${encodeURIComponent(symbol.toUpperCase())}`) as any;
      // Both branches must guard against the proxy's documented null-on-404
      // return. Without the ternary, full=true would emit literal "null" via
      // JSON.stringify(sanitizeMcpWireOutput(null)); returning null lets the
      // toolHandler emit the standard "No data available" message instead.
      if (full) return res ? { _skipSizeGuard: true, data: res } : null;
      return shapeCompanyProfileResponse(res);
    }),
  );
}
