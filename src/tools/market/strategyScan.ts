import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeStrategyScan } from './strategyScanShaping.js';
import { significantDeep } from './dealerPositioningShaping.js';

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
      title: 'Live Option Strategy Scan',
      description:
        'Scan one expiration of the LIVE options chain, read with the broker credential stored on your Options Analysis Suite account, for candidate trades of one strategy, priced from the broker\'s current quotes. '
        + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Each candidate carries its legs\' quotes (each leg\'s `spreadPct` is its bid-ask spread already in percent of the mid: 0.54 is 0.54%, not 54%) and Greeks, its net credit or debit at the mid and at the natural, max profit, max loss, breakevens, return on risk, a risk-neutral probability of profit, position Greeks and liquidity; the answer adds the expiration\'s expected move (its at-the-money straddle, call mid plus put mid, unscaled), its dealer levels (gamma flip, call wall, put wall, gamma magnet) and every strike\'s distance from spot. '
        + 'Strategies: single calls and puts, long and short; credit and debit vertical spreads; iron condors and iron butterflies; straddles and strangles. '
        + 'A covered call or cash-secured put is the short_call or short_put here, without the stock or cash leg, which is not modelled. '
        + 'On moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked. '
        + 'EXPENSIVE. Cold-call estimates, not actual spend or upper bounds: a scan reads the expirations list and the scanned chain in your broker\'s own requests (3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade and settled to the real count, and on moomoo 3 reserved and settled to what it spent), and up to four more chains with `levels: "window"`. '
        + 'The budget is your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools. '
        + 'Another scan of the same expiration within 15 seconds (same account, broker, `levels` and supplied `r` and `q`), with any other strategy or filters, can be answered from the cached chain with the same `asOf`, quotes and expected move, uncharged and even on a spent budget (the cache is per proxy instance, so a repeat can also be read afresh). '
        + 'Do not call it in a loop or for a list of symbols. '
        + 'For dealer levels alone use get_live_dealer_positioning (live) or get_dealer_positioning (the most recent session on file, 0-60 days, free, no broker).',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, MU)'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe('The expiration to scan, YYYY-MM-DD. It must be one the broker lists; otherwise the refusal names the listed ones.'),
        strategy: z.enum(STRATEGY_SCAN_STRATEGIES).describe('The strategy to build candidates for. '
          + 'Credit strategies: short_put, short_call, bull_put_spread, bear_call_spread, iron_condor, iron_butterfly, short_straddle and short_strangle; the rest are debit. '
          + 'iron_condor and iron_butterfly have both wings `width` away.'),
        deltaMin: z.number().min(0).max(1).optional().describe('Lowest absolute delta of the anchor leg, 0 to 1, read on the delta the broker publishes (a contract with no published delta is never an anchor). '
          + 'The anchor is the option sold for a short or credit strategy, the option bought for a long or debit one, both short strikes of an iron condor or short strangle, both strikes of a long strangle, and the body\'s call for a straddle or iron butterfly. '
          + 'Default bands by strategy: 0.15 to 0.35 for short options, credit spreads and long strangles; 0.3 to 0.6 for long options; 0.4 to 0.6 for debit spreads, straddles and iron butterflies; 0.1 to 0.25 for iron condors and short strangles. '
          + 'Supplying one end keeps the other at the strategy default, and a band whose low end is above its high end is refused (INVALID_REQUEST) before anything is charged. '
          + 'For iron_condor, short_strangle and long_strangle every put-call pair in the band is priced before sorting, so a band giving more than 10,000 pairs is refused (SCAN_TOO_LARGE) after the chain is obtained; a fresh fetch spends broker quota, but a cached chain is free.'),
        deltaMax: z.number().min(0).max(1).optional().describe('Highest absolute delta of the anchor leg, 0 to 1, read on the delta the broker publishes; the anchor, the default bands, the one-ended rule and the pair limit are stated under `deltaMin`. '
          + 'Defaults by strategy: 0.35 for short options, credit spreads and long strangles; 0.6 for long options, debit spreads, straddles and iron butterflies; 0.25 for iron condors and short strangles.'),
        width: z.number().positive().optional()
          .describe('Dollars from the anchor strike to its wing. '
          + 'Required for spreads, iron condors and iron butterflies; ignored otherwise. '
          + 'When that exact strike is not listed, the nearest listed strike within a quarter of the width is used; with none that close the candidate is skipped ("no-wing-strike").'),
        minOpenInterest: z.number().int().min(0).optional().describe('Every leg\'s open interest at least this many contracts; a leg whose open interest is unknown fails it.'),
        maxSpreadPct: z.number().positive().max(1000).optional().describe('Every leg\'s bid-ask spread at most this percent of its mid.'),
        maxNaturalSlippagePct: z.number().min(0).max(1000).optional().describe('The natural price\'s give-up against the mid (netMid minus netNatural over |netMid|, in percent) at most this: the slippage of crossing every leg.'),
        minCredit: z.number().min(0).optional().describe('A credit strategy\'s net credit at the mid at least this, in dollars per share.'),
        sortBy: z.enum(['delta', 'returnOnRisk', 'probabilityOfProfit', 'netPremium']).optional()
          .describe('Order of the candidates. '
          + 'Default "delta": lowest absolute anchor delta first (the mean of both anchors for an iron condor or strangle); an iron butterfly or straddle body instead sorts by its call delta\'s distance from 0.5, smallest first, in the broker\'s decimals (0.45 and 0.55 tie). '
          + '"returnOnRisk" and "probabilityOfProfit" sort highest first; "netPremium" sorts the largest credit, or the smallest debit, first. '
          + 'Nulls sort last, and ties go to the lower first-leg strike. '
          + 'The order used is echoed in `request.sortBy`.'),
        maxResults: z.number().int().min(1).max(25).optional().describe('Candidates to return, 1 to 25. Default 10.'),
        levels: z.enum(['expiration', 'window']).optional()
          .describe('Which book the dealer levels come from: "expiration" (default, this expiration\'s chain, no extra requests) or "window" (the four nearest expirations that may still trade, up to four more chains).'),
        distinct: z.boolean().optional()
          .describe('Iron condors and strangles only: one candidate per anchor strike on each side (default true), built as a ladder: walking the sorted candidates best first, one is kept only while neither of its anchor strikes has been used, so each anchor strike appears once, though not always in its own best pair. '
          + 'false returns every pair.'),
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.'),
        r: z.number().min(-0.1).max(1).optional()
          .describe('Risk-free rate to price with, as a decimal fraction (0.0425 is 4.25%), from -0.1 to 1, used as given instead of the resolved one and never checked against the market; `resolved.r.source` is then "supplied" with no date, and q is resolved as usual. '
          + 'A value outside that range is refused by this tool\'s input check before any request.'),
        q: z.number().min(0).max(1).optional()
          .describe('Dividend yield to price with, as a decimal fraction (0.012 is 1.2%), from 0 to 1, used as given instead of the resolved one and never checked against the market; `resolved.q.source` is then "supplied" with no date, and r is resolved as usual. '
          + 'An index\'s resolved yield is its basket-derived estimate; a volatility index such as VIX has none, and an index whose estimate is unavailable needs this too: without it the call is refused before the session opens and before anything is charged (RESOLUTION_FAILED naming what is missing, or UPSTREAM_UNAVAILABLE, retryable, when the stored yield could not be read). '
          + 'A value outside that range is refused by this tool\'s input check before any request.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async (input) => {
      const params: Record<string, string> = { expiration: input.expiration, strategy: input.strategy };
      for (const key of ['deltaMin', 'deltaMax', 'width', 'minOpenInterest', 'maxSpreadPct', 'minCredit', 'maxNaturalSlippagePct', 'maxResults', 'r', 'q'] as const) {
        const value = input[key];
        if (value !== undefined) params[key] = plainDecimal(value);
      }
      if (input.sortBy) params.sortBy = input.sortBy;
      if (input.levels) params.levels = input.levels;
      if (input.distinct !== undefined) params.distinct = String(input.distinct);
      if (input.provider) params.provider = input.provider;

      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/strategy-scan/${encodeURIComponent(input.symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as Record<string, unknown>;
      // The budget rides inside the fit with the candidates and the guide, no longer added after it.
      return significantDeep(summarizeStrategyScan(res, { rateLimit: budget.rateLimit }));
    }, { liveTool: 'scan' }),
  );
}
