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
      callWall: 510, x: 1, reason: 'below_average', source: 'scan_tickers',
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
    expect(text).toContain('Retrying will not succeed.');
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
    expect(text).toContain('Retrying will not succeed.');
    expect(text).toContain('https://x.test/fix');
    expect((result.structuredContent as any)?.retryable).toBe(false);
    // The code rides in the prefix, ahead of everything truncation can take.
    expect(text.startsWith('API error (BROKER_CREDENTIAL_INVALID): ')).toBe(true);
    // A truncated message ends in the suffix; no full stop is bolted onto it.
    expect(text).toContain('... [truncated] Retrying will not succeed.');
  });

  test('the text names the code and separates the message from the guidance', async () => {
    // A text-only client saw "not listed for SPY Retrying will not succeed."
    // and never the code that was in structuredContent. The code goes in the
    // prefix; a full stop is added only where the message brought none.
    const bare = await toolHandler(async () => {
      throw new LiveApiError('Expiration 2020-01-17 is not listed for SPY', 400, 'UNKNOWN_EXPIRATION', false, undefined, {});
    })({});
    expect(bare.content[0].text).toBe('API error (UNKNOWN_EXPIRATION): Expiration 2020-01-17 is not listed for SPY. Retrying will not succeed.');
    const punctuated = await toolHandler(async () => {
      throw new LiveApiError('Broker refused the credential.', 403, 'BROKER_CREDENTIAL_INVALID', false, undefined, {});
    })({});
    expect(punctuated.content[0].text).toBe('API error (BROKER_CREDENTIAL_INVALID): Broker refused the credential. Retrying will not succeed.');
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
