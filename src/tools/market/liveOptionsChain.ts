import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient, LiveRateLimit } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeLiveChain } from './liveChainShaping.js';
import { significantDeep } from './dealerPositioningShaping.js';

/**
 * The only tool that returns option-chain prices newer than the most recent
 * session on file. It reaches the proxy's /live route, which reads the broker
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
      title: 'Live Options Chain',
      description:
        'Get a LIVE options chain for one expiration, fetched in real time from the broker credential stored on your Options Analysis Suite account; on moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed with nothing in the data saying so. '
        + 'This is the only tool with intraday option-chain prices; for end-of-day prices from the most recent session on file use get_options_chain. '
        + 'No end-of-day fallback is made here: a broker that cannot answer is reported as a failure, with whether retrying can help. '
        + 'get_regime with scope="intraday" gives intraday exposure, not chain prices. '
        + 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'Returns near-the-money strikes, the at-the-money pair, the 25-delta wings and whole-chain volume and open-interest totals; each contract row carries its quote, implied volatility and Greeks. '
        + 'A zero bid leaves a contract\'s `mid` null (averaging it with the ask makes no mid), and a chain of at least 20 contracts whose every contract reads zero open interest goes out with null open interest and `openInterestUnpublished`: an unpublished figure, not an empty book, so its nonempty sides\' open-interest totals are unknown. '
        + 'A bid can sit below intrinsic value against `spotPrice` during trading hours too; this is not necessarily a data error. '
        + 'Broker requests spend your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools. Cold-call estimates, not actual spend or upper bounds: a cold call reads the expirations list and the chain, 3 requests on Tradier and Public and 2 on Schwab, and the list is then cached 15 minutes, so another date costs 2 and 1; on tastytrade a chain is 2 plus one per 100 contracts listed for the date across every root, and on moomoo 2 reserved and settled to what it spent (its contract list, cached for the day and shared across accounts, costs nothing once cached, then one snapshot per 400 codes, the underlying\'s among them), each plus 1 for an uncached expirations list.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Expiration in YYYY-MM-DD. '
          + 'Defaults to the nearest listed expiration that may still trade: from 4:15 PM New York time on an expiration day that day\'s is passed over for the next one, and kept when the broker lists nothing else (early closes are not known here, so on those days it stays until 4:15). '
          + 'A named date is never filtered, so name the expiring day to see it while the broker lists it. '
          + 'An expiration the broker does not list returns the available ones; a well-formed date that is not a calendar date (2026-02-30) is refused as INVALID_EXPIRATION before anything is charged.'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab', 'moomoo']).optional()
          .describe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.'),
        strikeRange: z.number().int().min(1).max(40).optional()
          .describe('Strikes to return either side of spot. '
          + 'Default 8, min 1, max 40. '
          + 'It trims the answer, not the fetch: any range costs the same, and the whole-chain totals are unaffected. '
          + 'When the rows at that range would not fit the response, the window is narrowed evenly on both sides and `view.narrowedForSize` is true.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, expiration, provider, strikeRange }) => {
      const params: Record<string, string> = {};
      if (expiration) params.expiration = expiration;
      if (provider) params.provider = provider;

      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/options-chain/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as any;

      // The budget rides inside the fit with the rows and the guide, no longer added after it.
      return significantDeep(summarizeLiveChain(res, { strikeRange, rateLimit: budget.rateLimit, expirationOmitted: !expiration }));
    }, { liveTool: 'chain' }),
  );
}
