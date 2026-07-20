import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeEconomicCalendar } from './economicCalendarShaping.js';
import {
  shapeIpoCalendar,
  shapeDividendCalendar,
  shapeSplitCalendar,
} from './corporateActionsShaping.js';

/**
 * Unified calendar tool. Replaces the four previous single-purpose
 * tools (get_economic_calendar / get_ipo_calendar /
 * get_dividend_calendar / get_split_calendar) with one enum-driven
 * tool, keeping per-type shaping and defaults intact.
 */

const CALENDAR_DESCRIPTION = `Get market calendar events by type. Each type has its own default date window, shaping, and optional filters:

• type="economic" - upcoming macro events (FOMC, CPI, NFP, GDP, etc.) that move options vol. Default from=today, to=30d ahead, with a maximum 90-day date range. Supports country (e.g. US, EU, UK). The default view focuses on higher-signal catalysts.
• type="ipo" - upcoming and recent public listings. Default from=30d ago, to=60d ahead, limit=50. Optional symbol filter applied after fetch.
• type="dividend" - cash dividend events (ex-date, record date, payment date). Default from=7d ago, to=30d ahead, limit=100. Optional symbol filter.
• type="split" - stock splits (ratios + dates). Default from=30d ago, to=60d ahead, limit=100. Optional symbol filter.

Irrelevant sub-params are ignored (e.g. country on type=ipo, full on type=dividend).`;

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_market_calendar',
    {
      title: 'Market Calendar',
      description: CALENDAR_DESCRIPTION,
      inputSchema: {
        type: z.enum(['economic', 'ipo', 'dividend', 'split']).describe('Which calendar to fetch.'),
        from: z.string().optional().describe('Start date (YYYY-MM-DD). Type-specific defaults apply when omitted.'),
        to: z.string().optional().describe('End date (YYYY-MM-DD). Type-specific defaults apply when omitted.'),
        limit: z.number().int().min(1).max(200).optional().describe('For ipo/dividend/split: max rows to return (default varies by type). Economic ignores limit and is capped by date range; keep from/to within 90 days.'),
        country: z.string().optional().describe('For economic only: ISO-2 country filter (US, EU, UK, etc.).'),
        symbol: z.string().optional().describe('For ipo/dividend/split only: ticker filter applied after fetch.'),
        full: z.boolean().optional().describe('For economic only: bypass the catalyst-focused summary and return the raw feed.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ type, from, to, limit, country, symbol, full }) => {
      if (type === 'economic') {
        const params: Record<string, string> = {};
        if (from) params.from = from;
        if (to) params.to = to;
        if (country) params.country = country.toUpperCase();
        const res = await client.get('/economic-calendar', params) as any;
        if (full) return { _skipSizeGuard: true, data: Array.isArray(res) ? { events: res } : res };
        return summarizeEconomicCalendar(res);
      }

      const endpointByType = {
        ipo: '/ipo-calendar',
        dividend: '/dividend-calendar',
        split: '/split-calendar',
      } as const;
      const defaultLimitByType = { ipo: 50, dividend: 100, split: 100 } as const;
      const effectiveLimit = limit ?? defaultLimitByType[type];

      const response = await client.get(endpointByType[type], {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });

      if (type === 'ipo') return shapeIpoCalendar(response, effectiveLimit, symbol);
      if (type === 'dividend') return shapeDividendCalendar(response, effectiveLimit, symbol);
      return shapeSplitCalendar(response, effectiveLimit, symbol);
    }),
  );
}
