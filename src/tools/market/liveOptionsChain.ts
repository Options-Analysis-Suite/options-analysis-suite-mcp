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
      title: 'Live Options Chain (Pro)',
      description:
        'Get a LIVE options chain for one expiration, fetched in real time from the broker credential stored on your Options Analysis Suite account. '
        + 'This is the only tool that returns intraday option-chain prices; every other option-chain tool returns end-of-day prices from the most recent session on file. '
        + 'get_regime with scope="intraday" provides intraday exposure, not chain prices. '
        + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'A chain whose every contract reads zero open interest is published with null open interest and `openInterestUnpublished: true`: a blanket zero is an unpublished figure (Schwab prints it on every index option), not an empty book, and the totals say unknown. '
        + 'An index date listed under several OCC roots (SPX and SPXW on a third Friday) comes back as one row per strike: open interest and volume summed across the roots, each root\'s own in `openInterestByRoot` and `volumeByRoot` (null where that root published none; a row the broker named no root for under "unnamed"), prices from the one root with the most open interest over the date (the symbol\'s own root on a tie, as when the broker publishes no open interest) at every strike it lists, even where the other root is busier at that strike, so a spread\'s legs share a series wherever that root lists both strikes, `root` and `roots` naming them, and a row naming its own `root` only where it had to come from another (null where the broker named none). A date under one root names it the same way where the broker names each contract\'s root, `roots` then holding one (an index weekly listed only as SPXW). The root is the series, and series differ in settlement (SPX\'s monthly contracts settle in the morning of expiration day and SPXW\'s at the close, while VIX weeklies settle in the morning and XSP monthlies at the close), so read the exchange\'s specification for the root rather than a pattern. Public lists SPX\'s options under SPXW only, even on a third Friday, so an SPX monthly there is the PM-settled series. Only roots of the same deliverable merge, the symbol and the symbol plus one letter (SPXW, NDXP, RUTW, VIXW); an adjusted series, a digit root such as AAPL1 after a special dividend or a spin-off, is a different deliverable at the same strikes, so its contracts are left out of the rows and the totals and named in `excludedRoots` with their count; a date listed only under such roots answers an empty book naming them. Tradier\'s expirations list asks for every root, so an index\'s weekly dates are listed beside the monthly ones. A merged row\'s summed figure with an unknown term is null. '
        + '`spotTime` is when the spot printed, where the broker gives it (Tradier, Public and Schwab; tastytrade publishes no trade time, so null there), and `spotStale` is true when that predates the last session\'s open, by get_live_quote\'s `stale` rule (Public has answered a 04:00 pre-market print), null when unknown; the at-the-money pair and the strike window are read against that spot. '
        + 'Returns near-the-money strikes, the ATM pair, 25-delta wings and whole-chain volume/open-interest totals, which add up what the broker reported, with `contractsMissingVolume` and `contractsMissingOpenInterest` beside them counting the contracts it left out (null only when it reported none); every contract row carries strike, bid, ask, mid, mark, last, iv, delta, gamma, theta, vega, volume and openInterest. A contract that has not traded has `last` null: nothing trades at zero, so a broker\'s 0 is no print. `mid` is (bid + ask) / 2 only where both sides are quoted above zero, as get_live_quote\'s is: a zero bid (nobody bidding) leaves it null beside the ask and the broker\'s mark. '
        + 'A null field means the broker published nothing for it, which is different from zero, except where this tool withholds a figure and says so: a `mid` beside a zero bid, and the Greeks beside an unusable IV (`greeksReason`). `mid` is null unless there is a two-sided market; `mark` is the broker\'s own valuation, not an executable quote. `last` is the broker\'s last traded price, which can be hours old, and never stands in for `mid`. '
        + '`iv` is the broker\'s published implied volatility where it is usable (finite, above 0 and at most 5, that is 500%); a published 0 or a value above that band is a solver sentinel, not a volatility (brokers emit them for deep in-the-money contracts near expiration and after the close), and is reported as null and counted in totals.<side>.contractsWithoutUsableIv. The quote beside it is the broker\'s and is kept; the contract\'s delta, gamma, theta and vega come from the same failed solve (delta 1 beside gamma and vega 0 is the zero-vol limit, not a measurement), so they are withheld as null with `greeksReason` "iv-unusable", as they are where the broker published Greeks with no IV. A 25-delta wing is chosen only among contracts whose IV is usable, so its delta is one this tool shows, and is null when none is. '
        + 'Where the IV is usable, the Greeks are the broker\'s as published and are not checked against the quote or the IV beside them. Delta, gamma, theta and vega are in the units the broker publishes; this tool does not rescale them or compare them across brokers. A delta of exactly 0 or 1 can be a genuine limit deep in or out of the money, and it can be the broker\'s solver (a 755 put quoted 0.63 with iv 0.164 carried delta 0); this tool applies no check that tells the two apart, so treat such a delta as suspect and read it with the quote and IV beside it. A broker\'s Greeks can be a snapshot it refreshes about hourly rather than a figure from the quote beside them, and such a snapshot can carry one theta for the call and the put at a strike. Tradier publishes no mark, so its `mark` is always null. '
        + '`asOf` is when the chain was FETCHED, not a quote time: outside regular trading hours the quotes are the last ones the broker holds, and this tool does not date the quotes individually. A bid can sit below intrinsic value against `spotPrice` during trading hours too (MU\'s same-day 1030 call bid 39.10 at 15:10 ET on 2026-09-23 with `spotPrice` 1070.45, intrinsic 40.45). '
        + '`spotPrice` is the broker\'s own price for the underlying (Tradier\'s and tastytrade\'s last trade, or their close when the quote has no last; Public\'s last trade; Schwab\'s underlying price, else its last or its mark), and outside regular hours a broker\'s last can include extended-hours trades, so brokers can report different spots for the same moment (SPY on 2026-09-30 after the close: 764.81 tastytrade, 764.79 Public, 762.63 Tradier and Schwab), and each broker\'s moneyness and Greeks follow its own; open interest can also differ by broker. Some ETF options, SPY\'s included, quote until 4:15 PM New York time, so between 4:00 and 4:15, and on the quotes held after, put-call parity can imply an underlying away from `spotPrice`. '
        + 'Omit `expiration` for the nearest listed expiration that may still trade: from 4:15 PM New York time on an expiration day, when no expiring series trades any longer (some expiring ETF options, including SPY, trade until then; expiring stock options stop at 4:00 in regular hours, and at 4:15 for a class Cboe trades in its curb session; PM-settled index options stop at 4:00), that day\'s is passed over for the next one (early closes are not known here, so on those days it stays until 4:15, and it is kept if the broker lists nothing else); name it to see it. An unlisted expiration returns the available dates; one not written YYYY-MM-DD is refused by this tool\'s input check before any request, and a well-formed date that is not a calendar date (2026-02-30) by the proxy as INVALID_EXPIRATION, before it is charged. '
        + 'Rate limited per broker, shared with the other live tools, because each call spends your own broker quota: a chain is 2 requests on Tradier and Public, 1 on Schwab, and on tastytrade 2 plus one per 100 contracts it lists for the date under every root before they merge (a third Friday\'s SPX lists about twice the merged count), plus 1 for the expirations list when it is not cached (15 minutes); `strikeRange` trims the answer, not the fetch. A repeat for the same symbol and expiration on the same broker, by the same account, within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account\'s call never shares it. '
        + '`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker\'s own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; an error answered after the live-broker limiter ran carries it as `rateLimit` beside `code`, whether one it charged for (an unlisted expiration, a broker failure) or its own rate-limit refusal (RATE_LIMITED, which charges nothing), and one refused before it (the Pro tier gate, a malformed date, a missing credential) carries none. The budget is each broker\'s own documented quota, never less: 120 requests a minute on Tradier and Schwab, 600 on Public (10 a second), and 120 on tastytrade, which publishes no figure, so that one is a conservative stand-in. The broker\'s own rate limit is reported as BROKER_RATE_LIMITED, retryable, with `retryAfterSeconds` when the broker said how long (Tradier\'s window reset, Schwab\'s Retry-After) and null with a backoff note when it did not; wait before retrying. '
        + 'Every number goes out at 15 significant digits at most, which drops binary noise such as 11.190000000000001 in a computed mid or ratio, while a decimal the broker printed with 15 or fewer digits and a whole number such as an open-interest count pass unchanged. '
        + 'There is no end-of-day fallback: if the broker cannot answer, this reports the failure and whether retrying can help. A broker that does not answer is reported as BROKER_UNAVAILABLE, with `brokerFailure` saying what kind of failure it was ("http-status" with the broker\'s `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" when it answered with no price, strikes or spot to use, or "other"); no broker text is passed on. A broker that refuses the request itself (an HTTP 4xx other than 408, 409, 425 and 429, and neither a credential refusal nor a failed sign-in; Public answers a symbol it does not list with a 400) is reported as BROKER_REJECTED, not retryable, with `brokerFailure` "http-status" and its `brokerStatus`: retrying will not help, another broker may.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Expiration in YYYY-MM-DD. Defaults to the nearest listed expiration that may still trade (the next one from 4:15 PM New York time on an expiration day). An expiration the broker does not list returns the available ones.'),
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

      const budget: { rateLimit: LiveRateLimit | null } = { rateLimit: null };
      const res = await client.get(
        `/live/options-chain/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
        (rateLimit) => { budget.rateLimit = rateLimit; },
      ) as any;

      return significantDeep({ ...summarizeLiveChain(res, { strikeRange }), rateLimit: budget.rateLimit });
    }),
  );
}
