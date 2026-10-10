import { describe, expect, test } from 'bun:test';
import { applyResponseSizeGuard, sanitizeMcpWireOutput, toolHandler } from './helpers.js';
import { ApiError, AuthError, SubscriptionError } from '../types.js';
import { LiveApiError } from '../proxy/liveApiClient.js';

describe('applyResponseSizeGuard', () => {
  test('enforces the response limit in UTF-8 bytes for multibyte text', () => {
    const guarded = applyResponseSizeGuard({ value: '漢'.repeat(18_000) }, 50 * 1024);
    const parsed = JSON.parse(guarded);

    expect(new TextEncoder().encode(guarded).byteLength).toBeLessThanOrEqual(50 * 1024);
    expect(parsed.responseBudget).toEqual({ tooLarge: true, sizeKb: 53 });
  });

  test('keeps sub-50KB responses intact even when arrays exceed 50 items', () => {
    const payload = {
      data: Array.from({ length: 60 }, (_, index) => ({
        date: `2026-03-${String(index + 1).padStart(2, '0')}`,
        close: 600 + index,
        volume: 1_000_000 + index,
      })),
    };

    const parsed = JSON.parse(applyResponseSizeGuard(payload));

    expect(parsed.data).toHaveLength(60);
    expect(parsed._data_note).toBeUndefined();
    expect(parsed._data_meta).toBeUndefined();
  });

  test('truncates oversized nested arrays only after the raw response exceeds the byte budget', () => {
    const payload = {
      data: Array.from({ length: 120 }, (_, index) => ({
        id: index,
        blob: 'x'.repeat(1200),
      })),
    };

    const parsed = JSON.parse(applyResponseSizeGuard(payload, 50 * 1024));

    expect(parsed.data).toHaveLength(5);
    expect(parsed.dataMeta).toMatchObject({
      truncated: true,
      aggressive: true,
      originalLength: 50,
      returned: 5,
    });
  });

  test('aggressively trims oversized root arrays before falling back to an error payload', () => {
    const payload = Array.from({ length: 120 }, (_, index) => ({
      id: index,
      blob: 'x'.repeat(1200),
    }));

    const parsed = JSON.parse(applyResponseSizeGuard(payload, 50 * 1024));

    expect(Array.isArray(parsed)).toBeTrue();
    expect(parsed.slice(0, 5)).toHaveLength(5);
    expect(parsed[5]).toMatchObject({
      truncated: true,
      aggressive: true,
      returned: 5,
    });
  });

  test('keeps the FIRST N items when aggressively trimming a nested data array', () => {
    // Sync tools sort timestamp DESC, so index 0 is newest. The guard must
    // preserve the newest records, not silently drop them by taking slice(-5).
    const payload = {
      data: Array.from({ length: 120 }, (_, index) => ({
        id: index,
        blob: 'x'.repeat(1200),
      })),
    };

    const parsed = JSON.parse(applyResponseSizeGuard(payload, 50 * 1024));

    expect(parsed.data).toHaveLength(5);
    // The first 5 items (ids 0-4) must survive — they're the newest for
    // sync-backed tools. The last 5 (ids 115-119, oldest) must be gone.
    expect(parsed.data.map((row: { id: number }) => row.id)).toEqual([0, 1, 2, 3, 4]);
  });

  test('keeps the FIRST N items when aggressively trimming a root array', () => {
    const payload = Array.from({ length: 120 }, (_, index) => ({
      id: index,
      blob: 'x'.repeat(1200),
    }));

    const parsed = JSON.parse(applyResponseSizeGuard(payload, 50 * 1024));

    expect(Array.isArray(parsed)).toBeTrue();
    // First 5 elements are the records (ids 0-4), last element is the truncation metadata
    expect(parsed.slice(0, 5).map((row: { id: number }) => row.id)).toEqual([0, 1, 2, 3, 4]);
    expect(parsed[5].truncated).toBe(true);
    expect(parsed[5].aggressive).toBe(true);
  });
});

// Field names are camelCase on every tool. Proxy rows carry snake_case
// columns (market_date, iv_rank, stress_score) and several tools pass them
// through on raw and full paths, so the wire boundary converts pure
// lowercase snake_case keys; anything else (a date, a tenor, a ticker, a
// model or feature display name, a form type) is data and stays as it is.
describe('sanitizeMcpWireOutput publishes camelCase field names', () => {
  test('converts pure snake_case keys, nested and inside arrays', () => {
    const sanitized = sanitizeMcpWireOutput({
      market_date: '2026-09-22', atm_iv_30d: 0.3, expected_move_30d_fraction: 0.04, hv_20d: 0.2,
      rows: [{ iv_rank: 40, put_call_ratio: 0.9 }],
      company_profile: { company_name: 'Micron', free_float_pct: 99 },
    });
    expect(sanitized).toEqual({
      marketDate: '2026-09-22', atmIv30d: 0.3, expectedMove30dFraction: 0.04, hv20d: 0.2,
      rows: [{ ivRank: 40, putCallRatio: 0.9 }],
      companyProfile: { companyName: 'Micron', freeFloatPct: 99 },
    });
  });

  test('joins two adjacent number segments with "to", and names the curve spreads as the summary does', () => {
    expect(sanitizeMcpWireOutput({ net_gex_0_60d: 1, net_dex_0_60d: 2, analysis: { spread_2_10: 0.5, spread_3m_10y: -0.2 } }))
      .toEqual({ netGex0to60d: 1, netDex0to60d: 2, analysis: { twoTen: 0.5, threeMonthTenYear: -0.2 } });
  });

  test('leaves data keys, camelCase keys and every value alone', () => {
    const data = {
      keyRates: { '10Y': 4.1, '3M': 4.3 }, firms: { '2026-04-11': 3 }, models: { 'Monte Carlo - Heston': 1, Heston: 2 },
      featureZScores: { 'Vol Level': 1.2 }, greeks: { Delta: 0.5 }, formCounts: { 'SC 13D/A': 1, '10-K': 2 },
      prices: { 'BRK.B': 1, BRK_B: 2 }, labels: { Local_Vol: 1, '2Y_10Y': 2 },
      // review: the pattern's anchors; a snake run inside a longer
      // key is data, not a field name.
      versions: { 'model_name.v2': 1, 'x-fixed_income': 2, 'fixed_income ': 3, ' atm_iv': 4 },
      callWall: 510, x: 1, reason: 'below_average', source: 'nearest_date',
    };
    expect(sanitizeMcpWireOutput(data)).toEqual(data);
  });

  test("keeps the regime tiers' own names as dictionary keys, and converts the fields inside them", () => {
    const sanitized = sanitizeMcpWireOutput({
      symbols: { fixed_income: [{ symbol: 'TLT', stress_score: 1.2, scan_time: '13:00' }] },
      symbolCoverage: { tiers: { fixed_income: { total: 10, returned: 8 } } },
    });
    expect(sanitized).toEqual({
      symbols: { fixed_income: [{ symbol: 'TLT', stressScore: 1.2, scanTime: '13:00' }] },
      symbolCoverage: { tiers: { fixed_income: { total: 10, returned: 8 } } },
    });
    // A `symbols` ARRAY is a list of rows, not a dictionary of tiers.
    expect(sanitizeMcpWireOutput({ symbols: [{ stress_score: 1 }] })).toEqual({ symbols: [{ stressScore: 1 }] });
  });

  test('never overwrites: a snake key whose camelCase twin is already present is left as it is', () => {
    expect(sanitizeMcpWireOutput({ market_date: 'a', marketDate: 'b' })).toEqual({ market_date: 'a', marketDate: 'b' });
  });

  test('converts the base of a _<key>_meta block and the keys inside it', () => {
    expect(sanitizeMcpWireOutput({ _trend_sample_meta: { total_rows: 90, evenly_spaced: true } }))
      .toEqual({ trendSampleMeta: { totalRows: 90, evenlySpaced: true } });
  });

  test('still drops the sync plumbing keys by their stored names', () => {
    expect(sanitizeMcpWireOutput({ id: 1, user_id: 2, run_key: 'r', created_at: 't', updated_at: 't', market_date: 'd' }))
      .toEqual({ marketDate: 'd' });
  });
});

describe('sanitizeMcpWireOutput dynamic _<key>_meta preservation', () => {
  test('preserves snake_case truncation metadata (e.g. _recent_history_meta from marketFlowShaping)', () => {
    // marketFlowShaping.ts:162 emits _recent_history_meta verbatim. The
    // earlier alphanumeric-only regex silently dropped this key, leaving
    // callers with no way to detect that recent_history was truncated.
    const sanitized = sanitizeMcpWireOutput({
      recent_history: [{ day: 1 }, { day: 2 }],
      _recent_history_meta: { showing: 2, total: 90, truncated: true },
    }) as Record<string, any>;

    expect(sanitized.recentHistory).toHaveLength(2);
    expect(sanitized.recentHistoryMeta).toEqual({ showing: 2, total: 90, truncated: true });
    expect(sanitized.recent_history).toBeUndefined();
    expect(sanitized['recent_historyMeta']).toBeUndefined();
    expect(sanitized._recent_history_meta).toBeUndefined();
  });

  test('preserves camelCase truncation metadata (e.g. _weeklyData_meta from darkPoolDataShaping)', () => {
    const sanitized = sanitizeMcpWireOutput({
      weeklyData: [{ week: 'w0' }],
      _weeklyData_meta: { truncated: true, originalLength: 52, returned: 1 },
    }) as Record<string, any>;

    expect(sanitized.weeklyDataMeta).toMatchObject({ truncated: true, originalLength: 52, returned: 1 });
    expect(sanitized._weeklyData_meta).toBeUndefined();
  });
});

describe('sanitizeMcpWireOutput', () => {
  test('removes underscore metadata fields while preserving useful preview payloads', () => {
    const sanitized = sanitizeMcpWireOutput({
      _stress_score_note: 'internal note',
      _symbols_truncation_meta: { selection: 'top symbols', tiers: {} },
      _venues_note: 'No ATS venue breakdown',
      _rate_meta: { source: 'platform 10Y benchmark', maturity: '10Y' },
      comparison: {
        _count: 20,
        _preview: [{ strike: 380, agreement: 'majority buy' }],
        _meta: { showing: 5, total: 20 },
      },
      data: [{ symbol: 'SPY' }],
    }) as Record<string, any>;

    expect(sanitized._stress_score_note).toBeUndefined();
    expect(sanitized._symbols_truncation_meta).toBeUndefined();
    expect(sanitized.stressScoreNote).toBe('internal note');
    expect(sanitized.symbolCoverage).toEqual({ selection: 'top symbols', tiers: {} });
    expect(sanitized.venuesNote).toBe('No ATS venue breakdown');
    expect(sanitized.rateContext).toEqual({ source: 'platform 10Y benchmark', maturity: '10Y' });
    expect(sanitized.comparison.count).toBe(20);
    expect(sanitized.comparison.preview).toEqual([{ strike: 380, agreement: 'majority buy' }]);
    expect(sanitized.comparison._count).toBeUndefined();
    expect(sanitized.comparison._preview).toBeUndefined();
    expect(sanitized.comparison._meta).toBeUndefined();
  });

  test('strips sync row database identifiers without dropping market data ids', () => {
    const sanitized = sanitizeMcpWireOutput({
      data: [
        { id: 22, user_id: 316, created_at: '2026-04-01', run_key: 'abc', status: 'completed' },
        { id: 23, data: {}, timestamp: 1770000000000, event: 'market-row-like-shape' },
        { id: 'filing-1', formType: '10-K' },
      ],
    }) as Record<string, any>;

    expect(sanitized.data[0].id).toBeUndefined();
    expect(sanitized.data[0].user_id).toBeUndefined();
    expect(sanitized.data[0].created_at).toBeUndefined();
    expect(sanitized.data[0].run_key).toBeUndefined();
    expect(sanitized.data[1].id).toBe(23);
    expect(sanitized.data[2].id).toBe('filing-1');
  });

  test('strips internal snapshot and position identifiers from nested sync payloads', () => {
    const sanitized = sanitizeMcpWireOutput({
      data: [{
        runKey: 'run-123',
        details: { snapshotId: 2 },
        summary: { portfolioSnapshotId: 7, riskSnapshotId: 8 },
        positions: [{ positionId: 'pos-a', symbol: 'AAPL 250C' }],
      }],
    }) as Record<string, any>;

    expect(sanitized.data[0].runKey).toBeUndefined();
    expect(sanitized.data[0].details.snapshotId).toBeUndefined();
    expect(sanitized.data[0].summary.portfolioSnapshotId).toBeUndefined();
    expect(sanitized.data[0].summary.riskSnapshotId).toBeUndefined();
    expect(sanitized.data[0].positions[0].positionId).toBeUndefined();
  });

  test('strips nested sync snapshot ids and raw contribution arrays without dropping market ids', () => {
    const sanitized = sanitizeMcpWireOutput({
      data: [
        {
          id: 2,
          timestamp: 1776550587306,
          totalValue: 107864.29,
          delta: 309.6892,
        },
        {
          id: 3,
          timestamp: 1776550584312,
          portfolioValue: 161179.82,
          positionContributions: [{ symbol: 'AAPL', contribution: 1200 }],
          position_contributions: [{ symbol: 'META', contribution: -800 }],
        },
        {
          id: 23,
          data: {},
          timestamp: 1770000000000,
          event: 'market-row-like-shape',
        },
      ],
    }) as Record<string, any>;

    expect(sanitized.data[0].id).toBeUndefined();
    expect(sanitized.data[1].id).toBeUndefined();
    expect(sanitized.data[1].positionContributions).toBeUndefined();
    expect(sanitized.data[1].position_contributions).toBeUndefined();
    expect(sanitized.data[2].id).toBe(23);
  });
});

describe('toolHandler — _skipSizeGuard bypass removal', () => {
  test('legacy { _skipSizeGuard: true, data } is unwrapped AND size-guarded', async () => {
    // Pre-fix, this payload would have skipped applyResponseSizeGuard and
    // serialized verbatim. Post-fix, the wrapper is unwrapped and the
    // inner data is forced through the size guard like everything else.
    const huge = {
      data: Array.from({ length: 200 }, (_, i) => ({
        id: i,
        blob: 'x'.repeat(2000),
      })),
    };
    const handler = toolHandler(async () => ({ _skipSizeGuard: true, data: huge }));
    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    // Wrapper unwrapped: top-level is the inner shape, not { _skipSizeGuard, data }
    expect(parsed._skipSizeGuard).toBeUndefined();
    // Size-guarded: 200 × 2KB rows would be ~400KB raw; guard truncates to 5
    expect(parsed.data).toHaveLength(5);
    // Output is well under the 50KB cap
    expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThan(50 * 1024);
  });

  // Proxy failure campaign (review): a full-mode wrapper around the client's null for a 404 is no data, never an
  // internal error from reading the null.
  test('a full-mode wrapper around null or undefined is no data, not an error', async () => {
    for (const inner of [null, undefined]) {
      const result = await toolHandler(async () => ({ _skipSizeGuard: true, data: inner }))({});
      expect(result.isError).not.toBe(true);
      expect(result.content[0].text).toBe('No data available for this query.');
      expect(result.structuredContent).toEqual({ dataAvailable: false, message: 'No data available for this query.' });
    }
  });
});

describe('toolHandler — structuredContent', () => {
  test('preserves the exact legacy response for an ordinary ApiError', async () => {
    const result = await toolHandler(async () => {
      throw new ApiError('Request to /live/x failed (HTTP 502)', 502);
    })({});

    expect(result).toEqual({
      content: [{ type: 'text', text: 'API error: Request to /live/x failed (HTTP 502)' }],
      isError: true,
    });
  });

  test('renders a validation path unambiguously, so a dotted key is not read as nesting', async () => {
    // A record key may itself contain a dot. Joining segments with '.' renders
    // the key "a.b" identically to the nested field a -> b, and a model
    // correcting the call then edits the wrong field. The structured path stays
    // an array; only the human-readable rendering needs disambiguating.
    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 400, undefined, undefined, undefined, {
        issues: [
          { path: ['filters', 'a.b'], message: 'not a number' },
          { path: ['legs', 0, 'strike'], message: 'required' },
          { path: [], message: 'body is empty' },
        ],
      });
    })({});

    const text = result.content[0].text;
    expect(text, 'a dotted key must be quoted, not silently nested').toContain('filters["a.b"]: not a number');
    expect(text, 'an array index is not a field name').toContain('legs[0].strike: required');
    expect(text, 'a pathless issue keeps just its message').toContain('body is empty');
    expect(text).not.toContain('[object Object]');
    // The machine-readable path is untouched.
    expect((result.structuredContent as any)?.issues?.[0]?.path).toEqual(['filters', 'a.b']);
  });

  test('a pathological path does not cost the model the error itself', async () => {
    // `path` is preserved as received from a parsed HTTP body, so its shape is
    // not ours to assume. JSON.stringify RECURSES, and this runs inside the
    // catch that is supposed to be REPORTING the failure: a RangeError here
    // replaces the message, the code and `retryable` with "Maximum call stack
    // size exceeded", and a model that cannot see `retryable: false` retries a
    // call that can never succeed, against the user's own broker quota.
    let deep: unknown = 'leaf';
    for (let i = 0; i < 50_000; i += 1) deep = [deep];

    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, {
        issues: [{ path: deep, message: 'invalid field' }],
      });
    })({});

    const text = result.content[0].text;
    expect(text).not.toContain('Maximum call stack size exceeded');
    expect(text).toContain('Validation failed');
    expect(text).toContain('Retrying the same request will not succeed.');
    expect((result.structuredContent as any)?.code).toBe('VALIDATION');
    expect((result.structuredContent as any)?.retryable).toBe(false);
    // The whole result must survive the serialization the MCP SDK performs
    // OUTSIDE this catch, where a throw is not recoverable at all.
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  test('an oversized detail payload is dropped, and said to be dropped', async () => {
    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, 'https://x.test/fix', {
        issues: [{ path: { field: 'x'.repeat(100_000) }, message: 'invalid field' }],
      });
    })({});

    const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    expect(bytes, 'an error must not blow the response budget').toBeLessThan(50 * 1024);
    // Silence would leave the model believing it had been told everything.
    expect(result.content[0].text.toLowerCase()).toContain('omitted');
    expect((result.structuredContent as any)?.detailsOmitted).toBe(true);
    // The fields that decide what happens NEXT are never what gets dropped.
    expect((result.structuredContent as any)?.code).toBe('VALIDATION');
    expect((result.structuredContent as any)?.retryable).toBe(false);
    expect((result.structuredContent as any)?.actionUrl).toBe('https://x.test/fix');
    expect(result.content[0].text).toContain('https://x.test/fix');
  });

  const errorBytes = (r: any): number => new TextEncoder().encode(JSON.stringify(r)).byteLength;

  test('every error branch is bounded, not just the structured one', async () => {
    // A schema-accepted 100,000-character symbol echoed by an upstream 502
    // reached the client as a 100KB error. AuthError, SubscriptionError, a
    // plain ApiError and an unrecognised throw all returned err.message raw.
    const huge = 'S'.repeat(100_000);
    const branches = [
      new AuthError(`bad session ${huge}`),
      new SubscriptionError(`tier required ${huge}`),
      new ApiError(`upstream said ${huge}`, 502),
      new LiveApiError(`upstream said ${huge}`, 502, 'UPSTREAM', true, undefined, {}),
      new Error(`unrecognised ${huge}`),
    ];
    for (const err of branches) {
      const result = await toolHandler(async () => { throw err; })({});
      expect(errorBytes(result), err.constructor.name).toBeLessThan(50 * 1024);
    }
  });

  test('truncation never costs the model the guidance on what to do next', async () => {
    // hint, actionUrl and the omission notice were appended AFTER the message
    // and the whole string truncated, so a long message removed exactly the
    // part that says do not retry. A text-only client then retries forever.
    const result = await toolHandler(async () => {
      throw new LiveApiError('M'.repeat(9_000), 403, 'BROKER_CREDENTIAL_INVALID', false, 'https://x.test/fix', {});
    })({});

    const text = result.content[0].text;
    expect(text).toContain('Retrying the same request will not succeed.');
    expect(text).toContain('https://x.test/fix');
    expect((result.structuredContent as any)?.retryable).toBe(false);
    // The code rides in the prefix, ahead of everything truncation can take.
    expect(text.startsWith('API error (BROKER_CREDENTIAL_INVALID): ')).toBe(true);
    // A truncated message ends in the suffix; no full stop is bolted onto it.
    expect(text).toContain('... [truncated] Retrying the same request will not succeed.');
  });

  test('the text names the code and separates the message from the guidance', async () => {
    // A text-only client saw "not listed for SPY Retrying will not succeed."
    // and never the code that was in structuredContent. The code goes in the
    // prefix; a full stop is added only where the message brought none.
    const bare = await toolHandler(async () => {
      throw new LiveApiError('Expiration 2020-01-17 is not listed for SPY', 400, 'UNKNOWN_EXPIRATION', false, undefined, {});
    })({});
    expect(bare.content[0].text).toBe('API error (UNKNOWN_EXPIRATION): Expiration 2020-01-17 is not listed for SPY. Retrying the same request will not succeed.');
    const punctuated = await toolHandler(async () => {
      throw new LiveApiError('Broker refused the credential.', 403, 'BROKER_CREDENTIAL_INVALID', false, undefined, {});
    })({});
    expect(punctuated.content[0].text).toBe('API error (BROKER_CREDENTIAL_INVALID): Broker refused the credential. Retrying the same request will not succeed.');
    // No code: the plain prefix, as before.
    const uncoded = await toolHandler(async () => {
      throw new LiveApiError('Upstream busy', 503, undefined as any, true, undefined, {});
    })({});
    expect(uncoded.content[0].text).toBe('API error: Upstream busy. This may be retried.');
  });

  test('the text budget counts UTF-8 bytes, suffix included', async () => {
    // slice() counts CHARACTERS. A multibyte message sliced at 8192 chars is
    // up to three times the byte budget, and the suffix was added afterwards,
    // so even ASCII overshot.
    for (const fill of ['A', '\u00e9', '\u4e16', '\u{1f600}']) {
      const result = await toolHandler(async () => {
        throw new ApiError(fill.repeat(20_000), 500);
      })({});
      const bytes = new TextEncoder().encode(result.content[0].text).byteLength;
      // Against the MESSAGE budget (2KB), not the 8KB text budget: slicing
      // 2048 CHARACTERS of a 3-byte character is 6KB, which slips under 8KB
      // and would leave the defect in place.
      expect(bytes, `fill ${JSON.stringify(fill)}`).toBeLessThanOrEqual(2 * 1024 + 64);
      // A truncated multi-byte sequence would decode to U+FFFD.
      expect(result.content[0].text, `fill ${JSON.stringify(fill)}`).not.toContain('\uFFFD');
    }
  });

  test('the detail budget bounds the WORK, not only the output', async () => {
    // The budget was checked after cloning the whole graph twice and
    // serializing it, so 250,000 issues cost 137ms and 84MB before being
    // discarded. Count how many entries are actually visited.
    let touched = 0;
    const LENGTH = 1_000_000;
    const lazyIssues = new Proxy([] as unknown[], {
      get(target, prop, receiver) {
        if (prop === 'length') return LENGTH;
        if (typeof prop === 'string' && /^\d+$/.test(prop)) {
          touched += 1;
          return { path: ['legs', Number(prop)], message: 'invalid field' };
        }
        return Reflect.get(target, prop, receiver);
      },
      has(target, prop) {
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return Number(prop) < LENGTH;
        return Reflect.has(target, prop);
      },
    });

    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, { issues: lazyIssues });
    })({});

    expect(touched, 'traversal must stop at the cap, not at the end of the array').toBeLessThan(1_000);
    // Bounded, but not silently: the model is told how many it is not seeing,
    // and the fields that decide what happens next still survive.
    const issues = (result.structuredContent as any)?.issues as unknown[];
    expect(issues.length).toBeLessThan(1_000);
    expect(String(issues.at(-1))).toContain('further validation issues omitted');
    expect(result.content[0].text).toContain('further validation issues omitted');
    expect((result.structuredContent as any)?.retryable).toBe(false);
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(8 * 1024);
  });

  test('the truncation suffix is counted inside the budget, not added past it', async () => {
    // AuthError has no prefix, so the text IS the truncated message and the
    // budget can be asserted exactly. Appending the suffix after cutting at the
    // limit overshoots by its own length, every time.
    const result = await toolHandler(async () => { throw new AuthError('A'.repeat(50_000)); })({});
    const bytes = new TextEncoder().encode(result.content[0].text).byteLength;
    expect(bytes).toBeLessThanOrEqual(2 * 1024);
    expect(result.content[0].text).toContain('[truncated]');
  });

  test('a legitimately nested path is marked where it was cut, not silently flattened', async () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 20; i += 1) nested = [nested];
    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, {
        issues: [{ path: nested, message: 'invalid field' }],
      });
    })({});

    // Depth is bounded, and the boundary is visible rather than implied.
    expect(JSON.stringify((result.structuredContent as any)?.issues)).toContain('[...]');
    expect(result.content[0].text).toContain('invalid field');
  });

  test('an oversized KEY is refused before it is serialized', async () => {
    // The budget is checked on emitted bytes, so a huge key was passed whole
    // through JSON.stringify first and only then rejected. Bounding the output
    // is not bounding the work: watch what the serializer is actually handed.
    const realStringify = JSON.stringify;
    let largestSerialized = 0;
    (JSON as any).stringify = (value: unknown, ...rest: unknown[]) => {
      if (typeof value === 'string') largestSerialized = Math.max(largestSerialized, value.length);
      return (realStringify as any)(value, ...rest);
    };
    try {
      const result = await toolHandler(async () => {
        throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, {
          [`k${'K'.repeat(4_000_000)}`]: 'v',
        });
      })({});
      expect(largestSerialized, 'a 4MB key must never reach JSON.stringify').toBeLessThan(100_000);
      expect((result.structuredContent as any)?.detailsOmitted).toBe(true);
      expect((result.structuredContent as any)?.retryable).toBe(false);
    } finally {
      (JSON as any).stringify = realStringify;
    }
  });

  test('properties that emit nothing still consume the work budget', async () => {
    // Skipped properties pushed no bytes, so the budget never noticed them:
    // 100,000 getters returning undefined were every one visited and the
    // result was {} with exceeded false. Cost is the thing being bounded.
    let reads = 0;
    const hostile: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i += 1) {
      Object.defineProperty(hostile, `k${i}`, {
        enumerable: true,
        get() { reads += 1; return undefined; },
      });
    }

    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 422, 'VALIDATION', false, undefined, { hostile });
    })({});

    expect(reads, 'property visits must be bounded, not only emitted bytes').toBeLessThan(10_000);
    expect((result.structuredContent as any)?.retryable).toBe(false);
  });

  test('the budget catches an accumulation, not only one oversized scalar', async () => {
    // Every entry here is small; only the total is over. A budget checked once
    // at the end would pass each scalar and still emit the whole payload, so
    // this is what pins the running check rather than the per-scalar guard.
    const result = await toolHandler(async () => {
      throw new LiveApiError('Validation failed', 400, 'UNKNOWN_EXPIRATION', false, undefined, {
        availableExpirations: Array.from({ length: 500 }, (_, i) => `2026-${String((i % 12) + 1).padStart(2, '0')}-1${i % 10}`),
      });
    })({});

    expect((result.structuredContent as any)?.detailsOmitted).toBe(true);
    expect(result.content[0].text).toContain('omitted');
    expect((result.structuredContent as any)?.code).toBe('UNKNOWN_EXPIRATION');
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThan(8 * 1024);
  });

  test('a real UNKNOWN_EXPIRATION list still reaches the model intact', async () => {
    // The endpoint caps its advice at 12 dates. That must comfortably fit, or
    // the budget would be silently eating the guidance it exists to protect.
    const available = Array.from({ length: 12 }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}-19`);
    const result = await toolHandler(async () => {
      throw new LiveApiError('Unknown expiration', 400, 'UNKNOWN_EXPIRATION', false, undefined, {
        availableExpirations: available, availableExpirationsTruncated: true,
      });
    })({});

    expect((result.structuredContent as any)?.detailsOmitted).toBeUndefined();
    expect((result.structuredContent as any)?.availableExpirations).toEqual(available);
    for (const date of available) expect(result.content[0].text).toContain(date);
  });

  test('returns structuredContent matching the sanitized text payload for object responses', async () => {
    const handler = toolHandler(async () => ({
      data: [{ id: 1, user_id: 22, symbol: 'SPY' }],
      _rate_meta: { source: 'platform 10Y benchmark' },
    }));

    const result = await handler({});
    const parsed = JSON.parse(result.content[0].text);

    expect(result.structuredContent).toEqual(parsed);
    expect(result.structuredContent).toEqual({
      data: [{ symbol: 'SPY' }],
      rateContext: { source: 'platform 10Y benchmark' },
    });
  });

  test('wraps root-array structuredContent in a data envelope while preserving text JSON', async () => {
    const handler = toolHandler(async () => ([{ symbol: 'AAPL' }, { symbol: 'MSFT' }]));

    const result = await handler({});

    expect(JSON.parse(result.content[0].text)).toEqual([{ symbol: 'AAPL' }, { symbol: 'MSFT' }]);
    expect(result.structuredContent).toEqual({
      data: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
    });
  });

  test('returns structuredContent for null and empty sync responses', async () => {
    const nullResult = await toolHandler(async () => null)({});
    expect(nullResult.structuredContent).toEqual({
      dataAvailable: false,
      message: 'No data available for this query.',
    });

    const syncEmptyResult = await toolHandler(async () => ({ data: [] }), { isSyncTool: true })({});
    expect(syncEmptyResult.structuredContent).toEqual({
      dataAvailable: false,
      data: [],
      message: 'No data found. Make sure MCP sync is enabled in the platform\'s Account Settings. Data syncs automatically as you use the platform.',
    });
  });
});

describe('no tool output names a data vendor', () => {
  // A company profile's and a news item's `image` is a URL on the equity
  // vendor's image host (12,914 of 12,957 profiles and 131,506 of 135,620
  // news rows on 2026-09-23), and both tools pass the raw row through on
  // `full`. Backend error text can quote a vendor too. Broker names are not
  // data vendors and stay. The names are built from base64 so this file,
  // which the public mirror ships, names no vendor itself.
  const decode = (s: string) => Buffer.from(s, 'base64').toString('utf8');
  const OPT = decode('T1JBVFM=');
  const EQ = decode('Rk1Q');
  const EQ_LONG = decode('RmluYW5jaWFsIE1vZGVsaW5nIFByZXA=').split(' ');
  const EQ_HOST = `images.${EQ_LONG.join('').toLowerCase()}.com`;
  const any = new RegExp(`${OPT}|${EQ}|${EQ_LONG.join('\\W*')}`, 'i');

  test('drops a value that is a vendor URL, and keeps other URLs', () => {
    const out = sanitizeMcpWireOutput({
      symbol: 'ROIV', image: `https://${EQ_HOST}/symbol/ROIV.png`, website: 'https://roivant.com',
      rows: [{ title: 'x', image: ` http://${EQ_HOST}/news/a.jpg ` }],
    }) as any;
    expect(out).toEqual({ symbol: 'ROIV', website: 'https://roivant.com', rows: [{ title: 'x' }] });
  });

  test('rewrites vendor names in text, in any case and spacing, and a vendor URL inside text', () => {
    const out = sanitizeMcpWireOutput({
      a: `${OPT} import success is for 2026-09-22`,
      b: `data from ${EQ_LONG.join('  ')} and ${EQ_LONG.join('\n')}`,
      c: `${EQ}_API_KEY not set; ${EQ.toLowerCase()} sync; [${EQ.charAt(0)}${EQ.slice(1).toLowerCase()}Sync]`,
      d: `see https://${EQ_HOST}/x.png for the chart`,
      e: [`${OPT.toLowerCase()}_strikes_not_clean`],
    }) as any;
    expect(JSON.stringify(out)).not.toMatch(any);
    expect(out).toEqual({
      a: 'VENDOR import success is for 2026-09-22',
      b: 'data from Vendor and Vendor',
      c: 'VENDOR_API_KEY not set; vendor sync; [VendorSync]',
      d: 'see a removed link for the chart',
      e: ['vendor_strikes_not_clean'],
    });
  });

  test('rewrites vendor names in keys, data-keyed ones included', () => {
    const out = sanitizeMcpWireOutput({
      [`${EQ.toLowerCase()}_rating`]: 4,
      [`${OPT.toLowerCase()}Iv`]: 0.3,
      tiers: { [`${OPT.toLowerCase()}_tier`]: 1 },
    }) as any;
    expect(out).toEqual({ vendorRating: 4, vendorIv: 0.3, tiers: { vendor_tier: 1 } });
  });

  test('leaves broker names and ordinary words alone', () => {
    const text = `Tradier, tastytrade, Schwab and Public.com; the platform formats moratorium decorators; hal${EQ.toLowerCase()}`;
    expect(sanitizeMcpWireOutput({ text })).toEqual({ text });
  });

  test('scrubs below the recursion limit too', () => {
    let deep: any = { note: `${OPT} feed`, image: `https://${EQ_HOST}/a.png` };
    for (let i = 0; i < 30; i += 1) deep = { inner: deep };
    expect(JSON.stringify(sanitizeMcpWireOutput(deep))).not.toMatch(any);
    let inner: any = sanitizeMcpWireOutput(deep);
    while (inner.inner) inner = inner.inner;
    expect(inner).toEqual({ note: 'VENDOR feed' });
  });

  test('error text, codes, action URLs and details carry no vendor name', async () => {
    const thrown = [
      new ApiError(`${EQ} profile request failed`, 502),
      new AuthError(`${OPT} says no`),
      new SubscriptionError(`${OPT} tier`),
      new Error(`Could not check ${OPT} sync_progress`),
      new LiveApiError(`${EQ_LONG.join(' ')} down`, 503, `${EQ}_UPSTREAM_DOWN`, true, `https://${EQ_HOST}/fix`, {
        source: OPT, [`${EQ.toLowerCase()}Status`]: 503,
      }),
    ];
    for (const err of thrown) {
      const res = await toolHandler(async () => { throw err; })({});
      expect(res.isError, err.message).toBe(true);
      expect(JSON.stringify(res), err.message).not.toMatch(any);
    }
  });

  test('a form feed before "mp" is text, not a vendor name, and the call succeeds', async () => {
    // Rewriting serialized JSON turned the escape \f followed by "mp" into
    // an invalid escape and rejected the call outside the handler's catch.
    const value = `\f${'mp'}, a form feed then "mp"`;
    const res = await toolHandler(async () => ({ description: value }))({});
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as any).description).toBe(value);
    let deep: any = { description: value };
    for (let i = 0; i < 30; i += 1) deep = { inner: deep };
    let inner: any = sanitizeMcpWireOutput(deep);
    while (inner.inner) inner = inner.inner;
    expect(inner.description).toBe(value);
  });

  test('a name across a line break is caught in structured errors and past the depth limit', async () => {
    const res = await toolHandler(async () => {
      throw new LiveApiError(`${EQ_LONG.join('\n')} failed`, 503, 'UPSTREAM', true, undefined, { note: `${EQ_LONG.join('\r\n')}` });
    })({});
    expect(JSON.parse(JSON.stringify(res.structuredContent)).error).toBe('Vendor failed');
    expect((res.structuredContent as any).note).toBe('Vendor');
    let deep: any = { note: `${EQ_LONG.join('\n')} feed` };
    for (let i = 0; i < 30; i += 1) deep = { inner: deep };
    let inner: any = sanitizeMcpWireOutput(deep);
    while (inner.inner) inner = inner.inner;
    expect(inner.note).toBe('Vendor feed');
  });

  test('the acronym is caught as a camelCase or snake_case segment and in the plural', () => {
    const lower = EQ.toLowerCase();
    const out = sanitizeMcpWireOutput({
      [`source_${lower}`]: 'quarterly',
      [`source${EQ}`]: 1,
      [`_source_${lower}_meta`]: { a: 1 },
      text: `two ${EQ}s and ${EQ}S; ${lower}s`,
    }) as any;
    expect(out).toEqual({ sourceVendor: 'quarterly', sourceVENDOR: 1, sourceVendorMeta: { a: 1 }, text: 'two VENDORs and VENDORS; vendors' });
  });

  test('a key renamed for a vendor never overwrites another key', () => {
    const opt = OPT.toLowerCase();
    const eq = EQ.toLowerCase();
    expect(sanitizeMcpWireOutput({ ratings: { [opt]: 1, [eq]: 2 } })).toEqual({ ratings: { vendor: 1, vendor2: 2 } });
    expect(sanitizeMcpWireOutput({ [opt]: 1, vendor: 2 })).toEqual({ vendor2: 1, vendor: 2 });
    expect(sanitizeMcpWireOutput({ [opt]: 1, [eq]: 2, vendor2: 3 })).toEqual({ vendor: 1, vendor3: 2, vendor2: 3 });
    expect(sanitizeMcpWireOutput({ [`${opt}_x`]: 1, vendor_x: 2 })).toEqual({ vendorX2: 1, vendorX: 2 });
  });

  test('scrubbing stays inside the error budgets', async () => {
    // The replacement is longer than the acronym, and it ran after
    // truncation: a structured error reached 11,515 bytes against 8,192.
    const long = `${EQ} `.repeat(3_000);
    const bytes = (x: string) => new TextEncoder().encode(x).byteLength;
    for (const err of [
      new LiveApiError(long, 503, 'UPSTREAM', true, undefined, { note: long.slice(0, 3_000) }),
      new ApiError(long, 502),
      new Error(long),
    ]) {
      const res = await toolHandler(async () => { throw err; })({});
      expect(bytes(res.content[0].text)).toBeLessThanOrEqual(8 * 1024);
      expect(JSON.stringify(res)).not.toMatch(any);
      const structured = res.structuredContent as any;
      if (structured) {
        expect(bytes(structured.error)).toBeLessThanOrEqual(2 * 1024);
        expect(bytes(JSON.stringify(structured.note ?? ''))).toBeLessThanOrEqual(4 * 1024);
      }
    }
  });

  test('an action URL on a vendor host is withheld', async () => {
    const res = await toolHandler(async () => {
      throw new LiveApiError('down', 503, 'UPSTREAM', false, `https://${EQ_HOST}/status`, {});
    })({});
    expect((res.structuredContent as any).actionUrl).toBeUndefined();
    expect(res.content[0].text).toBe('API error (UPSTREAM): down. Retrying the same request will not succeed.');
  });

  test("a URL on any vendor host is dropped, the cloud product's name included", () => {
    const cloud = `${EQ.toLowerCase()}cloud.io`;
    const out = sanitizeMcpWireOutput({
      a: `https://${cloud}/api/v3/profile/AAPL`,
      b: `https://api.${OPT.toLowerCase()}.io/datav2/strikes`,
      // Percent-encoded, in the host and in the path.
      e: `https://%${OPT.toLowerCase().charCodeAt(0).toString(16)}${OPT.toLowerCase().slice(1)}.io/datav2/strikes`,
      f: `https://%${EQ.toLowerCase().charCodeAt(0).toString(16)}${EQ.toLowerCase().slice(1)}cloud.io/api/v3/profile/AAPL`,
      g: `https://example.com/%${OPT.toLowerCase().charCodeAt(0).toString(16)}${OPT.toLowerCase().slice(1)}/x`,
      // Full-width letters, which the URL parser folds to the ASCII host.
      h: `https://${[...OPT.toLowerCase()].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('')}.io/x`,
      // A host that merely contains a short name is not a vendor's.
      breeder: `https://www.k${OPT.toLowerCase()}.com/`,
      c: `see https://${cloud}/x and https://example.com/y`,
      d: `${EQ} Cloud and ${EQ.toLowerCase()}cloud`,
      keep: 'https://example.com/y',
    });
    expect(out).toEqual({
      c: 'see a removed link and https://example.com/y', d: 'Vendor and vendor',
      breeder: `https://www.k${OPT.toLowerCase()}.com/`, keep: 'https://example.com/y',
    });
  });

  test('a name in full-width letters is a name, and nothing else in the string changes', () => {
    const wide = (x: string) => [...x].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    expect(sanitizeMcpWireOutput({ a: `per ${wide(OPT)}`, [wide(EQ.toLowerCase())]: 1, b: `${wide('ABC')} fund` }))
      .toEqual({ a: 'per VENDOR', vendor: 1, b: `${wide('ABC')} fund` });
    // Mixed with an ASCII name, and beside notation a whole-string fold
    // would rewrite (10 to the sixth became 106).
    expect(sanitizeMcpWireOutput({
      mixed: `${EQ} and ${wide(OPT)} supply data.`,
      notation: `Shares outstanding: 10\u2076. ${wide('ABC')} fund. Source: ${wide(OPT)}.`,
      // A ligature folds to two letters; the name after it is still the span
      // that changes.
      ligature: `\ufb01nance and ${wide(OPT)} and ${wide('X')}`,
      spaced: `${EQ_LONG.join('\u3000')} feed`,
      url: `see https://example.com/${wide('ABC')} and https://${wide(OPT.toLowerCase())}.io/x`,
    })).toEqual({
      mixed: 'VENDOR and VENDOR supply data.',
      notation: `Shares outstanding: 10\u2076. ${wide('ABC')} fund. Source: VENDOR.`,
      ligature: `\ufb01nance and VENDOR and ${wide('X')}`,
      spaced: 'Vendor feed',
      url: `see https://example.com/${wide('ABC')} and a removed link`,
    });
  });

  test('error text and details fold full-width names too', async () => {
    const wide = (x: string) => [...x].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join('');
    const res = await toolHandler(async () => {
      throw new LiveApiError(`${EQ} and ${wide(OPT)} down`, 503, 'UPSTREAM', true, undefined, { note: `${EQ} and ${wide(OPT)}` });
    })({});
    expect(res.content[0].text).not.toMatch(any);
    expect(res.content[0].text).not.toContain(wide(OPT));
    expect(JSON.stringify(res.structuredContent)).not.toContain(wide(OPT));
    expect((res.structuredContent as any).error).toBe('VENDOR and VENDOR down');
  });

  test('a word that merely contains a short name is left alone', () => {
    const text = `The company breeds K${OPT.toLowerCase()}. K${OPT} too.`;
    expect(sanitizeMcpWireOutput({ description: text })).toEqual({ description: text });
    expect(sanitizeMcpWireOutput({ description: `per ${OPT}, ${OPT.charAt(0)}${OPT.slice(1).toLowerCase()} and ${OPT.toLowerCase()}Iv` }))
      .toEqual({ description: 'per VENDOR, Vendor and vendorIv' });
  });

  test('a key the camelCase conversion turns into a vendor name never overwrites another key', () => {
    const spelled = EQ.toLowerCase().split('').join('_');
    expect(sanitizeMcpWireOutput({ [`source_${spelled}`]: 1, sourceVENDOR: 2 })).toEqual({ sourceVENDOR2: 1, sourceVENDOR: 2 });
  });

  test('a __proto__ key past the depth limit stays a key', () => {
    let deep: any = JSON.parse('{"__proto__":{"sentinel":1},"keep":2}');
    for (let i = 0; i < 25; i += 1) deep = { inner: deep };
    let inner: any = sanitizeMcpWireOutput(deep);
    while (inner.inner) inner = inner.inner;
    expect(Object.keys(inner)).toEqual(['__proto__', 'keep']);
    expect(JSON.parse(JSON.stringify(inner))).toEqual(JSON.parse('{"__proto__":{"sentinel":1},"keep":2}'));
    expect(Object.getPrototypeOf(inner)).toBe(Object.prototype);
  });

  test('a key named like an Object.prototype member is an ordinary key', () => {
    // The rename tables were consulted with `in`, which also finds inherited
    // members: {constructor: 1} came out under the key "function Object()...".
    expect(sanitizeMcpWireOutput({ constructor: 1, toString: 2, valueOf: 3 })).toEqual({ constructor: 1, toString: 2, valueOf: 3 });
  });

  test('the value sanitized is what JSON.stringify publishes, and it is scrubbed', () => {
    // toJSON, functions, boxed primitives and getters are settled by the
    // native serializer, once, before anything is scrubbed.
    const callable = Object.assign(() => {}, { toJSON: () => OPT });
    const arrayWithToJSON = Object.assign([1, 2], { toJSON() { return this; } });
    let reads = 0;
    const getter = { get toJSON() { reads += 1; return () => `${OPT} once`; } };
    const seen: string[] = [];
    const keyed = { toJSON: (key: string) => { seen.push(key); return `${key}:${OPT}`; } };
    const cases: unknown[] = [
      { named: { toJSON: () => OPT } },
      { payload: { toJSON: () => callable } },
      { direct: callable },
      [callable, { toJSON: () => callable }],
      { list: arrayWithToJSON },
      { n: new Number(42), b: new Boolean(false), s: new String(OPT) },
      { gone: { toJSON: () => undefined }, price: keyed, list: [keyed] },
      { date: new Date('2026-09-22T20:00:00Z') },
    ];
    for (const input of cases) {
      const native = JSON.parse(JSON.stringify(input));
      expect(sanitizeMcpWireOutput(input)).toEqual(sanitizeMcpWireOutput(native));
      expect(JSON.stringify(sanitizeMcpWireOutput(input))).not.toMatch(any);
    }
    expect(sanitizeMcpWireOutput(cases[0])).toEqual({ named: 'VENDOR' });
    expect(sanitizeMcpWireOutput(cases[1])).toEqual({});
    expect(sanitizeMcpWireOutput(cases[4])).toEqual({ list: [1, 2] });
    expect(sanitizeMcpWireOutput(cases[5])).toEqual({ n: 42, b: false, s: 'VENDOR' });
    expect(sanitizeMcpWireOutput(cases[7])).toEqual({ date: '2026-09-22T20:00:00.000Z' });
    expect(sanitizeMcpWireOutput(callable)).toBe('VENDOR');
    expect(sanitizeMcpWireOutput(() => 1)).toBeUndefined();
    reads = 0;
    expect(sanitizeMcpWireOutput({ getter })).toEqual({ getter: 'VENDOR once' });
    expect(reads).toBe(1);
    seen.length = 0;
    sanitizeMcpWireOutput(cases[6]);
    expect(seen).toEqual(['price', '0']);
  });

  test('a full-path payload reaches the client without a vendor name', async () => {
    const res = await toolHandler(async () => ({
      _skipSizeGuard: true,
      data: { symbol: 'ROIV', image: `https://${EQ_HOST}/symbol/ROIV.png`, description: `per ${OPT}` },
    }))({});
    expect(JSON.stringify(res)).not.toMatch(any);
    expect(res.structuredContent).toEqual({ symbol: 'ROIV', description: 'per VENDOR' });
  });
});

describe('sanitizeMcpWireOutput never publishes our own infrastructure', () => {
  // The proxy's history provenance names the database product and the table
  // each answer came from (2026-09-30 smoke test: "provider":"supabase",
  // scan_tickers, scan_strikes, option_ticker_snapshots), on get_iv_history,
  // get_greeks_history and get_options_analytics_history.
  const provenance = {
    provider: 'supabase',
    source: 'scan_tickers',
    sourceKind: 'cached',
    historySnapshotId: 'scan_tickers:SPY:auto:latest:2026-09-29:62',
    openInterestSource: 'scan_strikes',
    volumeSource: 'option_ticker_snapshots',
    greeksSource: 'option_term_structure',
    fetchedAt: '2026-09-29T20:00:00.000Z',
  };

  test('drops a field whose value is the database product, and relabels table names wherever they appear', () => {
    const out = sanitizeMcpWireOutput({ provenance, rows: [{ source: 'futures_strikes' }, { source: 'ticker_snapshots' }] }) as any;
    const text = JSON.stringify(out);
    expect(text).not.toMatch(/supabase/i);
    for (const table of ['scan_tickers', 'scan_strikes', 'option_ticker_snapshots', 'option_term_structure', 'futures_strikes', 'ticker_snapshots']) {
      expect(text).not.toContain(table);
    }
    expect(out.provenance).not.toHaveProperty('provider');
    expect(out.provenance).toMatchObject({
      source: 'eod-options-summary',
      historySnapshotId: 'eod-options-summary:SPY:auto:latest:2026-09-29:62',
      openInterestSource: 'eod-strike-data',
      volumeSource: 'eod-options-snapshot',
      greeksSource: 'eod-term-structure',
      sourceKind: 'cached',
      fetchedAt: '2026-09-29T20:00:00.000Z',
    });
    expect(out.rows).toEqual([{ source: 'eod-futures-strikes' }, { source: 'eod-ticker-snapshot' }]);
  });

  test('rewrites the database product named inside text, and leaves lookalike words alone', () => {
    expect(sanitizeMcpWireOutput({ note: 'Read from Supabase at 20:00.' })).toEqual({ note: 'Read from the platform database at 20:00.' });
    expect(sanitizeMcpWireOutput({ source: 'SUPABASE' })).toEqual({});
    // Not our tables: a word that merely contains one, and ordinary fields.
    expect(sanitizeMcpWireOutput({ note: 'rescan_tickers_x', other: 'rescan_tickers', source: 'historical', table: 'default' }))
      .toEqual({ note: 'rescan_tickers_x', other: 'rescan_tickers', source: 'historical', table: 'default' });
  });

  test('the same scrub reaches an error result', async () => {
    const handler = toolHandler(async () => {
      throw new LiveApiError('read from scan_strikes via supabase failed', 503, 'UPSTREAM', true, undefined, { table: 'scan_strikes' });
    });
    const result: any = await handler({});
    expect(JSON.stringify(result)).not.toMatch(/supabase|scan_strikes/i);
  });
});

describe('toolHandler publishes every number at 15 significant digits', () => {
  // The thirty-third run: get_options_chain atmStraddleMid 4.4399999999999995,
  // get_insider_trading totalValue 815803.9400000001, get_snapshot cashBalance
  // 32164.399999999994, get_greeks_history values at 17 digits.
  test('drops binary noise everywhere in a result and leaves whole numbers and short decimals alone', async () => {
    const handler = toolHandler(async () => ({
      atmStraddleMid: 4.4399999999999995, totalValue: 815803.9400000001, cashBalance: 32164.399999999994,
      rows: [{ putCallSkew: 0.016460000000000002, delta: -0.24352300000000004 }],
      openInterest: 1000000000000001, strike: 762.63, date: '2026-09-29',
    }));
    const result: any = await handler({});
    expect(result.structuredContent).toEqual({
      atmStraddleMid: 4.44, totalValue: 815803.94, cashBalance: 32164.4,
      rows: [{ putCallSkew: 0.01646, delta: -0.243523 }],
      openInterest: 1000000000000001, strike: 762.63, date: '2026-09-29',
    });
    expect(result.content[0].text).not.toMatch(/\d\.\d{16,}|\d{17,}/);
  });

  test('a path the tool names as exact keeps the value it computed', async () => {
    const handler = toolHandler(async () => ({ strikes: { deltaBand: 0.10000000000000002, other: 0.10000000000000002 } }),
      { exactPaths: ['strikes.deltaBand'] });
    const result: any = await handler({});
    expect(result.structuredContent.strikes).toEqual({ deltaBand: 0.10000000000000002, other: 0.1 });
  });

  test('an empty account-data result is JSON in the text as well as structured', async () => {
    const handler = toolHandler(async () => ({ data: [] }), { isSyncTool: true });
    const result: any = await handler({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual(result.structuredContent);
    expect(parsed.message).toContain('No data found. Make sure MCP sync is enabled');
  });
});

describe('sanitizeMcpWireOutput drops invisible characters', () => {
  // Thirty-third run: a news summary carried U+200B and U+2060 between words.
  test('zero-width spaces, word joiners and byte-order marks go; joiners that shape text stay', () => {
    const zw = String.fromCharCode(0x200b);
    const wj = String.fromCharCode(0x2060);
    const bom = String.fromCharCode(0xfeff);
    const zwj = String.fromCharCode(0x200d);
    const out = sanitizeMcpWireOutput({
      summary: `Apple ${zw}shares rose${wj} after ${bom}the report`,
      rows: [`a${zw}b`],
      emoji: `x${zwj}y`,
    });
    expect(out).toEqual({ summary: 'Apple shares rose after the report', rows: ['ab'], emoji: `x${zwj}y` });
  });
});

describe('the infrastructure and invisible-character scrubs reach every path (review)', () => {
  test('keys naming the database product or a table are renamed, snake and camel alike', () => {
    const out = sanitizeMcpWireOutput({ supabaseProvider: 'cached', scan_tickers: 1, rows_scan_strikes: 2, SupabaseUrl: 'x' }) as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toMatch(/supabase|scan_tickers|scanTickers|scan_strikes|scanStrikes/i);
    expect(out).toEqual({ platformDatabaseProvider: 'cached', eodOptionsSummary: 1, rowsEodStrikeData: 2, PlatformDatabaseUrl: 'x' });
  });

  test('a renamed key never overwrites another', () => {
    const out = sanitizeMcpWireOutput({ eodOptionsSummary: 'kept', scan_tickers: 'renamed' }) as Record<string, unknown>;
    expect(out.eodOptionsSummary).toBe('kept');
    expect(Object.values(out)).toContain('renamed');
  });

  test('the product inside an identifier in text reads platformDatabase, and as a word the platform database', () => {
    expect(sanitizeMcpWireOutput({ note: 'via supabaseClient and Supabase' })).toEqual({ note: 'via platformDatabaseClient and the platform database' });
  });

  test('keys in error details and past the depth limit are renamed too', async () => {
    const handler = toolHandler(async () => {
      throw new LiveApiError('failed', 503, 'UPSTREAM', true, undefined, { scan_tickers: 1, supabaseRegion: 'x' });
    });
    const result: any = await handler({});
    expect(JSON.stringify(result)).not.toMatch(/supabase|scan_tickers/i);
    let deep: any = { scan_strikes: 1 };
    for (let i = 0; i < 25; i += 1) deep = { d: deep };
    expect(JSON.stringify(sanitizeMcpWireOutput(deep))).not.toMatch(/scan_strikes/);
    // Past the depth limit keys keep their form, so the label keeps the key's
    // snake form rather than the value label's hyphens.
    let leaf: any = sanitizeMcpWireOutput(deep);
    while (leaf.d) leaf = leaf.d;
    expect(leaf).toEqual({ eod_strike_data: 1 });
  });

  test('a URL encoding the product in its path is removed too', () => {
    expect(sanitizeMcpWireOutput({ image: 'https://cdn.example.com/%73upabase/logo.png' })).toEqual({});
  });

  test('a URL on the database product is removed however it is encoded', () => {
    const encoded = 'https://abc.%73upabase.co/storage/v1/logo.png';
    expect(sanitizeMcpWireOutput({ image: encoded })).toEqual({});
    expect(sanitizeMcpWireOutput({ note: `see ${encoded} now` })).toEqual({ note: 'see a removed link now' });
  });

  test('invisible characters are dropped from errors, keys and values past the depth limit', async () => {
    const zw = String.fromCharCode(0x200b);
    const wj = String.fromCharCode(0x2060);
    const handler = toolHandler(async () => {
      throw new LiveApiError(`bad${zw}symbol`, 400, 'INVALID_REQUEST', false, undefined, { detail: `a${wj}b` });
    });
    const result: any = await handler({});
    expect(JSON.stringify(result)).not.toMatch(/[​⁠]/);
    expect(sanitizeMcpWireOutput({ [`k${zw}ey`]: 1 })).toEqual({ key: 1 });
    let deep: any = { leaf: `x${wj}y` };
    for (let i = 0; i < 25; i += 1) deep = { d: deep };
    expect(JSON.stringify(sanitizeMcpWireOutput(deep))).not.toMatch(/[​⁠]/);
  });
});

describe('toolHandler publishes what JSON makes of a value (review)', () => {
  test('a Date is its ISO string and a boxed number its value, as before the rounding', async () => {
    // eslint-disable-next-line no-new-wrappers
    const handler = toolHandler(async () => ({ asOf: new Date('2026-09-30T12:00:00Z'), boxed: new Number(12.34), noisy: 4.4399999999999995 }));
    const result: any = await handler({});
    expect(result.structuredContent).toEqual({ asOf: '2026-09-30T12:00:00.000Z', boxed: 12.34, noisy: 4.44 });
  });
});

describe('the scrubs hold for case, key order, stray escapes and null results (review)', () => {
  const zw = String.fromCharCode(0x200b);

  test('table names match in any case, in keys, meta keys, text and details', async () => {
    expect(sanitizeMcpWireOutput({ SCAN_TICKERS: 1, note: 'from SCAN_STRIKES' })).toEqual({ eodOptionsSummary: 1, note: 'from eod-strike-data' });
    expect(JSON.stringify(sanitizeMcpWireOutput({ _SCAN_TICKERS_meta: { n: 1 } }))).not.toMatch(/scan_tickers|scanTickers/i);
    const handler = toolHandler(async () => { throw new LiveApiError('read SCAN_TICKERS', 503, 'UPSTREAM', true, undefined, { Scan_Strikes: 1 }); });
    expect(JSON.stringify(await handler({}))).not.toMatch(/scan_tickers|scan_strikes/i);
  });

  test('invisible characters leave a key before anything reads it', async () => {
    expect(sanitizeMcpWireOutput({ [`_s${zw}can_strikes_meta`]: 1 })).toEqual({ eodStrikeDataMeta: 1 });
    expect(sanitizeMcpWireOutput({ supabase_provider: 1 })).toEqual({ platformDatabaseProvider: 1 });
    const handler = toolHandler(async () => { throw new LiveApiError('x', 503, 'UPSTREAM', true, undefined, { [`s${zw}can_tickers`]: 1 }); });
    const result: any = await handler({});
    expect(JSON.stringify(result)).toContain('eod_options_summary');
    expect(JSON.stringify(result)).not.toMatch(/scan_tickers|eod-options-summary/);
  });

  test('an unrelated bad escape does not hide an encoded product in the path', () => {
    const url = 'https://example.com/%73upabase/%FF';
    expect(sanitizeMcpWireOutput({ url })).toEqual({});
    expect(sanitizeMcpWireOutput({ note: `see ${url} here` })).toEqual({ note: 'see a removed link here' });
  });

  test('the data-vendor URL check decodes escapes one by one too', () => {
    // The acronym from base64, so this file names no vendor; its first letter
    // percent-encoded, beside an unrelated bad escape.
    const name = Buffer.from('b3JhdHM=', 'base64').toString('utf8');
    const url = `https://example.com/%${name.charCodeAt(0).toString(16)}${name.slice(1)}/%FF`;
    expect(sanitizeMcpWireOutput({ url })).toEqual({});
  });

  test('a result that serializes to null is the ordinary no-data answer, not an error', async () => {
    const handler = toolHandler(async () => ({ toJSON: () => null }));
    const result: any = await handler({});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ dataAvailable: false, message: 'No data available for this query.' });
  });
});

describe('cleaned keys never overwrite, multi-byte escapes decode, and every rule reads cleaned keys (review)', () => {
  const zw = String.fromCharCode(0x200b);

  test('a key that lost an invisible character never overwrites another, in any branch', () => {
    const meta = sanitizeMcpWireOutput({ fooMeta: 'kept', [`_f${zw}oo_meta`]: 'renamed' }) as Record<string, unknown>;
    expect(meta.fooMeta).toBe('kept');
    expect(Object.values(meta)).toContain('renamed');
    const plain = sanitizeMcpWireOutput({ callWall: 'kept', [`call${zw}Wall`]: 'renamed' }) as Record<string, unknown>;
    expect(plain.callWall).toBe('kept');
    expect(Object.values(plain)).toContain('renamed');
  });

  test('a valid multi-byte escape decodes, beside a broken one', () => {
    const name = Buffer.from('ZmluYW5jaWFsIG1vZGVsaW5nIHByZXA=', 'base64').toString('utf8').replace(/ /g, '%C2%A0');
    expect(sanitizeMcpWireOutput({ url: `https://example.com/${name}/logo.png` })).toEqual({});
    expect(sanitizeMcpWireOutput({ note: `see https://example.com/${name}/%FF now` })).toEqual({ note: 'see a removed link now' });
    expect(sanitizeMcpWireOutput({ url: 'https://example.com/%C2%A0%73upabase%FF' })).toEqual({});
  });

  test('sync-row detection reads the cleaned keys too', () => {
    expect(sanitizeMcpWireOutput({ id: 'row-id', [`user_${zw}id`]: 'u', value: 1 })).toEqual(sanitizeMcpWireOutput({ id: 'row-id', user_id: 'u', value: 1 }));
  });
});
