import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';

/**
 * Black-Scholes from explicit inputs, through the proxy's compute route.
 *
 * The maths is packages/shared's and the Greek scaling is the SAME
 * applyGreekConventions /v1/compute/greeks uses, so this publishes the numbers
 * the commercial API would for the same inputs - not a third answer under one
 * brand. The response is small (a price, seventeen Greeks, an expected move
 * and a probability, each labelled) and is passed through whole: every field
 * carries its own convention or note, and reshaping would only strip those.
 *
 * THE ROUTE IS THE VALIDATOR. Exactly one of `t` or `daysToExpiry`; `r` and
 * `q` supplied or resolved from a `symbol`, never defaulted; a tenor under one
 * minute refused. Those rules live on the proxy and its refusal envelope
 * (code INVALID_REQUEST, the offending field in `issues`) reaches the model
 * through helpers.ts, so the schema here describes them rather than enforcing
 * a second copy that could drift.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'compute_black_scholes',
    {
      title: 'Black-Scholes Pricing (Pro)',
      description:
        'Price a European option with Black-Scholes from explicit inputs and return the price, all seventeen Greeks, the expected move and the risk-neutral probability of finishing in the money. '
        + 'Greeks are published in the same convention as the commercial API (`greekConvention: "dapi"`): vega, rho, epsilon and phi per 1 percentage point; theta, charm, color and dcharmDvol per day; veta per percentage point per day; vanna, vomma, zomma and ultima per unit of volatility; delta, gamma, speed and lambda unscaled. '
        + 'The expected move is an at-the-money straddle scaled by 0.85, independent of the strike priced. The probability is N(d2) under the pricing measure, not a real-world probability. '
        + 'Supply exactly one of `t` (years) or `daysToExpiry`. Supply `r` and `q`, or a `symbol` so they are read from stored market data for the option\'s own tenor; they are never defaulted, and a symbol whose rate or yield cannot be resolved is refused with the reason. '
        + 'Volatility is a decimal (0.25 for 25%). Requires a Pro subscription or above. '
        + 'For the other pricing models, calibration and multi-model runs use the REST API or Python SDK; this tool is Black-Scholes only.',
      inputSchema: {
        optionType: z.enum(['call', 'put']).describe('Which option to price.'),
        S: z.number().positive().describe('Spot price of the underlying.'),
        K: z.number().positive().describe('Strike price.'),
        sigma: z.number().nonnegative().describe('Implied volatility as a decimal, e.g. 0.25 for 25%.'),
        t: z.number().positive().optional()
          .describe('Time to expiry in years. Supply this OR daysToExpiry, not both.'),
        daysToExpiry: z.number().positive().optional()
          .describe('Time to expiry in days, converted with `dayCount`. Supply this OR t, not both.'),
        r: z.number().optional()
          .describe('Continuously compounded risk-free rate as a decimal. Omit it and supply `symbol` to resolve it from stored market data.'),
        q: z.number().optional()
          .describe('Continuous dividend yield as a decimal. Omit it and supply `symbol` to resolve it from stored market data.'),
        symbol: z.string().optional()
          .describe('Ticker used to resolve whichever of r and q was not supplied. Not needed when both are given.'),
        dayCount: z.enum(['calendar', 'trading']).optional()
          .describe('Day count for daysToExpiry and for the per-day Greeks: 365 calendar days or 252 trading days a year. Default calendar.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async (args) => {
      // Only what was given: an `undefined` field serialised as absent, so the
      // route's "exactly one of t / daysToExpiry" rule sees what the caller sent.
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(args)) {
        if (value !== undefined) body[key] = value;
      }
      return await client.post('/compute/black-scholes', body) as Record<string, unknown>;
    }),
  );
}
