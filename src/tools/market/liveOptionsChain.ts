import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeLiveChain } from './liveChainShaping.js';

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
      title: 'Live Options Chain (Pro)',
      description:
        'Get a LIVE options chain for one expiration, fetched in real time from the broker credential stored on your Options Analysis Suite account. '
        + 'This is the only tool that returns intraday option-chain prices; every other option-chain tool returns end-of-day prices from the most recent session on file. '
        + 'get_regime with scope="intraday" provides intraday exposure, not chain prices. '
        + 'Requires a Pro subscription or above and a broker connected under Account -> Broker. '
        + 'Returns near-the-money strikes, the ATM pair, 25-delta wings and whole-chain volume/open-interest totals; every contract row carries strike, bid, ask, mid, mark, last, iv, delta, gamma, theta, vega, volume and openInterest. '
        + 'A null field means the broker published nothing for it, which is different from zero. `mid` is null unless there is a two-sided market; `mark` is the broker\'s own valuation, not an executable quote. `last` is the broker\'s last traded price, which can be hours old, and never stands in for `mid`. '
        + '`iv` is the broker\'s published implied volatility where it is usable (finite, above 0 and at most 5, that is 500%); a published 0 or a value above that band is a solver sentinel, not a volatility (brokers emit them for deep in-the-money contracts near expiration and after the close), and is reported as null and counted in totals.<side>.contractsWithoutUsableIv. The delta and the quote beside it are still the broker\'s and are kept. '
        + 'The Greeks are the broker\'s as published and are not checked against the quote or the IV beside them. Delta, gamma, theta and vega are in the units the broker publishes; this tool does not rescale them or compare them across brokers. A delta of exactly 0 or 1 can be a genuine limit deep in or out of the money, and it can be the broker\'s solver (a 755 put quoted 0.63 with iv 0.164 carried delta 0); this tool applies no check that tells the two apart, so treat such a delta as suspect and read it with the quote and IV beside it. '
        + '`asOf` is when the chain was FETCHED, not a quote time: outside regular trading hours the quotes are the last ones the broker holds, and this tool does not date the quotes individually. A bid can sit below intrinsic value against `spotPrice` during trading hours too (MU\'s same-day 1030 call bid 39.10 at 15:10 ET on 2026-09-23 with `spotPrice` 1070.45, intrinsic 40.45). '
        + 'Omit `expiration` for the front month; an unlisted expiration returns the available dates. '
        + 'Rate limited to 10 requests per minute because each call spends your own broker quota. A repeat for the same symbol and expiration within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and still counts as a request; the cache is per proxy instance, so a repeat can also be fetched afresh. '
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
          .describe('Strikes to return either side of spot. Default 8, max 40. Raise it for a wider view; the whole-chain totals are unaffected by this. If the rows at that range would exceed the 50KB response budget (a dense strike grid with long published decimals), the window is narrowed evenly on both sides until it fits: `view.strikeRange` is the range returned, `view.requestedStrikeRange` the one asked for, and `view.narrowedForSize` is true.'),
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
