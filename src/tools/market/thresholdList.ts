import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { displayThresholdSource, summarizeThresholdHistory } from './thresholdHistoryShaping.js';

function sanitizeThresholdSource(value: unknown, depth = 0): void {
  if (depth > 8 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) sanitizeThresholdSource(item, depth + 1);
    return;
  }

  const obj = value as Record<string, unknown>;
  if ('source' in obj) obj.source = displayThresholdSource(obj.source);
  for (const child of Object.values(obj)) sanitizeThresholdSource(child, depth + 1);
}

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_threshold_history',
    {
      title: 'Threshold List History',
      description: 'Get SEC Regulation SHO threshold-list history for a symbol with a compact status summary by default. Highlights whether the symbol is currently on the list, recently cleared, or only appeared historically in the requested window.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        days: z.number().int().min(1).max(90).default(30).describe('Number of days to check (default 30, max 90)'),
        full: z.boolean().optional().describe('Return the raw threshold-history payload instead of the compact summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, full }) => {
      // Backend requires comma-separated dates. Generate last N trading days (skip weekends).
      const dates: string[] = [];
      const d = new Date();
      while (dates.length < days) {
        d.setDate(d.getDate() - 1);
        const dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) {
          dates.push(d.toISOString().split('T')[0]);
        }
      }
      const response = await client.get(`/sec/threshold-history/${encodeURIComponent(symbol.toUpperCase())}`, {
        dates: dates.join(','),
      });
      if (full) {
        sanitizeThresholdSource(response);
        return { _skipSizeGuard: true, data: response };
      }
      return summarizeThresholdHistory(response as Record<string, unknown>, dates);
    }),
  );
}
