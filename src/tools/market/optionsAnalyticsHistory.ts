import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import {
  HISTORY_V2_NOTE,
  labelOptionsAnalyticsHistory,
  methodology2History,
  shouldSummarizeOptionsAnalyticsHistory,
  summarizeOptionsAnalyticsHistory,
  withoutExposureColumns,
  type HistoryMethodology,
} from './optionsAnalyticsHistoryShaping.js';
import { DEFAULT_UNREADABLE, methodologyInput, methodologyLabel, resolveMethodology } from '../exposureMethodology.js';
import { HISTORY_PROVENANCE_TIMES } from './provenanceShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_options_analytics_history',
    {
      title: 'Options Analytics History',
      description: 'Get daily end-of-day options analytics snapshots for a symbol - historical trend data going back years. Covers ATM IV, HV, IV rank/percentile, VWIV, skew, the exposures by `methodology` (1: GEX/DEX/VEX and net vanna/charm/vomma; 2: the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma), put/call ratio, max pain, the 30-day expected move (`expectedMove30dFraction`, a decimal fraction of spot: 0.018 = 1.8%), term structure, and risk-free rate. Best for trend analysis over time. The GEX and DEX here are over ALL expirations on file, while get_dealer_positioning reports the 0-60 day window, so the two differ for the same session and neither is wrong. Long-dated contracts carry large delta, so the two can differ even in sign (SPY 2026-09-29: net DEX -16,795,316,756 over all expirations against +16,246,461,968 over 0-60 days). Under methodology 2 (`methodology`) this, get_options_snapshot and get_dealer_positioning report one stored book, the assumed dealer book, over the scope each answer states; only get_dealer_positioning\'s levels keep the 0-60 day window. For current authoritative Greek exposures and dealer-positioning levels like call wall, put wall, gamma flip, and gamma magnet, use get_regime with scope="symbol" instead. Up to 5000 days. Large windows return a compact recent/trend summary by default. The raw shape lists every row in the window oldest first; the summary keeps the newest `dataMeta.recent` rows in `data`, newest first, and `count` is the rows in the whole window, not in `data`; `dataMeta.order` on either shape says which way it runs; summary points are compact: twenty fields, IVs and ratios rounded to four decimals, prices to two, the slope and rate to five, exposures to whole numbers, and `latest`, `earliest` and `trendSample` are the same compact shape.' + HISTORY_PROVENANCE_TIMES,
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(5000).default(30).describe('Days of history (default 30). Ignored if from/to are provided.'),
        from: z.string().optional().describe('Start date (YYYY-MM-DD). Overrides days parameter.'),
        to: z.string().optional().describe('End date (YYYY-MM-DD). Overrides days parameter.'),
        interval: z.enum(['daily', 'weekly', 'biweekly', 'monthly']).default('daily').describe('Sampling interval (default daily)'),
        full: z.boolean().optional().describe('Return the raw row shape instead of the compact summary. Windows of 90 rows or fewer are already raw, so it changes nothing there; use it with narrow explicit ranges. Still subject to the MCP response budget.'),
        methodology: methodologyInput('For the exposure columns. '),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, from: fromDate, to: toDate, interval, full, methodology }) => {
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

      // The exposure columns' methodology: named, else the platform default; every row carries them, so it is
      // read before the request (methodology 2 is the route's `exposure=v2`, U7b). An unreadable default withholds the
      // exposure columns and answers the rest. No v2rev: that generation decides only the edge cache, and this
      // server reads the origin, which qualifies each day under the live repair state either way.
      const resolved = await resolveMethodology(client, methodology);
      const mode: HistoryMethodology = resolved === null ? null : resolved.methodology;
      if (mode === 2) params.exposure = 'v2';

      const fetched = await client.get('/history', params) as any;
      const res = mode === 2 ? methodology2History(fetched) : mode === null ? withoutExposureColumns(fetched) : fetched;
      const answerFields = resolved === null
        ? { exposuresWithheld: DEFAULT_UNREADABLE }
        : { ...methodologyLabel(resolved), ...(mode === 2 ? { methodologyNote: HISTORY_V2_NOTE } : {}) };
      const labeled = (body: unknown) => (body && typeof body === 'object' && !Array.isArray(body) ? { ...answerFields, ...body } : body);

      // Every path names the expected move by its unit: the summarizer does it
      // itself past 90 rows, and the `full` and short paths are labelled here.
      // A first fix covered the summarizer only, so the default 30-day window
      // still published the column name.
      if (full && res != null) return { _skipSizeGuard: true, data: labeled(labelOptionsAnalyticsHistory(res)) };

      if (shouldSummarizeOptionsAnalyticsHistory(res)) {
        return labeled(summarizeOptionsAnalyticsHistory(res, undefined, undefined, mode));
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

      return labeled(labelOptionsAnalyticsHistory(res));
    }),
  );
}
