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

describe('a halt is active only while it is the symbol\'s latest', () => {
  // Thirty-third run: LQDA listed as active "Halted" from its 15:31:56 LUDP
  // pause, beside later halts of its own that resumed at 17:45 and 17:52.
  // The feed does not update an earlier row, so a later event supersedes it.
  const halt = (symbol: string, haltTime: string, resumptionTime: string | null) => ({
    symbol, name: symbol, market: 'NASDAQ', haltTime, haltCode: 'LUDP', haltDescription: 'Volatility Trading Pause',
    resumptionTime, status: resumptionTime ? 'Resumed' : 'Halted', source: 'NASDAQ',
  });
  const feed = [
    halt('LQDA', '2026-09-30T15:31:56.000Z', null),
    halt('LQDA', '2026-09-30T17:40:00.000Z', '2026-09-30T17:45:00.000Z'),
    halt('LQDA', '2026-09-30T17:47:00.000Z', '2026-09-30T17:52:00.000Z'),
    halt('ABCD', '2026-09-30T17:00:00.000Z', '2026-09-30T17:05:00.000Z'),
    halt('ABCD', '2026-09-30T18:00:00.000Z', null),
  ];

  it('the market summary lists a symbol as halted only when its latest halt has not resumed', () => {
    const out = summarizeTradingHalts({ halts: feed }, '2026-09-30T20:00:00.000Z') as any;
    expect(out.activeHalts.map((h: any) => h.symbol)).toEqual(['ABCD']);
    expect(out.summary.activeHalts).toBe(1);
  });

  it('a resumed row for the same halt time wins over the row still reading Halted', () => {
    const out = summarizeTradingHalts({ halts: [
      halt('WXYZ', '2026-09-30T16:00:00.000Z', null),
      halt('WXYZ', '2026-09-30T16:00:00.000Z', '2026-09-30T16:05:00.000Z'),
    ] }, '2026-09-30T20:00:00.000Z') as any;
    expect(out.activeHalts).toEqual([]);
  });

  it('the symbol history says the same', () => {
    const out = summarizeSymbolTradingHalts({ symbol: 'LQDA', history: feed.filter((h) => h.symbol === 'LQDA') }) as any;
    expect(out.summary.currentlyHalted).toBe(false);
    expect(out.activeHalt).toBeNull();
    const still = summarizeSymbolTradingHalts({ symbol: 'ABCD', history: feed.filter((h) => h.symbol === 'ABCD') }) as any;
    expect(still.summary.currentlyHalted).toBe(true);
    expect(still.activeHalt.haltTime).toBe('2026-09-30T18:00:00.000Z');
  });
});

describe('a partial halts answer', () => {
  const HALT = {
    symbol: 'AAPL', name: 'Apple Inc.', market: 'NASDAQ', haltTime: '2026-10-08T18:30:00.000Z', haltCode: 'T1',
    haltDescription: 'News Pending', resumptionTime: null, status: 'Halted', source: 'NASDAQ',
  };
  const note = /The NYSE halt feed could not be read/;

  it('the market summary carries partial, the feed and a note, so the list is never read as complete', () => {
    const out = summarizeTradingHalts({ halts: [HALT], summary: {}, partial: true, unavailable: ['NYSE'] }, '2026-10-08T20:00:00Z') as any;
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['NYSE']);
    expect(out.partialNote).toMatch(note);
  });

  it('an empty partial answer is not "no halts": the note comes with it', () => {
    const out = summarizeTradingHalts({ halts: [], summary: { totalHalts: 0 }, partial: true, unavailable: ['NYSE'] }) as any;
    expect(out.partial).toBe(true);
    expect(out.partialNote).toMatch(note);
  });

  it('the symbol summary too, with or without its history', () => {
    const withRows = summarizeSymbolTradingHalts({
      symbol: 'AAPL', history: [{ haltTime: HALT.haltTime, code: 'T1', description: 'News Pending', market: 'NASDAQ', source: 'NASDAQ', resumptionTime: null }],
      summary: {}, partial: true, unavailable: ['NYSE'],
    }) as any;
    expect(withRows.partialNote).toMatch(note);
    const empty = summarizeSymbolTradingHalts({ symbol: 'F', history: [], summary: { totalHalts: 0 }, partial: true, unavailable: ['NYSE'] }) as any;
    expect(empty.partial).toBe(true);
    expect(empty.partialNote).toMatch(note);
  });

  it('a complete answer carries no partial fields (the control)', () => {
    const out = summarizeTradingHalts({ halts: [HALT], summary: {} }, '2026-10-08T20:00:00Z') as any;
    expect('partial' in out).toBe(false);
    expect('partialNote' in out).toBe(false);
  });

  it('the fields survive the wire sanitizer the tools publish through', async () => {
    const { sanitizeMcpWireOutput } = await import('../helpers.js');
    const out = sanitizeMcpWireOutput(summarizeTradingHalts({ halts: [], summary: {}, partial: true, unavailable: ['NYSE'] })) as any;
    expect(out.partial).toBe(true);
    expect(out.unavailable).toEqual(['NYSE']);
    expect(out.partialNote).toMatch(note);
  });
});

describe('currentlyHalted when a feed could not be read (review)', () => {
  const resumed = { haltTime: '2026-10-06T14:00:00.000Z', resumptionTime: '2026-10-06T14:05:00.000Z', code: 'LUDP', description: 'Volatility Trading Pause', market: 'NYSE', source: 'NYSE' };
  const active = { haltTime: '2026-10-08T18:30:00.000Z', resumptionTime: null, code: 'T1', description: 'News Pending', market: 'NYSE', source: 'NYSE' };

  it('only resumed halts in the feed that answered, the other unread: unknown (null), never false', () => {
    const out = summarizeSymbolTradingHalts({ symbol: 'AAPL', history: [resumed], summary: {}, partial: true, unavailable: ['NASDAQ'] }) as any;
    expect(out.summary.currentlyHalted).toBeNull();
    expect(out.activeHalt).toBeNull();
  });

  it('an empty partial answer: unknown too, stated (the key present and null)', () => {
    const out = summarizeSymbolTradingHalts({ symbol: 'AAPL', history: [], summary: { totalHalts: 0 }, partial: true, unavailable: ['NASDAQ'] }) as any;
    expect('currentlyHalted' in out.summary).toBe(true);
    expect(out.summary.currentlyHalted).toBeNull();
  });

  it('an active halt in the feed that answered is a fact (true) even when the other was unread', () => {
    const out = summarizeSymbolTradingHalts({ symbol: 'AAPL', history: [active], summary: {}, partial: true, unavailable: ['NASDAQ'] }) as any;
    expect(out.summary.currentlyHalted).toBe(true);
  });

  it('a complete answer with only resumed halts: false (the control)', () => {
    const out = summarizeSymbolTradingHalts({ symbol: 'AAPL', history: [resumed], summary: {} }) as any;
    expect(out.summary.currentlyHalted).toBe(false);
  });
});
