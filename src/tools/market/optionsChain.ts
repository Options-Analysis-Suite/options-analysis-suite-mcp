import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeOptionsChain } from './optionsChainShaping.js';

/**
 * The description points at get_live_options_chain, which is always
 * registered beside this tool.
 *
 * Without the pointer, a model asked for a chain "right now" answers from the
 * most recent session on file and never mentions that live prices are
 * available, so a Pro user is quietly served stale data for the capability
 * they pay for.
 *
 * The pointer is conditioned on the QUESTION, not on the tier. Order of
 * precedence, in the order these actually decide the answer:
 *
 *   1. DATASET. A question about the user's own portfolio is never answered
 *      from platform data because they pay for a higher tier.
 *   2. FRESHNESS. If the answer has to be current, live is the only tool that
 *      can give it, and quota is not a reason to hand back stale prices.
 *   3. COST. Only where the first two do not decide does it matter that the
 *      live call spends the user's own broker quota at 10/min.
 *
 * "Asked for a quote" implies freshness on its own - a specific contract's bid
 * or mark is a request about now, whether or not the words "right now" appear.
 * A request to see the chain, or to compare expirations, does not.
 */
export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_options_chain',
    {
      title: 'Options Chain',
      description: 'Get the end-of-day options chain snapshot from the most recent session on file by default. Default view summarizes expirations, ATM term structure, skew, and representative near-money contracts across the curve while avoiding same-day expiry noise when later expirations exist; set date to query a specific session.'
        + ' This data is end-of-day from the most recent session on file, NOT live; `date` in the result is the session it describes and is authoritative (the equity import usually lands in the early hours US Eastern, so in the evening this is usually the previous session, and it can be older when an import is late). Use get_live_options_chain instead whenever the answer needs to be current: an explicit ask for live, current or intraday prices, and equally any request for the quote, bid, ask or mark on a specific contract, which is a question about now even without those words. It fetches from the user\'s own connected broker, needs a Pro subscription or above, and says so plainly if they do not have one. Stay here for what the chain looked like at a past session, or to compare expirations.'
        + ' `expirations` and `nearAtmPairs` are a sample of up to six expirations across the curve, one per tenor bucket first and then the earliest remaining, skipping the expiry that ended that session whenever a later one exists; `expirationCount` counts every expiration in the file, that one included, and the near-money contract lists can draw on expirations outside the sample.'
        + ' `impliedVolatility` on a contract is the side\'s own mid IV where usable (finite, above 0, at most 5) and otherwise the smoothed surface value standing in, as the platform fills it; every IV here carries its source beside it (`ivSource` on a contract, `atmCallIvSource`, `atmPutIvSource`, `put25DeltaIvSource`, `call25DeltaIvSource` on an expiration: "mid", "smoothed", or null for no usable IV). "mid" names the side\'s stored mid IV column (the vendor\'s c_mid_iv or p_mid_iv), not the contract\'s `mid` price beside it, which is (bid + ask) / 2 of the stored quote and null when a side is unquoted, so a "mid" IV can sit beside a null `mid`. The band rejects stored sentinels, not noise: on a thin name a side mid IV can be in band beside a quote with no bid and disagree severalfold with the next strike. `putCallSkew` is the 25-delta put IV minus the 25-delta call IV only when both are side mids, otherwise null; `putCallSkewBasis` says so beside it, because get_iv_surface\'s `putCallSkew` is a different measure (the strikes nearest 95% and 105% of spot on either side of the ATM strike) and the two can differ severalfold on one expiration. `put25DeltaStrike`, `put25DeltaDelta`, `call25DeltaStrike` and `call25DeltaDelta` are the strike and delta of the contract each wing actually is: the out-of-the-money contract whose delta is nearest 0.25 in magnitude, however far from it that is, which on a coarse strike grid can be the ATM strike itself (a $5 stock with 50-cent strikes), and an in-the-money one when no out-of-the-money contract exists on that side. `atmAverageIv` is the mean of the ATM call and put IVs, or the one that is usable when the other is not, whatever their sources.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional market date in YYYY-MM-DD format. Defaults to the most recent session on file for this symbol, whatever its date; read `date` in the result.'),
        full: z.boolean().optional().describe('Return all contracts (can be 2000+ for broad ETFs). Default false — returns a compact summarized chain view.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, date, full }) => {
      const params: Record<string, string> = {
        ticker: symbol.toUpperCase(),
      };
      if (date) params.date = date;

      const res = await client.get('/scanner/options-chain', params) as any;

      if (full) return { _skipSizeGuard: true, data: res };
      return summarizeOptionsChain(res);
    }),
  );
}
