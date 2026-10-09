import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { currencyContext, dividendYieldUnreadFields, noFundamentalsRecord, shapeFundamentalsFull, summarizeFundamentals } from './fundamentalsShaping.js';
import { READ_FAILED, shapeValuation } from './marketIntelShaping.js';

export const FUNDAMENTALS_DESCRIPTION =
  'Get company fundamentals: market cap, P/E ratio, EPS, revenue, profit margins, dividend yield, beta, sector, and industry. Useful for assessing whether an options strategy aligns with the fundamental picture. Default response returns compact company metadata, curated TTM ratios/key metrics, and one summarized recent statement entry per financial statement. '
  + 'It also returns `valuation`: `peers`, the trailing P/E beside the company\'s sector\'s and industry\'s P/E among the companies listed on its own exchange (NYSE, NASDAQ and AMEX only) with `premiumPct` for each, and `marketCap`, the latest market cap with its change over one and five years from weekly history; a part with nothing to show is null with a note saying why. '
  + '`currencies` gives the currency the newest statement on file reports in, with that statement\'s date (each statement names its own in `reportedCurrency`; the TTM amounts and per-share figures carry none: they are normally in the company\'s reporting currency, this one, but are refreshed apart from the statements, so around a change of reporting currency the two can disagree), and the one the listing trades in (the profile and the market-cap history), with `currencyNote` when they differ. '
  + 'When the symbol has no fundamentals record the answer is `fundamentalsStatus` (naming an exchange-traded product as one), not a payload. '
  + 'The TTM figures are refreshed both with the company\'s statements (`fetchedAt`) and from daily files (`ttmBulkAsOf`, the files\' own date); the two stamps record those refreshes, not which one wrote the figures shown.';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_fundamentals',
    {
      title: 'Fundamentals',
      description: FUNDAMENTALS_DESCRIPTION,
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        full: z.boolean().optional().describe('Include the full raw financial statements payload (annual + quarterly), with `valuation` beside it: each statement\'s newest periods up to one shared count, the most that fits the response budget beside the TTM figures and `valuation` (a list shorter than the count keeps all of its own), with `fullMeta` giving the count and each list\'s periods on file when some are left out. Default false returns a compact fundamentals summary.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      // The valuation reads stand apart: an outage there leaves the fundamentals standing.
      const failed = () => READ_FAILED;
      const [res, companyProfile, dividendYield, sectors, industries, capHistory] = await Promise.all([
        client.get(`/fundamentals/${upperSymbol}`),
        (client.get(`/company-profile/${upperSymbol}`) as Promise<unknown>).catch(failed),
        // Trailing dividend yield from the shared /dividend-yield endpoint (stored ratios-ttm for
        // companies, profile last_div / close for funds) - reused, not re-derived. Funds carry no
        // ratios-ttm dividendYieldTTM, so this is the only place an ETF yield surfaces here.
        // A failed call is an unread yield (stated), never silent absence.
        client.get(`/dividend-yield/${upperSymbol}`).catch(() => ({ reason: 'read_failed' })),
        (client.get('/market/sector-metrics', { kind: 'sector' }) as Promise<any>).catch(failed),
        (client.get('/market/sector-metrics', { kind: 'industry' }) as Promise<any>).catch(failed),
        (client.get(`/market-cap-history/${upperSymbol}`) as Promise<any>).catch(failed),
      ]);
      // No statements on record (a 404) is an answer: the status says what it means, on either path.
      if (res == null) return noFundamentalsRecord(symbol.toUpperCase(), companyProfile);
      const valuation = shapeValuation(res, companyProfile, sectors, industries, capHistory, full ? 'full' : 'summary');
      if (full) return { _skipSizeGuard: true, data: shapeFundamentalsFull(res, { valuation, ...currencyContext(res, companyProfile, 'full'), ...dividendYieldUnreadFields(res, dividendYield) }) };
      // A failed profile read reads as no profile there (any non-object is absent).
      const summary = summarizeFundamentals(res, companyProfile, dividendYield);
      return summary && typeof summary === 'object' ? { ...summary, valuation } : summary;
    }),
  );
}
