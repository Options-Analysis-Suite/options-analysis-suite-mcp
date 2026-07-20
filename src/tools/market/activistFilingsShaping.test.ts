import { describe, expect, it } from 'bun:test';
import { shapeActivistFilingsResponse } from './activistFilingsShaping.js';

describe('shapeActivistFilingsResponse', () => {
  it('prioritizes current above-threshold holder snapshots over recent below-threshold amendments', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'TSLA',
      companyName: 'Tesla, Inc.',
      activistCount: 4,
      filings: [
        {
          formType: '13G/A',
          filerName: 'The Vanguard Group',
          filingDate: '2026-03-27',
          sharesOwned: 0,
          percentOwnership: 0,
          ownershipStatus: 'below_threshold',
          purpose: 'below_threshold',
          description: 'Dropped below 5%',
        },
        {
          formType: '13G/A',
          filerName: 'Elon R. Musk',
          filingDate: '2025-11-10',
          sharesOwned: 717323438,
          percentOwnership: 20.3,
          ownershipStatus: 'above_threshold',
          purpose: 'ownership',
          description: 'Founder ownership',
        },
        {
          formType: '13G/A',
          filerName: 'The Vanguard Group',
          filingDate: '2024-02-13',
          sharesOwned: 229805491,
          percentOwnership: 7.23,
          ownershipStatus: 'above_threshold',
          purpose: 'institutional',
          description: 'Institutional owner',
        },
        {
          formType: '13G/A',
          filerName: 'BlackRock, Inc.',
          filingDate: '2024-01-29',
          sharesOwned: 188797465,
          percentOwnership: 5.9,
          ownershipStatus: 'above_threshold',
          purpose: 'institutional',
          description: 'Institutional owner',
        },
      ],
    }) as Record<string, any>;

    expect(shaped.summary).toEqual({
      uniqueFilers: 4,
      totalFilings: 4,
      currentAboveThresholdFilers: 2,
      recentBelowThresholdFilings: 1,
    });
    expect(shaped.currentHolderSnapshot).toHaveLength(2);
    expect(shaped.currentHolderSnapshot[0].filerName).toBe('Elon R. Musk');
    expect(shaped.currentHolderSnapshot[1].filerName).toBe('BlackRock, Inc.');
    expect(shaped.recentBelowThreshold).toHaveLength(1);
    expect(shaped.recentBelowThreshold[0].filerName).toBe('The Vanguard Group');
    expect(shaped._belowThresholdMeta).toEqual({ summarizedSeparately: true });
  });

  it('returns a stable empty current-holder view when only below-threshold filings exist', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'ABC',
      companyName: 'Example Co.',
      filings: [
        {
          formType: '13G/A',
          filerName: 'Example Fund',
          filingDate: '2026-01-01',
          sharesOwned: 0,
          percentOwnership: 0,
          ownershipStatus: 'below_threshold',
          purpose: 'below_threshold',
          description: 'Dropped below 5%',
        },
      ],
    }) as Record<string, any>;

    expect(shaped.currentHolderSnapshot).toEqual([]);
    expect(shaped.recentBelowThreshold).toHaveLength(1);
    expect(shaped._snapshotStatus).toBe('No current above-threshold holders');
  });
});
