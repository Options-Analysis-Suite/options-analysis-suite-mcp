import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { CONGRESS_NOTE, noCongressRecord, shapeCongressTrades, shapeMarketCongressTrades } from './congressTradesShaping.js';

export const CONGRESS_TRADES_DESCRIPTION =
  'Get trades by members of Congress (Senate and House) and their spouses and dependents, from their STOCK Act periodic transaction reports. '
  + 'scope="symbol" (default) gives one company\'s: `summary` (transactions, purchases, sales, other, members, by chamber, first and last trade, last disclosed) over every transaction on file, and the newest `trades` first. '
  + 'scope="market" gives the trades first disclosed over the last `days` days of disclosures on file (1-365, default 30; an amended report re-listing an older trade is not new), of a `chamber` and `kind`: `summary`, `topCompanies` (the tickers traded most, with purchases, sales and members) and the newest disclosures first. '
  + 'Each trade: `member` with `party` on the trade date (`caucus` for an independent who caucuses with a party), `chamber`, `seat` (state, and district for the House) and `label` (e.g. D-CA-31), `symbol` (the company that traded under the ticker on the trade date; `symbolFiled` when the report named another ticker; null for a bond, fund or private stock, with the report\'s `asset`), `assetType`, `type` (Purchase, Sale (Full), Sale (Partial), Sale, Exchange), `owner`, `amountRange` (the report\'s range: text, min, max), `tradeDate`, `disclosedDate` (the first disclosure), `disclosureLagDays`, `report` (the filing\'s URL) and `alsoInLaterReports`. '
  + '`coverage` gives the disclosures on file per chamber, `tradesMeta` how many are shown of how many, and `congressNote` the rules (ranges, amendments counted once, party by date, ticker matching by date). `congressStatus` says when none are on record.';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_congress_trades',
    {
      title: 'Congress Trades',
      description: CONGRESS_TRADES_DESCRIPTION,
      inputSchema: {
        symbol: z.string().optional().describe('Ticker symbol (e.g., NVDA). Required unless scope is "market".'),
        scope: z.enum(['symbol', 'market']).default('symbol').describe('symbol (default): one company\'s trades. market: trades first disclosed across companies over the last `days`.'),
        days: z.number().int().min(1).max(365).default(30).describe('scope market: days of disclosures, ending on the newest disclosure on file (1-365, default 30).'),
        chamber: z.enum(['all', 'senate', 'house']).default('all').describe('scope market: both chambers (default), the Senate or the House.'),
        kind: z.enum(['all', 'purchases', 'sales']).default('all').describe('scope market: every trade (default), purchases or sales.'),
        limit: z.number().int().min(1).max(50).default(25).describe('How many trades to list, newest first (1-50, default 25). The totals count them all.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, scope, days, chamber, kind, limit }) => {
      if (scope === 'market') {
        const res = await client.get('/market/congress-trades', { days: String(days), chamber, kind, limit: String(limit) });
        return shapeMarketCongressTrades(res, { limit });
      }
      if (!symbol) throw new Error("scope='symbol' requires `symbol`");
      const upper = symbol.toUpperCase();
      const res = await client.get(`/congress-trades/${encodeURIComponent(upper)}`, { limit: String(limit) });
      // None on record (a 404) is an answer: the status says so.
      if (res == null) return noCongressRecord(upper);
      return shapeCongressTrades(res, { limit });
    }),
  );
}

export { CONGRESS_NOTE };
