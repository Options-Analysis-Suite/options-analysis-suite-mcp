import { describe, expect, test } from 'bun:test';
import { isCurrentComputeRunRecord, recordMatchesComputeFilters, sanitizeComputeRunsWireOutput, shapeComputeRunRecord, summarizeComputeRunsResponse, trimFullComputeRunsResponse } from './computeRunsShaping.js';

const CORE_CURRENT_MODEL_IDS = [
  'BlackScholes',
  'Heston',
  'JumpDiffusion',
  'SABR',
  'VarianceGamma',
] as const;

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

function makeCurrentTerminalRecord() {
  const record: any = makeRecord();
  record.scope = 'core';
  record.data.projection.exposureTruncated = true;
  Object.assign(record.data.summary, {
    completionState: 'partial',
    valuationTime: 1774771100000,
    executionConfig: {
      calibrationPolicy: 'required',
      useDiscreteDividends: true,
      randomSeed: 7,
    },
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
  });
  record.data.errors = [];
  record.data.notices = [];
  record.data.modelExclusions = [];
  record.data.calibrationOutcomes = [];
  record.data.portfolioAggregates = {
    byModel: {},
    dispersion: {},
    coverage: {},
    exclusions: [],
  };
  record.positions = record.positions.map((position: Record<string, unknown>) => ({
    ...position,
    assetClass: 'equity',
    timeToExpiryYears: 3 / 365,
    valuationTime: 1774771100000,
    pricingBasis: 'spot',
    spotProvenance: { kind: 'market', source: 'quote' },
    ivProvenance: { kind: 'market', source: 'chain' },
    riskFreeRateProvenance: { kind: 'market', source: 'curve' },
    dividendProvenance: { kind: 'market', source: 'forecast' },
    models: Object.fromEntries(CORE_CURRENT_MODEL_IDS.map(model => [
      model,
      makeUnavailableCurrentModel(),
    ])),
  }));
  setCalibrationOutcomes(record, requiredCoreCalibrationOutcomes(record));
  return record;
}

function setCalibrationOutcomes(record: any, outcomes: any[]): void {
  const successful = outcomes.filter(outcome => outcome.status === 'success').length;
  record.data.calibrationOutcomes = outcomes;
  for (const position of record.positions) {
    for (const model of ['Heston', 'SABR', 'JumpDiffusion', 'VarianceGamma', 'MonteCarlo-JumpDiffusion']) {
      if (position.models?.[model]) delete position.models[model].calibration;
    }
    if (position.models?.['MonteCarlo-Heston']) delete position.models['MonteCarlo-Heston'].calibration;
    for (const outcome of outcomes) {
      if (outcome.status !== 'success'
        || outcome.detail == null
        || outcome.underlying !== position.underlying
        || outcome.expiration !== position.expiration) continue;
      if (position.models?.[outcome.model]) {
        position.models[outcome.model].calibration = structuredClone(outcome.detail);
      }
      if (outcome.model === 'Heston' && position.models?.['MonteCarlo-Heston']) {
        position.models['MonteCarlo-Heston'].calibration = structuredClone(outcome.detail);
      }
    }
  }
  Object.assign(record.data.summary, {
    completionState: outcomes.some(outcome => outcome.status !== 'success') ? 'partial' : 'complete',
    totalCalibrations: successful,
    calibrationOutcomeCount: outcomes.length,
    includedCalibrationOutcomeCount: outcomes.length,
    includedSuccessfulCalibrationCount: successful,
    calibrationOutcomesTruncated: false,
  });
}

function requiredCoreCalibrationOutcomes(record: any): any[] {
  const groups = new Map<string, { underlying: string; expiration: string }>();
  for (const position of record.positions) {
    const group = { underlying: position.underlying, expiration: position.expiration };
    groups.set(JSON.stringify([group.underlying, group.expiration]), group);
  }
  return [...groups.values()].flatMap(({ underlying, expiration }) => (
    ['Heston', 'SABR', 'JumpDiffusion', 'VarianceGamma'].map(model => ({
      model,
      underlying,
      expiration,
      status: 'unavailable',
      reason: 'No calibratable observations in test fixture',
    }))
  ));
}

function makeTwoExpiryCoreRecordWithTruncatedOutcomes(): any {
  const record = makeCurrentTerminalRecord();
  Object.assign(record.positions[1], {
    symbol: 'SPY260430P00500000',
    underlying: 'SPY',
    expiration: '2026-04-30',
  });
  record.data.underlyings = ['SPY'];
  record.data.calibrationOutcomes = [requiredCoreCalibrationOutcomes(record)[0]];
  Object.assign(record.data.summary, {
    totalCalibrations: 0,
    calibrationOutcomeCount: 8,
    includedCalibrationOutcomeCount: 1,
    includedSuccessfulCalibrationCount: 0,
    calibrationOutcomesTruncated: true,
  });
  return record;
}

function makeTwoExpiryCoreRecord(): any {
  const record = makeCurrentTerminalRecord();
  Object.assign(record.positions[1], {
    symbol: 'SPY260430P00500000',
    underlying: 'SPY',
    expiration: '2026-04-30',
  });
  record.data.underlyings = ['SPY'];
  setCalibrationOutcomes(record, requiredCoreCalibrationOutcomes(record));
  return record;
}

function makeSummaryOnlyRecord(record: any): any {
  record.positions = [];
  Object.assign(record.data.projection, {
    compactionLevel: 'summary-only',
    includedPositionCount: 0,
    positionsTruncated: true,
    variantsTruncated: true,
    calibrationTruncated: true,
    portfolioAggregatesTruncated: true,
  });
  delete record.data.exposureSweep;
  delete record.data.portfolioAggregates.coverage;
  return record;
}

describe('isCurrentComputeRunRecord terminal semantics', () => {
  test('requires and returns truthful bounded notice evidence', () => {
    const record: any = makeCurrentTerminalRecord();
    record.data.notices = [
      {
        code: 'DIVIDEND_ZERO_ASSUMPTION',
        level: 'warning',
        underlying: 'SPY',
        message: 'SPY dividend yield was unavailable; this run assumes zero.',
        provenance: {
          kind: 'assumption',
          source: 'unknown-dividend-zero-assumption',
          assumed: true,
        },
      },
      {
        code: 'EXPOSURE_SWEEP_FAILED',
        level: 'warning',
        underlying: 'SPY',
        message: 'Exposure sweep failed for SPY: quote service unavailable',
      },
    ];
    Object.assign(record.data.summary, {
      noticeCount: 3,
      includedNoticeCount: 2,
      noticesTruncated: true,
    });

    expect(isCurrentComputeRunRecord(record)).toBe(true);
    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.notices).toEqual([
      {
        code: 'DIVIDEND_ZERO_ASSUMPTION',
        level: 'warning',
        underlying: 'SPY',
        message: 'SPY dividend yield was unavailable; this run assumes zero.',
      },
      {
        code: 'EXPOSURE_SWEEP_FAILED',
        level: 'warning',
        underlying: 'SPY',
        message: 'Exposure sweep failed for SPY: quote service unavailable',
      },
    ]);
    expect(shaped.noticesNotShown).toBe(1);
    expect(shaped.summary).toMatchObject({
      noticeCount: 3,
      includedNoticeCount: 2,
      noticesTruncated: true,
    });

    const missing = makeCurrentTerminalRecord();
    delete missing.data.notices;
    expect(isCurrentComputeRunRecord(missing)).toBe(false);

    const nullProvenance: any = makeCurrentTerminalRecord();
    nullProvenance.data.notices = [{
      code: 'DIVIDEND_ZERO_ASSUMPTION',
      level: 'warning',
      underlying: 'SPY',
      message: 'SPY dividend yield was unavailable; this run assumes zero.',
      provenance: null,
    }];
    Object.assign(nullProvenance.data.summary, {
      noticeCount: 1,
      includedNoticeCount: 1,
      noticesTruncated: false,
    });
    expect(isCurrentComputeRunRecord(nullProvenance)).toBe(false);
  });

  test('keeps distinct actionable notice codes ahead of duplicate assumptions', () => {
    const record: any = makeCurrentTerminalRecord();
    record.data.notices = [
      ...Array.from({ length: 6 }, (_, index) => ({
        code: 'DIVIDEND_ZERO_ASSUMPTION',
        level: 'warning',
        underlying: 'SPY',
        message: `Dividend assumption ${index}`,
      })),
      {
        code: 'EXPOSURE_SWEEP_FAILED',
        level: 'warning',
        underlying: 'SPY',
        message: 'Exposure sweep failed for SPY.',
      },
    ];
    Object.assign(record.data.summary, {
      noticeCount: 7,
      includedNoticeCount: 7,
      noticesTruncated: false,
    });

    expect(isCurrentComputeRunRecord(record)).toBe(true);
    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.notices).toHaveLength(5);
    expect(shaped.notices.map((notice: { code: string }) => notice.code)).toContain(
      'EXPOSURE_SWEEP_FAILED',
    );
    expect(shaped.noticesNotShown).toBe(2);
  });

  test('rejects a current Kou calibration below the canonical etaUp domain', () => {
    const makeKouRecord = (etaUp: number) => {
      const record = makeCurrentTerminalRecord();
      const detailFor = (expiration: string) => ({
        params: {
          selectedModel: 'kou',
          baseVolatility: 0.2,
          lambda: 0.2,
          pUp: 0.4,
          etaUp,
          etaDown: 8,
        },
        rmse: null,
        confidence: null,
        isFallback: false,
        warnings: [],
        expirationDate: expiration,
        status: 'success',
      });
      const outcomes = requiredCoreCalibrationOutcomes(record).map(outcome => (
        outcome.model === 'JumpDiffusion'
          ? {
              model: outcome.model,
              underlying: outcome.underlying,
              expiration: outcome.expiration,
              status: 'success',
              detail: detailFor(outcome.expiration),
            }
          : outcome
      ));
      setCalibrationOutcomes(record, outcomes);
      return record;
    };

    expect(isCurrentComputeRunRecord(makeKouRecord(1.999))).toBe(false);
    expect(isCurrentComputeRunRecord(makeKouRecord(2))).toBe(true);

    const conflictingEta = makeKouRecord(1.999);
    const etaOutcome = conflictingEta.data.calibrationOutcomes.find((outcome: any) => (
      outcome.model === 'JumpDiffusion'
    ));
    etaOutcome.detail.params.eta1 = 10;
    expect(isCurrentComputeRunRecord(conflictingEta)).toBe(false);

    const conflictingEtaDown = makeKouRecord(2);
    const etaDownOutcome = conflictingEtaDown.data.calibrationOutcomes.find((outcome: any) => (
      outcome.model === 'JumpDiffusion'
    ));
    etaDownOutcome.detail.params.etaDown = 1.499;
    etaDownOutcome.detail.params.eta2 = 8;
    expect(isCurrentComputeRunRecord(conflictingEtaDown)).toBe(false);

    const conflictingProbability = makeKouRecord(2);
    const probabilityOutcome = conflictingProbability.data.calibrationOutcomes.find((outcome: any) => (
      outcome.model === 'JumpDiffusion'
    ));
    probabilityOutcome.detail.params.pUp = -1;
    probabilityOutcome.detail.params.p = 0.4;
    expect(isCurrentComputeRunRecord(conflictingProbability)).toBe(false);
  });

  test('rejects failed rows that claim complete or have no recorded error', () => {
    const completeWithoutError: any = makeCurrentTerminalRecord();
    completeWithoutError.status = 'failed';

    const partialWithoutError: any = makeCurrentTerminalRecord();
    partialWithoutError.status = 'failed';
    partialWithoutError.data.summary.completionState = 'partial';

    expect(isCurrentComputeRunRecord(completeWithoutError)).toBe(false);
    expect(isCurrentComputeRunRecord(partialWithoutError)).toBe(false);
  });

  test('rejects cancelled rows that claim complete', () => {
    const record: any = makeCurrentTerminalRecord();
    record.status = 'cancelled';
    record.data.summary.completionState = 'complete';

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('required calibration failures are completion evidence in MCP records', () => {
    const record: any = makeCurrentTerminalRecord();
    expect(record.data.errors).toEqual([]);
    expect(record.data.modelExclusions).toEqual([]);
    expect(record.data.portfolioAggregates.exclusions).toEqual([]);
    expect(record.data.calibrationOutcomes.some(
      (outcome: any) => outcome.status !== 'success',
    )).toBe(true);
    expect(isCurrentComputeRunRecord(record)).toBe(true);

    record.data.summary.completionState = 'complete';
    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test.each(['none', 'variants', 'variants+exposure'])(
    'rejects %s projections that falsely claim calibration details were truncated',
    (compactionLevel) => {
      const record: any = makeCurrentTerminalRecord();
      Object.assign(record.data.projection, {
        compactionLevel,
        calibrationTruncated: true,
      });

      expect(isCurrentComputeRunRecord(record)).toBe(false);
    },
  );

  test('rejects calibration-outcome omission outside summary-only compaction', () => {
    const record = makeTwoExpiryCoreRecordWithTruncatedOutcomes();
    expect(record.data.projection.compactionLevel).toBe('none');
    expect(record.data.summary.calibrationOutcomesTruncated).toBe(true);

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('rejects a summary-only projection that still retains positions', () => {
    const record: any = makeCurrentTerminalRecord();
    record.data.projection.compactionLevel = 'summary-only';
    delete record.data.exposureSweep;
    delete record.data.portfolioAggregates.coverage;
    expect(record.positions.length).toBeGreaterThan(0);

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('accepts valid failed and cancelled terminal rows', () => {
    const failed: any = makeCurrentTerminalRecord();
    failed.status = 'failed';
    failed.data.summary.completionState = 'partial';
    failed.data.errors = [{ positionId: 'pos-a', model: 'PDE', error: 'solver failed' }];
    failed.data.summary.errorCount = 1;
    failed.data.summary.includedErrorCount = 1;

    const cancelled: any = makeCurrentTerminalRecord();
    cancelled.status = 'cancelled';
    cancelled.data.summary.completionState = 'partial';

    expect(isCurrentComputeRunRecord(failed)).toBe(true);
    expect(isCurrentComputeRunRecord(cancelled)).toBe(true);
  });

  test('rejects calibration outcomes for models that are never calibrated', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, [{
      model: 'BlackScholes',
      underlying: 'SPY',
      expiration: '2026-03-30',
      status: 'success',
    }]);

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('rejects contradictory outer and detail calibration statuses', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, [{
      model: 'Heston',
      underlying: 'SPY',
      expiration: '2026-03-30',
      status: 'success',
      detail: {
        params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
        rmse: null,
        confidence: null,
        isFallback: false,
        warnings: [],
        expirationDate: '2026-03-30',
        status: 'failed',
      },
    }]);

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('rejects a successful calibration outcome with fallback detail', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, [{
      model: 'Heston',
      underlying: 'SPY',
      expiration: '2026-03-30',
      status: 'success',
      detail: {
        params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
        rmse: null,
        confidence: null,
        isFallback: true,
        warnings: [],
        expirationDate: '2026-03-30',
        status: 'success',
      },
    }]);

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('accepts and preserves bounded current calibration warning outcomes', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, requiredCoreCalibrationOutcomes(record).map(outcome => (
      outcome.model === 'Heston'
        && outcome.underlying === 'SPY'
        && outcome.expiration === '2026-03-30'
        ? {
            model: 'Heston',
            underlying: 'SPY',
            expiration: '2026-03-30',
            status: 'success',
            detail: {
              params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
              rmse: null,
              confidence: null,
              isFallback: false,
              warnings: ['Calibration warning survives sync compaction.'],
              expirationDate: '2026-03-30',
              status: 'success',
            },
          }
        : outcome
    )));

    expect(isCurrentComputeRunRecord(record)).toBe(true);

    const payload = { data: [record] };
    sanitizeComputeRunsWireOutput(payload);
    expect(payload.data[0].data.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warnings).toEqual([
      'Calibration warning survives sync compaction.',
    ]);

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warnings).toEqual([
      'Calibration warning survives sync compaction.',
    ]);

    const summarized = summarizeComputeRunsResponse({ data: [record] }, 'detailed') as Record<string, any>;
    expect(summarized.data[0].calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warnings).toEqual([
      'Calibration warning survives sync compaction.',
    ]);

    const oversized = { data: [{ ...record, oversized: 'x'.repeat(900_000) }], count: 1 };
    trimFullComputeRunsResponse(oversized);
    expect(oversized.data[0].calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warnings).toEqual([
      'Calibration warning survives sync compaction.',
    ]);
  });

  test('rejects contradictory retained calibration bindings at the MCP trust boundary', () => {
    const mismatch: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(mismatch, requiredCoreCalibrationOutcomes(mismatch).map(outcome => (
      outcome.model === 'Heston'
        ? {
            model: 'Heston',
            underlying: outcome.underlying,
            expiration: outcome.expiration,
            status: 'success',
            detail: {
              params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
              rmse: null,
              confidence: null,
              isFallback: false,
              warnings: [],
              expirationDate: outcome.expiration,
              status: 'success',
            },
          }
        : outcome
    )));
    mismatch.positions[0].models.Heston.calibration.params.kappa = 3;
    expect(isCurrentComputeRunRecord(mismatch)).toBe(false);

    const missingOutcome: any = makeCurrentTerminalRecord();
    missingOutcome.status = 'failed';
    missingOutcome.data.errors = [{ positionId: 'pos-a', model: 'engine', error: 'stopped after pricing' }];
    missingOutcome.data.summary.errorCount = 1;
    missingOutcome.data.summary.includedErrorCount = 1;
    setCalibrationOutcomes(
      missingOutcome,
      requiredCoreCalibrationOutcomes(missingOutcome).filter(
        outcome => outcome.model !== 'VarianceGamma',
      ),
    );
    missingOutcome.positions[0].models.VarianceGamma.variants[0].price = 10;
    delete missingOutcome.positions[0].models.VarianceGamma.variants[0].error;
    expect(isCurrentComputeRunRecord(missingOutcome)).toBe(false);
  });

  test('counts engine-omitted calibration warnings exactly through compact and budget shaping', () => {
    const record: any = makeCurrentTerminalRecord();
    const proseWarnings = Array.from(
      { length: 19 },
      (_, index) => `Heston calibration warning ${index + 1}.`,
    );
    const engineOmissionSentinel = '[engine omitted 3 additional calibration warnings]';
    const recordedWarnings = [...proseWarnings, engineOmissionSentinel];
    setCalibrationOutcomes(record, requiredCoreCalibrationOutcomes(record).map(outcome => (
      outcome.model === 'Heston'
        && outcome.underlying === 'SPY'
        && outcome.expiration === '2026-03-30'
        ? {
            model: 'Heston',
            underlying: 'SPY',
            expiration: '2026-03-30',
            status: 'success',
            detail: {
              params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
              rmse: null,
              confidence: null,
              isFallback: false,
              warnings: recordedWarnings,
              expirationDate: '2026-03-30',
              status: 'success',
            },
          }
        : outcome
    )));

    expect(isCurrentComputeRunRecord(record)).toBe(true);

    const compact = shapeComputeRunRecord(structuredClone(record)) as Record<string, any>;
    const compactDetail = compact.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail;
    expect(compactDetail.warnings).toEqual(proseWarnings.slice(0, 5));
    expect(compactDetail.warningsNotShown).toBe(17);

    const fullPayload: any = { data: [structuredClone(record)] };
    sanitizeComputeRunsWireOutput(fullPayload);
    const fullDetail = fullPayload.data[0].data.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail;
    expect(fullDetail.warnings).toEqual(recordedWarnings);

    const budgetPayload: any = {
      data: [{ ...compact, oversized: 'x'.repeat(900_000) }],
      count: 1,
    };
    trimFullComputeRunsResponse(budgetPayload);
    const budgetDetail = budgetPayload.data[0].calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail;
    expect(budgetDetail.warnings).toEqual(proseWarnings.slice(0, 3));
    expect(budgetDetail.warningsNotShown).toBe(19);

    const saturatedRecord = structuredClone(record);
    saturatedRecord.data.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warnings[19] = `[engine omitted ${Number.MAX_SAFE_INTEGER} additional calibration warnings]`;
    const saturatedCompact = shapeComputeRunRecord(saturatedRecord) as Record<string, any>;
    const saturatedCompactDetail = saturatedCompact.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail;
    expect(saturatedCompactDetail.warningsNotShown).toBe(Number.MAX_SAFE_INTEGER);

    const saturatedBudget: any = {
      data: [{ ...saturatedCompact, oversized: 'x'.repeat(900_000) }],
      count: 1,
    };
    trimFullComputeRunsResponse(saturatedBudget);
    const saturatedBudgetCount = saturatedBudget.data[0].calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Heston' && outcome.underlying === 'SPY',
    ).detail.warningsNotShown;
    expect(Number.isSafeInteger(saturatedBudgetCount)).toBe(true);
    expect(saturatedBudgetCount).toBe(Number.MAX_SAFE_INTEGER);
  });

  test('rejects duplicate calibration tuples and inconsistent outcome counts', () => {
    const record: any = makeCurrentTerminalRecord();
    const success = {
      model: 'Heston', underlying: 'SPY', expiration: '2026-03-30', status: 'success',
      detail: {
        params: { v0: 0.04, kappa: 2, theta: 0.04, xi: 0.3, rho: -0.5 },
        rmse: null, confidence: null, isFallback: false, warnings: [],
        expirationDate: '2026-03-30', status: 'success',
      },
    };
    setCalibrationOutcomes(record, [success, {
      model: 'Heston', underlying: 'SPY', expiration: '2026-03-30', status: 'failed',
      reason: 'contradictory duplicate',
    }]);
    expect(isCurrentComputeRunRecord(record)).toBe(false);

    setCalibrationOutcomes(record, [success]);
    record.data.summary.totalCalibrations = 0;
    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('rejects omitted, impossible, misattributed, or shadow-invalid completed calibration evidence', () => {
    const zero: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(zero, []);
    expect(isCurrentComputeRunRecord(zero)).toBe(false);

    const partial: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(partial, requiredCoreCalibrationOutcomes(partial).slice(0, 3));
    expect(isCurrentComputeRunRecord(partial)).toBe(false);

    const impossibleSuccesses: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(impossibleSuccesses, [requiredCoreCalibrationOutcomes(impossibleSuccesses)[0]]);
    Object.assign(impossibleSuccesses.data.summary, {
      totalCalibrations: 8,
      calibrationOutcomeCount: 8,
      includedCalibrationOutcomeCount: 1,
      includedSuccessfulCalibrationCount: 0,
      calibrationOutcomesTruncated: true,
    });
    expect(isCurrentComputeRunRecord(impossibleSuccesses)).toBe(false);

    const wrongExpiration: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(wrongExpiration, [{
      ...requiredCoreCalibrationOutcomes(wrongExpiration)[0],
      expiration: '2099-12-31',
    }]);
    Object.assign(wrongExpiration.data.summary, {
      totalCalibrations: 0,
      calibrationOutcomeCount: 8,
      includedCalibrationOutcomeCount: 1,
      includedSuccessfulCalibrationCount: 0,
      calibrationOutcomesTruncated: true,
    });
    expect(isCurrentComputeRunRecord(wrongExpiration)).toBe(false);

    const shadowInvalid: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(shadowInvalid, requiredCoreCalibrationOutcomes(shadowInvalid).map(outcome => (
      outcome.model === 'Heston'
        && outcome.underlying === 'SPY'
        && outcome.expiration === '2026-03-30'
        ? {
            model: 'Heston', underlying: 'SPY', expiration: '2026-03-30', status: 'success',
            detail: {
              params: { v0: 0.04, kappa: 2, theta: 0.04, xi: -1, volOfVol: 0.3, rho: -0.5 },
              rmse: null, confidence: null, isFallback: false, warnings: [],
              expirationDate: '2026-03-30', status: 'success',
            },
          }
        : outcome
    )));
    expect(isCurrentComputeRunRecord(shadowInvalid)).toBe(false);

    const visiblePositionWithoutOutcome: any = makeCurrentTerminalRecord();
    visiblePositionWithoutOutcome.positions[0].expiration = '2099-12-31';
    visiblePositionWithoutOutcome.data.summary.totalPositions = 3;
    Object.assign(visiblePositionWithoutOutcome.data.projection, {
      originalPositionCount: 3,
      positionsTruncated: true,
    });
    expect(isCurrentComputeRunRecord(visiblePositionWithoutOutcome)).toBe(false);
  });

  test('rejects a false original calibration outcome count when every position is retained', () => {
    const record = makeTwoExpiryCoreRecord();
    expect(isCurrentComputeRunRecord(record)).toBe(true);

    record.data.summary.calibrationOutcomeCount = 4;
    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('rejects a phantom authoritative underlying when every position is retained', () => {
    const record = makeTwoExpiryCoreRecordWithTruncatedOutcomes();
    record.data.underlyings = ['QQQ', 'SPY'];

    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('counts the union of retained position and calibration outcome groups', () => {
    const record = makeTwoExpiryCoreRecord();
    record.positions = record.positions.slice(0, 1);
    Object.assign(record.data.projection, {
      includedPositionCount: 1,
      positionsTruncated: true,
      variantsTruncated: true,
    });
    expect(isCurrentComputeRunRecord(record)).toBe(true);

    record.data.summary.calibrationOutcomeCount = 4;
    expect(isCurrentComputeRunRecord(record)).toBe(false);
  });

  test('preserves producer-side calibration outcome omissions in assistant shaping', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, [{
      model: 'VarianceGamma', underlying: 'SPY', expiration: '2026-03-30', status: 'success',
      detail: {
        params: { sigma: 0.2, nu: 0.3, theta: -0.1 },
        rmse: 2.25,
        confidence: 35,
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'variance-gamma-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
        isFallback: false,
        warnings: ['Variance Gamma calibration quality is low.'],
        expirationDate: '2026-03-30',
        status: 'success',
      },
    }]);
    Object.assign(record.data.summary, {
      completionState: 'partial',
      totalCalibrations: 5,
      calibrationOutcomeCount: 8,
      includedCalibrationOutcomeCount: 1,
      includedSuccessfulCalibrationCount: 1,
      calibrationOutcomesTruncated: true,
    });
    makeSummaryOnlyRecord(record);

    expect(isCurrentComputeRunRecord(record)).toBe(true);
    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.calibrationOutcomes).toHaveLength(1);
    expect(shaped.calibrationOutcomesNotShown).toBe(7);
    expect(shaped.summary).toMatchObject({
      calibrationOutcomeCount: 8,
      includedCalibrationOutcomeCount: 1,
      includedSuccessfulCalibrationCount: 1,
      calibrationOutcomesTruncated: true,
    });
  });

  test('prioritizes a warning outcome over capped generic unavailable outcomes', () => {
    const record: any = makeCurrentTerminalRecord();
    const genericGroups = [
      { underlying: 'QQQ', expiration: '2026-03-30' },
      { underlying: 'SPY', expiration: '2026-04-30' },
      { underlying: 'SPY', expiration: '2026-05-30' },
      { underlying: 'SPY', expiration: '2026-06-30' },
      { underlying: 'SPY', expiration: '2026-07-30' },
    ];
    setCalibrationOutcomes(record, [
      ...genericGroups.flatMap(({ underlying, expiration }, groupIndex) => (
        ['Heston', 'SABR', 'JumpDiffusion', 'VarianceGamma'].map(model => ({
          model,
          underlying,
          expiration,
          status: 'unavailable',
          reason: `No calibration surface ${groupIndex}`,
        }))
      )),
      {
        model: 'VarianceGamma',
        underlying: 'SPY',
        expiration: '2026-03-30',
        status: 'success',
        detail: {
          params: { sigma: 0.2, nu: 0.3, theta: -0.1 },
          rmse: 2.25,
          confidence: 35,
          confidenceSemantics: {
            label: 'model-specific calibration quality score',
            method: 'variance-gamma-quality-v1',
            scale: '0-100 points',
            crossModelComparable: false,
          },
          isFallback: false,
          warnings: ['Variance Gamma calibration quality is low.'],
          expirationDate: '2026-03-30',
          status: 'success',
        },
      },
    ]);
    Object.assign(record.data.summary, {
      totalPositions: 6,
      calibrationOutcomeCount: 24,
      includedCalibrationOutcomeCount: 21,
      includedSuccessfulCalibrationCount: 1,
      calibrationOutcomesTruncated: true,
    });
    Object.assign(record.data.projection, {
      originalPositionCount: 6,
      includedPositionCount: 2,
      positionsTruncated: true,
    });
    makeSummaryOnlyRecord(record);

    expect(isCurrentComputeRunRecord(record)).toBe(true);
    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.calibrationOutcomes[0].detail.warnings).toEqual([
      'Variance Gamma calibration quality is low.',
    ]);
    expect(shaped.calibrationOutcomesNotShown).toBe(4);

    const oversized: any = { data: [{ ...shaped, oversized: 'x'.repeat(900_000) }], count: 1 };
    trimFullComputeRunsResponse(oversized);
    expect(oversized.data[0].calibrationOutcomes[0].detail.warnings).toEqual([
      'Variance Gamma calibration quality is low.',
    ]);
  });

  test('keeps the emergency floor below its byte budget with worst-case evidence text', () => {
    const record: any = makeCurrentTerminalRecord();
    record.data.notices = Array.from({ length: 5 }, (_, index) => ({
      code: index === 4 ? 'EXPOSURE_SWEEP_FAILED' : 'DIVIDEND_ZERO_ASSUMPTION',
      level: 'warning',
      message: `notice-${index}-${'漢'.repeat(1_900)}`,
      positionId: '漢'.repeat(128),
      underlying: 'SPY',
      expiration: '漢'.repeat(64),
    }));
    Object.assign(record.data.summary, {
      noticeCount: 7,
      includedNoticeCount: 5,
      noticesTruncated: true,
    });
    expect(isCurrentComputeRunRecord(record)).toBe(true);
    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    expect(shaped.noticesMeta.entriesWithTruncatedFields).toBe(5);
    shaped.calibrationOutcomes = Array.from({ length: 10 }, (_, index) => ({
      model: 'Variance Gamma',
      underlying: 'SPY',
      expiration: '2026-03-30',
      status: 'success',
      reason: `reason-${index}-${'漢'.repeat(2_000)}`,
      detail: {
        rmse: 2.25,
        confidence: 35,
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'variance-gamma-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
        expirationDate: '2026-03-30',
        warnings: Array.from({ length: 10 }, (_, warningIndex) => (
          `warning-${warningIndex}-${'漢'.repeat(500)}`
        )),
      },
    }));
    shaped.aggregateExclusions = Array.from({ length: 20 }, (_, index) => ({
      model: 'PDE',
      metric: `Metric${index}`,
      reason: '漢'.repeat(500),
    }));
    shaped.modelExclusions = Array.from({ length: 20 }, (_, index) => ({
      model: 'PDE',
      underlying: 'SPY',
      expiration: '2026-03-30',
      reason: `model-${index}-${'漢'.repeat(500)}`,
    }));
    const payload: any = { data: [{ ...shaped, oversized: 'x'.repeat(900_000) }], count: 1 };
    trimFullComputeRunsResponse(payload);

    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(48 * 1024);
    expect(payload.data[0].calibrationOutcomes[0].detail.warnings[0]).toContain('warning-0');
    expect(payload.data[0].calibrationOutcomes[0].detail.warningsNotShown).toBe(9);
    expect(payload.data[0].calibrationOutcomesNotShown).toBeGreaterThan(0);
    expect(payload.data[0].noticesMeta).toMatchObject({
      total: 7,
      returned: payload.data[0].notices.length,
      omitted: payload.data[0].noticesNotShown,
      entriesWithTruncatedFields: payload.data[0].notices.length,
    });
    expect(payload.data[0].notices.length).toBeGreaterThan(0);
    expect(payload.data[0].notices.map((notice: { code: string }) => notice.code)).toContain(
      'EXPOSURE_SWEEP_FAILED',
    );
  });

  test('preserves sanitized fallback calibration status through emergency trimming', () => {
    const record: any = makeCurrentTerminalRecord();
    setCalibrationOutcomes(record, requiredCoreCalibrationOutcomes(record).map(outcome => (
      outcome.model === 'JumpDiffusion'
        && outcome.underlying === 'SPY'
        && outcome.expiration === '2026-03-30'
        ? {
            model: 'JumpDiffusion',
            underlying: 'SPY',
            expiration: '2026-03-30',
            status: 'failed',
            reason: 'fallback_calibration',
            detail: {
              params: {},
              rmse: null,
              confidence: null,
              isFallback: true,
              failureReason: 'fallback_calibration',
              warnings: ['Fallback calibration used.'],
              expirationDate: '2026-03-30',
              status: 'failed',
            },
          }
        : outcome
    )));
    expect(isCurrentComputeRunRecord(record)).toBe(true);

    const compact = shapeComputeRunRecord(structuredClone(record)) as Record<string, any>;
    const compactOutcome = compact.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Jump Diffusion',
    );
    expect(compactOutcome.reason).toBe('fallback calibration');
    expect(compact.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'SABR',
    ).reason).toBe('No calibratable observations in test fixture');

    const payload: any = { data: [record] };
    sanitizeComputeRunsWireOutput(payload);
    sanitizeComputeRunsWireOutput(payload);
    const fullOutcome = payload.data[0].data.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Jump Diffusion',
    );
    expect(fullOutcome.reason).toBe('fallback calibration');
    expect(payload.data[0].data.calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'SABR',
    ).reason).toBe('No calibratable observations in test fixture');
    payload.data[0].oversized = 'x'.repeat(900_000);
    trimFullComputeRunsResponse(payload);

    const trimmedOutcome = payload.data[0].calibrationOutcomes.find(
      (outcome: any) => outcome.model === 'Jump Diffusion',
    );
    expect(trimmedOutcome.detail.status).toBe('fallback (default parameters)');
    expect(trimmedOutcome.detail.statusReason).toBe('fallback calibration');
  });

  test('removes spoofed calibration omission counts before deriving trusted counts', () => {
    const record: any = makeCurrentTerminalRecord();
    record.data.calibrationOutcomesNotShown = 999;
    record.data.calibrationOutcomes = [{
      model: 'Heston',
      underlying: 'SPY',
      expiration: '2026-03-30',
      status: 'success',
      detail: {
        params: {},
        rmse: null,
        confidence: null,
        isFallback: false,
        warnings: ['One recorded warning.'],
        warningsNotShown: 999,
        expirationDate: '2026-03-30',
      },
    }];
    const payload: any = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    expect(payload.data[0].data).not.toHaveProperty('calibrationOutcomesNotShown');
    expect(payload.data[0].data.calibrationOutcomes[0].detail).not.toHaveProperty('warningsNotShown');
  });

  test.each(['abc123', 'A'.repeat(64)])(
    'rejects a current-looking row whose input hash is not lowercase SHA-256: %s',
    (inputHash) => {
      const record: any = makeCurrentTerminalRecord();
      record.data.summary.inputHash = inputHash;

      expect(isCurrentComputeRunRecord(record)).toBe(false);
    },
  );
});

function makeRecord() {
  return {
    id: 9,
    user_id: 1,
    created_at: '2026-03-29T08:00:00.000Z',
    key: 'compute-run-row',
    run_key: 'run-123',
    scope: 'full',
    quality: 'balanced',
    status: 'completed',
    timestamp: 1774771200000,
    data: {
      syncSchemaVersion: 2,
      runSchemaVersion: 2,
      key: 'compute-run-data',
      summary: {
        inputHash: 'a'.repeat(64),
        completedAt: 1774771560000,
        totalPositions: 2,
        totalModelRuns: 24,
        totalCalibrations: 0,
        executionTimeMs: 358646.55,
        errorCount: 1,
        engineVersion: '2.0.6',
        completionState: 'partial',
        modelExclusionCount: 0,
        includedModelExclusionCount: 0,
        modelExclusionsTruncated: false,
        calibrationOutcomeCount: 0,
        includedCalibrationOutcomeCount: 0,
        includedSuccessfulCalibrationCount: 0,
        calibrationOutcomesTruncated: false,
      },
      underlyings: ['QQQ', 'SPY'],
      errors: [{ positionId: 'pos-b', model: 'PDE', error: 'slow' }],
      modelExclusions: [],
      calibrationOutcomes: [],
      projection: {
        schemaVersion: 2,
        compactionLevel: 'none',
        originalPositionCount: 2,
        includedPositionCount: 2,
        positionsTruncated: false,
        variantsTruncated: false,
        exposureTruncated: false,
        calibrationTruncated: false,
        earlyExercisePremiumTruncated: false,
        portfolioAggregatesTruncated: false,
      },
      portfolioAggregates: {
        byModel: {},
        exclusions: [],
        dispersion: {
          Delta: { min: 50.6, max: 52.8, mean: 51.7, stddev: 0.82, models: ['BlackScholes', 'Heston', 'VarianceGamma'] },
        },
      },
      exposureSweep: [{
        underlying: 'SPY',
        spot: 634.09,
        strikeCount: 136,
        aggregateByStrike: [],
        aggregateByStrikeTruncated: true,
        keyLevels: { regime: 'negative-gamma', gammaFlip: 645.9, callWall: 650, putWall: 620, gammaTilt: -1, secondaryFlips: [] },
        timestamp: 1774771500000,
      }],
    },
    positions: [
      {
        positionId: 'pos-a',
        symbol: 'SPY250330C00634000',
        underlying: 'SPY',
        isCall: true,
        strike: 634,
        expiration: '2026-03-30',
        daysToExpiry: 3,
        spot: 634.09,
        iv: 0.2296,
        quantity: 1,
        multiplier: 100,
        marketPrice: 4.97,
        riskFreeRate: 0.045,
        dividendYield: 0.012,
        models: {
          Heston: {
            variantCount: 2,
            variantsTruncated: false,
            variants: [
              {
                price: 5.13,
                greeks: { Delta: 0.54, Vega: 0.31 },
                dimensions: { exerciseStyle: 'european' },
                diagnostics: { solverPath: 'debug-worker', iterationCount: 42 },
              },
              {
                price: 5.2,
                greeks: {},
                dimensions: { exerciseStyle: 'american' },
              },
            ],
            calibration: {
              key: 'heston-calibration',
              rmse: 0.012,
              confidence: 0.94,
              confidenceSemantics: {
                label: 'model-specific calibration quality score',
                method: 'heston-quality-v1',
                scale: '0-100 points',
                crossModelComparable: false,
              },
              isFallback: false,
              expirationDate: '2026-03-30',
              params: { kappa: 1.2, theta: 0.05 },
            },
          },
          PDE: {
            variantCount: 2,
            variantsTruncated: false,
            variants: [
              {
                price: 5.36,
                greeks: { Delta: 0.51, Gamma: 0.03 },
                dimensions: { exerciseStyle: 'european' },
              },
              {
                price: 5.61,
                greeks: {},
                dimensions: { exerciseStyle: 'american' },
              },
            ],
            earlyExercisePremium: { priceAmerican: 5.61, priceEuropean: 5.36, premium: 0.25, premiumPercent: 4.66 },
          },
        },
      },
      {
        positionId: 'pos-b',
        symbol: 'QQQ250330P00500000',
        underlying: 'QQQ',
        isCall: false,
        strike: 500,
        expiration: '2026-03-30',
        daysToExpiry: 3,
        spot: 499.5,
        iv: 0.3,
        quantity: 2,
        multiplier: 100,
        marketPrice: 12.4,
        riskFreeRate: 0.045,
        dividendYield: 0.0,
        models: {
          BlackScholes: {
            variantCount: 1,
            variantsTruncated: false,
            variants: [{
              price: { value: 12.1, stdError: 0.02 },
              greeks: { Delta: -0.48, Theta: -0.22 },
              dimensions: { exerciseStyle: 'european' },
            }],
          },
        },
      },
    ],
  };
}

function exactCalibrationSemantics(
  method: 'unified-jump-selection-v1' | 'variance-gamma-quality-v1',
) {
  return {
    label: method === 'unified-jump-selection-v1'
      ? 'within-family model-selection score'
      : 'model-specific calibration quality score',
    method,
    scale: '0-100 points',
    crossModelComparable: false,
  };
}

function calibrationModel(
  confidence: number | null,
  confidenceSemantics?: ReturnType<typeof exactCalibrationSemantics>,
) {
  return {
    variantCount: 0,
    variants: [],
    variantsTruncated: false,
    calibration: {
      params: { calibrated: true },
      rmse: 0.01,
      confidence,
      ...(confidenceSemantics ? { confidenceSemantics } : {}),
      isFallback: false,
      warnings: [],
      expirationDate: '2026-03-30',
    },
  };
}

describe('shapeComputeRunRecord', () => {
  test('builds a compact assistant-facing compute-run summary', () => {
    const shaped = shapeComputeRunRecord(makeRecord()) as Record<string, any>;

    expect(shaped.runKey).toBeUndefined();
    expect(shaped.summary.totalModelRuns).toBe(24);
    expect(shaped.engineVersion).toBe('2.0.6');
    expect(shaped.summary.engineVersion).toBeUndefined();
    expect(shaped.errors).toEqual([{ model: 'PDE', message: 'slow' }]);
    expect(JSON.stringify(shaped)).not.toContain('debug-worker');
    expect(shaped.portfolioDispersion.Delta).toEqual({
      min: 50.6,
      max: 52.8,
      mean: 51.7,
      stddev: 0.82,
      models: ['Black-Scholes', 'Heston', 'Variance Gamma'],
    });
    expect(shaped.exposureSweep[0]).toEqual(
      expect.objectContaining({
        underlying: 'SPY',
        strikeCount: 136,
        levels: expect.objectContaining({ 'call wall': 650 }),
      }),
    );
    expect(shaped.exposureSweep[0].keyLevels).toBeUndefined();
    expect(shaped.positions[0].symbol).toBe('QQQ250330P00500000');
    expect(shaped.positions[0].positionId).toBeUndefined();
    expect(shaped.positions[0].modelCount).toBe(1);
    expect(shaped.positions[0].models['Black-Scholes']).toBeDefined();
    expect(shaped.positions[0].models.BlackScholes).toBeUndefined();
    expect(shaped.positions[1].models.Heston.calibrationSummary.rmse).toBe(0.012);
    expect(shaped.positions[1].models.Heston.calibrationSummary.confidence).toBe(0.94);
    expect(shaped.positions[1].models.Heston.calibrationSummary.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
    expect(shaped.positions[1].models.Heston.calibrationSummary.fallback).toBeUndefined();
    expect(shaped.positions[1].models.Heston.calibrationSummary.executionPath).toBeUndefined();
    expect(shaped.positions[1].models.PDE.alternateCount).toBe(1);
  });

  test('keeps an explicitly empty variant and run error visible in strict compact output', () => {
    const record: any = makeRecord();
    record.data.summary.errorCount = 1;
    record.data.errors = [{ positionId: 'pos-a', model: 'PDE', error: '' }];
    record.positions[0].models.PDE = {
      variantCount: 1,
      variantsTruncated: false,
      variants: [{
        dimensions: { exerciseStyle: 'european' },
        price: 5.36,
        greeks: { Delta: 0.51 },
        error: '',
      }],
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const spy = shaped.positions.find((position: any) => position.underlying === 'SPY');

    expect(Object.prototype.hasOwnProperty.call(spy.models.PDE, 'error')).toBe(true);
    expect(spy.models.PDE.error).toBe('');
    expect(shaped.errors).toEqual([{ model: 'PDE', message: '' }]);
  });

  test('does not prioritize an empty-error European variant over a successful American variant', () => {
    const record: any = makeRecord();
    record.positions[0].models.PDE = {
      variantCount: 2,
      variantsTruncated: false,
      variants: [
        {
          dimensions: { exerciseStyle: 'european' },
          price: 5.36,
          greeks: {},
          error: '',
        },
        {
          dimensions: { exerciseStyle: 'american' },
          price: 6.25,
          greeks: {},
        },
      ],
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const spy = shaped.positions.find((position: any) => position.underlying === 'SPY');

    expect(spy.models.PDE.price).toBe(6.25);
    expect(spy.models.PDE).not.toHaveProperty('error');
  });

  test('exposes distinct Heston and SABR confidence semantics in detailed shaping', () => {
    const record: any = makeRecord();
    record.positions[0].models.Heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
      internalFormula: 'do not expose',
    };
    record.positions[0].models.SABR = {
      variantCount: 0,
      variants: [],
      variantsTruncated: false,
      calibration: {
        params: { alpha: 0.2 },
        rmse: 0.02,
        confidence: 87,
        isFallback: false,
        warnings: [],
        expirationDate: '2026-03-30',
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'sabr-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
          internalFormula: 'do not expose',
        },
      },
    };
    record.positions[0].models['MonteCarlo-Heston'] = {
      calibration: {
        params: { v0: 0.04 },
        rmse: 0.01,
        confidence: 91,
        isFallback: false,
        expirationDate: '2026-03-30',
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'heston-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
      },
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const models = shaped.positions.find((position: any) => position.underlying === 'SPY').models;

    expect(models.Heston.calibrationSummary.confidence).toBe(0.94);
    expect(models.Heston.calibrationSummary.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
    expect(models.SABR.calibrationSummary.confidence).toBe(87);
    expect(models.SABR.calibrationSummary.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'sabr-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
    expect(models['Monte Carlo - Heston'].calibrationSummary.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
  });

  test('preserves valid exact 2.0.6 JD/VG pairs and the MC-JD null in compact shaping', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models.JumpDiffusion = calibrationModel(
      72,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    );
    record.positions[0].models.VarianceGamma = calibrationModel(
      83,
      exactCalibrationSemantics('variance-gamma-quality-v1'),
    );
    record.positions[0].models['MonteCarlo-JumpDiffusion'] = calibrationModel(null);

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const models = shaped.positions.find((position: any) => position.underlying === 'SPY').models;

    expect(models['Jump Diffusion'].calibrationSummary).toMatchObject({
      confidence: 72,
      confidenceSemantics: exactCalibrationSemantics('unified-jump-selection-v1'),
    });
    expect(models['Variance Gamma'].calibrationSummary).toMatchObject({
      confidence: 83,
      confidenceSemantics: exactCalibrationSemantics('variance-gamma-quality-v1'),
    });
    expect(models['Monte Carlo - Jump Diffusion'].calibrationSummary.confidence).toBeUndefined();
    expect(models['Monte Carlo - Jump Diffusion'].calibrationSummary.confidenceSemantics).toBeUndefined();
  });

  test('withholds every malformed strict 2.0.6 JD/VG/MC-JD confidence fact in compact shaping', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models.JumpDiffusion = calibrationModel(72);
    record.positions[0].models.VarianceGamma = calibrationModel(
      83,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    );
    record.positions[0].models['MonteCarlo-JumpDiffusion'] = calibrationModel(64);

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const models = shaped.positions.find((position: any) => position.underlying === 'SPY').models;

    for (const modelName of [
      'Jump Diffusion',
      'Variance Gamma',
      'Monte Carlo - Jump Diffusion',
    ]) {
      expect(models[modelName].calibrationSummary.confidence, modelName).toBeUndefined();
      expect(models[modelName].calibrationSummary.confidenceSemantics, modelName).toBeUndefined();
    }
  });

  test.each([
    ['label', { label: 'wrong label' }],
    ['method', { method: 'variance-gamma-quality-v1' }],
    ['scale', { scale: 'percent' }],
    ['crossModelComparable', { crossModelComparable: true }],
  ] as const)(
    'withholds compact JD confidence when exact semantics %s is mutated',
    (_field, mutation) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.summary.engineVersion = '2.0.6';
      const semantics = {
        ...exactCalibrationSemantics('unified-jump-selection-v1'),
        ...mutation,
      };
      record.positions[0].models = {
        JumpDiffusion: calibrationModel(72, semantics as any),
      };

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      const calibration = shaped.positions
        .find((position: any) => position.underlying === 'SPY')
        .models['Jump Diffusion'].calibrationSummary;
      expect(calibration.confidence).toBeUndefined();
      expect(calibration.confidenceSemantics).toBeUndefined();
    },
  );

  test('withholds a noncanonical JD alias in current compact shaping', () => {
    const record: any = makeRecord();
    record.positions[0].models['Jump Diffusion_'] = calibrationModel(
      72,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    );
    record.positions[0].models['Jump Diffusion_'].calibration.expirationDate = 'jd-alias-marker';

    const current = shapeComputeRunRecord(record) as Record<string, any>;
    const currentCalibration = Object.values(current.positions
      .find((position: any) => position.underlying === 'SPY').models)
      .map((model: any) => model.calibrationSummary)
      .find((calibration: any) => calibration?.expirationDate === 'jd-alias-marker');

    expect(currentCalibration?.confidence).toBeUndefined();
    expect(currentCalibration?.confidenceSemantics).toBeUndefined();
  });

  test.each([
    ['Jump Diffusion', 72, exactCalibrationSemantics('unified-jump-selection-v1')],
    ['Variance Gamma', 83, exactCalibrationSemantics('variance-gamma-quality-v1')],
    ['Monte Carlo - Jump Diffusion', 64, undefined],
  ] as const)(
    'withholds strict 2.0.6 confidence facts from raw exact display model id %s in compact shaping',
    (displayModelId, confidence, semantics) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.summary.engineVersion = '2.0.6';
      record.positions[0].models = {
        [displayModelId]: calibrationModel(confidence, semantics),
      };

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      const calibration = shaped.positions
        .find((position: any) => position.underlying === 'SPY')
        .models[displayModelId].calibrationSummary;

      expect(calibration.confidence).toBeUndefined();
      expect(calibration.confidenceSemantics).toBeUndefined();
    },
  );

  test.each([
    ['Heston', 'Heston'],
    ['SABR', 'SABR'],
    ['MonteCarlo-Heston', 'Monte Carlo - Heston'],
    ['JumpDiffusion', 'Jump Diffusion'],
    ['VarianceGamma', 'Variance Gamma'],
    ['MonteCarlo-JumpDiffusion', 'Monte Carlo - Jump Diffusion'],
  ] as const)(
    'omits unavailable strict %s null confidence without inventing semantics in compact shaping',
    (backendModelId, displayModelId) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.positions[0].models = {
        [backendModelId]: calibrationModel(null),
      };

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      const calibration = shaped.positions
        .find((position: any) => position.underlying === 'SPY')
        .models[displayModelId].calibrationSummary;

      expect(calibration.confidence).toBeUndefined();
      expect(calibration.confidenceSemantics).toBeUndefined();
    },
  );

  test('withholds an unsupported confidence method from a current compact response', () => {
    const record: any = makeRecord();
    record.positions[0].models.Heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'unsupported-method',
      scale: '0-100 points',
      crossModelComparable: false,
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const calibration = shaped.positions
      .find((position: any) => position.underlying === 'SPY')
      .models.Heston.calibrationSummary;

    expect(calibration.confidence).toBeUndefined();
    expect(calibration.confidenceSemantics).toBeUndefined();
  });

  test.each(['Monte Carlo - Heston', 'Monte Carlo Heston', 'MonteCarlo_Heston'])(
    'withholds confidence from protected noncanonical current model alias %s in compact mode',
    (modelAlias) => {
      const record: any = makeRecord();
      const model = record.positions[0].models.Heston;
      delete record.positions[0].models.Heston;
      model.calibration.confidence = 87;
      model.calibration.confidenceSemantics = {
        label: 'model-specific calibration quality score',
        method: 'heston-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      };
      record.positions[0].models[modelAlias] = model;

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      const calibration = Object.values(shaped.positions
        .find((position: any) => position.underlying === 'SPY').models)
        .map((entry: any) => entry.calibrationSummary)
        .find(Boolean) as Record<string, unknown>;

      expect(calibration.confidence).toBeUndefined();
      expect(calibration.confidenceSemantics).toBeUndefined();
    },
  );

  test('drops confidence semantics whose method does not match the calibrated model', () => {
    const record: any = makeRecord();
    record.positions[0].models.Heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'sabr-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    };
    record.positions[0].models.SABR = {
      calibration: {
        confidence: 87,
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'heston-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
      },
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const models = shaped.positions.find((position: any) => position.underlying === 'SPY').models;

    expect(models.Heston.calibrationSummary.confidence).toBeUndefined();
    expect(models.Heston.calibrationSummary.confidenceSemantics).toBeUndefined();
    expect(models.SABR.calibrationSummary.confidence).toBeUndefined();
    expect(models.SABR.calibrationSummary.confidenceSemantics).toBeUndefined();
  });

  test.each([101, Number.POSITIVE_INFINITY])(
    'drops explicit confidence semantics when confidence %p is outside the documented scale',
    (confidence) => {
      const record: any = makeRecord();
      record.positions[0].models.Heston.calibration.confidence = confidence;
      record.positions[0].models.Heston.calibration.confidenceSemantics = {
        label: 'model-specific calibration quality score',
        method: 'heston-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      };

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      const heston = shaped.positions.find((position: any) => position.underlying === 'SPY').models.Heston;

      expect(heston.calibrationSummary.confidence).toBeUndefined();
      expect(heston.calibrationSummary.confidenceSemantics).toBeUndefined();
    },
  );

  test('keeps canonical aggregate omissions separate from vestigial dispersion diagnostics', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.excluded = { models: ['BlackScholes'] };
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
        complete: false, reason: 'duplicate_source',
      },
      {
        model: 'BlackScholes', metric: 'Price', included: 1, expected: 2,
        complete: false, reason: 'incomplete_position_coverage',
      },
      {
        model: 'Future_Model', metric: 'Delta', included: 1, expected: 2,
        complete: false, reason: 'future_contract_reason',
      },
    ];
    record.data.modelExclusions = [{
      model: 'LocalVol-Dupire',
      underlying: 'spy',
      expiration: '2026-05-15',
      reason: 'exact_chain_required',
      dependency: 'BlackScholes',
    }];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.dispersionExclusions).toBeUndefined();
    expect(shaped.aggregateExclusions).toEqual([
      {
        model: 'Black-Scholes', metric: 'Price', included: 1, expected: 2,
        reason: 'incomplete position coverage',
      },
      {
        model: 'Future Model', metric: 'Delta', included: null, expected: null,
        reason: 'future contract reason',
      },
    ]);
    expect(shaped.modelExclusions).toEqual([{
      model: 'Local Volatility - Dupire',
      underlying: 'SPY',
      expiration: '2026-05-15',
      reason: 'exact chain required',
      dependency: 'Black-Scholes',
    }]);
    expect(JSON.stringify(shaped)).not.toContain('duplicate_source');
  });

  test('preserves explicit canonical empty completion-reason arrays', () => {
    const canonical: any = makeRecord();
    canonical.data.runSchemaVersion = 2;
    canonical.data.portfolioAggregates.exclusions = [];
    canonical.data.modelExclusions = [];

    const canonicalShaped = shapeComputeRunRecord(canonical) as Record<string, any>;
    expect(canonicalShaped.aggregateExclusions).toEqual([]);
    expect(canonicalShaped.modelExclusions).toEqual([]);
    expect(canonicalShaped.dispersionExclusions).toBeUndefined();
    expect(canonicalShaped.aggregateExclusionsNotShown).toBeUndefined();
    expect(canonicalShaped.modelExclusionsNotShown).toBeUndefined();
  });

  test('requires own current discriminators and canonical source path segments', () => {
    const aggregate = [{
      model: 'BlackScholes', metric: 'Price', included: 1, expected: 2,
      complete: false, reason: 'incomplete_position_coverage',
    }];
    const models = [{
      model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
      reason: 'exact_chain_required',
    }];
    const canonicalData = () => ({
      syncSchemaVersion: 2,
      runSchemaVersion: 2,
      summary: {
        engineVersion: '2.0.6',
        inputHash: 'a'.repeat(64),
      },
      portfolioAggregates: { exclusions: aggregate },
      modelExclusions: models,
    });

    const missingSyncSchema: any = makeRecord();
    Object.assign(missingSyncSchema.data, canonicalData());
    delete missingSyncSchema.data.syncSchemaVersion;

    const inheritedRecord: any = Object.create({ data: canonicalData() });
    Object.assign(inheritedRecord, { status: 'completed', timestamp: 1774771200000, positions: [] });

    const inheritedVersion: any = makeRecord();
    inheritedVersion.data = Object.assign(
      Object.create({ runSchemaVersion: 2 }),
      { portfolioAggregates: { exclusions: aggregate }, modelExclusions: models },
    );

    const inheritedContainers: any = makeRecord();
    inheritedContainers.data = Object.assign(
      Object.create({ portfolioAggregates: { exclusions: aggregate }, modelExclusions: models }),
      { runSchemaVersion: 2 },
    );

    const inheritedAggregateArray: any = makeRecord();
    inheritedAggregateArray.data = {
      runSchemaVersion: 2,
      portfolioAggregates: Object.create({ exclusions: aggregate }),
    };

    for (const record of [missingSyncSchema, inheritedRecord, inheritedVersion, inheritedContainers, inheritedAggregateArray]) {
      const shaped = shapeComputeRunRecord(record) as Record<string, any>;
      expect(shaped.aggregateExclusions).toBeUndefined();
      expect(shaped.aggregateExclusionsNotShown).toBeUndefined();
      expect(shaped.modelExclusions).toBeUndefined();
      expect(shaped.modelExclusionsNotShown).toBeUndefined();
    }
  });

  test('keeps prototype-only and sparse canonical entries visible without trusting inherited fields', () => {
    const inheritedAggregate = Object.create({
      model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
      complete: false, reason: 'duplicate_source',
    });
    Object.defineProperty(inheritedAggregate, 'reason', {
      value: 'duplicate_source', enumerable: true, configurable: true,
    });
    const inheritedModel = Object.create({
      model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
      reason: 'exact_chain_required', dependency: 'BlackScholes',
    });
    const aggregateExclusions = new Array(2);
    const modelExclusions = new Array(2);
    aggregateExclusions[0] = inheritedAggregate;
    modelExclusions[0] = inheritedModel;
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = aggregateExclusions;
    record.data.modelExclusions = modelExclusions;

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions).toEqual([
      {
        model: 'model not recorded', metric: 'metric not recorded',
        included: null, expected: null, reason: 'duplicate source',
      },
      {
        model: 'model not recorded', metric: 'metric not recorded',
        included: null, expected: null, reason: 'reason not recorded',
      },
    ]);
    expect(shaped.modelExclusions).toEqual([
      {
        model: 'model not recorded', underlying: 'underlying not recorded',
        expiration: 'expiration not recorded', reason: 'reason not recorded',
      },
      {
        model: 'model not recorded', underlying: 'underlying not recorded',
        expiration: 'expiration not recorded', reason: 'reason not recorded',
      },
    ]);
  });

  test.each([
    ['blank model', { model: ' ' }],
    ['blank metric', { metric: '' }],
    ['fractional included count', { included: 1.5, expected: 1.5 }],
    ['non-finite included count', { included: Number.POSITIVE_INFINITY, expected: Number.POSITIVE_INFINITY }],
    ['fractional expected count', { included: 1.5, expected: 1.5 }],
    ['non-positive expected count', { included: 0, expected: 0 }],
    ['unequal counts', { included: 1, expected: 2 }],
    ['non-false completion flag', { complete: true }],
    ['non-exact reason', { reason: 'duplicate-source' }],
  ])('keeps malformed duplicate bookkeeping visible for %s', (_label, mutation) => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [{
      model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
      complete: false, reason: 'duplicate_source',
      ...mutation,
    }];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions).toHaveLength(1);
  });

  test('filters only duplicate bookkeeping with every predicate present as an own field', () => {
    const valid = {
      model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
      complete: false, reason: 'duplicate_source',
    };
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [valid];
    expect((shapeComputeRunRecord(record) as Record<string, any>).aggregateExclusions).toEqual([]);

    for (const field of ['model', 'metric', 'included', 'expected', 'complete', 'reason'] as const) {
      const prototype = { [field]: valid[field] };
      const spoof = Object.assign(Object.create(prototype), valid);
      delete spoof[field];
      record.data.portfolioAggregates.exclusions = [spoof];

      expect((shapeComputeRunRecord(record) as Record<string, any>).aggregateExclusions).toHaveLength(1);
    }
  });

  test('filters only exact duplicate-source bookkeeping before capping and bounding reasons', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
        complete: false, reason: 'duplicate_source',
      },
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 1, expected: 2,
        complete: false, reason: 'duplicate_source',
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        model: index === 0 ? 'BlackScholes' : `Model_${index}_${'m'.repeat(180)}`,
        metric: `Metric_${index}_${'g'.repeat(180)}`,
        included: 7,
        expected: 9,
        complete: false,
        reason: index === 0
          ? 'unsafe_net_value'
          : index === 2
            ? null
            : index === 1
              ? `future_reason_${index}_${'漢'.repeat(600)}`
              : `future_reason_${index}_${'r'.repeat(600)}`,
      })),
    ];
    record.data.modelExclusions = Array.from({ length: 21 }, (_, index) => ({
      model: index === 0 ? 'BlackScholes' : `Model_${index}_${'m'.repeat(180)}`,
      underlying: `underlying_${index}_${'u'.repeat(180)}`,
      expiration: `expiration_${index}_${'e'.repeat(180)}`,
      reason: index === 0 ? 'calibration_required' : `future_reason_${index}_${'r'.repeat(600)}`,
      dependency: index === 0 ? 'LocalVol-Dupire' : `Dependency_${index}_${'d'.repeat(180)}`,
    }));

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions).toHaveLength(20);
    expect(shaped.aggregateExclusionsNotShown).toBe(1);
    expect(shaped.aggregateExclusions[0]).toEqual({
      model: 'Monte Carlo - Heston', metric: 'Delta', included: null, expected: null,
      reason: 'duplicate source',
    });
    expect(shaped.aggregateExclusions[1]).toEqual(expect.objectContaining({
      model: 'Black-Scholes', included: null, expected: null, reason: 'unstable net portfolio value',
    }));
    expect(shaped.aggregateExclusions[2].reason).toStartWith('future_reason_1_');
    expect(shaped.aggregateExclusions[3].reason).toBe('reason not recorded');
    expect(shaped.modelExclusions).toHaveLength(20);
    expect(shaped.modelExclusionsNotShown).toBe(1);
    expect(shaped.modelExclusions[0]).toEqual(expect.objectContaining({
      model: 'Black-Scholes',
      reason: 'calibration required',
      dependency: 'Local Volatility - Dupire',
    }));
    expect(shaped.modelExclusions[0].underlying).toStartWith('UNDERLYING_0_');
    expect(shaped.modelExclusions[0].expiration).toStartWith('expiration_0_');
    for (const exclusion of [...shaped.aggregateExclusions, ...shaped.modelExclusions]) {
      expect(exclusion.model.length).toBeLessThanOrEqual(128);
      expect(exclusion.reason.length).toBeLessThanOrEqual(500);
      expect(new TextEncoder().encode(JSON.stringify(exclusion.model)).byteLength - 2).toBeLessThanOrEqual(128);
      expect(new TextEncoder().encode(JSON.stringify(exclusion.reason)).byteLength - 2).toBeLessThanOrEqual(500);
      for (const identifier of [exclusion.metric, exclusion.underlying, exclusion.expiration, exclusion.dependency]) {
        if (!identifier) continue;
        expect(identifier.length).toBeLessThanOrEqual(128);
        expect(new TextEncoder().encode(JSON.stringify(identifier)).byteLength - 2).toBeLessThanOrEqual(128);
      }
    }
  });

  test('uses a valid own producer count trio when reporting model exclusions not shown', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.modelExclusions = Array.from({ length: 100 }, (_, index) => ({
      model: `Model${index}`, underlying: 'SPY', expiration: '2026-05-15', reason: `reason_${index}`,
    }));
    Object.assign(record.data.summary, {
      modelExclusionCount: 102,
      includedModelExclusionCount: 100,
      modelExclusionsTruncated: true,
    });

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.modelExclusions).toHaveLength(20);
    expect(shaped.modelExclusionsNotShown).toBe(82);
  });

  test.each([
    ['missing metadata', {}],
    ['partial metadata', { modelExclusionCount: 102 }],
    ['included count disagrees with source', {
      modelExclusionCount: 102, includedModelExclusionCount: 99, modelExclusionsTruncated: true,
    }],
    ['original count is below included', {
      modelExclusionCount: 99, includedModelExclusionCount: 100, modelExclusionsTruncated: false,
    }],
    ['truncation flag contradicts counts', {
      modelExclusionCount: 102, includedModelExclusionCount: 100, modelExclusionsTruncated: false,
    }],
    ['non-finite original count', {
      modelExclusionCount: Number.NaN, includedModelExclusionCount: 100, modelExclusionsTruncated: true,
    }],
    ['non-finite included count', {
      modelExclusionCount: 102, includedModelExclusionCount: Number.POSITIVE_INFINITY, modelExclusionsTruncated: true,
    }],
  ])('falls back to present source length for invalid producer counts: %s', (_label, metadata) => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.modelExclusions = Array.from({ length: 100 }, (_, index) => ({
      model: `Model${index}`, underlying: 'SPY', expiration: '2026-05-15', reason: `reason_${index}`,
    }));
    Object.assign(record.data.summary, metadata);

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.modelExclusions).toHaveLength(20);
    expect(shaped.modelExclusionsNotShown).toBe(80);
  });

  test('rejects inherited producer count metadata', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.modelExclusions = Array.from({ length: 100 }, (_, index) => ({
      model: `Model${index}`, underlying: 'SPY', expiration: '2026-05-15', reason: `reason_${index}`,
    }));
    record.data.summary = Object.assign(Object.create({
      modelExclusionCount: 102,
      includedModelExclusionCount: 100,
      modelExclusionsTruncated: true,
    }), {
      totalPositions: 2,
      engineVersion: '2.0.6',
      inputHash: 'b'.repeat(64),
    });

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.modelExclusionsNotShown).toBe(80);
  });

  test('humanizes only whole safe identifiers while preserving prose, numbers, dates, and model punctuation', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'LocalVol-Dupire', metric: 'Lambda', included: 1, expected: 2,
        complete: false, reason: 'unsafe_net_value',
      },
      {
        model: 'Future-Model--1', metric: 'Delta', included: 1, expected: 2,
        complete: false, reason: 'future_contract_reason',
      },
      {
        model: 'Future_Model_-1', metric: 'Gamma', included: 1, expected: 2,
        complete: false, reason: 'future_contract_reason',
      },
    ];
    record.data.modelExclusions = [
      {
        model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
        reason: 'Exact option chain unavailable for LocalVol-Dupire SPY 2026-05-15',
        dependency: 'BlackScholes',
      },
      ...['value_below_-1', '1e-3', '2026-05-15', '-1', '+1', 'future_contract_reason'].map((reason) => ({
        model: 'Future-Model--1', underlying: 'SPY', expiration: '2026-05-15', reason,
      })),
    ];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions).toEqual([
      {
        model: 'Local Volatility - Dupire', metric: 'Lambda', included: null, expected: null,
        reason: 'unstable net portfolio value',
      },
      {
        model: 'Future-Model--1', metric: 'Delta', included: null, expected: null,
        reason: 'future contract reason',
      },
      {
        model: 'Future_Model_-1', metric: 'Gamma', included: null, expected: null,
        reason: 'future contract reason',
      },
    ]);
    expect(shaped.modelExclusions.map((entry: any) => entry.reason)).toEqual([
      'Exact option chain unavailable for LocalVol-Dupire SPY 2026-05-15',
      'value_below_-1',
      '1e-3',
      '2026-05-15',
      '-1',
      '+1',
      'future contract reason',
    ]);
    expect(shaped.modelExclusions[0].dependency).toBe('Black-Scholes');
    expect(shaped.modelExclusions.slice(1).every((entry: any) => entry.model === 'Future-Model--1')).toBe(true);
  });

  test('treats prototype-named aggregate reasons as unknown values instead of known-label hits', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [
      ['constructor', 'Price'],
      ['toString', 'Delta'],
      ['hasOwnProperty', 'Gamma'],
      ['__proto__', 'Vega'],
    ].map(([reason, metric]) => ({
      model: 'Heston', metric, included: 1, expected: 2, complete: false, reason,
    }));

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions.map((entry: any) => entry.reason)).toEqual([
      'constructor',
      'to string',
      'has own property',
      '__proto__',
    ]);
    expect(shaped.aggregateExclusions.every((entry: any) => entry.reason !== 'reason not recorded')).toBe(true);
  });

  test('withholds impossible canonical aggregate coverage ratios while retaining valid evidence', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'PDE', metric: 'Vanna', included: 1, expected: 2,
        complete: false, reason: 'incomplete_position_coverage',
      },
      {
        model: 'PDE', metric: 'Charm', included: 2, expected: 2,
        complete: false, reason: 'incomplete_position_coverage',
      },
      {
        model: 'PDE', metric: 'Lambda', included: 1, expected: 2,
        complete: false, reason: 'unsafe_net_value',
      },
      {
        model: 'PDE', metric: 'Price', included: 0, expected: 2,
        complete: false, reason: 'invalid_value',
      },
      {
        model: 'PDE', metric: 'Vomma', included: 0, expected: 3,
        complete: false, reason: 'incomplete_position_coverage',
      },
    ];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions.map((entry: any) => ({
      metric: entry.metric,
      included: entry.included,
      expected: entry.expected,
    }))).toEqual([
      { metric: 'Vanna', included: 1, expected: 2 },
      { metric: 'Charm', included: null, expected: null },
      { metric: 'Lambda', included: null, expected: null },
      { metric: 'Price', included: null, expected: null },
      { metric: 'Vomma', included: null, expected: null },
    ]);
  });

  test('does not hide or publish false ratios from malformed current aggregate evidence', () => {
    const record: any = makeRecord();
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 1, expected: 1,
        complete: false, reason: 'duplicate_source',
      },
      {
        model: 'Future_Model', metric: 'FutureMetric', included: 1, expected: 2,
        complete: false, reason: 'future_contract_reason',
      },
    ];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions).toEqual([
      {
        model: 'Monte Carlo - Heston', metric: 'Delta', included: null, expected: null,
        reason: 'duplicate source',
      },
      {
        model: 'Future Model', metric: 'FutureMetric', included: null, expected: null,
        reason: 'future contract reason',
      },
    ]);
  });

  test.each([
    ['control characters', `${'\u0000\u0001\n'.repeat(300)}`],
    ['quotes and slashes', `${'"\\'.repeat(600)}`],
    ['astral characters', '😀'.repeat(600)],
  ])('bounds %s by serialized UTF-8 bytes without producing invalid JSON', (_label, reason) => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.modelExclusions = [{
      model: 'Heston', underlying: 'SPY', expiration: '2026-05-15', reason,
    }];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const bounded = shaped.modelExclusions[0].reason;
    const serialized = JSON.stringify(bounded);

    expect(bounded.length).toBeLessThanOrEqual(500);
    expect(new TextEncoder().encode(serialized).byteLength - 2).toBeLessThanOrEqual(500);
    expect(() => JSON.parse(serialized)).not.toThrow();
    expect(bounded).toEndWith('…');
  });

  test.each([
    ['NaN included', Number.NaN, 2, null, 2],
    ['infinite included', Number.POSITIVE_INFINITY, 2, null, 2],
    ['negative infinite expected', 1, Number.NEGATIVE_INFINITY, 1, null],
  ])('keeps invalid aggregate counts visible as unknown: %s', (_label, included, expected, shapedIncluded, shapedExpected) => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [{
      model: 'Heston', metric: 'Price', included, expected,
      complete: false, reason: 'incomplete_position_coverage',
    }];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.aggregateExclusions[0].included).toBe(shapedIncluded);
    expect(shaped.aggregateExclusions[0].expected).toBe(shapedExpected);
  });

  test.each([
    ['negative included', -1, 2, null, 2],
    ['negative expected', 1, -1, 1, null],
    ['fractional included', 1.5, 2, null, 2],
    ['fractional expected', 1, 2.5, 1, null],
    ['unsafe included', Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER, null, null],
    ['unsafe expected', 1, Number.MAX_SAFE_INTEGER + 1, 1, null],
    ['included exceeds expected', 2, 1, null, null],
    ['zero of zero contradicts current expected count', 0, 0, null, null],
    ['zero of a different expected count', 0, 3, null, null],
    ['complete coverage contradicts an incomplete reason', 3, 3, null, null],
  ])(
    'keeps aggregate coverage counts honest for %s',
    (_label, included, expected, shapedIncluded, shapedExpected) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.portfolioAggregates.exclusions = [{
        model: 'Heston', metric: 'Price', included, expected,
        complete: false, reason: 'incomplete_position_coverage',
      }];

      const shaped = shapeComputeRunRecord(record) as Record<string, any>;

      expect(shaped.aggregateExclusions).toHaveLength(1);
      expect(shaped.aggregateExclusions[0].included).toBe(shapedIncluded);
      expect(shaped.aggregateExclusions[0].expected).toBe(shapedExpected);
    },
  );

  test('supports current variant-based models and trims calibration params', () => {
    const shaped = shapeComputeRunRecord({
      run_key: 'current-run',
      scope: 'core',
      quality: 'balanced',
      status: 'completed',
      timestamp: 1774771200000,
      data: {
        syncSchemaVersion: 2,
        runSchemaVersion: 2,
        summary: {
          engineVersion: '2.0.6',
          inputHash: 'c'.repeat(64),
          totalPositions: 1,
          totalModelRuns: 2,
          modelExclusionCount: 0,
          includedModelExclusionCount: 0,
          modelExclusionsTruncated: false,
        },
        underlyings: ['AAPL'],
        errors: [],
        modelExclusions: [],
        projection: {
          schemaVersion: 2,
          compactionLevel: 'none',
          originalPositionCount: 1,
          includedPositionCount: 1,
          positionsTruncated: false,
          variantsTruncated: false,
          exposureTruncated: false,
          calibrationTruncated: false,
          earlyExercisePremiumTruncated: false,
          portfolioAggregatesTruncated: false,
        },
      },
      positions: [
        {
          positionId: 'current-pos',
          symbol: '',
          underlying: 'AAPL',
          isCall: true,
          strike: 200,
          expiration: '2026-05-08',
          daysToExpiry: 40,
          spot: 210.25,
          iv: 0.31,
          quantity: 1,
          multiplier: 100,
          marketPrice: 5.12,
          riskFreeRate: 0.043,
          dividendYield: 0.01,
          models: {
            SABR: {
              variants: [
                {
                  price: { value: 5.123456789 },
                  greeks: {
                    Delta: { value: 0.5432109, stdError: 0.00234 },
                    Gamma: { value: 0.0212345 },
                  },
                  dimensions: { exerciseStyle: 'european' },
                },
                {
                  price: { value: 5.4 },
                  greeks: {
                    Delta: { value: 0.5 },
                  },
                  dimensions: { exerciseStyle: 'american' },
                },
              ],
              calibration: {
                rmse: 0.123456789,
                confidence: 88.98765,
                confidenceSemantics: {
                  label: 'model-specific calibration quality score',
                  method: 'sabr-quality-v1',
                  scale: '0-100 points',
                  crossModelComparable: false,
                },
                isFallback: false,
                expirationDate: '2026-05-08',
                params: {
                  alpha: 1.23456789,
                  beta: 0.5,
                  seed: 12345,
                  enabled: true,
                  timestamp: '2026-03-29T07:18:38.387Z',
                  nested: { score: 99 },
                },
              },
            },
          },
        },
      ],
    }) as Record<string, any>;

    expect(shaped.positions[0].symbol).toBe('AAPL');
    expect(shaped.positions[0].models.SABR.variantCount).toBe(2);
    expect(shaped.positions[0].models.SABR.alternateCount).toBe(1);
    expect(shaped.positions[0].models.SABR.price).toBe(5.123457);
    expect(shaped.positions[0].models.SABR.greeks).toEqual({
      Delta: { value: 0.543211, stdError: 0.00234 },
      Gamma: 0.021234,
    });
    expect(shaped.positions[0].models.SABR.dimensions).toEqual({ exerciseStyle: 'european' });
    expect(shaped.positions[0].models.SABR.calibrationSummary.params).toEqual({
      alpha: 1.234568,
      beta: 0.5,
      enabled: true,
      timestamp: '2026-03-29T07:18:38.387Z',
    });
    expect(shaped.positions[0].models.SABR.calibrationSummary.params.nested).toBeUndefined();
    expect(shaped.positions[0].models.SABR.calibrationSummary.confidence).toBe(88.9877);
    expect(shaped.positions[0].models.SABR.calibrationSummary.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'sabr-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
  });

  test('emits a prose fallback status in compact model summaries', () => {
    const record = makeRecord();
    (record.positions[0].models as any).Heston.calibration.isFallback = true;
    (record.positions[0].models as any).Heston.calibration.failureReason = 'insufficient_surface';

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.positions[1].models.Heston.calibrationSummary.isFallback).toBeUndefined();
    expect(shaped.positions[1].models.Heston.calibrationSummary.fallback).toBeUndefined();
    expect(shaped.positions[1].models.Heston.calibrationSummary.status).toBe('fallback (default parameters)');
    expect(shaped.positions[1].models.Heston.calibrationSummary.statusReason).toBe('insufficient surface');
    expect(shaped.positions[1].models.Heston.calibrationSummary.fallbackReason).toBeUndefined();
    expect(shaped.positions[1].models.Heston.calibrationSummary.failureReason).toBeUndefined();
  });

  test('does not interpret obsolete fallbackReason in compact model summaries', () => {
    const record = makeRecord();
    const calibration = (record.positions[0].models as any).Heston.calibration;
    calibration.isFallback = true;
    delete calibration.failureReason;
    calibration.fallbackReason = 'legacy_surface_failure';

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;
    const summary = shaped.positions[1].models.Heston.calibrationSummary;

    expect(summary.status).toBe('fallback (default parameters)');
    expect(summary.statusReason).toBeUndefined();
    expect(summary.fallbackReason).toBeUndefined();
  });

  test('preserves an explicit zero current variant total', () => {
    const record: any = makeRecord();
    record.positions = [{
      ...(record.positions as Array<Record<string, unknown>>)[0],
      models: {
        Empty: {
          variantCount: 0,
          variants: [],
          variantsTruncated: false,
        },
      },
    }];

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.positions[0].models.Empty.variantCount).toBe(0);
    expect(shaped.positions[0].models.Empty.variantsTruncated).toBe(false);
  });
});

describe('recordMatchesComputeFilters', () => {
  test('matches exact run and underlying filters', () => {
    const record = makeRecord();
    expect(recordMatchesComputeFilters(record, { runKey: 'run-123' })).toBe(true);
    expect(recordMatchesComputeFilters(record, { runKey: 'other' })).toBe(false);
    expect(recordMatchesComputeFilters(record, { underlying: 'qqq' })).toBe(true);
    expect(recordMatchesComputeFilters(record, { underlying: 'iwm' })).toBe(false);
  });

  test('trusts v2 explicit underlyings before the compacted position subset', () => {
    const record = makeRecord();
    (record.data as Record<string, unknown>).underlyings = ['QQQ'];

    expect(recordMatchesComputeFilters(record, { underlying: 'qqq' })).toBe(true);
    expect(recordMatchesComputeFilters(record, { underlying: 'spy' })).toBe(false);
  });

  test('does not expand v2 authoritative underlyings from calibration outcomes', () => {
    const record = makeRecord();
    (record.data as Record<string, unknown>).underlyings = ['QQQ'];
    (record.data as Record<string, unknown>).calibrationOutcomes = [{
      model: 'Heston',
      underlying: 'IWM',
      expiration: '2026-05-15',
      status: 'success',
    }];

    expect(recordMatchesComputeFilters(record, { underlying: 'qqq' })).toBe(true);
    expect(recordMatchesComputeFilters(record, { underlying: 'iwm' })).toBe(false);
  });
});

describe('sanitizeComputeRunsWireOutput', () => {
  function makeCanonicalSanitizerRecord() {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.exclusions = [{
      model: 'BlackScholes', metric: 'Price', included: 1, expected: 2,
      complete: false, reason: 'incomplete_position_coverage',
    }];
    record.data.modelExclusions = [{
      model: 'LocalVol-Dupire', underlying: 'SPY', expiration: '2026-05-15',
      reason: 'exact_chain_required',
    }];
    return record;
  }

  test('humanizes full-mode exposure levels and removes raw isFallback booleans', () => {
    const payload = { data: [makeRecord()] };
    (payload.data[0] as any).data.portfolioAggregates.excluded = { byReason: { missingIv: 2 } };
    (payload.data[0].positions[0].models as any).Heston.calibration.fallback = true;
    (payload.data[0].positions[0].models as any).Heston.calibration.status = 'fallback (default parameters)';
    (payload.data[0].positions[0].models as any).Heston.calibration.statusReason = 'insufficient surface';
    (payload.data[0].positions[0].models as any).Heston.calibration.failureReason = 'insufficient_surface';
    (payload.data[0].positions[0].models as any).Heston.calibration.seedRejections = [{ reason: 'bad_seed' }];
    (payload.data[0].positions[0].models as any).Heston.calibration.executionPath = 'worker';
    (payload.data[0].positions[0].models as any).Heston.calibration.economicPenalty = 1.25;

    sanitizeComputeRunsWireOutput(payload);

    const text = JSON.stringify(payload);
    expect(payload.data[0].data.portfolioAggregates).toBeUndefined();
    expect(text).not.toContain('BlackScholes');
    expect(text).toContain('Black-Scholes');
    expect(text).not.toContain('fallbackReason');
    expect(text).not.toContain('failureReason');
    expect(text).not.toContain('"seed"');
    expect(text).not.toContain('seedRejections');
    expect(text).not.toContain('executionPath');
    expect(text).not.toContain('economicPenalty');
    expect(text).not.toContain('byReason');
    expect(text).not.toContain('callWall');
    expect(text).not.toContain('putWall');
    expect(text).not.toContain('gammaFlip');
    expect(text).not.toContain('gammaTilt');
    expect(text).not.toContain('secondaryFlips');
    expect(text).not.toContain('isFallback');
    expect(text).not.toContain('"key"');
    expect(text).not.toContain('keyLevels');

    const levels = (payload.data[0].data.exposureSweep[0] as any).levels;
    expect(levels['call wall']).toBe(650);
    expect(levels['put wall']).toBe(620);
    expect(levels['gamma flip']).toBe(645.9);
    expect(levels['gamma tilt']).toBe(-1);
    expect(levels['secondary flips']).toEqual([]);

    const hestonCalibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(hestonCalibration.confidence).toBe(0.94);
    expect(hestonCalibration.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
    expect(hestonCalibration.isFallback).toBeUndefined();
    expect(hestonCalibration.fallback).toBeUndefined();
    expect(hestonCalibration.status).toBe('fallback (default parameters)');
    expect(hestonCalibration.statusReason).toBe('insufficient surface');
    expect(hestonCalibration.fallbackReason).toBeUndefined();
    expect(hestonCalibration.failureReason).toBeUndefined();
    expect(hestonCalibration.seedRejections).toBeUndefined();
    expect(hestonCalibration.executionPath).toBeUndefined();
    expect(hestonCalibration.economicPenalty).toBeUndefined();
  });

  test('preserves distinct confidence semantics in full-mode shaping', () => {
    const record: any = makeRecord();
    record.positions[0].models.Heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
      internalFormula: 'do not expose',
    };
    record.positions[0].models.SABR = {
      calibration: {
        params: {},
        rmse: 0.02,
        confidence: 87,
        isFallback: false,
        expirationDate: '2026-03-30',
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'sabr-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
          internalFormula: 'do not expose',
        },
      },
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const models = (payload.data[0].positions[0].models as any);
    expect(models.Heston.calibration.confidence).toBe(0.94);
    expect(models.Heston.calibration.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
    expect(models.SABR.calibration.confidence).toBe(87);
    expect(models.SABR.calibration.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'sabr-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
  });

  test('preserves valid exact 2.0.6 JD/VG pairs and MC-JD null in full-mode sanitization', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models.JumpDiffusion = calibrationModel(
      72,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    );
    record.positions[0].models.VarianceGamma = calibrationModel(
      83,
      exactCalibrationSemantics('variance-gamma-quality-v1'),
    );
    record.positions[0].models['MonteCarlo-JumpDiffusion'] = calibrationModel(null);
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const models = payload.data[0].positions[0].models as any;
    expect(models['Jump Diffusion'].calibration).toMatchObject({
      confidence: 72,
      confidenceSemantics: exactCalibrationSemantics('unified-jump-selection-v1'),
    });
    expect(models['Variance Gamma'].calibration).toMatchObject({
      confidence: 83,
      confidenceSemantics: exactCalibrationSemantics('variance-gamma-quality-v1'),
    });
    expect(models['Monte Carlo - Jump Diffusion'].calibration.confidence).toBeNull();
    expect(models['Monte Carlo - Jump Diffusion'].calibration).not.toHaveProperty('confidenceSemantics');
  });

  test.each([
    ['Heston', 'Heston'],
    ['SABR', 'SABR'],
    ['MonteCarlo-Heston', 'Monte Carlo - Heston'],
    ['JumpDiffusion', 'Jump Diffusion'],
    ['VarianceGamma', 'Variance Gamma'],
    ['MonteCarlo-JumpDiffusion', 'Monte Carlo - Jump Diffusion'],
  ] as const)(
    'preserves producer-valid strict %s null confidence without semantics in full mode',
    (backendModelId, displayModelId) => {
      const record: any = makeRecord();
      record.positions[0].models = {
        [backendModelId]: calibrationModel(null),
      };
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const calibration = payload.data[0].positions[0].models[displayModelId].calibration;
      expect(calibration).toHaveProperty('confidence', null);
      expect(calibration).not.toHaveProperty('confidenceSemantics');
    },
  );

  test('withholds malformed strict 2.0.6 JD/VG/MC-JD facts in full-mode sanitization', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models.JumpDiffusion = calibrationModel(72);
    record.positions[0].models.VarianceGamma = calibrationModel(
      83,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    );
    record.positions[0].models['MonteCarlo-JumpDiffusion'] = calibrationModel(64);
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const models = payload.data[0].positions[0].models as any;
    for (const modelName of [
      'Jump Diffusion',
      'Variance Gamma',
      'Monte Carlo - Jump Diffusion',
    ]) {
      expect(models[modelName].calibration, modelName).not.toHaveProperty('confidence');
      expect(models[modelName].calibration, modelName).not.toHaveProperty('confidenceSemantics');
    }
  });

  test.each([
    ['label', { label: 'wrong label' }],
    ['method', { method: 'variance-gamma-quality-v1' }],
    ['scale', { scale: 'percent' }],
    ['crossModelComparable', { crossModelComparable: true }],
  ] as const)(
    'withholds full-mode JD confidence when exact semantics %s is mutated',
    (_field, mutation) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.summary.engineVersion = '2.0.6';
      record.positions[0].models = {
        JumpDiffusion: calibrationModel(72, {
          ...exactCalibrationSemantics('unified-jump-selection-v1'),
          ...mutation,
        } as any),
      };
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const calibration = payload.data[0].positions[0].models['Jump Diffusion'].calibration;
      expect(calibration).not.toHaveProperty('confidence');
      expect(calibration).not.toHaveProperty('confidenceSemantics');
    },
  );

  test('withholds strict MC-JD null confidence when orphan semantics are present', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models = {
      'MonteCarlo-JumpDiffusion': calibrationModel(
        null,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ),
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const calibration = payload.data[0].positions[0]
      .models['Monte Carlo - Jump Diffusion'].calibration;
    expect(calibration).not.toHaveProperty('confidence');
    expect(calibration).not.toHaveProperty('confidenceSemantics');
  });

  test.each([
    ['Jump Diffusion', 72, exactCalibrationSemantics('unified-jump-selection-v1')],
    ['Variance Gamma', 83, exactCalibrationSemantics('variance-gamma-quality-v1')],
    ['Monte Carlo - Jump Diffusion', 64, undefined],
  ] as const)(
    'withholds strict 2.0.6 confidence facts from raw exact display model id %s in full mode',
    (displayModelId, confidence, semantics) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.summary.engineVersion = '2.0.6';
      record.positions[0].models = {
        [displayModelId]: calibrationModel(confidence, semantics),
      };
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const calibration = payload.data[0].positions[0].models[displayModelId].calibration;
      expect(calibration).not.toHaveProperty('confidence');
      expect(calibration).not.toHaveProperty('confidenceSemantics');
    },
  );

  test('preserves valid strict JD/VG facts when full-mode sanitization repeats on the same row', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models = {
      JumpDiffusion: calibrationModel(
        72,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ),
      VarianceGamma: calibrationModel(
        83,
        exactCalibrationSemantics('variance-gamma-quality-v1'),
      ),
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);
    sanitizeComputeRunsWireOutput(payload);

    const models = payload.data[0].positions[0].models as any;
    expect(models['Jump Diffusion'].calibration).toMatchObject({
      confidence: 72,
      confidenceSemantics: exactCalibrationSemantics('unified-jump-selection-v1'),
    });
    expect(models['Variance Gamma'].calibration).toMatchObject({
      confidence: 83,
      confidenceSemantics: exactCalibrationSemantics('variance-gamma-quality-v1'),
    });
  });

  test('does not transfer display-id trust when a sanitized row receives a replacement models map', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions[0].models = {
      JumpDiffusion: calibrationModel(
        72,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ),
    };
    const payload = { data: [record] };
    sanitizeComputeRunsWireOutput(payload);
    const sanitizedModel = record.positions[0].models['Jump Diffusion'];
    record.positions[0].models = { 'Jump Diffusion': sanitizedModel };

    sanitizeComputeRunsWireOutput(payload);

    expect(sanitizedModel.calibration).not.toHaveProperty('confidence');
    expect(sanitizedModel.calibration).not.toHaveProperty('confidenceSemantics');
  });

  test('invalidates display-id trust when a sanitized row changes input identity', () => {
    const record: any = makeRecord();
    record.positions[0].models = {
      JumpDiffusion: calibrationModel(
        72,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ),
    };
    const payload = { data: [record] };
    sanitizeComputeRunsWireOutput(payload);
    const calibration = record.positions[0].models['Jump Diffusion'].calibration;
    record.data.summary.inputHash = 'd'.repeat(64);

    sanitizeComputeRunsWireOutput(payload);

    expect(calibration).not.toHaveProperty('confidence');
    expect(calibration).not.toHaveProperty('confidenceSemantics');
  });

  test('applies enclosing strictness to data.positions even when an empty top-level positions array shadows it', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.positions = [];
    record.data.positions = [{
      models: {
        JumpDiffusion: calibrationModel(72),
      },
    }];
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const calibration = payload.data[0].data.positions[0]
      .models['Jump Diffusion'].calibration;
    expect(calibration).not.toHaveProperty('confidence');
    expect(calibration).not.toHaveProperty('confidenceSemantics');
  });

  test('propagates enclosing strictness to every nested models map in full output', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.data.shadow = {
      nested: {
        models: {
          VarianceGamma: calibrationModel(83),
        },
      },
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const calibration = payload.data[0].data.shadow.nested.models['Variance Gamma'].calibration;
    expect(calibration).not.toHaveProperty('confidence');
    expect(calibration).not.toHaveProperty('confidenceSemantics');
  });

  test('sanitizes calibration facts inside a malformed current models array', () => {
      const record: any = makeRecord();
      record.positions[0].models = [{
        model: 'JumpDiffusion',
        calibration: calibrationModel(72).calibration,
      }];
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const calibration = payload.data[0].positions[0].models[0].calibration;
      expect(calibration).not.toHaveProperty('confidence');
      expect(calibration).not.toHaveProperty('confidenceSemantics');
  });

  test.each([
    ['mismatched method', 'JumpDiffusion', 72, exactCalibrationSemantics('variance-gamma-quality-v1')],
    ['display model id', 'Jump Diffusion', 72, exactCalibrationSemantics('unified-jump-selection-v1')],
  ] as const)(
    'withholds strict calibrationOutcomes detail for %s',
    (_shape, model, confidence, confidenceSemantics) => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.summary.engineVersion = '2.0.6';
      record.data.calibrationOutcomes = [{
        model,
        detail: calibrationModel(confidence, confidenceSemantics).calibration,
      }];
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const detail = payload.data[0].data.calibrationOutcomes[0].detail;
      expect(detail).not.toHaveProperty('confidence');
      expect(detail).not.toHaveProperty('confidenceSemantics');
    },
  );

  test('preserves a valid canonical strict calibrationOutcome pair across repeated full sanitization', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.data.calibrationOutcomes = [{
      model: 'JumpDiffusion',
      detail: calibrationModel(
        72,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ).calibration,
    }];
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);
    sanitizeComputeRunsWireOutput(payload);

    expect(payload.data[0].data.calibrationOutcomes[0].detail).toMatchObject({
      confidence: 72,
      confidenceSemantics: exactCalibrationSemantics('unified-jump-selection-v1'),
    });
  });

  test('default-denies unbound calibration confidence and injected calibrationSummary confidence in strict rows', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    record.data.shadow = {
      calibration: calibrationModel(
        72,
        exactCalibrationSemantics('unified-jump-selection-v1'),
      ).calibration,
      models: {
        JumpDiffusion: {
          calibrationSummary: calibrationModel(
            72,
            exactCalibrationSemantics('unified-jump-selection-v1'),
          ).calibration,
        },
      },
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const unbound = payload.data[0].data.shadow.calibration;
    const injectedSummary = payload.data[0].data.shadow.models['Jump Diffusion'].calibrationSummary;
    for (const calibration of [unbound, injectedSummary]) {
      expect(calibration).not.toHaveProperty('confidence');
      expect(calibration).not.toHaveProperty('confidenceSemantics');
    }
  });

  test('lets an invalid unbound alias win when it shares a calibration object with a valid model context', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.summary.engineVersion = '2.0.6';
    const sharedCalibration = calibrationModel(
      72,
      exactCalibrationSemantics('unified-jump-selection-v1'),
    ).calibration;
    record.positions[0].models = {
      JumpDiffusion: { calibration: sharedCalibration },
    };
    record.data.shadow = { calibration: sharedCalibration };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    expect(sharedCalibration).not.toHaveProperty('confidence');
    expect(sharedCalibration).not.toHaveProperty('confidenceSemantics');
  });

  test('withholds a noncanonical MC-JD alias in current full mode', () => {
    const sanitizeAlias = () => {
      const record: any = makeRecord();
      record.positions[0].models['Monte Carlo Jump Diffusion_'] = calibrationModel(64);
      const payload = { data: [record] };
      sanitizeComputeRunsWireOutput(payload);
      return (payload.data[0].positions[0].models as any)
        ['Monte Carlo Jump Diffusion'].calibration as Record<string, unknown>;
    };

    const current = sanitizeAlias();
    expect(current).not.toHaveProperty('confidence');
    expect(current).not.toHaveProperty('confidenceSemantics');
  });

  test('preserves valid Monte Carlo Heston confidence semantics when full-mode shaping is repeated', () => {
    const record: any = makeRecord();
    record.positions[0].models['MonteCarlo-Heston'] = {
      calibration: {
        confidence: 91,
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'heston-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
      },
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);
    sanitizeComputeRunsWireOutput(payload);

    const calibration = (payload.data[0].positions[0].models as any)
      ['Monte Carlo - Heston'].calibration;
    expect(calibration.confidence).toBe(91);
    expect(calibration.confidenceSemantics).toEqual({
      label: 'model-specific calibration quality score',
      method: 'heston-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    });
  });

  test('withholds an unsupported known-model confidence pair from a current full response', () => {
    const record: any = makeRecord();
    record.positions[0].models.Heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'unsupported-method',
      scale: '0-100 points',
      crossModelComparable: false,
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const calibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(calibration.confidence).toBeUndefined();
    expect(calibration.confidenceSemantics).toBeUndefined();
  });

  test.each(['Monte Carlo - Heston', 'Monte Carlo Heston', 'MonteCarlo_Heston'])(
    'withholds confidence from protected noncanonical current model alias %s in full mode',
    (modelAlias) => {
      const record: any = makeRecord();
      const model = record.positions[0].models.Heston;
      delete record.positions[0].models.Heston;
      model.calibration.confidence = 87;
      model.calibration.confidenceSemantics = {
        label: 'model-specific calibration quality score',
        method: 'heston-quality-v1',
        scale: '0-100 points',
        crossModelComparable: false,
      };
      record.positions[0].models[modelAlias] = model;
      const payload = { data: [record] };

      sanitizeComputeRunsWireOutput(payload);

      const calibration = Object.values(payload.data[0].positions[0].models)
        .map((entry: any) => entry.calibration)
        .find(Boolean) as Record<string, unknown>;
      expect(calibration.confidence).toBeUndefined();
      expect(calibration.confidenceSemantics).toBeUndefined();
    },
  );

  test('drops mismatched and out-of-range confidence semantics in full mode after model relabeling', () => {
    const record: any = makeRecord();
    const hestonModel = record.positions[0].models.Heston;
    delete record.positions[0].models.Heston;
    record.positions[0].models.heston = hestonModel;
    record.positions[0].models.heston.calibration.confidenceSemantics = {
      label: 'model-specific calibration quality score',
      method: 'sabr-quality-v1',
      scale: '0-100 points',
      crossModelComparable: false,
    };
    record.positions[0].models.SABR = {
      calibration: {
        confidence: 101,
        confidenceSemantics: {
          label: 'model-specific calibration quality score',
          method: 'sabr-quality-v1',
          scale: '0-100 points',
          crossModelComparable: false,
        },
      },
    };
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    const models = (payload.data[0].positions[0].models as any);
    expect(models.Heston.calibration.confidence).toBeUndefined();
    expect(models.Heston.calibration.confidenceSemantics).toBeUndefined();
    expect(models.SABR.calibration.confidence).toBeUndefined();
    expect(models.SABR.calibration.confidenceSemantics).toBeUndefined();
  });

  test('preserves fallback context in full-mode sanitizer while dropping raw internals', () => {
    const payload = { data: [makeRecord()] };
    (payload.data[0].positions[0].models as any).Heston.calibration.isFallback = true;
    (payload.data[0].positions[0].models as any).Heston.calibration.fallback = true;
    (payload.data[0].positions[0].models as any).Heston.calibration.status = 'fallback';
    (payload.data[0].positions[0].models as any).Heston.calibration.statusReason = 'insufficient surface';
    (payload.data[0].positions[0].models as any).Heston.calibration.failureReason = 'insufficient_surface';

    sanitizeComputeRunsWireOutput(payload);

    const hestonCalibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(hestonCalibration.isFallback).toBeUndefined();
    expect(hestonCalibration.fallback).toBeUndefined();
    expect(hestonCalibration.status).toBe('fallback (default parameters)');
    expect(hestonCalibration.statusReason).toBe('insufficient surface');
    expect(hestonCalibration.fallbackReason).toBeUndefined();
    expect(hestonCalibration.failureReason).toBeUndefined();
  });

  test('does not interpret obsolete fallback aliases in the recursive sanitizer', () => {
    const payload = { data: [makeRecord()] };
    const calibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    calibration.isFallback = false;
    calibration.fallback = true;
    calibration.fallbackReason = 'legacy_surface_failure';
    delete calibration.failureReason;

    sanitizeComputeRunsWireOutput(payload);

    const hestonCalibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(hestonCalibration.status).toBeUndefined();
    expect(hestonCalibration.statusReason).toBeUndefined();
    expect(hestonCalibration.fallback).toBeUndefined();
    expect(hestonCalibration.fallbackReason).toBeUndefined();
  });

  test('drops non-fallback statusReason values from full-mode payloads', () => {
    const payload = { data: [makeRecord()] };
    (payload.data[0].positions[0].models as any).Heston.calibration.status = 'completed';
    (payload.data[0].positions[0].models as any).Heston.calibration.statusReason = 'internal_diag: seed search exhausted';

    sanitizeComputeRunsWireOutput(payload);

    const hestonCalibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(hestonCalibration.status).toBe('completed');
    expect(hestonCalibration.statusReason).toBeUndefined();
  });

  test('drops statusReason from fallback rows when no humanizable reason is available', () => {
    const payload = { data: [makeRecord()] };
    // isFallback=true triggers the fallback branch, but with both reason
    // fields non-humanizable (empty / non-string), the sanitizer can't produce
    // a user-facing reason and must drop the field rather than leave the raw
    // value visible.
    (payload.data[0].positions[0].models as any).Heston.calibration.isFallback = true;
    (payload.data[0].positions[0].models as any).Heston.calibration.statusReason = '';
    (payload.data[0].positions[0].models as any).Heston.calibration.failureReason = null;

    sanitizeComputeRunsWireOutput(payload);

    const hestonCalibration = (payload.data[0].positions[0].models as any).Heston.calibration;
    expect(hestonCalibration.status).toBe('fallback (default parameters)');
    expect(hestonCalibration.statusReason).toBeUndefined();
    expect(hestonCalibration.fallbackReason).toBeUndefined();
    expect(hestonCalibration.failureReason).toBeUndefined();
    expect(hestonCalibration.isFallback).toBeUndefined();
  });

  test('lifts bounded canonical completion reasons before full-mode aggregate removal', () => {
    const record: any = makeRecord();
    record.data.runSchemaVersion = 2;
    record.data.portfolioAggregates.excluded = { models: ['BlackScholes'] };
    record.data.portfolioAggregates.exclusions = [
      {
        model: 'MonteCarlo-Heston', metric: 'Delta', included: 2, expected: 2,
        complete: false, reason: 'duplicate_source',
      },
      {
        model: 'BlackScholes', metric: 'Price', included: 1, expected: 2,
        complete: false, reason: 'invalid_value',
      },
    ];
    record.data.modelExclusions = [{
      model: 'LocalVol-Dupire',
      underlying: 'spy',
      expiration: '2026-05-15',
      reason: 'exact_chain_required',
    }];
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);

    expect(payload.data[0].aggregateExclusions).toEqual([{
      model: 'Black-Scholes', metric: 'Price', included: 1, expected: 2,
      reason: 'non-finite aggregate value',
    }]);
    expect(payload.data[0].modelExclusions).toEqual([{
      model: 'Local Volatility - Dupire', underlying: 'SPY', expiration: '2026-05-15',
      reason: 'exact chain required',
    }]);
    expect(payload.data[0].dispersionExclusions).toBeUndefined();
    expect(payload.data[0].data.portfolioAggregates).toBeUndefined();
    expect(payload.data[0].data.modelExclusions).toBeUndefined();
    const text = JSON.stringify(payload);
    expect(text).not.toContain('duplicate_source');
    expect(text).not.toContain('invalid_value');
    expect(text).not.toContain('exact_chain_required');
  });

  test('keeps explicit canonical empty reason arrays in full mode', () => {
    const canonical: any = makeRecord();
    canonical.data.runSchemaVersion = 2;
    canonical.data.portfolioAggregates.exclusions = [];
    canonical.data.modelExclusions = [];
    const payload = { data: [canonical] };

    sanitizeComputeRunsWireOutput(payload);

    expect(payload.data[0].aggregateExclusions).toEqual([]);
    expect(payload.data[0].modelExclusions).toEqual([]);
  });

  test('removes untrusted assistant fields from every object before assigning strict canonical values', () => {
    const spoof = {
      aggregateExclusions: [{ model: 'SPOOFED AGGREGATE' }],
      aggregateExclusionsNotShown: 999,
      modelExclusions: [{ model: 'SPOOFED MODEL' }],
      modelExclusionsNotShown: 999,
    };
    const canonical = Object.assign(makeCanonicalSanitizerRecord(), structuredClone(spoof));
    const missingData: any = { ...structuredClone(spoof) };
    const nullData: any = { ...structuredClone(spoof), data: null };
    const scalarData: any = { ...structuredClone(spoof), data: 'not an object' };
    const nestedSpoof: any = { ...structuredClone(spoof), child: { ...structuredClone(spoof) } };
    const payload: any = {
      ...structuredClone(spoof),
      data: [canonical, missingData, nullData, scalarData, nestedSpoof],
    };

    sanitizeComputeRunsWireOutput(payload);

    expect(payload.aggregateExclusions).toBeUndefined();
    expect(payload.aggregateExclusionsNotShown).toBeUndefined();
    expect(payload.modelExclusions).toBeUndefined();
    expect(payload.modelExclusionsNotShown).toBeUndefined();
    expect(canonical.aggregateExclusions[0].model).toBe('Black-Scholes');
    expect(canonical.modelExclusions[0].model).toBe('Local Volatility - Dupire');
    for (const candidate of [missingData, nullData, scalarData, nestedSpoof, nestedSpoof.child]) {
      expect(candidate.aggregateExclusions).toBeUndefined();
      expect(candidate.aggregateExclusionsNotShown).toBeUndefined();
      expect(candidate.modelExclusions).toBeUndefined();
      expect(candidate.modelExclusionsNotShown).toBeUndefined();
    }
  });

  test('sanitizes deeply nested runs and raw fields without a bypassable depth cutoff', () => {
    const payload: any = {};
    let cursor = payload;
    for (let depth = 0; depth < 30; depth += 1) {
      cursor.child = {};
      cursor = cursor.child;
    }
    const nestedRun = makeCanonicalSanitizerRecord();
    cursor.nestedRun = nestedRun;
    cursor.raw = {
      aggregateExclusions: [{ model: 'DEEP SPOOF' }],
      aggregateExclusionsNotShown: 999,
      modelExclusions: [{ model: 'DEEP MODEL SPOOF' }],
      modelExclusionsNotShown: 999,
      executionPath: 'deep-worker',
      seedRejections: [{ reason: 'deep-seed' }],
      key: 'deep-key',
    };

    sanitizeComputeRunsWireOutput(payload);

    expect(nestedRun.aggregateExclusions[0].model).toBe('Black-Scholes');
    expect(nestedRun.modelExclusions[0].model).toBe('Local Volatility - Dupire');
    expect(nestedRun.data.portfolioAggregates).toBeUndefined();
    expect(nestedRun.data.modelExclusions).toBeUndefined();
    expect(cursor.raw.aggregateExclusions).toBeUndefined();
    expect(cursor.raw.aggregateExclusionsNotShown).toBeUndefined();
    expect(cursor.raw.modelExclusions).toBeUndefined();
    expect(cursor.raw.modelExclusionsNotShown).toBeUndefined();
    expect(cursor.raw.executionPath).toBeUndefined();
    expect(cursor.raw.seedRejections).toBeUndefined();
    expect(cursor.raw.key).toBeUndefined();
  });

  test('is cycle-safe and removes spoofed fields inside cyclic graphs', () => {
    const payload: any = {
      aggregateExclusions: [{ model: 'SPOOF' }],
      modelExclusions: [{ model: 'SPOOF' }],
    };
    payload.self = payload;
    payload.child = { parent: payload, aggregateExclusionsNotShown: 999, modelExclusionsNotShown: 999 };

    expect(() => sanitizeComputeRunsWireOutput(payload)).not.toThrow();
    expect(payload.aggregateExclusions).toBeUndefined();
    expect(payload.modelExclusions).toBeUndefined();
    expect(payload.child.aggregateExclusionsNotShown).toBeUndefined();
    expect(payload.child.modelExclusionsNotShown).toBeUndefined();
  });

  test('preserves trusted lifted fields across a second sanitizer call', () => {
    const record = makeCanonicalSanitizerRecord();
    const payload = { data: [record] };

    sanitizeComputeRunsWireOutput(payload);
    const firstAggregate = structuredClone(record.aggregateExclusions);
    const firstModels = structuredClone(record.modelExclusions);
    record.aggregateExclusions = [{ model: 'SECOND-CALL SPOOF' }];
    record.modelExclusions = [{ model: 'SECOND-CALL SPOOF' }];
    sanitizeComputeRunsWireOutput(payload);

    expect(record.aggregateExclusions).toEqual(firstAggregate);
    expect(record.modelExclusions).toEqual(firstModels);
  });

  test('discovers strict v2 projections before mutation in both record-and-data sibling orders', () => {
    for (const recordFirst of [true, false]) {
      const record = makeCanonicalSanitizerRecord();
      const payload: any = recordFirst
        ? { record, alias: record.data }
        : { alias: record.data, record };

      sanitizeComputeRunsWireOutput(payload);

      expect(record.aggregateExclusions?.[0]?.model).toBe('Black-Scholes');
      expect(record.modelExclusions?.[0]?.model).toBe('Local Volatility - Dupire');
      expect(record.data.portfolioAggregates).toBeUndefined();
      expect(record.data.modelExclusions).toBeUndefined();
    }
  });

  test('preserves trusted fields for repeated runs and distinct runs sharing canonical data', () => {
    const repeated = makeCanonicalSanitizerRecord();
    const sharedData = makeCanonicalSanitizerRecord().data;
    const first: any = { status: 'completed', data: sharedData };
    const second: any = { status: 'completed', data: sharedData };
    const payload = { data: [repeated, repeated, first, second] };

    sanitizeComputeRunsWireOutput(payload);

    for (const record of [repeated, first, second]) {
      expect(record.aggregateExclusions[0].model).toBe('Black-Scholes');
      expect(record.modelExclusions[0].model).toBe('Local Volatility - Dupire');
    }
    expect(first.data).toBe(second.data);
    expect(first.data.portfolioAggregates).toBeUndefined();
    expect(first.data.modelExclusions).toBeUndefined();
  });

  test('does not transfer record trust to a new source-absent run sharing previously sanitized data', () => {
    const original = makeCanonicalSanitizerRecord();
    sanitizeComputeRunsWireOutput({ data: [original] });
    const newRun: any = {
      data: original.data,
      aggregateExclusions: [{ model: 'INHERITED AGGREGATE' }],
      modelExclusions: [{ model: 'INHERITED MODEL' }],
    };

    sanitizeComputeRunsWireOutput({ data: [newRun] });

    expect(newRun.aggregateExclusions).toBeUndefined();
    expect(newRun.aggregateExclusionsNotShown).toBeUndefined();
    expect(newRun.modelExclusions).toBeUndefined();
    expect(newRun.modelExclusionsNotShown).toBeUndefined();
  });

  test('invalidates same-record trust when raw sources, current identity, or data identity indicate reuse', () => {
    const rawSourceRecord = makeCanonicalSanitizerRecord();
    sanitizeComputeRunsWireOutput(rawSourceRecord);
    rawSourceRecord.data.portfolioAggregates = { exclusions: [{
      model: 'Heston', metric: 'Price', included: 1, expected: 2,
      complete: false, reason: 'invalid_value',
    }] };
    rawSourceRecord.data.modelExclusions = [];
    sanitizeComputeRunsWireOutput(rawSourceRecord);
    expect(rawSourceRecord.aggregateExclusions?.[0]?.reason).toBe('non-finite aggregate value');
    expect(rawSourceRecord.modelExclusions).toEqual([]);

    const discriminatorRecord = makeCanonicalSanitizerRecord();
    sanitizeComputeRunsWireOutput(discriminatorRecord);
    const originalInputHash = discriminatorRecord.data.summary.inputHash;
    discriminatorRecord.data.summary.inputHash = '';
    sanitizeComputeRunsWireOutput(discriminatorRecord);
    discriminatorRecord.data.summary.inputHash = originalInputHash;
    sanitizeComputeRunsWireOutput(discriminatorRecord);
    expect(discriminatorRecord.aggregateExclusions).toBeUndefined();
    expect(discriminatorRecord.modelExclusions).toBeUndefined();

    const identityRecord = makeCanonicalSanitizerRecord();
    const originalData = identityRecord.data;
    sanitizeComputeRunsWireOutput(identityRecord);
    identityRecord.data = { runSchemaVersion: 2 };
    sanitizeComputeRunsWireOutput(identityRecord);
    identityRecord.data = originalData;
    sanitizeComputeRunsWireOutput(identityRecord);
    expect(identityRecord.aggregateExclusions).toBeUndefined();
    expect(identityRecord.modelExclusions).toBeUndefined();
  });
});

describe('summarizeComputeRunsResponse', () => {
  function makeRichRecord(index: number) {
    const modelEntries = Object.fromEntries(
      Array.from({ length: 14 }, (_, modelIndex) => [
        `Model${modelIndex + 1}`,
        {
          variantCount: 1,
          variantsTruncated: false,
          variants: [{
            price: modelIndex + 1,
            greeks: { Delta: 0.5 + modelIndex / 100, Gamma: 0.01 + modelIndex / 1000 },
            dimensions: { exerciseStyle: 'european' },
          }],
          calibration: {
            rmse: 0.01 + modelIndex / 1000,
            confidence: 0.9,
            isFallback: false,
            params: { alpha: modelIndex, beta: 0.5 },
          },
        },
      ]),
    );

    const dispersion = Object.fromEntries(
      Array.from({ length: 400 }, (_, dispersionIndex) => [
        `Greek${dispersionIndex}`,
        {
          min: dispersionIndex,
          max: dispersionIndex + 10,
          mean: dispersionIndex + 5,
          stddev: 1.25,
          models: Array.from({ length: 80 }, (_, modelIndex) => `Model${modelIndex + 1}`),
        },
      ]),
    );

    return {
      ...makeRecord(),
      run_key: `rich-run-${index}`,
      timestamp: 1774771200000 - index * 1000,
      data: {
        ...(makeRecord().data as Record<string, unknown>),
        portfolioAggregates: { dispersion },
      },
      positions: Array.from({ length: 7 }, (_, positionIndex) => ({
        ...(makeRecord().positions as Array<Record<string, unknown>>)[0],
        positionId: `rich-pos-${index}-${positionIndex}`,
        symbol: `SPY250330C00634${positionIndex}`,
        marketPrice: 10 + positionIndex,
        models: modelEntries,
      })),
    };
  }

  test('adds a top-level summary while keeping shaped run rows', () => {
    const summarized = summarizeComputeRunsResponse({
      data: [makeRecord()],
      count: 1,
    }) as Record<string, any>;

    expect(summarized.data).toHaveLength(1);
    expect(summarized.data[0].portfolioDispersion.Delta.models).toBeUndefined();
    expect(summarized.data[0].positions[0].models).toBeUndefined();
    expect(summarized.data[0].positions[0].modelSummary).toBeDefined();
    expect(summarized.summary).toEqual({
      returnedRuns: 1,
      latestStatus: 'completed',
      latestStartedAt: '2026-03-29T08:00:00.000Z',
      statuses: ['completed'],
      scopes: ['full'],
      qualities: ['balanced'],
      underlyings: ['QQQ', 'SPY'],
    });
  });

  test('exposes canonical completion reasons in both compact and detailed run views', () => {
    for (const view of ['summary', 'detailed'] as const) {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.portfolioAggregates.excluded = { models: ['Heston'] };
      record.data.portfolioAggregates.exclusions = [{
        model: 'BlackScholes', metric: 'Lambda', included: 2, expected: 2,
        complete: false, reason: 'unsafe_net_value',
      }];
      record.data.modelExclusions = [{
        model: 'LocalVol-Dupire', underlying: 'spy', expiration: '2026-05-15',
        reason: 'exact_chain_required',
      }];

      const summarized = summarizeComputeRunsResponse({ data: [record], count: 1 }, view) as Record<string, any>;

      expect(summarized.data[0].dispersionExclusions).toBeUndefined();
      expect(summarized.data[0].aggregateExclusions).toEqual([{
        model: 'Black-Scholes', metric: 'Lambda', included: 2, expected: 2,
        reason: 'unstable net portfolio value',
      }]);
      expect(summarized.data[0].modelExclusions).toEqual([{
        model: 'Local Volatility - Dupire', underlying: 'SPY', expiration: '2026-05-15',
        reason: 'exact chain required',
      }]);
    }
  });

  test('retains bounded completion reasons at the UTF-8 emergency budget floor', () => {
    const makePathologicalRecord = () => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.underlyings = ['漢'.repeat(30_000)];
      record.data.portfolioAggregates.exclusions = Array.from({ length: 20 }, (_, index) => ({
        model: index === 0 ? 'BlackScholes' : `Model_${index}_${'漢'.repeat(300)}`,
        metric: index === 0 ? 'Price' : `Metric_${index}_${'漢'.repeat(300)}`,
        included: 1,
        expected: 2,
        complete: false,
        reason: index === 0 ? 'incomplete_position_coverage' : `future_reason_${index}_${'漢'.repeat(600)}`,
      }));
      record.data.modelExclusions = Array.from({ length: 20 }, (_, index) => ({
        model: index === 0 ? 'LocalVol-Dupire' : `Model_${index}_${'漢'.repeat(300)}`,
        underlying: index === 0 ? 'spy' : `underlying_${index}_${'漢'.repeat(300)}`,
        expiration: index === 0 ? '2026-05-15' : `expiration_${index}_${'漢'.repeat(300)}`,
        reason: index === 0 ? 'exact_chain_required' : `future_reason_${index}_${'漢'.repeat(600)}`,
        ...(index === 0 ? {} : { dependency: `Dependency_${index}_${'漢'.repeat(300)}` }),
      }));
      return record;
    };

    const summarized = summarizeComputeRunsResponse({ data: [makePathologicalRecord()], count: 1 }) as Record<string, any>;
    const full = { data: [makePathologicalRecord()], count: 1 };
    sanitizeComputeRunsWireOutput(full);
    trimFullComputeRunsResponse(full);

    for (const response of [summarized, full] as Array<Record<string, any>>) {
      expect(response._truncation_meta.singleRunCompacted).toBe(true);
      expect(response.data[0].aggregateExclusions).toHaveLength(20);
      expect(response.data[0].aggregateExclusions[0]).toEqual({
        model: 'Black-Scholes', metric: 'Price', included: 1, expected: 2,
        reason: 'incomplete position coverage',
      });
      expect(response.data[0].modelExclusions).toHaveLength(20);
      expect(response.data[0].modelExclusions[0]).toEqual({
        model: 'Local Volatility - Dupire', underlying: 'SPY', expiration: '2026-05-15',
        reason: 'exact chain required',
      });
      expect(response.data[0].aggregateExclusionsNotShown).toBeUndefined();
      expect(response.data[0].modelExclusionsNotShown).toBeUndefined();
      expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(50 * 1024);
      expect(response.data[0].data?.portfolioAggregates).toBeUndefined();
    }
  });

  test('preserves explicit-empty and upstream-counted reasons at the emergency floor', () => {
    const makeFloorRecord = (kind: 'empty' | 'counted') => {
      const record: any = makeRecord();
      record.data.runSchemaVersion = 2;
      record.data.underlyings = ['漢'.repeat(30_000)];
      record.data.portfolioAggregates.exclusions = [];
      record.data.modelExclusions = kind === 'empty'
        ? []
        : Array.from({ length: 100 }, (_, index) => ({
            model: `Model${index}`, underlying: 'SPY', expiration: '2026-05-15', reason: `reason_${index}`,
          }));
      if (kind === 'counted') {
        Object.assign(record.data.summary, {
          modelExclusionCount: 102,
          includedModelExclusionCount: 100,
          modelExclusionsTruncated: true,
        });
      }
      return record;
    };

    for (const kind of ['empty', 'counted'] as const) {
      const summary = summarizeComputeRunsResponse({ data: [makeFloorRecord(kind)], count: 1 }) as Record<string, any>;
      const full = { data: [makeFloorRecord(kind)], count: 1 };
      sanitizeComputeRunsWireOutput(full);
      trimFullComputeRunsResponse(full);

      for (const response of [summary, full] as Array<Record<string, any>>) {
        expect(response._truncation_meta.singleRunCompacted).toBe(true);
        if (kind === 'empty') {
          expect(response.data[0].aggregateExclusions).toEqual([]);
          expect(response.data[0].modelExclusions).toEqual([]);
          expect(response.data[0].modelExclusionsNotShown).toBeUndefined();
        } else {
          expect(response.data[0].aggregateExclusions).toEqual([]);
          expect(response.data[0].modelExclusions).toHaveLength(20);
          expect(response.data[0].modelExclusionsNotShown).toBe(82);
        }
        expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThan(50 * 1024);
      }
    }
  });

  test('summarizes per-position model consensus in multi-run responses instead of returning nested model dumps', () => {
    const base = makeRecord();
    const modelEntries = Object.fromEntries(
      Array.from({ length: 14 }, (_, index) => [
        `Model${index + 1}`,
        {
          variantCount: 1,
          variantsTruncated: false,
          variants: [{
            price: index + 1,
            greeks: { Delta: 0.5 + index / 100 },
            dimensions: { exerciseStyle: 'european' },
          }],
        },
      ]),
    );

    const runs = Array.from({ length: 5 }, (_, index) => ({
      ...base,
      run_key: `run-${index + 1}`,
      timestamp: 1774771200000 - index * 1000,
      positions: Array.from({ length: 4 }, (_, positionIndex) => ({
          ...(base.positions as Array<Record<string, unknown>>)[0],
          positionId: `pos-${index}-${positionIndex}`,
          symbol: `SPY250330C00634${positionIndex}`,
          models: modelEntries,
        })),
    }));

    const summarized = summarizeComputeRunsResponse({
      data: runs,
      count: runs.length,
    }) as Record<string, any>;

    expect(summarized.summary.returnedRuns).toBe(5);
    expect(summarized.data[0].positions).toHaveLength(2);
    expect(summarized.data[0].positionsNotShown).toBe(2);
    expect(summarized.data[0].omittedPositionCount).toBeUndefined();
    expect(summarized.data[0].positions[0].models).toBeUndefined();
    expect(summarized.data[0].positions[0].modelsNotShown).toBeUndefined();
    expect(summarized.data[0].positions[0].omittedModelCount).toBeUndefined();
    expect(summarized.data[0].positions[0].modelSummary).toEqual({
      modelCount: 14,
      modelsPreview: ['Model1', 'Model2', 'Model3'],
      calibratedModelCount: 0,
      price: { min: 1, max: 14, mean: 7.5 },
      greeksAvailable: ['Delta'],
    });
  });

  test('excludes failed current variants from multi-run price and Greek consensus', () => {
    const base = makeRecord();
    const makeRun = (index: number) => ({
      ...base,
      run_key: `consensus-run-${index}`,
      timestamp: base.timestamp - index,
      positions: [{
        ...(base.positions as Array<Record<string, any>>)[0],
        models: {
          BlackScholes: {
            variantCount: 1,
            variantsTruncated: false,
            variants: [{
              dimensions: { exerciseStyle: 'european' },
              price: 10,
              greeks: { Delta: 0.5 },
            }],
          },
          PDE: {
            variantCount: 1,
            variantsTruncated: false,
            variants: [{
              dimensions: { exerciseStyle: 'european' },
              price: 1_000,
              greeks: { Gamma: 99 },
              error: '',
            }],
          },
        },
      }],
    });

    const summarized = summarizeComputeRunsResponse({
      data: [makeRun(0), makeRun(1)],
      count: 2,
    }) as Record<string, any>;
    const modelSummary = summarized.data[0].positions[0].modelSummary;

    expect(modelSummary.modelCount).toBe(2);
    expect(modelSummary.errorCount).toBe(1);
    expect(modelSummary.price).toEqual({ min: 10, max: 10, mean: 10 });
    expect(modelSummary.greeksAvailable).toEqual(['Delta']);
  });

  test('keeps rich multi-run responses compact without nested model dumps', () => {
    const summarized = summarizeComputeRunsResponse({
      data: [makeRichRecord(0), makeRichRecord(1), makeRichRecord(2)],
      count: 3,
    }) as Record<string, any>;

    expect(new TextEncoder().encode(JSON.stringify(summarized)).byteLength).toBeLessThan(50 * 1024);
    expect(summarized.data[0].runKey).toBeUndefined();
    expect(summarized.summary.returnedRuns).toBe(summarized.data.length);
    expect(summarized._truncation_meta).toBeUndefined();
    expect(summarized.data).toHaveLength(3);
    expect(summarized.data[0].positions).toHaveLength(2);
    expect(summarized.data[0].positions[0].models).toBeUndefined();
    expect(summarized.data[0].positions[0].modelSummary).toBeDefined();
  });

  test('keeps a single rich run compact enough for the MCP budget', () => {
    const summarized = summarizeComputeRunsResponse({
      data: [makeRichRecord(0)],
      count: 1,
    }) as Record<string, any>;

    expect(new TextEncoder().encode(JSON.stringify(summarized)).byteLength).toBeLessThan(50 * 1024);
    expect(summarized.data).toHaveLength(1);
    expect(summarized.summary.returnedRuns).toBe(1);
    expect(summarized._truncation_meta).toBeUndefined();
    expect(summarized.data[0].positions).toHaveLength(5);
    expect(summarized.data[0].positions[0].models).toBeUndefined();
    expect(summarized.data[0].positions[0].modelSummary).toBeDefined();
  });

  test('view=detailed preserves per-model details for a single returned run', () => {
    const record = makeRichRecord(0);
    const modelNames = Array.from({ length: 14 }, (_, index) => `Model${index + 1}`);
    (record.data as Record<string, any>).portfolioAggregates = {
      dispersion: {
        Price: { min: 1, max: 14, mean: 7.5, stddev: 2.5, models: modelNames },
        Delta: { min: 0.5, max: 0.64, mean: 0.57, stddev: 0.04, models: modelNames },
      },
    };

    const summarized = summarizeComputeRunsResponse({
      data: [record],
      count: 1,
    }, 'detailed') as Record<string, any>;

    expect(new TextEncoder().encode(JSON.stringify(summarized)).byteLength).toBeLessThan(50 * 1024);
    expect(summarized.data).toHaveLength(1);
    const dispersionMetric = Object.values(summarized.data[0].portfolioDispersion ?? {})[0] as Record<string, unknown> | undefined;
    expect(dispersionMetric?.models).toBeDefined();
    expect(summarized.data[0]._portfolioDispersion_meta).toBeUndefined();
    expect(summarized.data[0].positions[0].models).toBeDefined();
    expect(summarized.data[0].positions[0].modelSummary).toBeUndefined();
  });

  test('view=detailed is ignored for multi-run responses', () => {
    const summarized = summarizeComputeRunsResponse({
      data: [makeRichRecord(0), makeRichRecord(1)],
      count: 2,
    }, 'detailed') as Record<string, any>;

    expect(summarized.data).toHaveLength(2);
    const dispersionMetric = Object.values(summarized.data[0].portfolioDispersion ?? {})[0] as Record<string, unknown> | undefined;
    expect(dispersionMetric?.models).toBeUndefined();
    expect(summarized.data[0].positions[0].models).toBeUndefined();
    expect(summarized.data[0].positions[0].modelSummary).toBeDefined();
  });

  test('decodes the current compact contract and bounds run errors', () => {
    const record: any = makeRecord();
    record.positions = [{
      ...(record.positions as Array<Record<string, unknown>>)[0],
      underlying: 'SPY',
      models: {
        Heston: {
          variantCount: 2,
          variants: [
            { dimensions: { exerciseStyle: 'american' }, error: 'failed variant' },
            { dimensions: { exerciseStyle: 'european' }, price: 5.25, greeks: { Delta: 0.52 } },
          ],
          variantsTruncated: false,
        },
      },
    }];
    record.data = {
      syncSchemaVersion: 2,
      runSchemaVersion: 2,
      summary: {
        inputHash: 'e'.repeat(64),
        totalPositions: 12,
        totalModelRuns: 2,
        errorCount: 12,
        includedErrorCount: 8,
        errorsTruncated: true,
        engineVersion: '2.0.6',
        completionState: 'partial',
        valuationTime: 1774771100000,
        executionConfig: {
          calibrationPolicy: 'required',
          useDiscreteDividends: true,
          randomSeed: 8675309,
        },
        modelExclusionCount: 0,
        includedModelExclusionCount: 0,
        modelExclusionsTruncated: false,
      },
      underlyings: ['QQQ', 'SPY'],
      errors: Array.from({ length: 8 }, (_, index) => ({
        positionId: `position-${index}`,
        model: 'PDE',
        error: `run error ${index}`,
        code: `E${index}`,
      })),
      modelExclusions: [],
      projection: {
        schemaVersion: 2,
        compactionLevel: 'models-core',
        originalPositionCount: 12,
        includedPositionCount: 1,
        positionsTruncated: true,
        variantsTruncated: true,
        exposureTruncated: false,
        calibrationTruncated: true,
        earlyExercisePremiumTruncated: false,
        portfolioAggregatesTruncated: true,
      },
    };

    const shaped = shapeComputeRunRecord(record) as Record<string, any>;

    expect(shaped.summary.totalPositions).toBe(12);
    expect(shaped.summary.totalModelRuns).toBe(2);
    expect(shaped.summary.errorCount).toBe(12);
    expect(shaped.summary.includedErrorCount).toBe(8);
    expect(shaped.summary.errorsTruncated).toBe(true);
    expect(shaped.engineVersion).toBe('2.0.6');
    expect(shaped.runSchemaVersion).toBe(2);
    expect(shaped.completionState).toBe('partial');
    expect(shaped.valuationTime).toBe(1774771100000);
    expect(shaped.executionConfig).toEqual({
      calibrationPolicy: 'required',
      useDiscreteDividends: true,
    });
    expect(shaped.executionConfig.randomSeed).toBeUndefined();
    expect(shaped.underlyings).toEqual(['QQQ', 'SPY']);
    expect(shaped.positions[0].models.Heston.price).toBe(5.25);
    expect(shaped.positions[0].models.Heston.greeks).toEqual({ Delta: 0.52 });
    expect(shaped.errors).toHaveLength(5);
    expect(shaped.errors[0]).toEqual({ model: 'PDE', message: 'run error 0', code: 'E0' });
    expect(shaped.errorsNotShown).toBe(3);
    expect(shaped.errorsMeta).toEqual({
      total: 8,
      returned: 5,
      omitted: 3,
      entriesWithTruncatedFields: 0,
    });
    expect(shaped.projection).toEqual({
      schemaVersion: 2,
      compactionLevel: 'models-core',
      originalPositionCount: 12,
      includedPositionCount: 1,
      positionsTruncated: true,
      variantsTruncated: true,
      exposureTruncated: false,
      calibrationTruncated: true,
      earlyExercisePremiumTruncated: false,
      portfolioAggregatesTruncated: true,
    });
  });

  test('recomputes facets and counts after response-budget trimming', () => {
    const hugeUnderlying = (prefix: string) => `${prefix}${'X'.repeat(12_000)}`;
    const records = Array.from({ length: 3 }, (_, index) => {
      const record: any = makeRecord();
      const underlying = hugeUnderlying(`U${index}-`);
      record.status = index === 0 ? 'completed' : 'failed';
      record.scope = index === 0 ? 'core' : 'full';
      record.positions = (record.positions as Array<Record<string, unknown>>).map((position) => ({
        ...position,
        underlying,
      }));
      return record;
    });

    const summarized = summarizeComputeRunsResponse({
      data: records,
      count: records.length,
      requestedLimit: 3,
      matchedCount: 3,
      hasMore: false,
    }) as Record<string, any>;

    expect(summarized._truncation_meta).toBeDefined();
    expect(summarized.data).toHaveLength(1);
    expect(summarized.count).toBe(1);
    expect(summarized.summary.returnedRuns).toBe(1);
    expect(summarized.summary.statuses).toEqual(['completed']);
    expect(summarized.summary.scopes).toEqual(['core']);
    expect(summarized.summary.underlyings).toEqual(summarized.data[0].underlyings);
    expect(summarized.requestedLimit).toBe(3);
    expect(summarized.matchedCount).toBe(3);
    expect(summarized.hasMore).toBe(true);
  });
});
