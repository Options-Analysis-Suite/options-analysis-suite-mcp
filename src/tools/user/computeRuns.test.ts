import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { register } from './computeRuns.js';
import { isCurrentComputeRunRecord } from './computeRunsShaping.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
}>;

function createHarness(
  stubResponse: any | ((params?: Record<string, string>) => any),
) {
  const calls: Array<{ path: string; params?: Record<string, string> }> = [];
  const fakeClient: ProxyClient = {
    get: async (path: string, params?: Record<string, string>) => {
      calls.push({ path, params });
      const response = typeof stubResponse === 'function' ? stubResponse(params) : stubResponse;
      return structuredClone(response);
    },
    post: async () => ({}),
  } as unknown as ProxyClient;

  const captured: { handler: ToolHandler | null; inputSchema: Record<string, z.ZodTypeAny> | null } = {
    handler: null, inputSchema: null,
  };
  const fakeServer = {
    registerTool: (_name: string, config: { inputSchema: Record<string, z.ZodTypeAny> }, handler: ToolHandler) => {
      captured.handler = handler;
      captured.inputSchema = config.inputSchema;
    },
  } as unknown as McpServer;

  register(fakeServer, fakeClient);
  if (!captured.handler || !captured.inputSchema) throw new Error('Tool handler not captured');
  return { calls, handler: captured.handler, inputSchema: captured.inputSchema };
}

const CORE_CURRENT_MODEL_IDS = [
  'BlackScholes',
  'Heston',
  'JumpDiffusion',
  'SABR',
  'VarianceGamma',
] as const;

const FULL_CURRENT_MODEL_IDS = [
  ...CORE_CURRENT_MODEL_IDS,
  'Binomial',
  'PDE',
  'MonteCarlo-GBM',
  'MonteCarlo-JumpDiffusion',
  'MonteCarlo-MeanReverting',
  'MonteCarlo-Heston',
  'FFT',
  'LocalVol-Dupire',
  'LocalVol-CEV',
] as const;

const CORE_CALIBRATION_OUTCOME_MODEL_IDS = [
  'Heston',
  'SABR',
  'JumpDiffusion',
  'VarianceGamma',
] as const;

const FULL_CALIBRATION_OUTCOME_MODEL_IDS = [
  ...CORE_CALIBRATION_OUTCOME_MODEL_IDS,
  'MonteCarlo-JumpDiffusion',
] as const;

function setCompletedCalibrationOutcomeFixture(
  run: any,
  scope: 'core' | 'full' = run.scope,
): void {
  const groups = new Map<string, { underlying: string; expiration: string }>();
  for (const position of run.positions) {
    const group = { underlying: position.underlying, expiration: position.expiration };
    groups.set(JSON.stringify([group.underlying, group.expiration]), group);
  }
  const modelIds = scope === 'core'
    ? CORE_CALIBRATION_OUTCOME_MODEL_IDS
    : FULL_CALIBRATION_OUTCOME_MODEL_IDS;
  const outcomes = [...groups.values()].flatMap(({ underlying, expiration }) => (
    modelIds.map(model => {
      const targets = model === 'Heston'
        ? ['Heston', 'MonteCarlo-Heston']
        : [model];
      const matchingPositions = run.positions.filter((position: any) => (
        position.underlying === underlying && position.expiration === expiration
      ));
      const existing = matchingPositions
        .map((position: any) => position.models[targets[0]]?.calibration)
        .find((calibration: any) => calibration != null);
      const detail = existing ?? makeSuccessfulCalibrationFixture(model, expiration);
      for (const position of matchingPositions) {
        for (const target of targets) {
          if (position.models[target]) position.models[target].calibration = detail;
        }
      }
      return {
        model,
        underlying,
        expiration,
        status: 'success',
        detail,
      };
    })
  ));
  run.data.calibrationOutcomes = outcomes;
  Object.assign(run.data.summary, {
    totalCalibrations: outcomes.length,
    calibrationOutcomeCount: outcomes.length,
    includedCalibrationOutcomeCount: outcomes.length,
    includedSuccessfulCalibrationCount: outcomes.length,
    calibrationOutcomesTruncated: false,
  });
}

function makeSuccessfulCalibrationFixture(model: string, expirationDate: string): Record<string, any> {
  const common = {
    key: `calibration-${model}`,
    rmse: 0.01,
    confidence: 80,
    isFallback: false,
    warnings: [],
    expirationDate,
    executionPath: 'worker',
    status: 'success',
    economicPenalty: 1.25,
    seedRejections: [{ reason: 'bad_seed' }],
  };
  if (model === 'Heston') {
    return {
      ...common,
      params: { v0: 0.04, kappa: 1.2, theta: 0.04, xi: 0.3, rho: -0.5 },
      confidence: 0.9,
      confidenceSemantics: {
        label: 'model-specific calibration quality score',
        method: 'heston-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      },
    };
  }
  if (model === 'SABR') {
    return {
      ...common,
      params: { alpha: 0.2, beta: 0.5, rho: -0.2, nu: 0.4 },
      confidenceSemantics: {
        label: 'model-specific calibration quality score',
        method: 'sabr-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      },
    };
  }
  if (model === 'JumpDiffusion') {
    return {
      ...common,
      params: {
        selectedModel: 'merton', baseVolatility: 0.2, lambda: 0.1, muJ: -0.05, sigmaJ: 0.2,
      },
      confidenceSemantics: {
        label: 'within-family model-selection score',
        method: 'unified-jump-selection-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      },
    };
  }
  if (model === 'VarianceGamma') {
    return {
      ...common,
      params: { sigma: 0.2, nu: 0.2, theta: -0.05 },
      confidenceSemantics: {
        label: 'model-specific calibration quality score',
        method: 'variance-gamma-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      },
    };
  }
  return {
    ...common,
    params: { baseVolatility: 0.2, lambda: 0.1, muJ: -0.05, sigmaJ: 0.2 },
    confidence: null,
  };
}

function setFailedCalibrationOutcomeFixture(run: any, model: string, reason: string): void {
  const outcome = run.data.calibrationOutcomes.find((candidate: any) => candidate.model === model);
  if (!outcome) throw new Error(`Missing ${model} calibration outcome fixture`);
  const targets = model === 'Heston' ? ['Heston', 'MonteCarlo-Heston'] : [model];
  for (const position of run.positions) {
    for (const target of targets) delete position.models[target]?.calibration;
  }
  Object.assign(outcome, {
    status: 'failed',
    reason,
    detail: {
      ...outcome.detail,
      status: 'failed',
      isFallback: true,
      failureReason: reason,
    },
  });
  Object.assign(run.data.summary, {
    completionState: 'partial',
    totalCalibrations: run.data.summary.totalCalibrations - 1,
    includedSuccessfulCalibrationCount: run.data.summary.includedSuccessfulCalibrationCount - 1,
  });
}

function testInputHash(seed = 1): string {
  return seed.toString(16).padStart(64, '0');
}

function makeUnavailableCurrentModel() {
  return {
    variantCount: 1,
    variants: [{
      dimensions: { exerciseStyle: 'european' },
      price: null,
      greeks: {},
      error: 'unavailable',
    }],
    variantsTruncated: false,
  };
}

function makeExactCurrentModels(
  scope: 'core' | 'full',
  overrides: Record<string, any> = {},
): Record<string, any> {
  const modelIds = scope === 'core' ? CORE_CURRENT_MODEL_IDS : FULL_CURRENT_MODEL_IDS;
  return Object.fromEntries(modelIds.map(model => [
    model,
    Object.prototype.hasOwnProperty.call(overrides, model)
      ? overrides[model]
      : makeUnavailableCurrentModel(),
  ]));
}

function makeRun(index = 0) {
  const modelNames = [
    'BlackScholes',
    'Binomial',
    'PDE',
    'MonteCarlo-GBM',
    'MonteCarlo-MeanReverting',
    'FFT',
    'LocalVol-Dupire',
  ] as const;
  const models = makeExactCurrentModels('full', Object.fromEntries(
    modelNames.map((modelName, modelIndex) => [
      modelName,
      {
        variantCount: 1,
        variantsTruncated: false,
        variants: [{
          price: 1 + modelIndex,
          greeks: { Delta: 0.5, Gamma: 0.01 },
          dimensions: { exerciseStyle: 'european' },
        }],
      },
    ]),
  ));
  models.Heston.calibration = makeSuccessfulCalibrationFixture('Heston', '2026-05-15');

  const run = {
    id: 100 + index,
    user_id: 1,
    created_at: '2026-04-01T00:00:00.000Z',
    key: `compute-run-${index}`,
    resultId: 900 + index,
    run_key: `run-${index}`,
    runKey: `run-${index}`,
    latestRunKey: `run-${index}`,
    scope: 'full',
    quality: 'balanced',
    status: 'completed',
    timestamp: 1774771200000 - index * 1000,
    data: {
      syncSchemaVersion: 2,
      runSchemaVersion: 2,
      key: `compute-data-${index}`,
      resultId: 900 + index,
      summary: {
        engineVersion: '2.0.6',
        inputHash: testInputHash(index + 1),
        completionState: 'complete',
        valuationTime: 1774771100000 - index * 1000,
        executionConfig: {
          calibrationPolicy: 'required',
          useDiscreteDividends: true,
          randomSeed: index,
        },
        totalPositions: 4,
        totalModelRuns: 56,
        totalCalibrations: 0,
        completedAt: 1774771500000,
        executionTimeMs: 300_000,
        errorCount: 0,
        includedErrorCount: 0,
        errorsTruncated: false,
        noticeCount: 0,
        includedNoticeCount: 0,
        noticesTruncated: false,
        modelExclusionCount: 0,
        includedModelExclusionCount: 0,
        modelExclusionsTruncated: false,
        calibrationOutcomeCount: 0,
        includedCalibrationOutcomeCount: 0,
        includedSuccessfulCalibrationCount: 0,
        calibrationOutcomesTruncated: false,
      },
      underlyings: ['SPY'],
      errors: [],
      notices: [],
      modelExclusions: [],
      calibrationOutcomes: [],
      projection: {
        schemaVersion: 2,
        compactionLevel: 'none',
        originalPositionCount: 4,
        includedPositionCount: 4,
        positionsTruncated: false,
        variantsTruncated: false,
        exposureTruncated: false,
        calibrationTruncated: false,
        earlyExercisePremiumTruncated: false,
        portfolioAggregatesTruncated: false,
      },
      portfolioAggregates: {
        byModel: {
          BlackScholes: { Price: 10, Delta: 0.5 },
          Binomial: { Price: 11, Delta: 0.6 },
        },
        dispersion: {
          Delta: {
            min: 0.4,
            max: 0.6,
            mean: 0.5,
            stddev: 0.1,
            models: ['BlackScholes', 'Binomial'],
          },
        },
        coverage: {
          BlackScholes: { Price: { included: 4, expected: 4, complete: true } },
        },
        exclusions: [],
      },
      exposureSweep: [{
        underlying: 'SPY',
        spot: 650,
        timestamp: 1774771450000,
        strikeCount: 0,
        aggregateByStrikeTruncated: false,
        keyLevels: {
          regime: 'negative-gamma',
          callWall: 650,
          putWall: null,
          gammaFlip: 645.5,
          gammaTilt: null,
        },
        aggregateByStrike: [],
      }],
    },
    positions: Array.from({ length: 4 }, (_, positionIndex) => ({
      key: `position-${index}-${positionIndex}`,
      positionId: `pos-${index}-${positionIndex}`,
      symbol: `SPY C${positionIndex}`,
      underlying: 'SPY',
      isCall: true,
      strike: 650 + positionIndex,
      expiration: '2026-05-15',
      daysToExpiry: 30,
      spot: 650,
      iv: 0.2,
      marketPrice: 10 + positionIndex,
      quantity: 1,
      multiplier: 100,
      riskFreeRate: 0.04,
      dividendYield: 0.01,
      assetClass: 'equity',
      timeToExpiryYears: 30 / 365,
      valuationTime: 1774771100000 - index * 1000,
      pricingBasis: 'spot',
      spotProvenance: { kind: 'market', source: 'quote' },
      ivProvenance: { kind: 'market', source: 'chain' },
      riskFreeRateProvenance: { kind: 'market', source: 'curve' },
      dividendProvenance: { kind: 'market', source: 'forecast' },
      models,
    })),
  };
  setCompletedCalibrationOutcomeFixture(run);
  return run;
}

function expandCurrentRunForBudget(run: any, fill: string, positionCount = 20): void {
  const template = run.positions[0];
  run.positions = Array.from({ length: positionCount }, (_, positionIndex) => {
    const expiration = `2026-${String(Math.floor(positionIndex / 28) + 1).padStart(2, '0')}-${String((positionIndex % 28) + 1).padStart(2, '0')}`;
    const position = structuredClone(template);
    Object.assign(position, {
      positionId: `budget-position-${positionIndex}`,
      symbol: `SPY BUDGET ${positionIndex}`,
      expiration,
    });
    for (const model of Object.values(position.models) as any[]) {
      if (model.calibration) model.calibration.expirationDate = expiration;
    }
    return position;
  });
  Object.assign(run.data.summary, { totalPositions: positionCount });
  Object.assign(run.data.projection, {
    originalPositionCount: positionCount,
    includedPositionCount: positionCount,
    positionsTruncated: false,
  });
  run.data.portfolioAggregates.coverage.BlackScholes.Price = {
    included: positionCount,
    expected: positionCount,
    complete: true,
  };
  setCompletedCalibrationOutcomeFixture(run);
  const warning = fill.repeat(Math.ceil(500 / fill.length)).slice(0, 500);
  for (const outcome of run.data.calibrationOutcomes) {
    outcome.detail.warnings = Array(20).fill(warning);
  }
}

function setSummaryOnlyProjectionFixture(run: any): void {
  run.positions = [];
  Object.assign(run.data.projection, {
    compactionLevel: 'summary-only',
    includedPositionCount: 0,
    positionsTruncated: true,
    variantsTruncated: true,
    calibrationTruncated: true,
    portfolioAggregatesTruncated: true,
  });
  delete run.data.exposureSweep;
  delete run.data.portfolioAggregates.coverage;
}

const CURRENT_COMPUTE_GREEK_NAMES = [
  'Delta', 'Vega', 'Theta', 'Rho', 'Gamma', 'Vanna', 'Charm', 'Vomma', 'Veta',
  'Speed', 'Ultima', 'DcharmDvol', 'Zomma', 'Color', 'Lambda', 'Epsilon', 'Phi',
  'VegaAlpha', 'Volga', 'Epsilon2', 'RhoR', 'RhoQ', 'KappaDer', 'ThetaParamDer',
  'VolOfVolDer', 'RhoDer',
] as const;

function makeCurrentExposureStrike() {
  return {
    strike: 650,
    callGamma: 1,
    putGamma: 1,
    gamma: 1,
    callDelta: 1,
    putDelta: 1,
    delta: 1,
    callVega: 1,
    putVega: 1,
    vega: 1,
    callVanna: 1,
    putVanna: 1,
    vanna: 1,
    callCharm: 1,
    putCharm: 1,
    charm: 1,
    callVomma: 1,
    putVomma: 1,
    vomma: 1,
  };
}

describe('get_compute_runs wire output', () => {
  test('accepts exact core model ids and every current canonical Greek key', () => {
    const run: any = makeRun(0);
    const blackScholes = structuredClone(run.positions[0].models.BlackScholes);
    blackScholes.variants[0].greeks = Object.fromEntries(
      CURRENT_COMPUTE_GREEK_NAMES.map(name => [name, 0.1]),
    );
    run.scope = 'core';
    run.positions = run.positions.map((position: any) => ({
      ...position,
      models: makeExactCurrentModels('core', {
        BlackScholes: structuredClone(blackScholes),
      }),
    }));
    setCompletedCalibrationOutcomeFixture(run, 'core');
    run.data.portfolioAggregates = {
      byModel: {
        BlackScholes: { Price: 10, Delta: 0.5 },
        Heston: { Price: 11, Delta: 0.6 },
      },
      dispersion: {
        Delta: {
          min: 0.5,
          max: 0.6,
          mean: 0.55,
          stddev: 0.05,
          models: ['BlackScholes', 'Heston'],
        },
      },
      coverage: {
        BlackScholes: { Price: { included: 4, expected: 4, complete: true } },
      },
      exclusions: [],
    };
    run.data.exposureSweep[0].strikeCount = 1;
    run.data.exposureSweep[0].aggregateByStrike = [makeCurrentExposureStrike()];

    expect(isCurrentComputeRunRecord(run)).toBe(true);
  });

  test('requires every exact scope model key and truthful variant truncation metadata', () => {
    const missingCoreModel: any = makeRun(0);
    missingCoreModel.scope = 'core';
    missingCoreModel.positions = missingCoreModel.positions.map((position: any) => ({
      ...position,
      models: makeExactCurrentModels('core', position.models),
    }));
    setCompletedCalibrationOutcomeFixture(missingCoreModel, 'core');
    missingCoreModel.data.portfolioAggregates = {
      byModel: {
        BlackScholes: { Price: 10, Delta: 0.5 },
        Heston: { Price: 11, Delta: 0.6 },
      },
      dispersion: {
        Delta: {
          min: 0.5,
          max: 0.6,
          mean: 0.55,
          stddev: 0.05,
          models: ['BlackScholes', 'Heston'],
        },
      },
      coverage: {
        BlackScholes: { Price: { included: 4, expected: 4, complete: true } },
      },
      exclusions: [],
    };
    expect(isCurrentComputeRunRecord(missingCoreModel)).toBe(true);
    delete missingCoreModel.positions[0].models.Heston;
    expect(isCurrentComputeRunRecord(missingCoreModel)).toBe(false);

    const missingFullModel: any = makeRun(0);
    delete missingFullModel.positions[0].models['LocalVol-CEV'];
    expect(isCurrentComputeRunRecord(missingFullModel)).toBe(false);

    for (const mutate of [
      (model: any) => { model.variantCount = Number.MAX_SAFE_INTEGER + 1; },
      (model: any) => { model.variantCount = 0; },
      (model: any) => { model.variantsTruncated = true; },
      (model: any) => { model.variantCount = 2; model.variantsTruncated = false; },
    ]) {
      const malformed: any = makeRun(0);
      mutate(malformed.positions[0].models.BlackScholes);
      expect(isCurrentComputeRunRecord(malformed)).toBe(false);
    }
  });

  test('requires projection variant truncation for retained or dropped position variants', () => {
    const retainedVariantTruncation: any = makeRun(0);
    retainedVariantTruncation.positions[0].models.BlackScholes.variantCount = 2;
    retainedVariantTruncation.positions[0].models.BlackScholes.variantsTruncated = true;
    retainedVariantTruncation.data.projection.variantsTruncated = false;
    expect(isCurrentComputeRunRecord(retainedVariantTruncation)).toBe(false);

    const positionOnlyTruncation: any = makeRun(0);
    positionOnlyTruncation.positions = positionOnlyTruncation.positions.slice(0, 3);
    Object.assign(positionOnlyTruncation.data.projection, {
      includedPositionCount: 3,
      positionsTruncated: true,
      variantsTruncated: false,
    });
    expect(isCurrentComputeRunRecord(positionOnlyTruncation)).toBe(false);
  });

  test.each([
    ['duplicate retained position ids', (run: any) => {
      run.positions[1].positionId = run.positions[0].positionId;
    }],
    ['a position valuation time outside the run snapshot', (run: any) => {
      run.positions[0].valuationTime = run.data.summary.valuationTime + 1;
    }],
    ['retained exposure truncation hidden by the projection', (run: any) => {
      Object.assign(run.data.exposureSweep[0], {
        strikeCount: 1,
        aggregateByStrike: [],
        aggregateByStrikeTruncated: true,
      });
      run.data.projection.exposureTruncated = false;
    }],
    ['summary-only aggregate omission hidden by the projection', (run: any) => {
      setSummaryOnlyProjectionFixture(run);
      run.data.projection.portfolioAggregatesTruncated = false;
    }],
  ] as const)('rejects current compute records with %s', (_case, mutate) => {
    const run: any = makeRun(0);
    mutate(run);
    expect(isCurrentComputeRunRecord(run)).toBe(false);
  });

  test('requires positive positions and nonempty underlyings for every terminal status', () => {
    for (const status of ['failed', 'cancelled']) {
      const zeroPositions: any = makeRun(0);
      zeroPositions.status = status;
      zeroPositions.positions = [];
      zeroPositions.data.summary.totalPositions = 0;
      zeroPositions.data.portfolioAggregates.coverage.BlackScholes.Price = {
        included: 0,
        expected: 0,
        complete: true,
      };
      Object.assign(zeroPositions.data.projection, {
        originalPositionCount: 0,
        includedPositionCount: 0,
        positionsTruncated: false,
      });
      expect(isCurrentComputeRunRecord(zeroPositions)).toBe(false);

      const emptyUnderlyings: any = makeRun(0);
      emptyUnderlyings.status = status;
      emptyUnderlyings.positions = [];
      emptyUnderlyings.data.underlyings = [];
      emptyUnderlyings.data.exposureSweep = [];
      Object.assign(emptyUnderlyings.data.projection, {
        includedPositionCount: 0,
        positionsTruncated: true,
      });
      expect(isCurrentComputeRunRecord(emptyUnderlyings)).toBe(false);
    }
  });

  test('requires universal aggregate exclusions and compaction-exact coverage presence', () => {
    const missingExclusions: any = makeRun(0);
    missingExclusions.status = 'cancelled';
    delete missingExclusions.data.portfolioAggregates.exclusions;
    expect(isCurrentComputeRunRecord(missingExclusions)).toBe(false);

    const missingCoverage: any = makeRun(0);
    delete missingCoverage.data.portfolioAggregates.coverage;
    expect(isCurrentComputeRunRecord(missingCoverage)).toBe(false);

    const withVestigialExcluded: any = makeRun(0);
    withVestigialExcluded.data.portfolioAggregates.excluded = { byReason: {}, models: [] };
    expect(isCurrentComputeRunRecord(withVestigialExcluded)).toBe(false);

    const summaryOnly: any = makeRun(0);
    setSummaryOnlyProjectionFixture(summaryOnly);
    expect(isCurrentComputeRunRecord(summaryOnly)).toBe(true);

    const summaryOnlyWithCoverage: any = makeRun(0);
    const coverage = summaryOnlyWithCoverage.data.portfolioAggregates.coverage;
    setSummaryOnlyProjectionFixture(summaryOnlyWithCoverage);
    summaryOnlyWithCoverage.data.portfolioAggregates.coverage = coverage;
    expect(isCurrentComputeRunRecord(summaryOnlyWithCoverage)).toBe(false);
  });

  test('enforces current position numeric domains while allowing zero rates and market price', () => {
    const zeroFinancialValues: any = makeRun(0);
    Object.assign(zeroFinancialValues.positions[0], {
      marketPrice: 0,
      riskFreeRate: 0,
      dividendYield: 0,
    });
    expect(isCurrentComputeRunRecord(zeroFinancialValues)).toBe(true);

    for (const [field, values] of [
      ['strike', [0, -1]],
      ['spot', [0, -1]],
      ['iv', [0, -0.1]],
      ['multiplier', [0, -1]],
      ['quantity', [0]],
      ['daysToExpiry', [0, -1]],
      ['timeToExpiryYears', [null, 0, -0.1]],
      ['valuationTime', [null]],
    ] as const) {
      for (const value of values) {
        const malformed: any = makeRun(0);
        malformed.positions[0][field] = value;
        expect(isCurrentComputeRunRecord(malformed), `${field}: ${String(value)}`).toBe(false);
      }
    }
  });

  test('accepts current model detail at its exact text and collection boundaries', () => {
    const run: any = makeRun(0);
    const expiration = 'E'.repeat(100);
    for (const position of run.positions) position.expiration = expiration;
    for (const outcome of run.data.calibrationOutcomes) {
      outcome.expiration = expiration;
      outcome.detail.expirationDate = expiration;
    }
    Object.assign(run.positions[0].models.Heston.calibration, {
      warnings: Array(20).fill('W'.repeat(500)),
      executionPath: 'P'.repeat(200),
    });
    setFailedCalibrationOutcomeFixture(run, 'MonteCarlo-JumpDiffusion', 'F'.repeat(2_000));
    Object.assign(run.positions[0].models.Heston.variants[0], {
      error: 'V'.repeat(2_000),
      diagnostics: { method: 'M'.repeat(200) },
    });

    expect(isCurrentComputeRunRecord(run)).toBe(true);
  });

  test('rejects producer-impossible null optionals and overlong model detail', () => {
    const mutations: Array<(run: any) => void> = [
      run => { run.positions[0].models.Heston.calibration = null; },
      run => { run.positions[0].models.BlackScholes.earlyExercisePremium = null; },
      run => { run.positions[0].models.BlackScholes.variants[0].diagnostics = null; },
      run => { run.positions[0].models.BlackScholes.variants[0].dimensions.beta = null; },
      run => {
        run.positions[0].models.BlackScholes.variants[0].greeks.Delta = { value: 0.5, stdError: null };
      },
      run => {
        run.positions[0].models.BlackScholes.variants[0].greeks.Delta = { value: 0.5, ciLow: null };
      },
      run => {
        run.positions[0].models.BlackScholes.variants[0].greeks.Delta = { value: 0.5, ciHigh: null };
      },
      run => {
        run.positions[0].models.BlackScholes.variants[0].greeks.Delta = { value: 0.5, source: null };
      },
      run => { run.positions[0].models.Heston.calibration.executionPath = null; },
      run => { run.positions[0].models.Heston.calibration.status = null; },
      run => { run.positions[0].models.Heston.calibration.failureReason = null; },
      run => { run.data.exposureSweep = null; },
      run => { delete run.data.exposureSweep; },
      run => { run.data.projection.compactionLevel = 'summary-only'; },
      run => { run.positions[0].models.BlackScholes.variants[0].error = 'E'.repeat(2_001); },
      run => {
        run.positions[0].models.BlackScholes.variants[0].diagnostics = { method: 'M'.repeat(201) };
      },
      run => { run.positions[0].models.Heston.calibration.warnings = Array(21).fill('warning'); },
      run => { run.positions[0].models.Heston.calibration.warnings = ['W'.repeat(501)]; },
      run => { run.positions[0].models.Heston.calibration.expirationDate = 'E'.repeat(101); },
      run => { run.positions[0].models.Heston.calibration.executionPath = 'P'.repeat(201); },
      run => {
        setFailedCalibrationOutcomeFixture(
          run,
          'MonteCarlo-JumpDiffusion',
          'F'.repeat(2_001),
        );
      },
      run => {
        run.positions[0].models.BlackScholes.calibration = structuredClone(
          run.positions[0].models.Heston.calibration,
        );
      },
      run => { run.positions[0].spotProvenance.family = null; },
      run => { run.positions[0].spotProvenance.assumed = null; },
      run => { run.positions[0].spotProvenance.details = null; },
    ];
    for (const mutate of mutations) {
      const malformed: any = makeRun(0);
      mutate(malformed);
      expect(isCurrentComputeRunRecord(malformed)).toBe(false);
    }
  });

  test('enforces exact optional error-field bounds in the current record validator', () => {
    const boundary: any = makeRun(0);
    boundary.data.errors = [{
      positionId: 'pos-0',
      model: 'Heston',
      error: 'failed',
      code: 'C'.repeat(200),
      expiration: 'E'.repeat(100),
    }];
    Object.assign(boundary.data.summary, {
      completionState: 'partial',
      errorCount: 1,
      includedErrorCount: 1,
    });
    expect(isCurrentComputeRunRecord(boundary)).toBe(true);

    for (const [field, value] of [
      ['error', 'E'.repeat(2_001)],
      ['code', 500],
      ['code', 'C'.repeat(201)],
      ['expiration', 500],
      ['expiration', '   '],
      ['expiration', 'E'.repeat(101)],
    ] as const) {
      const malformed: any = structuredClone(boundary);
      malformed.data.errors[0][field] = value;
      expect(isCurrentComputeRunRecord(malformed)).toBe(false);
    }
  });

  test('rejects producer-impossible PDE numeric drift and mixed compact representation', () => {
    const run: any = makeRun(0);
    run.positions[0].models.PDE = {
      variantCount: 2,
      variantsTruncated: false,
      variants: [
        {
          dimensions: { exerciseStyle: 'european' },
          price: 5,
          greeks: { Delta: 0.5 },
        },
        {
          dimensions: { exerciseStyle: 'american' },
          price: 6,
          greeks: { Delta: 0.6 },
        },
      ],
      earlyExercisePremium: {
        priceAmerican: 6,
        priceEuropean: 5,
        premium: 1 + 1e-13,
        premiumPercent: 20,
      },
    };

    expect(isCurrentComputeRunRecord(run)).toBe(false);

    const mixed: any = makeRun(0);
    const priceEuropean = 5;
    const rawPriceAmerican = 4.9995;
    mixed.positions[0].models.PDE = {
      variantCount: 2,
      variantsTruncated: false,
      variants: [
        {
          dimensions: { exerciseStyle: 'european' },
          price: priceEuropean,
          greeks: { Delta: 0.5 },
        },
        {
          dimensions: { exerciseStyle: 'american' },
          price: priceEuropean,
          greeks: { Delta: { value: 0.5 } },
        },
      ],
      earlyExercisePremium: {
        priceAmerican: priceEuropean,
        priceEuropean,
        premium: 0,
        premiumPercent: 0,
        numericalAdjustment: {
          reason: 'american_below_european_within_tolerance',
          rawPriceAmerican,
          rawDifference: rawPriceAmerican - priceEuropean,
          tolerance: Math.max(
            1e-6,
            1e-3 * Math.max(1, Math.abs(priceEuropean), Math.abs(rawPriceAmerican)),
          ),
        },
      },
    };
    expect(isCurrentComputeRunRecord(mixed)).toBe(false);
  });

  test('default view removes run identifiers and uses readable omission fields', async () => {
    const { handler } = createHarness({ data: [makeRun(0), makeRun(1)], count: 2 });
    const result = await handler({ limit: 2 });
    const parsed = JSON.parse(result.content[0].text);
    const text = result.content[0].text;

    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].positionsNotShown).toBe(2);
    expect(parsed.data[0].positions[0].models).toBeUndefined();
    expect(parsed.data[0].positions[0].modelsNotShown).toBeUndefined();
    expect(parsed.data[0].positions[0].modelSummary.modelCount).toBe(14);
    expect(parsed.data[0].positions[0].modelSummary.modelsPreview).toEqual([
      'Heston',
      'SABR',
      'Jump Diffusion',
    ]);
    expect(text).not.toContain('runKey');
    expect(text).not.toContain('latestRunKey');
    expect(text).not.toContain('run_key');
    expect(text).not.toContain('omittedModelCount');
    expect(text).not.toContain('omittedPositionCount');
    expect(text).not.toContain('positionId');
    expect(text).not.toContain('portfolioSnapshotId');
    expect(text).not.toContain('riskSnapshotId');
  });

  test('full view strips raw backend identifiers and calibration plumbing', async () => {
    const run = makeRun(0);
    setFailedCalibrationOutcomeFixture(run, 'Heston', 'insufficient_surface');
    const { handler } = createHarness({ data: [run], count: 1 });
    const result = await handler({ limit: 1, full: true });
    const parsed = JSON.parse(result.content[0].text);
    const text = result.content[0].text;

    expect(parsed.data[0].status).toBe('completed');
    expect(text).toContain('fallback (default parameters)');
    expect(text).toContain('insufficient surface');
    expect(text).toContain('statusReason');
    expect(text).not.toContain('runKey');
    expect(text).not.toContain('latestRunKey');
    expect(text).not.toContain('run_key');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('created_at');
    expect(text).not.toContain('"key"');
    expect(text).not.toContain('keyLevels');
    expect(text).not.toContain('resultId');
    expect(text).not.toContain('positionId');
    expect(text).not.toContain('executionPath');
    expect(text).not.toContain('economicPenalty');
    expect(text).not.toContain('seedRejections');
    expect(parsed.data[0].data.portfolioAggregates).toBeUndefined();
    expect(text).not.toContain('byReason');
    expect(text).not.toContain('fallbackReason');
    expect(text).not.toContain('failureReason');
  });

  test('returns synced run notices in compact and full views without private provenance', async () => {
    const run: any = makeRun(0);
    run.data.notices = [{
      code: 'DIVIDEND_ZERO_ASSUMPTION',
      level: 'warning',
      underlying: 'SPY',
      message: 'SPY dividend yield was unavailable; this run assumes zero.',
      provenance: {
        kind: 'assumption',
        source: 'unknown-dividend-zero-assumption',
        assumed: true,
      },
    }];
    Object.assign(run.data.summary, {
      noticeCount: 1,
      includedNoticeCount: 1,
      noticesTruncated: false,
    });
    run.noticesNotShown = 999;
    run.noticesMeta = { total: 999, returned: 0, omitted: 999 };
    run.data.noticesNotShown = 998;
    run.data.noticesMeta = { total: 998, returned: 0, omitted: 998 };

    const compactHarness = createHarness({ data: [run], count: 1 });
    const compact = JSON.parse((await compactHarness.handler({
      limit: 1,
      view: 'detailed',
    })).content[0].text);
    expect(compact.data[0].notices).toEqual([{
      code: 'DIVIDEND_ZERO_ASSUMPTION',
      level: 'warning',
      underlying: 'SPY',
      message: 'SPY dividend yield was unavailable; this run assumes zero.',
    }]);
    expect(compact.data[0].summary).toMatchObject({
      noticeCount: 1,
      includedNoticeCount: 1,
      noticesTruncated: false,
    });
    expect(compact.data[0].noticesNotShown).toBeUndefined();
    expect(compact.data[0].noticesMeta).toBeUndefined();

    const fullHarness = createHarness({ data: [run], count: 1 });
    const full = JSON.parse((await fullHarness.handler({ limit: 1, full: true })).content[0].text);
    expect(full.data[0].data.notices).toEqual(compact.data[0].notices);
    expect(full.data[0].noticesNotShown).toBeUndefined();
    expect(full.data[0].noticesMeta).toBeUndefined();
    expect(full.data[0].data.noticesNotShown).toBeUndefined();
    expect(full.data[0].data.noticesMeta).toBeUndefined();
    expect(JSON.stringify(full)).not.toContain('unknown-dividend-zero-assumption');
  });

  test('returns bounded canonical aggregate and model exclusions through the handler', async () => {
    const run: any = makeRun(0);
    run.data.runSchemaVersion = 2;
    run.data.portfolioAggregates.exclusions = [
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 4, expected: 4,
        complete: false, reason: 'duplicate_source',
      },
      {
        model: 'BlackScholes', metric: 'Price', included: 3, expected: 4,
        complete: false, reason: 'incomplete_position_coverage',
      },
    ];
    run.data.modelExclusions = Array.from({ length: 100 }, (_, index) => index === 0
      ? {
          model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
          reason: 'exact_chain_required', dependency: 'BlackScholes',
        }
      : {
          model: index % 2 === 0 ? 'Heston' : 'BlackScholes',
          underlying: 'SPY',
          expiration: '2026-05-15',
          reason: `reason_${index}`,
        });
    Object.assign(run.data.summary, {
      completionState: 'partial',
      modelExclusionCount: 102,
      includedModelExclusionCount: 100,
      modelExclusionsTruncated: true,
    });
    const { handler } = createHarness({ data: [run], count: 1 });

    for (const args of [{ limit: 1 }, { limit: 1, view: 'detailed' }, { limit: 1, full: true }]) {
      const result = await handler(args);
      const parsed = JSON.parse(result.content[0].text);
      const returnedRun = parsed.data[0];

      expect(returnedRun.aggregateExclusions).toEqual([{
        model: 'Black-Scholes', metric: 'Price', included: 3, expected: 4,
        reason: 'incomplete position coverage',
      }]);
      expect(returnedRun.modelExclusions).toHaveLength(20);
      expect(returnedRun.modelExclusions[0]).toEqual({
        model: 'Local Volatility - Dupire', underlying: 'SPY', expiration: '2026-05-15',
        reason: 'exact chain required', dependency: 'Black-Scholes',
      });
      expect(returnedRun.modelExclusionsNotShown).toBe(82);
      expect(result.content[0].text).not.toContain('duplicate_source');
      if (args.full) {
        expect(returnedRun.data.modelExclusions).toBeUndefined();
        expect(returnedRun.data.portfolioAggregates).toBeUndefined();
      } else {
        expect(returnedRun.dispersionExclusions).toBeUndefined();
      }
    }
  });

  test('full handler removes spoofed fields and sanitizes nested current runs without a depth cutoff', async () => {
    const run: any = makeRun(0);
    run.data.runSchemaVersion = 2;
    run.data.portfolioAggregates.exclusions = [{
      model: 'BlackScholes', metric: 'Price', included: 1, expected: 4,
      complete: false, reason: 'incomplete_position_coverage',
    }];
    run.data.modelExclusions = [{
      model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
      reason: 'exact_chain_required',
    }];
    Object.assign(run.data.summary, {
      completionState: 'partial',
      modelExclusionCount: 1,
      includedModelExclusionCount: 1,
      modelExclusionsTruncated: false,
    });
    run.aggregateExclusions = [{ model: 'ROOT SPOOF' }];
    run.aggregateExclusionsNotShown = 999;
    run.modelExclusions = [{ model: 'ROOT SPOOF' }];
    run.modelExclusionsNotShown = 999;
    let cursor = run.data;
    for (let depth = 0; depth < 30; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    cursor.nestedRun = {
      aggregateExclusions: [{ model: 'NESTED SPOOF' }],
      modelExclusions: [{ model: 'NESTED SPOOF' }],
      data: {
        syncSchemaVersion: 2,
        runSchemaVersion: 2,
        summary: {
          engineVersion: '2.0.6',
          inputHash: testInputHash(99),
          totalPositions: 2,
          modelExclusionCount: 1,
          includedModelExclusionCount: 1,
          modelExclusionsTruncated: false,
        },
        portfolioAggregates: { exclusions: [{
          model: 'Heston', metric: 'Delta', included: 1, expected: 2,
          complete: false, reason: 'invalid_value',
        }] },
        modelExclusions: [{
          model: 'LocalVol-Dupire', underlying: 'QQQ', expiration: '2026-06-19',
          reason: 'exact_chain_required',
        }],
      },
    };
    cursor.raw = {
      aggregateExclusionsNotShown: 999,
      modelExclusionsNotShown: 999,
      executionPath: 'deep-worker',
      key: 'deep-key',
    };

    const { handler } = createHarness({ data: [run], count: 1 });
    const result = await handler({ limit: 1, full: true });
    const returnedRun = JSON.parse(result.content[0].text).data[0];
    let returnedCursor = returnedRun.data;
    for (let depth = 0; depth < 30; depth += 1) returnedCursor = returnedCursor.child;

    expect(returnedRun.aggregateExclusions[0].model).toBe('Black-Scholes');
    expect(returnedRun.modelExclusions[0].model).toBe('Local Volatility - Dupire');
    expect(returnedCursor.nestedRun.aggregateExclusions[0].model).toBe('Heston');
    expect(returnedCursor.nestedRun.modelExclusions[0].model).toBe('Local Volatility - Dupire');
    expect(returnedCursor.nestedRun.data.portfolioAggregates).toBeUndefined();
    expect(returnedCursor.nestedRun.data.modelExclusions).toBeUndefined();
    expect(returnedCursor.raw.aggregateExclusionsNotShown).toBeUndefined();
    expect(returnedCursor.raw.modelExclusionsNotShown).toBeUndefined();
    expect(returnedCursor.raw.executionPath).toBeUndefined();
    expect(returnedCursor.raw.key).toBeUndefined();
    expect(result.content[0].text).not.toContain('SPOOF');
  });

  test('view=detailed on a single returned run preserves per-model details', async () => {
    const { handler } = createHarness({ data: [makeRun(0)], count: 1 });
    const result = await handler({ limit: 1, view: 'detailed' });
    const parsed = JSON.parse(result.content[0].text);
    const position = parsed.data[0].positions[0];

    expect(parsed.data).toHaveLength(1);
    expect(position.models).toBeDefined();
    expect(position.modelSummary).toBeUndefined();
    expect(position.models.Binomial.price).toBe(2);
    expect(position.models.Binomial.greeks).toEqual({ Delta: 0.5, Gamma: 0.01 });
    expect(position.models.Heston.calibrationSummary.confidence).toBe(0.9);
  });

  test('default single-run view remains compact consensus summary', async () => {
    const { handler } = createHarness({ data: [makeRun(0)], count: 1 });
    const result = await handler({ limit: 1 });
    const parsed = JSON.parse(result.content[0].text);
    const position = parsed.data[0].positions[0];

    expect(parsed.data).toHaveLength(1);
    expect(position.models).toBeUndefined();
    expect(position.modelSummary).toBeDefined();
    expect(position.modelSummary.modelCount).toBe(14);
  });

  test('view=detailed falls back to summary when more than one run is returned', async () => {
    const { handler } = createHarness({ data: [makeRun(0), makeRun(1)], count: 2 });
    const result = await handler({ limit: 5, view: 'detailed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0].positions[0].models).toBeUndefined();
    expect(parsed.data[0].positions[0].modelSummary).toBeDefined();
    expect(parsed.data[1].positions[0].models).toBeUndefined();
    expect(parsed.data[1].positions[0].modelSummary).toBeDefined();
  });

  test('humanizes model identifiers and strips calibration seeds on the wire', async () => {
    const run: any = makeRun(0);
    run.data.portfolioAggregates.dispersion.Price = {
      min: 1,
      max: 3,
      mean: 2,
      stddev: 0.5,
      models: ['BlackScholes', 'JumpDiffusion', 'VarianceGamma'],
    };
    run.positions[0].models = makeExactCurrentModels('full', {
      BlackScholes: {
        variantCount: 1,
        variantsTruncated: false,
        variants: [{ price: 1, greeks: { Delta: 0.5 }, dimensions: { exerciseStyle: 'european' } }],
      },
      JumpDiffusion: {
        variantCount: 1,
        variantsTruncated: false,
        variants: [{ price: 2, greeks: { Delta: 0.51 }, dimensions: { exerciseStyle: 'european' } }],
        calibration: {
          isFallback: false,
          params: {
            seed: 67890,
            selectedModel: 'merton',
            baseVolatility: 0.2,
            lambda: 0.1,
            muJ: -0.05,
            sigmaJ: 0.2,
          },
          rmse: null,
          confidence: null,
          warnings: [],
          expirationDate: '2026-05-15',
          status: 'success',
        },
      },
      VarianceGamma: {
        variantCount: 1,
        variantsTruncated: false,
        variants: [{ price: 3, greeks: { Delta: 0.52 }, dimensions: { exerciseStyle: 'european' } }],
        calibration: {
          isFallback: false,
          params: { seed: 24680, sigma: 0.2, nu: 0.2, theta: -0.05 },
          rmse: null,
          confidence: null,
          warnings: [],
          expirationDate: '2026-05-15',
          status: 'success',
        },
      },
    });
    setCompletedCalibrationOutcomeFixture(run);

    const { handler } = createHarness({ data: [run], count: 1 });
    const result = await handler({ limit: 1 });
    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    expect(parsed.data[0].portfolioDispersion.Price.models).toBeUndefined();
    const targetPosition = parsed.data[0].positions.find((position: any) => position.symbol === 'SPY C0');
    expect(targetPosition.models).toBeUndefined();
    expect(targetPosition.modelSummary.modelsPreview).toEqual(['Jump Diffusion', 'Variance Gamma', 'Heston']);
    expect(text).not.toContain('BlackScholes');
    expect(text).not.toContain('JumpDiffusion');
    expect(text).not.toContain('VarianceGamma');
    expect(text).not.toContain('"seed"');
  });

  test('searches the complete retained window before applying the requested limit', async () => {
    const runs = Array.from({ length: 130 }, (_, index) => makeRun(index));
    runs[120].positions = runs[120].positions.map((position) => ({
      ...position,
      symbol: 'QQQ target',
      underlying: 'QQQ',
    }));
    (runs[120].data as any).underlyings = ['QQQ'];
    (runs[120].data as any).exposureSweep[0].underlying = 'QQQ';
    setCompletedCalibrationOutcomeFixture(runs[120]);

    const { calls, handler } = createHarness((params?: Record<string, string>) => {
      const requested = Number(params?.limit ?? 0);
      const data = runs.slice(0, requested);
      return { data, count: data.length };
    });

    const result = await handler({ limit: 1, underlying: 'QQQ' });
    const parsed = JSON.parse(result.content[0].text);

    expect(calls).toHaveLength(1);
    expect(calls[0].params?.limit).toBe('200');
    expect(parsed.count).toBe(1);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].underlyings).toEqual(['QQQ']);
  });

  test('drops unsupported compute rows before nested filtering and the requested limit', async () => {
    const unsupported: any[] = [];
    const addUnsupported = (mutate: (run: any) => void) => {
      const run: any = makeRun(20 + unsupported.length);
      mutate(run);
      unsupported.push(run);
    };
    addUnsupported(run => { run.data.summary.engineVersion = '2.0.4'; });
    addUnsupported(run => { run.data.summary.engineVersion = '2.0.7'; });
    addUnsupported(run => { run.data.summary.engineVersion = '2.0.6-rc.1'; });
    addUnsupported(run => { run.data.summary.inputHash = 'abc123'; });
    addUnsupported(run => { run.data.summary.inputHash = 'A'.repeat(64); });
    addUnsupported(run => { run.scope = 'core'; });
    addUnsupported(run => { delete run.positions[0].models.Heston; });
    addUnsupported(run => {
      run.positions[0].models.CustomModel = structuredClone(run.positions[0].models.BlackScholes);
    });
    addUnsupported(run => {
      run.positions[0].models['Black-Scholes'] = run.positions[0].models.BlackScholes;
      delete run.positions[0].models.BlackScholes;
    });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variants[0].greeks.delta = 0.5;
    });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variants[0].greeks.DV01 = 0.5;
    });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variantCount = Number.MAX_SAFE_INTEGER + 1;
    });
    addUnsupported(run => { run.positions[0].models.BlackScholes.variantCount = 0; });
    addUnsupported(run => { run.positions[0].models.BlackScholes.variantsTruncated = true; });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variantCount = 2;
      run.positions[0].models.BlackScholes.variantsTruncated = false;
    });
    addUnsupported(run => { delete run.data.summary.inputHash; });
    addUnsupported(run => { delete run.data.modelExclusions; });
    addUnsupported(run => { run.data.errors = [null]; });
    addUnsupported(run => { run.status = 'running'; });
    addUnsupported(run => { run.data.exposureSweep = [null]; });
    addUnsupported(run => { run.data.exposureSweep = null; });
    addUnsupported(run => { delete run.data.exposureSweep; });
    addUnsupported(run => { run.data.projection.compactionLevel = 'summary-only'; });
    addUnsupported(run => { run.data.exposureSweep = [{}]; });
    addUnsupported(run => { delete run.data.exposureSweep[0].strikeCount; });
    addUnsupported(run => { run.data.exposureSweep[0].strikeCount = Number.MAX_SAFE_INTEGER + 1; });
    addUnsupported(run => { delete run.data.exposureSweep[0].aggregateByStrikeTruncated; });
    addUnsupported(run => { run.data.exposureSweep[0].aggregateByStrikeTruncated = true; });
    addUnsupported(run => {
      run.data.exposureSweep[0].aggregateByStrike = [{ strike: 650 }];
      run.data.exposureSweep[0].strikeCount = 0;
    });
    addUnsupported(run => {
      run.data.exposureSweep[0].aggregateByStrike = [{ strike: 650 }];
      run.data.exposureSweep[0].strikeCount = 1;
    });
    addUnsupported(run => {
      run.data.exposureSweep[0].aggregateByStrike = [{
        strike: 650,
        callGamma: 1,
        putGamma: 1,
        gamma: 1,
        callDelta: 1,
        putDelta: 1,
        delta: 1,
        callVega: 1,
        putVega: 1,
        vega: 1,
        callVanna: 1,
        putVanna: 1,
        vanna: 1,
        callCharm: 1,
        putCharm: 1,
        charm: 1,
        callVomma: 1,
        putVomma: 1,
        vomma: Number.NaN,
      }];
      run.data.exposureSweep[0].strikeCount = 1;
    });
    addUnsupported(run => {
      run.status = 'failed';
      run.data.portfolioAggregates = [];
    });
    for (const field of [
      'valuationTime',
      'executionConfig',
      'completedAt',
      'totalPositions',
      'totalModelRuns',
      'totalCalibrations',
      'executionTimeMs',
      'errorCount',
      'includedErrorCount',
      'errorsTruncated',
    ]) {
      addUnsupported(run => { delete run.data.summary[field]; });
    }
    addUnsupported(run => { run.data.summary.completionState = 'unknown'; });
    addUnsupported(run => { delete run.data.portfolioAggregates; });
    addUnsupported(run => { delete run.data.portfolioAggregates.exclusions; });
    addUnsupported(run => { delete run.data.portfolioAggregates.byModel; });
    addUnsupported(run => { delete run.data.portfolioAggregates.dispersion; });
    addUnsupported(run => { run.data.portfolioAggregates.byModel = []; });
    addUnsupported(run => { run.data.portfolioAggregates.dispersion = []; });
    addUnsupported(run => {
      run.data.portfolioAggregates.byModel = { EvilModel: { Delta: 1 } };
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.byModel.BlackScholes = { theta: 1 };
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.byModel.BlackScholes.Delta = Number.POSITIVE_INFINITY;
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.dispersion = {
        theta: { min: 0, max: 1, mean: 0.5, stddev: 0.5, models: ['BlackScholes'] },
      };
    });
    addUnsupported(run => { delete run.data.portfolioAggregates.dispersion.Delta.min; });
    addUnsupported(run => { run.data.portfolioAggregates.dispersion.Delta.mean = 2; });
    addUnsupported(run => { run.data.portfolioAggregates.dispersion.Delta.stddev = -1; });
    addUnsupported(run => { run.data.portfolioAggregates.dispersion.Delta.models = []; });
    addUnsupported(run => {
      run.data.portfolioAggregates.dispersion.Delta.models = ['BlackScholes'];
    });
    addUnsupported(run => { run.data.portfolioAggregates.dispersion.Delta.models = ['EvilModel']; });
    addUnsupported(run => {
      run.data.portfolioAggregates.dispersion.Delta.models = ['BlackScholes', 'BlackScholes'];
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.coverage = {
        EvilModel: { Price: { included: 4, expected: 4, complete: true } },
      };
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.coverage.BlackScholes = {
        theta: { included: 4, expected: 4, complete: true },
      };
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.coverage.BlackScholes.Price.included = 5;
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.coverage.BlackScholes.Price.reason = 'duplicate_source';
    });
    addUnsupported(run => {
      run.data.summary.completionState = 'partial';
      run.data.portfolioAggregates.exclusions = [{
        model: 'EvilModel', metric: 'Delta', included: 0, expected: 4,
        complete: false, reason: 'incomplete_position_coverage',
      }];
    });
    addUnsupported(run => {
      run.data.summary.completionState = 'partial';
      run.data.portfolioAggregates.exclusions = [{
        model: 'BlackScholes', metric: 'theta', included: 0, expected: 4,
        complete: false, reason: 'incomplete_position_coverage',
      }];
    });
    addUnsupported(run => {
      run.data.portfolioAggregates.excluded = { byReason: {}, models: [] };
    });
    addUnsupported(run => {
      run.positions = [];
      run.data.summary.totalPositions = 0;
      run.data.projection.originalPositionCount = 0;
      run.data.projection.includedPositionCount = 0;
    });
    addUnsupported(run => { run.data.summary.completionState = 'partial'; });
    addUnsupported(run => {
      run.data.errors = [{ positionId: 'pos', model: 'Heston', error: 'failed' }];
      run.data.summary.errorCount = 1;
      run.data.summary.includedErrorCount = 1;
    });
    addUnsupported(run => {
      run.data.errors = [{
        positionId: 'pos', model: 'Heston', error: 'failed', underlying: 'IWM',
      }];
      run.data.summary.completionState = 'partial';
      run.data.summary.errorCount = 1;
      run.data.summary.includedErrorCount = 1;
    });
    addUnsupported(run => { run.data.summary.executionConfig.randomSeed = -1; });
    addUnsupported(run => { run.data.summary.totalPositions = 5; });
    addUnsupported(run => { run.data.projection.compactionLevel = '   '; });
    addUnsupported(run => { run.data.projection.compactionLevel = 'legacy'; });
    addUnsupported(run => { run.data.projection.compactionLevel = 'x'.repeat(129); });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variantCount = 2;
      run.positions[0].models.BlackScholes.variantsTruncated = true;
      run.data.projection.variantsTruncated = false;
    });
    addUnsupported(run => { run.positions[0].models.Heston.calibration = null; });
    addUnsupported(run => { run.positions[0].models.BlackScholes.earlyExercisePremium = null; });
    addUnsupported(run => { run.positions[0].models.BlackScholes.variants[0].diagnostics = null; });
    addUnsupported(run => {
      run.positions[0].models.BlackScholes.variants[0].greeks.Delta = { value: 0.5, source: null };
    });
    addUnsupported(run => { run.positions[0].models.Heston.calibration.executionPath = null; });
    addUnsupported(run => {
      run.data.errors = [{ positionId: 'pos', model: 'Heston', error: 'E'.repeat(2_001) }];
      run.data.summary.completionState = 'partial';
      run.data.summary.errorCount = 1;
      run.data.summary.includedErrorCount = 1;
    });
    for (const field of ['positionId', 'model', 'error']) {
      addUnsupported(run => {
        const error = { positionId: 'pos', model: 'Heston', error: 'failed' };
        delete error[field as keyof typeof error];
        run.data.errors = [error];
        run.data.summary.completionState = 'partial';
        run.data.summary.errorCount = 1;
        run.data.summary.includedErrorCount = 1;
      });
    }
    for (const [field, value] of [
      ['code', 500],
      ['code', 'C'.repeat(201)],
      ['expiration', 500],
      ['expiration', '   '],
      ['expiration', 'E'.repeat(101)],
    ] as const) {
      addUnsupported(run => {
        run.data.errors = [{
          positionId: 'pos',
          model: 'Heston',
          error: 'failed',
          [field]: value,
        }];
        run.data.summary.completionState = 'partial';
        run.data.summary.errorCount = 1;
        run.data.summary.includedErrorCount = 1;
      });
    }
    addUnsupported(run => {
      run.data.errors = [{ positionId: 'pos', model: 'Heston', error: 'failed' }];
      run.data.summary.completionState = 'partial';
      run.data.summary.errorCount = 1;
    });
    addUnsupported(run => {
      run.data.summary.completionState = 'partial';
      run.data.summary.errorCount = 1;
      run.data.summary.includedErrorCount = 0;
      run.data.summary.errorsTruncated = true;
    });
    addUnsupported(run => {
      run.data.errors = Array.from({ length: 101 }, (_, index) => ({
        positionId: `pos-${index}`,
        model: 'Heston',
        error: 'failed',
      }));
      run.data.summary.completionState = 'partial';
      run.data.summary.errorCount = 101;
      run.data.summary.includedErrorCount = 101;
      run.data.summary.errorsTruncated = false;
    });
    addUnsupported(run => { delete run.positions[0].iv; });
    addUnsupported(run => { delete run.positions[0].spotProvenance; });
    addUnsupported(run => { run.positions[0].spotProvenance = { kind: 'market' }; });
    addUnsupported(run => { delete run.positions[0].models; });
    addUnsupported(run => {
      run.data.modelExclusions = [{
        model: 'M'.repeat(201),
        underlying: 'QQQ',
        expiration: '2026-05-15',
        reason: 'excluded',
      }];
      Object.assign(run.data.summary, {
        completionState: 'partial',
        modelExclusionCount: 1,
        includedModelExclusionCount: 1,
      });
    });
    addUnsupported(run => {
      run.data.modelExclusions = [{
        model: 'EvilModel',
        underlying: 'QQQ',
        expiration: '2026-05-15',
        reason: 'excluded',
      }];
      Object.assign(run.data.summary, {
        completionState: 'partial',
        modelExclusionCount: 1,
        includedModelExclusionCount: 1,
      });
    });
    addUnsupported(run => {
      run.data.modelExclusions = [{
        model: 'Heston',
        underlying: 'IWM',
        expiration: '2026-05-15',
        reason: 'excluded',
      }];
      Object.assign(run.data.summary, {
        completionState: 'partial',
        modelExclusionCount: 1,
        includedModelExclusionCount: 1,
      });
    });
    for (const field of ['model', 'underlying', 'expiration', 'reason']) {
      addUnsupported(run => {
        run.data.modelExclusions = [{
          model: 'Heston',
          underlying: 'QQQ',
          expiration: '2026-05-15',
          reason: 'excluded',
          [field]: '   ',
        }];
        Object.assign(run.data.summary, {
          completionState: 'partial',
          modelExclusionCount: 1,
          includedModelExclusionCount: 1,
        });
      });
    }
    addUnsupported(run => {
      run.data.modelExclusions = [{
        model: 'Heston',
        underlying: 'QQQ',
        expiration: '2026-05-15',
        reason: 'excluded',
        dependency: '   ',
      }];
      Object.assign(run.data.summary, {
        completionState: 'partial',
        modelExclusionCount: 1,
        includedModelExclusionCount: 1,
      });
    });
    addUnsupported(run => {
      run.data.summary.completionState = 'partial';
      run.data.summary.modelExclusionCount = 1;
      run.data.summary.includedModelExclusionCount = 0;
      run.data.summary.modelExclusionsTruncated = true;
    });
    addUnsupported(run => {
      run.positions[0].models.Heston = {
        variantCount: 1,
        variants: [{
          dimensions: { exerciseStyle: 'european' },
          price: null,
          greeks: {},
          error: 'unavailable',
        }],
        variantsTruncated: false,
        calibration: {
          params: {},
          rmse: 0.01,
          confidence: 80,
          confidenceSemantics: {
            label: 'model-specific calibration quality score',
            method: 'sabr-quality-v1',
            scale: '0-100 points',
            crossModelComparable: false,
          },
          isFallback: false,
          warnings: [],
          expirationDate: '2026-05-15',
        },
      };
    });
    addUnsupported(run => {
      run.positions[0].models.CustomModel = {
        variantCount: 0,
        variants: [],
        variantsTruncated: false,
        calibration: {
          params: {},
          rmse: 0.01,
          confidence: 80,
          confidenceSemantics: {
            label: 'model-specific calibration quality score',
            method: 'heston-quality-v1',
            scale: '0-100 points',
            crossModelComparable: false,
          },
          isFallback: false,
          warnings: [],
          expirationDate: '2026-05-15',
        },
      };
    });
    addUnsupported(run => {
      run.positions[0].models = makeExactCurrentModels('full', {
        ...run.positions[0].models,
        PDE: {
          variantCount: 2,
          variantsTruncated: false,
          variants: [
            { dimensions: { exerciseStyle: 'european' }, price: 5, greeks: { Delta: 0.5 } },
            { dimensions: { exerciseStyle: 'american' }, price: 6, greeks: { Delta: 0.6 } },
          ],
          earlyExercisePremium: {
            priceAmerican: 6,
            priceEuropean: 5,
            premium: 0.5,
            premiumPercent: 10,
          },
        },
      });
    });
    for (const run of unsupported) {
      run.data.underlyings = ['QQQ'];
      if (run.data.exposureSweep?.[0]?.underlying) {
        run.data.exposureSweep[0].underlying = 'QQQ';
      }
      if (Array.isArray(run.positions)) {
        for (const position of run.positions) {
          if (position && typeof position === 'object') position.underlying = 'QQQ';
        }
      }
    }
    addUnsupported(run => {
      run.data.underlyings = ['QQQ'];
      run.data.exposureSweep[0].underlying = 'qqq';
    });
    addUnsupported(run => {
      run.data.underlyings = ['QQQ'];
      run.data.exposureSweep[0].underlying = 'IWM';
    });
    addUnsupported(run => { run.data.underlyings = ['qqq']; });
    addUnsupported(run => { run.data.underlyings = ['SPY', 'QQQ']; });
    addUnsupported(run => { run.data.underlyings = ['QQQ', 'QQQ']; });
    addUnsupported(run => {
      run.data.underlyings = ['QQQ', 'X'.repeat(101)];
      run.data.exposureSweep[0].underlying = 'QQQ';
      for (const position of run.positions) position.underlying = 'QQQ';
    });
    addUnsupported(run => {
      run.data.underlyings = ['QQQ'];
      run.data.exposureSweep[0].underlying = 'QQQ';
      run.positions[0].underlying = 'qqq';
    });
    addUnsupported(run => {
      run.data.underlyings = ['QQQ'];
      run.data.exposureSweep[0].underlying = 'QQQ';
      run.positions[0].underlying = 'IWM';
    });

    const currentTarget: any = makeRun(120);
    currentTarget.data.underlyings = ['QQQ'];
    currentTarget.data.exposureSweep[0].underlying = 'QQQ';
    currentTarget.positions = currentTarget.positions.map((position: any) => ({
      ...position,
      symbol: position.symbol.replace('SPY', 'QQQ'),
      underlying: 'QQQ',
    }));
    setCompletedCalibrationOutcomeFixture(currentTarget);
    const { handler } = createHarness({
      data: [...unsupported, currentTarget, makeRun(121)],
      count: unsupported.length + 2,
    });

    const result = await handler({ limit: 1, underlying: 'QQQ' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(1);
    expect(parsed.matchedCount).toBe(1);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.data).toHaveLength(1);
    expect(parsed.data[0].engineVersion).toBe('2.0.6');
    expect(parsed.data[0].underlyings).toEqual(['QQQ']);
    expect(parsed.data[0].startedAt).toBe(new Date(currentTarget.timestamp).toISOString());
  });

  test('reports requested, matched, and remaining run cardinality after filtering and limiting', async () => {
    const failedRun = makeRun(3);
    failedRun.status = 'failed';
    const runs = [makeRun(0), makeRun(1), makeRun(2), failedRun];
    const { handler } = createHarness({ data: runs, count: runs.length });

    const result = await handler({ limit: 1, status: 'completed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBe(1);
    expect(parsed.requestedLimit).toBe(1);
    expect(parsed.matchedCount).toBe(3);
    expect(parsed.hasMore).toBe(true);
  });

  test('preserves selection metadata when filters match no retained runs', async () => {
    const failedRun = makeRun(0);
    failedRun.status = 'failed';
    const { handler } = createHarness({ data: [failedRun], count: 1 });

    const result = await handler({ limit: 1, status: 'completed' });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed).toMatchObject({
      dataAvailable: false,
      data: [],
      count: 0,
      requestedLimit: 1,
      matchedCount: 0,
      hasMore: false,
    });
    expect(parsed.message).toBe('No data matched the requested filters.');
    expect(result.structuredContent).toEqual(parsed);
  });

  test('shows sync-enable guidance for an empty account when no filters are supplied', async () => {
    const { handler } = createHarness({ data: [], count: 0 });

    const result = await handler({ limit: 5 });

    expect((result.structuredContent as Record<string, unknown>).dataAvailable).toBe(false);
    expect(result.content[0].text).toContain('MCP sync is enabled');
    // No filter supplied, so the response must not claim "No data matched the requested filters".
    expect(result.content[0].text).not.toContain('No data matched the requested filters');
  });

  test('forwards since unchanged to the proxy and treats a since-only query as a filter (no match, not no sync)', async () => {
    // `since` is applied server-side (never re-checked by recordMatchesComputeFilters), so it must be
    // both forwarded to the proxy AND counted as a supplied filter. Otherwise an account with runs but
    // none after `since` gets the misleading "enable MCP sync" guidance instead of "no data matched".
    const { calls, handler } = createHarness({ data: [], count: 0 });

    const since = '2099-01-01T12:34:56.789-07:00';
    const result = await handler({ limit: 5, since });

    // Forwarded to the proxy (dropping the request param would leave this green with an empty stub,
    // so assert it explicitly).
    expect(calls[0].params?.since).toBe(since);
    expect(result.content[0].text).toContain('No data matched the requested filters');
    expect(result.content[0].text).not.toContain('MCP sync is enabled');
  });

  test('validates since as a strict ISO calendar date or RFC3339 instant at the schema boundary', async () => {
    // The handler harness bypasses Zod, so validate against the REGISTERED schema directly - otherwise
    // removing the refine would go undetected. Date.parse-permissive and non-existent dates must reject.
    const { inputSchema } = createHarness({ data: [], count: 0 });
    const schema = z.object(inputSchema);

    const bad = [
      // Calendar overflow, including Gregorian century leap-year rules.
      '2026-02-30',
      '2026-02-29',
      '1900-02-29',
      '2100-02-29',
      '2026-04-31',
      '2026-00-01',
      '2026-13-01',
      '2026-01-00',
      '2026-01-32',
      '2026-02-30T12:34:56Z',
      // Complete instants require valid time fields and an explicit RFC3339 offset.
      '2026-01-01T24:00:00Z',
      '2026-01-01T23:60:00Z',
      '2026-01-01T23:59:60Z',
      '2026-01-01T23:59:59+24:00',
      '2026-01-01T23:59:59+00:60',
      '2026-01-01T23:59:59',
      '2026-01-01T23:59Z',
      '2026-01-01 23:59:59Z',
      '2026-01-01T23:59:59+0000',
      // Locale, loose-width, whitespace, and Unicode lookalikes are not normalized.
      '01/02/2026',
      'March 1, 2026',
      '0',
      'nonsense',
      '2026-1-1',
      ' 2026-01-01',
      '2026-01-01 ',
      '2026-01-01\n',
      '２０２６-01-01',
      '2026‐01‐01',
      '',
    ];
    const good = [
      '2026-02-28',
      '2026-01-01',
      '2024-02-29',
      '2000-02-29',
      '2400-02-29',
      '2026-07-18T12:34:56Z',
      '2026-07-18T12:34:56.789Z',
      '2026-07-18t12:34:56z',
      '2026-07-18T05:34:56-07:00',
      '2026-07-18T19:34:56+07:00',
      '2024-02-29T23:59:59.123456+14:00',
    ];

    for (const value of bad) {
      expect(schema.safeParse({ since: value }).success).toBe(false);
    }
    for (const value of good) {
      expect(schema.safeParse({ since: value }).success).toBe(true);
    }
  });

  test('keeps full-view count exact when the response budget trims runs', async () => {
    const runs = Array.from({ length: 10 }, (_, index) => {
      const run = makeRun(index);
      (run.data as Record<string, unknown>).publicNote = `${index}:${'x'.repeat(8_000)}`;
      return run;
    });
    const { handler } = createHarness({ data: runs, count: runs.length });

    const result = await handler({ limit: 10, full: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.data.length).toBeLessThan(10);
    expect(parsed.count).toBe(parsed.data.length);
    expect(parsed.truncationMeta).toEqual(expect.objectContaining({
      returned: parsed.data.length,
      requested: 10,
      reason: 'size budget',
    }));
    expect(parsed.requestedLimit).toBe(10);
    expect(parsed.matchedCount).toBe(10);
    expect(parsed.hasMore).toBe(true);
  });

  test('keeps one pathological run useful and bounded in summary and full modes', async () => {
    const run = makeRun(0);
    expandCurrentRunForBudget(run, '漢');
    run.positions = [];
    const projection = {
      schemaVersion: 2,
      compactionLevel: 'summary-only',
      originalPositionCount: 20,
      includedPositionCount: 0,
      positionsTruncated: true,
      variantsTruncated: true,
      exposureTruncated: false,
      calibrationTruncated: true,
      earlyExercisePremiumTruncated: false,
      portfolioAggregatesTruncated: true,
    };
    (run.data as Record<string, any>).projection = projection;
    delete (run.data as Record<string, any>).exposureSweep;
    (run.data as Record<string, any>).portfolioAggregates = {
      byModel: {},
      dispersion: {},
      exclusions: [],
    };
    const { handler } = createHarness({ data: [run], count: 1 });

    for (const full of [false, true]) {
      const result = await handler({ limit: 1, full });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.responseBudget).toBeUndefined();
      expect(parsed.data).toHaveLength(1);
      expect(parsed.data[0].status).toBe('completed');
      expect(parsed.requestedLimit).toBe(1);
      expect(parsed.matchedCount).toBe(1);
      expect(parsed.hasMore).toBe(false);
      expect(parsed.data[0].projection).toEqual(projection);
      expect(parsed.truncationMeta).toEqual(expect.objectContaining({
        returned: 1,
        requested: 1,
        reason: 'size budget',
        singleRunCompacted: true,
      }));
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(50 * 1024);
    }
  });

  test('does not claim positions are included when the current single-run floor strips them', async () => {
    const run = makeRun(0);
    expandCurrentRunForBudget(run, '漢');
    // A pristine write-time projection that says nothing was truncated. The emergency floor strips
    // all positions, so the wire must not echo this stale "everything included" claim.
    (run.data as Record<string, any>).projection = {
      schemaVersion: 2,
      compactionLevel: 'none',
      originalPositionCount: 20,
      includedPositionCount: 20,
      positionsTruncated: false,
      variantsTruncated: false,
      exposureTruncated: false,
      calibrationTruncated: false,
      earlyExercisePremiumTruncated: false,
      portfolioAggregatesTruncated: false,
    };
    const { handler } = createHarness({ data: [run], count: 1 });

    for (const full of [false, true]) {
      const result = await handler({ limit: 1, full });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.truncationMeta.singleRunCompacted).toBe(true);
      expect('positions' in parsed.data[0]).toBe(false);
      expect(parsed.data[0].projection.positionsTruncated).toBe(true);
      expect(parsed.data[0].projection.variantsTruncated).toBe(true);
      expect(parsed.data[0].projection.includedPositionCount).toBe(0);
      // The true original count is preserved (not fabricated to 0).
      expect(parsed.data[0].projection.originalPositionCount).toBe(20);
    }
  });

  test('accepts only exact current compaction levels', () => {
    for (const compactionLevel of [
      'none',
      'variants',
      'variants+exposure',
      'models-core',
      'positions',
      'summary-only',
    ]) {
      const run = makeRun(0);
      if (compactionLevel === 'summary-only') {
        setSummaryOnlyProjectionFixture(run);
      } else {
        (run.data as Record<string, any>).projection.compactionLevel = compactionLevel;
      }
      expect(isCurrentComputeRunRecord(run), compactionLevel).toBe(true);
    }

    for (const compactionLevel of ['legacy', 'x'.repeat(128)]) {
      const run = makeRun(0);
      (run.data as Record<string, any>).projection.compactionLevel = compactionLevel;
      expect(isCurrentComputeRunRecord(run), compactionLevel).toBe(false);
    }
  });

  test('compacts multibyte single-run fields before the shared wire guard', async () => {
    const run = makeRun(0);
    expandCurrentRunForBudget(run, '漢');
    const { handler } = createHarness({ data: [run], count: 1 });

    for (const full of [false, true]) {
      const result = await handler({ limit: 1, full });
      const parsed = JSON.parse(result.content[0].text);

      expect(parsed.responseBudget).toBeUndefined();
      expect(parsed.data[0].status).toBe('completed');
      expect(parsed.truncationMeta.singleRunCompacted).toBe(true);
      expect(new TextEncoder().encode(result.content[0].text).byteLength).toBeLessThanOrEqual(50 * 1024);
    }
  });

  test('bounds individual run-error fields so one error cannot collapse the response', async () => {
    const run = makeRun(0);
    (run.data as any).errors = [{
      positionId: 'pos-0-0',
      model: `PDE-${'m'.repeat(2_000)}`,
      error: 'x'.repeat(2_000),
      code: `E-${'c'.repeat(198)}`,
      underlying: 'SPY',
      expiration: `2026-05-15-${'e'.repeat(89)}`,
    }];
    Object.assign((run.data as any).summary, {
      completionState: 'partial',
      errorCount: 1,
      includedErrorCount: 1,
      errorsTruncated: false,
    });
    const { handler } = createHarness({ data: [run], count: 1 });

    const result = await handler({ limit: 1 });
    const parsed = JSON.parse(result.content[0].text);
    const error = parsed.data[0].errors[0];

    expect(parsed.responseBudget).toBeUndefined();
    expect(error.message.length).toBeLessThanOrEqual(1_000);
    expect(error.model.length).toBeLessThanOrEqual(128);
    expect(error.code.length).toBeLessThanOrEqual(128);
    expect(error.underlying.length).toBeLessThanOrEqual(64);
    expect(error.expiration.length).toBeLessThanOrEqual(64);
    expect(error.truncatedFields).toEqual(['model', 'message', 'code', 'expiration']);
    expect(parsed.data[0].errorsMeta).toEqual({
      total: 1,
      returned: 1,
      omitted: 0,
      entriesWithTruncatedFields: 1,
    });
  });
});
