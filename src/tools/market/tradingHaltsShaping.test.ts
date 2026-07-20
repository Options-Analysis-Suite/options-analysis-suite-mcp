import { describe, expect, it } from 'bun:test';
import { dedupeTradingHalts, summarizeSymbolTradingHalts, summarizeTradingHalts } from './tradingHaltsShaping.js';

describe('dedupeTradingHalts', () => {
  it('removes duplicate cross-feed rows for the same halt event', () => {
    const deduped = dedupeTradingHalts([
      {
        symbol: 'ARTL',
        name: 'Artelo Biosciences, Inc. CS',
        market: 'NASDAQ',
        haltTime: '2026-03-27T13:36:24.460Z',
        haltCode: 'LUDP',
        haltDescription: 'Volatility Trading Pause',
        resumptionTime: '2026-03-27T13:41:24.000Z',
        status: 'Resumed',
        source: 'NASDAQ',
      },
      {
        symbol: 'ARTL',
        name: 'Artelo Biosciences, Inc. Common Stock',
        market: 'NASDAQ',
        haltTime: '2026-03-27T13:36:24.000Z',
        haltCode: 'LUDP',
        haltDescription: 'Volatility Trading Pause',
        resumptionTime: '2026-03-27T13:41:24.000Z',
        status: 'Resumed',
        source: 'NYSE',
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.name).toBe('Artelo Biosciences, Inc. Common Stock');
  });

  it('prefers the canonical volatility halt code when feeds disagree on alias codes for the same event', () => {
    const deduped = dedupeTradingHalts([
      {
        symbol: 'BUR',
        name: 'Burford Capital Limited Ordinary Shares',
        market: 'NYSE',
        haltTime: '2026-03-27T11:11:44.790Z',
        haltCode: 'M',
        haltDescription: 'Volatility Trading Pause',
        resumptionTime: '2026-03-27T11:16:47.000Z',
        status: 'Resumed',
        source: 'NASDAQ',
      },
      {
        symbol: 'BUR',
        name: 'Burford Capital Limited Ordinary Shares',
        market: 'NYSE',
        haltTime: '2026-03-27T11:11:44.000Z',
        haltCode: 'LUDP',
        haltDescription: 'Volatility Trading Pause',
        resumptionTime: '2026-03-27T11:16:47.000Z',
        status: 'Resumed',
        source: 'NYSE',
      },
    ]);

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.haltCode).toBe('LUDP');
  });
});

describe('summarizeTradingHalts', () => {
  it('prioritizes active halts and material recent events in the default view', () => {
    const summarized = summarizeTradingHalts({
      halts: [
        {
          symbol: 'AREB',
          name: 'American Rebel Holdings',
          market: 'NASDAQ',
          haltTime: '2026-03-20T19:50:00.000Z',
          haltCode: 'T12',
          haltDescription: 'Additional Information Requested',
          resumptionTime: null,
          status: 'Halted',
          source: 'NASDAQ',
        },
        {
          symbol: 'ITRM',
          name: 'Iterum Therapeutics plc',
          market: 'NASDAQ',
          haltTime: '2026-03-27T09:17:21.000Z',
          haltCode: 'T1',
          haltDescription: 'News Pending',
          resumptionTime: '2026-03-27T10:20:00.000Z',
          status: 'Resumed',
          source: 'NYSE',
        },
        {
          symbol: 'ARTL',
          name: 'Artelo Biosciences, Inc. CS',
          market: 'NASDAQ',
          haltTime: '2026-03-27T13:36:24.460Z',
          haltCode: 'LUDP',
          haltDescription: 'Volatility Trading Pause',
          resumptionTime: '2026-03-27T13:41:24.000Z',
          status: 'Resumed',
          source: 'NASDAQ',
        },
        {
          symbol: 'ARTL',
          name: 'Artelo Biosciences, Inc. Common Stock',
          market: 'NASDAQ',
          haltTime: '2026-03-27T13:36:24.000Z',
          haltCode: 'LUDP',
          haltDescription: 'Volatility Trading Pause',
          resumptionTime: '2026-03-27T13:41:24.000Z',
          status: 'Resumed',
          source: 'NYSE',
        },
        {
          symbol: 'VSA',
          name: 'VisionSys AI Inc American Depositary Shares',
          market: 'NASDAQ',
          haltTime: '2026-03-27T12:31:12.000Z',
          haltCode: 'LUDP',
          haltDescription: 'Volatility Trading Pause',
          resumptionTime: '2026-03-27T12:36:12.000Z',
          status: 'Resumed',
          source: 'NYSE',
        },
      ],
      summary: {
        activeHalts: 1,
        todayHalts: 5,
        totalHalts: 5,
        source: 'NASDAQ RSS Feed + NYSE API',
      },
    }, '2026-03-27T18:00:00.000Z') as Record<string, any>;

    expect(summarized.summary.activeHalts).toBe(1);
    expect(summarized.summary.totalHalts).toBe(4);
    expect(summarized.summary.duplicateRowsRemoved).toBe(1);
    expect(summarized.activeHalts).toHaveLength(1);
    expect(summarized.activeHalts[0]?.symbol).toBe('AREB');
    expect(summarized.recentMaterialHalts).toHaveLength(1);
    expect(summarized.recentMaterialHalts[0]?.symbol).toBe('ITRM');
    expect(summarized.recentVolatilityHalts).toHaveLength(2);
    expect(summarized.recentVolatilityHalts.map((halt: Record<string, unknown>) => halt.symbol)).toEqual(['ARTL', 'VSA']);
    expect(summarized._halts_meta?.duplicateRowsRemoved).toBe(1);
  });

  it('shows only the latest unresolved halt per symbol in the active section', () => {
    const summarized = summarizeTradingHalts({
      halts: [
        {
          symbol: 'SVA',
          name: 'Sinovac Biotech, Ltd',
          market: 'NASDAQ',
          haltTime: '2025-05-19T00:21:31.000Z',
          haltCode: 'T1',
          haltDescription: 'News Pending',
          resumptionTime: null,
          status: 'Halted',
        },
        {
          symbol: 'SVA',
          name: 'Sinovac Biotech, Ltd Ord Shrs',
          market: 'NASDAQ',
          haltTime: '2019-02-22T16:02:01.000Z',
          haltCode: 'T12',
          haltDescription: 'Additional Information Requested',
          resumptionTime: null,
          status: 'Halted',
        },
      ],
      summary: {
        activeHalts: 2,
        totalHalts: 2,
      },
    }) as Record<string, any>;

    expect(summarized.summary.activeHalts).toBe(1);
    expect(summarized.summary.olderActiveRowsCollapsed).toBe(1);
    expect(summarized.activeHalts).toHaveLength(1);
    expect(summarized.activeHalts[0]?.haltTime).toBe('2025-05-19T00:21:31.000Z');
  });

  it('returns the original payload when no halt array is present', () => {
    const payload = { foo: 'bar' };
    expect(summarizeTradingHalts(payload)).toEqual(payload);
  });
});

describe('summarizeSymbolTradingHalts', () => {
  it('dedupes same-event feed rows and collapses older unresolved rows in default symbol view', () => {
    const summarized = summarizeSymbolTradingHalts({
      symbol: 'BUR',
      history: [
        {
          date: '2026-03-27',
          haltTime: '2026-03-27T11:11:44.790Z',
          resumptionTime: '2026-03-27T11:16:47.000Z',
          duration: 5,
          code: 'M',
          description: 'Volatility Trading Pause',
          market: 'NYSE',
          source: 'NASDAQ',
        },
        {
          date: '2026-03-27',
          haltTime: '2026-03-27T11:11:44.000Z',
          resumptionTime: '2026-03-27T11:16:47.000Z',
          duration: 5,
          code: 'LUDP',
          description: 'Volatility Trading Pause',
          market: 'NYSE',
          source: 'NYSE',
        },
      ],
      summary: {
        totalHalts: 2,
        avgDuration: 5,
      },
    }) as Record<string, any>;

    expect(summarized.summary.totalHalts).toBe(1);
    expect(summarized.summary.duplicateRowsRemoved).toBe(1);
    expect(summarized.history).toHaveLength(1);
    expect(summarized.summary.newsHalts).toBe(0);
    expect(summarized.summary.volatilityHalts).toBe(1);
    expect(summarized.history[0]?.code).toBe('LUDP');
  });

  it('keeps only the newest unresolved row as the current active halt', () => {
    const summarized = summarizeSymbolTradingHalts({
      symbol: 'SVA',
      history: [
        {
          date: '2025-05-19',
          haltTime: '2025-05-19T00:21:31.000Z',
          resumptionTime: null,
          duration: null,
          code: 'T1',
          description: 'News Pending',
          market: 'NASDAQ',
          source: 'NYSE',
        },
        {
          date: '2019-02-22',
          haltTime: '2019-02-22T16:02:01.000Z',
          resumptionTime: null,
          duration: null,
          code: 'T12',
          description: 'Additional Information Requested',
          market: 'NASDAQ',
          source: 'NASDAQ',
        },
      ],
      summary: {
        totalHalts: 2,
      },
    }) as Record<string, any>;

    expect(summarized.summary.activeHalts).toBe(1);
    expect(summarized.summary.currentlyHalted).toBe(true);
    expect(summarized.summary.olderActiveRowsCollapsed).toBe(1);
    expect(summarized.activeHalt?.code).toBe('T1');
    expect(summarized.history).toHaveLength(1);
  });
});
