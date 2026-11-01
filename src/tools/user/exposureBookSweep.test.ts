import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import * as twin from './exposureBookSweep.js';

/**
 * The MCP server's inline copy of the book sweep rules against
 * packages/shared/src/compute/exposureBookSweep.ts: the same verdict and the same reason for every case, and the same
 * statements. The public mirror ships the MCP server alone, without packages/shared: there this comparison has nothing
 * to read.
 */
const sharedPackage = new URL('../../../../packages/shared/', import.meta.url);
const sharedModule = new URL('src/compute/exposureBookSweep.ts', sharedPackage);

type Rules = typeof twin;

const cov = (included: number, total: number) => ({ status: included === total ? 'complete' : included === 0 ? 'unavailable' : 'partial', included, total });
const coverage = (over: Record<string, unknown> = {}) => ({ gamma: cov(2, 2), delta: cov(2, 2), vega: cov(2, 2), vanna: cov(2, 2), charm: cov(2, 2), vomma: cov(2, 2), ...over });
const strike = (k: number, over: Record<string, unknown> = {}) => ({
  strike: k, callGamma: 1, putGamma: -1, gamma: 0, callDelta: -1, putDelta: 1, delta: 0, callVega: 1, putVega: 1, vega: 2,
  callVanna: 0.1, putVanna: 0.1, vanna: 0.2, callCharm: -1, putCharm: 1, charm: 0, callVomma: 0.1, putVomma: 0.1, vomma: 0.2,
  coverage: coverage(), ...over,
});
const reported = (value: number | null, included = 2, total = 2) => ({ ...cov(included, total), value });
const book = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  exposureCalculation: 'assumedDealerBook', underlying: 'SPY', reference: { kind: 'spot', price: 500 },
  roll: { status: 'notApplicable', carry: null }, charmBasis: 'cash', multipliers: [100], scopeAsOf: 1, timestamp: 2,
  keyLevels: { callWall: 510, putWall: 490, gammaFlip: null, regime: 'unknown', gammaTilt: null },
  totals: { gex: reported(1), vegaExposure: reported(1), vanna: reported(null, 0, 2), charmFlow: reported(1), vomma: reported(1), putMinusCallDeltaBalance: reported(0, 0, 2) },
  strikeCount: 2, strikes: [strike(490), strike(510)], strikesTruncated: false, ...over,
});
const drop = (entry: Record<string, unknown>, key: string) => { const copy = { ...entry }; delete copy[key]; return copy; };
const earlier = { underlying: 'SPY', spot: 500, timestamp: 1, strikeCount: 0, aggregateByStrike: [], aggregateByStrikeTruncated: false, keyLevels: { regime: 'unknown', callWall: null, putWall: null, gammaFlip: null, gammaTilt: null } };

// every rule's pass and fail: the valid book in each projection and one mutation per check
const ENTRY_CASES: unknown[] = [
  book(), book({ strikes: [strike(490)], strikesTruncated: true }), { ...drop(book(), 'strikes'), strikesTruncated: true },
  { ...drop(book({ strikeCount: 0 }), 'strikes'), strikesTruncated: false },
  null, 7, [], earlier, book({ exposureCalculation: 'earlierDealerHedging' }), book({ spot: 1 }), book({ aggregateByStrike: [] }),
  book({ aggregateByStrikeTruncated: false }), book({ underlying: 'QQQ' }), book({ underlying: 'spy' }), book({ underlying: '' }),
  book({ reference: { kind: 'cash', price: 1 } }), book({ reference: { kind: 'spot', price: -1 } }), book({ reference: null }),
  book({ roll: { status: 'fitted', carry: null } }), book({ roll: { status: 'notApplicable', carry: 0.1 } }), book({ roll: { status: 'other', carry: null } }),
  book({ roll: { status: 'notApplicable' } }), book({ charmBasis: 'spot' }), book({ multipliers: [] }), book({ multipliers: [100, 50] }),
  book({ multipliers: [0] }), book({ scopeAsOf: Infinity }), book({ timestamp: '1' }),
  book({ keyLevels: { callWall: 1, putWall: 1, gammaFlip: 1, regime: 'flat', gammaTilt: 1 } }), book({ keyLevels: { putWall: 1, gammaFlip: 1, regime: 'unknown', gammaTilt: 1 } }),
  book({ totals: { ...(book().totals as object), gex: reported(null) } }), book({ totals: { ...(book().totals as object), gex: { status: 'partial', included: 2, total: 2, value: 1 } } }),
  book({ totals: { ...(book().totals as object), gex: { status: 'complete', included: 3, total: 2, value: 1 } } }), book({ totals: drop(book().totals as Record<string, unknown>, 'vomma') }),
  book({ strikeCount: -1 }), book({ strikesTruncated: 'no' }), book({ strikeCount: 3 }), book({ strikes: [strike(510), strike(490)] }),
  book({ strikes: [strike(490, { gamma: null }), strike(510)] }), book({ strikes: [strike(490, { vega: 1, coverage: coverage({ vega: cov(0, 2) }) }), strike(510)] }),
  book({ strikes: [strike(490, { delta: null, coverage: coverage({ delta: cov(0, 2) }) }), strike(510)] }), book({ strikes: [strike(490, { coverage: null }), strike(510)] }),
  book({ strikes: [drop(strike(490), 'callVomma'), strike(510)] }), book({ strikes: 'x' }), drop(book(), 'strikes'),
];
const SWEEP_CASES: unknown[] = [[], [earlier], [book()], [earlier, book()], [book(), book({ underlying: 'AAPL' })], 'x', [null], [drop(book(), 'strikes')]];

describe('the MCP copy of the book sweep rules', () => {
  test.skipIf(!existsSync(sharedModule))('gives the shared module\'s verdict and reason for every case, and its statements', async () => {
    const shared = await import(sharedModule.href) as Rules;
    const underlyings = new Set(['SPY', 'AAPL']);
    let compared = 0;
    for (const value of ENTRY_CASES) {
      for (const rule of ['complete', 'bounded', 'absent'] as const) {
        expect(twin.bookSweepViolation(value, underlyings, rule), JSON.stringify(value)).toBe(shared.bookSweepViolation(value, underlyings, rule));
        compared += 1;
      }
      expect(twin.isBookSweepClaim(value)).toBe(shared.isBookSweepClaim(value));
    }
    const earlierRule = (entry: unknown) => typeof entry === 'object' && entry !== null && 'spot' in entry;
    for (const sweep of SWEEP_CASES) {
      for (const stage of ['local', 'projection', 'summaryOnly'] as const) {
        expect(twin.exposureSweepViolation(sweep, underlyings, stage, earlierRule)).toBe(shared.exposureSweepViolation(sweep, underlyings, stage, earlierRule));
        compared += 1;
      }
      if (Array.isArray(sweep)) expect(twin.sweepCalculationOf(sweep)).toBe(shared.sweepCalculationOf(sweep));
      expect(twin.summaryOnlySweepPresenceOk({ exposureSweep: sweep })).toBe(shared.summaryOnlySweepPresenceOk({ exposureSweep: sweep }));
    }
    expect(twin.summaryOnlySweepPresenceOk({})).toBe(shared.summaryOnlySweepPresenceOk({}));
    // the cases reach every rule: each verdict a distinct reason or a pass
    const reasons = new Set(ENTRY_CASES.map((value) => String(shared.bookSweepViolation(value, underlyings, 'complete'))));
    expect(reasons.size).toBe(24);
    expect(compared).toBe(ENTRY_CASES.length * 3 + SWEEP_CASES.length * 3);

    expect(twin.EARLIER_SWEEP_CHARM_STATEMENT).toBe(shared.EARLIER_SWEEP_CHARM_STATEMENT);
    expect(twin.bookSweepCharmStatement('cash')).toBe(shared.bookSweepCharmStatement('cash'));
    expect(twin.bookSweepCharmStatement('fixedReference')).toBe(shared.bookSweepCharmStatement('fixedReference'));
    expect(twin.BOOK_SWEEP_REPORTED_METRICS).toEqual(shared.BOOK_SWEEP_REPORTED_METRICS);
    expect(twin.BOOK_SWEEP_COVERAGE_OF).toEqual(shared.BOOK_SWEEP_COVERAGE_OF);
    expect(twin.BOOK_SWEEP_STRIKE_FIELDS).toEqual(shared.BOOK_SWEEP_STRIKE_FIELDS);
  });

  test('the earlier statement is the one every earlier export has carried', () => {
    expect(twin.EARLIER_SWEEP_CHARM_STATEMENT).toBe('remaining-maturity sign, per calendar day (charm per year / 365), times open interest, multiplier and spot, negated for the dealer');
  });
});
