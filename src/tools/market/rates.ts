import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { annotateRiskFreeRate } from './riskFreeRateShaping.js';
import { summarizeYieldCurve } from './yieldCurveShaping.js';

/**
 * Unified Treasury rates tool. Replaces get_risk_free_rate and
 * get_yield_curve with one enum-driven tool — both read from the
 * same Treasury data pipeline.
 */

const RATES_DESCRIPTION = `Get Treasury rate data. Pick the view that matches the question:

• view="benchmark" — current platform risk-free rate served at /risk-free-rate (currently a 10Y-based Treasury rate used for options pricing). No params. If you need shorter maturities (1M, 3M, 6M, 2Y, 5Y), use view="curve" instead.
• view="curve" — full US Treasury yield curve with a compact current-curve summary by default. Returns key maturities, inversion flags, spreads, and small trend samples.`;

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_rates',
    {
      title: 'Treasury Rates',
      description: RATES_DESCRIPTION,
      inputSchema: {
        view: z.enum(['benchmark', 'curve']).describe('Which Treasury view to fetch.'),
        weeks: z.number().int().min(1).max(52).optional().describe('Only for view=curve: history weeks for trend context (default 12).'),
        full: z.boolean().optional().describe('Only for view=curve: return the raw curve payload with historical observations.'),
      },
      // OpenAI app review treats openWorldHint as public-state mutation. This
      // tool may read public rate feeds through the proxy, but it cannot
      // publish, submit, trade, or change public or third-party systems.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ view, weeks, full }) => {
      if (view === 'benchmark') {
        const res = await client.get('/risk-free-rate') as any;
        return annotateRiskFreeRate(res);
      }
      const effectiveWeeks = weeks ?? 12;
      const res = await client.get('/treasury/yield-curve', { weeks: String(effectiveWeeks) }) as any;
      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeYieldCurve(res);
    }),
  );
}
