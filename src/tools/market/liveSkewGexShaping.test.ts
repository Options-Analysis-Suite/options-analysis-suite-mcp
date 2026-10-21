import { describe, expect, test } from 'bun:test';
import { applyResponseSizeGuard, MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { LIVE_SKEW_GEX_MARGIN_BYTES, LIVE_SKEW_GEX_UNITS, shapeLiveSkewGex } from './liveSkewGexShaping.js';

/** One answered symbol as the proxy's skewGexResponseBody writes it. */
function result(symbol: string, over: { skew?: Record<string, unknown> | null; gex?: Record<string, unknown> | null; warnings?: string[] } = {}) {
  const skew = over.skew === null ? undefined : {
    status: 'ok', value: 0.052, callIv25d: 0.18, putIv25d: 0.232, ivSkew10d: 0.09, expiration: '2026-11-20', dte: 31,
    prior: { value: 0.047, status: 'ok' }, change: 0.005,
    asOf: '2026-10-20T15:00:00.000Z', ageSeconds: 4, baselineDate: '2026-10-19', ...over.skew,
  };
  const gex = over.gex === null ? undefined : {
    status: 'ok', value: 1_250_000_000, expirations: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'],
    gammaCoverage: { total: 400, included: 400 }, oiShare: 1,
    strikeCoverage: { strikes: 200, strikesOtmSide: 120, strikesFilled: 80, strikesNoIv: 0 },
    prior: { value: 1_000_000_000, oiShare: 1, status: 'ok' }, change: 250_000_000, changePct: 0.25,
    asOf: '2026-10-20T15:00:00.000Z', ageSeconds: 4, baselineDate: '2026-10-19', ...over.gex,
  };
  return {
    symbol,
    spot: { value: 500.25, time: '2026-10-20T14:59:58.000Z', stale: false },
    valuation: 'now',
    q: { value: 0.012, source: 'ratios_ttm', asOf: '2026-10-19' },
    rates: [
      { expiration: '2026-10-20', value: 0.0412, source: 'DGS1MO', asOf: '2026-10-17' },
      { expiration: '2026-11-20', value: 0.0405, source: 'DGS1MO', asOf: '2026-10-17' },
    ],
    baseline: { status: 'found', date: '2026-10-19', sessionsSkipped: 0, spot: 498.1, missingExpirations: [] },
    ...(skew ? { skew } : {}),
    ...(gex ? { gex } : {}),
    ...(over.warnings ? { warnings: over.warnings } : {}),
  };
}

function body(results: unknown[], over: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1, dataSource: 'live', provider: 'tradier', asOf: '2026-10-20T15:00:04.000Z',
    session: { liveSessionDate: '2026-10-20', marketOpen: true, valuation: 'now' },
    method: { id: 'own-model-v1', skew: 'definition text' },
    notes: { openInterest: 'timing text', levels: 'levels text' },
    metrics: ['skew', 'gex'], maxAgeSeconds: 120,
    results, pending: [], refreshPending: [], errors: [], retryAfterSeconds: null, complete: true,
    ...over,
  };
}

const wire = (value: unknown) => sanitizeMcpWireOutput(value) as any;

describe('rank_live_skew_gex shaping', () => {
  test('the proxy\'s open-interest timing and closed-market notes reach the answer as given', () => {
    const notes = { openInterest: 'the live open interest is the count published before today\'s session', levels: 'levels text', sessionClosed: 'The market is closed: valued at the last session\'s close' };
    const out = wire(shapeLiveSkewGex(body([result('SPY')], { notes }), { requestedSymbols: ['SPY'] }));
    expect(out.notes).toEqual(notes);
  });

  test('a row carries spot, both metrics with prior, change, age and baseline, the yield, and the units', () => {
    const out = wire(shapeLiveSkewGex(body([result('SPY')]), { requestedSymbols: ['SPY'] }));
    expect(out.results[0]).toEqual({
      symbol: 'SPY', spot: 500.25, spotTime: '2026-10-20T14:59:58.000Z', spotStale: false,
      skew: {
        value: 0.052, status: 'ok', putIv25d: 0.232, callIv25d: 0.18, skew10d: 0.09, expiration: '2026-11-20', dte: 31,
        prior: 0.047, priorStatus: 'ok', change: 0.005, ageSeconds: 4,
      },
      gex: {
        value: 1_250_000_000, status: 'complete', oiShare: 1,
        expirations: ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23'],
        strikes: { otmSide: 120, filled: 80, noIv: 0 },
        prior: 1_000_000_000, priorOiShare: 1, priorStatus: 'ok', change: 250_000_000, changePercent: 25, ageSeconds: 4,
      },
      baseline: { date: '2026-10-19', status: 'found', spot: 498.1 },
      q: { value: 0.012, source: 'ratios_ttm', asOf: '2026-10-19' },
      stale: false,
    });
    expect(out.units).toEqual(LIVE_SKEW_GEX_UNITS);
    expect(out).toMatchObject({ dataSource: 'live', provider: 'tradier', complete: true, retryAfterSeconds: null, requested: 1, returned: 1 });
    expect(out.session).toEqual({ liveSessionDate: '2026-10-20', marketOpen: true, valuation: 'now' });
    expect(out.omitted).toBeUndefined();
    expect(out.rankMeta).toBeUndefined();
  });

  test('model outputs go out at 6 significant digits and dollar GEX to the dollar; prices as the broker gave them', () => {
    const out = wire(shapeLiveSkewGex(body([{
      ...result('SPY', {
        skew: { value: 0.0446311321861118, putIv25d: 0.225865700076235, callIv25d: 0.181234567890123, ivSkew10d: 0.0912345678901234, prior: { value: 0.0372076552867343, status: 'ok' }, change: 0.00742347689937747 },
        gex: { value: -4467060501.62345, prior: { value: 2708172477.4321, oiShare: 0.999876543210987, status: 'ok' }, change: -7175232979.05555, changePct: -2.64947415238058, oiShare: 0.98765432109876 },
      }),
      // Seven digits, as an index prints: a price is never cut to six.
      spot: { value: 7754.325, time: null, stale: false },
      q: { value: 0.0105360457517737, source: 'index_constituents', asOf: '2026-10-07' },
      baseline: { status: 'found', date: '2026-10-19', sessionsSkipped: 0, spot: 7760.115, missingExpirations: [] },
    }]), { requestedSymbols: ['SPY'] }));
    const row = out.results[0];
    expect(row.skew).toMatchObject({ value: 0.0446311, putIv25d: 0.225866, callIv25d: 0.181235, skew10d: 0.0912346, prior: 0.0372077, change: 0.00742348 });
    expect(row.gex).toMatchObject({ value: -4467060502, prior: 2708172477, change: -7175232979, changePercent: -264.947, oiShare: 0.987654, priorOiShare: 0.999877 });
    expect(row.q.value).toBe(0.0105360);
    expect(row.spot).toBe(7754.325);
    expect(row.baseline.spot).toBe(7760.115);
  });

  test('a percentage that comes out a whole number is cut to six digits too', () => {
    // Review: significant() leaves integers as they are, so a prior near 0
    // gave a seven-digit changePercent the description says goes out at six.
    const out = wire(shapeLiveSkewGex(body([result('AAA', { gex: { changePct: 12345.25 } })]), { requestedSymbols: ['AAA'] }));
    expect(out.results[0].gex.changePercent).toBe(1234530);
  });

  test('a row says its valuation, a skipped session and a missing expiration only where there is something to say', () => {
    const plain = result('AAA');
    const odd = { ...result('BBB'), valuation: 'session-close', baseline: { status: 'found', date: '2026-10-16', sessionsSkipped: 1, spot: 498.1, missingExpirations: ['2026-10-23'] } };
    const out = wire(shapeLiveSkewGex(body([plain, odd]), { requestedSymbols: ['AAA', 'BBB'] }));
    expect(out.session.valuation).toBe('now');
    expect('valuation' in out.results[0]).toBe(false);
    expect(out.results[0].baseline).toEqual({ date: '2026-10-19', status: 'found', spot: 498.1 });
    expect(out.results[1].valuation).toBe('session-close');
    expect(out.results[1].baseline).toEqual({ date: '2026-10-16', status: 'found', sessionsSkipped: 1, spot: 498.1, missingExpirations: ['2026-10-23'] });
  });

  test('a metric names its own baseline date only where it differs from the row\'s', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA', { skew: { baselineDate: '2026-10-16' } })]), { requestedSymbols: ['AAA'] }));
    expect(out.results[0].skew.baselineDate).toBe('2026-10-16');
    expect(out.results[0].gex.baselineDate).toBeUndefined();
  });

  test('a failed check keeps its name, expiration and days, with a null value and no prior', () => {
    const out = wire(shapeLiveSkewGex(body([
      result('AAA', { skew: { status: 'curve-gate', value: null, callIv25d: null, putIv25d: null, ivSkew10d: null, expiration: '2026-11-20', dte: 31, prior: { value: null, status: 'not-measured-live' }, change: null } }),
      result('BBB', { skew: { status: 'no-qualifying-expiration', value: null, callIv25d: null, putIv25d: null, ivSkew10d: null, expiration: null, dte: null, prior: { value: null, status: 'not-measured-live' }, change: null } }),
    ]), { requestedSymbols: ['AAA', 'BBB'] }));
    expect(out.results[0].skew).toMatchObject({ status: 'curve-gate', value: null, expiration: '2026-11-20', dte: 31, prior: null, priorStatus: 'not-measured-live', change: null });
    expect(out.results[1].skew).toMatchObject({ status: 'no-qualifying-expiration', expiration: null, dte: null });
  });

  test('the change percent is the proxy\'s fraction in percent, and null beside a zero prior', () => {
    const out = wire(shapeLiveSkewGex(body([
      result('AAA', { gex: { changePct: -0.125 } }),
      result('BBB', { gex: { prior: { value: 0, oiShare: 1, status: 'ok' }, change: 5, changePct: null } }),
    ]), { requestedSymbols: ['AAA', 'BBB'] }));
    expect(out.results[0].gex.changePercent).toBe(-12.5);
    expect(out.results[1].gex.changePercent).toBeNull();
  });

  test('no leg sized is no number: unmeasured, null, its change withheld; partial coverage keeps the value and says so', () => {
    const out = wire(shapeLiveSkewGex(body([
      result('AAA', { gex: { status: 'unmeasured', value: null, gammaCoverage: { total: 120, included: 0 }, change: 9, changePct: 0.1 } }),
      result('BBB', { gex: { gammaCoverage: { total: 400, included: 350 }, oiShare: 0.9 } }),
      // A proxy that called it ok with nothing sized is not believed.
      result('CCC', { gex: { status: 'ok', value: 7, gammaCoverage: { total: 10, included: 0 } } }),
      // No leg carried open interest at all: still the documented "unmeasured", never another label.
      result('DDD', { gex: { status: 'unmeasured', value: null, gammaCoverage: { total: 0, included: 0 }, oiShare: null } }),
    ]), { requestedSymbols: ['AAA', 'BBB', 'CCC', 'DDD'] }));
    expect(out.results[0].gex).toMatchObject({ value: null, status: 'unmeasured', change: null, changePercent: null, legCoverage: { total: 120, included: 0 } });
    expect(out.results[1].gex).toMatchObject({ value: 1_250_000_000, status: 'partial', change: 250_000_000, oiShare: 0.9 });
    expect(out.results[1].gex.legCoverage).toEqual({ total: 400, included: 350 });
    expect(out.results[2].gex).toMatchObject({ value: null, status: 'unmeasured', change: null });
    expect(out.results[3].gex).toMatchObject({ value: null, status: 'unmeasured', change: null, legCoverage: { total: 0, included: 0 } });
  });

  test('the expiration lists the proxy names are carried only when present', () => {
    const out = wire(shapeLiveSkewGex(body([
      result('SPX', { gex: { emptyExpirations: ['2026-10-21'], openInterestUnpublishedExpirations: ['2026-10-22', 'not-a-date'] } }),
      result('SPY'),
    ]), { requestedSymbols: ['SPX', 'SPY'] }));
    expect(out.results[0].gex.emptyExpirations).toEqual(['2026-10-21']);
    expect(out.results[0].gex.openInterestUnpublishedExpirations).toEqual(['2026-10-22']);
    expect(out.results[1].gex.emptyExpirations).toBeUndefined();
    expect(out.results[1].gex.openInterestUnpublishedExpirations).toBeUndefined();
  });

  test('a level ranks by value, a change by its size with the sign kept, a missing figure last and named', () => {
    const results = [
      result('AAA', { skew: { value: 0.03, change: -0.02 }, gex: { change: 10, changePct: 0.01 } }),
      result('BBB', { skew: { value: 0.08, change: 0.004 }, gex: { change: -900, changePct: -0.5 } }),
      result('CCC', { skew: { status: 'curve-gate', value: null, change: null }, gex: { change: 300, changePct: 0.2 } }),
      result('DDD', { skew: { value: 0.05, change: 0.02 }, gex: null }),
    ];
    const ranked = (rankBy: any, order?: any) => wire(shapeLiveSkewGex(body(results), { requestedSymbols: ['AAA', 'BBB', 'CCC', 'DDD'], rankBy, order }));
    expect(ranked('skew').results.map((r: any) => r.symbol)).toEqual(['BBB', 'DDD', 'AAA', 'CCC']);
    expect(ranked('skew').rankMeta).toEqual({ rankBy: 'skew', order: 'desc', by: 'value', ranked: 3, unranked: 1, unrankedSymbols: ['CCC'] });
    expect(ranked('skew', 'asc').results.map((r: any) => r.symbol)).toEqual(['AAA', 'DDD', 'BBB', 'CCC']);
    // -0.02 and +0.02 tie on size: the order asked for decides; the sign stays.
    const change = ranked('skewChange');
    expect(change.results.map((r: any) => [r.symbol, r.skew?.change ?? null])).toEqual([['AAA', -0.02], ['DDD', 0.02], ['BBB', 0.004], ['CCC', null]]);
    expect(change.rankMeta.by).toBe('size of the change, sign kept in the value');
    expect(ranked('gexChange').results.map((r: any) => r.symbol)).toEqual(['BBB', 'CCC', 'AAA', 'DDD']);
    expect(ranked('gexChange').rankMeta.unrankedSymbols).toEqual(['DDD']);
    expect(ranked('gexChangePercent').results.map((r: any) => [r.symbol, r.gex?.changePercent ?? null])).toEqual([['BBB', -50], ['CCC', 20], ['AAA', 1], ['DDD', null]]);
    expect(ranked('gex', 'asc').results.map((r: any) => r.symbol)).toEqual(['AAA', 'BBB', 'CCC', 'DDD']);
  });

  test('without rankBy the rows stay in the proxy\'s order, which is the order asked for after its spelling', () => {
    const out = wire(shapeLiveSkewGex(body([result('BRK.B'), result('AAPL')]), { requestedSymbols: ['BRK-B', 'AAPL'] }));
    expect(out.results.map((r: any) => r.symbol)).toEqual(['BRK.B', 'AAPL']);
  });

  test('limit keeps the best-ranked rows and names the rest in omitted', () => {
    const results = ['AAA', 'BBB', 'CCC'].map((symbol, i) => result(symbol, { skew: { value: 0.01 * (i + 1) } }));
    const out = wire(shapeLiveSkewGex(body(results), { requestedSymbols: ['AAA', 'BBB', 'CCC'], rankBy: 'skew', limit: 1 }));
    expect(out.results.map((r: any) => r.symbol)).toEqual(['CCC']);
    expect(out.returned).toBe(1);
    expect(out.omitted).toEqual({ count: 2, byLimit: ['BBB', 'AAA'] });
  });

  test('fifty full rows fit the response ceiling; rows past it are named, never trimmed silently', () => {
    // THE LIVE RUN'S LIST AND ITS NUMBERS AS THE PROXY SENDS THEM. The first
    // version of this test used short literals (0.052, 500.25) and passed while
    // a real fifty-symbol answer - doubles of 16 and 17 digits - held 46 rows
    // (2026-10-08). Every number below has a double's full length, every row
    // both metrics with a prior and a change, and all fifty are stale (all in
    // refreshPending), the market closed, five refreshes failed and five rows
    // carry the proxy's dividend caveat.
    const symbols = 'IWM,DIA,XLF,XLE,XLK,GLD,SLV,TLT,HYG,EEM,MSFT,AMZN,GOOGL,META,AMD,NFLX,AVGO,ORCL,CRM,ADBE,INTC,MU,QCOM,JPM,BAC,C,WFC,GS,MS,XOM,CVX,BA,CAT,DIS,NKE,KO,PEP,WMT,COST,HD,UNH,PFE,MRK,ABBV,LLY,V,MA,PYPL,UBER,COIN'.split(',');
    const texts = {
      method: { id: 'own-model-v1', iv: 'm'.repeat(150), strikeIv: 'm'.repeat(220), greeks: 'm'.repeat(200), skew: 'm'.repeat(250), gex: 'm'.repeat(200), baseline: 'm'.repeat(200) },
      notes: { openInterest: 'n'.repeat(380), levels: 'n'.repeat(160), sessionClosed: 'n'.repeat(220) },
    };
    const long = (base: number, i: number) => base * (1 + i * 0.0123456789012345) + base * 1.234567890123e-13;
    const dates = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-16', '2026-10-23', '2026-10-30', '2026-11-06', '2026-11-20'];
    const full = symbols.map((symbol, i) => ({
      ...result(symbol, {
        skew: {
          value: long(0.0446311321861118, i), callIv25d: long(0.181234567890123, i), putIv25d: long(0.225865700076235, i), ivSkew10d: long(0.0912345678901234, i),
          expiration: '2026-11-06', dte: 29, prior: { value: long(0.0372076552867343, i), status: 'ok' }, change: long(0.00742347689937747, i),
          ageSeconds: 538, baselineDate: '2026-10-07',
        },
        gex: {
          value: long(-4467060501.12345, i), expirations: dates.slice(i % 2, (i % 2) + 4),
          // Five rows partial (as off hours), the rest complete as in the live run.
          gammaCoverage: { total: 1844, included: i % 10 === 3 ? 1843 : 1844 }, oiShare: long(0.999876543210987, i),
          strikeCoverage: { strikes: 922, strikesOtmSide: 410, strikesFilled: 511, strikesNoIv: 1 },
          prior: { value: long(2708172477.98765, i), oiShare: long(0.999123456789012, i), status: 'ok' },
          change: long(-7175232978.4321, i), changePct: long(-2.64947415238058, i), ageSeconds: 538, baselineDate: '2026-10-07',
        },
        ...(i % 10 === 0 ? { warnings: ['w'.repeat(200)] } : {}),
      }),
      // Prices in cents, as the brokers quote them and the stored median gives them.
      spot: { value: Math.round(long(197.95, i) * 100) / 100, time: '2026-10-08T19:59:59.000Z', stale: false },
      valuation: 'session-close',
      q: { value: long(0.0105360457517737, i), source: 'ratios_ttm', asOf: '2026-10-07' },
      rates: [0, 1, 2, 3, 8].map((k) => ({ expiration: dates[(k + i) % 10], value: long(0.0412, (k + i) % 10), source: 'DGS1MO', asOf: '2026-10-07' })),
      baseline: { status: 'found', date: '2026-10-07', sessionsSkipped: 0, spot: Math.round(long(199.12, i) * 100) / 100, missingExpirations: [] },
    }));
    const failed = symbols.slice(0, 5).map((symbol) => ({
      symbol, status: 503, code: 'BROKER_UNAVAILABLE', error: 'tradier did not answer the chain request', retryable: true,
      message: 'The broker did not answer in time. Retry after a short wait; the rest of the list was answered.', brokerFailure: 'timeout', brokerStatus: null,
    }));
    const closed = { ...texts, session: { liveSessionDate: '2026-10-08', marketOpen: false, valuation: 'session-close' }, refreshPending: symbols, errors: failed, retryAfterSeconds: 57 };
    const budget = { limit: 120, remaining: 0, resetSeconds: 59, provider: 'tradier' };
    const out = wire(shapeLiveSkewGex(body(full, closed), { requestedSymbols: symbols, rateLimit: budget }));
    expect(out.returned).toBe(50);
    expect(out.omitted).toBeUndefined();
    expect(out.rateLimit).toEqual(budget);
    expect(out.guide.rateLimit).toMatch(/budget after this call/);
    const size = utf8ByteLength(JSON.stringify(out));
    expect(size).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES);
    expect(JSON.parse(applyResponseSizeGuard(out))).toEqual(out);

    // Rows heavier than anything the proxy sends: the ceiling, not the generic guard, decides.
    const heavy = symbols.map((symbol) => result(symbol, { warnings: Array.from({ length: 5 }, () => 'w'.repeat(400)) }));
    const capped = wire(shapeLiveSkewGex(body(heavy), { requestedSymbols: symbols }));
    expect(capped.returned).toBeLessThan(50);
    expect(capped.omitted.count).toBe(50 - capped.returned);
    expect(capped.omitted.bySize).toEqual(symbols.slice(capped.returned));
    expect(utf8ByteLength(JSON.stringify(capped))).toBeLessThan(MAX_RESPONSE_BYTES);
    // Each warning is cut to 240 characters, three at most.
    expect(capped.results[0].warnings).toHaveLength(3);
    expect(capped.results[0].warnings[0]).toHaveLength(240);
  });

  test('pending, refreshPending, the wait and completeness pass through; a stale served row is flagged', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA'), result('BBB')], {
      pending: [{ symbol: 'CCC', metrics: ['skew', 'gex'], reason: 'budget' }, { symbol: 'BBB', metrics: ['skew'], reason: 'in-progress' }],
      refreshPending: ['BBB'], retryAfterSeconds: 42, complete: false,
    }), { requestedSymbols: ['AAA', 'BBB', 'CCC'] }));
    expect(out.pending).toEqual([{ symbol: 'CCC', metrics: ['skew', 'gex'], reason: 'budget' }, { symbol: 'BBB', metrics: ['skew'], reason: 'in-progress' }]);
    expect(out.refreshPending).toEqual(['BBB']);
    expect(out.results.map((r: any) => [r.symbol, r.stale])).toEqual([['AAA', false], ['BBB', true]]);
    expect(out).toMatchObject({ complete: false, retryAfterSeconds: 42, requested: 3, returned: 2 });
  });

  test('errors keep the code, retryability, the reason and the corrective message, nothing else', () => {
    const out = wire(shapeLiveSkewGex(body([], {
      errors: [
        { symbol: 'VIX', status: 422, error: 'Could not resolve q for VIX', code: 'RESOLUTION_FAILED', retryable: false, missingFields: ['q'], warnings: ['no yield'], message: 'use get_live_dealer_positioning with q' },
        { symbol: 'ZZZ', status: 503, error: 'tradier returned no usable spot price for ZZZ', code: 'BROKER_UNAVAILABLE', retryable: true, provider: 'tradier', brokerFailure: 'no-usable-answer', brokerStatus: null },
      ],
    }), { requestedSymbols: ['VIX', 'ZZZ'] }));
    expect(out.errors).toEqual([
      { symbol: 'VIX', status: 422, code: 'RESOLUTION_FAILED', error: 'Could not resolve q for VIX', retryable: false, message: 'use get_live_dealer_positioning with q', missingFields: ['q'], warnings: ['no yield'] },
      { symbol: 'ZZZ', status: 503, code: 'BROKER_UNAVAILABLE', error: 'tradier returned no usable spot price for ZZZ', retryable: true, brokerFailure: 'no-usable-answer', brokerStatus: null },
    ]);
  });

  test('each rate once, by expiration, in date order', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA'), result('BBB')]), { requestedSymbols: ['AAA', 'BBB'] }));
    expect(out.rates).toEqual([
      { expiration: '2026-10-20', value: 0.0412, source: 'DGS1MO', asOf: '2026-10-17' },
      { expiration: '2026-11-20', value: 0.0405, source: 'DGS1MO', asOf: '2026-10-17' },
    ]);
  });

  test('a metric not requested is not shown even if a cached row carries it', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA')], { metrics: ['gex'] }), { requestedSymbols: ['AAA'] }));
    expect(out.results[0].skew).toBeUndefined();
    expect(out.results[0].gex.value).toBe(1_250_000_000);
  });
});

// Rows the broker left out are carried on the gex and skew blocks.
describe('rows left out', () => {
  const OMITTED = { total: 4, quarantined: 4, invalidStrike: 0, notSuccess: 0, unquoted: 0 };
  test('gex and skew carry omittedRows; none, no field', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA', { gex: { omittedRows: OMITTED }, skew: { omittedRows: { ...OMITTED, total: 1, quarantined: 1 } } }), result('BBB')]), { requestedSymbols: ['AAA', 'BBB'] }));
    const aaa = out.results.find((r: any) => r.symbol === 'AAA');
    expect(aaa.gex.omittedRows).toEqual(OMITTED);
    expect(aaa.skew.omittedRows).toEqual({ ...OMITTED, total: 1, quarantined: 1 });
    const bbb = out.results.find((r: any) => r.symbol === 'BBB');
    expect(bbb.gex.omittedRows).toBeUndefined();
  });

  test('a partial window or skew is marked, its change as the proxy withheld it (review)', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAA', { gex: { partial: true, change: null, changePct: null }, skew: { partial: true, change: null } }), result('BBB')]), { requestedSymbols: ['AAA', 'BBB'] }));
    const aaa = out.results.find((r: any) => r.symbol === 'AAA');
    expect(aaa.gex.partial).toBe(true);
    expect(aaa.gex.change).toBeNull();
    expect(aaa.skew.partial).toBe(true);
    expect(aaa.skew.change).toBeNull();
    const bbb = out.results.find((r: any) => r.symbol === 'BBB');
    expect(bbb.gex.partial).toBeUndefined();
    expect(bbb.skew.partial).toBeUndefined();
  });
});

// Review: the ranking names an adjusted series (a
// digit root, a different deliverable) it left out, a window date listed only
// under one, and the series a skew of a multi-root date was read from.
describe('rank_live_skew_gex: adjusted series and the skew\'s series', () => {
  const GEX_WARNING = '7 contracts under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) are left out of the GEX, which measures the symbol\'s own contracts alone, so a "complete" status does not include them; 2026-10-21 is listed only under adjusted series, so it adds nothing.';
  const rateWarning = 'Risk-free: DGS1MO unavailable; falling back to DGS3MO';

  test('carries the exclusions and a note on each metric; the proxy\'s own sentence is not relayed twice, other warnings are', () => {
    const out = wire(shapeLiveSkewGex(body([result('AAPL', {
      gex: { expirations: ['2026-10-20', '2026-10-22', '2026-10-23'], adjustedOnlyExpirations: ['2026-10-21'], excludedRoots: [{ root: 'AAPL1', contracts: 7 }] },
      skew: { excludedRoots: [{ root: 'AAPL1', contracts: 1 }] },
      warnings: [rateWarning, GEX_WARNING],
    })]), { requestedSymbols: ['AAPL'] }));
    const row = out.results[0];
    expect(row.gex).toMatchObject({ status: 'complete', adjustedOnlyExpirations: ['2026-10-21'], excludedRoots: [{ root: 'AAPL1', contracts: 7 }], excludedRootsNote: GEX_WARNING });
    expect(row.gex).not.toHaveProperty('emptyExpirations');
    expect(row.gex).not.toHaveProperty('partial');
    expect(row.skew).toMatchObject({ excludedRoots: [{ root: 'AAPL1', contracts: 1 }], excludedRootsNote: '1 contract under the AAPL1 root (an adjusted series, a different deliverable at the same strikes) is left out of the skew\'s expiration, whose smile is read from the symbol\'s own contracts alone.' });
    expect(row.warnings).toEqual([rateWarning]);
  });

  test('names the series a skew was read from on a date under several roots', () => {
    const out = wire(shapeLiveSkewGex(body([result('SPX', { skew: { root: 'SPXW' } })]), { requestedSymbols: ['SPX'] }));
    expect(out.results[0].skew.root).toBe('SPXW');
  });

  test('a plain row names none of it (control)', () => {
    const out = wire(shapeLiveSkewGex(body([result('SPY', { warnings: [rateWarning] })]), { requestedSymbols: ['SPY'] }));
    for (const key of ['adjustedOnlyExpirations', 'excludedRoots', 'excludedRootsNote']) expect(out.results[0].gex).not.toHaveProperty(key);
    for (const key of ['root', 'excludedRoots', 'excludedRootsNote']) expect(out.results[0].skew).not.toHaveProperty(key);
    expect(out.results[0].warnings).toEqual([rateWarning]);
  });
});

describe('shapeLiveSkewGex guide', () => {
  const BUDGET = { limit: 120, remaining: 90, resetSeconds: 25, provider: 'tradier' };
  const shape = (rows: unknown[], over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    wire(shapeLiveSkewGex(body(rows, over) as any, { requestedSymbols: rows.map((r: any) => r.symbol), ...opts } as any));
  const g = (rows: unknown[] = [result('SPY')], over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    shape(rows, over, opts).guide as Record<string, string>;

  test('units carries the precision rule on every answer', () => {
    expect(shape([result('SPY')]).units.precision).toMatch(/6 significant digits/);
  });

  test('the skew gate legend per status present, an unreadable status, no qualifying expiration', () => {
    expect(g().skewGate).toBeUndefined();
    const gated = g([result('SPY', { skew: { status: 'wing-iv', value: null, change: null } })]);
    expect(gated.skewGate).toMatch(/"wing-iv"/);
    expect(gated.skewGate).toMatch(/outside regular hours/);
    expect(gated.skewGate).not.toMatch(/"curve-gate"/);
    expect(g([result('SPY', { skew: { status: null, value: null } })]).skewGate).toMatch(/unknown/);
    expect(g([result('SPY', { skew: { status: 'no-qualifying-expiration', value: null, expiration: null, dte: null } })]).skewNoExpiration).toMatch(/at least 7 days out/);
  });

  test('the prior legend per status present, the baseline legend, missing expirations', () => {
    expect(g().prior).toBeUndefined();
    expect(g([result('SPY', { skew: { status: 'curve-gate', value: null, prior: { value: null, status: 'not-measured-live' }, change: null } })]).prior).toMatch(/"not-measured-live"/);
    const baseline = g([{ ...result('SPY', { gex: { prior: { value: null, status: 'baseline-spot-missing' }, change: null } }), baseline: { status: 'found', date: '2026-10-19', spot: null, missingExpirations: ['2026-10-23'] } }]);
    expect(baseline.prior).toMatch(/"baseline-spot-missing"/);
    expect(baseline.prior).toMatch(/missingExpirations/);
    expect(g([{ ...result('SPY'), baseline: { status: 'unavailable', date: null } }]).prior).toMatch(/"unavailable"/);
  });

  test('the GEX window, its comparison, the strike sources and the series rule, whenever gex is asked for', () => {
    const x = g();
    expect(x.gexWindow).toMatch(/4:15 PM New York/);
    expect(x.gexComparison).toMatch(/neither can be subtracted/);
    expect(x.strikes).toMatch(/otmSide/);
    expect(x.roots).toMatch(/every retained same-deliverable series/);
    const skewOnly = g([result('SPY', { gex: null })], { metrics: ['skew'] }, { });
    expect(skewOnly.gexWindow).toBeUndefined();
    expect(g([result('SPX', { skew: { root: 'SPX' } })]).roots).toMatch(/skew is read from one series/);
  });

  test('the GEX status legend per status present, the null sentence beside a null value', () => {
    expect(g().gexStatus).toMatch(/"complete"/);
    expect(g().gexStatus).not.toMatch(/never a measured 0/);
    const unmeasured = g([result('SPY', { gex: { status: 'unmeasured', value: null, gammaCoverage: { total: 10, included: 0 }, change: null, changePct: null } })]);
    expect(unmeasured.gexStatus).toMatch(/"unmeasured"/);
    expect(unmeasured.gexStatus).toMatch(/never a measured 0/);
  });

  test('a null change is withheld, not "no change"', () => {
    expect(g().changeWithheld).toBeUndefined();
    expect(g([result('SPY', { skew: { change: null } })]).changeWithheld).toMatch(/never "no change"/);
  });

  test('the window\'s gaps when present', () => {
    expect(g().openInterestUnpublished).toBeUndefined();
    const unpublished = g([result('SPY', { gex: { openInterestUnpublishedExpirations: ['2026-10-23'] } })]).openInterestUnpublished;
    expect(unpublished).toMatch(/counted and left out/);
    expect(unpublished).toMatch(/may not be like for like/);
    expect(g([result('SPY', { gex: { emptyExpirations: ['2026-10-22'] } })]).emptyExpirations).toMatch(/change stands/);
    expect(g([result('SPY', { gex: { adjustedOnlyExpirations: ['2026-10-22'] } })]).adjustedOnly).toMatch(/no outage/);
    expect(g([result('SPY', { gex: { omittedRows: { quarantined: 1, invalidStrike: 0, notSuccess: 0, unquoted: 0, total: 1 } } })]).omittedRows).toMatch(/quarantined/);
    expect(g([result('SPY', { gex: { partial: true } })]).partial).toMatch(/could not be read whole/);
    expect(g().partial).toBeUndefined();
  });

  test('skipped sessions, a row valued otherwise, the spot clock, an index yield, moomoo', () => {
    expect(g().sessionsSkipped).toBeUndefined();
    expect(g([{ ...result('SPY'), baseline: { status: 'found', date: '2026-10-16', sessionsSkipped: 1, spot: 498 } }]).sessionsSkipped).toMatch(/that many more sessions/);
    expect(g().valuation).toBeUndefined();
    expect(g([{ ...result('SPY'), valuation: 'close' }]).valuation).toMatch(/its own valuation/);
    expect(g().spotClock).toMatch(/spotStale/);
    expect(g([result('SPY')], { provider: 'moomoo' }).spotClock).toMatch(/moomoo[^.]*update time/);
    expect(g([{ ...result('SPX'), q: { value: 0.013, source: 'index_constituents', asOf: '2026-10-19' } }]).indexYield).toMatch(/basket-derived/);
    expect(g().moomooDelay).toBeUndefined();
    expect(g([result('SPY')], { provider: 'moomoo' }).moomooDelay).toMatch(/15 minutes/);
  });

  test('stale rows, pending reasons, completion', () => {
    expect(g().stale).toBeUndefined();
    const stale = g([result('SPY')], { refreshPending: ['SPY'], complete: true, retryAfterSeconds: 30 }).stale;
    expect(stale).toMatch(/priority, not a barrier/);
    expect(stale).not.toMatch(/once every symbol has a value/);
    const pending = g([result('SPY')], { pending: [{ symbol: 'QQQ', metrics: ['skew', 'gex'], reason: 'time' }], complete: false, retryAfterSeconds: 20 });
    expect(pending.pending).toMatch(/"time"/);
    expect(pending.pending).not.toMatch(/"budget"/);
    expect(pending.complete).toMatch(/retryAfterSeconds/);
    expect(g().complete).toBeUndefined();
  });

  test('per-symbol errors - the list never fails, one legend sentence per code present, the misdirecting messages corrected', () => {
    expect(g().errorCodes).toBeUndefined();
    const errors = [
      { symbol: 'XYZQ', status: 404, code: 'NO_EXPIRATIONS', error: 'tradier lists no option expirations for XYZQ', retryable: false },
      { symbol: 'AAPL', status: 422, code: 'ADJUSTED_SERIES_ONLY', error: 'only adjusted series. Ask for another expiration.', retryable: false },
      { symbol: 'NDX', status: 503, code: 'UPSTREAM_UNAVAILABLE', error: 'the stored yield could not be read; retry, or supply the fields explicitly', retryable: true },
      { symbol: 'MSFT', status: 502, code: 'BROKER_REJECTED', error: 'rejected', retryable: false },
      { symbol: 'TSLA', status: 502, code: 'BROKER_REJECTED', error: 'rejected', retryable: false },
    ];
    const codes = g([result('SPY')], { errors }).errorCodes;
    expect(codes).toMatch(/never fails the list/);
    expect(codes).toMatch(/NO_EXPIRATIONS/);
    expect(codes).toMatch(/no expiration parameter/);
    expect(codes).toMatch(/takes no supplied r or q/);
    expect(codes.match(/BROKER_REJECTED:/g)?.length).toBe(1);
    expect(codes).toMatch(/provider parameter/);
  });

  test('unranked rows and ties when ranked; omitted rows answered free from the cache', () => {
    expect(g().ranking).toBeUndefined();
    const ranked = g([result('SPY'), result('QQQ', { skew: { value: null, status: 'wing-iv', change: null } })], {}, { rankBy: 'skew' });
    expect(ranked.ranking).toMatch(/never ranked as 0/);
    expect(ranked.ranking).toMatch(/ties keep the order asked for/);
    expect(g().omitted).toBeUndefined();
    expect(g([result('SPY'), result('QQQ')], {}, { limit: 1 }).omitted).toMatch(/no cost/);
  });

  test('the budget line and the cost mechanics when they apply; rateLimit inside the answer', () => {
    const out = shape([result('SPY')], { pending: [{ symbol: 'QQQ', metrics: ['gex'], reason: 'in-progress' }], complete: false }, { rateLimit: BUDGET });
    expect(out.rateLimit).toEqual(BUDGET);
    expect(out.guide.rateLimit).toMatch(/budget after this call/);
    expect(out.guide.cost).toMatch(/counts when it is sent/);
    expect(out.guide.cost).toMatch(/remaining can read low/);
    expect(g().cost).toBeUndefined();
    expect(shape([result('SPY')]).rateLimit).toBeUndefined();
  });

  test('the fifty-row case with errors and every predicate it can make true: the guide whole, inside the ranking\'s own budget', () => {
    const rows = Array.from({ length: 50 }, (_, i) => result(`S${i}`, { gex: { partial: true, emptyExpirations: ['2026-10-22'], openInterestUnpublishedExpirations: ['2026-10-23'] }, skew: { status: 'curve-gate', value: null, change: null } }));
    const errors = Array.from({ length: 30 }, (_, i) => ({ symbol: `E${i}`, status: 502, code: 'BROKER_UNAVAILABLE', error: 'x'.repeat(200), retryable: true, brokerFailure: 'timeout' }));
    const out = shape(rows, { errors, refreshPending: ['S1'], complete: false, retryAfterSeconds: 10, pending: [{ symbol: 'P', metrics: ['gex'], reason: 'budget' }] }, { rateLimit: BUDGET });
    expect(out.guide.errorCodes).toMatch(/BROKER_UNAVAILABLE/);
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES);
    if (out.returned < 50) expect(out.guide.omitted).toBeDefined();
  });
});

describe('ranking', () => {
  const BUDGET = { limit: 120, remaining: 90, resetSeconds: 25, provider: 'tradier' };
  const shape = (rows: unknown[], over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    wire(shapeLiveSkewGex(body(rows, over) as any, { requestedSymbols: rows.map((r: any) => r.symbol), ...opts } as any));
  test('only moomoo and tastytrade get the dynamic-chain and oversized-symbol cost mechanics', () => {
    for (const provider of ['tradier', 'schwab', 'public', 'moomoo', 'tastytrade']) {
      for (const rateLimit of [{ ...BUDGET, provider }, null]) {
        const line = shape([result('SPY')], {
          provider, pending: [{ symbol: 'QQQ', metrics: ['gex'], reason: 'in-progress' }],
        }, { rateLimit }).guide.cost;
        expect(line).toMatch(/counts when it is sent/);
        expect(line).toMatch(/remaining can read low/);
        if (provider === 'moomoo' || provider === 'tastytrade') {
          expect(line).toContain(`${provider} settles`);
          expect(line).toMatch(/longer than its share reserves the rest/);
          expect(line).toMatch(/bigger than the whole budget runs alone.*charged in full/);
        } else {
          expect(line).not.toMatch(/moomoo|tastytrade|longer than its share|bigger than the whole budget/);
        }
      }
      const pending = shape([result('SPY')], {
        provider, pending: [{ symbol: 'QQQ', metrics: ['gex'], reason: 'budget' }],
      }).guide.cost;
      if (provider === 'moomoo' || provider === 'tastytrade') expect(pending).toMatch(/bigger than the whole budget/);
      else expect(pending).toBeUndefined();
    }
  });
  test('the spot clock says null is unknown, never fresh, also with no session on file', () => {
    const line = shape([result('SPY')]).guide.spotClock;
    expect(line).toMatch(/never fresh/);
    expect(line).toMatch(/no session is on file/);
  });
  test('pinned: fifty rows beside thirty errors keep the guide whole and move rows to omitted.bySize', () => {
    const rows = Array.from({ length: 50 }, (_, i) => result(`S${i}`, { gex: { partial: true, emptyExpirations: ['2026-10-22'], openInterestUnpublishedExpirations: ['2026-10-23'] }, skew: { status: 'curve-gate', value: null, change: null } }));
    const errors = Array.from({ length: 30 }, (_, i) => ({ symbol: `E${i}`, status: 502, code: 'BROKER_UNAVAILABLE', error: 'x'.repeat(200), retryable: true, brokerFailure: 'timeout' }));
    const out = shape(rows, { errors, refreshPending: ['S1'], complete: false, retryAfterSeconds: 10, pending: [{ symbol: 'P', metrics: ['gex'], reason: 'budget' }] }, { rateLimit: BUDGET });
    expect(out.returned).toBeLessThan(50);
    expect(out.omitted.bySize.length).toBe(50 - out.returned);
    expect(out.guide.omitted).toMatch(/bySize/);
  });
});

describe('ranking unknowns, independent cached metrics and the final fit', () => {
  const shape = (rows: unknown[], over: Record<string, unknown> = {}, opts: Record<string, unknown> = {}) =>
    wire(shapeLiveSkewGex(body(rows, over), { requestedSymbols: rows.map((r: any) => r.symbol), ...opts }));

  test('an absent or unknown provider gets only general cost facts', () => {
    for (const provider of [null, undefined, 'unrecognized']) {
      const out = shape([result('SPY')], { provider }, { rateLimit: null });
      expect(out.guide.cost).toMatch(/counts when it is sent/);
      expect(out.guide.cost).not.toMatch(/moomoo|tastytrade|400 codes|100 contracts|bigger than the whole budget/);
      expect(out.guide.rateLimit).toMatch(/unknown/);
    }
    expect(shape([result('SPY')], { provider: 'tastytrade' }, { rateLimit: null }).guide.cost).toMatch(/tastytrade settles/);
  });

  test('a missing prior status is unknown, never silently omitted or treated as ok', () => {
    for (const status of [null, undefined]) {
      const out = shape([result('SPY', {
        skew: { prior: { value: null, status }, change: null },
        gex: { prior: { value: null, status }, change: null, changePct: null },
      })]);
      expect(out.guide.prior).toMatch(/priorStatus[^.]*not reported|priorStatus[^.]*could not be read/);
      expect(out.guide.prior).toMatch(/unknown/);
      expect(out.results[0].skew.prior).toBeNull();
      expect(out.results[0].gex.prior).toBeNull();
    }
    const baselineUnknown = shape([{ ...result('SPY'), baseline: { status: null, date: null } }]);
    expect(baselineUnknown.guide.prior).toMatch(/baseline.status[^.]*unknown/);
    expect(shape([result('SPY')]).guide.prior).toBeUndefined();
  });

  test('row baseline metadata does not null a prior from an independently cached metric', () => {
    // skewGexResponseBody takes row metadata from the newer entry while keeping each metric's own prior and date.
    const out = shape([{
      ...result('SPY', { skew: { prior: { value: null, status: 'unavailable' }, change: null, baselineDate: null } }),
      baseline: { status: 'unavailable', date: null, spot: null },
    }]);
    expect(out.results[0].gex.prior).toBe(1_000_000_000);
    expect(out.results[0].gex.baselineDate).toBe('2026-10-19');
    expect(out.guide.prior).not.toMatch(/leaves every prior null/);
    expect(out.guide.prior).toMatch(/each metric[^.]*priorStatus/);
    for (const status of ['none-on-file', 'unavailable']) {
      const oldPrior = shape([result('SPY', { gex: { prior: { value: null, status }, change: null, changePct: null } })]);
      expect(oldPrior.results[0].baseline.status).toBe('found');
      expect(oldPrior.guide.prior).toContain(`"${status}"`);
      expect(oldPrior.guide.prior).toMatch(status === 'unavailable' ? /failed or slow read/ : /no prior session on file/);
    }
  });

  test('failed-read missingExpirations is not proof of absent stored expirations, and metric dates have a row fallback', () => {
    const out = shape([{
      ...result('SPY', { skew: { prior: { value: null, status: 'unavailable' }, change: null } }),
      baseline: { status: 'unavailable', date: null, spot: null, missingExpirations: ['2026-11-20'] },
    }]);
    expect(out.guide.prior).toMatch(/missingExpirations[^.]*only when baseline.status is "found"/);
    expect(out.guide.prior).toMatch(/"unavailable"[^.]*requested dates[^.]*not proof/);
    expect(out.guide.prior).toMatch(/baselineDate[^.]*otherwise[^.]*baseline.date/);
  });

  test('a missing pending reason is explicitly not reported, alone or with a known reason', () => {
    for (const reason of [null, undefined]) {
      const pending = [{ symbol: 'SPY', metrics: ['skew'], reason }];
      const out = shape([], { pending, complete: false });
      expect(out.guide.pending).toMatch(/reason[^.]*not reported/);
      expect(out.guide.pending).toMatch(/only metrics with no value/);
      expect(out.guide.pending).not.toMatch(/"budget"/);
      const mixed = shape([], { pending: [...pending, { symbol: 'QQQ', metrics: ['gex'], reason: 'time' }], complete: false });
      expect(mixed.guide.pending).toMatch(/reason[^.]*not reported/);
      expect(mixed.guide.pending).toMatch(/"time"/);
    }
    expect(shape([]).guide.pending).toBeUndefined();
  });

  test('RESOLUTION_FAILED covers a missing rate for a stock as well as an index yield', () => {
    const out = shape([], { errors: [
      { symbol: 'AAA', status: 422, code: 'RESOLUTION_FAILED', error: 'Could not resolve r for AAA', retryable: false, missingFields: ['r'] },
      { symbol: 'VIX', status: 422, code: 'RESOLUTION_FAILED', error: 'Could not resolve q for VIX', retryable: false, missingFields: ['q'] },
    ] });
    expect(out.guide.errorCodes).toMatch(/RESOLUTION_FAILED:[^.]*rate[^.]*yield/);
    expect(out.guide.errorCodes).toMatch(/missingFields/);
    expect(out.guide.errorCodes).toMatch(/takes no supplied/);
    expect(out.guide.errorCodes.match(/RESOLUTION_FAILED:/g)).toHaveLength(1);
    expect(out.errors[0].missingFields).toEqual(['r']);
  });

  test('the fit includes omitted.bySize metadata before selecting the final rows', () => {
    const rows = Array.from({ length: 50 }, (_, i) => result(`S${i}`, { warnings: ['w'.repeat(240), 'w'.repeat(240), 'w'.repeat(240)] }));
    const errors = Array.from({ length: 2 }, (_, i) => ({ symbol: `S${i}`, status: 502, code: 'BROKER_UNAVAILABLE', error: 'x'.repeat(180), retryable: true, brokerFailure: 'timeout' }));
    const out = shape(rows, { errors }, { rateLimit: { limit: 120, remaining: 0, resetSeconds: 59, provider: 'tradier' } });
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES);
    expect(out.returned).toBeGreaterThan(0);
    expect(out.returned).toBeLessThan(50);
    expect(out.omitted.bySize).toEqual(rows.slice(out.returned).map((r) => r.symbol));
    expect(JSON.parse(applyResponseSizeGuard(out))).toEqual(out);
  });

  test('legal row warnings can cause size omissions without any errors', () => {
    const rows = Array.from({ length: 50 }, (_, i) => result(`S${i}`, { warnings: ['w'.repeat(240), 'w'.repeat(240), 'w'.repeat(240)] }));
    const out = shape(rows);
    expect(out.errors).toHaveLength(0);
    expect(out.omitted.bySize.length).toBeGreaterThan(0);
    expect(out.guide.omitted).not.toMatch(/only beside many errors|fifty rows fit/);
    expect(out.guide.omitted).toMatch(/computed and are cached/);
    expect(out.results[0].warnings).toEqual(['w'.repeat(240), 'w'.repeat(240), 'w'.repeat(240)]);
  });

  test('a zero prior withholds only the percent change, not the measured level or dollar change', () => {
    const out = shape([result('SPY', { gex: { prior: { value: 0, status: 'ok', oiShare: 1 }, change: 1_250_000_000, changePct: null } })]);
    expect(out.results[0].gex).toMatchObject({ value: 1_250_000_000, prior: 0, change: 1_250_000_000, changePercent: null });
    expect(out.guide.changeWithheld).toMatch(/changePercent[^.]*prior is 0/);
    expect(out.guide.changeWithheld).toMatch(/does not withhold[^.]*level[^.]*dollar change/);
    expect(out.guide.changeWithheld).not.toMatch(/null change is withheld with its level/);
  });

  test('defensive unknown and unavailable statuses do not invent unread counts or sized legs', () => {
    const inconsistent = shape([result('SPY', { gex: { value: 12, gammaCoverage: { total: 0, included: 0 } } })]);
    expect(inconsistent.results[0].gex).toMatchObject({ status: 'unknown', value: null, legCoverage: { total: 0, included: 0 } });
    expect(inconsistent.guide.gexStatus).toMatch(/"unknown"[^.]*inconsistent/);
    const emptyMissing = shape([result('SPY', { gex: { value: null, gammaCoverage: { total: 0, included: 0 } } })]);
    expect(emptyMissing.results[0].gex.status).toBe('unavailable');
    expect(emptyMissing.guide.gexStatus).toMatch(/"unavailable"[^.]*no value/);
    expect(emptyMissing.guide.gexStatus).not.toMatch(/legs were sized/);
  });

  test('fifty rows with every guide predicate and all status legends fit together with errors and rateLimit', () => {
    const omittedRows = { quarantined: 1, invalidStrike: 1, notSuccess: 1, unquoted: 1, total: 4 };
    const skewStatuses = ['curve-gate', 'delta-gate', 'wing-iv', null, 'no-qualifying-expiration', 'ok'];
    const priorStatuses = ['not-measured-live', 'curve-gate', 'delta-gate', 'wing-iv', 'baseline-expiration-missing', 'baseline-spot-missing', 'unmeasured', null];
    const coverage = [
      { total: 10, included: 10 }, { total: 10, included: 5 }, { total: 10, included: 0 },
      null, { total: 10, included: 10 }, { total: 0, included: 0 },
    ];
    const rows = Array.from({ length: 50 }, (_, i) => ({
      ...result(`S${i}`, {
        skew: { status: skewStatuses[i % 6], value: null, change: null, root: 'SPX', omittedRows, partial: true, prior: { value: null, status: priorStatuses[i % 8] } },
        gex: {
          gammaCoverage: coverage[i % 6], value: i % 6 === 4 ? null : i % 6 === 5 ? 0 : 1_250_000_000,
          change: null, changePct: null, partial: true, omittedRows,
          prior: { value: null, status: priorStatuses[i % 8] },
          emptyExpirations: ['2026-10-21'], adjustedOnlyExpirations: ['2026-10-22'], openInterestUnpublishedExpirations: ['2026-10-23'],
        },
        warnings: ['w'.repeat(240), 'w'.repeat(240), 'w'.repeat(240)],
      }),
      valuation: 'session-close', q: { value: 0.013, source: 'index_constituents', asOf: '2026-10-19' },
      baseline: { status: i % 2 ? 'none-on-file' : 'unavailable', date: null, spot: null, sessionsSkipped: 1, missingExpirations: ['2026-11-20'] },
    }));
    const codes = ['NO_EXPIRATIONS', 'RESOLUTION_FAILED', 'UPSTREAM_UNAVAILABLE', 'ADJUSTED_SERIES_ONLY', 'BROKER_UNAVAILABLE', 'BROKER_REJECTED', 'BROKER_ENTITLEMENT_MISSING'];
    const errors = Array.from({ length: 30 }, (_, i) => ({ symbol: `S${i}`, status: 502, code: codes[i % codes.length], error: 'x'.repeat(160), retryable: false }));
    const reasons = ['budget', 'time', 'in-progress', 'broker-rate-limited', null];
    const out = shape(rows, {
      provider: 'moomoo', errors, refreshPending: rows.map((r) => r.symbol), complete: false, retryAfterSeconds: 60,
      pending: reasons.map((reason, i) => ({ symbol: `S${i}`, metrics: ['skew'], reason })),
    }, { rankBy: 'gexChange', limit: 49, rateLimit: { limit: 30, remaining: 0, resetSeconds: 60, provider: 'moomoo' } });
    const keys = ['skewGate', 'skewNoExpiration', 'prior', 'gexWindow', 'gexComparison', 'strikes', 'roots', 'gexStatus', 'changeWithheld', 'openInterestUnpublished', 'emptyExpirations', 'adjustedOnly', 'omittedRows', 'partial', 'sessionsSkipped', 'valuation', 'spotClock', 'indexYield', 'moomooDelay', 'rateLimit', 'cost', 'stale', 'pending', 'complete', 'errorCodes', 'ranking', 'omitted'];
    expect(Object.keys(out.guide).sort()).toEqual(keys.sort());
    expect(out.returned).toBeGreaterThanOrEqual(8);
    expect(out.returned).toBeLessThan(49);
    expect(out.omitted.byLimit).toEqual(['S49']);
    expect(out.omitted.bySize).toEqual(rows.slice(out.returned, 49).map((r) => r.symbol));
    for (const status of ['complete', 'partial', 'unmeasured', 'unknown', 'unavailable', 'empty']) expect(out.guide.gexStatus).toContain(`"${status}"`);
    for (const code of codes) expect(out.guide.errorCodes.split(`${code}:`)).toHaveLength(2);
    expect(out.guide.pending).toMatch(/null reason was not reported/);
    expect(out.guide.cost).toMatch(/remaining can read low/);
    expect(utf8ByteLength(JSON.stringify(out))).toBeLessThanOrEqual(MAX_RESPONSE_BYTES - LIVE_SKEW_GEX_MARGIN_BYTES);
    expect(JSON.parse(applyResponseSizeGuard(out))).toEqual(out);
  });
});
