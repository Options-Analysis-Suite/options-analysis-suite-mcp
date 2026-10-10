import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeDealFlags, shapeMnaFilings, shapeSecFilingsResponse } from './secFilingsShaping.js';

const FILING_TYPE = z.enum([
  'all',
  '10-K',
  '10-Q',
  '8-K',
  'S-1',
  'S-3',
  'S-3ASR',
  'F-3',
  'S-4',
  'F-4',
  '425',
  'PREM14A',
  'DEFM14A',
  'SC TO-T',
  'SC 14D9',
  'SC 13E3',
  'DEF 14A',
  '4',
  '13D',
  '13G',
  '424B2',
  '424B3',
  '424B4',
  '424B5',
]);

export const SEC_FILINGS_DESCRIPTION =
  'Get recent SEC EDGAR filings for a symbol. Useful for finding 10-K, 10-Q, 8-K, proxy, insider, offering, merger and activist filings with direct SEC URLs. '
  + 'Default response returns a compact filing list with dates, form types, descriptions, accession numbers, and filing links, plus `dealFlags`: '
  + '`merger`, the newest merger, tender offer or going-private filing (S-4, F-4, 425, merger proxies, SC TO-T, SC 14D9, SC 13E3) within 120 days, '
  + 'and `offering`, the newest shelf registration (S-3, F-3) or securities offering (424B prospectus) within 30 days, each with what it is, its EDGAR link, '
  + 'the other companies the filing names (`counterparties`, with their tickers) and `flagUntil`, the day it lapses; `indexThrough` is the last EDGAR daily index read. '
  + 'A shelf or prospectus may register debt as well as stock: the filing says which. The filing behind a flag can be another company\'s (an S-4 filed under the acquirer\'s CIK names this company as its target), so it need not appear in `recentFilings`. A fund or ETF is left out of the company filer map the flags are read from, so `dealFlags` is null with `dealFlagsNote`. '
  + 'scope="market" instead lists the merger, tender offer and going-private filings of the last `days` (1-90, default 30) that name a covered US-listed company, '
  + 'newest first, every party with its tickers; `limit` caps the list and `filingsMeta` says when it is trimmed.';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_sec_filings',
    {
      title: 'SEC Filings',
      description: SEC_FILINGS_DESCRIPTION,
      inputSchema: {
        symbol: z.string().optional().describe('Ticker symbol (e.g., AAPL, TSLA). Required unless scope is "market".'),
        scope: z.enum(['symbol', 'market']).default('symbol').describe('symbol (default): one company\'s filings and its merger / offering flags. market: recent merger, tender offer and going-private filings across covered companies.'),
        limit: z.number().int().min(1).max(50).default(10).describe('Maximum number of filings to return (default 10, max 50).'),
        type: FILING_TYPE.default('all').describe('Optional SEC form-type filter (scope symbol). Use 424B2/3/4/5 for prospectus supplements; default all returns the most recent mixed filing list.'),
        days: z.number().int().min(1).max(90).default(30).describe('scope market: how many days of filings, 1-90 (default 30).'),
        full: z.boolean().optional().describe('Return the raw SEC EDGAR filing payload instead of the compact summary (scope symbol).'),
      },
      // OpenAI app review treats openWorldHint as public-state mutation. This
      // tool may read public SEC EDGAR data through the proxy, but it cannot
      // submit filings or change public or third-party systems.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, scope, limit, type, days, full }) => {
      if (scope === 'market') {
        const market = await client.get('/market/mna-filings', { days: String(days) }) as any;
        return shapeMnaFilings(market, limit);
      }
      if (!symbol) throw new Error("scope='symbol' requires `symbol`");
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      // The flags are their own read: a failure there leaves the filing list standing.
      const [response, flags] = await Promise.all([
        client.get(`/sec-filings/${upperSymbol}`, {
          limit: String(limit),
          ...(type !== 'all' ? { type } : {}),
        }) as Promise<any>,
        (client.get(`/sec-corporate-filings/${upperSymbol}`) as Promise<any>)
          .then(payload => shapeDealFlags(payload), () => shapeDealFlags(null, true)),
      ]);

      if (full) {
        return { _skipSizeGuard: true, data: { ...response, ...flags } };
      }

      // The client's null for a 404 is the confirmed absence of filings: an empty list beside the deal flags (their own
      // read), never a shaper reading the null.
      return { ...shapeSecFilingsResponse(response ?? { filings: [] }, limit), ...flags };
    }),
  );
}
