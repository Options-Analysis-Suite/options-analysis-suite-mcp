import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { estimatesCurrencyContext, summarizeAnalystData } from './analystDataShaping.js';

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_analyst_data',
    {
      title: 'Analyst Data',
      description: 'Get Wall Street analyst ratings, price targets, and consensus estimates for a symbol. Default response keeps the nearest forward estimate periods, price-target summaries, the analysts\' monthly rating counts and their 12-month history, recent individual price targets, recent rating changes, and the quantitative rating. '
        + '`ratingCounts` is how many analysts rate the stock strong buy, buy, hold, sell and strong sell in the newest monthly count, with its `month` and `total`; it is given only while that month is at most two months back (otherwise it is null and `ratingCountsNote` names the newest month on file, or says the counts have not been fetched yet or none are on file). `ratingHistory` holds the 12 months to the newest count, newest first, and `ratingHistoryMeta.missingMonths` names the months in that span with no count on file. '
        + '`priceTargets` lists individual targets published in the last 12 months, newest first: the `firm`, the `analyst` (null when not named), the `priceTarget`, a `splitAdjustedPriceTarget` when it differs, and the `priceWhenPosted`; `priceTargetsMeta.publishedLast12Months` counts the year\'s targets on file, the year\'s whole count only when `countComplete` (the list on file reaches back past the year; otherwise the year holds at least that many). `priceTargets` is null, with `priceTargetsNote`, when individual targets have not been fetched yet. '
        + '`ratingSnapshot` and the `historicalRating` streaks are a quantitative model grade from six valuation and financial measures, each scored 1 to 5, not analysts\' ratings. `estimates` lists forward periods first, soonest first, then past periods newest first, so the nearest forward periods are the ones kept when the list is capped. Each rating streak runs from `fromDate`, its oldest observation, through `throughDate`, its newest, and the streaks are newest first. '
        + '`estimatesCurrency` gives the currency the company\'s newest statement reports in, with that statement\'s date, and the one the listing trades in: the estimates carry none of their own and are normally in the reporting currency, but are refreshed apart from the statements, so around a change of reporting currency the two can disagree; `estimatesCurrencyNote` says so when the reporting currency differs from the listing\'s, in which the price targets are.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, TSLA)'),
        full: z.boolean().optional().describe('Include the full stored analyst payload: the complete estimate, quantitative-rating history, monthly rating-count and price-target arrays. Default false returns a compact summary view.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const [res, companyProfile] = await Promise.all([
        client.get(`/analyst-data/${upperSymbol}`),
        client.get(`/company-profile/${upperSymbol}`).catch(() => null),
      ]);
      if (full) return { _skipSizeGuard: true, data: res && typeof res === 'object' ? { ...(res as object), ...estimatesCurrencyContext(res, companyProfile) } : res };
      return summarizeAnalystData(res, undefined, undefined, undefined, undefined, companyProfile);
    }),
  );
}
