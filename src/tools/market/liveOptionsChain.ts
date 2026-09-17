import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeLiveChain } from './liveChainShaping.js';

/**
 * The only tool that returns option-chain prices newer than the last completed
 * session. It reaches the proxy's /live route, which reads the broker
 * credential stored on the account and gates the call to Pro and above.
 *
 * NO `full` OPTION, deliberately, and unlike get_options_chain. There, `full`
 * reads a bounded row set we already hold. Here it would be an unbounded live
 * broker call whose result cannot fit the response ceiling anyway - so the only
 * thing it could do is spend the user's broker quota to produce a truncated
 * answer. `strikeRange` widens the window instead, which is the request people
 * actually mean.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_options_chain',
    {
      title: 'Live Options Chain (Pro)',
      description:
        'Get a LIVE options chain for one expiration, fetched in real time from the broker credential stored on your Options Analysis Suite account. '
        + 'This is the only tool that returns intraday option-chain prices; every other option-chain tool returns end-of-day prices from the last completed session. '
        + 'get_regime with scope="intraday" provides intraday exposure, not chain prices. '
        + 'Requires a Pro subscription or above and a broker connected under Account -> Broker. '
        + 'Returns near-the-money strikes, the ATM pair, 25-delta wings and whole-chain volume/open-interest totals. '
        + 'A null field means the broker published nothing for it, which is different from zero. `mid` is null unless there is a two-sided market; `mark` is the broker\'s own valuation, not an executable quote. '
        + 'Omit `expiration` for the front month; an unlisted expiration returns the available dates. '
        + 'Rate limited to 10 requests per minute because each call spends your own broker quota. '
        + 'There is no end-of-day fallback: if the broker cannot answer, this reports the failure and whether retrying can help.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Expiration in YYYY-MM-DD. Defaults to the front month. An expiration the broker does not list returns the available ones.'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
        strikeRange: z.number().int().min(1).max(40).optional()
          .describe('Strikes to return either side of spot. Default 8. Raise it for a wider view; the whole-chain totals are unaffected by this.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, expiration, provider, strikeRange }) => {
      const params: Record<string, string> = {};
      if (expiration) params.expiration = expiration;
      if (provider) params.provider = provider;

      const res = await client.get(
        `/live/options-chain/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
      ) as any;

      return summarizeLiveChain(res, { strikeRange });
    }),
  );
}
