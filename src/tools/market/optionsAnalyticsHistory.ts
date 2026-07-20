import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import {
  shouldSummarizeOptionsAnalyticsHistory,
  summarizeOptionsAnalyticsHistory,
} from './optionsAnalyticsHistoryShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_options_analytics_history',
    {
      title: 'Options Analytics History',
      description: 'Get daily end-of-day options analytics snapshots for a symbol — historical trend data going back years. Covers ATM IV, HV, IV rank/percentile, VWIV, skew, GEX/DEX/VEX, net vanna/charm/vomma, put/call ratio, max pain, expected move, term structure, dividend yield, and risk-free rate. Best for trend analysis over time. For current authoritative Greek exposures and dealer-positioning levels like call wall, put wall, gamma flip, and abs gamma, use get_regime with scope="symbol" instead. Up to 5000 days. Large windows return a compact recent/trend summary by default.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(5000).default(30).describe('Days of history (default 30). Ignored if from/to are provided.'),
        from: z.string().optional().describe('Start date (YYYY-MM-DD). Overrides days parameter.'),
        to: z.string().optional().describe('End date (YYYY-MM-DD). Overrides days parameter.'),
        interval: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).default('daily').describe('Sampling interval (default daily)'),
        full: z.boolean().optional().describe('Return less-summarized data (raw shape, still subject to the MCP response budget). Use with narrow date ranges.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, from: fromDate, to: toDate, interval, full }) => {
      const fmt = (d: Date) => d.toISOString().split('T')[0];
      const hasExplicitDates = !!(fromDate || toDate);
      // When explicit dates provided, derive missing bound; otherwise compute from days
      let fromStr: string;
      let toStr: string;
      if (hasExplicitDates) {
        toStr = toDate || fmt(new Date());
        if (fromDate) {
          fromStr = fromDate;
        } else {
          // Derive from by subtracting days from the explicit to date
          const d = new Date(toStr);
          d.setDate(d.getDate() - days);
          fromStr = fmt(d);
        }
      } else {
        toStr = fmt(new Date());
        const d = new Date();
        d.setDate(d.getDate() - days);
        fromStr = fmt(d);
      }

      const params: Record<string, string> = {
        symbol: symbol.toUpperCase(),
        from: fromStr,
        to: toStr,
        interval,
      };
      // Only send limit when using days (no explicit dates) — explicit ranges should not be truncated
      if (!hasExplicitDates) params.limit = String(days);

      const res = await client.get('/history', params) as any;

      if (full && res != null) return { _skipSizeGuard: true, data: res };

      if (shouldSummarizeOptionsAnalyticsHistory(res)) {
        return summarizeOptionsAnalyticsHistory(res);
      }

      // Only trim when using defaults (no explicit from/to) — if user specified range, return full data
      if (!fromDate && !toDate && days === 30) {
        const cap = 30;
        for (const key of Object.keys(res ?? {})) {
          if (Array.isArray(res[key]) && res[key].length > cap) {
            const original = res[key].length;
            res[key] = res[key].slice(-cap);
            res[`_${key}_meta`] = { trimmed: true, original_length: original, returned: cap };
          }
        }
      }

      return res;
    }),
  );
}
