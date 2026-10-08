import { describe, expect, it } from 'bun:test';
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { summarizeLiveBars } from './liveBarsShaping.js';

/**
 * A session of bars is columnar on the wire and trimmed from the START when
 * it would not fit, so the latest bars survive and the payload says what
 * went. Summary, VWAP and each indicator's latest value are never trimmed.
 */
function session(count: number, startIso = '2026-09-17T09:30:00-04:00', volume: number | null = 1000) {
  const start = Date.parse(startIso);
  const bars = Array.from({ length: count }, (_, i) => {
    const ms = start + i * 60_000;
    const wall = new Date(ms - 4 * 3_600_000).toISOString().slice(0, 19) + '-04:00';
    const close = 100 + Math.sin(i / 7) * 2;
    return { time: wall, open: close - 0.1, high: close + 0.3, low: close - 0.3, close, volume, vwap: volume === null ? null : 100.123456, vwapUpper: volume === null ? null : 100.5, vwapLower: volume === null ? null : 99.75 };
  });
  return {
    schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-09-17T15:00:00.000Z',
    date: '2026-09-17', interval: '1min', session: count > 400 ? 'extended' : 'regular',
    sessionWindow: { start: startIso, end: '2026-09-17T16:00:00-04:00' },
    barCount: count, bars,
    summary: { open: 99.9, high: 102.3, low: 97.7, close: 100.2, volume: volume === null ? null : 1000 * count, firstBarTime: bars[0]!.time, lastBarTime: bars[bars.length - 1]!.time },
    vwap: { anchor: startIso, value: volume === null ? null : 100.123456, stdev: volume === null ? null : 0.37, upper: volume === null ? null : 100.5, lower: volume === null ? null : 99.75, reason: volume === null ? 'no-volume' : null },
    indicators: [{ name: 'sma', params: { period: 20, source: 'close' }, latest: { sma: 100.1 }, series: { sma: bars.slice(19).map((b) => ({ time: b.time, value: 100.1 })) } }],
  };
}

const bytes = (value: unknown) => utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(value)));

describe('summarizeLiveBars', () => {
  it('publishes the bars as columns and rows, with every bar when they fit', () => {
    const out: any = summarizeLiveBars(session(390), { maxBars: 400, indicatorPoints: 5 });
    expect(out.bars.columns).toEqual(['time', 'open', 'high', 'low', 'close', 'volume', 'vwap']);
    expect(out.bars.rows).toHaveLength(390);
    expect(out.bars.rows[0]).toEqual(['2026-09-17T09:30:00-04:00', 99.9, 100.3, 99.7, 100, 1000, 100.123456]);
    expect(out.barsMeta).toEqual({ returned: 390, total: 390, truncated: false, firstReturnedTime: '2026-09-17T09:30:00-04:00', trimmedBy: null });
    expect(bytes(out)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(out.summary.close).toBe(100.2);
    expect(out.vwap.value).toBe(100.123456);
  });

  it('keeps the latest bars and says so when a session would not fit the budget', () => {
    const out: any = summarizeLiveBars(session(960, '2026-09-17T04:00:00-04:00'), { maxBars: 960, indicatorPoints: 5 });
    expect(out.bars.rows.length).toBeLessThan(960);
    expect(out.bars.rows.length).toBeGreaterThan(300);
    expect(out.bars.rows[out.bars.rows.length - 1]![0]).toBe('2026-09-17T19:59:00-04:00');
    expect(out.barsMeta).toMatchObject({ returned: out.bars.rows.length, total: 960, truncated: true, trimmedBy: 'budget' });
    expect(out.barsMeta.firstReturnedTime).toBe(out.bars.rows[0]![0]);
    expect(bytes(out)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });

  it('caps at maxBars from the end, and says the cap did it', () => {
    const out: any = summarizeLiveBars(session(390), { maxBars: 50, indicatorPoints: 5 });
    expect(out.bars.rows).toHaveLength(50);
    expect(out.bars.rows[49]![0]).toBe('2026-09-17T15:59:00-04:00');
    expect(out.barsMeta).toMatchObject({ returned: 50, total: 390, truncated: true, trimmedBy: 'maxBars' });
  });

  it('keeps nulls as nulls and each indicator\'s latest value with its last points', () => {
    const out: any = summarizeLiveBars(session(30, '2026-09-17T09:30:00-04:00', null), { maxBars: 400, indicatorPoints: 3 });
    expect(out.bars.rows[0]![5]).toBeNull();
    expect(out.bars.rows[0]![6]).toBeNull();
    expect(out.vwap).toEqual({ anchor: '2026-09-17T09:30:00-04:00', value: null, stdev: null, upper: null, lower: null, reason: 'no-volume' });
    expect(out.indicators).toEqual([{ name: 'sma', params: { period: 20, source: 'close' }, latest: { sma: 100.1 }, points: { sma: [
      { time: '2026-09-17T09:57:00-04:00', value: 100.1 }, { time: '2026-09-17T09:58:00-04:00', value: 100.1 }, { time: '2026-09-17T09:59:00-04:00', value: 100.1 },
    ] }, pointsKept: 3, pointsTotal: 11 }]);
  });
});
