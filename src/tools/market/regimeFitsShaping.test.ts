import { describe, expect, it } from 'bun:test';
import { summarizeRegimeFits } from './regimeFitsShaping.js';
import { sanitizeMcpWireOutput, toolHandler } from '../helpers.js';

/**
 * The invariant is that the sanitizer must not change our output AT ALL.
 *
 * Two weaker versions of this check shipped first and both accepted real data
 * loss. Comparing key SETS missed a key stripped in one place but emitted in
 * another. Comparing PATHS then missed a changed VALUE - a mutation rewriting
 * historyRequested from 60 to 0 passed every test - and collapsed array
 * positions, so a strip on element 1 hid behind element 0.
 *
 * Deep equality has neither hole and is simpler than either. The lesson is that
 * the guard should assert the actual invariant rather than a proxy for it.
 */
function expectSanitizerLeavesIntact(shaped: unknown): void {
  // Cloned FIRST. Comparing the sanitizer's output against the same object it
  // was handed passes trivially if the sanitizer edits in place: a mutation
  // that rewrote a value in both the input and the output went unnoticed. The
  // expected value has to be captured before the call, not derived from it.
  const expected = structuredClone(shaped);
  expect(sanitizeMcpWireOutput(shaped as Record<string, unknown>)).toEqual(expected as Record<string, unknown>);
}

const fit = (over: Record<string, unknown> = {}) => ({
  market_date: '2026-09-09',
  model_name: 'heston',
  model_version: 'v1.0',
  params: { kappa: 1.5, theta: 0.04, xi: 0.6, rho: -0.7 },
  fit_error: { iv_rmse: 0.012, price_rmse: 0.31, n_options: 220, is_fallback: false },
  diagnostics: { convergence: 'ok', iterations: 41, runtime_ms: 1830 },
  ...over,
});

describe('summarizeRegimeFits', () => {
  it('reports the LATEST parameters, whatever order the rows arrive in', () => {
    // The endpoint orders by date DESC today. Relying on that makes the shaper
    // wrong the moment the query changes, and "the parameters" silently becomes
    // an older calibration - not a worse answer, a wrong one.
    const shaped = summarizeRegimeFits({
      symbol: 'SPY',
      data: [
        fit({ market_date: '2026-09-01', params: { kappa: 9.9 } }),
        fit({ market_date: '2026-09-09', params: { kappa: 1.5 } }),
        fit({ market_date: '2026-09-04', params: { kappa: 5.5 } }),
      ],
    });

    expect(shaped.models).toHaveLength(1);
    expect(shaped.models[0].asOf).toBe('2026-09-09');
    expect(shaped.models[0].params).toEqual({ kappa: 1.5 });
    expect(shaped.asOf).toBe('2026-09-09');
    expect(shaped.windowStart).toBe('2026-09-01');
  });

  it('keeps two versions of one model apart', () => {
    // The table is unique on (market_date, symbol, model_name, model_version),
    // so two versions are two calibrations. Collapsing them would present one
    // version's parameters under the other's fit error.
    const shaped = summarizeRegimeFits({
      symbol: 'SPY',
      data: [
        fit({ model_version: 'v1.0', params: { kappa: 1 } }),
        fit({ model_version: 'v2.0', params: { kappa: 2 } }),
      ],
    });

    expect(shaped.models).toHaveLength(2);
    expect(shaped.models.map((m) => m.version)).toEqual(['v1.0', 'v2.0']);
    expect(shaped.models.map((m) => (m.params as any).kappa)).toEqual([1, 2]);
  });

  it('carries the quality flag beside the parameters and through the history', () => {
    // A rejected fit was not accepted, whether or not its parameters were
    // substituted. A caller must never receive those parameters without the
    // flag that says the fit failed.
    const shaped = summarizeRegimeFits({
      symbol: 'SPY',
      data: [
        fit({ market_date: '2026-09-09', fit_error: { iv_rmse: 0.9, is_fallback: true } }),
        fit({ market_date: '2026-09-08', fit_error: { iv_rmse: 0.01, is_fallback: false } }),
        fit({ market_date: '2026-09-07', fit_error: { iv_rmse: 0.8, is_fallback: true } }),
      ],
    });

    expect(shaped.models[0].fit.failedQualityCheck).toBe(true);
    expect(shaped.models[0].daysFailingQualityCheck).toBe(2);
    expect(shaped.models[0].history.map((h) => h.failedQualityCheck)).toEqual([true, false, true]);
  });

  it('does not invent a fit error that was not reported', () => {
    const shaped = summarizeRegimeFits({ symbol: 'SPY', data: [fit({ fit_error: null })] });
    expect(shaped.models[0].fit).toEqual({
      ivRmse: null, priceRmse: null, nOptions: null, failedQualityCheck: null,
    });
  });

  it('drops diagnostics, which describe our calibration run and not the market', () => {
    const shaped = summarizeRegimeFits({ symbol: 'SPY', data: [fit()] });
    const json = JSON.stringify(shaped);
    expect(json).not.toContain('runtime_ms');
    expect(json).not.toContain('iterations');
    expect(json).not.toContain('convergence');
  });

  it('stays inside the response budget at the 365-day maximum', () => {
    const models = ['blackScholes', 'heston', 'sabr', 'vg', 'merton', 'kou', 'bates', 'essvi'];
    const data = [];
    for (let day = 0; day < 365; day += 1) {
      const date = new Date(Date.UTC(2025, 8, 10) - day * 86_400_000).toISOString().slice(0, 10);
      for (const model of models) data.push(fit({ market_date: date, model_name: model }));
    }
    expect(data).toHaveLength(2_920);

    const shaped = summarizeRegimeFits({ symbol: 'SPY', data });
    expect(shaped.models).toHaveLength(8);
    expect(shaped.coverage.rows).toBe(2_920);
    expect(shaped.coverage.dates).toBe(365);
    // Every model reports its full window even though only 10 days are listed.
    expect(shaped.models[0].fitDays).toBe(365);
    expect(shaped.models[0].history).toHaveLength(10);
    expect(new TextEncoder().encode(JSON.stringify(shaped)).byteLength).toBeLessThan(50 * 1024);
  });

  it('gets the quality flag past the shared wire sanitizer', () => {
    // The sanitizer strips a fixed set of internal key names GLOBALLY, and
    // `isFallback` is on it. A shaper cannot know that by reading its own file:
    // the field vanished on the wire while the parameters stayed, so a model
    // received parameters from a rejected fit with nothing marking them.
    const shaped = summarizeRegimeFits({
      symbol: 'SPY',
      data: [fit({ fit_error: { iv_rmse: 0.9, is_fallback: true } })],
    });

    return toolHandler(async () => shaped)({}).then((result: any) => {
      const wire = JSON.parse(result.content[0].text);
      expect(wire.models[0].fit.failedQualityCheck).toBe(true);
      expect(wire.models[0].history[0].failedQualityCheck).toBe(true);
      expect(result.structuredContent.models[0].fit.failedQualityCheck).toBe(true);
    });
  });

  it('shortens histories rather than dropping models when the budget binds', async () => {
    // Eight models at two versions with a 60-day history overran the response
    // budget, and the GENERIC guard then dropped whole model entries - losing
    // Heston, Kou, Merton, SABR and VG outright while coverage still claimed
    // sixteen. Losing a model is worse than losing its history, so the history
    // is what gives way, and the count reported is the count returned.
    const models = ['blackScholes', 'heston', 'sabr', 'vg', 'merton', 'kou', 'bates', 'essvi'];
    const data = [];
    for (let day = 0; day < 60; day += 1) {
      const date = new Date(Date.UTC(2025, 8, 10) - day * 86_400_000).toISOString().slice(0, 10);
      for (const model of models) {
        for (const version of ['v1.0', 'v2.0']) {
          data.push(fit({ market_date: date, model_name: model, model_version: version }));
        }
      }
    }

    const shaped = summarizeRegimeFits({ symbol: 'SPY', data }, { historyLimit: 60 });
    expect(shaped.models).toHaveLength(16);
    expect(shaped.coverage.modelsReturned).toBe(16);

    const result: any = await toolHandler(async () => shaped)({});
    const wire = JSON.parse(result.content[0].text);
    // Every model survives the trip, which is the whole point.
    expect(wire.models).toHaveLength(16);
    for (const model of models) {
      expect(wire.models.map((m: any) => m.model), model).toContain(model);
    }
    // And each still carries its latest parameters and quality flag.
    expect(wire.models[0].params).toBeTruthy();
    expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThan(50 * 1024);
  });

  it('never drops a whole model family to make room for an older version', () => {
    // The cap sliced an alphabetically sorted list, so four versions of eight
    // models pushed SABR and VG off the end entirely - while the payload was
    // 20KB, nowhere near any budget. A missing model reads as "we do not fit
    // this model for this symbol", which is a different and false claim.
    const models = ['bates', 'blackScholes', 'essvi', 'heston', 'kou', 'merton', 'sabr', 'vg'];
    const data = [];
    for (const model of models) {
      for (const version of ['v1.0', 'v2.0', 'v3.0', 'v4.0']) {
        data.push(fit({ model_name: model, model_version: version }));
      }
    }

    const shaped = summarizeRegimeFits({ symbol: 'SPY', data });
    for (const model of models) {
      expect(shaped.models.map((m) => m.model), model).toContain(model);
    }
    // And the entry kept for each family is its NEWEST version, not whichever
    // one sorted first.
    const sabr = shaped.models.filter((m) => m.model === 'sabr');
    expect(sabr[0].version).toBe('v4.0');
  });

  it('orders versions numerically, so v1.11 outranks v1.9', () => {
    // A lexical compare puts v1.9 first. That is not cosmetic: the family
    // representative is chosen by this ordering, so crossing a ten silently
    // demoted the newest calibration in favour of an older one.
    const data = [];
    for (const model of ['bates', 'blackScholes', 'essvi', 'heston', 'kou', 'merton', 'sabr', 'vg']) {
      for (const version of ['v1.2', 'v1.9', 'v1.11', 'v1.10']) {
        data.push(fit({ model_name: model, model_version: version }));
      }
    }
    const shaped = summarizeRegimeFits({ symbol: 'SPY', data });
    for (const model of ['sabr', 'vg']) {
      const kept = shaped.models.filter((m) => m.model === model);
      expect(kept.length, model).toBeGreaterThan(0);
      expect(kept[0].version, model).toBe('v1.11');
    }
  });

  it('reports the history limit as a limit, not as what was returned', () => {
    // historyPerModel said 60 when a single fit existed, which reads as sixty
    // days of history the caller never received.
    const shaped = summarizeRegimeFits({ symbol: 'SPY', data: [fit()] }, { historyLimit: 60 });
    expect(shaped.models[0].history).toHaveLength(1);
    expect(shaped.coverage).not.toHaveProperty('historyPerModel');
    expect(shaped.coverage.historyLimitPerModel).toBe(60);
    expect(shaped.coverage.historyReturnedMax).toBe(1);
  });

  it('survives an empty or malformed response without throwing', () => {
    for (const response of [
      {}, { data: null }, { data: [] }, { data: [null, 'nope', 42] },
      { symbol: 'SPY', data: [{}] },
      { data: [fit({ market_date: null, model_name: null })] },
    ]) {
      expect(() => summarizeRegimeFits(response as any)).not.toThrow();
    }
    // A row with no date still surfaces rather than vanishing.
    const shaped = summarizeRegimeFits({ data: [fit({ market_date: null })] } as any);
    expect(shaped.models).toHaveLength(1);
    expect(shaped.asOf).toBeNull();
  });
});

describe('regime fit output survives the shared wire sanitizer', () => {
  // Pins the CLASS, not the one name: any key this shaper emits that collides
  // with the sanitizer's global strip or rename lists disappears on the way
  // out, and the shaper's own tests would never notice.
  it('keeps every key it emits', () => {
    const shaped = summarizeRegimeFits({
      symbol: 'SPY',
      data: [fit({ fit_error: { iv_rmse: 0.9, price_rmse: 1, n_options: 3, is_fallback: true } })],
    }, { historyLimit: 2 });

    expectSanitizerLeavesIntact(shaped);
  });

  it('keeps the keys it emits only SOMETIMES', () => {
    // A field emitted conditionally never appears in a happy-path fixture, so
    // the guard never sees it and a rename of it passes silently. Force the
    // branch: many model/version groups reduce the history limit, which is the
    // only thing that emits historyRequested.
    const data = [];
    for (const model of ['heston', 'sabr', 'vg', 'kou', 'bates', 'merton', 'essvi', 'blackScholes']) {
      for (const version of ['v1.0', 'v2.0', 'v3.0']) {
        data.push(fit({ model_name: model, model_version: version }));
      }
    }
    const shaped = summarizeRegimeFits({ symbol: 'SPY', data }, { historyLimit: 60 });

    expect(shaped.coverage, 'the conditional branch must actually be taken')
      .toHaveProperty('historyRequested');
    expectSanitizerLeavesIntact(shaped);
  });
});
