import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPlatformInfo } from './platformInfo.js';
import { registerAllTools } from './registry.js';
import { getMcpServerInfo } from '../server.js';
import { LiveApiClient, LiveApiError } from '../proxy/liveApiClient.js';
import { BUDGET_UNKNOWN } from './liveGuide.js';

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
    const titled = (name: string) => String(tools.find((t) => t.name === name)!.config.title);
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning', 'get_live_quote', 'get_intraday_bars', 'rank_live_skew_gex', 'get_regime_fits', 'compute_black_scholes', 'compute_scenario', 'scan_option_strategies']) {
      expect(titled(name), name).not.toMatch(/\bPro\b/);
    }
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
    const scenarioLegs = String((tools.find((t) => t.name === 'compute_scenario')!.config.inputSchema as Record<string, { description?: string }>).legs.description);
    expect(scenarioLegs).toContain('vol bumped one point');
    expect(scenarioLegs).toContain('spot a tenth of a percent, or a quarter of a one-sigma move to expiry when that is less, which is within hours of expiry at ordinary vols (about six hours at 15% vol, a day at 7%) and months out at very low vol, and then not under one node interval within the 0.1% cap, so such a leg is measured at its own scale; the third-order spot stencil one node interval wide, at least the spot bump and at most a tenth of spot');
    expect(scenario).not.toMatch(/within a day or so of expiry/);
    expect(scenarioLegs).not.toMatch(/within a day or so of expiry/);
    expect(scenario).toContain('A supplied or record entry premium carries `impliedVol` (the vol that premium implies at the leg\'s own model) and `volGapPoints` (that vol less the leg\'s, in points); both are null with `impliedVolReason` when no vol prices the premium ("below-zero-vol-value", "above-max-vol-value") or vols are not told apart there ("not-identifiable": a deep in-the-money American leg worth its intrinsic across many vols), and a premium equal to the leg\'s own price is its own vol with no gap. Past a point the answer warns: the base P&L then carries a gap that is the premium disagreeing with the vol (a broker\'s IV snapshot can lag its quote), not a move.');
    expect(scenarioLegs).toContain('A call three hours out at 7% vol kept the European twin\'s delta, gamma, charm and vanna within 3% and its color, speed and zomma within 5%, where the fixed 0.1% spot bump had read charm a fifth low');
    expect(scenario).toContain('not the European twin\'s');
    const scenarioParam = (p: string) => String((tools.find((t) => t.name === 'compute_scenario')!.config.inputSchema as Record<string, { description?: string }>)[p].description);
    expect(scenario).toContain('r and q are supplied or resolved, never defaulted (the `r` and `q` parameters say how), each option leg pricing at its own rate (`legs[i].r`), held across the whole grid, with `inputs.r` the shortest option leg\'s');
    expect(scenarioParam('r')).toContain('Supplied, it prices every leg. Omitted (with symbol), each option leg prices at its own rate, as the Strategy page prices each leg: a strategy sent from the Strategy page gives each leg the rate the page priced it with (source "record"), and otherwise the leg reads the Treasury series matched to its own tenor, named in its source (the 3-month series, with a warning, when the matched series cannot be read). A leg keeps its rate across the whole grid: days elapsed age its life, never its rate.');
    expect(scenarioParam('q')).toContain('it comes from the symbol\'s stored dividend data (its trailing yield, else its stored dividend over spot), also for a recorded strategy');
    expect(scenario).not.toContain('r is one rate for the position');
    expect(scenario).toContain('whose symbol, legs, premiums, vols, rates and spot are read from the record');
    expect(scenario).not.toContain('q the symbol\'s stored yield');
    expect(scenario).toContain('vanna, vomma, zomma and ultima per unit of volatility, not per point (per point: vanna and zomma divided by 100, vomma by 10,000, ultima by 1,000,000)');
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
    expect(description('get_live_options_chain')).not.toMatch(/openInterestByRoot|summed across the roots|before they merge/);
    expect(description('get_live_dealer_positioning')).not.toMatch(/open interest is summed per strike across them/);
    expect(description('rank_live_skew_gex')).not.toContain('whose chain came back with no strikes');
    expect(description('get_live_options_chain')).not.toMatch(/an index monthly in the morning/);
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
    expect(chain).not.toMatch(/exactly 0 or 1 next to a real two-sided quote is that solver/);
    expect(chain).not.toMatch(/real premium and a usable IV[^.]*it is the broker/);
    expect(chain).not.toMatch(/within 15 seconds is answered/);
    expect(chain).not.toMatch(/the last ones the broker holds, a bid can sit below intrinsic value/);
    const positioning = description('get_live_dealer_positioning');
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
    expect(eod.config.description).not.toMatch(/\bPro\b|subscription/);
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
      get: async (path: string, params?: Record<string, string>) => {
        // the platform default, methodology 1 as today; a public route, not one of the proxy paths pinned here
        if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
        requests.push({ path, params });
        return {};
      },
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
    expect(live).not.toMatch(/a dealer regime of positive or negative gamma|two near-term strikes|it is the sign of net gamma/);
    const regime = description('get_regime');
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
    expect(text).not.toMatch(/entered at 0\.5987 the day before/);
    expect(text).not.toMatch(/is a clipped value, not a measurement/);
    expect(text).not.toMatch(/On the market scope each driver's/);
    expect(text).toMatch(/Get regime data at one of six scopes\./);
    expect(text).not.toMatch(/stress_score/);
    expect(text).not.toMatch(/Bands: CALM|Typical bands/);
    expect(text).not.toMatch(/in session order|open to pre-close\), so/);
    expect(text).not.toMatch(/from the run's own cache/);
    expect(text).not.toMatch(/the previous stored daily label|With no such prior|same symbol, scope and model version/);
    expect(text).not.toMatch(/for a day's first intraday scan/);
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
    const wall = /the call wall is the strike with the largest positive call gamma and the put wall the strike with the most negative put gamma; ties go to the lower strike, a side with no such strike leaves that wall null, and nothing orders them, so the put wall can sit above the call wall/;
    expect(description('get_dealer_positioning')).toMatch(wall);
    expect(description('get_live_dealer_positioning')).not.toMatch(/the gamma levels that act as resistance and support/);
    const regime = description('get_regime');
    expect(regime).not.toMatch(/which prior it took, and confidence is computed from the unrounded score/);
    expect(regime).not.toMatch(/inside its label's band \(near 0 at a band edge\)|just entered from below|a curve that reaches 1 at the middle/);
    // The stamp is the run's start; rows land per symbol as each finishes.
    expect(regime).not.toMatch(/`scan_time`/);
    expect(regime).not.toMatch(/`exposuresNote` on the symbol and intraday shapes/);
    // Live: the per-strike sides and the window on a monthly-only name.
    const live = description('get_live_dealer_positioning');
    expect(live).not.toMatch(/under the same gamma coverage\./);
    expect(live).not.toMatch(/per-strike rule below|listed strike nearest spot|never read from a farther strike/);
    expect(live).not.toMatch(/operating companies only|a fund or ETF has none/);
    expect(live).not.toMatch(/calendarThrough|CalendarCovers/);
    expect(live).not.toMatch(/squeeze (score|risk|probability)/i);
    expect(live).not.toMatch(/spans three months|three months\) against/);
    const liveRange = String((tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.inputSchema as Record<string, { description?: string }>).strikeRange.description);
    expect(liveRange).not.toMatch(/a wall with no row here/);
    expect(live).not.toMatch(/rolls when a listing expires/);
    expect(liveRange).not.toMatch(/returns more rows\./);
    // review: with null IV on every leg the flip's coverage is
    // complete and gammaFlipMethod "frozen-gamma", so no leg was repriced.
    expect(live).not.toMatch(/the flip's repriced-gamma coverage/);
    expect(live).not.toMatch(/null\.Gamma/);
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
    const eodDate = String((tools.find((t) => t.name === 'get_dealer_positioning')!.config.inputSchema as Record<string, { description?: string }>).date.description);
    expect(eodDate).toContain('A not-found for a weekday date inside the window is marked retryable until 09:30 US Eastern on the following calendar day, this tool\'s cutoff, not a producer deadline (the producer has none); a market holiday, a futures contract or a name with no near-term options stays not-found, and the date alone cannot tell those apart.');
    expect(eodDate).toContain('After the cutoff the answer says retrying will not succeed: that is the proxy\'s flag for a row absent on the normal schedule, not a promise that the file can never arrive, since a session whose import or exposure computation failed can appear after a later successful import or repair, and nothing here says whether one is coming.');
    expect(eodDate).toContain('The equity import is scheduled for 01:00 US Eastern the next day, retried in half-hour steps to about 06:00 and later when it has days to catch up, and usually lands about 02:30 (02:31 to 02:34 for every session from 2026-09-08 to 09-17); the newest on file can be older when an import is late.');
    expect(eod).toContain('The equity import usually lands about 02:30 US Eastern the next day, so in the evening the most recent on file is usually the previous session');
    expect(eod).toContain('`sincePriorSession` compares this session with the one before it on file, from the same stored end-of-day computation over the same 0-60 day window: `prior` holds that session\'s levels, `change` this session minus that one (null where either is missing), and `dealerRegimeChanged` whether the regime differs;');
    expect(eod).toContain('`sessionsSkipped` counts the NYSE sessions between `priorDate` and `date`, none of which has a summary on file (0: none falls between).');
    expect(eod).toMatch(/Both flips are found on a grid of 60 prices within 20% of each session's spot, about 0\.68% of spot apart and re-centred every session, so a flip change smaller than that step can come from the grid rather than the market\./);
    expect(eod).toContain('`status` is "none-on-file" when no earlier session has a summary and "unavailable" when it could not be read; this session\'s values are unaffected either way.');
    expect(eod).toMatch(/It is a close-to-close change on file, not a change to now: the live book comes from get_live_dealer_positioning, over a different window and computation, and differencing the two is not a change\./);
    // Seventeenth run: the window admits tomorrow's date, and "was a trading
    // session" read wrong for it (2026-09-22 asked for at 13:47 ET on 09-21).
    expect(`${eod} ${eodDate}`).not.toMatch(/was a trading session/);
    expect(`${eod} ${eodDate}`).not.toMatch(/today or later in New York is not final|For an earlier date a not-found is final|says the file is not on file yet|the end of the overnight import window|is re-run later, and the session appears|until 08:00 US Eastern/);
    expect(eodDate).toContain('Accepted from 1990-01-01 to one day past the current UTC date, the proxy\'s window, which moves forward with the date: a later weekday date is rejected as INVALID_REQUEST until the window reaches it, marked retryable with the UTC day it can be asked for from, and a later weekend date keeps the rejection as final, since it is never a session.');
    expect(eodDate).toMatch(/^Session date in YYYY-MM-DD\. Defaults to the most recent session on file, whatever its date; read `date` in the result\. Accepted from 1990-01-01/);
    expect(live).not.toMatch(/a refresh moves the levels/);
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

  test('the tools that read the public internet at call time declare openWorldHint true; stored-data reads stay false', () => {
    // OpenAI's Apps SDK reference: openWorldHint is true "when a tool accesses the public internet or open-ended external
    // entities, including through read-only actions such as web search"; false is for a bounded private account or
    // workspace. These four proxy routes fetch public sources live:
    // SEC EDGAR (filings, 13D/13G) and the NYSE and Nasdaq halt feeds; get_rates' benchmark falls back to a live public rate
    // feed when the synced store is missing or stale (matched-tenor and yield-curve reads are stored data only).
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    // Include optional views, cache misses,
    // enrichments and default compute inputs. Broker market-data reads are open;
    // stored catalogs, user records and local computation are bounded.
    const open = [
      'get_rates', 'get_sec_filings', 'get_trading_halts', 'get_activist_filings',
      'get_live_quote', 'get_live_options_chain', 'get_live_dealer_positioning',
      'scan_option_strategies', 'rank_live_skew_gex', 'get_intraday_bars',
    ];
    const bounded = [
      'get_iv_history', 'get_greeks_history', 'get_regime', 'get_earnings', 'get_news',
      'get_short_data', 'get_fundamentals', 'get_dividends', 'get_insider_trading',
      'get_institutional_ownership', 'get_congress_trades', 'get_options_analytics_history',
      'get_iv_surface', 'get_stock_prices', 'get_stock_splits', 'get_analyst_data',
      'get_market_calendar', 'get_options_chain', 'get_options_snapshot', 'get_regime_fits',
      'get_dealer_positioning', 'compute_black_scholes', 'compute_scenario',
      'get_fail_to_deliver', 'get_threshold_history', 'get_dark_pool_data',
      'get_platform_info', 'get_custom_indicator_spec', 'get_analysis_history',
      'get_snapshot', 'get_analysis_rollups', 'get_fft_results', 'query_analysis',
      'get_compute_runs', 'get_company_profile', 'run_screener',
    ];
    // A newly registered tool must be audited, not silently defaulted to false.
    expect(tools.map((t) => t.name).sort()).toEqual([...open, ...bounded].sort());
    const hint = (name: string) => (tools.find((t) => t.name === name)!.config.annotations as Record<string, unknown>).openWorldHint;
    for (const name of open) expect(hint(name), name).toBe(true);
    for (const name of bounded) expect(hint(name), name).toBe(false);
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
        // the platform default, read before the positioning and not recorded
        if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
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
      get: async (path: string) => (path === '/exposure/methodology' ? { defaultMethodology: 1, stale: false } : {
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
    expect(text).toContain('Numbers go out at 15 significant digits at most, each change computed as the exact difference of the two stored values before that rounding.');
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
    expect(text).toContain("It spends the user's own broker quota, metered in the broker's own requests (a chain is 2 on Tradier and Public, 1 on Schwab, 2 plus one per 100 listed contracts on tastytrade, counted across every root before they merge, and on moomoo 2 reserved, settled to its contract list when not cached for the day plus one snapshot per 400 codes, the underlying's among them) against the broker's own quota (120 a minute on Tradier, Schwab and tastytrade, 600 on Public, 30 on moomoo) shared with the other live tools, so prefer it when the question is about current or intraday prices, and the end-of-day tools otherwise.");
    expect(text).not.toMatch(/weighted unit|10-unit/);
  });

  // moomoo, the fifth broker: every live tool takes it by name, prices
  // it in its own requests at its own budget, and says what it does and does
  // not publish - including that its option quotes may be delayed, unmarked,
  // on an account without real-time option permission.
  test('moomoo is in every live tool: its name, its budget, its costs and what it publishes', async () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = (name: string) => String(tools.find((t) => t.name === name)!.config.description);
    const live = ['get_live_options_chain', 'get_live_quote', 'get_intraday_bars', 'rank_live_skew_gex', 'get_live_dealer_positioning', 'scan_option_strategies'];
    for (const name of live) {
      const provider = (tools.find((t) => t.name === name)!.config.inputSchema as Record<string, z.ZodTypeAny>).provider;
      expect(provider.safeParse('moomoo').success, name).toBe(true);
      if (name !== 'get_live_quote' && name !== 'get_intraday_bars') expect(text(name), name).toMatch(/30 on moomoo/);
    }
    expect(text('get_live_options_chain')).toMatch(/on moomoo 2 reserved and settled to what it spent/);
    expect(text('get_intraday_bars')).toMatch(/tastytrade, Public and moomoo/);
    // A fully cold figure, not a ceiling: cached contract lists refund the rest (review).
    expect(text('rank_live_skew_gex')).toMatch(/moomoo\'s 30 about three fully cold ones/);
    expect(text('get_live_dealer_positioning')).toMatch(/about three fully cold calls a minute on its 30/);
    expect(text('get_live_dealer_positioning')).not.toMatch(/at most three a minute/);
    for (const name of ['get_live_options_chain']) {
      expect(text(name), name).toContain('one snapshot per 400 codes, the underlying\'s among them');
      expect(text(name), name).not.toContain('per 400 contracts');
    }
    expect(text('scan_option_strategies')).toMatch(/on moomoo 3 reserved and settled to what it spent/);
    expect(text('get_live_dealer_positioning')).toMatch(/3 reserved on moomoo and settled to what it spent/);
    expect(text('rank_live_skew_gex')).toMatch(/2 reserved on moomoo/);
    const info: any = await tools.find((t) => t.name === 'get_platform_info')!.handler({ topic: 'capabilities' });
    const platform = String(info.structuredContent.text);
    expect(platform).toMatch(/30 on moomoo/);
    expect(platform).toContain("on moomoo 2 reserved, settled to its contract list when not cached for the day plus one snapshot per 400 codes, the underlying's among them");
    expect(platform).toMatch(/tastytrade, Public and moomoo/);
  });

  test('analyst data says how its estimates and rating streaks are ordered', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_analyst_data')!.config.description as string;
    expect(text).toContain('`estimates` lists forward periods first, soonest first, then past periods newest first, so the nearest forward periods are the ones kept');
    expect(text).toContain('Each rating streak runs from `fromDate`, its oldest observation, through `throughDate`, its newest, and the streaks are newest first.');
    expect(text).toContain('`ratingCounts` is how many analysts rate the stock strong buy, buy, hold, sell and strong sell in the newest monthly count, with its `month` and `total`; it is given only while that month is at most two months back');
    expect(text).toContain('`ratingSnapshot` and the `historicalRating` streaks are a quantitative model grade from six valuation and financial measures, each scored 1 to 5, not analysts\' ratings.');
    expect(text).toContain('the year\'s whole count only when `countComplete` (the list on file reaches back past the year; otherwise the year holds at least that many)');
    expect(text).toContain('`priceTargets` is null, with `priceTargetsNote`, when individual targets have not been fetched yet.');
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
    expect(text).toContain("Its `delta` is share-equivalent, summed across underlyings with no price weighting, while `details.greeks.dollarDelta` (and `dollarGamma`) weights each position by its own underlying's price, so the two can differ in size and even in sign when positions span underlyings priced far apart.");
  });

  test('the snapshot tool says the strategy type holds definitions only and points at compute_scenario', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = tools.find((t) => t.name === 'get_snapshot')!.config.description as string;
    expect(text).toContain('type="strategy"');
    expect(text).toContain('Definitions only, never computed outputs.');
    expect(text).toContain('Price or stress type="strategy" with compute_scenario by its `strategyKey`, without retyping legs.');
    expect(text).toContain('Send to assistant');
    expect(text).toContain('the page\'s inputs (spot, rate and dividend yield, each with its source; the rate\'s `rateSeries` for the shortest option leg; the volatility mode the legs were priced with and the model)');
    expect(text).toContain('implied vols, and each option leg\'s `rate` with `rateSeries`, the Treasury series matched to its own expiration; null for a manual page\'s one rate, absent on older definitions)');
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

  test('the compute, live-chain and risk tools distinguish their pricing and risk conventions', () => {
    // A tester took a Heston "success" with 0% inside bid/ask and a count of 6
    // models beside 5 outcomes for defects, identical call and put theta for a
    // shaping bug, and a rejected stress row (+7,057 at -10%) for a risk result.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const description = (name: string) => tools.find((t) => t.name === name)!.config.description as string;
    expect(description('get_compute_runs')).toContain("A calibration status of success means the model produced usable fitted parameters; how well they fit is in its confidence and warnings, so a success can carry a warning such as few prices staying within bid/ask. calibratedModelCount counts the models carrying a calibration, including MonteCarlo-Heston, which reuses Heston's fit and has no calibration outcome of its own, so it can exceed the number of outcomes.");
    expect(description('get_snapshot')).toContain('A figure or stress row with contractStatus "rejected" (calculationAccepted false) is display-only, whether its inputs were fallback or degraded or changed after it was computed (a stale_snapshot reason; displayReasons say which): it is not a valid risk result, so report it as unavailable.');
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
    expect(result.content[0].text).toBe(
      `API error (UNKNOWN_EXPIRATION): Expiration 2026-09-19 is not listed for SPY. Retrying the same request will not succeed. ${BUDGET_UNKNOWN} availableExpirations: 2026-09-18, 2026-09-25.`,
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
      // Parsed through the tool's own input schema, as the SDK does: a review
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
    for (const name of ['scan_option_strategies', 'get_live_dealer_positioning']) {
      expect(String(tools.find((t) => t.name === name)!.config.description), name).not.toMatch(/profile_yield\" \(a fund/);
    }
    expect(text).not.toMatch(/probability of (?:success|winning)|best trade|recommend/i);
  });

  test('each live tool reports the live-broker budget the proxy gave, and nothing when it gave none', async () => {
    // proxy/lib/liveBrokerLimiter.ts sets RateLimit-* on every admitted request;
    // LiveApiClient.get hands them to the tool.
    const budget = { limit: 10, remaining: 8, resetSeconds: 43 };
    for (const report of [true, false]) {
      const live = {
        get: async (path: string, _params?: Record<string, string>, onRateLimit?: (r: typeof budget) => void) => {
          if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
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
      get: async (path: string, _params?: Record<string, string>, onRateLimit?: (r: unknown) => void) => {
        if (path === '/exposure/methodology') return { defaultMethodology: 1, stale: false };
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
    const chain = text('get_live_options_chain');
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning']) {
      const expiration = (tools.find((t) => t.name === name)!.config.inputSchema as Record<string, z.ZodTypeAny>).expiration;
      expect(expiration.safeParse('2026-9-28').success, name).toBe(false);
      expect(expiration.safeParse('2026-02-30').success, name).toBe(true);
    }
    expect(chain).not.toContain('front month');
    const bars = text('get_intraday_bars');
    expect(bars).toContain('After this call, it gives `remaining` of `limit` in broker requests (`provider` names the broker), resetting in `resetSeconds`; an error after the live-broker limiter ran carries it beside `code` (a charged failure, or its own RATE_LIMITED refusal, which charges nothing), one refused before it (a malformed date, a missing credential) none.');
    expect(bars).toContain('1 request on Tradier or Schwab, each metering 120 a minute shared with the other live tools');
    expect(bars).toContain('BROKER_RATE_LIMITED (retryable; wait `retryAfterSeconds` when given)');
    expect(bars).not.toMatch(/weighted unit|10-unit|10 units/);
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
    for (const name of ['get_live_dealer_positioning', 'scan_option_strategies']) {
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
    expect(text('get_live_options_chain')).not.toContain('The delta and the quote beside it are still the broker');
    for (const name of ['get_live_quote', 'get_live_options_chain', 'get_intraday_bars', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex']) expect(text(name), name).not.toContain('answered SPX\'s expirations with a 400');
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex', 'get_live_quote']) {
      expect(text(name), name).not.toMatch(/publishes no trade time|gives no print time|always on tastytrade/);
    }
    expect(text('scan_option_strategies')).not.toContain('the last session\'s, at the broker');
    const quote = text('get_live_quote');
    expect(quote).not.toMatch(/so a computed change of 0 after hours is that roll, not a flat day/);
    // tastytrade's market-data spec publishes `last-trade-time` ("Epoch timestamp of the last trade"), and the shared
    // quote reads it, so the trade time is real there.
    expect(quote).not.toMatch(/publishes no trade time|tastytrade's one clock/);
    for (const name of ['get_live_quote', 'get_live_options_chain', 'get_intraday_bars', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex']) {
      expect(text(name), name).not.toMatch(/brokerError|never its body/);
    }
    expect(text('get_intraday_bars')).toContain('A repeat (same symbol, date, interval, session, broker and account) within 15 seconds can be answered from a short in-memory cache with the same `asOf`, spending no broker request, so it is not charged and is answered even when the budget is spent; the cache is per proxy instance, so a repeat can also be fetched afresh, and another account\'s call never shares it.');
  });

  test('the live tools name the credential store they read', () => {
    // A user whose account page said Connected (a browser connection) got
    // BROKER_NOT_CONNECTED; the tools read only the opt-in stored credential.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    for (const name of ['get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'get_live_quote', 'get_intraday_bars', 'rank_live_skew_gex']) {
      const text = String(tools.find((t) => t.name === name)!.config.description);
      expect(text, name).toContain('Requires a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool.');
      expect(text, name).not.toContain('a broker connected under Account -> Broker.');
    }
  });

  test('the live watchlist ranking states its budget, its re-call contract, its method and its own budget block', () => {
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'rank_live_skew_gex')!.config.description);
    expect(text).toContain('fresh fetches spend your own broker quota and MAY SPEND ALL OF IT. Further requests to that broker can then be refused (RATE_LIMITED) until the window resets; cache-only answers can still be served.');
    expect(text).not.toContain('or "no-qualifying-expiration" when nothing is 7 days out');
    expect(text).not.toContain('or its own rate-limit refusal (RATE_LIMITED, which charges nothing)');
    expect(text).not.toContain('Every number goes out at 15 significant digits at most.');
    expect(text).toContain('so on a long list a row can be older than `maxAgeSeconds` (fifty symbols on Tradier take about five minutes a round): ask for fewer symbols for fresher rows.');
    expect(text).not.toContain('`complete` is false until nothing is pending');
    expect(text).not.toContain('Schwab prints none on index options');
  });


  test('the live dealer tool says why its rate is dated a session or two back', () => {
    // resolved.r.asOf read two sessions back on 2026-09-23 (DGS3MO's newest
    // row was 2026-09-21): FRED posts a day's value the next business day and
    // the sync runs at 18:30 New York, so that is the newest value there is.
    const { tools, server } = captureRegisteredTools();
    registerAllTools(server as any, stubClient(), stubTokens(), stubClient());
    const text = String(tools.find((t) => t.name === 'get_live_dealer_positioning')!.config.description);
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
    // The two conventions differ on dcharmDvol by 100 and on the time signs;
    // "per day" on both sides hid the first and the second went unsaid.
    expect(text).toContain('dcharmDvol by 100');
    // The time-convention change: the web app's time Greeks are on the time-passing sign on a
    // tagged record, the remaining-maturity sign (charm, color, dcharmDvol) on
    // a legacy one. dapi's five are time-passing since 2026-10-13, named by
    // greekTimeConvention, and an untagged dapi response is the old sign
    expect(text).toContain('dapi and a web record tagged "time-passing" carry all five time Greeks on the same time-passing sign, while a legacy web record\'s charm, color and dcharmDvol differ in sign from dapi\'s');
    expect(text).toContain('every response names it as greekTimeConvention: "time-passing"; a dapi response without that tag predates 2026-10-13 and carries charm, color, dcharmDvol and veta on the opposite, remaining-maturity sign');
    expect(text).toContain('dcharmDvol per day per unit of volatility');
    expect(text).not.toContain('not negated');
    // The dealer exposure sweeps keep their own (unchanged) sign, said in words
    expect(text).toContain('Dealer exposure charm is NOT on the time-passing sign');
    expect(text).toContain('dealer dollar charm per calendar day on the remaining-maturity sign for the dealer - one day of time passing moves the dealers\' dollar delta by minus it');
    // dcharmDvol is the day's change in vanna (the daily charm per unit of volatility), not the day's change in charm
    const bs = on.tools.find((t) => t.name === 'compute_black_scholes')!;
    expect((bs as any).config.description).toContain('which is the day\'s change in vanna');
    expect((bs as any).config.description).not.toContain('dcharmDvol in charm');
    expect(displayBullet).toContain('greekTimeConvention "time-passing"');
    expect(displayBullet).toContain('legacy: model-dependent time sign');
    expect(rollupsLine).toContain('avgThetaConvention');
    // Review: the rollup's day, and the compute run tag's scope beside the exposure sweep's own charm
    expect(rollupsLine).toContain('avgThetaBasis "tradingDay"');
    expect(displayBullet).toContain('covers the model Greeks and their aggregates only (greekTimeScope), NOT its exposure sweep');
    expect(displayBullet).toContain('remaining-maturity sign per calendar day (charm per year / 365) times open interest, multiplier and spot, negated for the dealer (exposureSweepCharmConvention)');
    // Review: a tagged record or run is per trading day; the scaler's other defaults and the pages' display
    // toggle never reach a saved record
    expect(displayBullet).toContain('where a tagged record or run stores the day as a trading day (greekTimeBasis "tradingDay": 252 a year)');
    expect(displayBullet).toContain('and the pages\' calendar or trading day display toggle are separate and never reach a saved record');
    expect(displayBullet).not.toContain('calendar days otherwise');
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

async function publishedTools() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  const stub = { get: async () => ({}), post: async () => ({}) } as any;
  registerAllTools(server, stub, { getAccessToken: async () => 'token' } as any, stub);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

const DATA_AVAILABLE = 'False when no data was returned: nothing matched, or the call failed (a failed call also carries error and code).';
const MAX_AGE_SECONDS = 'Seconds, 15 to 900, default 120. A cached row younger than this is served again at no cost; only a row older than this is refreshed. This is not how long rows are cached (15 minutes per account, broker, symbol and session). Within a call the symbols with no cached value are queued first and the older rows after them, oldest first, dispatched concurrently as the call\'s budget and deadlines allow, without waiting for every symbol to have a value; a row not refreshed in time is served as it is, with its `ageSeconds`, marked `stale` and listed in `refreshPending`, so on a long list a row can be older than this.';
const ENVELOPE_VALIDATION = {
  type: 'object',
  properties: {
    dataAvailable: { type: 'boolean' }, message: { type: 'string' }, note: { type: 'string' }, data: {}, summary: {},
    count: { type: 'number' }, symbol: { type: ['string', 'null'] }, source: { type: 'string' }, status: { type: 'string' },
    responseBudget: {},
  },
  $schema: 'http://json-schema.org/draft-07/schema#',
  additionalProperties: {},
};
const withoutDescriptions = (o: unknown): unknown => Array.isArray(o) ? o.map(withoutDescriptions)
  : o !== null && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'description').map(([k, v]) => [k, withoutDescriptions(v)]))
    : o;
const descriptionPaths = (o: unknown, path = ''): string[] => Array.isArray(o) ? o.flatMap((v, i) => descriptionPaths(v, `${path}[${i}]`))
  : o !== null && typeof o === 'object'
    ? Object.entries(o).flatMap(([k, v]) => (k === 'description' ? [path || '(root)'] : descriptionPaths(v, path ? `${path}.${k}` : k)))
    : [];

describe('output-schema prose', () => {
  test('the 44 generic envelopes publish no prose but dataAvailable\'s corrected description, validation unchanged', async () => {
    const tools = await publishedTools();
    const envelopes = tools.filter((t) => JSON.stringify(withoutDescriptions(t.outputSchema)) === JSON.stringify(ENVELOPE_VALIDATION));
    expect(envelopes).toHaveLength(44);
    for (const tool of envelopes) {
      expect(descriptionPaths(tool.outputSchema), tool.name).toEqual(['properties.dataAvailable']);
      expect((tool.outputSchema as any).properties.dataAvailable.description, tool.name).toBe(DATA_AVAILABLE);
    }
  });

  test('the two reference schemas are unchanged, prose included', async () => {
    const tools = await publishedTools();
    const sha = (name: string) => createHash('sha256').update(JSON.stringify(tools.find((t) => t.name === name)!.outputSchema)).digest('hex');
    expect(sha('get_platform_info')).toBe('0a04d0dff2e66f073f487dc693db546719f35618cf68b03f8f2caeb5c79db181');
    expect(sha('get_custom_indicator_spec')).toBe('bc305f0c04653177d6075557b9305fe8c6826223ba8b624a72c212b2b38a7873');
    expect(tools.filter((t) => !['get_platform_info', 'get_custom_indicator_spec'].includes(t.name)
      && JSON.stringify(withoutDescriptions(t.outputSchema)) !== JSON.stringify(ENVELOPE_VALIDATION))).toEqual([]);
  });

  test('rank_live_skew_gex maxAgeSeconds says what an older row does; its validation is unchanged', async () => {
    const tools = await publishedTools();
    const prop = (tools.find((t) => t.name === 'rank_live_skew_gex')!.inputSchema as any).properties.maxAgeSeconds;
    expect(prop).toEqual({ description: MAX_AGE_SECONDS, type: 'integer', minimum: 15, maximum: 900 });
    expect(prop.description).not.toContain('only after every symbol without a value');
  });

  test('every live tool\'s provider names the stored-credential default and its order; the enum is unchanged', async () => {
    const tools = await publishedTools();
    const provider = (name: string) => (tools.find((t) => t.name === name)!.inputSchema as any).properties.provider;
    const ENUM = ['tradier', 'tastytrade', 'public', 'schwab', 'moomoo'];
    for (const name of ['get_live_quote', 'get_live_options_chain', 'get_live_dealer_positioning', 'scan_option_strategies', 'rank_live_skew_gex']) {
      expect(provider(name), name).toEqual({ type: 'string', enum: ENUM, description: PROVIDER });
    }
    expect(provider('get_intraday_bars')).toEqual({ type: 'string', enum: ENUM, description: BARS_PROVIDER });
    expect(tools.filter((t) => (t.inputSchema as any).properties?.provider).map((t) => t.name).sort()).toEqual(
      ['get_intraday_bars', 'get_live_dealer_positioning', 'get_live_options_chain', 'get_live_quote', 'rank_live_skew_gex', 'scan_option_strategies']);
  });

  test('scan_option_strategies levels states its cost in chains; its values are unchanged', async () => {
    const tools = await publishedTools();
    const prop = (tools.find((t) => t.name === 'scan_option_strategies')!.inputSchema as any).properties.levels;
    expect(prop).toEqual({ type: 'string', enum: ['expiration', 'window'], description: LEVELS });
  });
});

const PROVIDER = 'Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo.';
const BARS_PROVIDER = 'Which stored broker credential to use. Defaults to the first one stored, in the order Tradier, tastytrade, Public, Schwab, moomoo; bars need Tradier or Schwab, so name one of them when another is stored first.';
const LEVELS = 'Which book the dealer levels come from: "expiration" (default, this expiration\'s chain, no extra requests) or "window" (the four nearest expirations that may still trade, up to four more chains).';
