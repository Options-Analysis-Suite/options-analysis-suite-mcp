import { beforeAll, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from './registry.js';
import { getMcpServerInfo } from '../server.js';

/**
 * Tool descriptions provide the information needed to choose and call a tool.
 * Reading rules also travel with the answers and parameter schemas.
 * These tests read tools/list as a client receives it.
 */
type Listed = { name: string; description?: string; inputSchema: { properties?: Record<string, { description?: string }> } };
let tools: Listed[] = [];

beforeAll(async () => {
  const server = new McpServer(getMcpServerInfo());
  const stub = { get: async () => ({}), post: async () => ({}) } as any;
  registerAllTools(server, stub, { getAccessToken: async () => 'token' } as any, stub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'tool-descriptions', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  tools = (await client.listTools()).tools as Listed[];
});

const desc = (name: string) => String(tools.find((t) => t.name === name)!.description);
const param = (name: string, p: string) => String(tools.find((t) => t.name === name)!.inputSchema.properties![p].description);
const firstSentence = (text: string) => text.slice(0, text.indexOf('. ') + 1);
/** Claude Code cuts a description loaded upfront at this many characters. */
const CLIENT_CUT = 4096;
/** The first part of a description: what a model reads to choose between tools. */
const FIRST_PART = 1024;
/** The no-tier rule: the MCP connection already requires Pro or above, so the prerequisite is the credential alone. */
const BROKER_PREREQUISITE = 'Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool.';

describe('The no-tier rule: no tool definition states a Pro requirement', () => {
  test('no title, description or parameter text names Pro', () => {
    expect(tools.length).toBeGreaterThan(40);
    for (const t of tools as (Listed & { title?: string })[]) {
      for (const [where, text] of [['title', t.title], ['description', t.description], ...Object.entries(t.inputSchema.properties ?? {}).map(([p, v]) => [`param ${p}`, v.description])] as [string, string | undefined][]) {
        expect(String(text ?? ''), `${t.name} ${where}`).not.toMatch(/\bPro\b/);
      }
    }
  });
});

describe('get_live_quote description', () => {
  test('fits the client cut and opens with the words a search uses', () => {
    const d = desc('get_live_quote');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(firstSentence(d)).toMatch(/\bLIVE quote\b/);
    expect(firstSentence(d)).toContain('fetched in real time from the broker credential stored on your Options Analysis Suite account (`provider` names the broker)');
  });

  test('the fetch time and the broker clocks, tastytrade\'s among them', () => {
    expect(desc('get_live_quote')).toContain('`asOf` is when the quote was FETCHED, not a quote time; the broker\'s own clocks are `quoteTime` and `tradeTime`, and on tastytrade `quoteTime` is a market-data clock that moves without new prices, so it does not date the bid, ask or last; on moomoo `quoteTime` is its snapshot\'s update time and it gives no `tradeTime`.');
  });

  test('a RATE_LIMITED refusal names the broker request, including a capacity refusal: no UPSTREAM_UNAVAILABLE sentence', () => {
    const d = desc('get_live_quote');
    expect(d).not.toContain('UPSTREAM_UNAVAILABLE');
    expect(d).toContain('A RATE_LIMITED refusal comes from the platform\'s limiter before any broker request is sent: with `rateLimit`, `rateLimit.provider` names the broker whose request was refused; another stored broker has its own budget, though shared limiter capacity can also cause refusal.');
    expect(d).not.toContain('budget of the broker `rateLimit.provider` names that is held');
  });

  test('what it answers, field by field, with the change basis', () => {
    expect(desc('get_live_quote')).toContain('last, bid, ask, bid and ask sizes, mid, the broker\'s mark, the session\'s open, high and low, the previous close, volume, the broker\'s quote and trade times, and the day change (`change` and `changePercent`: the broker\'s own, or computed against the previous close; `changeBasis` says which).');
  });

  test('the siblings and the missing fallback sit in the first part', () => {
    const d = desc('get_live_quote');
    const siblings = 'This is the only tool with the underlying\'s current quote and session range; get_live_options_chain reports a spot at fetch time with no range, and get_stock_prices is end-of-day bars with the prior close.';
    expect(d).toContain(siblings);
    expect(d.indexOf(siblings) + siblings.length).toBeLessThanOrEqual(FIRST_PART);
    expect(d).toContain('No end-of-day fallback: a failed fetch returns an error; read `code` and `retryable` when present. No broker error text is passed on.');
    // The fallback and the broker credential must both survive a 1,024-character client cut.
    expect(d.indexOf('No broker error text is passed on.') + 'No broker error text is passed on.'.length).toBeLessThanOrEqual(1024);
  });

  test('the prerequisite appears early and every broker cost includes the 5-second repeat rule', () => {
    const d = desc('get_live_quote');
    expect(d.indexOf(BROKER_PREREQUISITE)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(BROKER_PREREQUISITE) + BROKER_PREREQUISITE.length).toBeLessThanOrEqual(FIRST_PART);
    expect(d).toContain('Cold-call estimate, not actual spend or an upper bound: 1 request on every broker, against your broker\'s own quota, which the live tools share; a repeat for the same symbol and broker by the same account within 5 seconds can be answered from a short cache, uncharged, with the same `asOf`.');
    expect(d).not.toMatch(/weighted unit|10-unit|10 units/);
  });

  test('the parameter texts are unchanged', () => {
    expect(param('get_live_quote', 'symbol')).toBe('Ticker symbol (e.g., AAPL, SPY, SPX, VIX)');
    expect(param('get_live_quote', 'provider')).toBe('Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.');
  });
});

describe('get_live_options_chain description', () => {
  test('fits the client cut and opens with the words a search uses', () => {
    const d = desc('get_live_options_chain');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(firstSentence(d)).toMatch(/\bLIVE options chain\b/);
    expect(firstSentence(d)).toContain('fetched in real time from the broker credential stored on your Options Analysis Suite account');
  });

  test('the moomoo delay is stated with the first sentence', () => {
    expect(firstSentence(desc('get_live_options_chain'))).toContain('on moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed with nothing in the data saying so.');
  });

  test('the end-of-day sibling, the missing fallback and the intraday-exposure tool sit in the first part', () => {
    const d = desc('get_live_options_chain');
    for (const s of ['This is the only tool with intraday option-chain prices; for end-of-day prices from the most recent session on file use get_options_chain.', 'No end-of-day fallback is made here: a broker that cannot answer is reported as a failure, with whether retrying can help.', 'get_regime with scope="intraday" gives intraday exposure, not chain prices.']) {
      expect(d).toContain(s);
      expect(d.indexOf(s) + s.length).toBeLessThanOrEqual(FIRST_PART);
    }
  });

  test('what it returns', () => {
    expect(desc('get_live_options_chain')).toContain('Returns near-the-money strikes, the at-the-money pair, the 25-delta wings and whole-chain volume and open-interest totals; each contract row carries its quote, implied volatility and Greeks.');
  });

  test('the zero-bid mid and the unpublished open interest', () => {
    expect(desc('get_live_options_chain')).toContain('A zero bid leaves a contract\'s `mid` null (averaging it with the ask makes no mid), and a chain of at least 20 contracts whose every contract reads zero open interest goes out with null open interest and `openInterestUnpublished`: an unpublished figure, not an empty book, so its nonempty sides\' open-interest totals are unknown.');
  });

  test('in the first part: the quota and every broker\'s request count', () => {
    const d = desc('get_live_options_chain');
    expect(d.indexOf(BROKER_PREREQUISITE)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(BROKER_PREREQUISITE) + BROKER_PREREQUISITE.length).toBeLessThanOrEqual(FIRST_PART);
    expect(d).toContain('Broker requests spend your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools. Cold-call estimates, not actual spend or upper bounds: a cold call reads the expirations list and the chain, 3 requests on Tradier and Public and 2 on Schwab, and the list is then cached 15 minutes, so another date costs 2 and 1; on tastytrade a chain is 2 plus one per 100 contracts listed for the date across every root, and on moomoo 2 reserved and settled to what it spent (its contract list, cached for the day and shared across accounts, costs nothing once cached, then one snapshot per 400 codes, the underlying\'s among them), each plus 1 for an uncached expirations list.');
    expect(d).not.toMatch(/weighted unit|10-unit|10 units/);
  });

  test('no merged-row sentence (merging no longer exists)', () => {
    expect(desc('get_live_options_chain')).not.toMatch(/merged/i);
  });

  test('expiration and strikeRange retain their complete parameter text', () => {
    expect(param('get_live_options_chain', 'expiration')).toBe('Expiration in YYYY-MM-DD. Defaults to the nearest listed expiration that may still trade: from 4:15 PM New York time on an expiration day that day\'s is passed over for the next one, and kept when the broker lists nothing else (early closes are not known here, so on those days it stays until 4:15). A named date is never filtered, so name the expiring day to see it while the broker lists it. An expiration the broker does not list returns the available ones; a well-formed date that is not a calendar date (2026-02-30) is refused as INVALID_EXPIRATION before anything is charged.');
    expect(param('get_live_options_chain', 'strikeRange')).toBe('Strikes to return either side of spot. Default 8, min 1, max 40. It trims the answer, not the fetch: any range costs the same, and the whole-chain totals are unaffected. When the rows at that range would not fit the response, the window is narrowed evenly on both sides and `view.narrowedForSize` is true.');
    expect(param('get_live_options_chain', 'symbol')).toBe('Ticker symbol (e.g., AAPL, SPY)');
  });

  test('the intrinsic caveat remains available when a partial answer has wings without spot', () => {
    expect(desc('get_live_options_chain')).toContain('A bid can sit below intrinsic value against `spotPrice` during trading hours too; this is not necessarily a data error.');
  });
});

describe('get_live_dealer_positioning description', () => {
  test('fits the client cut and opens with the words a search uses', () => {
    const d = desc('get_live_dealer_positioning');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(firstSentence(d)).toMatch(/\bLIVE dealer positioning \(GEX, gamma exposure\)/);
    expect(firstSentence(d)).toContain('computed in real time from the broker credential stored on your Options Analysis Suite account');
    expect(firstSentence(d)).toContain('the repriced gamma flip, the call wall and put wall');
    expect(firstSentence(d)).toContain('a dealer regime (normally the sign of net gamma at spot; net GEX is the fallback with fewer than two gamma-bearing strikes or no recognized regime, and the flip side does not determine it) and per-strike rows near spot');
  });

  test('what each expiration adds: the current session, and the moomoo delay', () => {
    const d = desc('get_live_dealer_positioning');
    expect(d).toContain('Per expiration it adds its own GEX, DEX and gross-gamma share (0DTE concentration), its at-the-money straddle expected move and the earnings and ex-dividend dates on file, also in the top-level `events` (none on file, here or in a separate earnings or dividends lookup, is not none scheduled: a fund rarely has earnings on file, and its ex-dividend date often appears only on or after the day, so for a fund neither rules one out); `spotSides` splits open interest above and below spot (a squeeze argument\'s inputs).');
    expect(d).toContain('The gamma flip is the crossing nearest spot that a sampled search found (a fine step, 0.0005% of spot growing to at most 0.02% farther out), not necessarily the only one; a null flip beside a complete `levelStatus.gammaFlip` is the result of a search over every counted leg (read `coverage.gammaFlipSearchStatus` when reported), not withheld and not proof of no flip.');
    expect(d).toContain('It reflects the current session, not the most recent session on file; on moomoo, option quotes are real time only once the account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked.');
  });

  test('the end-of-day sibling and the prerequisite sit in the first part', () => {
    const d = desc('get_live_dealer_positioning');
    const sibling = 'For the most recent session on file (0-60 days), free and without a broker, use get_dealer_positioning; its coarse-grid gamma flip is a different claim from the repriced one here.';
    expect(d.indexOf(sibling)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(sibling) + sibling.length).toBeLessThanOrEqual(FIRST_PART);
    expect(d.indexOf(BROKER_PREREQUISITE)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(BROKER_PREREQUISITE) + BROKER_PREREQUISITE.length).toBeLessThanOrEqual(FIRST_PART);
  });

  test('the default window and the one-expiration book', () => {
    expect(desc('get_live_dealer_positioning')).toContain('Without `expiration` it covers the first four listed expirations that may still trade (on a monthly-listed name that can span months; get_dealer_positioning covers 0-60 days from the most recent session on file; its window and session can differ from this live answer, so comparing them does not isolate today\'s longer-dated book); with `expiration` every total (charm included), level and row is computed over that one listed date alone, the way to see a same-day (0DTE) or single-week book.');
  });

  test('the cost on every broker, the no-loop rule and the 15-second cache', () => {
    const d = desc('get_live_dealer_positioning');
    expect(d).toContain('EXPENSIVE: broker requests spend your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools. Cold-call estimates, not actual spend or upper bounds: a default call reads the expirations list and four chains: 9 requests on Tradier and Public, 5 on Schwab, 49 reserved on tastytrade and settled to the real count, and 9 reserved on moomoo and settled to what it spent (about three fully cold calls a minute on its 30, more once its contract lists are cached for the day); with `expiration` it reads the list and one chain: 3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade, and 3 reserved on moomoo and settled to what it spent. Counts vary with the broker\'s caches, and a long tastytrade or moomoo chain reserves more once its count is known and is refused RATE_LIMITED when the budget cannot hold it.');
    for (const broker of ['Tradier', 'Public', 'Schwab', 'tastytrade', 'moomoo']) expect(d.slice(d.indexOf('Cold-call estimates, not actual spend or upper bounds: a default call')), broker).toContain(broker);
    expect(d).toContain('Do not call it in a loop or for a list of symbols. A repeat within 15 seconds for the same symbol, broker, `expiration`, `r`, `q` and methodology can be answered from a short cache, uncharged, with the same `asOf`; `strikeRange`, `strikeWindowPct` and `strikeWindowDelta` only choose which computed rows are returned, so widening a cached window spends no broker requests.');
    expect(d).not.toMatch(/weighted unit|10-unit|10 units/);
  });

  test('the parameter texts, exactly', () => {
    expect(param('get_live_dealer_positioning', 'expiration')).toBe('One expiration in YYYY-MM-DD to compute over instead of the default window (the nearest four that may still trade), for example the same-day expiration, before or after its close; it can be named while the broker still lists it, and the list is cached 15 minutes, so for that long after the listing ends. It must be one the broker lists: otherwise the refusal names the listed ones and never substitutes the nearest. A value not written YYYY-MM-DD is refused by this tool\'s input check before any request, and a well-formed date that is not a calendar date (2026-02-30) by the proxy as INVALID_EXPIRATION, before anything is charged.');
    expect(param('get_live_dealer_positioning', 'r')).toBe('Risk-free rate to price with, as a decimal fraction (0.0425 is 4.25%), from -0.1 to 1, used as given instead of the resolved one and never checked against the market; `resolved.r.source` is then "supplied" with no date, and q is resolved as usual. A value outside that range is refused by this tool\'s input check before any request.');
    expect(param('get_live_dealer_positioning', 'q')).toBe('Dividend yield to price with, as a decimal fraction (0.012 is 1.2%), from 0 to 1, used as given instead of the resolved one and never checked against the market; `resolved.q.source` is then "supplied" with no date, and r is resolved as usual. An index\'s resolved yield is its basket-derived estimate (`resolved.q.source` "index_constituents"); a volatility index such as VIX has none, and an index whose estimate is unavailable has none either, so a call on one needs this: without it the call is refused (RESOLUTION_FAILED, naming what is missing) before the session opens and before anything is charged. A value outside that range is refused by this tool\'s input check before any request.');
    expect(param('get_live_dealer_positioning', 'strikeRange')).toBe('TOTAL per-strike rows nearest spot, the cap when `strikeWindowPct` or `strikeWindowDelta` is given. Default 10 (150 with either), max 150. Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage.');
    expect(param('get_live_dealer_positioning', 'strikeWindowPct')).toBe('Return every strike within this percent of spot instead of a fixed count, nearest first up to `strikeRange` (for example 10 for strikes within 10% of spot); above 0, at most 50. With no spot price from the broker no percent window is applied: the rows are then the first strikes in strike order up to the cap, and the answer says so.');
    expect(param('get_live_dealer_positioning', 'strikeWindowDelta')).toBe('Return every strike inside a delta band instead of a fixed count, nearest spot first up to `strikeRange`: 0.1 keeps the strikes from the 10-delta put to the 10-delta call, a call delta from 0.1 to 0.9 or a put delta from -0.9 to -0.1, ends included. The deltas are the broker\'s per-contract deltas; either leg qualifies a strike on its own, and a missing one is never derived from the other, so a strike with no usable delta on either leg is outside. Over several expirations a strike qualifies when at least one of them prices it inside the band, so the farthest expiration, whose deltas sit nearest 0.5, usually sets how far out the band reaches. Strictly between 0 and 0.5. It takes the place of `strikeWindowPct`, and passing both is refused before any request.');
    expect(param('get_live_dealer_positioning', 'symbol')).toBe('Ticker symbol (e.g., AAPL, SPY, MU)');
  });
});

describe('scan_option_strategies description', () => {
  test('fits the client cut and opens with the words a search uses', () => {
    const d = desc('scan_option_strategies');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(firstSentence(d)).toContain('Scan one expiration of the LIVE options chain, read with the broker credential stored on your Options Analysis Suite account, for candidate trades of one strategy');
  });

  test('the candidate vocabulary, the strategy families and what a covered call is here', () => {
    const d = desc('scan_option_strategies');
    expect(d).toContain('Each candidate carries its legs\' quotes (each leg\'s `spreadPct` is its bid-ask spread already in percent of the mid: 0.54 is 0.54%, not 54%) and Greeks, its net credit or debit at the mid and at the natural, max profit, max loss, breakevens, return on risk, a risk-neutral probability of profit, position Greeks and liquidity; the answer adds the expiration\'s expected move (its at-the-money straddle, call mid plus put mid, unscaled), its dealer levels (gamma flip, call wall, put wall, gamma magnet) and every strike\'s distance from spot.');
    expect(d).toContain('Strategies: single calls and puts, long and short; credit and debit vertical spreads; iron condors and iron butterflies; straddles and strangles.');
    expect(d).toContain('A covered call or cash-secured put is the short_call or short_put here, without the stock or cash leg, which is not modelled.');
    expect(d).toContain('a risk-neutral probability of profit');
  });

  test('the prerequisite in the first part, and the moomoo delay', () => {
    const d = desc('scan_option_strategies');
    expect(d.indexOf(BROKER_PREREQUISITE)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(BROKER_PREREQUISITE) + BROKER_PREREQUISITE.length).toBeLessThanOrEqual(FIRST_PART);
    expect(d).toContain('On moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked.');
  });

  test('the cost on every broker, the cached re-scan and the no-loop rule', () => {
    const d = desc('scan_option_strategies');
    expect(d).toContain('EXPENSIVE. Cold-call estimates, not actual spend or upper bounds: a scan reads the expirations list and the scanned chain in your broker\'s own requests (3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade and settled to the real count, and on moomoo 3 reserved and settled to what it spent), and up to four more chains with `levels: "window"`. The budget is your broker\'s own quota (120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo), shared with the other live tools.');
    expect(d).toContain('Another scan of the same expiration within 15 seconds (same account, broker, `levels` and supplied `r` and `q`), with any other strategy or filters, can be answered from the cached chain with the same `asOf`, quotes and expected move, uncharged and even on a spent budget (the cache is per proxy instance, so a repeat can also be read afresh). Do not call it in a loop or for a list of symbols.');
    expect(d).not.toMatch(/weighted unit|10-unit|10 units/);
  });

  test('the dealer-positioning tools for levels alone, live and end-of-day', () => {
    expect(desc('scan_option_strategies')).toContain('For dealer levels alone use get_live_dealer_positioning (live) or get_dealer_positioning (the most recent session on file, 0-60 days, free, no broker).');
  });

  test('the parameter texts, exactly', () => {
    expect(param('scan_option_strategies', 'strategy')).toBe('The strategy to build candidates for. Credit strategies: short_put, short_call, bull_put_spread, bear_call_spread, iron_condor, iron_butterfly, short_straddle and short_strangle; the rest are debit. iron_condor and iron_butterfly have both wings `width` away.');
    expect(param('scan_option_strategies', 'deltaMin')).toBe('Lowest absolute delta of the anchor leg, 0 to 1, read on the delta the broker publishes (a contract with no published delta is never an anchor). The anchor is the option sold for a short or credit strategy, the option bought for a long or debit one, both short strikes of an iron condor or short strangle, both strikes of a long strangle, and the body\'s call for a straddle or iron butterfly. Default bands by strategy: 0.15 to 0.35 for short options, credit spreads and long strangles; 0.3 to 0.6 for long options; 0.4 to 0.6 for debit spreads, straddles and iron butterflies; 0.1 to 0.25 for iron condors and short strangles. Supplying one end keeps the other at the strategy default, and a band whose low end is above its high end is refused (INVALID_REQUEST) before anything is charged. For iron_condor, short_strangle and long_strangle every put-call pair in the band is priced before sorting, so a band giving more than 10,000 pairs is refused (SCAN_TOO_LARGE) after the chain is obtained; a fresh fetch spends broker quota, but a cached chain is free.');
    expect(param('scan_option_strategies', 'deltaMax')).toBe('Highest absolute delta of the anchor leg, 0 to 1, read on the delta the broker publishes; the anchor, the default bands, the one-ended rule and the pair limit are stated under `deltaMin`. Defaults by strategy: 0.35 for short options, credit spreads and long strangles; 0.6 for long options, debit spreads, straddles and iron butterflies; 0.25 for iron condors and short strangles.');
    expect(param('scan_option_strategies', 'width')).toBe('Dollars from the anchor strike to its wing. Required for spreads, iron condors and iron butterflies; ignored otherwise. When that exact strike is not listed, the nearest listed strike within a quarter of the width is used; with none that close the candidate is skipped ("no-wing-strike").');
    expect(param('scan_option_strategies', 'minOpenInterest')).toBe('Every leg\'s open interest at least this many contracts; a leg whose open interest is unknown fails it.');
    expect(param('scan_option_strategies', 'sortBy')).toBe('Order of the candidates. Default "delta": lowest absolute anchor delta first (the mean of both anchors for an iron condor or strangle); an iron butterfly or straddle body instead sorts by its call delta\'s distance from 0.5, smallest first, in the broker\'s decimals (0.45 and 0.55 tie). "returnOnRisk" and "probabilityOfProfit" sort highest first; "netPremium" sorts the largest credit, or the smallest debit, first. Nulls sort last, and ties go to the lower first-leg strike. The order used is echoed in `request.sortBy`.');
    expect(param('scan_option_strategies', 'distinct')).toBe('Iron condors and strangles only: one candidate per anchor strike on each side (default true), built as a ladder: walking the sorted candidates best first, one is kept only while neither of its anchor strikes has been used, so each anchor strike appears once, though not always in its own best pair. false returns every pair.');
    expect(param('scan_option_strategies', 'r')).toBe('Risk-free rate to price with, as a decimal fraction (0.0425 is 4.25%), from -0.1 to 1, used as given instead of the resolved one and never checked against the market; `resolved.r.source` is then "supplied" with no date, and q is resolved as usual. A value outside that range is refused by this tool\'s input check before any request.');
    expect(param('scan_option_strategies', 'q')).toBe('Dividend yield to price with, as a decimal fraction (0.012 is 1.2%), from 0 to 1, used as given instead of the resolved one and never checked against the market; `resolved.q.source` is then "supplied" with no date, and r is resolved as usual. An index\'s resolved yield is its basket-derived estimate; a volatility index such as VIX has none, and an index whose estimate is unavailable needs this too: without it the call is refused before the session opens and before anything is charged (RESOLUTION_FAILED naming what is missing, or UPSTREAM_UNAVAILABLE, retryable, when the stored yield could not be read). A value outside that range is refused by this tool\'s input check before any request.');
  });
});

describe('rank_live_skew_gex description', () => {
  test('fits the client cut and opens with the words a search uses, run_screener named in the first part', () => {
    const d = desc('rank_live_skew_gex');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(firstSentence(d)).toContain('Rank a WATCHLIST of 1 to 50 symbols LIVE by their 25-delta skew and net GEX (gamma exposure)');
    expect(firstSentence(d)).toContain('computed in real time from the broker credential stored on your Options Analysis Suite account');
    expect(d.indexOf('run_screener')).toBeLessThan(FIRST_PART);
  });

  test('the model, skew and GEX definitions are retained, and the prerequisite appears early', () => {
    const d = desc('rank_live_skew_gex');
    expect(d).toContain('Both sides of every change use this platform\'s own model (implied volatility solved from bid/ask mids, then Black-Scholes delta and gamma), not the broker\'s Greeks, so the change is like for like; skew is the 25-delta put IV minus the 25-delta call IV at the listed expiration nearest 30 days out among those at least 7 days out (`skew10d` the same at 10-delta, same expiration), and net GEX is in dollars per 1% move over the nearest four expirations that may still trade.');
    expect(d.indexOf(BROKER_PREREQUISITE)).toBeGreaterThanOrEqual(0);
    expect(d.indexOf(BROKER_PREREQUISITE) + BROKER_PREREQUISITE.length).toBeLessThanOrEqual(FIRST_PART);
  });

  test('the closed-market valuation and the moomoo delay', () => {
    expect(desc('rank_live_skew_gex')).toContain('Outside regular hours the chain is valued at the session\'s 4:00 PM New York close on quotes that can be stale or one-sided; on moomoo, option quotes are real time only once the moomoo account holds assets or a US position, and until then may be about 15 minutes delayed, unmarked.');
  });

  test('the budget warning, the quota and the per-symbol cost on every broker', () => {
    const d = desc('rank_live_skew_gex');
    expect(d).toContain('BUDGET: fresh fetches spend your own broker quota and MAY SPEND ALL OF IT. Further requests to that broker can then be refused (RATE_LIMITED) until the window resets; cache-only answers can still be served. Per-broker quota: 120 requests a minute on Tradier and Schwab, 600 on Public, 120 on tastytrade, 30 on moomoo.');
    expect(d).toContain('Cold-call estimates per symbol, not actual spend or caps: both metrics need the expirations list (1, cached 15 minutes) and four GEX chains, 9 requests on Tradier, Public and moomoo (moomoo reserved and settled to what it spent), 5 on Schwab, 49 reserved on tastytrade and settled to the real count; one more chain when the skew expiration is outside those four, as it often is on a symbol with weekly or daily expirations (2 more on Tradier and Public, so 11 a symbol; 1 on Schwab; 12 reserved on tastytrade; 2 reserved on moomoo), and one more when the first skew candidate fails its checks; `metrics` "skew" alone is the list and one chain (3 on Tradier and Public, 2 on Schwab, 13 reserved on tastytrade, 3 reserved on moomoo).');
    expect(d).not.toMatch(/weighted unit|10-unit|10 units/);
  });

  test('a long list takes several calls with the same list; old rows on a long list', () => {
    const d = desc('rank_live_skew_gex');
    expect(d).toContain('A long list takes several calls: with both metrics Tradier\'s 120 a minute covers about ten symbols and Schwab\'s about twenty, Public paces to about one symbol a second, moomoo\'s 30 about three fully cold ones (more once its contract lists are cached for the day), and tastytrade\'s reservation of 49 or more a symbol leaves room for two at a time. Call again with the SAME list after `retryAfterSeconds`, not in a tight loop. A cached metric younger than `maxAgeSeconds` is reused at no cost; its `ageSeconds` is the rounded computation age at the response\'s `asOf`, not a quote age. Later calls refresh the oldest rows their budget covers, so on a long list a row can be older than `maxAgeSeconds` (fifty symbols on Tradier take about five minutes a round): ask for fewer symbols for fresher rows.');
  });

  test('the per-symbol yield refusal and the siblings', () => {
    const d = desc('rank_live_skew_gex');
    expect(d).toContain('A volatility index such as VIX, or an index whose stored dividend yield is unavailable, is refused per symbol in `errors` (RESOLUTION_FAILED) before anything is spent on it; get_live_dealer_positioning takes a supplied `q` for it.');
    expect(d).toContain('An `errors` entry\'s `status` is this tool\'s for that symbol, not an HTTP status from the broker: 404 NO_EXPIRATIONS means no usable expiration dates were obtained, not that the broker returned a 404 (`brokerStatus` carries the broker\'s).');
    expect(d).toContain('Use run_screener (put-skew, dod-change) for the market-wide end-of-day boards, get_options_snapshot for the end-of-day skew and GEX of up to 50 symbols at no broker cost, and get_live_dealer_positioning for one symbol\'s full live positioning (the broker\'s Greeks) with the gamma flip and walls.');
  });

  test('the parameter texts, exactly', () => {
    expect(param('rank_live_skew_gex', 'symbols')).toBe('A comma-separated list of 1 to 50 symbols (e.g., "SPY,QQQ,AAPL,NVDA,TSLA"); duplicates and letter case fold to one symbol, and an empty list or more than 50 distinct symbols is refused before any request. Call again with the SAME list to continue a list this call did not finish.');
    expect(param('rank_live_skew_gex', 'rankBy')).toBe('Sort the answered rows by: skew (25-delta put minus call IV), skewChange (since the prior close), gex (net GEX), gexChange, or gexChangePercent (the change as a percent of the prior\'s size). A change sorts by its size with the sign kept. The ranked metric must be in `metrics` (skew and skewChange need skew; gex, gexChange and gexChangePercent need gex), otherwise the call is refused before any request. Absent keeps the order asked for.');
    expect(param('rank_live_skew_gex', 'metrics')).toBe('Which metrics to compute: skew, gex, or both (default). Skew alone reads the expirations list and one chain per symbol (one more when its first candidate fails its checks); both read the list and four chains, plus one for a skew expiration outside them.');
    expect(param('rank_live_skew_gex', 'limit')).toBe('Keep only this many rows (1-50): the best-ranked with `rankBy`, otherwise the first in the order asked for. Default: every answered row. The rest are named in `omitted.byLimit`, not lost.');
  });
});

describe('get_regime description', () => {
  test('fits the client cut and names the six scopes first', () => {
    const d = desc('get_regime');
    expect(d.length).toBeLessThanOrEqual(CLIENT_CUT);
    expect(d.startsWith('Get regime data at one of six scopes. Pick the scope that fits the question: market, symbol, intraday, volatility, sectors or cot.')).toBe(true);
  });

  test('the market composite (with scanSource) and the symbol scope (days = stored sessions)', () => {
    const d = desc('get_regime');
    expect(d).toContain('scope="market": the MARKET COMPOSITE stress regime, an aggregate of SPY, QQQ, IWM and DIA (not per-symbol): stress score, a Calm-to-Crisis label, confidence, drivers and feature z-scores, the latest by default or one `date`; without `date`, the composite\'s own newest intraday scan is preferred when its market date is the same as or later than the daily row\'s (`scanSource` says which), and a symbol\'s scans of the current session are scope="intraday".');
    expect(d).not.toContain('`include_symbols`');
    expect(d).toContain('scope="symbol": one symbol\'s daily regime plus its Greek exposures (net gamma, delta, vega, vanna, charm and vomma; call wall, put wall, gamma flip, gamma magnet, top gamma strikes); requires `symbol`; `days` returns the newest stored sessions, 1 to 30, default 1 = the latest.');
  });

  test('freshness compares market dates, and interval filters across the requested window', () => {
    const d = desc('get_regime');
    expect(d).toContain("its market date is the same as or later than the daily row's");
    expect(d).not.toContain('when it is newer than the daily row');
    expect(d).toContain('`interval` filters by scan interval across the window');
    expect(d).not.toContain('`interval` keeps one scan');
  });

  test('the scope for current exposures, and the positioning tools named', () => {
    const d = desc('get_regime');
    expect(d).toContain('For a symbol\'s CURRENT exposures use this scope, not get_options_analytics_history (a daily history over all expirations). The dedicated positioning tools are get_dealer_positioning (end of day, 0-60 day window) and get_live_dealer_positioning (live); this scan\'s levels are its own computation and can differ from theirs.');
    // Keep the end-of-day alternatives early in the get_regime description.
    expect(d.indexOf('get_options_analytics_history')).toBeLessThan(FIRST_PART);
    expect(d.indexOf('get_dealer_positioning (end of day')).toBeLessThan(FIRST_PART);
  });

  test('the intraday scope; no tier gate stated (every MCP session is Pro or above)', () => {
    const d = desc('get_regime');
    expect(d).toContain('scope="intraday": a symbol\'s intraday regime scans, 5 a day (open, morning, midday, afternoon, pre-close), each with stress score, label and compact exposures; requires `symbol`; `days` is a calendar window back from the current UTC date (default 5, max 90) or `date` one session; `interval` filters by scan interval across the window; `migration` adds each level\'s move since the previous scan.');
    expect(d).not.toMatch(/subscription|below Pro/);
  });

  test('volatility, sectors and cot, which answer the newest data on file', () => {
    const d = desc('get_regime');
    for (const s of ['scope="volatility": the VIX term structure at the latest close (VIX1D, VIX9D, VIX, VIX3M, VIX6M and VVIX), its shape (contango, backwardation or mixed) and ratios.', 'scope="sectors": each sector\'s or industry\'s (`kind`) P/E and average daily price change on the NYSE, NASDAQ and AMEX for one day; `group` adds that group\'s daily history over `days`.', 'scope="cot": CFTC Commitments of Traders positioning (futures only, weekly): with `symbol` (a futures ticker or root) its family market\'s trader groups, speculative line, 3-year range and recent reports; without `symbol`, every market\'s speculative line, most extreme first, with optional `sector`.', 'volatility, sectors and cot answer the newest data on file; `date` is not supported there.']) expect(d).toContain(s);
  });

  test('`full` says what it does; the parameter texts, exactly', () => {
    expect(param('get_regime', 'scope')).toBe('Which regime view to fetch: market, symbol, intraday, volatility, sectors or cot. A parameter that belongs to another scope is ignored; each one names its scope.');
    expect(param('get_regime', 'date')).toBe('Specific date (YYYY-MM-DD). For scope=market: default is latest; with a date, that day\'s daily row only. For scope=intraday: overrides `days`. Not used by scope=symbol. Not supported on volatility, sectors and cot, which answer the newest data on file and say so in `dateNote`.');
    expect(param('get_regime', 'days')).toBe('For scope=sectors with `group`: calendar days of the group\'s daily history, back from the current UTC date (default 30, max 90). For scope=symbol: the newest N stored sessions, not calendar days (default 1 = the latest, max 30). For scope=intraday: calendar days back from the current UTC date, the cutoff day included, so 1 returns the previous UTC day and the current one; at midnight UTC (7 PM EST, 8 PM EDT) the cutoff advances one calendar date, and weekends and holidays are not skipped, so a window can cover days with no session and return no rows (default 5, max 90); use `date` for one session.');
    expect(param('get_regime', 'include_symbols')).toBe('For scope=market only: also return per-symbol daily rows, each tier sorted by absolute stress score and capped at the top 8, for a question needing individual symbols\' regimes; the composite\'s own label, score, confidence and drivers come without it. Default false.');
    expect(param('get_regime', 'full')).toBe('For scope=symbol only. Default false. With `days` 1, true keeps the `history` wrapper around the one entry instead of flattening it to the top level; with `days` above 1 it returns the same entries as the default (the same exposures, model coverage and top strikes), so it changes nothing there.');
    expect(param('get_regime', 'group')).toBe('For scope=sectors only: one sector or industry by name, any case (e.g. Technology, Semiconductors), returned with its daily history over `days` on each exchange the group is listed on.');
    expect(param('get_regime', 'migration')).toBe('For scope=intraday only: add each scan\'s `migration`, the change in its gamma flip, call wall, put wall, gamma magnet and net gamma since the previous scan with exposures (direction, change, percent of spot, per hour). Default false.');
    expect(param('get_regime', 'full')).toContain('with `days` above 1 it returns the same entries as the default');
  });
});

describe('budget rules have a per-tool home', () => {
  for (const name of ['get_live_quote', 'get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex', 'get_intraday_bars']) {
    test(`${name}: request counts are cold estimates, not actual spend or ceilings`, () => {
      const visible = desc(name).slice(0, CLIENT_CUT);
      expect(visible).toMatch(/cold-call estimates?/i);
      expect(visible).toMatch(/not actual spend or (?:an? )?(?:upper bounds?|caps?)/i);
    });
  }
  test('bars: the shared snapshot and no-subtraction rule survive the client cut', () => {
    const visible = desc('get_intraday_bars').slice(0, CLIENT_CUT);
    expect(visible).toContain('`rateLimit`: proxy snapshot per account and broker');
    expect(visible).toContain('shared by live tools');
    expect(visible).toContain('includes other calls and reservations');
    expect(visible).toContain('Null means unknown.');
    expect(visible).toContain('`limit` minus `remaining` is not this call\'s spend.');
    // Adding the rule must not displace the free-repeat exception beyond the cut.
    expect(visible).toContain('within 15 seconds can be answered from a short in-memory cache');
    expect(visible).toContain('another account\'s call never shares it.');
  });
});

describe('every description fits the client cut', () => {
  test('no tool description is longer than the cut', () => {
    expect(tools.length).toBe(46);
    expect(tools.filter((t) => String(t.description).length > CLIENT_CUT).map((t) => t.name)).toEqual([]);
  });
  const opening: Record<string, RegExp> = {
    get_intraday_bars: /^Get one session's LIVE intraday bars \(1, 5, 15 or 30 minutes\)/,
    get_dealer_positioning: /^Get END-OF-DAY dealer positioning for a symbol from the most recent session on file, over the 0-60 day expiration window/,
    compute_scenario: /^Reprice a multi-leg options strategy across spot moves, implied-volatility shocks and days elapsed/,
    get_snapshot: /^Get the user's synced snapshot history by type\./,
    get_insider_trading: /^Get insider trading activity for a company\./,
  };
  for (const [name, re] of Object.entries(opening)) {
    test(`${name} keeps the opening a search reads`, () => {
      expect(firstSentence(desc(name))).toMatch(re);
    });
  }
});

describe('decision and reading rules survive compression', () => {
  const choices: Record<string, string[]> = {
    get_intraday_bars: [BROKER_PREREQUISITE, 'Tradier and Schwab only', 'get_stock_prices', 'get_live_quote'],
    get_dealer_positioning: ['No broker credential is required.', 'get_live_dealer_positioning', 'get_options_snapshot'],
    compute_scenario: ['It makes no broker call.', 'compute_black_scholes', 'get_snapshot', 'strategyKey'],
    get_snapshot: ['No broker call.', 'compute_scenario', 'strategyKey'],
    get_insider_trading: ['scope="market"', 'get_sec_filings', 'no broker credential needed.'],
  };
  for (const [name, rules] of Object.entries(choices)) test(`${name} exposes prerequisites and choices early`, () => {
    for (const rule of rules) expect(desc(name).slice(0, FIRST_PART), `${name}: ${rule}`).toContain(rule);
  });
  test('bars distinguish regular-hour filtering and the untrimmed VWAP anchor', () => {
    expect(desc('get_intraday_bars')).toContain('16:00 is dropped from regular hours');
    expect(desc('get_intraday_bars')).toContain('cumulative from the first usable session bar');
    expect(desc('get_intraday_bars')).toContain('After this call, it gives');
    expect(param('get_intraday_bars', 'indicators')).toContain('newest finite value of every plot, null when a plot has none');
    expect(param('get_intraday_bars', 'indicators')).toContain('an unknown parameter is refused naming what would have worked');
    expect(param('get_intraday_bars', 'indicators')).toContain('has no value until 200 bars exist');
  });
  test('insider values distinguish no events from unvalued events', () => {
    expect(desc('get_insider_trading')).toContain('0 with no events; null, and `netValue` null, when events exist but none has a value');
    expect(param('get_insider_trading', 'kind')).toContain('The totals and top lists cover purchases and sales');
    expect(param('get_insider_trading', 'kind')).toContain('whatever the kind');
  });
  test('snapshot records identify the volatility mode actually used to price the legs', () => {
    expect(desc('get_snapshot')).toContain('the volatility mode the legs were priced with');
  });
  test('scenario own-price premium retains its own implied volatility', () => {
    expect(desc('compute_scenario')).toContain("a premium equal to the leg's own price is its own vol with no gap");
  });
});

describe('scenario parameters retain their complete rules on the wire', () => {
  test('default days distinguish a stock-only strategy', () => {
    expect(param('compute_scenario', 'shocks')).toContain('stock-only strategies use 0');
    expect(param('compute_scenario', 'shocks')).toContain('sorted and deduplicated');
    expect(param('compute_scenario', 'shocks')).toContain('spot -10, -5, -2, 0, 2, 5 and 10 percent; vol -5, 0 and 5 points');
  });
  test('portfolio fit distinguishes same-underlying correlation and preserves caps and stress model', () => {
    const p = param('compute_scenario', 'portfolioFit');
    for (const rule of ['up to 25 underlyings, 40 legs', 'last 60 common daily log returns', 'matching underlyings return 1', 'no beta scaling is applied']) expect(p).toContain(rule);
  });
  test('optional legs expose both bump caps even when a saved strategy is used', () => {
    const t = tools.find((t) => t.name === 'compute_scenario')!;
    expect((t.inputSchema as { required?: string[] }).required ?? []).not.toContain('legs');
    expect(desc(t.name)).toContain('the `legs` parameter gives them');
    expect(param(t.name, 'legs')).toContain('vol bumped one point, or a quarter of the vol when that is less; time a day, or a twentieth of the time left');
  });
});

describe('each exposure tool says what methodology 2 changes', () => {
  test('get_regime: the scopes\' exposures by methodology, after the first part\'s pointers', () => {
    const d = desc('get_regime');
    const line = 'The market, symbol and intraday scopes\' exposures follow `methodology`: 1 is the figures named above; 2 is the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma, the walls, flip, magnet and top strikes staying methodology 1\'s, labeled.';
    expect(d).toContain(line);
    expect(d.indexOf(line)).toBeGreaterThan(d.indexOf('get_dealer_positioning (end of day'));
  });

  test('get_options_analytics_history and get_options_snapshot: the book they share with get_dealer_positioning under 2', () => {
    expect(desc('get_options_analytics_history')).toContain('the exposures by `methodology` (1: GEX/DEX/VEX and net vanna/charm/vomma; 2: the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma)');
    expect(desc('get_options_analytics_history')).toContain('Under methodology 2 (`methodology`) this, get_options_snapshot and get_dealer_positioning report one stored book, the assumed dealer book, over the scope each answer states; only get_dealer_positioning\'s levels keep the 0-60 day window.');
    expect(desc('get_options_snapshot')).toContain('Under methodology 2 (`methodology`) one symbol\'s net GEX and DEX give way to `exposures`, and several symbols\' netGex and netDex are the assumed dealer book\'s GEX and delta balance: the one stored book get_options_analytics_history and get_dealer_positioning report under 2, over the scope each answer states.');
  });

  test('get_dealer_positioning and get_live_dealer_positioning: the book in place of the totals, the levels labeled', () => {
    expect(desc('get_dealer_positioning')).toContain('Under methodology 2 (`methodology`) netGex and netDex give way to `exposures`, the stored assumed dealer book get_options_snapshot and get_options_analytics_history report under 2, over its stated scope; these levels sit in `levels`, labeled methodology 1, each with its own prior in sincePriorSession.');
    const live = desc('get_live_dealer_positioning');
    const line = 'Under methodology 2 (`methodology`) every total, row, per-expiration and spot-side figure is the assumed dealer book\'s (GEX, delta balance, vega exposure, vanna, charm flow, vomma; an expiration\'s share is of Long OI GEX), and the levels with their statuses and coverage sit in `levels`, labeled methodology 1.';
    expect(live).toContain(line);
    // after the first part's sibling and prerequisite, which keep their places
    expect(live.indexOf(line)).toBeGreaterThan(live.indexOf(BROKER_PREREQUISITE));
    expect(live).not.toContain('netCharm');
  });
});
