import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './optionsAnalyticsHistory.js';

// Greek exposure methodology v2: the
// history's exposure columns by methodology; methodology 2 is U7b's `exposure=v2`, each row's resolved bases through
// the book() twin, with what each point covers.

async function callHistory(body: unknown, args: Record<string, unknown>, defaultAnswer: unknown = { defaultMethodology: 1, stale: false }) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const server = new McpServer({ name: 'history-u10-test', version: '1' });
  register(server, {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      if (path === '/exposure/methodology') {
        if (defaultAnswer instanceof Error) throw defaultAnswer;
        return defaultAnswer;
      }
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
const V1_ON_WIRE = /"net(Gex|Dex|Vex|Vanna|Charm|Vomma)"|gammaConcentration|gamma_concentration|exposureV2/;

describe('get_options_analytics_history by methodology', () => {
  test('methodology 1 by default: the legacy route and columns, labeled', async () => {
    const { out, historyCalls } = await callHistory({ symbol: 'SPY', data: [day('2026-10-22', undefined)] }, { symbol: 'SPY' });
    expect(historyCalls[0].params).not.toHaveProperty('exposure');
    expect(out).toMatchObject({ methodology: 1, methodologySource: 'default' });
    expect(out.data[0].netGex).toBe(1.5e9);
    expect(out).not.toHaveProperty('methodologyNote');
  });

  test('methodology 2, a day at a time: the book in place of the legacy columns, and what each day covers', async () => {
    const body = { symbol: 'SPY', data: [
      day('2026-10-19', ready()),
      day('2026-10-20', ready({ bases: bases({ vega: [2, 4], vomma: [0, 4] }) })),
      day('2026-10-21', ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'mayInclude', cause: 'pending' } })),
      day('2026-10-22', { available: false, reason: 'no methodology-2 row' }),
      day('2026-10-23', { available: false, reason: 'the bases row carries methodology 3' }),
      day('2026-10-24', ready({ expiryQualifier: { kind: 'unscoped', strikes: 3 } })),
      day('2026-10-25', ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'affected', disposition: 'refused' } })),
    ] };
    const { out, text, historyCalls } = await callHistory(body, { symbol: 'SPY', days: 7, methodology: 2 });
    expect(historyCalls[0].params).toMatchObject({ exposure: 'v2' });
    expect(historyCalls[0].params).not.toHaveProperty('v2rev');
    expect(out).toMatchObject({ methodology: 2, methodologySource: 'requested', exposuresCommon: { referenceKind: 'spot', charmBasis: 'cash' } });
    expect(out.methodologyNote).toMatch(/^Methodology 2: each point carries the assumed dealer book/);
    expect(out.methodologyNote).toMatch(/over every expiration after the session where the expiry rule is proven \(a point whose exposureStatus carries an expiryQualifier may count contracts expiring that day\)/);
    expect(text).not.toMatch(V1_ON_WIRE);
    const [clean, partial, pending, missing, unreadable, unscoped, affected] = out.data;
    // the assumed book: call minus put, charm flow put minus call; the delta balance as stored
    expect(clean).toMatchObject({ gex: 2000, vegaExposure: 60, vanna: 70, charmFlow: -90, vomma: -70, putMinusCallDeltaBalance: -12345.5, spotPrice: 671.23 });
    expect(clean).not.toHaveProperty('exposureStatus');
    expect(partial.exposureStatus).toEqual({ coverage: { vegaExposure: { status: 'partial', included: 2, total: 4 }, vomma: { status: 'unavailable', included: 0, total: 4 } } });
    expect(partial.vomma).toBeNull();
    expect(pending.exposureStatus).toEqual({ expiryQualifier: 'may count contracts expiring that day (their correction is in progress)' });
    expect(missing).toMatchObject({ gex: null, vegaExposure: null, putMinusCallDeltaBalance: null, exposureUnavailable: 'no methodology-2 row' });
    // a stored row's own reason is not sent: one fixed phrase
    expect(unreadable.exposureUnavailable).toBe('the methodology-2 row could not be read');
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
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: [day('2026-10-23', oneOfTwo)] }, { symbol: 'SPY', interval: 'weekly', methodology: 2 });
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
    const { out } = await callHistory({ symbol: 'SPX', interval: 'monthly', data: points.map((b, i) => day(`2026-0${i + 4}-30`, b)) }, { symbol: 'SPX', interval: 'monthly', methodology: 2 });
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
    expect(none).toMatchObject({ gex: null, exposureUnavailable: 'no methodology-2 row in this period', exposureDays: { days: 5, withRow: 0, missing: 5, unreadable: 0 } });
    // the points differ in reference, so nothing is hoisted
    expect(out).not.toHaveProperty('exposuresCommon');
  });

  test('the summary under 2: the book\'s series and extremes, how many points stand short of complete, no legacy column', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => {
      const date = new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10);
      const exposureV2 = i === 0 ? { available: false, reason: 'no methodology-2 row' }
        : i === 119 ? ready({ bases: bases({ gamma: [3, 4] }, side(3000 + i, 70, 50, 30, 20)) })
          : i === 2 ? ready({ definition: 'legacy-scope', expiryQualifier: { kind: 'mayInclude', cause: 'unverified' } })
            : ready({ bases: bases({}, side(3000 + i, 70, 50, 30, 20)) });
      return day(date, exposureV2);
    });
    const { out, text } = await callHistory({ symbol: 'SPY', data: rows }, { symbol: 'SPY', days: 120, methodology: 2 });
    expect(out.summary).toMatchObject({ maxAbsGex: 2119, maxAbsPutMinusCallDeltaBalance: 12346, exposurePoints: { total: 120, partial: 1, qualified: 1, unavailable: 1 } });
    expect(out.summary).not.toHaveProperty('maxAbsNetGex');
    expect(out.latest).toMatchObject({ gex: 2119, putMinusCallDeltaBalance: -12346, vegaExposure: 60 });
    // the compact points keep their standing and their reason
    expect(out.latest.exposureStatus).toEqual({ coverage: { gex: { status: 'partial', included: 3, total: 4 } } });
    expect(out.earliest).toMatchObject({ gex: null, exposureUnavailable: 'no methodology-2 row' });
    expect(text).not.toMatch(V1_ON_WIRE);
  });

  test('a period missing a day, or with one unreadable, counts as partial in the summary', async () => {
    const periods = Array.from({ length: 120 }, (_, i) => {
      const date = new Date(Date.UTC(2024, 0, 7 + 7 * i)).toISOString().slice(0, 10);
      const exposureV2 = i === 40 ? bucket({ days: 2, rows: 1, missing: 1, unreadable: 0 })
        : i === 80 ? bucket({ days: 3, rows: 2, missing: 0, unreadable: 1 })
          : bucket();
      return day(date, exposureV2);
    });
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: periods }, { symbol: 'SPY', interval: 'weekly', days: 900, methodology: 2 });
    expect(out.summary.exposurePoints).toEqual({ total: 120, partial: 2, qualified: 0, unavailable: 0 });
  });

  test('an unreadable default withholds the exposure columns and answers the rest; a named methodology never reads it', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ date: new Date(Date.UTC(2026, 5, 1 + i)).toISOString().slice(0, 10), ...legacy }));
    const summary = await callHistory({ symbol: 'SPY', data: rows }, { symbol: 'SPY', days: 120 }, new Error('HTTP 503'));
    expect(summary.historyCalls[0].params).not.toHaveProperty('exposure');
    expect(summary.out.exposuresWithheld).toMatch(/could not be read/);
    expect(summary.out).not.toHaveProperty('methodology');
    expect(summary.out.summary).not.toHaveProperty('maxAbsNetGex');
    expect(summary.out.summary.avgAtmIv).toBe(0.15);
    expect(summary.out.latest).not.toHaveProperty('gex');
    expect(summary.out.summary).not.toHaveProperty('maxAbsGex');
    expect(summary.text).not.toMatch(V1_ON_WIRE);
    const raw = await callHistory({ symbol: 'SPY', data: rows.slice(0, 5) }, { symbol: 'SPY', days: 5 }, new Error('HTTP 503'));
    expect(raw.text).not.toMatch(V1_ON_WIRE);
    expect(raw.out.data[0].spotPrice).toBe(671.23);
    const named = await callHistory({ symbol: 'SPY', data: rows.slice(0, 5) }, { symbol: 'SPY', days: 5, methodology: 1 }, new Error('HTTP 503'));
    expect(named.calls.map((c) => c.path)).not.toContain('/exposure/methodology');
    expect(named.out).toMatchObject({ methodology: 1, methodologySource: 'requested' });
  });

  test('full=true under 2: the raw rows are methodology 2\'s and the answer is labeled', async () => {
    const { out, text } = await callHistory({ symbol: 'SPY', data: [day('2026-10-22', ready()), day('2026-10-23', ready())] }, { symbol: 'SPY', days: 2, full: true, methodology: 2 });
    expect(out).toMatchObject({ methodology: 2, methodologySource: 'requested' });
    expect(out.data[1].gex).toBe(2000);
    expect(text).not.toMatch(V1_ON_WIRE);
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
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: [day('2026-10-23', real)] }, { symbol: 'SPY', interval: 'weekly', methodology: 2 });
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
    const { out } = await callHistory({ symbol: 'SPY', interval: 'weekly', data: periods }, { symbol: 'SPY', interval: 'weekly', days: 900, methodology: 2 });
    expect(out.summary.exposurePoints).toEqual({ total: 120, partial: 1, qualified: 0, unavailable: 0 });
  });
});
