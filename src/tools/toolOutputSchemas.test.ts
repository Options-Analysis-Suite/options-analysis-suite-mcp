import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { registerPlatformInfo } from './platformInfo.js';
import { registerAllTools } from './registry.js';
import { getMcpServerInfo } from '../server.js';
import { LiveApiClient, LiveApiError } from '../proxy/liveApiClient.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function captureRegisteredTools() {
  const tools: Array<{ name: string; config: Record<string, unknown>; handler: Function }> = [];
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: Function) {
      tools.push({ name, config, handler });
    },
  };
  return { tools, server };
}

const stubClient = () => ({ get: async () => ({}), post: async () => ({}) } as any);
const stubTokens = () => ({ getAccessToken: async () => 'token' } as any);

describe('MCP tool output schemas', () => {
  test('all registered tools advertise an outputSchema', () => {
    const { tools, server } = captureRegisteredTools();

    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());

    expect(tools).toHaveLength(46);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...new Set(tools.map((tool) => tool.name))].sort());
    for (const tool of tools) {
      expect(tool.config.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  test('the six proxy-backed live, EOD and compute tools are always registered', () => {
    // Formerly gated on OAS_DATA_API_URL being set, and dark in production.
    // There is no switch now: the proxy gates the live tools by tier at call
    // time with an envelope the model can act on, so hiding them here would
    // only stop a free user discovering what Pro buys.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes', 'get_live_quote', 'get_intraday_bars', 'compute_scenario', 'rank_live_skew_gex']) {
      expect(tools.map((t) => t.name), name).toContain(name);
    }
    // Four say Pro; the two anonymous-on-the-proxy reads must not.
    const titled = (name: string) => String(tools.find((t) => t.name === name)!.config.title);
    expect(titled('get_live_options_chain')).toContain('(Pro)');
    expect(titled('get_live_dealer_positioning')).toContain('(Pro)');
    expect(titled('get_live_quote')).toContain('(Pro)');
    expect(titled('get_intraday_bars')).toContain('(Pro)');
    expect(titled('rank_live_skew_gex')).toContain('(Pro)');
    expect(titled('get_regime_fits')).toContain('(Pro)');
    expect(titled('compute_black_scholes')).toContain('(Pro)');
    expect(titled('compute_scenario')).toContain('(Pro)');
    expect(titled('get_options_snapshot')).not.toContain('Pro');
    expect(titled('get_options_snapshot')).not.toContain('API tier');
    expect(titled('get_dealer_positioning')).not.toContain('Pro');
  });

  test('compute_scenario says an American leg\'s Greeks are its own tree\'s, and the platform info defines phi as the code does', async () => {
    // Second live re-test (2026-10-03): the at-the-money American put's
    // vanna and vomma were held to the European twin's and read as a defect
    // (at the money the twin's are near zero and the gap is the early
    // exercise premium's own sensitivity), and phi, which every pricer here
    // publishes as rho minus epsilon, was read as a foreign-rate rho because
    // the platform copy said so.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const scenario = String(tools.find((t) => t.name === 'compute_scenario')!.config.description);
    expect(scenario).toContain('An American leg\'s Greeks are finite differences of its own tree');
    expect(scenario).toContain('vol bumped one point');
    expect(scenario).toContain('spot a tenth of a percent, or a quarter of a one-sigma move to expiry when that is less, which is within hours of expiry at ordinary vols (about six hours at 15% vol, a day at 7%) and months out at very low vol, and then not under one node interval within the 0.1% cap, so such a leg is measured at its own scale; the third-order spot stencil one node interval wide, at least the spot bump and at most a tenth of spot');
    expect(scenario).not.toMatch(/within a day or so of expiry/);
    expect(scenario).toContain('A supplied or record entry premium carries `impliedVol`, the vol that premium implies at the leg\'s own model, and `volGapPoints`, that vol less the leg\'s in points; both are null with `impliedVolReason` when no vol prices the premium ("below-zero-vol-value", "above-max-vol-value") or when the premium sits on a stretch where vols are not told apart ("not-identifiable": a deep in-the-money American leg worth its intrinsic across many vols), and a premium equal to the leg\'s own price is its own vol with no gap. Past a point the answer warns, since the base P&L then carries a gap that is the premium disagreeing with the vol (a broker\'s IV snapshot can lag its quote), not a move.');
    expect(scenario).toContain('a call three hours out at 7% vol kept the European twin\'s delta, gamma, charm and vanna within 3% and its color, speed and zomma within 5%, where the fixed 0.1% spot bump had read charm a fifth low');
    expect(scenario).toContain('not the European twin\'s');
    // Fifth live run: one rate for the position, the Greek units
    // the convention leaves per unit of volatility, and lambda's meaning.
    expect(scenario).toContain('r is one rate for the position, the Treasury series matched to the shortest option leg\'s tenor and named in its source (the 3-month series when no option leg sets a tenor, or with a warning when the matched series cannot be read), and q comes from the symbol\'s stored dividend data (its trailing yield, else its stored dividend over spot)');
    expect(scenario).not.toContain('q the symbol\'s stored yield');
    expect(scenario).toContain('vanna, vomma, zomma and ultima per unit of volatility, not per point (to read one per point divide by 100 for each order in volatility: vanna and zomma by 100, vomma by 10,000, ultima by 1,000,000)');
    expect(scenario).toContain('`lambda` is the position\'s own elasticity, delta times spot over the position\'s value, for a net-debit position, and null for a credit or flat one');
    const info: any = await tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'all' });
    const text = JSON.stringify(info);
    expect(text).toContain('Phi: rho minus epsilon');
    expect(text).not.toMatch(/foreign \/ borrow rate/);
  });

  test('the live chain and positioning say an adjusted series (a digit root) is left out of the rows and named with its count', () => {
    // Second live re-test: Tradier listed no SPXW date because the shared
    // expirations request asked for one root; and the root merge, reviewed
    // for SPX and SPXW, would have united an adjusted series (AAPL1 after a
    // special dividend, a different deliverable) with the standard rows.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    expect(description('get_live_options_chain')).toContain('`excludedRoots`');
    expect(description('get_live_options_chain')).toMatch(/adjusted series/);
    expect(description('get_live_options_chain')).toMatch(/an empty book naming them/);
    // Review: the settlement pattern is SPX's, not every
    // index's (VIX weeklies settle in the morning, XSP monthlies at the close).
    expect(description('get_live_options_chain')).toContain('open interest and volume summed across the roots, each root\'s own in `openInterestByRoot` and `volumeByRoot` (null where that root published none; a row the broker named no root for under "unnamed"), prices from the one root with the most open interest over the date (the symbol\'s own root on a tie, as when the broker publishes no open interest) at every strike it lists, even where the other root is busier at that strike, so a spread\'s legs share a series wherever that root lists both strikes, `root` and `roots` naming them, and a row naming its own `root` only where it had to come from another');
    expect(description('get_live_options_chain')).not.toContain('every strike from it so a spread');
    expect(description('get_live_options_chain')).toContain('A date under one root names it the same way where the broker names each contract\'s root, `roots` then holding one (an index weekly listed only as SPXW). The root is the series, and series differ in settlement (SPX\'s monthly contracts settle in the morning of expiration day and SPXW\'s at the close, while VIX weeklies settle in the morning and XSP monthlies at the close), so read the exchange\'s specification for the root rather than a pattern.');
    expect(description('get_live_options_chain')).not.toMatch(/an index monthly in the morning/);
    expect(description('get_live_dealer_positioning')).toMatch(/adjusted series/);
    for (const name of ['get_live_dealer_positioning', 'scan_option_strategies']) expect(description(name), name).toContain('ADJUSTED_SERIES_ONLY');
  });

  test('no tool description promises the last completed session', () => {
    // The equity import lands in the early hours US Eastern and can lag a day
    // further, and futures snapshots are written at the close. A description
    // saying "the last completed session" promised a session the store may
    // not hold yet: with the latest stored chain dated the 15th on the 17th,
    // the tool returns the 15th under a description that says the 16th. The
    // EOD tools say "most recent session on file" and the returned date is
    // the session described.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const tool of tools) {
      const text = String(tool.config.description ?? '');
      expect(text, tool.name).not.toMatch(/completed session/i);
      expect(text, tool.name).not.toMatch(/last[- ]close/i);
      // "the previous trading session" (get_iv_surface) was the same claim
      // in other words. "Usually the previous session", qualified by the
      // import timing and the returned date, is the honest form and stays.
      expect(text, tool.name).not.toMatch(/(?<!usually )the previous (?:trading )?session/i);
      expect(text, tool.name).not.toMatch(/(?:previous|prior|last|latest) trading (?:session|day)/i);
    }
    for (const name of ['get_options_chain', 'get_iv_surface', 'get_options_snapshot', 'get_dealer_positioning']) {
      expect(String(tools.find((t) => t.name === name)!.config.description), name).toMatch(/most recent session on file/);
    }
  });

  test('the live and EOD descriptions say what their numbers are not', () => {
    // Second live run, after the close. Each of these was read wrongly by a
    // model that had only the description to go on:
    // - a 755 put quoted 0.63/0.64 with iv 0.164 and delta 0: the Greeks are
    //   the broker's as published and are not checked against the quote or
    //   the IV beside them; a delta of exactly 0 or 1 is a genuine limit deep
    //   in or out of the money and the failed solve elsewhere, and the tool
    //   cannot tell which;
    // - a repeat chain call within the proxy's 15-second cache came back
    //   byte-identical, same asOf, and still counted against the limit;
    // - coverage.gammaFlip read 1192/1192 while gammaFlipMethod said "mixed":
    //   the coverage counts every leg that entered the sweep, repriced or held;
    // - the flip moved from 764.56 to 764.58 on identical quotes: after the
    //   close only the clock moves, and time to expiry is measured from the
    //   wall clock when the rows are built, moments before asOf;
    // - AAPL's net GEX was 1.13bn in get_dealer_positioning and 1.63bn in the
    //   snapshot for the same session: all expirations versus 0-60 days.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    const chain = description('get_live_options_chain');
    expect(chain).toMatch(/not checked against the quote or the IV beside them/);
    // And it must not discredit a genuine limit: Black-Scholes gives delta
    // 1.0000 for S=100, K=80, 20% IV, one day out, and a broker publishing
    // that is right. The tool cannot tell that from the failed solve, and
    // says so.
    expect(chain).toMatch(/can be a genuine limit deep in or out of the money/);
    expect(chain).toMatch(/applies no check that tells the two apart/);
    expect(chain).toMatch(/treat such a delta as suspect/);
    // Neither form of the overclaim: not "beside a real quote it IS the
    // solver", and not "with a real premium and a usable IV it IS the solver"
    // (S=100, K=80, 20% IV, one day out has both and a genuine delta 1).
    expect(chain).not.toMatch(/exactly 0 or 1 next to a real two-sided quote is that solver/);
    expect(chain).not.toMatch(/real premium and a usable IV[^.]*it is the broker/);
    expect(chain).toMatch(/within 15 seconds/);
    // Eighteenth run: two live positioning calls with strikeRange 10 and 40
    // returned one asOf. proxy/routes/live-broker.ts caches the whole
    // exposure payload 15 s keyed (user, provider, symbol, four
    // expirations), charges the limiter BEFORE the cache, and MCP trims the
    // rows itself so strikeRange is not in the key; the cache is an
    // in-memory Map per proxy instance, so a hit is possible, not promised.
    expect(chain).toContain("A repeat for the same symbol and expiration on the same broker, by the same account, within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account's call never shares it.");
    expect(chain).not.toMatch(/within 15 seconds is answered/);
    expect(description('get_live_dealer_positioning')).toContain("Do not call it in a loop or for a list of symbols. A repeat for the same symbol and broker, by the same account, over the same expirations, asked the same way (the same `expiration`, `r` and `q`), within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, totals and levels whatever `strikeRange`, `strikeWindowPct` or `strikeWindowDelta` it asks for (they only choose which computed rows are returned), and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be computed afresh and another account's call never shares it.");
    // One named expiration is the list plus one chain, charged two units
    // (liveBrokerLimiter LIVE_EXPOSURE_ONE_EXPIRATION_COST).
    expect(description('get_live_dealer_positioning')).toContain("EXPENSIVE: a cold call over the default four expirations reads the expirations list and four chains, charged in your broker's own requests (on Tradier 1 + 4 x 2 = 9, so at most thirteen such calls a minute; on Schwab 1 + 4 = 5), and a call naming `expiration` reads the list and one chain (3 on Tradier, 2 on Schwab); actual upstream request counts vary with the provider and cache state.");
    // Nineteenth run: the row carried delta alone, and a bid sat below
    // intrinsic DURING trading hours (MU's same-day 1030 call bid 39.10 at
    // 15:10 ET on 2026-09-23 with spotPrice 1070.45), which the sentence
    // placed only outside them.
    expect(chain).toMatch(/Returns near-the-money strikes, the ATM pair, 25-delta wings and whole-chain volume\/open-interest totals, which add up what the broker reported, with `contractsMissingVolume` and `contractsMissingOpenInterest` beside them counting the contracts it left out \(null only when it reported none\); every contract row carries strike, bid, ask, mid, mark, last, iv, delta, gamma, theta, vega, volume and openInterest\./);
    expect(chain).toMatch(/`last` is the broker's last traded price, which can be hours old, and never stands in for `mid`\./);
    expect(chain).toMatch(/Delta, gamma, theta and vega are in the units the broker publishes; this tool does not rescale them or compare them across brokers\./);
    expect(chain).toMatch(/outside regular trading hours the quotes are the last ones the broker holds, and this tool does not date the quotes individually\. A bid can sit below intrinsic value against `spotPrice` during trading hours too \(MU's same-day 1030 call bid 39\.10 at 15:10 ET on 2026-09-23 with `spotPrice` 1070\.45, intrinsic 40\.45\)\./);
    expect(chain).not.toMatch(/the last ones the broker holds, a bid can sit below intrinsic value/);
    // review: the wider rows can exceed the 50KB guard at
    // strikeRange 40 on a dense grid, and the guard cut the window lopsided.
    const chainRange = String((tools.find((t) => t.name === 'get_live_options_chain')!.config.inputSchema as Record<string, { description?: string }>).strikeRange.description);
    expect(chainRange).toMatch(/^Strikes to return either side of spot\. Default 8, max 40\. Raise it for a wider view; the whole-chain totals are unaffected by this\. If the rows at that range would exceed the 50KB response budget \(a dense strike grid with long published decimals\), the window is narrowed evenly on both sides until it fits: `view\.strikeRange` is the range returned, `view\.requestedStrikeRange` the one asked for, and `view\.narrowedForSize` is true\.$/);
    const positioning = description('get_live_dealer_positioning');
    expect(positioning).toMatch(/coverage\.gammaFlip` counts every leg that entered the sweep, repriced or held/);
    // The rows take Date.now() in chainsToStrikeRows BEFORE the market-input
    // read; asOf is stamped after it. Two clocks, moments apart, and the
    // description must not name the later one as the one the maths used.
    expect(positioning).toMatch(/time to expiry is measured from the wall clock when the chain rows are built, moments before `asOf`/);
    expect(positioning).not.toMatch(/last[- ]close/i);
    const snapshot = description('get_options_snapshot');
    expect(snapshot).toMatch(/net GEX and DEX here are over ALL expirations/);
    expect(snapshot).toMatch(/0-60 day window/);
    // SnapshotComputeService EQUITY_CHAIN_MIN_DTE: stored after the session's own expirations settle.
    expect(snapshot).toMatch(/`chainExpiry` is, for a stock, ETF or index, the nearest expiration at least a day after the session \(the snapshot is stored after that session's own expirations settle; null, with no chain, when none is that far out\); a futures contract's snapshot is taken intraday and can name the session's own expiration/);
    expect(snapshot).not.toMatch(/same-day one included/);
    // SnapshotComputeService._findNearestMonthly: at least 7 days out, the
    // monthly nearest 30 DTE, any expiration when no monthly qualifies. On
    // 2026-09-16 with 09-18 and 10-16 listed the producer picks 10-16, and
    // "the nearest monthly" would have sent a caller to 09-18 for max pain.
    expect(snapshot).toMatch(/`analyticsExpiry` is the expiration max pain and the probability analytics are computed on: the monthly nearest to 30 days out among those at least 7 days out, a non-monthly nearest to 30 days out when no monthly is that far out, and the first listed expiration when nothing is/);
    // The last fallback is expirations[0]: with only 09-18 listed on 09-16
    // the producer computes max pain on a two-day expiration, and a
    // description that stopped at "a non-monthly" promised a seven-day floor
    // the code does not keep.
    expect(snapshot).toMatch(/with only 09-18 listed it is 09-18, two days out/);
    expect(snapshot).not.toMatch(/is the nearest monthly/);
    // Third run. The surface's six were the first six by date (0 to 12 days,
    // no 30/60/90 point, led by the same-day expiry) beside a chain sampled
    // across the curve; both sample the same way now and say so, and the
    // surface says what its three IV fields are (smoothed SMV vs raw mid IV
    // per side). eSSVI stores no price RMSE on any of its 3,842 rows since
    // August: it is an IV-surface fit, and "IV and price RMSE" overclaimed.
    const surface = description('get_iv_surface');
    // The sample is one per tenor bucket FIRST, then the earliest remaining
    // up to six: DTEs [2,5,7,9,12,16] return all six, three from each of two
    // buckets, and "one per bucket" alone described a smaller set.
    expect(surface).toMatch(/six expirations sampled across the curve: one per tenor bucket first, then the earliest remaining up to six, the same rule get_options_chain uses/);
    expect(surface).toMatch(/The expiry that ended that session \(zero days to expiry\) is skipped whenever a later one exists/);
    // The wire name. The sanitizer renames `_surface_meta` to `surfaceMeta`
    // (helpers.ts DYNAMIC_META_KEY_RE), so a description pointing at
    // `_surface_meta.same_day_skipped` named a key no caller can find.
    expect(surface).toMatch(/`surfaceMeta\.sameDaySkipped`/);
    expect(surface).not.toMatch(/same_day_skipped/);
    expect(surface).not.toMatch(/_surface_meta/);
    // The proxy applies capIv to all three columns (packages/shared ivBounds:
    // finite, above 0, at most 5), so `iv` is the FIRST USABLE of the three,
    // not "the smoothed value where one is stored", and the side IVs are
    // banded, not raw: stored SMV 10, call 0.2, put 0 comes back iv 0.2,
    // callIV 0.2, putIV null.
    expect(surface).toMatch(/`iv` is the first usable value, in order, of the smoothed surface value, the call mid IV and the put mid IV/);
    expect(surface).toMatch(/`putIV` and `callIV` are the mid implied volatilities of each side, each null where the stored value is outside the usable band \(finite, above 0, at most 5/);
    expect(surface).not.toMatch(/raw mid implied volatilities|where none is stored/);
    // And the skew is built from those side IVs alone (ivSurfaceShaping): a
    // missing side used to be replaced by the smoothed value, so the summary
    // reported a skew of 0 for a strike with no usable side IV.
    // pickNearestRow at 0.95 and 1.05 of spot runs over the strikes on each
    // side of the ATM strike with the ATM strike used up, so "nearest 95%"
    // alone named the wrong strike at APT's spot 5.25 (5.0 is nearest 4.9875
    // and is the ATM; the put wing is 4.5).
    expect(surface).toMatch(/`skewSummary\[\]\.putCallSkew` is the put-wing mid IV at the strike nearest 95% of spot among strikes below the ATM strike, minus the call-wing mid IV at the strike nearest 105% of spot among strikes above it \(the ATM strike, the one nearest spot, is never a wing; ties go to the lower strike\)/);
    // A missing wing and an unusable wing are different outcomes: the row is
    // absent for the first (spot 5, strikes [5, 5.5] -> skewSummary []) and
    // carries null for the second. "Null unless both are usable" said only
    // the second.
    expect(surface).toMatch(/It is null when either wing's mid IV is unusable, and an expiration with no strike beyond the ATM on one side has no skew row at all/);
    expect(surface).not.toMatch(/null unless both are usable/);
    // Fourth run: the two tools' putCallSkew read 0.093 and 0.0179 on the
    // same expiration under one name, and the surface's blended iv named no
    // source while the chain's did.
    expect(surface).toMatch(/NOT the same measure as get_options_chain's `putCallSkew`/);
    expect(surface).toMatch(/`ivSource` beside each `iv` \(and `atmIvSource` on the term-structure and skew rows\) says which of the three it is: "smoothed", "call-mid", "put-mid", or null/);
    expect(surface).toMatch(/`expirationCount` and `rowCount` count every expiration and row in the file, the skipped same-day one included/);
    expect(surface).toMatch(/IVs are rounded to four decimals/);
    const eodChain = description('get_options_chain');
    expect(eodChain).toMatch(/`putCallSkewBasis` says so beside it, because get_iv_surface's `putCallSkew` is a different measure \(the strikes nearest 95% and 105% of spot on either side of the ATM strike\)/);
    const eod = description('get_options_chain');
    expect(eod).toMatch(/a sample of up to six expirations across the curve, one per tenor bucket first and then the earliest remaining, skipping the expiry that ended that session/);
    expect(eod).toMatch(/`expirationCount` counts every expiration in the file, that one included/);
    // The proxy fills a contract's impliedVolatility from the side mid where
    // usable and otherwise the smoothed SMV; stored (0.3, 0, 0) arrived as
    // 0.3 on both wings and the summary reported a skew of 0 with nothing
    // saying the wings were the same smoothed number. Sources are named and
    // the skew is side mids only.
    expect(eod).toMatch(/`impliedVolatility` on a contract is the side's own mid IV where usable \(finite, above 0, at most 5\) and otherwise the smoothed surface value standing in/);
    expect(eod).toMatch(/`putCallSkew` is the 25-delta put IV minus the 25-delta call IV only when both are side mids, otherwise null/);
    // atmAverageIv is the mean of the two ATM IVs, or the one that is usable
    // (optionsChainShaping: 0.22 and null give 0.22), whatever their sources.
    expect(eod).toMatch(/`atmAverageIv` is the mean of the ATM call and put IVs, or the one that is usable when the other is not, whatever their sources/);
    const chainDate = String(((tools.find((t) => t.name === 'get_options_chain')!.config.inputSchema as Record<string, { description?: string }>).date).description);
    expect(chainDate).toMatch(/most recent session on file for this symbol, whatever its date; read `date` in the result/);
    expect(chainDate).not.toMatch(/latest available/);
    const fits = description('get_regime_fits');
    expect(fits).toMatch(/a price RMSE for every model except eSSVI/);
    expect(fits).not.toMatch(/its IV and price RMSE/);
  });

  test('platform info carries the eSSVI price-RMSE exception the fits tool states', async () => {
    // The tool description said it; platform info, which a model reads first,
    // still promised "IV and price RMSE" for the eight, and an eSSVI row's
    // priceRmse null then read as a broken fit.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const info: any = await on.tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'capabilities' });
    const text = String(info.structuredContent.text);
    expect(text).toMatch(/IV RMSE for every model and price RMSE for all but eSSVI/);
    expect(text).not.toMatch(/\(IV and price RMSE\) for the eight/);
  });

  test('the EOD chain points at the live tool, conditioned on the question', () => {
    // Without the pointer a Pro user asking for prices "right now" is quietly
    // served the most recent session on file.
    const withApi = captureRegisteredTools();
    registerAllTools(withApi.server as any, stubClient(), stubTokens(), stubClient());
    const eod = withApi.tools.find((t) => t.name === 'get_options_chain')!;
    expect(eod.config.description).toContain('get_live_options_chain');
    expect(eod.config.description).toContain('Pro subscription');
    expect(eod.config.description).not.toContain('API tier');
    // Conditioned on the QUESTION, not the tier. Both halves must be present:
    // the explicit ask for current prices, AND the implicit one - a request for
    // a specific contract's quote is a question about now even without the
    // word. Routing on the literal phrase alone leaves the common case stale.
    const text = String(eod.config.description);
    expect(text, 'explicit freshness').toMatch(/live, current or intraday/);
    expect(text, 'implicit freshness: a quote request').toMatch(/quote, bid, ask or mark/);
    // And it must not read as "always prefer the API tool": the live call
    // spends the user's own broker quota, so past sessions stay here.
    expect(text, 'when to stay').toMatch(/Stay here for/);
  });

  test('the six proxy-backed tools request the proxy paths that exist', async () => {
    // The paths are the retarget. Every other test here stubs the client and
    // ignores what was asked for, so a tool still requesting /v1/data/... would
    // pass all of them and 404 in production. Recorded, and pinned to the
    // routes proxy/routes/live-broker.ts, regime.ts and scanner.ts mount.
    const requests: Array<{ path: string; params?: Record<string, string>; body?: unknown }> = [];
    const recording = {
      get: async (path: string, params?: Record<string, string>) => { requests.push({ path, params }); return {}; },
      post: async (path: string, body: unknown) => { requests.push({ path, body }); return {}; },
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), recording);
    const call = (name: string, args: Record<string, unknown>) =>
      tools.find((t) => t.name === name)!.handler(args);

    await call('get_live_options_chain', { symbol: 'spy', expiration: '2026-10-16', provider: 'tradier' });
    await call('get_live_dealer_positioning', { symbol: 'spy' });
    await call('get_live_dealer_positioning', { symbol: 'spy', expiration: '2026-09-25' });
    await call('get_live_dealer_positioning', { symbol: 'spx', r: 0.0425, q: 0.012 });
    await call('get_regime_fits', { symbol: 'spy', days: 5 });
    await call('get_options_snapshot', { symbols: 'spy' });
    await call('get_options_snapshot', { symbols: 'spy, qqq' });
    await call('get_dealer_positioning', { symbol: 'spy', date: '2026-09-15' });
    await call('get_dealer_positioning', { symbol: 'spy' });
    await call('compute_black_scholes', { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' });
    await call('get_live_quote', { symbol: 'spy', provider: 'schwab' });
    await call('get_live_quote', { symbol: 'spx' });
    await call('get_intraday_bars', { symbol: 'spy', interval: '1min', session: 'extended', indicators: [{ name: 'sma', params: { period: 20 } }] });
    await call('compute_scenario', { symbol: 'spy', legs: [{ type: 'call', side: 'long', strike: 500, expiration: '2026-10-17' }], full: true });

    expect(requests).toEqual([
      { path: '/live/options-chain/SPY', params: { expiration: '2026-10-16', provider: 'tradier' } },
      { path: '/live/exposure/SPY', params: {} },
      { path: '/live/exposure/SPY', params: { expiration: '2026-09-25' } },
      // Plain decimals, as the scan sends its own: the route refuses an exponent.
      { path: '/live/exposure/SPX', params: { r: '0.0425', q: '0.012' } },
      { path: '/regime/fits/SPY/history', params: { days: '5' } },
      { path: '/scanner/snapshot/SPY', params: undefined },
      { path: '/scanner/metrics/batch', params: { symbols: 'SPY,QQQ' } },
      { path: '/eod/exposure/SPY', params: { date: '2026-09-15' } },
      { path: '/eod/exposure/SPY', params: {} },
      // Only what was given: no `undefined` keys, so the route's exactly-one
      // rule for t / daysToExpiry sees what the caller sent.
      { path: '/compute/black-scholes', body: { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' } },
      { path: '/live/quote/SPY', params: { provider: 'schwab' } },
      { path: '/live/quote/SPX', params: {} },
      { path: '/live/bars/SPY', params: { interval: '1min', session: 'extended', indicators: '[{"name":"sma","params":{"period":20}}]' } },
      // `full` shapes the answer in the tool and never reaches the route.
      { path: '/compute/scenario', body: { symbol: 'spy', legs: [{ type: 'call', side: 'long', strike: 500, expiration: '2026-10-17' }] } },
    ]);
  });

  test('the IV surface reads the session the chain reads', async () => {
    // Fifth run: get_options_chain took date 2026-09-16 and get_iv_surface
    // took no date, so the APT surface came back from the 09-17 file and
    // nothing pinned to the 09-16 fixture could be checked, and the two
    // tools' skews on AAPL 09-18 were compared across two sessions. The
    // proxy route (scanner.ts /scanner/iv-surface/:ticker) has taken ?date
    // all along; the tool never passed one.
    const requests: Array<{ path: string; params?: Record<string, string> }> = [];
    const recording = {
      get: async (path: string, params?: Record<string, string>) => { requests.push({ path, params }); return {}; },
      post: async () => ({}),
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, recording, stubTokens(), stubClient());
    const surface = tools.find((t) => t.name === 'get_iv_surface')!;
    await surface.handler({ symbol: 'apt', date: '2026-09-16' });
    await surface.handler({ symbol: 'apt' });
    expect(requests).toEqual([
      { path: '/scanner/iv-surface/APT', params: { date: '2026-09-16' } },
      { path: '/scanner/iv-surface/APT', params: {} },
    ]);
    const schema = surface.config.inputSchema as Record<string, { description?: string }>;
    expect(String(schema.date.description)).toMatch(/Defaults to the most recent session on file for this symbol, whatever its date; read `date` in the result\. A date with no file for the symbol is an error, not the nearest session/);
    const text = String(surface.config.description);
    // Not "the same file get_options_chain reads": with a date the surface
    // resolves the ticker identity covering that day (SupabaseService
    // getIVSurface -> resolveTickerSegments: META on 2022-05-16 reads FB's
    // ticker_id), and the chain reads the current ticker's rows directly
    // (getOptionsChain -> strike_tickers by symbol). Review ran both readers
    // over FB/META fixture rows and got spot 200 here and spot 10 there,
    // both labelled META, same date. And the chain reads the REQUESTED
    // ticker's rows, not "the current ticker's": asking for FB on that date
    // sends both readers to FB's id and they agree; asking for META is what
    // diverges.
    expect(text).toMatch(/Set `date` to read a specific session, as get_options_chain does; for a symbol whose ticker has changed \(FB to META\), a date before the change reads the history under the ticker of that day here and the requested ticker's rows in get_options_chain, so the two need not agree there/);
    expect(text).not.toMatch(/the same file get_options_chain reads|the current ticker's rows/);
    // The wings on a skew row can sit far from 95% and 105% on a coarse
    // strike grid (APT 10-09: 76% and 114%), and only the preview said so.
    expect(text).toMatch(/`putRelativeStrike` and `callRelativeStrike` on each skew row say how far from spot each wing actually sits/);
    // The usable band is a sentinel filter, not a quality filter: APT 09-25
    // reported a skew of -2.7431 from two in-band mids stored beside quotes
    // with no bid. And the stored smoothed value can be flat across strikes.
    expect(text).toMatch(/The band rejects stored sentinels, not noise/);
    expect(text).toMatch(/the stored smoothed value can be one number across every strike of an expiration/);
    // Sixth run: APT 11-20 at 65 days read smoothed 0.148 below both sides,
    // 0.4294 and 0.5145 (stored smooth_smv_vol 0.148, c_mid 0.51451,
    // p_mid 0.42939), so "near expiry" understated where it happens. And
    // the smoothed values show three decimals because the store holds
    // three (scan_strikes.smooth_smv_vol is a real; zero rows with more
    // on 2026-06-01, 08-03, 09-15, 09-16 and 09-17, 5.0M rows).
    expect(text).toMatch(/The smoothed value can sit outside both sides, near expiry and on a thin name at any tenor; that is the smoothing, not an error/);
    expect(text).not.toMatch(/Near expiry the smoothed value/);
    expect(text).toMatch(/IVs are rounded to four decimals \(the stored smoothed value carries three, so it shows three\)/);
  });

  test('the EOD chain says what "mid" names and which contract each 25-delta wing is', () => {
    // APT261002C00005000 came back `mid: null, impliedVolatility: 3.15781,
    // ivSource: "mid"`: the source names the side's stored mid IV column,
    // the field beside it is (bid + ask) / 2 of a quote with no bid. And on
    // a 50-cent grid the "25-delta put" was the ATM strike on every
    // expiration with nothing on the row saying which contract it was.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_options_chain')!.config.description);
    expect(text).toMatch(/"mid" names the side's stored mid IV column \(the stored call-side or put-side mid IV column\), not the contract's `mid` price beside it/);
    expect(text).toMatch(/`put25DeltaStrike`, `put25DeltaDelta`, `call25DeltaStrike` and `call25DeltaDelta` are the strike and delta of the contract each wing actually is/);
    expect(text).toMatch(/can be the ATM strike itself/);
    expect(text).toMatch(/an in-the-money one when no out-of-the-money contract exists on that side/);
    expect(text).toMatch(/The band rejects stored sentinels, not noise/);
    // Sixth run: APT 10-09 named call25DeltaStrike 6 at delta 0.008285,
    // the nearest to 0.25 among OTM calls whose deltas were 0.008 and then
    // 0. The rule was stated; that the pick can be that far off was not.
    expect(text).toMatch(/whose delta is nearest 0\.25 in magnitude, however far from it that is/);
  });

  test('the intraday regime says what `days` reaches back to', () => {
    // Seventh run: get_regime {scope: "intraday", symbol: "SPY", days: 1}
    // returned seven scans over two dates. The proxy route
    // (proxy/routes/regime.ts /regime/intraday/:symbol) filters
    // market_date >= today minus `days`, cutoff day included, so days: 1
    // is yesterday and today; "history days" did not say that. And
    // "today" is the proxy's UTC date (review): at
    // 2026-09-19T00:30Z, still the 18th in New York, days: 1 cuts off at
    // the 18th and no longer reaches the 17th's session.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const regime = tools.find((t) => t.name === 'get_regime')!;
    const days = String((regime.config.inputSchema as Record<string, { description?: string }>).days.description);
    // Dates, not sessions (review): at Sunday 01:00Z the
    // cutoff is Saturday and the window returns no rows although Friday
    // is the latest session; weekends and holidays are not skipped.
    expect(days).toMatch(/For scope=intraday: calendar days back from the current UTC date, the cutoff day included, so 1 returns the previous UTC day and the current one; at midnight UTC \(7 PM EST, 8 PM EDT\) the cutoff advances one calendar date, and weekends and holidays are not skipped, so a window can cover days with no session and return no rows \(default 5, max 90\); use `date` for one session/);
    expect(days).not.toMatch(/back from today|the session before the current one/);
    // Fourteenth run: days: 2 on 2026-09-18 returned 09-16, 09-17 and
    // 09-18, fourteen scans over three sessions, under "cutoff day
    // included"; the description now counts the dates.
    expect(String(regime.config.description)).toMatch(/Accepts `days` \(calendar days back from the current UTC date, cutoff day included, so N spans N\+1 dates: 2 on 2026-09-18 returned 09-16, 09-17 and 09-18; default 5, max 90\)/);
    expect(String(regime.config.description)).not.toMatch(/cutoff day included; default 5/);
  });

  test('every dealer regime says it is the sign of gamma at spot, not of net GEX', () => {
    // The producer (proxy/lib/exposure-compute.ts:490-511, and the shared
    // compute the live route uses) sets the regime from the sign of the
    // near-term net gamma INTERPOLATED AT SPOT between the two bracketing
    // strikes; the sign of net gamma is only the fallback with fewer than
    // two strikes. Stored SPY 2026-09-17: net_gex_0_60d -5.49e9, regime
    // "positive"; regime_intraday SPY 09-17 afternoon: netGamma -7.9e9,
    // "positive". Three descriptions said "positive or negative gamma",
    // which reads as the sign of netGex, and a reader called the rows
    // contradictory.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    // review: with spot outside the strike range there is no
    // bracketing pair and the nearest strike's gamma decides (strikes 80
    // and 90 at -10,000 and +1,000, spot 100: total -9,000, regime
    // positive); the live route passes no expiry window, so its regime is
    // over the selected expirations, not a near-term subset. And the eighth
    // run: SPY 09-17 spot 763.01 sat BELOW the flip 764.97 with regime
    // positive, so the flip side is a second thing the regime need not
    // agree with (the flip is the repriced profile's crossing; the regime
    // is the stored per-strike gamma at spot).
    // review: the sparse fallback is the sign of the engine's
    // whole-input net gamma, which is exactly the field each sentence says
    // the regime is otherwise NOT the sign of: the EOD producer's input is
    // the 0-60 day rows (`netGex` is net_gex_0_60d), the scanner's is the
    // whole book with a 60-day level window (`exposures.netGamma`), and
    // the live route's is the selected expirations (`netGex`). "The sign of
    // net gamma" left the reader to guess which; each clause names it.
    // review: "every expiration" overstated the intraday book.
    // The intraday normalizer drops the same-day expiration (dte <= 0)
    // and any strike pair without a usable delta before the engine runs
    // (intraday-processor.ts:316-325); the daily scan passes every stored
    // row (data-pipeline.ts fetchStrikes has no filter but ticker and
    // date). A same-day put at -10,000 under a seven-day call at +1,000:
    // intraday publishes netGamma 1,000, regime positive; the daily scan
    // would carry -9,000.
    // review: "every row but" those two was a third overclaim.
    // normalizeTradierChain first drops every leg with a zero bid, no
    // Greeks or no mid IV (:288-293), and a per-expiry chain fetch that
    // fails is only warned about (:511-516), so that expiration never
    // arrives. Eight valid calls plus a seven-day put with a valid delta
    // and gamma but a zero bid: the scan publishes +800; with the put,
    // -9,200. The clause now says the intraday field is over the rows the
    // normalizer retains, names every rejection, and says a failed fetch
    // leaves its expiration out.
    const eod = description('get_dealer_positioning');
    expect(eod).toMatch(/`dealerRegime` is the sign of the 0-60 day net gamma interpolated at spot between the two strikes that bracket it \(the nearest strike's gamma when spot is outside the strike range\), not the sign of `netGex` and not which side of `gammaFlip` spot sits on; it can disagree with both \(SPY on 2026-09-17: netGex -5\.5 billion, spot 763\.01 below the flip 764\.97, regime positive\), and only with fewer than two gamma-bearing strikes in that window is it the sign of `netGex` itself/);
    expect(eod).not.toMatch(/the dealer regime \(positive or negative gamma\)|near-term net gamma|the sign of the window's net gamma/);
    const live = description('get_live_dealer_positioning');
    expect(live).toMatch(/`dealerRegime` is the sign of the net gamma over the selected expirations interpolated at spot between the two strikes that bracket it \(the nearest strike's gamma when spot is outside the strike range\), not the sign of `netGex` and not which side of `gammaFlip` spot sits on; it can disagree with both, and only with fewer than two gamma-bearing strikes is it the sign of `netGex` itself/);
    expect(live).not.toMatch(/a dealer regime of positive or negative gamma|two near-term strikes|it is the sign of net gamma/);
    const regime = description('get_regime');
    expect(regime).toMatch(/`exposures\.regime` on any entry is the sign of the 0-60 day net gamma interpolated at spot between the two strikes that bracket it \(the nearest strike's gamma when spot is outside the strike range\), not the sign of `exposures\.netGamma` and not which side of the gamma flip spot sits on; it can disagree with both \(SPY's 2026-09-17 afternoon scan: netGamma -7\.9 billion, regime positive\), and only with fewer than two gamma-bearing strikes in that window is it the sign of `exposures\.netGamma` itself\. That field is the net gamma of the whole exposure input with no 60-day cutoff: every stored row for the daily scan; for the intraday scan, only the rows its normalizer retains from the broker chain, which drops the same-day expiration, every leg with a zero bid, no Greeks or no mid implied volatility, and every strike without a usable delta, and an expiration whose chain fetch failed is absent altogether\./);
    expect(regime).not.toMatch(/near-term net gamma|it is the sign of net gamma|every expiration|every row but/);
  });

  test('the history tool says which way each shape runs and what `count` counts', () => {
    // Eighth run: the raw shape ran oldest first (the proxy sorts ascending,
    // history-backtest.ts), the summary's `data` newest first, and `count`
    // read 267 beside a 20-row `data`.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_options_analytics_history')!.config.description);
    // Ninth run: only the summary carried `dataMeta.order`; now both do.
    expect(text).toMatch(/`dataMeta\.order` on either shape says which way it runs/);
    expect(text).toMatch(/The raw shape lists every row in the window oldest first; the summary keeps the newest `dataMeta\.recent` rows in `data`, newest first, and `count` is the rows in the whole window, not in `data`; `dataMeta\.order` on either shape says which way it runs; summary points are compact: twenty fields, IVs and ratios rounded to four decimals, prices to two, the slope and rate to five, exposures to whole numbers, and `latest`, `earliest` and `trendSample` are the same compact shape/);
  });

  test('the regime tool says the label has hysteresis, how intraday scans are ordered, and that its gamma magnet is named as on the positioning tools', () => {
    // Ninth run: SPY 2026-09-18 midday 0.4229 labelled ELEVATED against
    // "NORMAL -0.5 to 0.5"; intraday scans read "neither newest-first nor
    // oldest-first" (newest date first, session order within it); and one
    // strike carried three names: abs_gamma_strike in the store, "abs
    // gamma" here, gammaMagnet on both positioning tools.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_regime')!.config.description);
    expect(text).toMatch(/`label` is a state with hysteresis, not a band read off the score\. Entry levels: NORMAL -0\.5, ELEVATED 0\.5, STRESS 1\.5, CRISIS 2\.5, and CALM below -0\.5 with no prior; exit levels: NORMAL -1\.0, ELEVATED 0\.0, STRESS 1\.0, CRISIS 2\.0\./);
    // Tenth run: the example chained through 09-17's intraday scans, but by
    // the rule a day's open takes the previous DAILY label; 09-17's daily
    // row is ELEVATED at 0.506, and that is where 09-18's label came from.
    expect(text).toMatch(/SPY's 2026-09-18 midday scan, 0\.4229, is ELEVATED because the day's open scan took the 2026-09-17 daily label, ELEVATED at 0\.506, and no scan since fell below 0\.0\./);
    expect(text).not.toMatch(/entered at 0\.5987 the day before/);
    // The payload note is the short form and says where the full rule is.
    expect(text).toMatch(/`stressScoreNote` on every response carries the short form of this rule/);
    // Tenth run, three producer facts the payload cannot show: z-scores are
    // winsorized to +-5 (regime-scorer.ts winsorize); the market composite's
    // driver `contribution` is weight times |z| (run-regime-daily.ts) while
    // the symbol and intraday scopes carry weight times z (computeDrivers);
    // and the daily scan's flip differs from get_dealer_positioning's for the
    // same session (SPY 09-17: 765.14 vs 764.97) because the two producers
    // take different rate and yield inputs and the scan's topStrikes are over
    // the whole book.
    // review: a displayed +-5 can be a rounded 4.99996 or a
    // raw 5 that the clamp left alone, so the band is stated without
    // claiming its edge proves clipping; and under include_symbols the
    // per-symbol breakdown's drivers stay signed (XME 09-17 curvature
    // -0.2937), so the unsigned rule names the composite's own `market.
    // drivers`, not the scope.
    expect(text).toMatch(/Feature z-scores are winsorized to -5\.\.5, so no \|z\| exceeds 5 and a value at that edge may have been clipped\./);
    expect(text).not.toMatch(/is a clipped value, not a measurement/);
    expect(text).toMatch(/On the market scope, the composite's own `market\.drivers` carry a `contribution` of weight times \|z\|, unsigned and sorted by size, so that column does not sum to `stressScore` \(apply the sign of `z` to each\); every other driver list, the per-symbol breakdown under `include_symbols` included, and the symbol and intraday scopes, carries weight times z, signed\./);
    expect(text).not.toMatch(/On the market scope each driver's/);
    expect(text).toMatch(/The daily scan's call wall, put wall, gamma flip, gamma magnet and regime use the 0-60 day window, like get_dealer_positioning's, but the scan takes its own rate and dividend inputs \(a tenor-weighted FRED rate and an estimated yield, against the snapshot's median rate and yield from the options data\), so its gamma flip differs from get_dealer_positioning's for the same session \(SPY 2026-09-17: 765\.14 here, 764\.97 there\), and its `topStrikes` are over the whole book, so per-strike values differ too\./);
    // The volatility and sectors scopes (phase E) carry no stress score.
    expect(text).toMatch(/On the market, symbol and intraday scopes, `stressScore` is a raw composite regime score/);
    expect(text).toMatch(/Get regime data at one of six scopes\./);
    expect(text).not.toMatch(/stress_score/);
    expect(text).not.toMatch(/Bands: CALM|Typical bands/);
    expect(text).toMatch(/Scans come newest date first and, within a date, by scan time ascending \(not by interval: a rerun scan sits after the ones before it\), so the newest scan is the last entry of the first date; `scansMeta\.order` says so\./);
    expect(text).not.toMatch(/in session order|open to pre-close\), so/);
    // Thirteenth run: SPY's 2026-09-17 midday scan (0.5987 ELEVATED,
    // confidence 0.9414) reproduces only against a kept ELEVATED prior,
    // while the morning scan before it was NORMAL. The worker's store of
    // the day's scans is proxy/data/intraday-regime-<date>.json on the
    // Cron Server's disk (intraday-regime.ts loadSnapshots/saveSnapshot);
    // that service redeployed at 16:08Z and 17:18Z, and every scan after a
    // deploy that day and the next reproduces only against the previous
    // daily label, every scan with no deploy since the one before it
    // against that scan. The persisted row carries no prevLabel.
    expect(text).toMatch(/for the daily symbol and market scopes, the latest earlier daily label stored for the same symbol, symbol tier and model version; for an intraday scan, the previous scan of the day while the scan worker still holds it, else that same daily label; the worker's store of the day's scans is a file on its disk that a redeploy between two scans wipes, so the scan after one takes the daily label \(SPY's 2026-09-17 midday scan, ELEVATED at 0\.5987 with confidence 0\.9414, was judged against the 2026-09-16 daily label ELEVATED, not the morning scan's NORMAL\)/);
    expect(text).not.toMatch(/from the run's own cache/);
    expect(text).toMatch(/Without a usable prior label, including when the prior could not be read, the label is the highest state whose entry level the score meets\./);
    expect(text).not.toMatch(/the previous stored daily label|With no such prior|same symbol, scope and model version/);
    expect(text).not.toMatch(/for a day's first intraday scan/);
    // The field was "abs gamma" here and gammaMagnet on both positioning
    // tools; it is now `gammaMagnet` everywhere.
    expect(text).toMatch(/call wall, put wall, gamma flip, gamma magnet \(`exposures\.gammaMagnet`, the strike with the largest absolute net gamma, named as on get_dealer_positioning and get_live_dealer_positioning\)/);
    expect(text).not.toMatch(/abs gamma/);
  });

  test('the three tools that publish walls say what a wall is, and get_regime says what a null flip and confidence are', () => {
    // Eleventh run: KBE 2026-09-17 carried call wall 66 and put wall 68
    // with spot 66.77; MTUM 300/310, XBI 155/158, UNG 9/10. Each wall is
    // the largest-gamma strike on its side (exposure-compute.ts: max
    // callGamma, min putGamma) and nothing orders them, which "resistance
    // and support" did not say. UNG, VIXY and VXX carried a null "gamma
    // flip" with no note; and SCHD read ELEVATED at confidence 0.0955
    // with nothing saying what confidence measures (computeConfidence:
    // band depth, times model coverage to the 1.5, times 0.85 on a label
    // change).
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    // review: both engines take strict > 0 and < 0 from zero,
    // so a side with no positive call gamma (or no negative put gamma)
    // leaves that wall null, ties go to the lower strike; the scan's flip
    // routine returns before sampling when the stored spot is not positive
    // (a stk_px_cents of -100 is persisted as spotPrice -1, flip null); and
    // symbol-coverage confidence is the composite's own, the breakdown's
    // rows keep model coverage; 0.85 applies with no prior as well.
    const wall = /the call wall is the strike with the largest positive call gamma and the put wall the strike with the most negative put gamma \(ties go to the lower strike; a side with no such strike leaves that wall null\), and nothing orders them, so the put wall can sit above the call wall/;
    expect(description('get_regime')).toMatch(wall);
    expect(description('get_regime')).toMatch(/KBE on 2026-09-17: call wall 66, put wall 68, spot 66\.77/);
    expect(description('get_dealer_positioning')).toMatch(wall);
    expect(description('get_live_dealer_positioning')).toMatch(wall);
    expect(description('get_live_dealer_positioning')).not.toMatch(/the gamma levels that act as resistance and support/);
    const regime = description('get_regime');
    expect(regime).toMatch(/A null `exposures\.gammaFlip` on any entry means the producer's coarse-grid sweep within 20% of spot found no zero crossing, or its profile was zero at every sampled price, or no open interest sat within its window, or the stored spot was not a positive number; it is not a level of zero\./);
    // Twelfth run: "its label's band" named no edges, and SPY's midday
    // 0.4229 (confidence 0.8234) only fits a band from the label's exit
    // level to the next state's entry level. computeBandDepth: lower =
    // exit when kept, entry when just entered from below; upper = next
    // state's entry, or the previous label's exit when just entered from
    // above; CALM and CRISIS measure from their one edge over 1.5; depth =
    // distance to the nearer edge over half the band, through
    // (1 - e^(-2.5 d)) / (1 - e^-2.5). Checked: 0.4229 in 0.0..1.5 gives
    // 0.8234; the open's stored 1.3496 gives 0.4295, and its stored 0.4296
    // comes from the unrounded score (confidence is computed before the
    // score is rounded; review).
    // Thirteenth run: "entry level when just entered from below" left the
    // lower edge of a downward move unsaid; computeBandDepth takes
    // current.exit when staying and current.enter otherwise, whichever
    // way the label moved and with no prior too (SPY's 2026-09-17 morning
    // scan, 0.0138 NORMAL after STRESS: band -0.5..1.0, 0.8929, times
    // 0.85, 0.759). The curve's 2.5 was in the prompt, not the tool; the
    // prior is not persisted; and the last digit can differ from a
    // recomputation off the rounded score.
    expect(regime).toMatch(/`confidence` \(0 to 1\) says how secure the label is, not how severe the regime: how deep the score sits inside its band, whose lower edge is the label's exit level when the label was kept and its entry level otherwise \(just entered from either direction, or no usable prior\), and whose upper edge is the next state's entry level, or the previous label's exit level when it was just entered from above \(CALM and CRISIS measure from their one edge over 1\.5\), as d, the distance to the nearer edge over half the band, through \(1 - e\^\(-2\.5 d\)\) \/ \(1 - e\^\(-2\.5\)\) \(SPY's 2026-09-17 morning scan, 0\.0138 NORMAL after the open's STRESS: band -0\.5 to 1\.0, 0\.8929, times 0\.85 for the change, 0\.759\); times the share of calibration models that succeeded raised to the power 1\.5; times 0\.85 when the label differs from its prior or had none; for the market composite's own `confidence` the share is symbols scored over symbols in the composite, and the rows of the `include_symbols` breakdown keep model coverage\. `modelCoverage` \{succeeded, attempted\} on every symbol and intraday entry is that share's numerator and denominator \(KBE 2026-09-17: 2 of 8, so 0\.25 to the 1\.5 caps its confidence at 0\.125\); the composite stores no such counts\. The prior label a row was judged against is not stored for daily rows or for intraday scans stored before the producer began recording it, so those entries do not say whether their label was kept or which prior they took \(newer intraday scans carry `priorLabel` and `priorLabelSource`\), and on the symbol and intraday scopes confidence is computed from the unrounded score, so a recomputation from the four-decimal `stressScore` can differ in the last digit \(the 2026-09-18 open scan, 1\.3496, recomputes to 0\.4295 against the stored 0\.4296\); the market composite rounds its score before computing confidence, so no such gap arises there\./);
    // review: aggregateMarket returns +stress_score.toFixed(4)
    // (regime-scorer.ts:483) and run-regime-daily.ts:682 scores confidence
    // from that, so the unrounded claim holds on symbol and intraday only.
    expect(regime).not.toMatch(/which prior it took, and confidence is computed from the unrounded score/);
    expect(regime).not.toMatch(/inside its label's band \(near 0 at a band edge\)|just entered from below|a curve that reaches 1 at the middle/);
    // The stamp is the run's start; rows land per symbol as each finishes.
    expect(regime).not.toMatch(/`scan_time`/);
    expect(regime).toMatch(/`scanTime` is the run's start; each symbol's row lands when its own calibration finishes, minutes later for a slow name, so a scan can be absent for a while after its stamp\./);
    // One exposures object, two books: the note says which fields use which;
    // the breakdown's rows carry no topStrikes and their note names none.
    expect(regime).toMatch(/`exposuresNote` on the symbol, intraday and include_symbols shapes says which fields are over the 0-60 day window and which over the whole exposure input \(the breakdown's rows carry no topStrikes, and their note names none\)\./);
    expect(regime).not.toMatch(/`exposuresNote` on the symbol and intraday shapes/);
    // Live: the per-strike sides and the window on a monthly-only name.
    const live = description('get_live_dealer_positioning');
    // review: gamma coverage is combined across the sides, so a
    // side is published only when the row's coverage is complete or empty;
    // and the route takes the broker's first four dates, so monthly
    // listings guarantee no span (09-18, 10-16, 12-18, 03-19 is six months).
    expect(live).toMatch(/Each per-strike row carries `callGex` and `putGex` beside `netGex`, the two sides the walls are chosen from, only when the row's gamma coverage is complete or empty: the coverage counts both sides together, so under partial coverage a side could be an unmeasured zero, and both sides are then null while the partial net is still published\./);
    expect(live).not.toMatch(/under the same gamma coverage\./);
    // Seventeenth run, 17:47Z on 2026-09-21: the 09-18 listing was gone and
    // 2027-01-15 was in, nearly four months; netGex read -5,013,878 with
    // walls 75 and 59 and no flip found, against 358,515, 70 and 66.68 at
    // 20:46Z on 09-18; and the 0-60 day figure on file was +184,861 for
    // 09-18 (option_ticker_snapshots.net_gex_0_60d, landed 02:34 ET on
    // 09-19) and +248,246 for 09-17. Nothing said the window rolls, or
    // that the two tools' signs can differ.
    expect(live).toMatch(/With `expiration`, every total, level and row is computed over that one listed expiration alone, which is how to see a same-day \(0DTE\) or single-week book, and `window\.expirationSelection` is "requested"; a date the broker does not list is refused with the listed ones, never replaced by the nearest; one not written YYYY-MM-DD is refused by this tool's input check before any request, and a well-formed date that is not a calendar date \(2026-02-30\) by the proxy as INVALID_EXPIRATION, before it is charged\. /);
    // The per-expiration split and the straddle (expirationBreakdown.ts).
    expect(live).toMatch(/`shareOfGrossGex`, its share of the window's gross gamma, published only when every expiration's gamma coverage is complete/);
    // review: the helper takes the nearest strike listed on BOTH
    // sides (calls 100 and 105, puts only 105, spot 100: 105), and the sides
    // rule sits in the per-strike sentence after this one.
    expect(live).toMatch(/Its `expectedMove` is the at-the-money straddle: the call and put midpoints at the strike nearest spot that lists both a call and a put \(ties to the lower strike\)/);
    expect(live).toMatch(/never read from a strike farther than that one, a mark or a last trade\./);
    expect(live).toMatch(/An expiration the broker answered with no options has unknown coverage, its values are null and no expiration gets a share\./);
    expect(live).not.toMatch(/per-strike rule below|listed strike nearest spot|never read from a farther strike/);
    // proxy/lib/liveEventCalendar.ts: earnings on file once known, mostly
    // operating companies; nothing excludes a fund (ECC, a closed-end fund,
    // has 2026-11-17 on file). SPY's 2026-09-18 ex-date reached
    // stock_dividends on 09-19 and was never in dividend_calendar, so no
    // horizon is claimed.
    expect(live).toMatch(/A null date means none ON FILE, not none scheduled: earnings are on file only once the next date is known and mostly for operating companies \(a fund or ETF usually has none, though a few carry dates\), and the time of day of an earnings release is not on file/);
    expect(live).not.toMatch(/operating companies only|a fund or ETF has none/);
    expect(live).toMatch(/Ex-dividend dates are not complete ahead of time either, and a fund's often appears only on or after the day \(SPY's 2026-09-18 ex-dividend date was not on file beforehand\), so for a fund or ETF a null says little\./);
    // A declaration dated after today does not count (liveEventCalendar).
    expect(live).toMatch(/`declared` \(false when no declaration dated on or before today is on file for it, as for a scheduled or estimated date\)/);
    expect(live).not.toMatch(/calendarThrough|CalendarCovers/);
    expect(live).toMatch(/`events` is null, here and on every entry, when the calendar could not be read; the exposure is unaffected/);
    // packages/shared/src/broker/spotSides.ts: strict split, the engine's
    // sign convention (call +1, put -1 in exposure-compute), no squeeze claim.
    expect(live).toMatch(/Each per-strike row also carries `callOpenInterest` and `putOpenInterest`, contracts summed over the window's expirations, null when the broker published no size for some leg at that strike\./);
    expect(live).toMatch(/`spotSides` splits the window at spot: `above` holds the strikes strictly above it and `below` those strictly below, and a strike exactly at spot \(`atSpotStrike`\) is in neither\./);
    expect(live).toMatch(/a partial open interest is the sum of the sizes published and is labelled partial\./);
    expect(live).toMatch(/`callOpenInterestShareAbove` is the call open interest above spot over the window's call open interest, the at-spot strike included in the whole, and is null unless every call leg's size is known\./);
    expect(live).toMatch(/These are what a squeeze argument reads, not a squeeze signal: GEX here counts call gamma as positive and put gamma as negative, the convention that dealers are long the calls and short the puts, while a squeeze reading of out-of-the-money calls assumes customers bought them and dealers are short, and open interest does not say who holds a contract\./);
    expect(live).not.toMatch(/squeeze (score|risk|probability)/i);
    expect(live).toMatch(/Without `expiration`, computed over the first four listed expirations that may still trade: from 4:15 PM New York time on an expiration day, when no expiring series trades any longer \(some expiring ETF options, including SPY, trade until then; expiring stock options stop at 4:00 in regular hours, and at 4:15 for a class Cboe trades in its curb session; PM-settled index options stop at 4:00\), that day's is left out, so after the close the window describes the next session's book \(early closes are not known here, so on those days it stays until 4:15, and it is kept if the broker lists nothing else\); name it with `expiration` to see the book as it closed\. On a name with monthly listings the window can span months \(KBE on 2026-09-18: 09-18, 10-16, 11-20, 12-18, three months; on 2026-09-21, with the 09-18 listing gone, 10-16, 11-20, 12-18, 2027-01-15, nearly four\) against the EOD tools' 0-60 days; `window\.expirations` lists them\. The window moves with the broker's list and the clock, as a listing expires or reaches 4:15 PM on its day or a nearer one is added, so two answers across such a change cover different books \(KBE at 17:47Z on 2026-09-21: netGex -5,013,878, call wall 75, put wall 59, no flip found within 20% of spot, against 358,515, 70 and a flip at 66\.68 at 20:46Z on 09-18\), and the live figure can differ in sign from the 0-60 day figure on file, a different window on a different session \(KBE: \+184,861 on file for 09-18, \+248,246 for 09-17\)\. It reflects the current session rather than the most recent session on file\./);
    expect(live).not.toMatch(/spans three months|three months\) against/);
    // And `levelStatus.gammaFlip` read "complete" beside a null flip with
    // nothing saying what the status is (each level's required coverage,
    // dealerPositioningShaping.ts measuredLevel); the walls sat at 75 and
    // 59 with the ten returned rows spanning 62 to 71, because the route
    // chooses them over every strike (exposure-compute.ts levelByStrike is
    // allStrikeMap when no wallMaxDte is passed, and live-broker.ts passes
    // none) while the rows are the nearest `strikeRange`.
    expect(live).toMatch(/`levelStatus` is each level's required coverage \(the flip's sweep coverage, `coverage\.gammaFlip`, which counts repriced and held legs alike, so it can be complete under \"frozen-gamma\" with no leg repriced; the walls', the magnet's and the concentration's net-gamma coverage\), not whether a level was found: a null `gammaFlip` beside a complete `levelStatus\.gammaFlip` is a null the route reported over complete coverage, and `coverage\.gammaFlipSearchStatus` says whether the search found no crossing or was unresolved\./);
    const liveRange = String((tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.inputSchema as Record<string, { description?: string }>).strikeRange.description);
    expect(liveRange).toMatch(/^TOTAL per-strike rows nearest spot, the cap when `strikeWindowPct` or `strikeWindowDelta` is given\. Default 10 \(150 with either\), max 150\. Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage\. The walls and the magnet are chosen over every strike in the window \(`strikes\.total` of them\), so they can sit outside the returned rows \(KBE on 2026-09-21: walls 75 and 59 with the ten default rows spanning 62 to 71\); such a level's own row is returned in `strikes\.atLevels`, naming the level, so its `callGex` and `putGex` can be checked\. Rows that would carry the answer past its 50 KB limit are dropped farthest from spot first, and `strikes\.limitedBySize` is then true\.$/);
    // The wall row travels beside the rows now (dealerPositioningShaping
    // atLevels), so "a wall with no row here has no callGex" is gone.
    expect(liveRange).not.toMatch(/a wall with no row here/);
    const windowPct = String((tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.inputSchema as Record<string, { description?: string }>).strikeWindowPct.description);
    expect(windowPct).toMatch(/^Return every strike within this percent of spot instead of a fixed count, nearest first up to `strikeRange` \(for example 10 for strikes within 10% of spot\)\. `strikes\.inWindow` counts the strikes inside the window, which exceeds `strikes\.returned` when the cap or the size limit cut it\.$/);
    expect(live).toMatch(/A row carries its `coverage` counts only when one of its statuses is not complete\./);
    // A listing added nearer than the fourth moves the window too, and a wider
    // limit returns nothing more once every strike is returned.
    expect(live).not.toMatch(/rolls when a listing expires/);
    expect(liveRange).not.toMatch(/returns more rows\./);
    // review: with null IV on every leg the flip's coverage is
    // complete and gammaFlipMethod "frozen-gamma", so no leg was repriced.
    expect(live).not.toMatch(/the flip's repriced-gamma coverage/);
    // Thirteenth run: KBE's live netCharm read +4,387,168 over 80 of 106
    // legs at 18:56Z and -2,631,616 over 70 at 19:16Z, both partial. A leg
    // enters the vanna, charm and vomma sums only while its IV passes
    // exposure-compute.ts:365 (above .01, at most 5, time left), and the
    // gamma, delta and vega sums only while that Greek is published, so
    // the summed set moves between calls and nothing names the legs.
    expect(live).toMatch(/Partial values sum only supported option legs; they are not measurements of the whole book\. A leg counts toward vanna, charm and vomma only while the broker's implied volatility for it is above 1% and at most 500% and more than a minute remains before 4:00 PM New York on its expiration day, the engine's fixed close, and toward gamma, delta and vega only while the broker publishes that Greek for it, so the included count of a partial total moves between calls, and two partial totals minutes apart can differ by which legs were summed rather than by the market \(KBE on 2026-09-18: netCharm \+4,387,168 over 80 of 106 legs at 18:56Z, -2,631,616 over 70 at 19:16Z\); the payload does not say which legs each summed\. Unmeasured or unknown values are null\. Gamma-derived levels require complete coverage\./);
    expect(live).not.toMatch(/null\.Gamma/);
    // Fourteenth run: KBE's netCharm went from -2,631,616 at 19:16Z to
    // +8,063,999 at 19:39Z over 70 of 106 legs both times, so the leg set
    // is one cause of two. The engine computes vanna, charm and vomma
    // analytically (exposure-compute.ts:365-377) from time to expiry, and
    // on an expiration day the same-day expiration sits in the window
    // until its close: through that formula a strike-66 leg with 1,000
    // open interest carries charm 3,276,453 at 44 minutes to the close
    // with spot 66.485 and 8,662 at 21 minutes with spot 66.585, against
    // about 1,500 to 2,400 for a one-month leg. And every per-strike vega
    // was identical between those two calls (different at 18:56Z), with
    // netGex 325,161 to 326,140 = (66.585/66.485)^2 exactly: the broker's
    // Greeks are an hourly snapshot the payload does not date (the
    // Tradier adapter reads greeks.delta/gamma/theta/vega/iv and drops
    // greeks.updated_at, brokerService.ts:637-640).
    // review: netGamma is Math.round-ed (exposure-compute.ts:
    // 791) so only the per-strike rows scale exactly; r, q, OI and the leg
    // set are inputs too; the route caches the expirations list 15 minutes
    // (live-broker.ts:58) with no close-time filter, and the T floor drops
    // a leg from vanna/charm/vomma at one minute, not at the close; vanna
    // and vomma do not grow toward expiry (same-day strike-66 leg, 1,000
    // OI: vanna peaks at 53,233 within cents of the strike against a
    // one-month leg's 26,865, vomma 592 against 3,154, both near zero at
    // the money), so charm is the one that can own the book.
    expect(live).toMatch(/The broker's Greeks and implied volatilities can be a snapshot older than `asOf`, which is the fetch time, and nothing in the payload dates them: Tradier's refresh about hourly \(KBE on 2026-09-18: every per-strike vega identical at 19:16Z and 19:39Z, different at 18:56Z\)\. Between refreshes the published Greeks are fixed, so with the resolved rate and yield, open interest and the summed leg set also unchanged, only spot and the clock move the totals: the per-strike gamma rows move with spot squared exactly and netGex to its rounding \(325,161 to 326,140 as spot went 66\.485 to 66\.585\)\. On an expiration day the same-day expiration is in the default window until 4:15 PM New York time, and can be named with `expiration` while the broker lists it \(Tradier still listed KBE's 2026-09-18 expiration 46 minutes after the close, and the route caches that list for 15 minutes, so it can be asked for that long after the listing ends\); its legs stay eligible for gamma, delta and vega under the engine's input checks \(a known open interest, finite and from 0 to 1e12; a finite gamma or delta of size at most 10, a finite vega of size at most 10,000; a finite contribution\), and drop out of vanna, charm and vomma a minute before 4:00 PM New York on that day, the fixed close the engine measures time to expiry to whatever the series' own close, so from then until 4:15, while such an expiration is still in the default window, those three leave its legs out\. Those three are computed from time to expiry, so on the same-day legs they change sharply with small spot moves and with the clock: charm near the money can be the largest term in the book \(a strike-66 leg with 1,000 open interest: charm 3\.3 million at 44 minutes to the close with spot 66\.485, 8,662 at 21 minutes with spot 66\.585; a one-month leg with the same open interest, in the low thousands\), and its vanna changes sign at the price where d2 is zero, 66\.0001 in the example \(higher implied volatility raises this crossing price\)\. On an expiration afternoon netCharm can be mostly the same-day legs and the clock \(KBE 2026-09-18: -2,631,616 at 19:16Z, \+8,063,999 at 19:39Z, over 70 of 106 legs both times\)\./);
    expect(live).not.toMatch(/grow without bound|in the window until its close|only spot and the clock move the totals, and netGex|netVanna, netCharm and netVomma are dominated/);
    // review: "vomma stays smaller" fails pointwise (spot
    // 66.13: same-day -319.96 against +1.52 for 30 days) and by grid
    // maximum at IV 1.0 (178.34 against 152.88), and "count for as long
    // as the broker publishes" outran observedLegOi (four legs with
    // published Greeks and null OI: coverage 0/4, totals null).
    expect(live).not.toMatch(/vomma stays smaller|at a size comparable to a longer-dated leg's|for as long as the broker publishes those Greeks/);
    // review: "within cents of the strike" is the 30%-IV
    // example (K 6000, IV 3, 44 minutes: $2.25 away), and "the coverage
    // checks above" named checks no earlier sentence states
    // (exposure-compute.ts:196-235: OI known and 0..1e12, |gamma| and
    // |delta| <= 10, |vega| <= 1e4, a finite contribution).
    expect(live).not.toMatch(/within cents of the strike|subject to the coverage checks above/);
    // review: the crossing K*exp(-(r - q - iv^2/2)T) rises
    // with IV throughout, but sits below the strike while iv^2/2 < r - q
    // and so moves TOWARD it first (IV 0.10 to 0.20: 65.99991552 to
    // 65.99999834); "farther" held only past IV ~0.2015.
    expect(live).not.toMatch(/farther from the strike at high implied volatility/);
    // Fifteenth run, 20:05Z on expiration day: the flip read 64.75 against
    // 65.56 at 19:39Z on the same broker snapshot (per-strike rows scaled by
    // (66.62/66.585)^2 exactly), and gammaFlipResolution came back as
    // exactly spot x 0.0002 where earlier values were irregular. The sweep
    // reprices each leg at its time to expiry floored at one minute
    // (observedFlipInput: yte floored by computeYearsToExpiration is still
    // > 0, so haveTime holds after the close), and the scan's step starts
    // at spot x 5e-6, grows 1% a sample and caps at spot x 0.0002 after 371
    // samples, 1.955% from spot (observed-gamma-flip.ts:19-23, :303): the
    // 19:39Z flip sat 1.54% out, the 20:05Z one 2.81%.
    expect(live).toMatch(/Named after the close, the expired legs are inside the totals and the levels, and `window\.expirations` beside `asOf` is the only sign of it\. The flip sweep reprices each leg from its implied volatility at its time to expiry floored at one minute, so on an expiration day the same-day legs' repriced gamma narrows onto their strikes through the afternoon and holds the one-minute shape after the close, and the flip moves with the clock \(KBE 2026-09-18: 65\.56 at 19:39Z, 64\.75 at 20:05Z, on one broker snapshot, spot 66\.585 to 66\.62\)\./);
    // review: the width is max(step, |sample - anchor|) at the
    // bracket (:281), clipped at the 20% edge (flip 120 at spot 100:
    // 0.0046, not 0.02), widened by zero-valued samples (a fixture: 0.04),
    // and about twice the first step for a crossing at spot (:290).
    expect(live).toMatch(/`coverage\.gammaFlipResolution` is the width of the bracket the sign change was found in, not a confidence interval or an error bound\. The search steps out from spot in samples starting at 0\.0005% of spot, growing 1% a sample to a cap of 0\.02% of spot from about 2% out, and the width is usually that step \(a flip beyond about 2% out usually reads spot times 0\.0002\), wider when zero-valued samples sat between the two signs, narrower at the 20% search edge, and about twice the first step for a crossing at spot itself\. The reported flip is the nearest crossing detected by that search, and the resolution is null when no level is reported\./);
    expect(live).not.toMatch(/reports exactly spot times 0\.0002/);
    expect(live).not.toMatch(/not a confidence interval or an error bound\. The reported flip/);
    // And the EOD tool says which not-found is final. review:
    // "today or later" left the session BEFORE its import (00:30 EDT the
    // next day) reading "Retrying will not succeed.", and the description's
    // "final ... though ... a late import" qualified a promise the response
    // text still made. The cutoff is the clock now, 09:30 New York on the
    // next calendar day, and it is this tool's: review showed
    // the producer has no deadline (the regime retry loop's four hours are
    // waits, not a bound; eight simulated 20-minute catch-up imports
    // reached 08:40 ET, past the 08:00 that commit called the window's
    // end), and that a failed exposure computation leaves the import
    // "success" with no re-attempt, so the file "appears when it is" re-run
    // was a promise too. The summaries landed 02:31-02:34 ET for every
    // session 2026-09-08 to 09-17; the import is scheduled 01:00 ET.
    const eod = description('get_dealer_positioning');
    expect(eod).toMatch(/A not-found for a weekday date inside that window is not final until 09:30 US Eastern on the following calendar day, and is marked retryable until then\. That cutoff is this tool's, not a deadline of the producer's, which has none: the import is scheduled for 01:00 US Eastern, retried in half-hour steps to about 06:00, and runs later when it has days to catch up\. If that date is a trading session its file usually lands about 02:30 US Eastern the next day \(02:31 to 02:34 for every session from 2026-09-08 to 09-17\), so before then it is usually not on file yet; a market holiday, a futures contract or a name with no near-term options stays not-found, and this tool cannot tell those apart from the date alone\. After the cutoff the response is the proxy's answer for any absent row and says retrying will not succeed; that is the proxy's flag for a row absent on the normal schedule, not a promise that the file can never arrive: a session whose import or exposure computation failed can appear after a later successful import or repair, and nothing here says whether one is coming\./);
    expect(eod).toMatch(/The equity import is scheduled for 01:00 US Eastern the next day and usually lands about 02:30, so in the evening the most recent on file is usually the previous session, and it can be older when an import is late\./);
    // proxy/routes/eod.ts readPriorSession + tradingSessionsBetween; the grid
    // is pinned against proxy/lib/exposure-compute.ts in proxy/routes/eod.test.ts.
    expect(eod).toMatch(/`sincePriorSession` compares this session with the one before it on file, from the same stored end-of-day computation over the same 0-60 day window: `prior` holds that session's levels, `change` this session minus that one \(null where either is missing\), and `dealerRegimeChanged` whether the regime differs\./);
    expect(eod).toMatch(/`sessionsSkipped` counts the NYSE sessions between `priorDate` and `date`, none of which has a summary on file: 0 means no session falls between the two, and more means the change spans that many more sessions\./);
    expect(eod).toMatch(/Both flips are found on a grid of 60 prices within 20% of each session's spot, about 0\.68% of spot apart and re-centred every session, so a flip change smaller than that step can come from the grid rather than the market\./);
    expect(eod).toMatch(/`status` is "none-on-file" when no earlier session has a summary and "unavailable" when it could not be read, and this session's values are unaffected either way\./);
    expect(eod).toMatch(/It is a close-to-close change on file, not a change to now: the live book comes from get_live_dealer_positioning, over a different window and computation, and differencing the two is not a change\./);
    // Seventeenth run: the window admits tomorrow's date, and "was a trading
    // session" read wrong for it (2026-09-22 asked for at 13:47 ET on 09-21).
    expect(eod).not.toMatch(/was a trading session/);
    expect(eod).not.toMatch(/today or later in New York is not final|For an earlier date a not-found is final|says the file is not on file yet|the end of the overnight import window|is re-run later, and the session appears|until 08:00 US Eastern/);
    // Sixteenth run: next Monday and next Sunday both got the proxy's
    // window rejection, "date must fall inside the available data window
    // 1990-01-01..2026-09-19. Retrying will not succeed.", and the
    // description named no window (proxy/routes/eod.ts
    // EOD_EXPOSURE_DATE_BOUNDS: min 1990-01-01, one day past the current
    // UTC date, moving with it).
    expect(eod).toMatch(/`date` is accepted from 1990-01-01 to one day past the current UTC date, the proxy's window, which moves forward with the date; a later weekday date is rejected as INVALID_REQUEST until the window reaches it, marked retryable with the UTC day it can be asked for from, and a later weekend date keeps the rejection as final, since it is never a session\./);
    expect(eod).toMatch(/A not-found for a weekday date inside that window is not final until 09:30 US Eastern/);
    const eodDate = String((tools.find((t) => t.name === 'get_dealer_positioning')!.config.inputSchema as Record<string, { description?: string }>).date.description);
    expect(eodDate).toMatch(/^Session date in YYYY-MM-DD, from 1990-01-01 to one day past the current UTC date \(a later date is rejected until the window reaches it\)\. Defaults to the most recent session on file, whatever its date; read `date` in the result\.$/);
    // And the live tool: the broker refreshed its Greeks AFTER the close
    // (every per-strike vega changed between the 20:05Z snapshot and 20:46Z
    // with spot 66.62 both times; netGex 326,483 to 358,515, the call wall
    // 66 to 70, the flip 64.75 to 66.68), which the "clock, not the market"
    // sentence did not cover, and Tradier still listed the same-day
    // expiration 46 minutes after the close, past the 15-minute cache.
    expect(live).toMatch(/so the repriced flip and the time-sensitive totals drift a little between calls with no new quotes; that is the clock, not the market\. The broker can also refresh its Greeks after the close, and a refresh can move the levels and totals at unchanged spot \(KBE on 2026-09-18 at 20:46Z against the 20:05Z snapshot, spot 66\.62 both times: every per-strike vega changed, netGex 326,483 to 358,515, the call wall 66 to 70, the flip 64\.75 to 66\.68\), so a change after hours can be a refresh rather than the market, and the payload does not say which\. /);
    // review: doubling every published gamma at unchanged spot
    // and IV doubled net gamma and left every level identical, so a refresh
    // "moves" the levels was an overclaim; "can move" is the computation.
    expect(live).not.toMatch(/a refresh moves the levels/);
    expect(live).toMatch(/On an expiration day the same-day expiration is in the default window until 4:15 PM New York time, and can be named with `expiration` while the broker lists it \(Tradier still listed KBE's 2026-09-18 expiration 46 minutes after the close, and the route caches that list for 15 minutes, so it can be asked for that long after the listing ends\); its legs stay eligible/);
    expect(regime).not.toMatch(/on the market scope the share is symbols scored/);
  });

  test('the live chain tool declares that it reaches an external system', () => {
    // openWorldHint is false on every tool that reads our own stored data.
    // This one calls the user's broker, and a client deciding whether to
    // confirm a call needs to know the difference.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const live = tools.find((t) => t.name === 'get_live_options_chain');
    expect((live!.config.annotations as Record<string, unknown>).openWorldHint).toBe(true);
    expect((live!.config.annotations as Record<string, unknown>).readOnlyHint).toBe(true);
    // No `full`: it would be an unbounded live broker call.
    expect(Object.keys(live!.config.inputSchema as object)).not.toContain('full');
  });

  test('live dealer positioning takes a delta band, strictly inside 0 to 0.5, and refuses it beside a percent window before any request', async () => {
    const requests: Array<{ path: string; params?: Record<string, string> }> = [];
    const byStrike = [118, 120, 140].map((strike) => ({
      strike, netGamma: 1, callGamma: 1, putGamma: 0, netDelta: 1, netVega: 1,
      coverage: { gamma: { total: 2, included: 2 }, delta: { total: 2, included: 2 }, vega: { total: 2, included: 2 } },
      deltasByExpiration: [{ expiration: '2026-10-16', call: strike === 140 ? 0.03 : 0.5, put: strike === 140 ? -0.97 : -0.5 }],
    }));
    const recording = {
      get: async (path: string, params?: Record<string, string>) => {
        requests.push({ path, params });
        return { symbol: 'SPY', expirations: ['2026-10-16'], snapshot: { spotPrice: 120 }, byStrike };
      },
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), recording);
    const tool = tools.find((t) => t.name === 'get_live_dealer_positioning')!;

    const schema = (tool.config.inputSchema as Record<string, any>).strikeWindowDelta;
    for (const ok of [0.01, 0.1, 0.49]) expect(schema.safeParse(ok).success, String(ok)).toBe(true);
    for (const bad of [0, 0.5, 0.6, -0.1]) expect(schema.safeParse(bad).success, String(bad)).toBe(false);

    const banded: any = await tool.handler({ symbol: 'spy', strikeWindowDelta: 0.1 });
    // The band only chooses rows: the request is the same as without it.
    expect(requests).toEqual([{ path: '/live/exposure/SPY', params: {} }]);
    expect(banded.structuredContent.strikes).toMatchObject({ deltaBand: 0.1, inWindow: 2, returned: 2 });

    // The echoes are the values the rows were chosen with, not rounded to 15
    // digits: 0.10000000000000002 keeps no strike at 0.1, and 0.1 would.
    const offGrid: any = await tool.handler({ symbol: 'spy', strikeWindowDelta: 0.10000000000000002 });
    expect(offGrid.structuredContent.strikes.deltaBand).toBe(0.10000000000000002);
    const near: any = await tool.handler({ symbol: 'spy', strikeWindowDelta: 0.49999999999999994 });
    expect(near.structuredContent.strikes.deltaBand).toBe(0.49999999999999994);
    const pct: any = await tool.handler({ symbol: 'spy', strikeWindowPct: 14.285714285714286 });
    expect(pct.structuredContent.strikes.windowPct).toBe(14.285714285714286);

    requests.length = 0;
    const both: any = await tool.handler({ symbol: 'spy', strikeWindowDelta: 0.1, strikeWindowPct: 5 });
    expect(both.isError).toBe(true);
    expect(both.structuredContent).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(both.content[0].text).toContain('strikeWindowDelta or strikeWindowPct, not both');
    expect(requests).toEqual([]);
  });

  test('EOD dealer positioning publishes every number at 15 significant digits, as the live tools do', async () => {
    // SPY on 2026-09-29, the values the thirty-first run read with binary
    // noise; the changes now arrive exact from the proxy (eodExposure.ts).
    const recording = {
      get: async () => ({
        schemaVersion: 1, symbol: 'SPY', date: '2026-09-29', asOf: '2026-09-29T21:40:00Z',
        source: 'eod_options_snapshot', dteWindow: { minDte: 0, maxDte: 60, unit: 'calendar_days' },
        spotPrice: 764.03, netGex: -10894620007, netDex: 16246461968,
        gammaMagnet: 761, gammaFlip: 771.58, callWall: 765, putWall: 765, dealerRegime: 'negative_gamma',
        expectedMovePct30d: 0.03882885235, expectedMove30d: 29.666368063999997,
        topContributingStrikes: [{ strike: 765, netGex: -1597560842.5686889, netDex: 1234.5678901234567 }],
        topContributingStrikesLimit: 10,
        sincePriorSession: {
          status: 'found', priorDate: '2026-09-28', sessionsSkipped: 0, dealerRegimeChanged: false,
          prior: { spotPrice: 765.54, netGex: -8801431612, netDex: 11348727140, gammaFlip: 772.75, callWall: 785, putWall: 765, gammaMagnet: 765, dealerRegime: 'negative_gamma' },
          change: { spotPrice: -1.51, netGex: -2093188395, netDex: 4897734828, gammaFlip: -1.17, callWall: -20, putWall: 0, gammaMagnet: -4 },
        },
      }),
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), recording);
    const result: any = await tools.find((t) => t.name === 'get_dealer_positioning')!.handler({ symbol: 'spy' });
    const out = result.structuredContent;
    expect(out.sincePriorSession.change).toMatchObject({ spotPrice: -1.51, gammaFlip: -1.17, netGex: -2093188395, callWall: -20 });
    expect(out.expectedMove30d.absolute).toBe(29.666368064);
    expect(out.topContributingStrikes[0]).toMatchObject({ netGex: -1597560842.56869, netDex: 1234.56789012346 });
    // Whole numbers and decimals already within 15 digits pass unchanged.
    expect(out).toMatchObject({ netGex: -10894620007, spotPrice: 764.03, gammaFlip: 771.58 });
    expect(result.content[0].text).not.toMatch(/\d{16,}/);
    const text = tools.find((t) => t.name === 'get_dealer_positioning')!.config.description as string;
    expect(text).toContain('Every number goes out at 15 significant digits at most, which drops binary noise such as 29.666368063999997 in the derived `expectedMove30d.absolute` (published as 29.666368064), while a whole number such as `netGex` and a decimal stored with 15 or fewer digits pass unchanged; each `sincePriorSession.change` is computed as the exact difference of the two stored values (764.03 against 765.54 is -1.51, not the binary -1.509999999999991) and then published under the same 15-digit rule, so a difference needing more digits (10000000000.01 against 0.00001) is rounded like any other number.');
  });

  test('the all-expiration and 0-60 day exposure tools each say the other window exists and can differ in sign', () => {
    // SPY 2026-09-29: net_dex -16.8B over all expirations, +16.2B over 0-60
    // days, the same engine and convention; read as a sign bug in the
    // thirty-third run.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = (name: string) => tools.find((t) => t.name === name)!.config.description as string;
    const sign = 'Long-dated contracts carry large delta, so the two can differ even in sign (SPY 2026-09-29: net DEX -16,795,316,756 over all expirations against +16,246,461,968 over 0-60 days)';
    for (const name of ['get_options_snapshot', 'get_options_analytics_history', 'get_dealer_positioning']) {
      expect(text(name), name).toContain(sign);
    }
    expect(text('get_options_analytics_history')).toContain('The GEX and DEX here are over ALL expirations on file, while get_dealer_positioning reports the 0-60 day window');
    expect(text('get_dealer_positioning')).toContain('get_options_snapshot and get_options_analytics_history report net GEX and DEX over ALL expirations');
  });

  test('platform info states the live chain budget in the broker\'s own requests, as the tool does', async () => {
    // It said "capped at 10 requests/minute" (thirty-third run); the limit is
    // 10 weighted units a minute shared by the live tools, a chain costing 1.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const info: any = await on.tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'capabilities' });
    const text = String(info.structuredContent.text);
    expect(text).not.toMatch(/requests\/minute/);
    expect(text).toContain("It spends the user's own broker quota, metered in the broker's own requests (a chain is 2 on Tradier and Public, 1 on Schwab, 2 plus one per 100 listed contracts on tastytrade, counted across every root before they merge) against the broker's own quota (120 a minute on Tradier, Schwab and tastytrade, 600 on Public) shared with the other live tools, so prefer it when the question is about current or intraday prices, and the end-of-day tools otherwise.");
    expect(text).not.toMatch(/weighted unit|10-unit/);
  });

  test('analyst data says how its estimates and rating streaks are ordered', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_analyst_data')!.config.description as string;
    expect(text).toContain('`estimates` lists forward periods first, soonest first, then past periods newest first, so the nearest forward periods are the ones kept');
    expect(text).toContain('Each rating streak runs from `fromDate`, its oldest observation, through `throughDate`, its newest, and the streaks are newest first.');
    // Phase D1: the analysts' counts and the targets, and the model grade named for what it is.
    expect(text).toContain('`ratingCounts` is how many analysts rate the stock strong buy, buy, hold, sell and strong sell in the newest monthly count, with its `month` and `total`; it is given only while that month is at most two months back');
    expect(text).toContain('`ratingSnapshot` and the `historicalRating` streaks are a quantitative model grade from six valuation and financial measures, each scored 1 to 5, not analysts\' ratings.');
    expect(text).toContain('the year\'s whole count only when `countComplete` (the list on file reaches back past the year; otherwise the year holds at least that many)');
    expect(text).toContain('`priceTargets` is null, with `priceTargetsNote`, when individual targets have not been fetched yet.');
  });

  test('the live chain says spot is each broker\'s own and can differ by broker', () => {
    // Thirty-third run: tastytrade and Public 764.8 against Tradier and
    // Schwab 762.63 after the close, and nothing said why.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_live_options_chain')!.config.description as string;
    expect(text).toContain("`spotPrice` is the broker's own price for the underlying (Tradier's and tastytrade's last trade, or their close when the quote has no last; Public's last trade; Schwab's underlying price, else its last or its mark), and outside regular hours a broker's last can include extended-hours trades, so brokers can report different spots for the same moment (SPY on 2026-09-30 after the close: 764.81 tastytrade, 764.79 Public, 762.63 Tradier and Schwab), and each broker's moneyness and Greeks follow its own; open interest can also differ by broker.");
  });

  test('short data says its full mode is the raw payload, compact dates and string numbers included', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const shape = (tools.find((t) => t.name === 'get_short_data')!.config.inputSchema as Record<string, any>).full;
    expect(shape.description).toBe('Return the raw FINRA payload instead of the compact summary, as the proxy sends it: dates as FINRA writes them (YYYYMMDD) and some numbers as strings. The compact summary publishes YYYY-MM-DD dates and numbers.');
  });

  test('stock prices says what confirmed and historyState mean', () => {
    // Thirty-third run: every SPY bar read confirmed:false with nothing saying
    // that is the state before a verified snapshot exists.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_stock_prices')!.config.description as string;
    expect(text).toContain('Each bar\'s `confirmed` is true when a verified price-history snapshot stands behind it and false when none does yet, which is the case for most symbols until their history has been verified; the price is the stored price either way, and `unconfirmedSessions` counts the false ones. It is null for an index, future or crypto symbol, which carry no confirmation, and for every bar when the symbol\'s history state could not be read (`historyState` null), which means unknown, not unconfirmed. `historyState` is "current", "pending_split" (a split is due and its refresh has not run, so bars before it may be on the pre-split scale), "held" (the price history is held for review) or "not_applicable" (null when it could not be read), with `historyNote` explaining the two that need it.');
  });

  test('the portfolio snapshot says its delta is unweighted and how dollarDelta differs', () => {
    // Thirty-third run: delta +118.1 beside dollarDelta -26,833 read as a
    // contradiction, and the text claimed the Greeks carried no dollar values.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_snapshot')!.config.description as string;
    expect(text).not.toContain('(no $)');
    expect(text).toContain("Its `delta` is the share-equivalent delta summed across every underlying with no price weighting, while `details.greeks.dollarDelta` (and `dollarGamma`) weights each position by its own underlying's price, so the two can differ in size and even in sign when positions span underlyings priced far apart (a short index position beside long shares of a low-priced stock).");
  });

  test('the snapshot tool says the strategy type holds definitions only and points at compute_scenario', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_snapshot')!.config.description as string;
    expect(text).toContain('type="strategy"');
    expect(text).toContain('Definitions only, never computed outputs: price or stress one with compute_scenario by its `strategyKey`');
    expect(text).toContain('Send to assistant');
    expect(text).toContain('the rate and the dividend yield each with where the page got it and the Treasury series the rate matched (`rateSeries`, the shortest option leg\'s tenor)');
  });

  test('FFT results say their Greeks are raw per-share values with annual theta', () => {
    // Thirty-third run: long-option theta read +141.92 and was taken for a
    // sign bug; it is computeFFTGreek's raw annual derivative, only explained
    // in get_platform_info.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_fft_results')!.config.description as string;
    expect(text).toContain("Each position's per-model Greeks are the pricer's raw output for one share of one contract, not sized by quantity or the 100 multiplier and not signed by long or short: delta and gamma as usual, vega and rho per 1.00 change (100x a per-1% figure), and theta per year in the mathematical direction, the opposite sign of the usual daily decay figure: the web app's equity convention divides by 252 trading days and flips the sign, so 141.92 per year is about -0.56 a day (usually positive for a long option, though not always: a deep in-the-money put can be negative).");
    expect(text).toContain("For Heston and Bates, vega is the sensitivity to the starting volatility only, a different quantity from the other models' vega, so the two are not comparable and either can be the larger. A model marked actionable false (calibrationStatus and qualityReasons say why, e.g. calibration_failed) priced from default parameters after its calibration failed: its price and signal are shown but are not counted in the position's agreement or average model price, and its Greeks can be empty. Positions saved before 2026-10-01 carry no such mark, and their agreement and average can include such a model.");
  });

  test('the compute, live-chain and risk tools say what a reviewer misread', () => {
    // A tester took a Heston "success" with 0% inside bid/ask and a count of 6
    // models beside 5 outcomes for defects, identical call and put theta for a
    // shaping bug, and a rejected stress row (+7,057 at -10%) for a risk result.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => tools.find((t) => t.name === name)!.config.description as string;
    expect(description('get_compute_runs')).toContain("A calibration status of success means the model produced usable fitted parameters; how well they fit is in its confidence and warnings, so a success can carry a warning such as few prices staying within bid/ask. calibratedModelCount counts the models carrying a calibration, including MonteCarlo-Heston, which reuses Heston's fit and has no calibration outcome of its own, so it can exceed the number of outcomes.");
    expect(description('get_live_options_chain')).toContain("A broker's Greeks can be a snapshot it refreshes about hourly rather than a figure from the quote beside them, and such a snapshot can carry one theta for the call and the put at a strike. Tradier publishes no mark, so its `mark` is always null.");
    expect(description('get_live_options_chain')).toContain("Some ETF options, SPY's included, quote until 4:15 PM New York time, so between 4:00 and 4:15, and on the quotes held after, put-call parity can imply an underlying away from `spotPrice`.");
    expect(description('get_snapshot')).toContain('A figure or stress row with contractStatus "rejected" (calculationAccepted false) is display-only, whether its inputs were fallback or degraded or they changed after it was computed (a stale_snapshot reason); its displayReasons say which. It is not a valid risk result, so report it as unavailable, not as the portfolio\'s risk.');
  });

  test('the analysis tools say which Analysis page models are recorded', async () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => tools.find((t) => t.name === name)!.config.description as string;
    const recorded = 'Only calibrated models (Heston, SABR, jump diffusion, Variance Gamma, Dupire local volatility) and standard Monte Carlo runs are recorded; a Black-Scholes, Black76, Binomial, PDE or exotic-payoff calculation is not, and compute_black_scholes prices one on demand.';
    expect(description('get_analysis_history')).toContain(recorded);
    expect(description('query_analysis')).toContain(recorded);
    const jumpModels = "A newer jump-diffusion record names its jump model, as Jump Diffusion (Merton), (Kou), (Bates) or (Variance Gamma), and a newer record's calibrationSummary.params holds only the model's fitted parameters; an older one shows plain Jump Diffusion, and its params can also list pricer settings or other jump models' defaults. The model filter matches every jump model, so read the label.";
    expect(description('get_analysis_history')).toContain(jumpModels);
    expect(description('query_analysis')).toContain(jumpModels);
    expect(description('get_analysis_rollups')).toContain('Rollups count only what the Analysis page records: calibrated models and standard Monte Carlo.');
    const { tools: infoTools, server: infoServer } = captureRegisteredTools();
    registerPlatformInfo(infoServer as any);
    const capabilities = await infoTools[0].handler({ topic: 'capabilities' });
    expect(capabilities.content[0].text).toContain('local pricing-analysis history (calibrated models and standard Monte Carlo only)');
  });

  test('regime fits say what paramsAtBounds means', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_regime_fits')!.config.description as string;
    expect(text).toContain("Each model's `paramsAtBounds` names the parameters its latest fit finished exactly on an optimizer bound: such a parameter may be held there by the bound rather than set by the market, so treat it with caution even when `failedQualityCheck` is false (SPY's Kou p at 0.05 and eta1 at 30 on 2026-09-30). It records where the fit finished, not how it got there: a parameter can also finish on a bound it started at. An empty list means none, and null means the fit did not report it: only Merton, Kou and Bates fits report bounds, so it is always null for the other five models, and for Merton, Kou and Bates fits recorded before their calibration did.");
  });

  test('live dealer positioning says what each of its three strike counts counts', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.description as string;
    expect(text).toContain('Three strike counts differ by what they count: `window.strikesUsed` is the strike rows the broker returned, one per strike per expiration; `coverage.strikes` is those rows with at least one leg not known to have zero open interest, the rows that enter the totals; and `strikes.total` is the distinct strikes among them, the strikes the per-strike rows are chosen from (SPY over four expirations on 2026-09-30: 796, 762 and 326).');
  });

  test('a structured proxy error reaches the model with its recovery fields', async () => {
    // THE WHOLE MECHANISM. toolHandler's ApiError branch emitted only the
    // message, so `retryable` never arrived - and a model facing a dead broker
    // credential retried, spending the user's own broker quota on a call that
    // could never succeed. Driven through the REGISTERED tool, because a
    // client-only test cannot see what the handler drops.
    const { tools, server } = captureRegisteredTools();
    const failing = {
      get: async () => {
        throw new LiveApiError(
          'tradier rejected the stored credential', 400, 'BROKER_CREDENTIAL_INVALID',
          false, 'https://x/account?tab=broker', undefined,
        );
      },
    } as any;
    registerAllTools(server as any, stubClient(), stubTokens(), failing);
    const live = tools.find((t) => t.name === 'get_live_options_chain')!;

    const result: any = await live.handler({ symbol: 'SPY' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'BROKER_CREDENTIAL_INVALID',
      retryable: false,
      actionUrl: 'https://x/account?tab=broker',
    });
    // Repeated in the text, because not every client reads structuredContent.
    expect(result.content[0].text).toContain('Retrying the same request will not succeed');
    expect(result.content[0].text).toContain('https://x/account?tab=broker');
  });

  test('an unlisted expiration reaches the model with the dates that would work', async () => {
    const { tools, server } = captureRegisteredTools();
    const failing = {
      get: async () => {
        throw new LiveApiError(
          'Expiration 2026-09-19 is not listed for SPY', 400, 'UNKNOWN_EXPIRATION',
          false, undefined, { availableExpirations: ['2026-09-18', '2026-09-25'] },
        );
      },
    } as any;
    registerAllTools(server as any, stubClient(), stubTokens(), failing);
    const live = tools.find((t) => t.name === 'get_live_options_chain')!;
    const result: any = await live.handler({ symbol: 'SPY', expiration: '2026-09-19' });
    expect(result.structuredContent.availableExpirations).toEqual(['2026-09-18', '2026-09-25']);
    // And in the TEXT, for clients that render nothing else: the code too,
    // and a full stop between the upstream message and the guidance. A client
    // rendering text alone was shown "...for SPY Retrying will not succeed."
    // and never the code UNKNOWN_EXPIRATION that was in structuredContent.
    expect(result.content[0].text).toBe(
      'API error (UNKNOWN_EXPIRATION): Expiration 2026-09-19 is not listed for SPY. Retrying the same request will not succeed. availableExpirations: 2026-09-18, 2026-09-25.',
    );
  });

  for (const status of [400, 422]) {
    test(`a ${status} Zod validation response reaches the registered tool without code or retryable`, async () => {
      // A body carrying Zod's issue objects, without code or retryable at the
      // top level. The proxy's own zod hook answers only the first message,
      // so this is the shape a body MAY carry, not the usual one; the client
      // must still pass it through. Exercise both HTTP parsing and the tool.
      const validation = z.object({
        symbol: z.string().refine((value) => /^[A-Z0-9./-]+$/.test(value), 'symbol contains unsupported characters'),
      }).safeParse({ symbol: 'BAD%' });
      if (validation.success) throw new Error('Expected invalid symbol fixture');
      globalThis.fetch = (async () => new Response(JSON.stringify({
        error: 'Validation failed', issues: validation.error.issues,
      }), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
      const dataClient = new LiveApiClient('https://proxy.example.com', stubTokens());
      const { tools, server } = captureRegisteredTools();
      registerAllTools(server as any, stubClient(), stubTokens(), dataClient);

      const result = await tools.find((tool) => tool.name === 'get_live_options_chain')!
        .handler({ symbol: 'BAD%' });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        dataAvailable: false,
        error: 'Validation failed',
        issues: [{ path: ['symbol'], message: 'symbol contains unsupported characters' }],
      });
      expect(result.structuredContent.code).toBeUndefined();
      expect(result.structuredContent.retryable).toBeUndefined();
      expect(result.content[0].text).toContain('symbol: symbol contains unsupported characters');
      expect(result.content[0].text).not.toContain('[object Object]');
    });
  }

  test('platform info describes the four proxy-backed tools and names their overlaps', async () => {
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const onInfo: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'capabilities' });
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes', 'get_live_quote', 'get_intraday_bars', 'compute_scenario', 'rank_live_skew_gex']) {
      expect(onInfo.structuredContent.text, name).toContain(name);
    }
    // The tier is named per tool, and it is Pro, not the API tier.
    expect(onInfo.structuredContent.text).toContain('(Pro and above)');
    expect(onInfo.structuredContent.text).not.toContain('API tier');
    expect(onInfo.structuredContent.text).not.toContain('/v1 data API');
    // No MCP session is on the free tier: TokenManager.initialize refuses to
    // start without entitlement and the OAuth handoff gates the same way.
    // "Every tier" described the proxy route, not who can call the tool from
    // here. But entitlement is NOT only a subscription: developer and comped
    // (bypassSubscription) accounts initialize with `subscription: null` and
    // pass the proxy's Pro gate, so the text names the check, not one way of
    // passing it, and marks the EOD tools by the requirement they lack.
    expect(onInfo.structuredContent.text).not.toContain('every tier');
    expect(onInfo.structuredContent.text).toContain('entitlement check');
    expect(onInfo.structuredContent.text).toContain('comped');
    expect(onInfo.structuredContent.text).not.toMatch(/every MCP session (?:already )?holds an active subscription/);
    expect(onInfo.structuredContent.text).toContain('(no Pro requirement)');
    // "Last-close" was the same overclaim as "last completed session": the
    // store holds the most recent session on file, which after a close and
    // before the import is the previous one.
    expect(onInfo.structuredContent.text).not.toMatch(/last-close|last close/);
    expect(onInfo.structuredContent.text).toContain('most recent session on file');
    // The overlaps are named, so a model is not left guessing which of two
    // similarly-named tools answers the question it was actually asked.
    expect(onInfo.structuredContent.text).toContain('Distinct from get_snapshot');
    expect(onInfo.structuredContent.text).toContain('Distinct from get_regime,');
    // And in the combined view a model is most likely to request.
    const onAll: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'all' });
    expect(onAll.structuredContent.text).toContain('get_live_options_chain');
  });

  test('the analytics history names the expected move by its unit on every response path', async () => {
    // The summarizer only runs past 90 rows. A one-row answer and a `full`
    // answer both went out with expected_move_pct: 0.018 and no units.
    const canned = { symbol: 'SPY', data: [{ date: '2026-09-15', spot_price: 650.12, expected_move_pct: 0.018 }] };
    const client = { get: async (path: string) => (path === '/history' ? structuredClone(canned) : {}), post: async () => ({}) } as any;
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, client, stubTokens(), stubClient());
    const history = on.tools.find((t) => t.name === 'get_options_analytics_history')!;
    for (const args of [{ symbol: 'SPY', days: 30 }, { symbol: 'SPY', days: 30, full: true }, { symbol: 'SPY', from: '2026-09-15', to: '2026-09-15' }]) {
      const text = JSON.stringify(await history.handler(args));
      // Field names are camelCase on the wire (the sanitizer converts the
      // shaper's expected_move_30d_fraction).
      expect(text, JSON.stringify(args)).toContain('"expectedMove30dFraction":0.018');
      expect(text, JSON.stringify(args)).not.toContain('expected_move_30d_fraction');
      expect(text, JSON.stringify(args)).not.toContain('expected_move_pct');
      expect(text, JSON.stringify(args)).toContain('decimal fraction of spot');
      expect(text, JSON.stringify(args)).toContain('expectedMove30dFraction on each point');
    }
    const described = String(history.config.description);
    expect(described).toContain('the 30-day expected move (`expectedMove30dFraction`, a decimal fraction of spot: 0.018 = 1.8%)');
    expect(described).not.toContain('expected_move_30d_fraction');
    {
    }
  });

  test('the IV and Greeks histories carry the proxy provenance once, on every path', async () => {
    // Twenty-first run: get_iv_history carried the same provenance block at
    // the top level, under `metadata` and under `provenance`; the analytics
    // history collapsed it already (collapseProvenance), these two did not.
    const prov = { provider: 'supabase', source: 'scanner_history', historySnapshotId: 'h1', fetchedAt: '2026-09-22T20:00:00.000Z', receivedAt: '2026-09-22T20:00:00.000Z', fromCache: false };
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ market_date: `2026-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, atm_iv: 0.2, spot_price: 500 }));
    const canned = (n: number) => ({ symbol: 'SPY', data: rows(n), ...prov, metadata: { ...prov }, provenance: { ...prov } });
    for (const [tool, args, n] of [
      ['get_iv_history', { symbol: 'SPY' }, 60], ['get_iv_history', { symbol: 'SPY', days: 400 }, 200], ['get_iv_history', { symbol: 'SPY', full: true }, 60],
      ['get_greeks_history', { symbol: 'SPY', start: '2026-01-01', end: '2026-09-22' }, 60], ['get_greeks_history', { symbol: 'SPY', start: '2025-01-01', end: '2026-09-22' }, 200],
      ['get_greeks_history', { symbol: 'SPY', start: '2026-01-01', end: '2026-09-22', full: true }, 60],
    ] as const) {
      const client = { get: async () => structuredClone(canned(n)), post: async () => ({}) } as any;
      const on = captureRegisteredTools();
      registerAllTools(on.server as any, client, stubTokens(), stubClient());
      // Parsed through the tool's own input schema, as the SDK does: review
      // showed a handler called raw never took IV history's
      // default branch (days defaults to 90 in the schema).
      const registered = on.tools.find((t) => t.name === tool)!;
      const parsed = z.object(registered.config.inputSchema as z.ZodRawShape).parse(args);
      const result: any = await registered.handler(parsed);
      const text = result.content[0].text as string;
      const label = `${tool} ${JSON.stringify(args)}`;
      if (tool === 'get_iv_history' && !('days' in args) && !('full' in args)) {
        expect((parsed as { days?: number }).days, label).toBe(90);
        expect(JSON.parse(text).data, label).toHaveLength(30);
      }
      expect(text.split('"historySnapshotId"').length - 1, label).toBe(1);
      expect(text, label).not.toContain('"metadata"');
      expect(text, label).toContain('"provenance"');
    }
  });

  test('the earnings calendar says which fields its rows carry', () => {
    // The description promised {symbol, date, time, ...}; the table has no
    // time column (earnings_calendar: symbol, date, fiscal_date_ending,
    // eps_estimated, eps_actual, revenue_estimated, revenue_actual,
    // updated_at, the last dropped at the wire).
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'run_screener')!.config.description);
    // Twenty-first run: fiscalDateEnding was null on all 15 rows; the
    // table had it null on all 10,833 on 2026-09-23. The proxy route no
    // longer selects it, so the description no longer names it.
    expect(text).toContain('`earnings-calendar` returns a bare array of {symbol, date, epsEstimated, epsActual, revenueEstimated, revenueActual} rows, with no time of day and no fiscal period; the estimates and actuals are null where the source has none.');
    expect(text).not.toContain('fiscalDateEnding');
    expect(text).not.toContain('{symbol, date, time, ...}');
  });

  test('scan_option_strategies says what its candidates, probabilities and costs are', () => {
    // packages/shared/src/broker/strategyScan.ts, proxy/lib/strategyScanParams.ts,
    // proxy/routes/live-broker.ts /live/strategy-scan.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'scan_option_strategies')!.config.description);
    expect(text).toMatch(/A covered call or cash-secured put is the short_call or short_put here, without the stock or cash leg, which is not modelled\./);
    expect(text).toMatch(/Unset, it defaults by strategy: 0\.15 to 0\.35 for short options and credit spreads, 0\.3 to 0\.6 for long options, 0\.4 to 0\.6 for debit spreads, straddles and butterflies, 0\.1 to 0\.25 for iron condors and short strangles, 0\.15 to 0\.35 for long strangles\./);
    expect(text).toMatch(/when that exact strike is not listed, the nearest within a quarter of the width is used and the candidate's `width` says what was listed \(for an iron condor or butterfly, the wider of its two wings; the legs' strikes show both\)\./);
    expect(text).toMatch(/a two-anchor candidate's `anchorDelta` is the mean of its two\./);
    expect(text).toMatch(/`expectedMove` is this expiration's at-the-money straddle \(`callMid` plus `putMid` at `strike`\), with `pctOfSpot` its fraction of spot as get_live_dealer_positioning gives it,/);
    // The fallback yield is the dividend over the live spot (proxy/lib/liveMarketInputs.ts),
    // taken whenever no usable trailing yield resolves (none on file, a failed
    // read or an unusable value), not only for funds.
    for (const name of ['scan_option_strategies', 'get_live_dealer_positioning']) {
      expect(String(tools.find((t) => t.name === name)!.config.description), name).not.toMatch(/profile_yield\" \(a fund/);
    }
    for (const name of ['scan_option_strategies', 'get_live_dealer_positioning']) {
      expect(String(tools.find((t) => t.name === name)!.config.description), name).toContain('When `resolved.q.source` is "profile_yield" (no usable trailing yield was resolved for the symbol: none on file, as for most funds, or one that could not be read or used), q is its trailing annual dividend over the live spot, so it moves slightly with spot from call to call while `resolved.q.asOf` is when the profile record holding that dividend was last updated, not when the division was made.');
    }
    expect(text).toMatch(/Every leg needs a two-sided quote, and a sold leg a bid above zero; a candidate missing one is counted in `skipped` by reason, never priced from a last trade or a mark, and a spread whose credit or debit reaches its width is skipped as not a real price\./);
    expect(text).toMatch(/`probabilityOfProfit` is the risk-neutral probability, under a lognormal model, that the price at expiration ends where the position makes money at the mid, each breakeven read at the implied volatility the chain's own smile gives at that price, with the resolved rate and dividend yield;/);
    expect(text).toMatch(/They are model values, not forecasts: they take no view on direction, implied volatility has tended to run above realized so short-premium outcomes have tended to beat them, and they ignore early assignment, fills and costs\. Delta is not used as a probability\./);
    expect(text).toMatch(/each is withheld under incomplete coverage as that tool withholds it, and they carry that tool's `gammaFlipMethod`, `gammaFlipResolution` and `dealerRegime` \(the sign of gamma at spot, not of net GEX\), and `levels.openInterestUnpublishedExpirations` names the expirations whose open interest the broker did not publish \(a zero on every contract, as Schwab prints on index options\), whose legs are excluded, so a level they feed is withheld for incomplete coverage\. Every strike, breakeven and level carries its distance from spot in percent\./);
    expect(text).toMatch(/these orderings do not rank trades as better or worse\./);
    expect(text).toContain("EXPENSIVE: a scan reads the expirations list and the scanned chain, charged in your broker's own requests (3 on Tradier, 2 on Schwab), and up to four more chains with `levels: \"window\"`.");
    expect(text).toContain("so another scan of the same expiration within 15 seconds, with any other strategy or filters, re-scans the cached chain with the same `asOf` and spends no broker request, so it is refunded.");
    expect(text).toMatch(/It refuses rather than defaulting a rate or dividend yield it cannot source \(RESOLUTION_FAILED, naming the missing one, which `r` or `q` supplies\), an expiration the broker does not list \(UNKNOWN_EXPIRATION, naming the listed ones\), and an expiration listed only under adjusted series, a different deliverable \(ADJUSTED_SERIES_ONLY, naming the roots in `excludedRoots`\); a malformed parameter \(INVALID_REQUEST\), symbol \(INVALID_SYMBOL\) or provider \(UNKNOWN_PROVIDER\) is refused before it is charged\./);
    // strategyScan.ts MAX_PAIRS and twoWings.
    expect(text).toMatch(/a band giving more than 10,000 pairs is refused \(SCAN_TOO_LARGE, naming the count\) after the chain is read and charged; a narrower band within 15 seconds re-scans the cached chain\./);
    expect(text).toMatch(/\(an iron condor or butterfly whose credit exceeds one wing keeps money on that whole side, so it has no breakeven there and its max loss is on the wider wing\)/);
    expect(text).not.toMatch(/probability of (?:success|winning)|best trade|recommend/i);
  });

  test('each live tool reports the live-broker budget the proxy gave, and nothing when it gave none', async () => {
    // proxy/lib/liveBrokerLimiter.ts sets RateLimit-* on every admitted request;
    // LiveApiClient.get hands them to the tool.
    const budget = { limit: 10, remaining: 8, resetSeconds: 43 };
    for (const report of [true, false]) {
      const live = {
        get: async (_path: string, _params?: Record<string, string>, onRateLimit?: (r: typeof budget) => void) => {
          if (report) onRateLimit?.(budget);
          return {};
        },
        post: async () => ({}),
      } as any;
      const { tools, server } = captureRegisteredTools();
      registerAllTools(server as any, stubClient(), stubTokens(), live);
      for (const [name, args] of [
        ['get_live_options_chain', { symbol: 'SPY' }],
        ['get_live_dealer_positioning', { symbol: 'SPY' }],
        ['scan_option_strategies', { symbol: 'SPY', expiration: '2026-11-20', strategy: 'short_put' }],
        ['get_live_quote', { symbol: 'SPY' }],
        ['get_intraday_bars', { symbol: 'SPY' }],
        ['rank_live_skew_gex', { symbols: 'SPY' }],
      ] as const) {
        const result = await tools.find((t) => t.name === name)!.handler(args);
        expect((result.structuredContent as any).rateLimit, `${name} ${report}`).toEqual(report ? budget : null);
      }
    }
  });

  test('each live tool publishes every number at 15 significant digits at most', async () => {
    // The whole output passes through one rounding: a tail anywhere in it,
    // here in the budget the proxy reported, is dropped.
    const live = {
      get: async (_path: string, _params?: Record<string, string>, onRateLimit?: (r: unknown) => void) => {
        onRateLimit?.({ limit: 10, remaining: 8.000000000000002, resetSeconds: 43 });
        return {};
      },
      post: async () => ({}),
    } as any;
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), live);
    for (const [name, args] of [
      ['get_live_options_chain', { symbol: 'SPY' }],
      ['get_live_dealer_positioning', { symbol: 'SPY' }],
      ['scan_option_strategies', { symbol: 'SPY', expiration: '2026-11-20', strategy: 'short_put' }],
      ['get_live_quote', { symbol: 'SPY' }],
      ['get_intraday_bars', { symbol: 'SPY' }],
      ['rank_live_skew_gex', { symbols: 'SPY' }],
    ] as const) {
      const result = await tools.find((t) => t.name === name)!.handler(args);
      expect((result.structuredContent as any).rateLimit, name).toEqual({ limit: 10, remaining: 8, resetSeconds: 43 });
    }
  });

  test('the scan and live tools describe the new ordering, ladder, liquidity, model Greeks and budget', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    const scan = text('scan_option_strategies');
    expect(scan).toContain('except that an iron butterfly or straddle body sorts nearest the money first, by its call delta\'s distance from 0.5, taken in the broker\'s decimals so 0.45 and 0.55 tie)');
    expect(scan).toContain('ties in any of them going to the lower first-leg strike;');
    expect(scan).toContain('walking the sorted candidates best first, it keeps one only while neither of its anchor strikes has been used, so each anchor strike appears once, though not always in its own best pair (a put strike whose best call was taken by an earlier candidate gets its best pair with a call still free, or none);');
    expect(scan).toContain('on the four nearest expirations that may still trade (from 4:15 PM New York time on an expiration day, when no expiring series trades any longer, that day\'s is left out unless the broker lists nothing else)');
    expect(scan).toContain('every number goes out at 15 significant digits at most');
    const chain = text('get_live_options_chain');
    expect(chain).toContain('Omit `expiration` for the nearest listed expiration that may still trade: from 4:15 PM New York time on an expiration day, when no expiring series trades any longer (some expiring ETF options, including SPY, trade until then; expiring stock options stop at 4:00 in regular hours, and at 4:15 for a class Cboe trades in its curb session; PM-settled index options stop at 4:00), that day\'s is passed over for the next one');
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning']) {
      expect(text(name), name).toContain('one not written YYYY-MM-DD is refused by this tool\'s input check before any request, and a well-formed date that is not a calendar date (2026-02-30) by the proxy as INVALID_EXPIRATION, before it is charged.');
      // The input check the sentence names: a shape the proxy never sees.
      const expiration = (tools.find((t) => t.name === name)!.config.inputSchema as Record<string, z.ZodTypeAny>).expiration;
      expect(expiration.safeParse('2026-9-28').success, name).toBe(false);
      expect(expiration.safeParse('2026-02-30').success, name).toBe(true);
    }
    expect(chain).toContain("Rate limited per broker, shared with the other live tools, because each call spends your own broker quota: a chain is 2 requests on Tradier and Public, 1 on Schwab, and on tastytrade 2 plus one per 100 contracts it lists for the date under every root before they merge (a third Friday's SPX lists about twice the merged count), plus 1 for the expirations list when it is not cached (15 minutes); `strikeRange` trims the answer, not the fetch.");
    expect(chain).toContain('Every number goes out at 15 significant digits at most');
    expect(chain).not.toContain('front month');
    expect(scan).toContain('the rest count in `skipped` as "shared-anchor-strike", and `distinct: false` returns every pair');
    expect(scan).toContain('Each candidate\'s `liquidity` is its thinnest leg\'s open interest (null when any is unknown) and its widest leg\'s spread in percent.');
    expect(scan).toContain('from the Black-Scholes model at each leg\'s own IV with the resolved rate and yield when every leg has a usable one (`source` "model"');
    expect(scan).toContain('the near-term positioning that moves the market now, not this expiration\'s');
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'get_live_quote', 'get_intraday_bars']) {
      expect(text(name), name).toContain("`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker's own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; an error answered after the live-broker limiter ran carries it as `rateLimit` beside `code`, whether one it charged for (an unlisted expiration, a broker failure) or its own rate-limit refusal (RATE_LIMITED, which charges nothing), and one refused before it (the Pro tier gate, a malformed date, a missing credential) carries none. The budget is each broker's own documented quota, never less: 120 requests a minute on Tradier and Schwab, 600 on Public (10 a second), and 120 on tastytrade, which publishes no figure, so that one is a conservative stand-in. The broker's own rate limit is reported as BROKER_RATE_LIMITED, retryable, with `retryAfterSeconds` when the broker said how long (Tradier's window reset, Schwab's Retry-After) and null with a backoff note when it did not; wait before retrying.");
      expect(text(name), name).not.toMatch(/weighted unit|10-unit|10 units/);
    }
    expect(text('get_live_dealer_positioning')).toContain('Every number goes out at 15 significant digits at most (except `strikes.windowPct` and `strikes.deltaBand`, which echo the value asked for exactly), which drops binary noise such as -27496.350000000002 in a computed sum, mid or ratio, while a decimal the broker printed with 15 or fewer digits and a whole number such as an open-interest count pass unchanged; `coverage.gammaFlipResolution`, a sampling step, at 6.');
  });

  test('the live positioning and scan take a supplied rate and yield, and the quote names the rolled previous close', () => {
    // Third live re-test, 2026-10-03 (markets closed): SPX positioning was
    // refused for a dividend yield the platform does not hold for an index
    // and the caller had no way to supply one; Tradier's SPX quote on a
    // Saturday read change 0.00 because prevclose had rolled to Friday's own
    // close, and published null open, high and low the copy did not mention.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const tool = (name: string) => tools.find((t) => t.name === name)!;
    const text = (name: string) => String(tool(name).config.description);
    const supplied = '`r` and `q` can be supplied, as decimal fractions (0.0425 is 4.25%): a supplied one is used as given, labelled "supplied" in `resolved` with no date, and never read from or checked against the market, while the other is resolved as usual; an index\'s resolved yield is its basket-derived trailing estimate (its members\' yields weighted as the index weighs them; `resolved.q.source` "index_constituents"), and a volatility index such as VIX, or an index whose estimate is unavailable, needs `q` supplied, the refusal otherwise (RESOLUTION_FAILED) naming what is missing and why. A value that is not a decimal fraction (4.25 for 4.25%) is refused as INVALID_REQUEST before anything is charged.';
    for (const name of ['get_live_dealer_positioning', 'scan_option_strategies']) {
      expect(text(name), name).toContain(supplied);
      expect(text(name), name).toContain('An index without `q` whose yield is unavailable is refused before the session opens and before anything is charged.');
      const schema = tool(name).config.inputSchema as Record<string, { description?: string }>;
      for (const field of ['r', 'q']) {
        expect(schema[field], `${name} ${field}`).toBeDefined();
        expect(String(schema[field].description), `${name} ${field}`).toMatch(/decimal fraction/);
        expect(String(schema[field].description), `${name} ${field}`).toMatch(/is 4\.25%|is 1\.2%/);
      }
      // An index carries its basket-derived yield; only an unavailable one is asked for
      expect(String(schema.q.description), name).toContain('a volatility index such as VIX has none');
      expect(text(name), name).not.toContain('holds no dividend yield for an index');
    }
    expect(text('scan_option_strategies')).toContain('The chain, rate, yield, levels and expected move are cached for 15 seconds per account, symbol, expiration, broker, `levels` and supplied `r` and `q`, so another scan of the same expiration within 15 seconds');
    // Broker re-run: a stale chain spot, Public's single-root rows, the weekend straddle.
    // Public index re-run: a zero last on untraded puts.
    // Final re-run: a sentinel IV's Greeks are withheld with it.
    // Live re-run: a zero bid's midpoint.
    expect(text('get_live_options_chain')).toContain('A null field means the broker published nothing for it, which is different from zero, except where this tool withholds a figure and says so: a `mid` beside a zero bid, and the Greeks beside an unusable IV (`greeksReason`).');
    expect(text('get_live_options_chain')).toContain('`mid` is (bid + ask) / 2 only where both sides are quoted above zero, as get_live_quote\'s is: a zero bid (nobody bidding) leaves it null beside the ask and the broker\'s mark.');
    expect(text('get_live_options_chain')).toContain('A 25-delta wing is chosen only among contracts whose IV is usable, so its delta is one this tool shows, and is null when none is.');
    expect(text('get_live_options_chain')).toContain('The quote beside it is the broker\'s and is kept; the contract\'s delta, gamma, theta and vega come from the same failed solve (delta 1 beside gamma and vega 0 is the zero-vol limit, not a measurement), so they are withheld as null with `greeksReason` "iv-unusable", as they are where the broker published Greeks with no IV.');
    expect(text('get_live_options_chain')).toContain('Where the IV is usable, the Greeks are the broker\'s as published and are not checked against the quote or the IV beside them.');
    expect(text('get_live_options_chain')).not.toContain('The delta and the quote beside it are still the broker');
    expect(text('get_live_options_chain')).toContain('A contract that has not traded has `last` null: nothing trades at zero, so a broker\'s 0 is no print.');
    expect(text('get_live_quote')).toContain('a `last` of 0 is no trade and goes out null');
    expect(text('get_live_dealer_positioning')).toContain('A stale spot adds a `limitations` line naming what it skews (the levels\' distances from spot, the at-the-money straddles, the split at spot).');
    expect(text('scan_option_strategies')).toContain('A stale spot adds `spotNote` beside `spotPrice` naming what it skews (every `pctFromSpot`, the expected move, each breakeven against it).');
    expect(text('get_live_options_chain')).toContain('Public lists SPX\'s options under SPXW only, even on a third Friday, so an SPX monthly there is the PM-settled series.');
    for (const name of ['get_live_quote', 'get_live_options_chain', 'get_intraday_bars', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex']) expect(text(name), name).not.toContain('answered SPX\'s expirations with a 400');
    expect(text('get_live_options_chain')).toContain('`spotTime` is when the spot printed, where the broker gives it (Tradier, Public and Schwab; tastytrade publishes no trade time, so null there), and `spotStale` is true when that predates the last session\'s open, by get_live_quote\'s `stale` rule (Public has answered a 04:00 pre-market print), null when unknown; the at-the-money pair and the strike window are read against that spot.');
    expect(text('get_live_dealer_positioning')).toContain('`resolved.S` carries the spot\'s print time as `asOf` and `stale` by get_live_quote\'s rule, both null where the broker gives no print time (tastytrade).');
    expect(text('scan_option_strategies')).toContain('`resolved.S` carries the spot\'s print time as `asOf` and `stale` by get_live_quote\'s rule, both null where the broker gives no print time (tastytrade).');
    expect(text('get_live_dealer_positioning')).toContain('near the money the straddle is roughly 0.8 of it while the market is open; on a closed market the straddle is whatever prices the broker last published while `ivOneSigma` is measured on the time left now, so their ratio can drift from 0.8 (0.99 on a Monday expiration seen on a Saturday).');
    expect(text('scan_option_strategies')).toContain('`resolved.r` is the Treasury series matched to the scanned expiration\'s tenor (DGS1MO within a month, DGS3MO within three), as compute_scenario matches its shortest option leg\'s (one rate for a position), where get_live_dealer_positioning\'s four-expiration window takes the 3-month default; the levels inside a scan are priced at the scan\'s rate, so they can differ from that tool\'s by the difference between the two rates.');
    expect(text('scan_option_strategies')).toContain('The band runs on the delta the broker publishes, so on a closed market it is whatever the broker last published, at the broker\'s own time convention, and a strike the band admits can read outside it at a model priced with the time now left.');
    expect(text('scan_option_strategies')).not.toContain('the last session\'s, at the broker');
    const quote = text('get_live_quote');
    expect(quote).toContain('A previous close rolls to the session\'s own close on some brokers once the session ends (Tradier\'s SPX all weekend, and Schwab\'s stocks and indices), so outside regular hours a quote whose previousClose equals its last, or the regular session\'s last where the broker keeps an extended-hours last apart (Schwab), with no broker-published change or a published change of 0, goes out with `change` and `changePercent` null, `changeBasis` null and `changeReason` "previous-close-rolled": the day\'s change cannot be read from it, and a session that genuinely closed flat reads the same and is withheld the same; a broker\'s own non-zero change is published whatever the previous close. A change computed from a stale quote (below) is withheld the same way with `changeReason` "stale-quote": it is that snapshot\'s move, not the day\'s (Public has answered a 04:00 pre-market print); a broker\'s own change is kept. `changeReason` is null otherwise. get_stock_prices has the prior close.');
    expect(quote).not.toMatch(/so a computed change of 0 after hours is that roll, not a flat day/);
    // All-broker live run: Schwab's index quote, its after-hours change, a stale
    // computed change, tastytrade's ticking clock, the broker's own error.
    expect(quote).toContain('`mark` is the broker\'s own valuation where it publishes one (tastytrade, and Schwab for a stock or fund), not an executable quote');
    expect(quote).toContain('(`changeBasis` "broker": Tradier, and Schwab from its regular-session figures where its quote carries them, so an after-hours trade does not move it, else its netChange)');
    expect(quote).toContain('Null with no clocks at all. tastytrade\'s one clock is its market-data clock, which moves without new prices (it ticked on a Saturday), so `stale` cannot catch a frozen tastytrade quote.');
    expect(quote).toContain('Schwab\'s `previousClose` is its close, the previous regular session\'s during the session and that session\'s own once it ends, its `quoteTime` moves on a bid or ask update while `tradeTime` is the last print, and an index quote there has no bid, ask, mark or quote time;');
    for (const name of ['get_live_quote', 'get_live_options_chain', 'get_intraday_bars', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex']) {
      expect(text(name), name).not.toMatch(/brokerError|never its body/);
      expect(text(name), name).toContain('A broker that refuses the request itself (an HTTP 4xx other than 408, 409, 425 and 429, and neither a credential refusal nor a failed sign-in; Public answers a symbol it does not list with a 400) is reported as BROKER_REJECTED, not retryable, with `brokerFailure` "http-status" and its `brokerStatus`: retrying will not help, another broker may.');
      expect(text(name), name).toContain('A broker that does not answer is reported as BROKER_UNAVAILABLE, with `brokerFailure` saying what kind of failure it was ("http-status" with the broker\'s `brokerStatus`, "timeout", "unreadable-response", "no-usable-answer" when it answered with no price, strikes or spot to use, or "other"); no broker text is passed on.');
    }
    expect(text('get_live_options_chain')).toContain('whole-chain volume/open-interest totals, which add up what the broker reported, with `contractsMissingVolume` and `contractsMissingOpenInterest` beside them counting the contracts it left out (null only when it reported none);');
    expect(text('get_live_options_chain')).toContain('A merged row\'s summed figure with an unknown term is null.');
    expect(text('get_live_dealer_positioning')).toContain('a null status means no leg entered the search (every one excluded, as when the broker published no open interest) or the response did not report a recognized search status.');
    expect(text('get_live_dealer_positioning')).toContain('`window.openInterestUnpublishedExpirations` names the expirations whose open interest the broker did not publish (a zero on every contract, as Schwab prints on index options): their legs are excluded, so a level they feed is withheld for incomplete coverage (`levelStatus` says which), and `limitations` says so; the expected moves are priced from quotes and are unaffected.');
    expect(text('scan_option_strategies')).toContain('`gammaFlipResolution` and `dealerRegime` (the sign of gamma at spot, not of net GEX), and `levels.openInterestUnpublishedExpirations` names the expirations whose open interest the broker did not publish (a zero on every contract, as Schwab prints on index options), whose legs are excluded, so a level they feed is withheld for incomplete coverage.');
    expect(quote).toContain('Public publishes no open, high or low, so those are null there, and Tradier publishes none for an index quote (SPX, VIX), so they are null there too; a null is what the broker left out, never a stand-in.');
    expect(quote).toContain('`mid` is (bid + ask) / 2 only when both sides are quoted above zero, and null for an index (SPX, VIX), whose bid and ask are indicative and not an executable market (`midReason` "index-not-executable"; Tradier\'s SPX sides were 76 points apart on a Saturday)');
    expect(quote).toContain('A repeat for the same symbol on the same broker, by the same account, within 5 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account\'s call never shares it.');
    expect(text('get_intraday_bars')).toContain('A repeat for the same symbol, date, interval and session on the same broker, by the same account, within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and spends no broker request, so it is refunded; the cache is per proxy instance and per account and broker, so a repeat can also be fetched afresh and another account\'s call never shares it.');
  });

  test('the live tools name the credential store they read', () => {
    // A user whose account page said Connected (a browser connection) got
    // BROKER_NOT_CONNECTED; the tools read only the opt-in stored credential.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'get_live_quote', 'get_intraday_bars', 'rank_live_skew_gex']) {
      const text = String(tools.find((t) => t.name === name)!.config.description);
      expect(text, name).toContain('Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool.');
      expect(text, name).not.toContain('a broker connected under Account -> Broker.');
    }
  });

  test('the live watchlist ranking states its budget, its re-call contract, its method and its own budget block', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'rank_live_skew_gex')!.config.description);
    expect(text).toContain('this spends your own broker quota and MAY SPEND ALL OF IT, after which the other live tools refuse (RATE_LIMITED) until the window resets.');
    expect(text).toContain('call again with the SAME list after it, not in a tight loop.');
    expect(text).toContain('so the change is like for like on every broker.');
    // Review: a failed check is named with its expiration; "no-qualifying-expiration" is only nothing 7 days out.
    expect(text).toContain('when every one tried fails, `skew.value` is null and `skew.status` names the check the expiration nearest 30 days out failed, with that `expiration` and `dte`: "curve-gate" (fewer than 5 strikes with a usable IV), "delta-gate" (fewer than 5 strikes with a delta) or "wing-iv" (no usable IV at the 25-delta call or put)');
    expect(text).toContain('"no-qualifying-expiration", with both null, means no listed expiration is 7 days out.');
    expect(text).not.toContain('or "no-qualifying-expiration" when nothing is 7 days out');
    expect(text).toContain('the GEX change is one session of new positions plus the price moves since');
    expect(text).toContain('It is this model\'s gamma, not the broker\'s: get_live_dealer_positioning sums the broker\'s published Greeks over the same window and the two can differ;');
    expect(text).toContain("`rateLimit` is the live-broker budget after this call as the proxy reported it, in your broker's own requests: `remaining` of `limit` on the broker used (`provider`), resetting in `resetSeconds`, or null when it reported none; a call ended by a dead credential or a failed record of its use carries it as `rateLimit` beside `code`, and one refused before the broker opened (the Pro tier gate, a malformed parameter, a missing credential) carries none.");
    // Its budget refusals are pending rows, not the RATE_LIMITED error the shared sentence describes.
    expect(text).not.toContain('or its own rate-limit refusal (RATE_LIMITED, which charges nothing)');
    // Live run: model outputs at their precision so fifty rows fit.
    expect(text).toContain('Skews, IVs, yields, shares and percentages go out at 6 significant digits and GEX in whole dollars; prices as the broker quoted them.');
    expect(text).not.toContain('Every number goes out at 15 significant digits at most.');
    // Live run: a stale row is not pending, so a long list completes; refreshes go oldest first after.
    expect(text).toContain('an older one is served as it is, with its `ageSeconds`, marked `stale` and listed in `refreshPending`, and is refreshed oldest first once every symbol has a value. What this call could not answer at all is in `pending`');
    expect(text).toContain('`complete` is true once every symbol has a value for every requested metric or an error, stale rows included, and `retryAfterSeconds` says when the next call can make progress, on pending symbols or on stale rows');
    expect(text).toContain('so on a long list a row can be older than `maxAgeSeconds` (fifty symbols on Tradier take about five minutes a round): ask for fewer symbols for fresher rows.');
    expect(text).not.toContain('`complete` is false until nothing is pending');
    // Live run: an unknown ticker, a timed-out request, errors beside complete, rows past the ceiling.
    expect(text).toContain('A symbol the broker lists no expirations for (an unknown ticker, or one without options) is NO_EXPIRATIONS, not retryable.');
    expect(text).toContain('A request counts when it is sent, answered or not: a chain the broker does not answer in time still spends its share.');
    expect(text).toContain('and `complete` does not wait for it - ask for a retryable one again later.');
    expect(text).toContain('ask for those symbols in a separate call, served from the cache at no cost while younger than `maxAgeSeconds`.');
    // Live run: Schwab answered SPX's daily window with open interest; the claim is what it has done, not what it always does.
    expect(text).toContain('(a zero on every contract, which Schwab has printed on index options)');
    expect(text).not.toContain('Schwab prints none on index options');
    expect(text).toContain('A symbol still finishing when the answer goes out holds its reservation until it settles, so `remaining` can read low for a moment.');
  });

  test('get_regime says which prior each intraday scan kept', () => {
    // The persisted intraday row kept neither the prior label nor its source
    // (0 of 95 rows since 2026-09-17); the producer records both now.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_regime')!.config.description);
    expect(text).toContain('A scan stored since the producer began recording it carries `priorLabel`, the label its hysteresis was judged against (null when it had none), and `priorLabelSource`, "earlier scan" or "daily label" (null with no prior); older scans carry neither.');
  });

  test('the live dealer tool says why its rate is dated a session or two back', () => {
    // resolved.r.asOf read two sessions back on 2026-09-23 (DGS3MO's newest
    // row was 2026-09-21): FRED posts a day's value the next business day and
    // the sync runs at 18:30 New York, so that is the newest value there is.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.description);
    // The resolver takes the newest stored row with no age check (review:
    // an offline probe got a January 2025 row) and accepts an older row when
    // newer ones are withdrawn, so the text promises no freshness and names
    // no single cause for an old date.
    expect(text).toContain("When r is not supplied, `resolved.r` is the newest stored 3-month Treasury yield from FRED, whatever its age: FRED posts a business day's value the next business day and the platform syncs it once each weekday evening, so `resolved.r.asOf` is usually one or two sessions before today; an older date can mean the sync is behind, a delayed publication, or a newer observation withdrawn, and the answer carries no warning either way.");
    expect(text).not.toContain('means the sync has not caught up');
    expect(text).not.toContain('not a stale feed');
  });

  test('the history tools say what their provenance timestamps mean', () => {
    // Twenty-first run: provenance on the IV history read fetchedAt and
    // receivedAt both 2026-09-22T20:00:00Z, for data imported the next
    // morning. fetchedAt is deliberately the session close (the web labels
    // old end-of-day data by its date); receivedAt is now the proxy's answer
    // time. The descriptions say which is which.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const name of ['get_iv_history', 'get_greeks_history', 'get_options_analytics_history']) {
      const text = String(tools.find((t) => t.name === name)!.config.description);
      expect(text, name).toContain('Where the answer carries provenance, fetchedAt is the close (16:00 New York) of the newest session in it, the time the data describes, not when it was imported; receivedAt is when the proxy answered.');
    }
  });

  test('no public surface names a data vendor', async () => {
    // Vendor names were scrubbed from every public surface, and
    // three descriptions written since named the options data vendor again
    // (get_options_chain, get_iv_surface, get_regime). Tool descriptions,
    // parameter descriptions, platform info, the README and the manifest are
    // all public: the connector serves them and the public mirror ships them.
    // The names are base64 here so this file, which the public mirror also
    // ships, names no vendor itself.
    // Any spacing, underscores and line breaks included, and a name inside
    // a word. Every string is checked as a string, never as serialized JSON,
    // where a line break hides behind an escape.
    const vendor = new RegExp(Buffer.from('b3JhdHN8Zm1wfGZpbmFuY2lhbFtcV19dKm1vZGVsaW5nW1xXX10qcHJlcA==', 'base64').toString('utf8'), 'i');
    const strings = (value: unknown, path: string, out: Array<[string, string]> = []): Array<[string, string]> => {
      if (typeof value === 'string') out.push([path, value]);
      else if (Array.isArray(value)) value.forEach((item, i) => strings(item, `${path}[${i}]`, out));
      else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
          out.push([`${path} key`, key]);
          strings(item, `${path}.${key}`, out);
        }
      }
      return out;
    };
    const schemaJson = (schema: unknown) => {
      if (schema == null) return {};
      const zod = schema instanceof z.ZodType ? schema : z.object(schema as z.ZodRawShape);
      return z.toJSONSchema(zod, { unrepresentable: 'any' });
    };
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const published: Array<[string, string]> = strings(getMcpServerInfo(), 'server');
    for (const tool of on.tools) {
      const { inputSchema, outputSchema, ...rest } = tool.config;
      strings(rest, tool.name, published);
      strings(schemaJson(inputSchema), `${tool.name} input`, published);
      strings(schemaJson(outputSchema), `${tool.name} output`, published);
    }
    const info: any = await on.tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'all' });
    strings(info, 'platform info', published);
    expect(published.length).toBeGreaterThan(1_000);
    for (const [where, text] of published) expect(text, where).not.toMatch(vendor);
    // And every text file the package and the public mirror ship, source,
    // tests and comments included.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = new URL('../../', import.meta.url).pathname;
    const skip = new Set(['node_modules', 'dist', 'dist-remote', '.git', 'bun.lock']);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (!/\.(png|mcpb|ico|jpg)$/.test(entry.name)) files.push(full);
      }
    };
    walk(root);
    expect(files.some((f) => f.endsWith('helpers.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('README.md'))).toBe(true);
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(vendor);
  });

  test('the raw profile and news paths reach the client without a vendor name', async () => {
    // Both tools pass the proxy row through on `full`, and the row's `image`
    // is a URL on the equity vendor's image host. The wire drops it.
    const decode = (x: string) => Buffer.from(x, 'base64').toString('utf8');
    const host = `https://images.${decode('ZmluYW5jaWFsbW9kZWxpbmdwcmVw')}.com`;
    const vendor = new RegExp(decode('b3JhdHN8Zm1wfGZpbmFuY2lhbFxXKm1vZGVsaW5nXFcqcHJlcA=='), 'i');
    const client = {
      get: async (path: string) => (path.startsWith('/stock-news/')
        ? [{ symbol: 'ROIV', title: 'Roivant rises', url: 'https://news.test/a', image: `${host}/news/a.jpg`, published_date: '2026-09-22' }]
        : { symbol: 'ROIV', company_name: 'Roivant', image: `${host}/symbol/ROIV.png`, description: 'Biotech.' }),
      post: async () => ({}),
    } as any;
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, client, stubTokens(), stubClient());
    for (const name of ['get_company_profile', 'get_news']) {
      const tool = on.tools.find((t) => t.name === name)!;
      const args = z.object(tool.config.inputSchema as z.ZodRawShape).parse({ symbol: 'ROIV', full: true });
      const res: any = await tool.handler(args);
      expect(res.isError, name).toBeUndefined();
      expect(JSON.stringify(res), name).not.toMatch(vendor);
      expect(JSON.stringify(res), name).toContain('Roivant');
    }
  });

  test('platform info names only tools that are registered', async () => {
    // Three names in the Conventions text were invented (get_analyses,
    // query_analyses, get_analysis_stats); the tools are get_analysis_history,
    // query_analysis and get_analysis_rollups. A model that follows a pointer
    // to a tool that does not exist gets a protocol error, so every tool-like
    // token in every topic has to resolve to a registered tool.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const registered = new Set(on.tools.map((t) => t.name));
    const info: any = await on.tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'all' });
    // The token is everything word-like, hyphenated or dotted after the
    // prefix, in any case, compared to the registry as written: a digit
    // suffix (get_analysis_history2), a letter suffix
    // (get_analysis_historyX), a hyphenated tail (get_analysis_history-extra),
    // a dotted tail (get_analysis_history.extra, which the MCP SDK's name
    // validator accepts), an upper-cased name (GET_ANALYSIS_HISTORY) and a
    // name broken after its prefix (a bare "get_") all resolve to no tool.
    // In prose only a sentence-ending dot is stripped, so "use get_regime."
    // names the tool and "get_analysis_history.extra" does not. Inside a
    // code span the token is literal and nothing is stripped, so a backticked
    // "get_analysis_history." or "get_analysis_history..." is a name that
    // does not exist, not the registered name plus punctuation.
    // A code span naming a tool is read literally (nothing inside it is
    // stripped, so a backticked "get_analysis_history." does not exist). A
    // span glued to prose on either side (`get_analysis_history`2,
    // `get_analysis_history`-extra, x`get_regime`) renders as one name, so
    // the glued whole is the token and must be registered as such; the
    // gluing is checked on the SPAN'S content, since a glued prefix breaks
    // the tool-like shape of the whole. A run of dots after the closing
    // backtick is sentence punctuation ("Use `get_analysis_history`."), not
    // glue.
    const text = String(info.structuredContent.text);
    const pattern = /\b(?:get|query|compute|run|scan|rank)_[\w.-]*/gi;
    // Tool-likeness is judged on the span's content AND on the glued whole:
    // x`get_regime` is tool-like inside and glued outside, get_`nonexistent`
    // is tool-like only as a whole (its prefix is outside the span). Either
    // way the glued whole is the token.
    const spanTokens: string[] = [];
    for (const match of text.matchAll(/([\w.-]*)`([^`]+)`([\w.-]*)/g)) {
      const [, before, inner, after] = match;
      const glue = after.replace(/^\.+$/, '');
      const whole = `${before}${inner}${glue}`;
      const innerTokens = inner.match(pattern) ?? [];
      const wholeTokens = whole.match(pattern) ?? [];
      if (innerTokens.length === 0 && wholeTokens.length === 0) continue;
      if (before || glue) spanTokens.push(whole);
      else spanTokens.push(...innerTokens);
    }
    const prose = text.replace(/[\w.-]*`[^`]+`[\w.-]*/g, ' ');
    const mentioned = Array.from(new Set([
      ...spanTokens,
      ...(prose.match(pattern) ?? []).map((token) => token.replace(/\.+$/, '')),
    ]));
    expect(mentioned.length).toBeGreaterThan(5);
    expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);
  });

  test('platform info names the Greek convention compute_black_scholes publishes, beside the web app\'s', async () => {
    // The Greeks topic defined vanna, vomma, zomma and ultima per 1% IV move,
    // which is the web app's scaling. compute_black_scholes publishes the
    // commercial API's, per UNIT of volatility, and tags it. A model reading
    // both was handed two readings of one number with nothing saying which
    // applied where.
    const on = captureRegisteredTools();
    registerAllTools(on.server as any, stubClient(), stubTokens(), stubClient());
    const greeks: any = await on.tools.find((t) => t.name === 'get_platform_info')!
      .handler({ topic: 'greeks' });
    const text: string = greeks.structuredContent.text;
    expect(text).toContain('greekConvention: "dapi"');
    expect(text).toContain('compute_black_scholes');
    expect(text).toContain('per unit of volatility');
    // The web app's vega rule has one exception applyGreekScaling makes on
    // purpose: the Digital model's vega is left per unit of volatility. A
    // synced Digital record read as "per point" is a 100x misreading.
    expect(text).toContain('Digital');
    // Not every synced record went through applyGreekScaling: the FFT scanner
    // syncs computeFFTGreek's raw output (vega per unit, theta per year in the
    // mathematical direction), so the text must say so by tool name.
    expect(text).toContain('get_fft_results');
    expect(text).toContain('computeFFTGreek');
    // Rollups are not under the display scaling's Digital exception: the
    // producer normalizes Digital's vega to per point before averaging, so
    // listing get_analysis_rollups there invited the 100x conversion the
    // tool's own units line forbids.
    const lines = text.split('\n');
    const displayBullet = lines.find((line) => line.startsWith("- The web app's display scaling"));
    expect(displayBullet).toBeDefined();
    expect(displayBullet).not.toContain('get_analysis_rollups');
    const rollupsLine = lines.find((line) => line.includes('get_analysis_rollups'));
    expect(rollupsLine).toBeDefined();
    expect(rollupsLine).toContain('per percentage point');
    expect(rollupsLine).toContain('Digital');
    // The two conventions differ on dcharmDvol by 100 and on veta's sign;
    // "per day" on both sides hid the first and the second went unsaid.
    expect(text).toContain('dcharmDvol by 100');
    expect(text).toContain('veta differs in sign');
    // Market-convention theta is a direction, not a guaranteed sign (a deep
    // ITM long put carries positive daily theta), and the scalings are
    // defaults the caller can override.
    expect(text).not.toContain('negative for long options)');
    expect(text).toContain('override');
    for (const prefix of ['- Vanna:', '- Vomma (Volga):', '- Ultima:', '- Zomma:']) {
      const definition = text.split('\n').find((line) => line.startsWith(prefix));
      expect(definition, prefix).toBeDefined();
      expect(definition, prefix).not.toContain('per 1% IV');
    }
  });

  test('get_platform_info returns structuredContent and advertises an outputSchema', async () => {
    const { tools, server } = captureRegisteredTools();
    registerPlatformInfo(server as any);

    expect(tools).toHaveLength(1);
    expect(tools[0].config.outputSchema).toBeTruthy();

    const result = await tools[0].handler({ topic: 'models' });
    expect(result.structuredContent).toMatchObject({
      topic: 'models',
      text: expect.stringContaining('Black-Scholes'),
    });
    expect(result.content[0].text).toContain('Black-Scholes');
  });
});
