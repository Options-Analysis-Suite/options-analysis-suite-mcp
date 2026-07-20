import { describe, expect, test } from 'bun:test';
import { pickNewsCompanyProfile } from './news.js';

describe('pickNewsCompanyProfile', () => {
  test('prefers the raw company profile when available', () => {
    const profile = {
      company_name: 'State Street SPDR S&P 500 ETF Trust',
      description: 'ETF tracking the S&P 500 index.',
      is_etf: true,
    };

    expect(pickNewsCompanyProfile(profile, {
      company_profile: {
        company_name: 'Fallback Name',
      },
    })).toEqual(profile);
  });

  test('normalizes a primary camelCase company profile for ETF-aware ranking', () => {
    expect(pickNewsCompanyProfile({
      companyName: 'SPDR S&P 500 ETF Trust',
      descriptionText: 'ETF tracking the S&P 500 index.',
      isEtf: true,
    }, null)).toEqual({
      companyName: 'SPDR S&P 500 ETF Trust',
      descriptionText: 'ETF tracking the S&P 500 index.',
      isEtf: true,
      company_name: 'SPDR S&P 500 ETF Trust',
      description: 'ETF tracking the S&P 500 index.',
      is_etf: true,
    });
  });

  test('falls back to fundamentals company_profile and normalizes ETF flags', () => {
    expect(pickNewsCompanyProfile(null, {
      company_profile: {
        company_name: 'State Street Technology Select Sector SPDR ETF',
        sector: 'Financial Services',
        industry: 'Asset Management',
      },
    })).toEqual({
      company_name: 'State Street Technology Select Sector SPDR ETF',
      sector: 'Financial Services',
      industry: 'Asset Management',
      is_etf: true,
    });
  });

  test('supports normalized fundamentals summaries that use camelCase keys', () => {
    expect(pickNewsCompanyProfile(null, {
      company_profile: {
        companyName: 'SPDR S&P 500 ETF Trust',
        isEtf: true,
      },
    })).toEqual({
      companyName: 'SPDR S&P 500 ETF Trust',
      company_name: 'SPDR S&P 500 ETF Trust',
      isEtf: true,
      is_etf: true,
    });
  });

  test('falls back to fundamentals when the primary profile object has no usable company name', () => {
    expect(pickNewsCompanyProfile({
      symbol: 'SPY',
      exchange_short: 'AMEX',
    }, {
      company_profile: {
        company_name: 'State Street SPDR S&P 500 ETF Trust',
        description: 'ETF tracking the S&P 500 index.',
        is_etf: true,
      },
    })).toEqual({
      symbol: 'SPY',
      exchange_short: 'AMEX',
      company_name: 'State Street SPDR S&P 500 ETF Trust',
      description: 'ETF tracking the S&P 500 index.',
      is_etf: true,
    });
  });

  test('returns null when neither source contains a usable profile', () => {
    expect(pickNewsCompanyProfile(null, null)).toBeNull();
    expect(pickNewsCompanyProfile(null, { company_profile: null })).toBeNull();
  });
});
