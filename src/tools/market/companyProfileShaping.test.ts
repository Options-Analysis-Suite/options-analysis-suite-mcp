import { describe, expect, it } from 'bun:test';
import { shapeCompanyProfileResponse } from './companyProfileShaping.js';

describe('shapeCompanyProfileResponse', () => {
  it('normalizes raw company profile fields into assistant-friendly keys', () => {
    const shaped = shapeCompanyProfileResponse({
      symbol: 'AAPL',
      company_name: 'Apple Inc.',
      sector: 'Technology',
      industry: 'Consumer Electronics',
      exchange: 'NASDAQ Global Select',
      exchange_short: 'NASDAQ',
      country: 'US',
      currency: 'USD',
      mkt_cap: 3150000000000,
      beta: 1.18493,
      pe_ratio_ttm: 29.87654,
      shares_outstanding: 15230000000,
      free_float_pct: 99.1,
      free_float_shares: 15100000000,
      vol_avg: 61234000,
      last_div: 0.25,
      price_range: '164.08-260.1',
      ipo_date: '1980-12-12',
      ceo: 'Tim Cook',
      full_time_employees: 161000,
      website: 'https://www.apple.com',
      cik: '0000320193',
      is_etf: false,
      is_actively_trading: true,
      description: 'A'.repeat(520),
      image: 'https://example.com/logo.png',
      updated_at: '2026-03-27T00:00:00.000Z',
    }) as Record<string, any>;

    expect(shaped.symbol).toBe('AAPL');
    expect(shaped.companyName).toBe('Apple Inc.');
    expect(shaped.marketCap).toBe(3150000000000);
    expect(shaped.beta).toBe(1.18);
    expect(shaped.peRatioTtm).toBe(29.88);
    expect(shaped.freeFloat).toBe(15100000000);
    expect(shaped.freeFloatPct).toBe(99.1);
    expect(shaped.avgVolume).toBe(61234000);
    expect(shaped.isEtf).toBe(false);
    expect(shaped.isActivelyTrading).toBe(true);
    expect(shaped.description.endsWith('...')).toBe(true);
    expect(shaped._description_truncated).toBe(true);
  });

  it('handles sparse or error payloads safely', () => {
    const shaped = shapeCompanyProfileResponse({
      symbol: 'UNKNOWN',
      error: 'No company profile available for this symbol',
      description: null,
      shares_outstanding: null,
      free_float_pct: null,
      free_float_shares: null,
    }) as Record<string, any>;

    expect(shaped.symbol).toBe('UNKNOWN');
    expect(shaped.companyName).toBeNull();
    expect(shaped.freeFloatPct).toBeNull();
    expect(shaped.description).toBeNull();
    expect(shaped.error).toBe('No company profile available for this symbol');
  });


  it('returns null for missing payloads so toolHandler can emit a no-data message', () => {
    expect(shapeCompanyProfileResponse(null)).toBeNull();
  });

});
