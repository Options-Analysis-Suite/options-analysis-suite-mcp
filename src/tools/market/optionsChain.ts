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
 * last completed session and never mentions that live prices are available, so
 * a Pro user is quietly served stale data for the capability they pay for.
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
      description: 'Get the end-of-day options chain snapshot from the latest available completed trading session by default. Default view summarizes expirations, ATM term structure, skew, and representative near-money contracts across the curve while avoiding same-day expiry noise when later expirations exist; set date to query a specific session.'
        + ' This data is from the last COMPLETED session, not live. Use get_live_options_chain instead whenever the answer needs to be current: an explicit ask for live, current or intraday prices, and equally any request for the quote, bid, ask or mark on a specific contract, which is a question about now even without those words. It fetches from the user\'s own connected broker, needs a Pro subscription or above, and says so plainly if they do not have one. Stay here for what the chain looked like at a past session, or to compare expirations.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Optional market date in YYYY-MM-DD format. Defaults to the latest available options-chain session for this symbol.'),
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
