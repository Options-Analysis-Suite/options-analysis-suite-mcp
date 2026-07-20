import { describe, expect, test } from 'bun:test';
import {
  shapeDividendHistory,
  shapeSplitHistory,
  shapeIpoCalendar,
  shapeDividendCalendar,
  shapeSplitCalendar,
} from './corporateActionsShaping.js';

describe('corporateActionsShaping', () => {
  test('shapeDividendHistory trims rows and preserves dividend metadata', () => {
    const payload = {
      symbol: 'AAPL',
      historical: [
        { date: '2026-02-10', dividend: 0.26, adjDividend: 0.26, recordDate: '2026-02-12', paymentDate: '2026-02-20', declarationDate: '2026-01-30', ignored: 'x' },
        { date: '2025-11-10', dividend: 0.25, adjDividend: 0.25, recordDate: '2025-11-12', paymentDate: '2025-11-20', declarationDate: '2025-10-30' },
      ],
    };

    expect(shapeDividendHistory(payload, 1)).toEqual({
      symbol: 'AAPL',
      historical: [
        {
          date: '2026-02-10',
          dividend: 0.26,
          adjDividend: 0.26,
          recordDate: '2026-02-12',
          paymentDate: '2026-02-20',
          declarationDate: '2026-01-30',
        },
      ],
      _historical_meta: { showing: 1, total: 2, truncated: true },
    });
  });

  test('shapeSplitHistory trims rows and keeps ratio fields', () => {
    const payload = {
      symbol: 'TSLA',
      historical: [
        { date: '2022-08-25', numerator: 3, denominator: 1, label: '3:1 split', ignored: true },
        { date: '2020-08-31', numerator: 5, denominator: 1, label: '5:1 split' },
      ],
    };

    expect(shapeSplitHistory(payload, 1)).toEqual({
      symbol: 'TSLA',
      historical: [
        { date: '2022-08-25', numerator: 3, denominator: 1, label: '3:1 split' },
      ],
      _historical_meta: { showing: 1, total: 2, truncated: true },
    });
  });

  test('shapeIpoCalendar filters by symbol and trims rows', () => {
    const rows = [
      { date: '2026-04-01', company: 'Acme Corp', symbol: 'ACME', exchange: 'NASDAQ', actions: 'Priced', priceRange: '$18-$20', shares: 10000000, marketCap: 900000000, ignored: 'x' },
      { date: '2026-04-02', company: 'Beta Inc', symbol: 'BETA', exchange: 'NYSE', actions: 'Filed', priceRange: '$12-$14', shares: 5000000, marketCap: 300000000 },
    ];

    expect(shapeIpoCalendar(rows, 10, 'ACME')).toEqual({
      ipoCalendar: [
        {
          date: '2026-04-01',
          company: 'Acme Corp',
          symbol: 'ACME',
          exchange: 'NASDAQ',
          actions: 'Priced',
          priceRange: '$18-$20',
          shares: 10000000,
          marketCap: 900000000,
        },
      ],
    });
  });

  test('shapeDividendCalendar trims and notes omitted events', () => {
    const rows = [
      { date: '2026-04-01', symbol: 'AAPL', dividend: 0.26, adjDividend: 0.26, recordDate: '2026-04-03', paymentDate: '2026-04-10', declarationDate: '2026-03-20' },
      { date: '2026-04-02', symbol: 'MSFT', dividend: 0.80, adjDividend: 0.80, recordDate: '2026-04-04', paymentDate: '2026-04-11', declarationDate: '2026-03-21' },
    ];

    expect(shapeDividendCalendar(rows, 1)).toEqual({
      dividendCalendar: [
        {
          date: '2026-04-01',
          symbol: 'AAPL',
          dividend: 0.26,
          adjDividend: 0.26,
          recordDate: '2026-04-03',
          paymentDate: '2026-04-10',
          declarationDate: '2026-03-20',
        },
      ],
      _dividendCalendar_meta: { showing: 1, total: 2, truncated: true },
    });
  });

  test('shapeSplitCalendar trims and filters by symbol', () => {
    const rows = [
      { date: '2026-05-01', symbol: 'NVDA', numerator: 10, denominator: 1, label: '10:1 split' },
      { date: '2026-05-02', symbol: 'AAPL', numerator: 4, denominator: 1, label: '4:1 split' },
    ];

    expect(shapeSplitCalendar(rows, 5, 'NVDA')).toEqual({
      splitCalendar: [
        { date: '2026-05-01', symbol: 'NVDA', numerator: 10, denominator: 1, label: '10:1 split' },
      ],
    });
  });
});
