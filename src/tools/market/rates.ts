import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { annotateMatchedRiskFreeRate, annotateRiskFreeRate, tenorYearsParam } from './riskFreeRateShaping.js';
import { summarizeYieldCurve } from './yieldCurveShaping.js';

/**
 * Unified Treasury rates tool. Replaces get_risk_free_rate and
 * get_yield_curve with one enum-driven tool — both read from the
 * same Treasury data pipeline.
 */

const RATES_DESCRIPTION = `Get Treasury rate data. Pick the view that matches the question:

• view="benchmark" — one Treasury rate. With no params, the 10-year yield: the platform's benchmark, which Portfolio Theory's CAPM pairs with the equity risk premium. Options are NOT priced at it: the platform prices each option at the Treasury rate matched to its own expiration. For that rate pass tenorYears (the maturity in years; 0.08 is a month): the answer is the series at or above it (1M to 30Y), named, the rate the platform prices an option of that maturity at. If that series cannot be read, the answer is the 3-month series with a warning saying so, and its rateContext says matched: false.
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
        tenorYears: z.number().min(0.000001).max(100).optional().describe('Only for view=benchmark: a maturity in years (0.08 is a month); answers the Treasury rate matched to it, the rate the platform prices an option of that maturity at.'),
      },
      // openWorldHint is true for public internet access, including read-only calls (OpenAI Apps SDK).
      // The 10-year benchmark without tenorYears can fall back to live public rate feeds when the synced
      // store is missing or stale (proxy RiskFreeRateCache). Matched-tenor and yield-curve reads use stored data only.
      // It cannot publish, submit, trade, or change any public or third-party system.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ view, weeks, full, tenorYears }) => {
      if (view === 'benchmark') {
        if (tenorYears !== undefined) {
          const matched = await client.get('/risk-free-rate', { tenorYears: tenorYearsParam(tenorYears) }) as any;
          return annotateMatchedRiskFreeRate(matched, tenorYears);
        }
        const res = await client.get('/risk-free-rate') as any;
        return annotateRiskFreeRate(res);
      }
      if (tenorYears !== undefined) throw new Error('tenorYears applies to view="benchmark" only');
      const effectiveWeeks = weeks ?? 12;
      const res = await client.get('/treasury/yield-curve', { weeks: String(effectiveWeeks) }) as any;
      if (full) return { _skipSizeGuard: true, data: res };
      // The client's null for a 404 is no data (toolHandler says so), never a shaper reading the null.
      if (res == null) return null;
      return summarizeYieldCurve(res);
    }),
  );
}
