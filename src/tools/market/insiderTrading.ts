import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { noInsiderRecord, shapeInsiderTradingResponse, shapeMarketInsiderTrades, type MarketInsiderResponse } from './insiderTradingShaping.js';

export const INSIDER_TRADING_DESCRIPTION =
  'Get insider trading activity for a company. Default response focuses on purchases and sales (Form 4 codes P and S, made on the open market or privately: the code alone does not say which, though a filing\'s footnotes sometimes do), groups repeated filing rows into event-level summaries, and summarizes awards/exercises/tax withholding separately: `summary` counts the purchases and sales among the company\'s newest filing lines on file (up to 500; `summary.period` gives the dates they span), with their values to the cent and the net, `insiderTradesMeta` says what is listed, and `insiderTradesStatus` says when nothing is on record (naming an exchange-traded product as one, by the profile\'s fund flag). Lines filed under an issuer CIK other than the company profile\'s are left out of the list and the summary (such a CIK can be a predecessor\'s after a reorganization or redomicile, a former holder of the ticker\'s, or another issuer this company or its insiders report holding; the CIK alone does not say which): `summary.otherIssuerLines` counts them, `otherIssuers` gives each CIK\'s lines, dates, security names and purchases and sales, and `full` returns the raw lines with each one\'s `companyCik`. '
  + '`quarterlyStatistics` counts the company\'s own reported Form 4 and Form 5 lines (another issuer CIK\'s left out; with no profile CIK on record, `quarterlyStatisticsMeta.issuer` is "unconfirmed" and the lines, naming one issuer at most, are counted as the company\'s) by transaction-date quarter, newest first, from every page of filings the sync read (for a busy company deeper than the 500 lines listed): per quarter, `purchases` and `sales` (codes P / S in the company\'s shares: lines, distinct `filings` and `reporters`, `shares`, and the `value` of the `pricedLines`), P / S lines on other securities, and other acquisitions and dispositions, each counted apart; Form 3 holdings are left out, and an amendment is not reconciled with the filing it amends. The `provisional` quarter is the current one, which later filings can change; a quarter is listed only when every filing for it was read (`quarterlyStatisticsMeta`: `readToEnd`, `oldestFilingRead`, `completeFrom`), so a quarter listed with zero lines had none. `quarterlyStatisticsNote` says when they are not computed yet or cannot be given. '
  + 'scope="market" instead reads the insider filings of every covered company over the last `days` calendar days (1-30, default 7) ending on the newest filing day on file: '
  + '`totals` (purchases and sales, codes P and S, which a filing codes the same on the open market or privately: each its lines and dollar value, and the net), `topPurchases` and `topSales` (the ten companies with the most value of each), '
  + 'and the window\'s individual Form 3, 4 and 5 lines, newest filing day first, ungrouped: `kind` "purchases" (default), "sales", or "all" (adding awards, exercises, gifts and tax withholding); `limit` lines (1-50, default 25), `tradesMeta` when the window holds more than are listed (by `limit`, or with `trimmedForSize` by the response size budget). '
  + 'A market line is valued only when it is the company\'s listed stock and, where a close is on file, priced near it: `valueWithheld` marks a line with a price and shares left unvalued and `issuerUnconfirmed` a line whose filing names an issuer that could not be confirmed as the company (never valued, never totaled); `note` has the rule.';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_insider_trading',
    {
      title: 'Insider Trading',
      description: INSIDER_TRADING_DESCRIPTION,
      inputSchema: {
        symbol: z.string().optional().describe('Ticker symbol. Required unless scope is "market".'),
        scope: z.enum(['symbol', 'market']).default('symbol').describe('symbol (default): one company\'s insider activity. market: insider filings across covered companies.'),
        days: z.number().int().min(1).max(30).default(7).describe('scope market: calendar days of filings, ending on the newest filing day on file (1-30, default 7).'),
        kind: z.enum(['purchases', 'sales', 'all']).default('purchases').describe('scope market: which lines to list - purchases (default), sales, or every transaction. The totals and top lists cover purchases and sales whatever the kind.'),
        limit: z.number().int().min(1).max(50).default(25).describe('scope market: how many lines to list (1-50, default 25).'),
        full: z.boolean().optional().describe('Return the less-summarized insider-trading feed (raw shape, still subject to the MCP response budget; scope symbol).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, scope, days, kind, limit, full }) => {
      if (scope === 'market') {
        const res = await client.get('/market/insider-trades', { days: String(days), kind, limit: String(limit) }) as MarketInsiderResponse | null;
        return shapeMarketInsiderTrades(res, kind);
      }
      if (!symbol) throw new Error("scope='symbol' requires `symbol`");
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const [res, companyProfile] = await Promise.all([
        client.get(`/insider-trading/${upperSymbol}`) as Promise<any>,
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
      ]);
      // No record on file (a 404) is an answer: the status says what it means.
      if (res == null) return noInsiderRecord(symbol.toUpperCase(), companyProfile);
      if (full) return { _skipSizeGuard: true, data: res };
      return shapeInsiderTradingResponse(res, companyProfile);
    }),
  );
}
