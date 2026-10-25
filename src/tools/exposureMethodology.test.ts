import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
  COVERAGE_METRICS,
  bookOfWire,
  charmBasisOf,
  coverageStatusOf,
  mcpExposuresV2,
  methodologyInput,
  methodologyLabel,
  readStoredBlock,
  resolveMethodology,
  type CoverageMetric,
  type WireBases,
} from './exposureMethodology.js';

const KEYS = ['gex', 'dex', 'vega', 'vanna', 'charmFixedRef', 'rollBasis', 'charm', 'vomma'] as const;

function wire(call: Partial<Record<(typeof KEYS)[number], number | null>>, put: Partial<Record<(typeof KEYS)[number], number | null>>, coverage: Partial<Record<CoverageMetric, [number, number]>> = {}, dexBalance: number | null = 0): WireBases {
  const full = (side: typeof call) => Object.fromEntries(KEYS.map((key) => [key, side[key] ?? null]));
  return {
    call: full(call),
    put: full(put),
    coverage: Object.fromEntries(COVERAGE_METRICS.map((metric) => {
      const [included, total] = coverage[metric] ?? [4, 4];
      return [metric, { included, total }];
    })) as WireBases['coverage'],
    dexBalance,
  };
}

describe('resolveMethodology and the label', () => {
  test('a named methodology never reads the default', async () => {
    const client = { get: async () => { throw new Error('the default was read'); } };
    expect(await resolveMethodology(client, 1)).toEqual({ methodology: 1, source: 'requested', stale: false });
    expect(await resolveMethodology(client, 2)).toEqual({ methodology: 2, source: 'requested', stale: false });
  });

  test('an omitted one is the default, stale when the read was; unknown is null', async () => {
    expect(await resolveMethodology({ get: async () => ({ defaultMethodology: 2, stale: true }) }, undefined))
      .toEqual({ methodology: 2, source: 'default', stale: true });
    expect(await resolveMethodology({ get: async () => { throw new Error('HTTP 503'); } }, undefined)).toBeNull();
  });

  test('the label carries methodologyStale only when stale', () => {
    expect(methodologyLabel({ methodology: 1, source: 'default', stale: false })).toEqual({ methodology: 1, methodologySource: 'default' });
    expect(methodologyLabel({ methodology: 2, source: 'default', stale: true })).toEqual({ methodology: 2, methodologySource: 'default', methodologyStale: true });
  });

  test('the input takes 1 or 2 only', () => {
    const input = methodologyInput();
    expect(input.safeParse(1).success).toBe(true);
    expect(input.safeParse(2).success).toBe(true);
    expect(input.safeParse(undefined).success).toBe(true);
    for (const bad of [0, 3, '2', 1.5, null]) expect(input.safeParse(bad).success).toBe(false);
  });
});

describe('the book() twin: expected values (these run in the public mirror too)', () => {
  test('complete metrics: the assumed book is call minus put, Long OI the sum, charm the negative drift', () => {
    const b = bookOfWire(wire(
      { gex: 10, vega: 7, vanna: 5, charm: 3, vomma: 2 },
      { gex: 4, vega: 1, vanna: -2, charm: -6, vomma: 9 },
      {}, -123.5,
    ));
    expect(b.assumedDealerBook).toEqual({ gex: 6, vegaExposure: 6, vanna: 7, charmFlow: -9, vomma: -7 });
    expect(b.longOi).toEqual({ gex: 14, vegaExposure: 8, vanna: 3, charmFlow: 3, vomma: 11 });
    expect(b.putMinusCallDeltaBalance).toBe(-123.5);
  });

  test('both charm signs: a put drift above the call\'s is buying, below it selling', () => {
    expect(bookOfWire(wire({ charm: -0.472766 }, { charm: 0.336865 })).assumedDealerBook.charmFlow).toBeCloseTo(0.809631, 12);
    expect(bookOfWire(wire({ charm: 14.240471 }, { charm: -12.752557 })).assumedDealerBook.charmFlow).toBeCloseTo(-26.993028, 12);
  });

  test('known-empty 0 of 0 is a complete 0, never unavailable', () => {
    const b = bookOfWire(wire({}, {}, { gamma: [0, 0] }));
    expect(b.coverage.gamma.status).toBe('complete');
    expect(b.assumedDealerBook.gex).toBe(0);
    expect(b.longOi.gex).toBe(0);
  });

  test('an unavailable metric is null in both views; a partial one sums the legs included, a null side as 0', () => {
    const b = bookOfWire(wire({ vega: 5, vanna: null }, { vega: null, vanna: 8 }, { vega: [0, 3], vanna: [2, 3] }));
    expect(b.assumedDealerBook.vegaExposure).toBeNull();
    expect(b.longOi.vegaExposure).toBeNull();
    expect(b.coverage.vega).toEqual({ included: 0, total: 3, status: 'unavailable' });
    expect(b.assumedDealerBook.vanna).toBe(-8);
    expect(b.longOi.vanna).toBe(8);
    expect(b.coverage.vanna).toEqual({ included: 2, total: 3, status: 'partial' });
  });

  test('a side missing a key counts it 0, as book() reads it (?? 0), never NaN', () => {
    const w = wire({ gex: 5 }, { gex: 2 }, { gamma: [1, 2] });
    delete w.put.gex;
    expect(bookOfWire(w).assumedDealerBook.gex).toBe(5);
    expect(bookOfWire(w).longOi.gex).toBe(5);
  });

  test('the delta balance passes through exactly, whatever the delta coverage says', () => {
    expect(bookOfWire(wire({}, {}, {}, 24197532839.69932)).putMinusCallDeltaBalance).toBe(24197532839.69932);
    expect(bookOfWire(wire({}, {}, { delta: [0, 5] }, null)).putMinusCallDeltaBalance).toBeNull();
  });

  test('coverage status: every leg complete, none unavailable, some partial', () => {
    expect(coverageStatusOf({ included: 3, total: 3 })).toBe('complete');
    expect(coverageStatusOf({ included: 0, total: 0 })).toBe('complete');
    expect(coverageStatusOf({ included: 0, total: 2 })).toBe('unavailable');
    expect(coverageStatusOf({ included: 1, total: 2 })).toBe('partial');
  });
});

// The public mirror ships the MCP server alone, without packages/shared: there this comparison has nothing to read.
const sharedPackage = new URL('../../../packages/shared/', import.meta.url);
const sharedBook = new URL('src/exposure/book.ts', sharedPackage);

describe('the book() twin against packages/shared/src/exposure/book.ts', () => {
  test.skipIf(!existsSync(sharedBook))('equals the shared book() at p = 1 in both views over a seeded sweep', async () => {
    // typed here, not imported: the mirror type-checks this file without packages/shared
    type Reported = { value: number | null; status: string };
    const { book } = await import(sharedBook.href) as {
      book: (bases: unknown, view: 'assumedDealerBook' | 'longOi', p: number) => Record<'gex' | 'vegaExposure' | 'vanna' | 'charmFlow' | 'vomma' | 'putMinusCallDeltaBalance', Reported>;
    };
    // mulberry32: an integer generator, so the cases cannot cycle the way a float LCG can (counted below)
    let seed = 0x5eed1;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const value = (): number | null => {
      const r = next();
      if (r < 0.1) return null;
      if (r < 0.15) return 0;
      return (next() - 0.5) * 10 ** Math.floor(next() * 12);
    };
    const seen = new Set<string>();
    const CASES = 2_000;
    for (let i = 0; i < CASES; i++) {
      const sides = { call: Object.fromEntries(KEYS.map((key) => [key, value()])), put: Object.fromEntries(KEYS.map((key) => [key, value()])) };
      const coverage = Object.fromEntries(COVERAGE_METRICS.map((metric) => {
        const total = Math.floor(next() * 4);
        const r = next();
        const included = r < 0.6 ? total : r < 0.8 ? 0 : Math.floor(next() * (total + 1));
        return [metric, { included, total }];
      })) as WireBases['coverage'];
      const dexBalance = value();
      const w: WireBases = { ...sides, coverage, dexBalance };
      seen.add(JSON.stringify(w));
      const twin = bookOfWire(w);
      const bases = { methodology: 2, ...sides, coverage, dexBalance, roll: { status: 'notApplicable', carry: null } } as any;
      for (const [view, ours] of [['assumedDealerBook', twin.assumedDealerBook], ['longOi', twin.longOi]] as const) {
        const theirs = book(bases, view, 1);
        expect({ gex: theirs.gex.value, vegaExposure: theirs.vegaExposure.value, vanna: theirs.vanna.value, charmFlow: theirs.charmFlow.value, vomma: theirs.vomma.value }).toEqual(ours);
        expect(theirs.putMinusCallDeltaBalance.value).toBe(twin.putMinusCallDeltaBalance);
        expect([theirs.gex.status, theirs.putMinusCallDeltaBalance.status, theirs.vegaExposure.status, theirs.vanna.status, theirs.charmFlow.status, theirs.vomma.status])
          .toEqual(['gamma', 'delta', 'vega', 'vanna', 'charm', 'vomma'].map((m) => twin.coverage[m as CoverageMetric].status));
      }
    }
    expect(seen.size).toBe(CASES);
  });
});

describe('the MCP shape of a methodology-2 exposure', () => {
  const b = bookOfWire(wire({ gex: 3, vega: 2 }, { gex: 1, vega: 1 }, { vega: [1, 2], vomma: [0, 2] }));

  test('coverage lists only what is not complete, under the name of the number it governs', () => {
    const out = mcpExposuresV2(b, { referenceKind: 'spot', rollStatus: 'notApplicable', carry: null }, 'every expiration after the session');
    expect(out.coverage).toEqual({ vegaExposure: { status: 'partial', included: 1, total: 2 }, vomma: { status: 'unavailable', included: 0, total: 2 } });
    expect(out).toMatchObject({ scope: 'every expiration after the session', gex: 2, vegaExposure: 1, vomma: null, referenceKind: 'spot', charmBasis: 'cash' });
    expect(out).not.toHaveProperty('roll');
    expect(out).not.toHaveProperty('carry');
  });

  test('off a spot reference the roll is stated, and the carry only when fitted', () => {
    expect(mcpExposuresV2(b, { referenceKind: 'forward', rollStatus: 'fitted', carry: 0.0412 })).toMatchObject({ charmBasis: 'cash', roll: 'fitted', carry: 0.0412 });
    const unfitted = mcpExposuresV2(b, { referenceKind: 'forward', rollStatus: 'insufficientData', carry: null });
    expect(unfitted).toMatchObject({ charmBasis: 'fixed reference', roll: 'insufficient data' });
    expect(unfitted).not.toHaveProperty('carry');
    expect(mcpExposuresV2(b, { referenceKind: 'future', rollStatus: 'notApplicable', carry: null })).toMatchObject({ charmBasis: 'fixed reference', roll: 'not applicable' });
  });

  test('charmBasisOf matches the screener\'s rule', () => {
    expect(charmBasisOf('spot', 'notApplicable')).toBe('cash');
    expect(charmBasisOf('forward', 'fitted')).toBe('cash');
    expect(charmBasisOf('forward', 'rejectedFit')).toBe('fixed reference');
    expect(charmBasisOf('future', 'notApplicable')).toBe('fixed reference');
  });
});

// SPY's daily block of 2026-10-23 as regime_daily stores it (read-only, 10-24), bases left out
const SPY_DAILY_BLOCK = {
  asOf: '2026-10-23', carry: null, scope: { expirations: 'all' },
  units: { gex: 'USD of delta per 1% move', vanna: 'USD of delta per vol point', vomma: 'USD per (vol point)^2', charmFlow: 'USD per calendar day', vegaExposure: 'USD per vol point', putMinusCallDeltaBalance: 'USD, underlying-equivalent' },
  longOi: { gex: 39578835690.025, vanna: 55865540.668741226, vomma: 41869924.254895926, charmFlow: -708314645.3629999, vegaExposure: 993900840.5978477 },
  source: 'scan_strikes', carryFit: null,
  coverage: Object.fromEntries(['vega', 'charm', 'delta', 'gamma', 'vanna', 'vomma'].map((m) => [m, { total: 9393, status: 'complete', included: 9393 }])),
  rollModel: 'log-forward-theil-sen-v1', rollStatus: 'notApplicable', expiryScope: 'eod-session-1', methodology: 2, referenceKind: 'spot', charmTimeBasis: 'calendar-day',
  assumedDealerBook: { gex: -13845258254.490454, vanna: 5991747552.922032, vomma: 6920285.69417274, charmFlow: 2146427916.062272, vegaExposure: -176041469.23922223 },
  putMinusCallDeltaBalance: 24197532839.69932,
};

describe('readStoredBlock', () => {
  test('reads a stored daily block exactly', () => {
    const read = readStoredBlock(SPY_DAILY_BLOCK);
    expect(read).not.toBeNull();
    expect(read!.book.assumedDealerBook).toEqual(SPY_DAILY_BLOCK.assumedDealerBook);
    expect(read!.book.longOi).toEqual(SPY_DAILY_BLOCK.longOi);
    expect(read!.book.putMinusCallDeltaBalance).toBe(24197532839.69932);
    expect(read!.book.coverage.gamma).toEqual({ included: 9393, total: 9393, status: 'complete' });
    expect(read!.reference).toEqual({ referenceKind: 'spot', rollStatus: 'notApplicable', carry: null });
    expect(read!.source).toBe('scan_strikes');
    expect(read!.expiryScope).toBe('eod-session-1');
  });

  test('a block without an expiry rule reads with expiryScope null', () => {
    const { expiryScope: _dropped, ...legacy } = SPY_DAILY_BLOCK;
    expect(readStoredBlock(legacy)!.expiryScope).toBeNull();
  });

  test('anything that does not read as a methodology-2 block is null', () => {
    const variants: Array<(b: any) => void> = [
      (b) => { b.methodology = 1; },
      (b) => { delete b.coverage.vomma; },
      (b) => { b.coverage.gamma = { included: 5, total: 4 }; },
      (b) => { b.coverage.gamma = { included: -1, total: 4 }; },
      (b) => { b.coverage.gamma = { included: 1.5, total: 4 }; },
      (b) => { b.assumedDealerBook.gex = Number.NaN; },
      (b) => { b.longOi.vanna = '1'; },
      (b) => { delete b.assumedDealerBook.vomma; },
      (b) => { b.putMinusCallDeltaBalance = Infinity; },
      (b) => { b.rollStatus = 'guessed'; },
      (b) => { b.referenceKind = 'cash'; },
      (b) => { b.carry = Number.NaN; },
    ];
    for (const change of variants) {
      const block = structuredClone(SPY_DAILY_BLOCK) as any;
      change(block);
      expect(readStoredBlock(block)).toBeNull();
    }
    for (const notABlock of [null, undefined, 1, 'x', [], {}]) expect(readStoredBlock(notABlock)).toBeNull();
  });
});
