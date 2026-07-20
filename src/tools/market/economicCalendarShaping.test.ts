import { describe, expect, test } from 'bun:test';
import { summarizeEconomicCalendar } from './economicCalendarShaping.js';

describe('summarizeEconomicCalendar', () => {
  test('focuses the default view on higher-signal macro catalysts and removes duplicates', () => {
    const payload = [
      {
        date: '2026-03-27T01:00:00+00:00',
        event: 'Producer Price Index YoY',
        impact: 'Low',
        country: 'PH',
        currency: 'PHP',
      },
      {
        date: '2026-03-27T01:00:00+00:00',
        event: 'Producer Price Index YoY',
        impact: 'Low',
        country: 'PH',
        currency: 'PHP',
        actual: 1.4,
      },
      {
        date: '2026-03-27T00:01:00+00:00',
        event: 'Consumer Confidence (Mar)',
        impact: 'Medium',
        country: 'UK',
        currency: 'GBP',
      },
      {
        date: '2026-03-28T12:30:00+00:00',
        event: 'Core PCE Price Index MoM',
        impact: 'High',
        country: 'US',
        currency: 'USD',
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'Non Farm Payrolls',
        impact: 'High',
        country: 'US',
        currency: 'USD',
      },
      {
        date: '2026-04-10T12:30:00+00:00',
        event: 'Consumer Price Index YoY',
        impact: 'High',
        country: 'US',
        currency: 'USD',
      },
      {
        date: '2026-04-16T11:45:00+00:00',
        event: 'ECB Interest Rate Decision',
        impact: 'High',
        country: 'EU',
        currency: 'EUR',
      },
    ];

    const result = summarizeEconomicCalendar(payload, 12, '2026-03-27T00:00:00+00:00') as {
      events: Array<Record<string, unknown>>;
      summary: Record<string, number>;
      _events_meta?: Record<string, unknown>;
    };

    expect(result.events.map((event) => event.event)).toEqual([
      'Core PCE Price Index MoM',
      'Non Farm Payrolls',
      'Consumer Price Index YoY',
      'ECB Interest Rate Decision',
    ]);
    expect(result.summary).toEqual({
      totalEvents: 6,
      selectedEvents: 4,
      highImpactEvents: 4,
      mediumImpactEvents: 1,
    });
    expect(result._events_meta).toMatchObject({
      focusedHigherSignal: true,
      duplicatesRemoved: 1,
      lowerSignalOmitted: 2,
    });
  });

  test('falls back to the next upcoming events when no strong macro catalyst cluster exists', () => {
    const payload = [
      {
        date: '2026-03-27T00:01:00+00:00',
        event: 'Car Production YoY (Feb)',
        impact: 'Low',
        country: 'UK',
        currency: 'GBP',
      },
      {
        date: '2026-03-27T03:30:00+00:00',
        event: 'Export Prices YoY (Feb)',
        impact: 'Low',
        country: 'SG',
        currency: 'SGD',
      },
      {
        date: '2026-03-27T04:00:00+00:00',
        event: 'Industrial Production YoY',
        impact: 'Low',
        country: 'TH',
        currency: 'THB',
      },
    ];

    const result = summarizeEconomicCalendar(payload, 12, '2026-03-27T00:00:00+00:00') as {
      events: Array<Record<string, unknown>>;
      summary: Record<string, number>;
      _events_meta?: Record<string, unknown>;
    };

    expect(result.events.map((event) => event.event)).toEqual([
      'Car Production YoY (Feb)',
      'Export Prices YoY (Feb)',
      'Industrial Production YoY',
    ]);
    expect(result.summary).toEqual({
      totalEvents: 3,
      selectedEvents: 3,
      highImpactEvents: 0,
      mediumImpactEvents: 0,
    });
    expect(result._events_meta).toBeUndefined();
  });

  test('preserves estimate and actual fields on selected events', () => {
    const payload = {
      events: [
        {
          date: '2026-03-28T12:30:00+00:00',
          event: 'Core PCE Price Index MoM',
          impact: 'High',
          country: 'US',
          currency: 'USD',
          estimate: 0.3,
          actual: 0.4,
          previous: 0.2,
          change: 0.2,
        },
      ],
    };

    const result = summarizeEconomicCalendar(payload, 12, '2026-03-27T00:00:00+00:00') as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events).toEqual([
      {
        date: '2026-03-28T12:30:00+00:00',
        event: 'Core PCE Price Index MoM',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 0.3,
        actual: 0.4,
        previous: 0.2,
        change: 0.2,
      },
    ]);
  });

  test('demotes subnational inflation rows below national macro catalysts', () => {
    const payload = [
      {
        date: '2026-03-30T06:00:00+00:00',
        event: 'CPI (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 0.2,
      },
      {
        date: '2026-03-30T08:00:00+00:00',
        event: 'Baden Wuerttemberg CPI MoM (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 0.2,
      },
      {
        date: '2026-03-30T08:00:00+00:00',
        event: 'Baden Wuerttemberg CPI YoY (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 1.8,
      },
      {
        date: '2026-03-30T08:00:00+00:00',
        event: 'Bavaria CPI MoM (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 0.2,
      },
      {
        date: '2026-04-01T12:15:00+00:00',
        event: 'ADP Employment Change (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 80,
        previous: 63,
      },
      {
        date: '2026-04-02T12:30:00+00:00',
        event: 'Initial Jobless Claims (Mar/28)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 213,
        previous: 210,
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'Non Farm Payrolls (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 48,
        previous: -92,
      },
    ];

    const result = summarizeEconomicCalendar(payload, 12, '2026-03-29T00:00:00+00:00') as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events.map((event) => event.event)).toEqual([
      'CPI (Mar)',
      'ADP Employment Change (Mar)',
      'Initial Jobless Claims (Mar/28)',
      'Non Farm Payrolls (Mar)',
    ]);
  });

  test('diversifies same-country macro variants so one release family does not dominate the default view', () => {
    const payload = [
      {
        date: '2026-03-30T06:00:00+00:00',
        event: 'CPI (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 0.2,
      },
      {
        date: '2026-03-30T12:00:00+00:00',
        event: 'CPI MoM (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        previous: 0.2,
      },
      {
        date: '2026-03-30T12:00:00+00:00',
        event: 'Inflation Rate YoY (Mar)',
        impact: 'High',
        country: 'DE',
        currency: 'EUR',
        estimate: 2.6,
        previous: 1.9,
      },
      {
        date: '2026-03-31T09:00:00+00:00',
        event: 'CPI (Mar)',
        impact: 'High',
        country: 'EU',
        currency: 'EUR',
        estimate: 102.1,
        previous: 100.71,
      },
      {
        date: '2026-04-01T12:15:00+00:00',
        event: 'ADP Employment Change (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 42,
        previous: 63,
      },
      {
        date: '2026-04-02T12:30:00+00:00',
        event: 'Continuing Jobless Claims (Mar/21)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 1825,
        previous: 1819,
      },
      {
        date: '2026-04-02T12:30:00+00:00',
        event: 'Initial Jobless Claims (Mar/28)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 215,
        previous: 210,
      },
      {
        date: '2026-04-02T12:30:00+00:00',
        event: 'Jobless Claims 4-Week Average (Mar/28)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 214,
        previous: 210.5,
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'Non Farm Payrolls (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 48,
        previous: -92,
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'Nonfarm Payrolls Private (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 51,
        previous: -86,
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'U-6 Unemployment Rate (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 8,
        previous: 7.9,
      },
      {
        date: '2026-04-03T12:30:00+00:00',
        event: 'Unemployment Rate (Mar)',
        impact: 'High',
        country: 'US',
        currency: 'USD',
        estimate: 4.5,
        previous: 4.4,
      },
    ];

    const result = summarizeEconomicCalendar(payload, 12, '2026-03-29T00:00:00+00:00') as {
      events: Array<Record<string, unknown>>;
    };

    expect(result.events.map((event) => event.event)).toEqual([
      'Inflation Rate YoY (Mar)',
      'CPI (Mar)',
      'ADP Employment Change (Mar)',
      'Initial Jobless Claims (Mar/28)',
      'Non Farm Payrolls (Mar)',
      'Unemployment Rate (Mar)',
    ]);
  });
});
