import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './optionsAnalyticsHistory.js';

// The history's exposure columns are the assumed dealer book (methodology v2; Greek exposure methodology v2: the only calculation): the route's `exposure=v2` (U7b, internal transport), each
// row's resolved bases through the book() twin, with what each point covers.

async function callHistory(body: unknown, args: Record<string, unknown>) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'history-u12-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      return structuredClone(body);
    },
  } as unknown as ProxyClient);
  const client = new Client({ name: 'history-u10-reader', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name: 'get_options_analytics_history', arguments: args });
    expect(result.isError).not.toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    // one request, the history route's; no default is read, there is nothing to choose
    expect(calls.map((c) => c.path)).toEqual(['/history']);
    return { out: JSON.parse(text) as Record<string, any>, text, calls, historyCalls: calls.filter((c) => c.path === '/history') };
  } finally {
    await client.close();
    await server.close();
  }
}

const METRICS = ['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'] as const;
type Metric = (typeof METRICS)[number];
const side = (gex: number, vega: number, vanna: number, charm: number, vomma: number) => ({ gex, dex: 0, vega, vanna, charmFixedRef: charm, rollBasis: 0, charm, vomma });
const coverage = (over: Partial<Record<Metric, [number, number]>> = {}) => Object.fromEntries(METRICS.map((m) => {
  const [included, total] = over[m] ?? [4, 4];
  return [m, { included, total }];
}));
const bases = (over: Partial<Record<Metric, [number, number]>> = {}, call = side(3000, 70, 50, 30, 20), put = side(1000, 10, -20, -60, 90)) => ({
  call, put, coverage: coverage(over), dexBalance: -12345.5,
});
const legacy = { spot_price: 671.23, max_pain: 670, atm_iv: 0.15, hv_20d: 0.12, iv_rank: 0.3, put_call_ratio: 1.1, net_gex: 1.5e9, net_dex: -2e9, net_vex: -3e7, net_vanna: 4e6, net_charm: -5e5, net_vomma: 6e4, gamma_concentration: 0.12 };
const day = (date: string, exposureV2: unknown) => ({ date, ...legacy, exposureV2 });
const ready = (over: Record<string, unknown> = {}) => ({
  available: true, provenance: 'nightly', referenceKind: 'spot', roll: { status: 'notApplicable', carry: null },
  bases: bases(), definition: 'expiry-scoped', expiryQualifier: null, ...over,
});
const NET_ON_WIRE = /"net(Gex|Dex|Vex|Vanna|Charm|Vomma)"|gammaConcentration|gamma_concentration|exposureV2/;
/** No calculation is named anywhere a model reads */
const NAMED_CALCULATION = /[Mm]ethodolog|\bv[12]\b|V2/;
const LABELS = ['methodology', 'methodologySource', 'methodologyStale', 'methodologyNote', 'exposuresWithheld'];
const expectBookAnswer = (out: Record<string, any>, text: string) => {
  expect(out.bookNote).toMatch(/^Each point carries the assumed dealer book - dealers long the calls and short the puts/);
  for (const key of LABELS) expect(out).not.toHaveProperty(key);
  expect(text).not.toMatch(NET_ON_WIRE);
  expect(text).not.toMatch(NAMED_CALCULATION);
};

describe('get_options_analytics_history: the exposure columns are the assumed dealer book', () => {
  test('every answer asks for the book and carries it, the net columns never, a missing book a gap with its reason', async () => {
    const { out, text, historyCalls } = await callHistory({ symbol: 'SPY', data: [day('2026-10-21', ready()), day('2026-10-22', undefined)] }, { symbol: 'SPY' });
    expect(historyCalls[0].params).toMatchObject({ exposure: 'v2' });
    expectBookAnswer(out, text);
    expect(out.data[0]).toMatchObject({ gex: 2000, putMinusCallDeltaBalance: -12345.5, spotPrice: 671.23 });
    // a row the route sent without its book: every number null, the reason in words
    expect(out.data[1]).toMatchObject({ gex: null, vegaExposure: null, putMinusCallDeltaBalance: null, exposureUnavailable: 'the answer carries no book for this point' });
  });

  test('a day at a time: the book in place of the net columns, and what each day covers', async () => {
    const body = { symbol: 'SPY', data: [
      day('2026-10-19', ready()),
      day('2026-10-20', ready({ bases: bases({ vega: [2, 4], vomma: [0, 4] }) })),
      day('2026-10-21', ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'mayInclude', cause: 'pending' } })),
      day('2026-10-22', { available: false, reason: 'no methodology-2 row' }),
      day('2026-10-23', { available: false, reason: 'the bases row carries methodology 3' }),
      day('2026-10-24', ready({ expiryQualifier: { kind: 'unscoped', strikes: 3 } })),
      day('2026-10-25', ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'affected', disposition: 'refused' } })),
    ] };
    const { out, text, historyCalls } = await callHistory(body, { symbol: 'SPY', days: 7 });
    expect(historyCalls[0].params).toMatchObject({ exposure: 'v2' });
    expect(historyCalls[0].params).not.toHaveProperty('v2rev');
    expect(out).toMatchObject({ exposuresCommon: { referenceKind: 'spot', charmBasis: 'cash' } });
    expect(out.bookNote).toMatch(/over every expiration after the session where the expiry rule is proven \(a point whose exposureStatus carries an expiryQualifier may count contracts expiring that day\)/);
    expectBookAnswer(out, text);
    const [clean, partial, pending, missing, unreadable, unscoped, affected] = out.data;
    // the assumed book: call minus put, charm flow put minus call; the delta balance as stored
    expect(clean).toMatchObject({ gex: 2000, vegaExposure: 60, vanna: 70, charmFlow: -90, vomma: -70, putMinusCallDeltaBalance: -12345.5, spotPrice: 671.23 });
    expect(clean).not.toHaveProperty('exposureStatus');
    expect(partial.exposureStatus).toEqual({ coverage: { vegaExposure: { status: 'partial', included: 2, total: 4 }, vomma: { status: 'unavailable', included: 0, total: 4 } } });
    expect(partial.vomma).toBeNull();
    expect(pending.exposureStatus).toEqual({ expiryQualifier: 'may count contracts expiring that day (their correction is in progress)' });
    // a day without a stored book is a gap: the route's transport reason read into words
    expect(missing).toMatchObject({ gex: null, vegaExposure: null, putMinusCallDeltaBalance: null, exposureUnavailable: 'the assumed dealer book is not published for this session' });
    // a stored row's own reason is not sent: one fixed phrase
    expect(unreadable.exposureUnavailable).toBe('the stored book is unreadable');
    expect(unscoped.exposureStatus).toEqual({ expiryQualifier: 'counts 3 strikes whose expiration could not be read' });
    expect(affected.exposureStatus.expiryQualifier).toMatch(/may count contracts expiring that day or strikes whose expiration could not be read \(the repair recorded it and refused the correction\)/);
  });

  // A bucket as the route's bucketExposureV2 writes it (proxy/lib/historyExposureV2.ts), its days' counts beside the averaged bases
  const bucket = (over: Record<string, unknown> = {}) => ({
    available: true, days: 2, rows: 2, missing: 0, unreadable: 0,
    metricDays: Object.fromEntries(METRICS.map((m) => [m, { complete: 2, partial: 0, unavailable: 0 }])),
    coverageAllDays: coverage(), rolls: { notApplicable: 2 }, referenceKinds: { spot: 2 }, provenance: { nightly: 2, reconstruction: 0 },
    definitions: { expiryScoped: 2, legacyScope: 0 }, expiryQualified: { mayInclude: 0, affected: 0, unscoped: 0 },
    bases: bases(), ...over,
  });

  test('a period point says how many of its days each number averages, even when its legs read complete', async () => {
    // the review's case: one complete day and one gamma-unavailable day - the averaged legs are the complete day's alone
    const oneOfTwo = bucket({ metricDays: { ...bucket().metricDays, gamma: { complete: 1, partial: 0, unavailable: 1 } } });
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: [day('2026-10-23', oneOfTwo)] }, { symbol: 'SPY', interval: 'weekly' });
    const [point] = out.data;
    expect(point.gex).toBe(2000);
    expect(point.exposureStatus).toEqual({ metricDays: { gex: { averaged: 1, partial: 0, unavailable: 1 } } });
    expect(point.exposureDays).toEqual({ days: 2, withRow: 2, missing: 0, unreadable: 0 });
    expect(point).toMatchObject({ referenceKind: 'spot', charmBasis: 'cash' });
  });

  test('partial legs stay visible beside the days; qualified days, mixed rolls and mixed references are counted', async () => {
    const points = [
      bucket({ bases: bases({ vanna: [3, 4] }), metricDays: { ...bucket().metricDays, vanna: { complete: 1, partial: 1, unavailable: 0 } } }),
      bucket({ expiryQualified: { mayInclude: 1, affected: 0, unscoped: 0 }, definitions: { expiryScoped: 1, legacyScope: 1 } }),
      bucket({ referenceKinds: { forward: 5 }, rolls: { fitted: 3, insufficientData: 2 }, days: 5, rows: 5 }),
      bucket({ referenceKinds: { spot: 2, forward: 1 }, rolls: { notApplicable: 2, fitted: 1 }, days: 3, rows: 3 }),
      bucket({ referenceKinds: undefined }),
      { available: false, reason: 'no methodology-2 row in this period', days: 5, rows: 0, missing: 5, unreadable: 0 },
    ];
    const { out, text } = await callHistory({ symbol: 'SPX', interval: 'monthly', data: points.map((b, i) => day(`2026-0${i + 4}-30`, b)) }, { symbol: 'SPX', interval: 'monthly' });
    expectBookAnswer(out, text);
    const [partial, qualified, mixedRolls, mixedKinds, noKinds, none] = out.data;
    expect(partial.exposureStatus).toEqual({
      coverage: { vanna: { status: 'partial', included: 3, total: 4 } },
      metricDays: { vanna: { averaged: 2, partial: 1, unavailable: 0 } },
    });
    expect(qualified.exposureStatus).toEqual({ expiryQualifiedDays: { mayInclude: 1 } });
    // several roll statuses: no one charm basis for the period
    expect(mixedRolls.exposureStatus).toEqual({ rolls: { fitted: 3, 'insufficient data': 2 } });
    expect(mixedRolls).not.toHaveProperty('charmBasis');
    expect(mixedKinds.exposureStatus).toEqual({ rolls: { 'not applicable': 2, fitted: 1 }, referenceKinds: { spot: 2, forward: 1 } });
    expect(mixedKinds).not.toHaveProperty('charmBasis');
    // an answer from before the route counted the kinds states no reference
    expect(noKinds).not.toHaveProperty('referenceKind');
    expect(noKinds).not.toHaveProperty('charmBasis');
    expect(none).toMatchObject({ gex: null, exposureUnavailable: 'the assumed dealer book is not published for any session in this period', exposureDays: { days: 5, withRow: 0, missing: 5, unreadable: 0 } });
    // the points differ in reference, so nothing is hoisted
    expect(out).not.toHaveProperty('exposuresCommon');
  });

  test('the period refusals read into words, none naming a calculation', async () => {
    const reasons = ['every methodology-2 row in this period is unreadable', 'no readable methodology-2 row in this period', 'a stored reason of its own'];
    const { out, text } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: reasons.map((reason, i) => day(`2026-0${i + 4}-30`, { available: false, reason, days: 5, rows: 5, missing: 0, unreadable: 5 })) }, { symbol: 'SPY', interval: 'weekly' });
    expect(out.data.map((point: any) => point.exposureUnavailable)).toEqual(['every stored book in this period is unreadable', 'no stored book in this period could be read', 'the stored book is unreadable']);
    expectBookAnswer(out, text);
  });

  test('the summary: the book\'s series and extremes, how many points stand short of complete, no net column', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
      const exposureV2 = i === 0 ? { available: false, reason: 'no methodology-2 row' }
        : i === 119 ? ready({ bases: bases({ gamma: [3, 4] }, side(3000 + i, 70, 50, 30, 20)) })
          : i === 2 ? ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'mayInclude', cause: 'unverified' } })
            : ready({ bases: bases({}, side(3000 + i, 70, 50, 30, 20)) });
      return day(date, exposureV2);
    });
    const { out, text } = await callHistory({ symbol: 'SPY', data: rows }, { symbol: 'SPY', days: 120 });
    expect(out.summary).toMatchObject({ maxAbsGex: 2119, maxAbsPutMinusCallDeltaBalance: 12346, exposurePoints: { total: 120, partial: 1, qualified: 1, unavailable: 1 } });
    expectBookAnswer(out, text);
    expect(out.summary).not.toHaveProperty('maxAbsNetGex');
    expect(out.latest).toMatchObject({ gex: 2119, putMinusCallDeltaBalance: -12346, vegaExposure: 60 });
    // the compact points keep their standing and their reason
    expect(out.latest.exposureStatus).toEqual({ coverage: { gex: { status: 'partial', included: 3, total: 4 } } });
    expect(out.earliest).toMatchObject({ gex: null, exposureUnavailable: 'the assumed dealer book is not published for this session' });
  });

  test('a period missing a day, or with one unreadable, counts as partial in the summary', async () => {
    const periods = Array.from({ length: 120 }, (_, i) => {
      const date = new Date(Date.UTC(2024, 0, 7 + 7 * i)).toISOString().slice(0, 10);
      const exposureV2 = i === 40 ? bucket({ days: 2, rows: 1, missing: 1, unreadable: 0 })
        : i === 80 ? bucket({ days: 3, rows: 2, missing: 0, unreadable: 1 })
          : bucket();
      return day(date, exposureV2);
    });
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: periods }, { symbol: 'SPY', interval: 'weekly', days: 900 });
    expect(out.summary.exposurePoints).toEqual({ total: 120, partial: 2, qualified: 0, unavailable: 0 });
  });

  // The route marks a failed read of the stored books partial, unavailable ['exposureV2'] (its
  // transport name); the answer keeps the partial signal, names the part `exposures` and says what it means, on every path
  // The route's provenance repeats its id at the top level, in metadata and in provenance, with the
  // book's opt-in (:v2) and its publication revision (:v2rev=<n>); the answer sends it in its public form on every path
  test('the provenance identifier names no method, the same opaque identity, on the short, full and summary paths', async () => {
    const id = 'history:SPY:auto:latest:2026-06-01:2026-09-28:120:abc123:v2:v2rev=7';
    const prov = { provider: 'supabase', source: 'option_ticker_snapshots', historySnapshotId: id, snapshotId: id, fetchedAt: '2026-09-28T21:00:00.000Z', fromCache: false };
    const rows = (n: number) => Array.from({ length: n }, (_, i) => day(new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), ready()));
    for (const [body, args] of [[{ symbol: 'SPY', data: rows(2), ...prov, metadata: prov, provenance: prov }, { symbol: 'SPY', days: 2 }],
      [{ symbol: 'SPY', data: rows(2), ...prov, metadata: prov, provenance: prov }, { symbol: 'SPY', days: 2, full: true }],
      [{ symbol: 'SPY', data: rows(120), ...prov, metadata: prov, provenance: prov }, { symbol: 'SPY', days: 120 }]] as const) {
      const { text } = await callHistory(body, args);
      expect(text, JSON.stringify(args)).toContain('history:SPY:auto:latest:2026-06-01:2026-09-28:120:abc123:rev=7');
      expect(text, JSON.stringify(args)).not.toMatch(/:v2|[Mm]ethodolog|\bv2\b|V2/);
    }
  });

  test('a failed read of the books stays partial, named `exposures`, on the short, full and summary paths', async () => {
    const unread = { available: false, reason: 'the methodology-2 bases could not be read' };
    const short = { symbol: 'SPY', data: [day('2026-10-22', unread), day('2026-10-23', unread)], partial: true, unavailable: ['exposureV2'] };
    const long = { symbol: 'SPY', data: Array.from({ length: 120 }, (_, i) => day(new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), unread)), partial: true, unavailable: ['exposureV2'] };
    for (const [body, args] of [[short, { symbol: 'SPY', days: 2 }], [short, { symbol: 'SPY', days: 2, full: true }], [long, { symbol: 'SPY', days: 120 }]] as const) {
      const { out, text } = await callHistory(body, args);
      expect(out, JSON.stringify(args)).toMatchObject({ partial: true, unavailable: ['exposures'] });
      expect(out.partialNote).toBe('The stored books could not be read on this call, so the points\' exposures are missing (null, with exposureUnavailable), not zero.');
      expect(text, JSON.stringify(args)).not.toMatch(NET_ON_WIRE);
      expect(text).not.toMatch(NAMED_CALCULATION);
    }
    // any other unread source passes as sent, without the book's note
    const other = await callHistory({ ...short, data: [day('2026-10-23', ready())], unavailable: ['provenance'] }, { symbol: 'SPY', days: 1 });
    expect(other.out).toMatchObject({ partial: true, unavailable: ['provenance'] });
    expect(other.out).not.toHaveProperty('partialNote');
  });

  test('full=true: the raw rows are the book\'s and the answer carries its note', async () => {
    const { out, text } = await callHistory({ symbol: 'SPY', data: [day('2026-10-22', ready()), day('2026-10-23', ready())] }, { symbol: 'SPY', days: 2, full: true });
    expectBookAnswer(out, text);
    expect(out.data[1].gex).toBe(2000);
  });

  test('the default 30-day window, trimmed, carries the book and its note too', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => day(new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), ready()));
    const { out, text } = await callHistory({ symbol: 'SPY', data: rows }, { symbol: 'SPY' });
    expect(out.data).toHaveLength(30);
    expect(out.dataMeta).toMatchObject({ trimmed: true, originalLength: 40, returned: 30, order: 'oldest first' });
    expectBookAnswer(out, text);
  });

  test('the description names the book\'s figures and no calculation', async () => {
    const server = new McpServer({ name: 'history-u12-description', version: '1' });
    register(server, { get: async () => ({}) } as unknown as ProxyClient);
    const client = new Client({ name: 'history-u12-description-reader', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const [tool] = (await client.listTools()).tools.filter((t) => t.name === 'get_options_analytics_history');
      const description = String(tool.description);
      expect(description).toContain('the assumed dealer book\'s GEX, delta balance, vega exposure, vanna, charm flow and vomma');
      expect(description).toContain('This, get_options_snapshot and get_dealer_positioning report one stored book, the assumed dealer book, over the scope each answer states; only get_dealer_positioning\'s levels keep the 0-60 day window.');
      expect(description.length).toBeLessThanOrEqual(4096);
      expect(JSON.stringify(tool)).not.toMatch(NAMED_CALCULATION);
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain('methodology');
    } finally {
      await client.close();
      await server.close();
    }
  });

  // The public mirror ships the MCP server alone, without the proxy: there this comparison has nothing to read.
  const proxyReader = new URL('../../../../proxy/lib/historyExposureV2.ts', import.meta.url);
  test.skipIf(!existsSync(proxyReader))('the route\'s own bucket of one complete and one gamma-unavailable day reads as one day averaged', async () => {
    const { bucketExposureV2 } = await import(proxyReader.href);
    const complete = ready({ bases: bases({}, side(3000, 70, 50, 30, 20), side(1000, 10, -20, -60, 90)) });
    const noGamma = ready({ bases: { ...bases({ gamma: [0, 4] }), call: side(9000, 70, 50, 30, 20) } });
    const real = bucketExposureV2([complete, noGamma]);
    // the averaged gamma legs are the complete day's: read alone they say complete
    expect(real.bases.coverage.gamma).toEqual({ included: 4, total: 4 });
    expect(real.referenceKinds).toEqual({ spot: 2 });
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: [day('2026-10-23', real)] }, { symbol: 'SPY', interval: 'weekly' });
    expect(out.data[0].gex).toBe(2000);
    expect(out.data[0].exposureStatus).toEqual({ metricDays: { gex: { averaged: 1, partial: 0, unavailable: 1 } } });
    expect(out.data[0].exposureDays).toEqual({ days: 2, withRow: 2, missing: 0, unreadable: 0 });
  });

  test.skipIf(!existsSync(proxyReader))('the route\'s own bucket of one complete and one missing day is partial in the summary', async () => {
    const { bucketExposureV2, NO_ROW } = await import(proxyReader.href);
    const missingDay = bucketExposureV2([ready(), { available: false, reason: NO_ROW }]);
    expect(missingDay).toMatchObject({ days: 2, rows: 1, missing: 1 });
    const periods = Array.from({ length: 120 }, (_, i) => day(new Date(Date.UTC(2024, 0, 7 + 7 * i)).toISOString().slice(0, 10),
      i === 60 ? missingDay : bucketExposureV2([ready(), ready()])));
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: periods }, { symbol: 'SPY', interval: 'weekly', days: 900 });
    expect(out.summary.exposurePoints).toEqual({ total: 120, partial: 1, qualified: 0, unavailable: 0 });
  });
});
