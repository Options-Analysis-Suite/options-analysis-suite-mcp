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

    expect(tools).toHaveLength(38);
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
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes']) {
      expect(tools.map((t) => t.name), name).toContain(name);
    }
    // Four say Pro; the two anonymous-on-the-proxy reads must not.
    const titled = (name: string) => String(tools.find((t) => t.name === name)!.config.title);
    expect(titled('get_live_options_chain')).toContain('(Pro)');
    expect(titled('get_live_dealer_positioning')).toContain('(Pro)');
    expect(titled('get_regime_fits')).toContain('(Pro)');
    expect(titled('compute_black_scholes')).toContain('(Pro)');
    expect(titled('get_options_snapshot')).not.toContain('Pro');
    expect(titled('get_options_snapshot')).not.toContain('API tier');
    expect(titled('get_dealer_positioning')).not.toContain('Pro');
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
    expect(chain).toMatch(/A repeat for the same symbol and expiration within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, and still counts as a request; the cache is per proxy instance, so a repeat can also be fetched afresh\./);
    expect(chain).not.toMatch(/within 15 seconds is answered/);
    expect(description('get_live_dealer_positioning')).toMatch(/Do not call it in a loop or for a list of symbols\. A repeat for the same symbol and broker over the same four expirations within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, totals and levels whatever `strikeRange` it asks for \(the limit only chooses which computed rows are returned\), and is still charged five units; the cache is per proxy instance, so a repeat can also be computed afresh\./);
    // Nineteenth run: the row carried delta alone, and a bid sat below
    // intrinsic DURING trading hours (MU's same-day 1030 call bid 39.10 at
    // 15:10 ET on 2026-09-23 with spotPrice 1070.45), which the sentence
    // placed only outside them.
    expect(chain).toMatch(/Returns near-the-money strikes, the ATM pair, 25-delta wings and whole-chain volume\/open-interest totals; every contract row carries strike, bid, ask, mid, mark, last, iv, delta, gamma, theta, vega, volume and openInterest\./);
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
    expect(snapshot).toMatch(/`chainExpiry` is the nearest expiration on file, the same-day one included/);
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
    await call('get_regime_fits', { symbol: 'spy', days: 5 });
    await call('get_options_snapshot', { symbols: 'spy' });
    await call('get_options_snapshot', { symbols: 'spy, qqq' });
    await call('get_dealer_positioning', { symbol: 'spy', date: '2026-09-15' });
    await call('get_dealer_positioning', { symbol: 'spy' });
    await call('compute_black_scholes', { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' });

    expect(requests).toEqual([
      { path: '/live/options-chain/SPY', params: { expiration: '2026-10-16', provider: 'tradier' } },
      { path: '/live/exposure/SPY', params: {} },
      { path: '/regime/fits/SPY/history', params: { days: '5' } },
      { path: '/scanner/snapshot/SPY', params: undefined },
      { path: '/scanner/metrics/batch', params: { symbols: 'SPY,QQQ' } },
      { path: '/eod/exposure/SPY', params: { date: '2026-09-15' } },
      { path: '/eod/exposure/SPY', params: {} },
      // Only what was given: no `undefined` keys, so the route's exactly-one
      // rule for t / daysToExpiry sees what the caller sent.
      { path: '/compute/black-scholes', body: { optionType: 'put', S: 100, K: 95, sigma: 0.3, daysToExpiry: 30, symbol: 'spy' } },
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
    expect(text).toMatch(/"mid" names the side's stored mid IV column \(the vendor's c_mid_iv or p_mid_iv\), not the contract's `mid` price beside it/);
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
    expect(text).toMatch(/On every scope, `stressScore` is a raw composite regime score/);
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
    expect(regime).toMatch(/`confidence` \(0 to 1\) says how secure the label is, not how severe the regime: how deep the score sits inside its band, whose lower edge is the label's exit level when the label was kept and its entry level otherwise \(just entered from either direction, or no usable prior\), and whose upper edge is the next state's entry level, or the previous label's exit level when it was just entered from above \(CALM and CRISIS measure from their one edge over 1\.5\), as d, the distance to the nearer edge over half the band, through \(1 - e\^\(-2\.5 d\)\) \/ \(1 - e\^\(-2\.5\)\) \(SPY's 2026-09-17 morning scan, 0\.0138 NORMAL after the open's STRESS: band -0\.5 to 1\.0, 0\.8929, times 0\.85 for the change, 0\.759\); times the share of calibration models that succeeded raised to the power 1\.5; times 0\.85 when the label differs from its prior or had none; for the market composite's own `confidence` the share is symbols scored over symbols in the composite, and the rows of the `include_symbols` breakdown keep model coverage\. `modelCoverage` \{succeeded, attempted\} on every symbol and intraday entry is that share's numerator and denominator \(KBE 2026-09-17: 2 of 8, so 0\.25 to the 1\.5 caps its confidence at 0\.125\); the composite stores no such counts\. The prior label a row was judged against is not stored, so no entry says whether its label was kept or which prior it took, and on the symbol and intraday scopes confidence is computed from the unrounded score, so a recomputation from the four-decimal `stressScore` can differ in the last digit \(the 2026-09-18 open scan, 1\.3496, recomputes to 0\.4295 against the stored 0\.4296\); the market composite rounds its score before computing confidence, so no such gap arises there\./);
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
    expect(live).toMatch(/Computed over the first four expirations the broker lists for the live chain, which on a name with monthly listings can span months \(KBE on 2026-09-18: 09-18, 10-16, 11-20, 12-18, three months; on 2026-09-21, with the 09-18 listing gone, 10-16, 11-20, 12-18, 2027-01-15, nearly four\) against the EOD tools' 0-60 days; `window\.expirations` lists them\. The window moves with the broker's list, as a listing expires or a nearer one is added, so two answers across such a change cover different books \(KBE at 17:47Z on 2026-09-21: netGex -5,013,878, call wall 75, put wall 59, no flip found within 20% of spot, against 358,515, 70 and a flip at 66\.68 at 20:46Z on 09-18\), and the live figure can differ in sign from the 0-60 day figure on file, a different window on a different session \(KBE: \+184,861 on file for 09-18, \+248,246 for 09-17\)\. It reflects the current session rather than the most recent session on file\./);
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
    expect(liveRange).toMatch(/^TOTAL per-strike rows nearest spot\. Default 10, max 40\. Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage\. The walls and the magnet are chosen over every strike in the window \(`strikes\.total` of them\), so they can sit outside the returned rows \(KBE on 2026-09-21: walls 75 and 59 with the ten default rows spanning 62 to 71\); a wall with no row here has no `callGex` or `putGex` beside it to check it against, and a wider limit returns more of them while `strikes\.returned` is below `strikes\.total`\.$/);
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
    expect(live).toMatch(/Partial values sum only supported option legs; they are not measurements of the whole book\. A leg counts toward vanna, charm and vomma only while the broker's implied volatility for it is above 1% and at most 500% and its expiration's close is more than a minute away, and toward gamma, delta and vega only while the broker publishes that Greek for it, so the included count of a partial total moves between calls, and two partial totals minutes apart can differ by which legs were summed rather than by the market \(KBE on 2026-09-18: netCharm \+4,387,168 over 80 of 106 legs at 18:56Z, -2,631,616 over 70 at 19:16Z\); the payload does not say which legs each summed\. Unmeasured or unknown values are null\. Gamma-derived levels require complete coverage\./);
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
    expect(live).toMatch(/The broker's Greeks and implied volatilities can be a snapshot older than `asOf`, which is the fetch time, and nothing in the payload dates them: Tradier's refresh about hourly \(KBE on 2026-09-18: every per-strike vega identical at 19:16Z and 19:39Z, different at 18:56Z\)\. Between refreshes the published Greeks are fixed, so with the resolved rate and yield, open interest and the summed leg set also unchanged, only spot and the clock move the totals: the per-strike gamma rows move with spot squared exactly and netGex to its rounding \(325,161 to 326,140 as spot went 66\.485 to 66\.585\)\. On an expiration day the same-day expiration stays in the window while the broker lists it \(Tradier still listed KBE's 2026-09-18 expiration 46 minutes after the close, and the route caches that list for 15 minutes, so it can be asked for that long after the listing ends\); its legs stay eligible for gamma, delta and vega under the engine's input checks \(a known open interest, finite and from 0 to 1e12; a finite gamma or delta of size at most 10, a finite vega of size at most 10,000; a finite contribution\), and drop out of vanna, charm and vomma a minute before its close\. Those three are computed from time to expiry, so on the same-day legs they change sharply with small spot moves and with the clock: charm near the money can be the largest term in the book \(a strike-66 leg with 1,000 open interest: charm 3\.3 million at 44 minutes to the close with spot 66\.485, 8,662 at 21 minutes with spot 66\.585; a one-month leg with the same open interest, in the low thousands\), and its vanna changes sign at the price where d2 is zero, 66\.0001 in the example \(higher implied volatility raises this crossing price\)\. On an expiration afternoon netCharm can be mostly the same-day legs and the clock \(KBE 2026-09-18: -2,631,616 at 19:16Z, \+8,063,999 at 19:39Z, over 70 of 106 legs both times\)\./);
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
    expect(live).toMatch(/After the close the expired legs stay inside the totals and the levels while the expiration is listed, and `window\.expirations` beside `asOf` is the only sign of it\. The flip sweep reprices each leg from its implied volatility at its time to expiry floored at one minute, so on an expiration day the same-day legs' repriced gamma narrows onto their strikes through the afternoon and holds the one-minute shape after the close, and the flip moves with the clock \(KBE 2026-09-18: 65\.56 at 19:39Z, 64\.75 at 20:05Z, on one broker snapshot, spot 66\.585 to 66\.62\)\./);
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
    expect(live).toMatch(/On an expiration day the same-day expiration stays in the window while the broker lists it \(Tradier still listed KBE's 2026-09-18 expiration 46 minutes after the close, and the route caches that list for 15 minutes, so it can be asked for that long after the listing ends\); its legs stay eligible/);
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
    expect(result.content[0].text).toContain('Retrying will not succeed');
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
      'API error (UNKNOWN_EXPIRATION): Expiration 2026-09-19 is not listed for SPY. Retrying will not succeed. availableExpirations: 2026-09-18, 2026-09-25.',
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
    for (const name of ['get_live_options_chain', 'get_options_snapshot', 'get_regime_fits', 'get_live_dealer_positioning', 'get_dealer_positioning', 'compute_black_scholes']) {
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
    // table had it null on all 10,833 on 2026-09-23.
    expect(text).toContain('`earnings-calendar` returns a bare array of {symbol, date, fiscalDateEnding, epsEstimated, epsActual, revenueEstimated, revenueActual} rows, with no time of day; fiscalDateEnding is not populated (null on every row on 2026-09-23), and the estimates and actuals are null where the source has none.');
    expect(text).not.toContain('{symbol, date, time, ...}');
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
    const pattern = /\b(?:get|query|compute|run)_[\w.-]*/gi;
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
