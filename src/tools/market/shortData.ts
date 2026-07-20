import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeShortInterest, summarizeShortVolume } from './marketFlowShaping.js';

/**
 * Unified FINRA short-side tool. Replaces get_short_volume and
 * get_short_interest with one enum-driven tool — both are per-symbol
 * FINRA feeds at different cadences.
 */

const SHORT_DATA_DESCRIPTION = `Get FINRA short-side data for a symbol. Two related but distinct series:

• type="volume" — DAILY short-volume activity. Compact summary-first view (latest day + trailing averages + recent-trend flag) by default.
• type="interest" — BIWEEKLY short-interest settlement reports (position-based, not flow-based). Compact summary-first view (latest settlement + trailing averages + rising/falling trend) by default. Short-percent-of-float is enriched from the company profile when the FINRA feed omits it.

Symbol is required for both.`;

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_short_data',
    {
      title: 'FINRA Short Data',
      description: SHORT_DATA_DESCRIPTION,
      inputSchema: {
        type: z.enum(['volume', 'interest']).describe('Which FINRA series to fetch.'),
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, GME)'),
        full: z.boolean().optional().describe('Return the raw FINRA payload instead of the compact summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ type, symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());

      if (type === 'volume') {
        const res = await client.get(`/finra/short-volume/${upperSymbol}`) as any;
        if (full) {
          if (res && Array.isArray(res.history) && res.history.length > 30) {
            const original = res.history.length;
            res.history = res.history.slice(0, 30);
            res._history_meta = { trimmed: true, original_length: original, returned: 30 };
          }
          return { _skipSizeGuard: true, data: res };
        }
        return summarizeShortVolume(res);
      }

      // type === 'interest'
      const [res, companyProfile] = await Promise.all([
        client.get(`/finra/short-interest/${upperSymbol}`),
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
      ]);
      if (full) {
        return { _skipSizeGuard: true, data: res };
      }
      return summarizeShortInterest(res, 8, companyProfile);
    }),
  );
}
