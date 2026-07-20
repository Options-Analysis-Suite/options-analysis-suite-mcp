import { describe, test, expect } from 'bun:test';
import {
  compactAnalysisHistoryResponse,
  compactPortfolioHistoryResponse,
  dedupeAnalysisHistoryRecords,
  dedupePortfolioSnapshotRecords,
  dedupeRiskSnapshotRecords,
  humanizeAnalysisWireOutput,
  normalizePortfolioSnapshotSymbols,
  summarizeNestedValue,
  shapeAnalysisResultRecord,
  shapePortfolioDetails,
  shapeRiskDetails,
  replaceDuplicatedDataField,
  sanitizeFullSyncResponse,
  stripSyncRecordMetadata,
} from './syncResponseShaping.js';

describe('summarizeNestedValue', () => {
  test('keeps scalars and small scalar arrays inline', () => {
    expect(summarizeNestedValue(5)).toBe(5);
    expect(summarizeNestedValue(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  test('replaces large or object arrays with compact notes', () => {
    expect(summarizeNestedValue([1, 2, 3, 4, 5, 6])).toEqual({
      _count: 6,
      _omitted: true,
    });
    expect(summarizeNestedValue([{ strike: 100 }, { strike: 105 }])).toEqual({
      _count: 2,
      _omitted: true,
    });
  });

  test('recurses into small nested objects and caps depth', () => {
    expect(summarizeNestedValue({
      calibrationSummary: {
        model: 'Heston',
        params: { kappa: 2, theta: 0.04 },
      },
    })).toEqual({
      calibrationSummary: {
        model: 'Heston',
        params: { kappa: 2, theta: 0.04 },
      },
    });
  });
});

describe('shapeAnalysisResultRecord', () => {
  test('deduplicates facts and artifacts already represented in data/data.greeks', () => {
    const record = {
      id: 12,
      user_id: 3,
      created_at: '2026-03-27T00:00:00Z',
      data: {
        id: 99,
        symbol: 'SPY',
        model: 'Heston',
        optionPrice: 12.123456789,
        greeks: {
          Delta: 0.53,
          Gamma: 0.03,
          Vanna: 0.01,
          KappaDer: 0.2,
          Price: 12.123456789,
          price: 12.123456789,
          terminalPrices: Array.from({ length: 100 }, (_, i) => 100 + i),
        },
        facts: { delta: 0.53 },
        artifacts: { calibrationSummary: { rmse: 0.002 } },
      },
      facts: {
        delta: 0.53,
        gamma: 0.03,
        spot: 100,
        moneyness: 1.02,
      },
      artifacts: {
        calibrationSummary: {
          model: 'Heston',
          rmse: 0.002,
          params: { kappa: 2, theta: 0.04 },
        },
        extraGreeks: {
          Vanna: 0.01,
          Speed: 0.123456789,
        },
        modelSensitivities: {
          KappaDer: 0.2,
        },
        pdeFinalGrid: [
          { spot: 100, value: 12 },
          { spot: 101, value: 13 },
        ],
      },
    };

    shapeAnalysisResultRecord(record);

    expect(record.data.greeks as any).toEqual({
      Delta: 0.53,
      Gamma: 0.03,
      Vanna: 0.01,
      KappaDer: 0.2,
      terminalPrices: {
        _count: 100,
        _omitted: true,
      },
    });
    expect(record.data.facts as any).toBe('[see top-level facts]');
    expect(record.data.artifacts as any).toBe('[see top-level artifacts]');
    expect(record.id).toBeUndefined();
    expect(record.user_id).toBeUndefined();
    expect(record.created_at).toBeUndefined();
    expect(record.data.id).toBeUndefined();
    expect(record.facts as any).toEqual({
      spot: 100,
      moneyness: 1.02,
    });
    expect(record.artifacts as any).toEqual({
      calibrationSummary: {
        model: 'Heston',
        rmse: 0.002,
        params: { kappa: 2, theta: 0.04 },
      },
      extraGreeks: {
        Speed: 0.123457,
      },
      pdeFinalGrid: {
        _count: 2,
        _omitted: true,
      },
    });
  });

  test('preserves unique facts for non-duplicated batch summaries', () => {
    const record = {
      data: {
        symbol: 'SPY',
        model: 'MonteCarlo',
        optionPrice: 4.25,
      },
      facts: {
        type: 'mc_batch',
        batchSize: 200,
        count: 200,
        mean: 4.25,
        stdDev: 0.37,
      },
    };

    shapeAnalysisResultRecord(record);

    expect(record.facts).toEqual({
      type: 'mc_batch',
      batchSize: 200,
      count: 200,
      mean: 4.25,
      stdDev: 0.37,
    });
  });

  test('drops rounded-equivalent duplicate greeks from facts and artifacts without throwing', () => {
    const record = {
      data: {
        symbol: 'SPY',
        optionPrice: 1.23456789,
        greeks: {
          Phi: 0.084709283067,
          Charm: 0.0000123456789,
        },
      },
      facts: {
        phi: 0.084709283067,
      },
      artifacts: {
        extraGreeks: {
          Phi: 0.084709283067,
          Charm: 0.0000123456789,
          Price: 1.23456789,
        },
        modelSensitivities: {
          price: 1.23456789,
          Charm: 0.0000123456789,
        },
      },
    };

    expect(() => shapeAnalysisResultRecord(record)).not.toThrow();
    expect(record.data.greeks).toEqual({
      Phi: 0.084709,
      Charm: 0.0000123457,
    });
    expect(record.facts).toBeUndefined();
    expect(record.artifacts).toBeUndefined();
  });

  test('leaves simple scalar fields intact and flattens unknown nested objects', () => {
    const record = {
      data: {
        symbol: 'AAPL',
        strike: 200,
        weirdNested: { hello: 'world' },
      },
    };

    shapeAnalysisResultRecord(record);

    expect(record.data.symbol).toBe('AAPL');
    expect(record.data.strike).toBe(200);
    expect(record.data.weirdNested as any).toBe('[nested object]');
  });

  test('humanizes analysis model identifiers and Variance Gamma calibration params', () => {
    const record = {
      model: 'VarianceGamma',
      data: {
        symbol: 'SPY',
        model: 'VarianceGamma',
        optionPrice: 3.25,
        greeks: { Delta: 0.42 },
      },
      artifacts: {
        calibrationSummary: {
          model: 'VarianceGamma',
          params: {
            vgNu: 0.11,
            vgSigma: 0.22,
            vgTheta: -0.33,
          },
        },
        comparison: {
          bestModel: 'BlackScholes',
          worstModel: 'LocalVol',
        },
      },
    };

    shapeAnalysisResultRecord(record);

    expect(record.model).toBe('Variance Gamma');
    expect(record.data.model).toBe('Variance Gamma');
    expect(record.artifacts.calibrationSummary.model).toBe('Variance Gamma');
    expect(record.artifacts.calibrationSummary.params as any).toEqual({
      nu: 0.11,
      sigma: 0.22,
      theta: -0.33,
    });
    expect(record.artifacts.comparison).toEqual({
      bestModel: 'Black-Scholes',
      worstModel: 'Local Volatility',
    });
    expect(JSON.stringify(record)).not.toContain('VarianceGamma');
    expect(JSON.stringify(record)).not.toContain('BlackScholes');
    expect(JSON.stringify(record)).not.toContain('LocalVol');
    expect(JSON.stringify(record)).not.toContain('vgNu');
  });

  test('humanizes model fields inside raw models object arrays', () => {
    const payload = {
      data: [{
        artifacts: {
          models: [
            { model: 'VarianceGamma', price: 3.25 },
            { model: 'BlackScholes', price: 3.12 },
          ],
        },
      }],
    };

    humanizeAnalysisWireOutput(payload);

    expect(payload.data[0].artifacts.models).toEqual([
      { model: 'Variance Gamma', price: 3.25 },
      { model: 'Black-Scholes', price: 3.12 },
    ]);
    expect(JSON.stringify(payload)).not.toContain('VarianceGamma');
    expect(JSON.stringify(payload)).not.toContain('BlackScholes');
  });

  test('is null-safe', () => {
    const record = { data: null, facts: undefined, artifacts: null } as any;
    expect(() => shapeAnalysisResultRecord(record)).not.toThrow();
  });
});

describe('dedupeAnalysisHistoryRecords', () => {
  test('collapses near-identical reruns from the same pricing sweep while preserving distinct outputs', () => {
    const baseTimestamp = 1774637379448;
    const records = [
      {
        symbol: 'AAPL',
        model: 'JumpDiffusion',
        timestamp: baseTimestamp,
        data: {
          symbol: 'AAPL',
          model: 'JumpDiffusion',
          isCall: true,
          strike: 250,
          daysToMaturity: 83,
          volatility: 0.335376162,
          optionPrice: 17.450806920331303,
          greeks: { Delta: 0.542205 },
        },
      },
      {
        symbol: 'AAPL',
        model: 'JumpDiffusion',
        timestamp: baseTimestamp - 60_000,
        data: {
          symbol: 'AAPL',
          model: 'JumpDiffusion',
          isCall: true,
          strike: 250,
          daysToMaturity: 83,
          volatility: 0.335376162,
          optionPrice: 17.461596029947614,
          greeks: { Delta: 0.542395 },
        },
      },
      {
        symbol: 'AAPL',
        model: 'JumpDiffusion',
        timestamp: baseTimestamp - 120_000,
        data: {
          symbol: 'AAPL',
          model: 'JumpDiffusion',
          isCall: true,
          strike: 250,
          daysToMaturity: 83,
          volatility: 0.335376162,
          optionPrice: 15.137175298598967,
          greeks: { Delta: 0.667043 },
        },
      },
      {
        symbol: 'AAPL',
        model: 'JumpDiffusion',
        timestamp: baseTimestamp - 3_600_000,
        data: {
          symbol: 'AAPL',
          model: 'JumpDiffusion',
          isCall: true,
          strike: 250,
          daysToMaturity: 83,
          volatility: 0.335376162,
          optionPrice: 17.455,
          greeks: { Delta: 0.543 },
        },
      },
    ];

    const deduped = dedupeAnalysisHistoryRecords(records, 10);

    expect(deduped.records).toHaveLength(3);
    expect(deduped.omittedCount).toBe(1);
    expect(deduped.records[0].timestamp).toBe(baseTimestamp);
    expect(deduped.records[1].data.optionPrice).toBe(15.137175298598967);
    expect(deduped.records[2].timestamp).toBe(baseTimestamp - 3_600_000);
  });
});

describe('stripSyncRecordMetadata', () => {
  test('removes database metadata from top-level and nested data objects', () => {
    const record = {
      id: 4,
      user_id: 7,
      created_at: '2026-03-27T00:00:00Z',
      data: {
        id: 88,
        user_id: 7,
        symbol: 'SPY',
      },
    };

    stripSyncRecordMetadata(record);

    expect(record as any).toEqual({
      data: {
        symbol: 'SPY',
      },
    });
  });
});

describe('sanitizeFullSyncResponse', () => {
  test('removes sync metadata and internal result identifiers from full-mode rows', () => {
    const response = {
      data: [
        {
          id: 10,
          user_id: 3,
          created_at: '2026-03-27T00:00:00Z',
          key: 'TSLA|day|1774594800000',
          data: {
            id: 99,
            user_id: 3,
            key: 'TSLA|day|1774594800000',
            resultId: 88,
            symbol: 'TSLA',
          },
          facts: {
            resultId: 88,
            model: 'VarianceGamma',
          },
          artifacts: {
            resultId: 88,
            calibrationSummary: {
              resultId: 88,
              model: 'VarianceGamma',
            },
          },
        },
      ],
    };

    sanitizeFullSyncResponse(response);

    const text = JSON.stringify(response);
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('created_at');
    expect(text).not.toContain('"key"');
    expect(text).not.toContain('resultId');
    expect(response.data[0].data.symbol).toBe('TSLA');
    expect(response.data[0].facts.model).toBe('VarianceGamma');
  });
});

describe('replaceDuplicatedDataField', () => {
  test('replaces duplicated nested details copy with a note', () => {
    const record = {
      details: {
        fullAllocation: [{ symbol: 'SPY' }],
      },
      data: {
        spot: 100,
        details: {
          fullAllocation: [{ symbol: 'SPY' }],
        },
      },
    };

    replaceDuplicatedDataField(record, 'details', '[see top-level details]');
    expect(record.data.details as any).toBe('[see top-level details]');
  });

  test('preserves nested details when no top-level companion exists', () => {
    const record = {
      data: {
        spot: 100,
        details: {
          fullAllocation: [{ symbol: 'SPY' }],
        },
      },
    };

    replaceDuplicatedDataField(record, 'details', '[see top-level details]');
    expect(record.data.details).toEqual({ fullAllocation: [{ symbol: 'SPY' }] });
  });

  test('does nothing for scalar fields or missing data', () => {
    const record = {
      data: {
        details: 'already summarized',
      },
    };
    replaceDuplicatedDataField(record, 'details', '[see top-level details]');
    expect(record.data.details).toBe('already summarized');
    expect(() => replaceDuplicatedDataField({ data: null }, 'details', '[see top-level details]')).not.toThrow();
  });
});

describe('shapeRiskDetails', () => {
  test('omits heavy risk-detail arrays while preserving summary objects', () => {
    const shaped = shapeRiskDetails({
      snapshotId: 10,
      fullMargin: {
        buyingPower: 70000,
        usagePercent: 32,
      },
      correlationMatrix: [[1, 0.2], [0.2, 1]],
      mcVarDetails: [{ percentile: 95, value: -1000 }],
      positionContributions: [
        { symbol: 'SPY', betaContribution: 0.2 },
        { symbol: 'QQQ', betaContribution: 0.1 },
      ],
    });

    expect(shaped).toEqual({
      snapshotId: 10,
      fullMargin: {
        buyingPower: 70000,
        usagePercent: 32,
      },
      _omitted: [
        'correlation matrix',
        'Monte Carlo VaR details',
        'position contributions (2 items)',
      ],
    });
  });

  test('passes through non-object details unchanged', () => {
    expect(shapeRiskDetails(null)).toBeNull();
    expect(shapeRiskDetails('summary')).toBe('summary');
    expect(shapeRiskDetails([{ foo: 'bar' }])).toEqual([{ foo: 'bar' }]);
  });
});

describe('shapePortfolioDetails', () => {
  test('keeps only unique greek summary fields and omits per-position arrays', () => {
    const shaped = shapePortfolioDetails({
      snapshotId: 12,
      greeks: {
        totalRho: -12.3456789,
        totalDelta: 50,
        totalGamma: 1.2,
        totalTheta: -5,
        totalVega: 30,
        dollarDelta: 15000.123456,
        dollarGamma: 42.123456,
      },
      positionGreeks: [{ symbol: 'SPY' }],
      fullAllocation: [{ symbol: 'AAPL' }],
    });

    expect(shaped).toEqual({
      snapshotId: 12,
      greeks: {
        totalRho: -12.345679,
        dollarDelta: 15000.123456,
        dollarGamma: 42.123456,
      },
      _omitted: ['position greeks (1 items)', 'full allocation (1 items)'],
    });
  });
});

describe('normalizePortfolioSnapshotSymbols', () => {
  test('backfills readable labels for legacy blank option symbols', () => {
    const record = {
      data: {
        topHoldings: [
          { symbol: '', value: 21062.5, pnl: -2.5, weight: 0.1763 },
          { symbol: 'QQQ', value: 17273.7, pnl: -718.8, weight: 0.1446 },
          { symbol: '', value: 5350, pnl: -2, weight: 0.0448 },
          { symbol: '', value: -130.5, pnl: 859.5, weight: 0.0011 },
        ],
      },
      details: {
        positionGreeks: [
          { symbol: '', type: 'put', quantity: 5 },
          { symbol: 'QQQ', type: 'stock', quantity: 30 },
          { symbol: '', type: 'call', quantity: 4 },
          { symbol: '', type: 'call', quantity: -1 },
        ],
        fullAllocation: [
          { symbol: '', type: 'put', value: 21062.5, pnl: -2.5, weight: 0.1763 },
          { symbol: 'QQQ', type: 'stock', value: 17273.7, pnl: -718.8, weight: 0.1446 },
          { symbol: '', type: 'call', value: 5350, pnl: -2, weight: 0.0448 },
          { symbol: '', type: 'call', value: -130.5, pnl: 859.5, weight: 0.0011 },
        ],
      },
    };

    normalizePortfolioSnapshotSymbols(record);

    expect(record.data.topHoldings).toEqual([
      { symbol: 'Put x5', value: 21062.5, pnl: -2.5, weight: 0.1763 },
      { symbol: 'QQQ', value: 17273.7, pnl: -718.8, weight: 0.1446 },
      { symbol: 'Call x4', value: 5350, pnl: -2, weight: 0.0448 },
      { symbol: 'Short Call x1', value: -130.5, pnl: 859.5, weight: 0.0011 },
    ]);
    expect(record.details.positionGreeks[0].symbol).toBe('Put x5');
    expect(record.details.positionGreeks[2].symbol).toBe('Call x4');
    expect(record.details.positionGreeks[3].symbol).toBe('Short Call x1');
    expect(record.details.fullAllocation[0].symbol).toBe('Put x5');
  });
});

describe('dedupePortfolioSnapshotRecords', () => {
  test('collapses consecutive identical portfolio snapshots while preserving distinct older states', () => {
    const records = [
      {
        timestamp: 3000,
        data: {
          positionCount: 2,
          totalValue: 100000,
          totalPnL: 500,
          totalPnLPercent: 0.5,
          cashBalance: 25000,
          delta: 12.5,
          gamma: 1.2,
          theta: -3.4,
          vega: 22.1,
          topHoldings: [
            { symbol: 'AAPL 250C', value: 5000, pnl: 10, weight: 0.05 },
            { symbol: 'QQQ', value: 3000, pnl: -20, weight: 0.03 },
          ],
        },
        details: {
          greeks: { totalRho: 3, dollarDelta: 1000, dollarGamma: 50 },
        },
      },
      {
        timestamp: 2000,
        data: {
          positionCount: 2,
          totalValue: 100000,
          totalPnL: 500,
          totalPnLPercent: 0.5,
          cashBalance: 25000,
          delta: 12.5,
          gamma: 1.2,
          theta: -3.4,
          vega: 22.1,
          topHoldings: [
            { symbol: 'AAPL 250C', value: 5000, pnl: 10, weight: 0.05 },
            { symbol: 'QQQ', value: 3000, pnl: -20, weight: 0.03 },
          ],
        },
        details: {
          greeks: { totalRho: 3, dollarDelta: 1000, dollarGamma: 50 },
        },
      },
      {
        timestamp: 1000,
        data: {
          positionCount: 2,
          totalValue: 99000,
          totalPnL: 400,
          totalPnLPercent: 0.4,
          cashBalance: 25000,
          delta: 10.5,
          gamma: 1,
          theta: -3,
          vega: 20,
          topHoldings: [
            { symbol: 'AAPL 250C', value: 4500, pnl: 5, weight: 0.045 },
          ],
        },
        details: {
          greeks: { totalRho: 2.5, dollarDelta: 900, dollarGamma: 45 },
        },
      },
    ];

    const deduped = dedupePortfolioSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(1);
    expect(deduped.records[0].timestamp).toBe(3000);
    expect(deduped.records[1].timestamp).toBe(1000);
  });

  test('omits older repeated portfolio states even when they are not consecutive', () => {
    const records = [
      {
        timestamp: 4000,
        data: {
          positionCount: 2,
          totalValue: 100000,
          totalPnL: 500,
          totalPnLPercent: 0.5,
          cashBalance: 25000,
          delta: 12.5,
          gamma: 1.2,
          theta: -3.4,
          vega: 22.1,
          topHoldings: [{ symbol: 'AAPL 250C', value: 5000, pnl: 10, weight: 0.05 }],
        },
        details: { greeks: { totalRho: 3, dollarDelta: 1000, dollarGamma: 50 } },
      },
      {
        timestamp: 3000,
        data: {
          positionCount: 3,
          totalValue: 105000,
          totalPnL: 750,
          totalPnLPercent: 0.71,
          cashBalance: 22000,
          delta: 15.5,
          gamma: 1.5,
          theta: -4.1,
          vega: 25,
          topHoldings: [{ symbol: 'QQQ', value: 7000, pnl: 20, weight: 0.067 }],
        },
        details: { greeks: { totalRho: 4, dollarDelta: 1400, dollarGamma: 60 } },
      },
      {
        timestamp: 2000,
        data: {
          positionCount: 2,
          totalValue: 100000,
          totalPnL: 500,
          totalPnLPercent: 0.5,
          cashBalance: 25000,
          delta: 12.5,
          gamma: 1.2,
          theta: -3.4,
          vega: 22.1,
          topHoldings: [{ symbol: 'AAPL 250C', value: 5000, pnl: 10, weight: 0.05 }],
        },
        details: { greeks: { totalRho: 3, dollarDelta: 1000, dollarGamma: 50 } },
      },
    ];

    const deduped = dedupePortfolioSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(1);
    expect(deduped.records.map((record) => record.timestamp)).toEqual([4000, 3000]);
  });

  test('preserves portfolio snapshots that differ only in higher-order Greeks', () => {
    const baseData = {
      positionCount: 2,
      totalValue: 100000,
      totalPnL: 500,
      totalPnLPercent: 0.5,
      cashBalance: 25000,
      delta: 12.5,
      gamma: 1.2,
      theta: -3.4,
      vega: 22.1,
      rho: 3,
      topHoldings: [{ symbol: 'AAPL 250C', value: 5000, pnl: 10, weight: 0.05 }],
    };
    const details = { greeks: { totalRho: 3, dollarDelta: 1000, dollarGamma: 50 } };
    const records = [
      {
        timestamp: 3000,
        data: { ...baseData, vanna: -0.09, charm: -0.29, vomma: 0.26, veta: -1.01 },
        details,
      },
      {
        timestamp: 2000,
        data: { ...baseData, vanna: -0.1, charm: -0.31, vomma: 0.28, veta: -1.04 },
        details,
      },
    ];

    const deduped = dedupePortfolioSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(0);
    expect(deduped.records.map((record) => record.timestamp)).toEqual([3000, 2000]);
  });
});

describe('dedupeRiskSnapshotRecords', () => {
  test('collapses consecutive identical risk snapshots while preserving later distinct states', () => {
    const records = [
      {
        timestamp: 3000,
        data: {
          portfolioValue: 166051,
          var95: -1.37,
          var99: -2.04,
          cvar95: -1.71,
          beta: 0.05,
          volatility: 122.82,
          correlation: 0.05,
          maxDrawdown: 3.91,
          sharpeRatio: 4.06,
          marginUsagePercent: 46.85,
        },
        details: {
          fullMargin: {
            usagePercent: 46.85,
            marginUsed: 45585.84,
            maintenanceReq: 39548.39,
            marginAvailable: 51710.56,
            buyingPower: 103421.13,
            cashBalance: 53315.53,
            buffer: 57748.01,
            bufferPercent: 59.35,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
      {
        timestamp: 2000,
        data: {
          portfolioValue: 166051,
          var95: -1.37,
          var99: -2.04,
          cvar95: -1.71,
          beta: 0.05,
          volatility: 122.82,
          correlation: 0.05,
          maxDrawdown: 3.91,
          sharpeRatio: 4.06,
          marginUsagePercent: 46.85,
        },
        details: {
          fullMargin: {
            usagePercent: 46.85,
            marginUsed: 45585.84,
            maintenanceReq: 39548.39,
            marginAvailable: 51710.56,
            buyingPower: 103421.13,
            cashBalance: 53315.53,
            buffer: 57748.01,
            bufferPercent: 59.35,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
      {
        timestamp: 1000,
        data: {
          portfolioValue: 165000,
          var95: -1.2,
          var99: -1.8,
          cvar95: -1.5,
          beta: 0.07,
          volatility: 118,
          correlation: 0.04,
          maxDrawdown: 3.5,
          sharpeRatio: 3.9,
          marginUsagePercent: 40,
        },
        details: {
          fullMargin: {
            usagePercent: 40,
            marginUsed: 40000,
            maintenanceReq: 35000,
            marginAvailable: 60000,
            buyingPower: 120000,
            cashBalance: 53000,
            buffer: 65000,
            bufferPercent: 65,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
    ];

    const deduped = dedupeRiskSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(1);
    expect(deduped.records[0].timestamp).toBe(3000);
    expect(deduped.records[1].timestamp).toBe(1000);
  });

  test('omits older repeated risk states even when they are separated by a distinct snapshot', () => {
    const records = [
      {
        timestamp: 4000,
        data: {
          portfolioValue: 166051,
          var95: -1.37,
          var99: -2.04,
          cvar95: -1.71,
          beta: 0.05,
          volatility: 122.82,
          correlation: 0.05,
          maxDrawdown: 3.91,
          sharpeRatio: 4.06,
          marginUsagePercent: 46.85,
        },
        details: {
          fullMargin: {
            usagePercent: 46.85,
            marginUsed: 45585.84,
            maintenanceReq: 39548.39,
            marginAvailable: 51710.56,
            buyingPower: 103421.13,
            cashBalance: 53315.53,
            buffer: 57748.01,
            bufferPercent: 59.35,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
      {
        timestamp: 3000,
        data: {
          portfolioValue: 165000,
          var95: -1.2,
          var99: -1.8,
          cvar95: -1.5,
          beta: 0.07,
          volatility: 118,
          correlation: 0.04,
          maxDrawdown: 3.5,
          sharpeRatio: 3.9,
          marginUsagePercent: 40,
        },
        details: {
          fullMargin: {
            usagePercent: 40,
            marginUsed: 40000,
            maintenanceReq: 35000,
            marginAvailable: 60000,
            buyingPower: 120000,
            cashBalance: 53000,
            buffer: 65000,
            bufferPercent: 65,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
      {
        timestamp: 2000,
        data: {
          portfolioValue: 166051,
          var95: -1.37,
          var99: -2.04,
          cvar95: -1.71,
          beta: 0.05,
          volatility: 122.82,
          correlation: 0.05,
          maxDrawdown: 3.91,
          sharpeRatio: 4.06,
          marginUsagePercent: 46.85,
        },
        details: {
          fullMargin: {
            usagePercent: 46.85,
            marginUsed: 45585.84,
            maintenanceReq: 39548.39,
            marginAvailable: 51710.56,
            buyingPower: 103421.13,
            cashBalance: 53315.53,
            buffer: 57748.01,
            bufferPercent: 59.35,
            isHighUsage: false,
            isCritical: false,
          },
        },
      },
    ];

    const deduped = dedupeRiskSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(1);
    expect(deduped.records.map((record) => record.timestamp)).toEqual([4000, 3000]);
  });

  test('preserves risk snapshots that differ only in aggregate Greek dollar-impact fields', () => {
    const baseData = {
      portfolioValue: 166051,
      var95: -1.37,
      var99: -2.04,
      cvar95: -1.71,
      beta: 0.05,
      volatility: 122.82,
      correlation: 0.05,
      maxDrawdown: 3.91,
      sharpeRatio: 4.06,
      marginUsagePercent: 46.85,
    };
    const details = {
      fullMargin: {
        usagePercent: 46.85,
        marginUsed: 45585.84,
        maintenanceReq: 39548.39,
        marginAvailable: 51710.56,
        buyingPower: 103421.13,
        cashBalance: 53315.53,
        buffer: 57748.01,
        bufferPercent: 59.35,
        isHighUsage: false,
        isCritical: false,
      },
    };
    const records = [
      {
        timestamp: 3000,
        data: {
          ...baseData,
          dollarDelta: 153775.28,
          dollarGamma: 1.15,
          dollarTheta: -16.49,
          dollarVega: 5.87,
          dollarRho: 18.53,
          dollarVanna: -66.39,
          dollarCharm: -212.68,
          dollarVomma: 0.26,
          dollarVeta: -1.01,
        },
        details,
      },
      {
        timestamp: 2000,
        data: {
          ...baseData,
          dollarDelta: 153775.28,
          dollarGamma: 1.15,
          dollarTheta: -16.49,
          dollarVega: 5.87,
          dollarRho: 18.53,
          dollarVanna: -70.08,
          dollarCharm: -217.78,
          dollarVomma: 0.28,
          dollarVeta: -1.04,
        },
        details,
      },
    ];

    const deduped = dedupeRiskSnapshotRecords(records, 3);

    expect(deduped.records).toHaveLength(2);
    expect(deduped.omittedCount).toBe(0);
    expect(deduped.records.map((record) => record.timestamp)).toEqual([3000, 2000]);
  });
});

describe('compactPortfolioHistoryResponse', () => {
  test('trims top holdings before the global size guard has to collapse the history', () => {
    const makeHoldings = (count: number) => Array.from({ length: count }, (_, i) => ({
      symbol: `SYM${i}`,
      value: 1000 + i,
      pnl: 10 + i,
      weight: 0.123456 + i,
    }));

    const res = {
      data: [
        { data: { topHoldings: makeHoldings(8) } },
        { data: { topHoldings: makeHoldings(7) } },
      ],
    };

    compactPortfolioHistoryResponse(res, 1);

    expect(res.data[0].data.topHoldings).toHaveLength(5);
    expect(res.data[1].data.topHoldings).toHaveLength(3);
    expect((res.data[0].data as any)._topHoldingsMeta).toEqual({ showing: 5, total: 8 });
    expect((res.data[1].data as any)._topHoldingsMeta).toEqual({ showing: 3, total: 7 });
    expect(res.data[0].data.topHoldings[0].weight).toBe(0.1235);
  });
});

describe('compactAnalysisHistoryResponse', () => {
  test('rounds nested numeric payloads when a large history response exceeds the soft threshold', () => {
    const res = {
      data: [{
        data: {
          greeks: {
            Delta: 0.123456789,
            Gamma: 0.987654321,
            Charm: 0.0000123456789,
          },
        },
        facts: {
          moneyness: 1.012345678,
        },
        artifacts: {
          calibrationSummary: {
            rmse: 0.000123456789,
          },
        },
      }],
    };

    compactAnalysisHistoryResponse(res, 1);

    expect(res.data[0].data.greeks).toEqual({
      Delta: 0.123457,
      Gamma: 0.987654,
      Charm: 0.0000123457,
    });
    expect(res.data[0].facts).toEqual({ moneyness: 1.012346 });
    expect(res.data[0].artifacts).toEqual({
      calibrationSummary: {
        rmse: 0.000123,
      },
    });
  });
});
