import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeScenario } from './computeScenarioShaping.js';

/**
 * A strategy repriced across spot, vol and time, with an optional fit against
 * the positions the user already holds, through the proxy's scenario route.
 *
 * THE ROUTE IS THE VALIDATOR, as for compute_black_scholes: the leg rules
 * (a strike and exactly one tenor form per option leg, none on a stock leg),
 * the resolution ladder (caller, then the stored end-of-day tables, never a
 * default) and the grid caps live on the proxy, whose refusal envelope names
 * the field. The schema here describes them so the model composes a call
 * that passes, and does not enforce a second copy that could drift.
 */
const legSchema = z.object({
  type: z.enum(['call', 'put', 'stock']).describe('Option type, or stock for shares of the underlying.'),
  side: z.enum(['long', 'short']),
  quantity: z.number().positive().optional().describe('Contracts for an option, shares for stock. Default 1.'),
  strike: z.number().positive().optional().describe('Required for an option leg; absent for stock.'),
  expiration: z.string().optional().describe('YYYY-MM-DD. One of expiration, daysToExpiry or t per option leg. Needed to resolve the leg\'s IV from the stored chain when iv is not supplied.'),
  daysToExpiry: z.number().positive().optional().describe('Days to expiry on dayCount. One of expiration, daysToExpiry or t.'),
  t: z.number().positive().optional().describe('Years to expiry. One of expiration, daysToExpiry or t.'),
  premium: z.number().nonnegative().optional().describe('Entry premium per share for an option leg. Omit it and the leg\'s own base model price is the entry, so its base-cell P&L is zero.'),
  costBasis: z.number().positive().optional().describe('Entry price per share for a stock leg. Omit it and spot is the entry.'),
  iv: z.number().nonnegative().optional().describe('The leg\'s implied volatility as a decimal (0.25 for 25%). Omit it, with symbol and expiration, to read the stored chain\'s vol at the nearest strike.'),
  isAmerican: z.boolean().optional().describe('Price on a binomial tree with early exercise. Default European Black-Scholes.'),
  steps: z.number().int().min(10).max(200).optional().describe('Tree steps for an American leg. Default 100.'),
});

const positionSchema = z.object({
  symbol: z.string(),
  legs: z.array(legSchema).min(1).max(10),
  spot: z.number().positive().optional(),
  r: z.number().optional(),
  q: z.number().optional(),
});

export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'compute_scenario',
    {
      title: 'Scenario and Portfolio Fit',
      description:
        'Reprice a multi-leg options strategy across spot moves, implied-volatility shocks and days elapsed, and return a P&L grid, the base position Greeks, and optionally how the strategy fits beside the positions you already hold (`portfolioFit`). '
        + 'It makes no broker call. For one European option without a grid, use compute_black_scholes. '
        + 'Legs are supplied in the call (up to ten: calls, puts and stock), or by `strategyKey`: a strategy the user sent from the Strategy page (listed by get_snapshot type "strategy"), whose symbol, legs, premiums, vols, rates and spot are read from the record with source "record" and the record\'s date, a value supplied in the call still winning. '
        + 'Spot and each leg\'s IV are taken as supplied, else resolved from the stored end-of-day snapshot and chain for the symbol with their source and date named; r and q are supplied or resolved, never defaulted (the `r` and `q` parameters say how), each option leg pricing at its own rate (`legs[i].r`), held across the whole grid, with `inputs.r` the shortest option leg\'s; a request with an input that cannot be resolved is refused naming every missing field. '
        + 'Vol shocks are in vol points (0.20 plus 5 points is 0.25); days elapsed are on dayCount, and a leg whose time has elapsed is valued at its intrinsic, never through the pricer\'s one-minute floor. '
        + 'Cells are pnl[spotMove][ivShock][daysElapsed] in currency: signed quantity times the multiplier (100 per contract, 1 per share) against each leg\'s entry premium. '
        + 'A supplied or record entry premium carries `impliedVol` (the vol that premium implies at the leg\'s own model) and `volGapPoints` (that vol less the leg\'s, in points); both are null with `impliedVolReason` when no vol prices the premium ("below-zero-vol-value", "above-max-vol-value") or vols are not told apart there ("not-identifiable": a deep in-the-money American leg worth its intrinsic across many vols), and a premium equal to the leg\'s own price is its own vol with no gap. '
        + 'Past a point the answer warns: the base P&L then carries a gap that is the premium disagreeing with the vol (a broker\'s IV snapshot can lag its quote), not a move. '
        + 'Greeks are in the commercial API\'s convention (`greekConvention: "dapi"`), summed as signed quantity times 100 per option leg; a stock leg adds its shares to delta. '
        + 'The five time Greeks are what one day of time passing does to the position (`greekTimeConvention: "time-passing"`). '
        + 'Units: theta, charm and color per day; vega, rho, epsilon and phi per percentage point; veta per point per day; dcharmDvol per day per unit of volatility, not per point (divide by 100 for one point); vanna, vomma, zomma and ultima per unit of volatility, not per point (per point: vanna and zomma divided by 100, vomma by 10,000, ultima by 1,000,000); delta, gamma and speed unscaled. '
        + '`lambda` is the position\'s own elasticity, delta times spot over the position\'s value, for a net-debit position, and null for a credit or flat one. '
        + 'European legs are Black-Scholes and American legs the Leisen-Reimer binomial tree. '
        + 'An American leg\'s Greeks are finite differences of its own tree (its bumps shrink near expiry and at very low vol, so such a leg is measured at its own scale; the `legs` parameter gives them), so they are the American contract\'s and not the European twin\'s: near the money, where the twin\'s vanna and vomma are close to zero, the early-exercise premium\'s own sensitivities dominate them. '
        + 'On an at-the-money SPY put a month out the default 100 `steps` put vomma, speed, zomma and color within about a tenth of a converged tree and ultima within about a third (200 steps: a tenth); third-order Greeks of a leg near its exercise boundary are indicative. '
        + 'For the other pricing models, calibration and multi-model runs use the REST API or Python SDK.',
      inputSchema: {
        symbol: z.string().optional().describe('The underlying. Needed to resolve any input not supplied, and for portfolioFit.'),
        legs: z.array(legSchema).min(1).max(10).optional().describe('The strategy\'s legs. Supply these or strategyKey, not both. '
          + 'An American leg\'s Greeks are finite differences of its own tree: vol bumped one point, or a quarter of the vol when that is less; time a day, or a twentieth of the time left; '
          + 'spot a tenth of a percent, or a quarter of a one-sigma move to expiry when that is less, which is within hours of expiry at ordinary vols (about six hours at 15% vol, a day at 7%) and months out at very low vol, and then not under one node interval within the 0.1% cap, so such a leg is measured at its own scale; '
          + 'the third-order spot stencil one node interval wide, at least the spot bump and at most a tenth of spot. '
          + 'A call three hours out at 7% vol kept the European twin\'s delta, gamma, charm and vanna within 3% and its color, speed and zomma within 5%, where the fixed 0.1% spot bump had read charm a fifth low.'),
        strategyKey: z.string().regex(/^[0-9a-f]{64}$/).optional().describe('A strategy the user sent from the Strategy page, from get_snapshot type "strategy". Supply this or legs, not both.'),
        spot: z.number().positive().optional().describe('Spot price. Omit it to resolve the stored end-of-day spot for symbol.'),
        r: z.number().optional().describe('Continuously compounded risk-free rate as a decimal. Supplied, it prices every leg. Omitted (with symbol), each option leg prices at its own rate, as the Strategy page prices each leg: a strategy sent from the Strategy page gives each leg the rate the page priced it with (source "record"), and otherwise the leg reads the Treasury series matched to its own tenor, named in its source (the 3-month series, with a warning, when the matched series cannot be read). A leg keeps its rate across the whole grid: days elapsed age its life, never its rate.'),
        q: z.number().optional().describe('Continuous dividend yield as a decimal. Omitted (with symbol), it comes from the symbol\'s stored dividend data (its trailing yield, else its stored dividend over spot), also for a recorded strategy.'),
        dayCount: z.enum(['calendar', 'trading']).optional().describe('365 calendar or 252 trading days a year, for daysToExpiry, daysElapsed and the per-day Greeks. Default calendar.'),
        shocks: z.object({
          spotMoves: z.array(z.number()).min(1).max(15).optional().describe('Percent of spot, up to 15 points.'),
          ivShocks: z.array(z.number()).min(1).max(7).optional().describe('Vol points added to each leg\'s own IV, up to 7 points.'),
          daysElapsed: z.array(z.number().nonnegative()).min(1).max(6).optional().describe('Days elapsed, up to 6 points.'),
        }).optional().describe('The grid axes. Defaults: spot -10, -5, -2, 0, 2, 5 and 10 percent; vol -5, 0 and 5 points; days 0, 7, 14 and the shortest option leg\'s expiry, sorted and deduplicated; stock-only strategies use 0.'),
        portfolioFit: z.object({
          positions: z.array(positionSchema).min(1).max(25).describe('The positions you hold: each its own symbol, legs and optional spot, r and q.'),
        }).optional().describe('How the strategy fits beside the positions you hold (up to 25 underlyings, 40 legs), resolved by the same rules: headline Greeks for held, candidate and combined by underlying, expiration and sector; the candidate\'s Pearson correlation with each held underlying over the last 60 common daily log returns (null with a reason when history is absent or unreadable; matching underlyings return 1 when returns are available; different underlyings return null below 40 observations or with zero variance); and held and combined P&L with every underlying moved by the same percent at once, labelled as that model - no beta scaling is applied.'),
        full: z.boolean().default(false).describe('Return the route\'s exact answer: unrounded values, each leg\'s base price and the position-value grid beside the P&L grid.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async (args) => {
      // Only what was given, so the route's exactly-one rules see what the
      // caller sent; `full` shapes the answer here and never reaches the route.
      const { full, ...rest } = args as { full?: boolean } & Record<string, unknown>;
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (value !== undefined) body[key] = value;
      }
      const res = await client.post('/compute/scenario', body);
      return summarizeScenario(res, { full: full === true }) as Record<string, unknown>;
    }),
  );
}
