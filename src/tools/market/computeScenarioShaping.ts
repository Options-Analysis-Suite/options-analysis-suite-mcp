/**
 * The scenario route's answer, rounded for the model: P&L cells are money
 * (two decimals), everything else four. The per-leg base price (the entry
 * premium already carries it when the source is 'model') and the
 * position-value grid (the P&L grid is the same information against the
 * entry) are dropped unless `full` asks for the route's exact answer.
 */
const PNL_DECIMALS = 2;
const DECIMALS = 4;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Every finite number in the structure rounded; nulls, strings and booleans untouched. */
function roundDeep(value: unknown, decimals: number): unknown {
  if (typeof value === 'number') return Number.isFinite(value) ? roundTo(value, decimals) : value;
  if (Array.isArray(value)) return value.map((entry) => roundDeep(entry, decimals));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, roundDeep(entry, decimals)]));
  }
  return value;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

function stripLegs(legs: unknown): unknown {
  if (!Array.isArray(legs)) return legs;
  return legs.map((leg) => {
    const record = asRecord(leg);
    if (!record) return leg;
    const { basePrice: _dropped, ...rest } = record;
    return rest;
  });
}

export function summarizeScenario(payload: unknown, options: { full: boolean }): unknown {
  if (options.full) return payload;
  const res = asRecord(payload);
  if (!res) return payload;

  const grid = asRecord(res.grid);
  const shapedGrid = grid
    ? (() => {
        const { positionValue: _dropped, pnl, ...rest } = grid;
        return { ...roundDeep(rest, DECIMALS) as Record<string, unknown>, pnl: roundDeep(pnl, PNL_DECIMALS) };
      })()
    : undefined;

  const fit = asRecord(res.portfolioFit);
  const shapedFit = fit
    ? (() => {
        const { stress, positions, ...rest } = fit;
        const stressRecord = asRecord(stress);
        return {
          ...roundDeep(rest, DECIMALS) as Record<string, unknown>,
          ...(Array.isArray(positions)
            ? { positions: positions.map((position) => {
                const record = asRecord(position);
                if (!record) return position;
                return roundDeep({ ...record, legs: stripLegs(record.legs) }, DECIMALS);
              }) }
            : {}),
          ...(stressRecord
            ? { stress: {
                ...roundDeep({ axes: stressRecord.axes }, DECIMALS) as Record<string, unknown>,
                heldPnl: roundDeep(stressRecord.heldPnl, PNL_DECIMALS),
                combinedPnl: roundDeep(stressRecord.combinedPnl, PNL_DECIMALS),
              } }
            : {}),
        };
      })()
    : undefined;

  const base = asRecord(res.base);
  const { grid: _g, portfolioFit: _p, legs, base: _b, ...rest } = res;
  return {
    ...roundDeep(rest, DECIMALS) as Record<string, unknown>,
    ...(legs !== undefined ? { legs: roundDeep(stripLegs(legs), DECIMALS) } : {}),
    ...(base
      ? { base: {
          ...roundDeep(base, DECIMALS) as Record<string, unknown>,
          ...(typeof base.positionValue === 'number' ? { positionValue: roundTo(base.positionValue, PNL_DECIMALS) } : {}),
          ...(typeof base.entryValue === 'number' ? { entryValue: roundTo(base.entryValue, PNL_DECIMALS) } : {}),
        } }
      : {}),
    ...(shapedGrid ? { grid: shapedGrid } : {}),
    ...(shapedFit ? { portfolioFit: shapedFit } : {}),
  };
}
