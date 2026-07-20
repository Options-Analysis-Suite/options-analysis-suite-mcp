import { describe, expect, test } from 'bun:test';
import { applyResponseSizeGuard, sanitizeMcpWireOutput, toolHandler } from './helpers.js';

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

describe('sanitizeMcpWireOutput dynamic _<key>_meta preservation', () => {
  test('preserves snake_case truncation metadata (e.g. _recent_history_meta from marketFlowShaping)', () => {
    // marketFlowShaping.ts:162 emits _recent_history_meta verbatim. The
    // earlier alphanumeric-only regex silently dropped this key, leaving
    // callers with no way to detect that recent_history was truncated.
    const sanitized = sanitizeMcpWireOutput({
      recent_history: [{ day: 1 }, { day: 2 }],
      _recent_history_meta: { showing: 2, total: 90, truncated: true },
    }) as Record<string, any>;

    expect(sanitized.recent_history).toHaveLength(2);
    expect(sanitized['recent_historyMeta']).toEqual({ showing: 2, total: 90, truncated: true });
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
