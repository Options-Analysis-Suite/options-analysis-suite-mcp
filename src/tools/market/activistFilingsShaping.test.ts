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

describe('filings whose details could not be read', () => {
  it('never reads as "no current holders": the unparsed count and a note travel with the empty snapshot', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'ABC',
      filings: [
        // The filing document and its header could not be fetched: no filer name, no ownership figures.
        { formType: 'SC 13D', filerName: null, filingDate: '2026-10-01', ownershipStatus: 'unknown' } as any,
        { formType: '13G/A', filerName: 'Example Fund', filingDate: '2026-09-01', ownershipStatus: 'unknown' } as any,
      ],
    }) as Record<string, any>;
    expect(shaped.currentHolderSnapshot).toEqual([]);
    expect(shaped.summary.unparsedFilings).toBe(2);
    expect(shaped.holdersNote).toMatch(/2 of the filings could not be read/);
    expect(shaped._snapshotStatus).toBeUndefined();
  });

  // The proxy names the filings it could not read in full (partial, unavailable).
  // A document read whose header was cut off by the deadline carries the ownership figures with no filer.
  it('a filing the proxy names unread, with figures but no filer: never "No current above-threshold holders"', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'PRU',
      filings: [{ formType: '13G', filerName: null, filingDate: '2026-10-08', percentOwnership: 6.2, sharesOwned: 5000, ownershipStatus: 'above_threshold', accessionNumber: '0000000000-26-000001' } as any],
      partial: true,
      unavailable: ['0000000000-26-000001'],
    }) as Record<string, any>;
    expect(shaped._snapshotStatus).toBeUndefined();
    expect(shaped.summary.unparsedFilings).toBe(1);
    expect(shaped.holdersNote).toMatch(/^1 of the filings could not be read in full, so their holder or ownership is unknown/);
    expect(shaped.partial).toBe(true);
    expect(shaped.unavailable).toEqual(['0000000000-26-000001']);
  });

  it('an above-threshold filing with no filer name is never "no holders", partial or not (a header SEC has no copy of)', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'PRU',
      filings: [{ formType: '13G', filerName: null, filingDate: '2026-10-08', percentOwnership: 6.2, ownershipStatus: 'above_threshold' } as any],
    }) as Record<string, any>;
    expect(shaped._snapshotStatus).toBeUndefined();
    expect(shaped.summary.unparsedFilings).toBe(1);
    expect('partial' in shaped).toBe(false);
  });

  it('an unread filing counts once, however many ways it is incomplete', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'PRU',
      filings: [
        { formType: '13D', filerName: null, filingDate: '2026-10-08', ownershipStatus: 'unknown', accessionNumber: 'a-1' } as any,
        { formType: '13G', filerName: 'Holder', filingDate: '2026-10-07', percentOwnership: 9, ownershipStatus: 'above_threshold', accessionNumber: 'a-2' } as any,
      ],
      partial: true,
      unavailable: ['a-1'],
    }) as Record<string, any>;
    expect(shaped.summary.unparsedFilings).toBe(1);
    expect(shaped.currentHolderSnapshot.map((f: any) => f.filerName)).toEqual(['Holder']);
  });

  it('every filing read: no unparsed count, no note (the control)', () => {
    const shaped = shapeActivistFilingsResponse({
      symbol: 'ABC',
      filings: [{ formType: '13G/A', filerName: 'Example Fund', filingDate: '2026-01-01', ownershipStatus: 'below_threshold' } as any],
    }) as Record<string, any>;
    expect('unparsedFilings' in shaped.summary).toBe(false);
    expect('holdersNote' in shaped).toBe(false);
  });
});
