import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeStrategyScan } from './strategyScanShaping.js';

/**
 * Strategy candidates from one expiration of the caller's live chain.
 *
 * The proxy's /live/strategy-scan prices every candidate from two-sided
 * quotes (packages/shared/src/broker/strategyScan.ts) and computes the dealer
 * levels on the same chain; this tool gates those levels on coverage and adds
 * distances from spot. The strategy list, default delta bands and costs are
 * the proxy's; the description states them so a caller can plan a call.
 */
export const STRATEGY_SCAN_STRATEGIES = [
  'short_put', 'short_call', 'long_call', 'long_put',
  'bull_put_spread', 'bear_call_spread', 'bull_call_spread', 'bear_put_spread',
  'iron_condor', 'iron_butterfly',
  'short_straddle', 'long_straddle', 'short_strangle', 'long_strangle',
] as const;

/**
 * The number as the shortest decimal that reads back to it (String(x)), with
 * an exponent form written out: the proxy accepts plain decimals only, and
 * rounding instead moved 0.30000000001 to 0.3 and 1e-11 to 0.
 */
export function plainDecimal(value: number): string {
  const text = String(value);
  const [mantissa, exponentText] = text.toLowerCase().split('e');
  if (exponentText === undefined) return text;
  const negative = mantissa.startsWith('-');
  const [whole, fraction = ''] = (negative ? mantissa.slice(1) : mantissa).split('.');
  const digits = whole + fraction;
  const point = whole.length + Number(exponentText);
  const plain = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`;
  return (negative ? '-' : '') + plain;
}

export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'scan_option_strategies',
    {
      title: 'Live Option Strategy Scan (Pro)',
      description:
        'Scan one expiration of the LIVE options chain, from the broker credential stored on your Options Analysis Suite account, for candidate trades of one strategy, priced from the current quotes. '
        + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Strategies: short_put, short_call, long_call and long_put; bull_put_spread and bear_call_spread (credit) and bull_call_spread and bear_put_spread (debit); iron_condor and iron_butterfly (credit, both wings `width` away); short_straddle, long_straddle, short_strangle and long_strangle. A covered call or cash-secured put is the short_call or short_put here, without the stock or cash leg, which is not modelled. '
        + 'The delta band (`deltaMin` to `deltaMax`, absolute) selects the anchor leg: the option sold for a short or credit strategy, the option bought for a long or debit one, both short strikes of a condor or short strangle and both strikes of a long strangle, and the body\'s call for a straddle or butterfly. Unset, it defaults by strategy: 0.15 to 0.35 for short options and credit spreads, 0.3 to 0.6 for long options, 0.4 to 0.6 for debit spreads, straddles and butterflies, 0.1 to 0.25 for iron condors and short strangles, 0.15 to 0.35 for long strangles. '
        + '`width` is the dollars from an anchor to its wing, required for spreads, condors and butterflies; when that exact strike is not listed, the nearest within a quarter of the width is used and the candidate\'s `width` says what was listed. '
        + 'Every leg needs a two-sided quote, and a sold leg a bid above zero; a candidate missing one is counted in `skipped` by reason, never priced from a last trade or a mark, and a spread whose credit or debit reaches its width is skipped as not a real price. '
        + 'Each candidate carries every leg\'s bid, ask, mid, spread as a percent of the mid, IV, Greeks as the broker publishes them, open interest and volume; `netMid` (sold mids minus bought mids, positive a credit) and `netNatural` (sold bids minus bought asks); max profit, max loss, breakevens and `returnOnRisk` (max profit over max loss) at expiration from the mid, per share and null where unbounded (an iron condor or butterfly whose credit exceeds one wing keeps money on that whole side, so it has no breakeven there and its max loss is on the wider wing); and `position`, the Greeks of one of each leg times 100, sold legs negative. '
        + '`probabilityOfProfit` is the risk-neutral probability, under a lognormal model, that the price at expiration ends where the position makes money at the mid, each breakeven read at the implied volatility the chain\'s own smile gives at that price, with the resolved rate and dividend yield; `probabilityOfMaxProfit` is the same for the region of maximum profit, null where that is a single price (a butterfly or straddle body) or unbounded. They are model values, not forecasts: they take no view on direction, implied volatility has tended to run above realized so short-premium outcomes have tended to beat them, and they ignore early assignment, fills and costs. Delta is not used as a probability. '
        + '`expectedMove` is this expiration\'s at-the-money straddle, and each breakeven says whether it lies outside that range. `levels` are the gamma flip, call wall, put wall and magnet computed on this expiration\'s own chain, or with `levels: "window"` on the four nearest expirations, the book get_live_dealer_positioning reports by default; each is withheld under incomplete coverage as that tool withholds it. Every strike, breakeven and level carries its distance from spot in percent. '
        + 'Filters: `minOpenInterest` and `maxSpreadPct` apply to every leg (an unknown open interest fails a minimum), `minCredit` to a credit strategy\'s `netMid`. `sortBy`: "delta" (default: the anchor delta ascending, farthest from the money first), "returnOnRisk", "probabilityOfProfit", or "netPremium" (largest credit, or smallest debit, first); these orderings do not rank trades as better or worse. `matched` counts every candidate before `maxResults` (default 10, max 25), and `limitedBySize` is true when the last ones were dropped to fit the response. '
        + 'EXPENSIVE: a scan is charged two weighted units against the 10-unit-per-minute live-broker limit, so at most five a minute, and five units with `levels: "window"`. The chain, rate, yield, levels and expected move are cached for 15 seconds per symbol, expiration, broker and `levels`, so another scan of the same expiration within 15 seconds, with any other strategy or filters, re-scans the cached chain with the same `asOf` and is still charged in full. Do not call it in a loop or for a list of symbols. '
        + 'An iron condor or strangle prices every put-call pair in the band before sorting, so a band giving more than 10,000 pairs is refused (SCAN_TOO_LARGE, naming the count) after the chain is read and charged; a narrower band within 15 seconds re-scans the cached chain. '
        + 'It refuses rather than defaulting a rate or dividend yield it cannot source (RESOLUTION_FAILED) and an expiration the broker does not list (UNKNOWN_EXPIRATION, naming the listed ones); a malformed parameter (INVALID_REQUEST), symbol (INVALID_SYMBOL) or provider (UNKNOWN_PROVIDER) is refused before it is charged.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, MU)'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('The expiration to scan, YYYY-MM-DD. It must be one the broker lists; otherwise the refusal names the listed ones.'),
        strategy: z.enum(STRATEGY_SCAN_STRATEGIES).describe('The strategy to build candidates for.'),
        deltaMin: z.number().min(0).max(1).optional().describe('Lowest absolute delta of the anchor leg, 0 to 1. Defaults by strategy.'),
        deltaMax: z.number().min(0).max(1).optional().describe('Highest absolute delta of the anchor leg, 0 to 1. Defaults by strategy.'),
        width: z.number().positive().optional()
          .describe('Dollars from the anchor strike to its wing. Required for spreads, iron condors and iron butterflies; ignored otherwise.'),
        minOpenInterest: z.number().int().min(0).optional().describe('Every leg\'s open interest at least this many contracts.'),
        maxSpreadPct: z.number().positive().max(1000).optional().describe('Every leg\'s bid-ask spread at most this percent of its mid.'),
        minCredit: z.number().min(0).optional().describe('A credit strategy\'s net credit at the mid at least this, in dollars per share.'),
        sortBy: z.enum(['delta', 'returnOnRisk', 'probabilityOfProfit', 'netPremium']).optional()
          .describe('Order of the candidates. Default "delta".'),
        maxResults: z.number().int().min(1).max(25).optional().describe('Candidates to return, 1 to 25. Default 10.'),
        levels: z.enum(['expiration', 'window']).optional()
          .describe('Which book the dealer levels come from: "expiration" (default, this expiration\'s chain, two units) or "window" (the four nearest expirations, five units).'),
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async (input) => {
      const params: Record<string, string> = { expiration: input.expiration, strategy: input.strategy };
      for (const key of ['deltaMin', 'deltaMax', 'width', 'minOpenInterest', 'maxSpreadPct', 'minCredit', 'maxResults'] as const) {
        const value = input[key];
        if (value !== undefined) params[key] = plainDecimal(value);
      }
      if (input.sortBy) params.sortBy = input.sortBy;
      if (input.levels) params.levels = input.levels;
      if (input.provider) params.provider = input.provider;

      const res = await client.get(
        `/live/strategy-scan/${encodeURIComponent(input.symbol.toUpperCase())}`,
        params,
      ) as Record<string, unknown>;
      return summarizeStrategyScan(res);
    }),
  );
}
