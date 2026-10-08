import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, utf8ByteLength } from '../helpers.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';

/**
 * Shape one session of intraday bars for a model.
 *
 * SHAPING IS MANDATORY HERE. 390 one-minute bars as objects with 25-character
 * times are 35 to 40 KB before the VWAP columns; an extended session is 960
 * rows and cannot fit the 50 KB ceiling at all. The generic size guard would
 * keep the FIRST rows of the array, which for a session means the open and
 * nothing recent. So the bars go out COLUMNAR (one list of column names, one
 * list per bar) and are trimmed from the START, so the latest bars survive,
 * and `barsMeta` says what went and why. The summary, the VWAP line and
 * each indicator's latest value are never trimmed.
 */

export const BAR_COLUMNS = ['time', 'open', 'high', 'low', 'close', 'volume', 'vwap'] as const;

interface RawBar {
  time?: unknown; open?: unknown; high?: unknown; low?: unknown; close?: unknown; volume?: unknown; vwap?: unknown;
}

interface RawIndicator {
  name?: unknown;
  params?: unknown;
  latest?: unknown;
  series?: Record<string, Array<{ time: unknown; value: number }>>;
}

export interface LiveBarsShapeOptions {
  /** Bars to keep at most, newest last. */
  maxBars?: number;
  /** Points to keep per indicator plot, newest last. */
  indicatorPoints?: number;
}

const DEFAULT_MAX_BARS = 120;
const DEFAULT_INDICATOR_POINTS = 10;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function row(bar: RawBar): [string | null, number | null, number | null, number | null, number | null, number | null, number | null] {
  return [str(bar.time), num(bar.open), num(bar.high), num(bar.low), num(bar.close), num(bar.volume), num(bar.vwap)];
}

function shapeIndicators(payload: unknown, keep: number) {
  if (!Array.isArray(payload)) return [];
  return payload
    .filter((entry): entry is RawIndicator => entry != null && typeof entry === 'object')
    .map((entry) => {
      const series = entry.series != null && typeof entry.series === 'object' ? entry.series : {};
      const latest: Record<string, number | null> = {};
      const points: Record<string, Array<{ time: unknown; value: number }>> = {};
      let kept = 0;
      let total = 0;
      for (const [key, list] of Object.entries(series)) {
        const finite = (Array.isArray(list) ? list : []).filter((pt) => pt != null && typeof pt === 'object' && Number.isFinite((pt as { value: number }).value));
        const last = finite[finite.length - 1];
        latest[key] = last ? last.value : null;
        points[key] = keep > 0 ? finite.slice(-keep) : [];
        kept = Math.max(kept, points[key].length);
        total = Math.max(total, finite.length);
      }
      // The proxy's own `latest` wins where it reported one: the series it
      // sent is the whole session, so the two agree, but the report is
      // what it saw before any trimming here.
      const reported = entry.latest != null && typeof entry.latest === 'object' ? entry.latest as Record<string, unknown> : null;
      if (reported) {
        for (const [key, value] of Object.entries(reported)) latest[key] = num(value);
      }
      return { name: entry.name ?? null, params: entry.params ?? {}, latest, points, pointsKept: kept, pointsTotal: total };
    });
}

export function summarizeLiveBars(response: Record<string, unknown>, options: LiveBarsShapeOptions = {}) {
  const maxBars = Math.max(1, Math.floor(options.maxBars ?? DEFAULT_MAX_BARS));
  const allBars = Array.isArray(response.bars) ? (response.bars as RawBar[]) : [];
  const total = allBars.length;
  const capped = allBars.slice(-maxBars);
  let trimmedBy: null | 'maxBars' | 'budget' = capped.length < total ? 'maxBars' : null;

  const shape = (bars: RawBar[]) => ({
    symbol: str(response.symbol),
    dataSource: str(response.dataSource),
    provider: str(response.provider),
    asOf: str(response.asOf),
    date: str(response.date),
    interval: str(response.interval),
    session: str(response.session),
    sessionWindow: response.sessionWindow ?? null,
    bars: { columns: [...BAR_COLUMNS], rows: bars.map(row) },
    barsMeta: {
      returned: bars.length,
      total,
      truncated: bars.length < total,
      firstReturnedTime: bars.length > 0 ? str(bars[0]!.time) : null,
      trimmedBy: bars.length < total ? (bars.length < capped.length ? 'budget' : trimmedBy) : null,
    },
    summary: response.summary ?? null,
    vwap: response.vwap ?? null,
    indicators: shapeIndicators(response.indicators, options.indicatorPoints ?? DEFAULT_INDICATOR_POINTS),
  });

  const fits = (payload: unknown) =>
    utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(payload))) <= MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES;
  let kept = capped;
  let payload = shape(kept);
  // Drop the oldest bars, a tenth at a time then one by one, until it fits.
  while (kept.length > 0 && !fits(payload)) {
    const drop = kept.length > 20 ? Math.ceil(kept.length / 10) : 1;
    kept = kept.slice(drop);
    trimmedBy = 'budget';
    payload = shape(kept);
  }
  return payload;
}
