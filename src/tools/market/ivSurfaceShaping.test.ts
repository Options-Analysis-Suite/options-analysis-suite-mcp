import { describe, expect, test } from 'bun:test';
import { summarizeIvSurface } from './ivSurfaceShaping.js';

describe('summarizeIvSurface', () => {
  test('builds term-structure and skew summaries from representative smile nodes', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      expirations: ['2026-04-01', '2026-04-08'],
      rowCount: 6,
      data: [
        { expiration: '2026-04-01', strike: 95, yte: 0.01, iv: 0.24, putIV: 0.26, callIV: 0.23 },
        { expiration: '2026-04-01', strike: 100, yte: 0.01, iv: 0.2, putIV: 0.21, callIV: 0.19 },
        { expiration: '2026-04-01', strike: 105, yte: 0.01, iv: 0.18, putIV: 0.19, callIV: 0.17 },
        { expiration: '2026-04-08', strike: 95, yte: 0.03, iv: 0.29, putIV: 0.31, callIV: 0.28 },
        { expiration: '2026-04-08', strike: 100, yte: 0.03, iv: 0.25, putIV: 0.26, callIV: 0.24 },
        { expiration: '2026-04-08', strike: 105, yte: 0.03, iv: 0.22, putIV: 0.23, callIV: 0.21 },
      ],
    };

    const summary = summarizeIvSurface(payload) as any;

    expect(summary.atmTermStructure).toEqual([
      { expiration: '2026-04-01', yte: 0.01, atmStrike: 100, atmIV: 0.2, atmIvSource: null, callIV: 0.19, putIV: 0.21 },
      { expiration: '2026-04-08', yte: 0.03, atmStrike: 100, atmIV: 0.25, atmIvSource: null, callIV: 0.24, putIV: 0.26 },
    ]);
    expect(summary.skewSummary).toEqual([
      {
        expiration: '2026-04-01',
        yte: 0.01,
        atmStrike: 100,
        atmIV: 0.2,
        atmIvSource: null,
        putStrike: 95,
        putRelativeStrike: 0.95,
        putIV: 0.26,
        callStrike: 105,
        callRelativeStrike: 1.05,
        callIV: 0.17,
        putCallSkew: 0.09,
      },
      {
        expiration: '2026-04-08',
        yte: 0.03,
        atmStrike: 100,
        atmIV: 0.25,
        atmIvSource: null,
        putStrike: 95,
        putRelativeStrike: 0.95,
        putIV: 0.31,
        callStrike: 105,
        callRelativeStrike: 1.05,
        callIV: 0.21,
        putCallSkew: 0.1,
      },
    ]);
    expect(summary.surfacePreview).toHaveLength(6);
    expect(summary.surfacePreview[0].bucket).toBe('put wing');
    expect(summary.surfacePreview[1].bucket).toBe('atm');
    expect(summary.surfacePreview[2].bucket).toBe('call wing');
  });

  test('skips the same-day expiry and samples the curve, like the chain', () => {
    // AAPL on 2026-09-16: 25 expirations on file, the first expiring that
    // same day at yte 0. The summary took the first six by date, so the
    // "term structure" ran 0 to 12 days with no 30, 60 or 90-day point, led
    // by an expiry whose wings read 80% to 180% and whose smoothed IV sat
    // outside both sides. The chain skips that expiry and spreads its six
    // across the curve; the surface now does the same, with the same rule.
    const row = (expiration: string, yte: number, strike: number, iv: number) => ({ expiration, strike, yte, iv, putIV: iv + 0.01, callIV: iv - 0.01 });
    const smile = (expiration: string, yte: number, iv: number) => [row(expiration, yte, 95, iv + 0.03), row(expiration, yte, 100, iv), row(expiration, yte, 105, iv - 0.02)];
    const dates: Array<[string, number]> = [
      ['2026-09-16', 0], ['2026-09-18', 2 / 365], ['2026-09-21', 5 / 365], ['2026-09-23', 7 / 365], ['2026-09-25', 9 / 365],
      ['2026-09-28', 12 / 365], ['2026-10-09', 23 / 365], ['2026-10-16', 30 / 365], ['2026-11-20', 65 / 365], ['2026-12-18', 93 / 365],
      ['2027-03-19', 184 / 365], ['2027-06-18', 275 / 365],
    ];
    const payload = {
      ticker: 'AAPL', date: '2026-09-16', spotPrice: 100,
      expirations: dates.map(([d]) => d),
      // Rows arrive LATEST FIRST, so a picker that trusts insertion order
      // takes 09-23 for the 0-7 day bucket instead of the nearest, 09-18.
      data: dates.flatMap(([d, yte], i) => smile(d, yte, 0.2 + i * 0.001)).reverse(),
    };

    const summary = summarizeIvSurface(payload) as any;
    expect(summary.expirationCount).toBe(12);
    expect(summary.expirations).toEqual(['2026-09-18', '2026-09-25', '2026-10-09', '2026-11-20', '2026-12-18', '2027-03-19']);
    expect(summary.atmTermStructure.map((e: any) => e.expiration)).toEqual(summary.expirations);
    expect(summary.skewSummary.map((e: any) => e.expiration)).toEqual(summary.expirations);
    expect(summary.surfacePreview.map((n: any) => n.expiration)).not.toContain('2026-09-16');
    expect(summary._surface_meta).toMatchObject({ preview: true, expirations: 6, sampled_across_curve: true, same_day_skipped: true });

    // With nothing later on file the same-day expiry is the whole surface.
    const onlySameDay = summarizeIvSurface({ ...payload, expirations: ['2026-09-16'], data: smile('2026-09-16', 0, 0.9) }) as any;
    expect(onlySameDay.expirations).toEqual(['2026-09-16']);
    expect(onlySameDay.atmTermStructure).toHaveLength(1);
    expect(onlySameDay._surface_meta.same_day_skipped).toBe(false);

    // A row set without yte cannot be same-day and is sampled by date order.
    const noYte = summarizeIvSurface({ ...payload, data: payload.data.map(({ yte: _yte, ...rest }) => rest) }) as any;
    expect(noYte.expirations).toHaveLength(6);
    expect(noYte.expirations[0]).toBe('2026-09-16');

    // An expiration whose rows carry no yte, among dated ones, ranks last and
    // is kept: unknown is not same-day. Treating it as zero days would drop it.
    const mixed = summarizeIvSurface({
      ...payload,
      data: [...smile('2026-09-16', 0, 0.9), ...smile('2026-09-18', 2 / 365, 0.2), ...smile('2026-10-16', 30 / 365, 0.21),
        ...smile('2027-06-18', 0, 0.22).map(({ yte: _yte, ...rest }) => rest)],
    }) as any;
    expect(mixed.expirations).toEqual(['2026-09-18', '2026-10-16', '2027-06-18']);
  });

  test('keeps an unusable side IV null and withholds a skew it cannot support', () => {
    // The proxy bands all three stored IVs (capIv: finite, above 0, at most
    // 5) and the description says a side outside it reads as null. The skew
    // summary instead fell back to the smoothed value for a missing side, so
    // stored (smv 0.3, call 0, put 0) produced putIV 0.3, callIV 0.3 and a
    // skew of 0, and stored (6, 7, 8), with no usable IV at all, produced a
    // skew of 0 too. Preview and ATM rows omitted the field rather than
    // carrying null. Side IVs are now the side IVs, null included; the skew
    // is put mid minus call mid only when both are usable, otherwise null.
    const node = (strike: number, iv: number | null, putIV: number | null, callIV: number | null) => ({ expiration: '2026-04-01', strike, yte: 0.05, iv, putIV, callIV });
    const smoothedOnly = summarizeIvSurface({
      ticker: 'SPY', date: '2026-03-26', spotPrice: 100,
      data: [node(95, 0.32, null, null), node(100, 0.3, null, null), node(105, 0.29, null, null)],
    }) as any;
    expect(smoothedOnly.skewSummary).toEqual([{
      expiration: '2026-04-01', yte: 0.05, atmStrike: 100, atmIV: 0.3, atmIvSource: null,
      putStrike: 95, putRelativeStrike: 0.95, putIV: null, callStrike: 105, callRelativeStrike: 1.05, callIV: null, putCallSkew: null,
    }]);
    expect(smoothedOnly.atmTermStructure).toEqual([{ expiration: '2026-04-01', yte: 0.05, atmStrike: 100, atmIV: 0.3, atmIvSource: null, callIV: null, putIV: null }]);
    for (const row of smoothedOnly.surfacePreview) {
      expect(row).toHaveProperty('putIV', null);
      expect(row).toHaveProperty('callIV', null);
      expect(typeof row.iv).toBe('number');
    }

    // One side usable: the side is reported, the skew still needs both.
    const oneSide = summarizeIvSurface({
      ticker: 'SPY', date: '2026-03-26', spotPrice: 100,
      data: [node(95, 0.32, 0.34, null), node(100, 0.3, 0.31, 0.29), node(105, 0.29, null, 0.27)],
    }) as any;
    expect(oneSide.skewSummary[0]).toMatchObject({ putIV: 0.34, callIV: 0.27, putCallSkew: 0.07 });
    const putOnly = summarizeIvSurface({
      ticker: 'SPY', date: '2026-03-26', spotPrice: 100,
      data: [node(95, 0.32, 0.34, null), node(100, 0.3, 0.31, 0.29), node(105, 0.29, null, null)],
    }) as any;
    expect(putOnly.skewSummary[0]).toMatchObject({ putIV: 0.34, callIV: null, putCallSkew: null });

    // The skew is the difference of the UNROUNDED side mids, rounded once:
    // 0.300049 - 0.299951 is 0.0001, not 0.3 - 0.3.
    const fine = summarizeIvSurface({
      ticker: 'SPY', date: '2026-03-26', spotPrice: 100,
      data: [node(95, 0.3, 0.300049, null), node(100, 0.3, 0.3, 0.3), node(105, 0.3, null, 0.299951)],
    }) as any;
    expect(fine.skewSummary[0]).toMatchObject({ putIV: 0.3, callIV: 0.3, putCallSkew: 0.0001 });

    // Nothing usable anywhere: every IV is null and no skew is invented.
    const nothing = summarizeIvSurface({
      ticker: 'SPY', date: '2026-03-26', spotPrice: 100,
      data: [node(95, null, null, null), node(100, null, null, null), node(105, null, null, null)],
    }) as any;
    expect(nothing.skewSummary[0]).toMatchObject({ atmIV: null, putIV: null, callIV: null, putCallSkew: null });
    expect(nothing.atmTermStructure[0]).toMatchObject({ atmIV: null, callIV: null, putIV: null });
    expect(nothing.surfacePreview.every((row: any) => row.iv === null && row.putIV === null && row.callIV === null)).toBe(true);
  });

  test('names the source of every blended iv and the basis of its skew', () => {
    // The proxy's `iv` is capIv(smv) ?? capIv(c_mid) ?? capIv(p_mid) and it
    // carries the raw smv beside it. A node showed iv 0.394 between putIV
    // 0.414 and callIV 0.2475 with nothing saying which of the three it was;
    // the chain names its sources, so the surface does too. And the two
    // tools publish a `putCallSkew` that means different things (fixed 95%
    // and 105% strikes here, 25-delta wings there; fivefold apart on the same
    // expiration), so each says its basis beside the number.
    const node = (strike: number, smv: number | null, putIV: number | null, callIV: number | null) => {
      const usable = (v: number | null) => (v !== null && v > 0 && v <= 5 ? v : null);
      return { expiration: '2026-10-02', strike, yte: 16 / 365, smv, iv: usable(smv) ?? usable(callIV) ?? usable(putIV), putIV: usable(putIV), callIV: usable(callIV) };
    };
    // APT on 2026-09-16, spot 5.25: 4.5 (smv 1.063, both mids 0), 5.0 (smv
    // 2.587, call mid 3.158, put mid 0), 5.5 (smv 8.112, both mids 0), 6.0
    // (smv 9.491, call mid 1.39, put mid 0).
    const apt = summarizeIvSurface({
      ticker: 'APT', date: '2026-09-16', spotPrice: 5.25,
      data: [node(4.5, 1.063, 0, 0), node(5, 2.587, 0, 3.15781), node(5.5, 8.112, 0, 0), node(6, 9.491, 0, 1.3897)],
    }) as any;
    const byBucket = Object.fromEntries(apt.surfacePreview.map((row: any) => [row.bucket, row]));
    expect(byBucket['put wing']).toMatchObject({ strike: 4.5, iv: 1.063, ivSource: 'smoothed', putIV: null, callIV: null });
    expect(byBucket.atm).toMatchObject({ strike: 5, iv: 2.587, ivSource: 'smoothed', putIV: null, callIV: 3.1578 });
    expect(byBucket['call wing']).toMatchObject({ strike: 5.5, iv: null, ivSource: null, putIV: null, callIV: null });
    expect(apt.atmTermStructure[0]).toMatchObject({ atmIV: 2.587, atmIvSource: 'smoothed' });
    expect(apt.skewSummary[0]).toMatchObject({ atmIV: 2.587, atmIvSource: 'smoothed', putIV: null, callIV: null, putCallSkew: null });
    // The wings are picked on either side of the ATM strike, never the ATM
    // strike itself: at APT's spot 5.25 the strike nearest 4.9875 is 5.0,
    // the ATM, so the put wing is 4.5. A basis that said only "nearest 95%"
    // sent a reader to 5.0.
    expect(apt.putCallSkewBasis).toBe('put-wing mid IV at the strike nearest 95% of spot among strikes below the ATM strike, minus call-wing mid IV at the strike nearest 105% of spot among strikes above it (the ATM strike is the one nearest spot and is never a wing; ties go to the lower strike); null when either wing\'s mid IV is unusable, and no skew row at all when a side has no strike beyond the ATM');

    // A side with no strike beyond the ATM has no wing, and the expiration
    // has no skew row at all; that is a different outcome from a wing whose
    // IV is unusable (a row with putCallSkew null), and the basis says both.
    const oneSided = summarizeIvSurface({
      ticker: 'APT', date: '2026-09-16', spotPrice: 5,
      data: [node(5, 0.4, 0.4, 0.4), node(5.5, 0.4, 0.4, 0.4)],
    }) as any;
    expect(oneSided.skewSummary).toEqual([]);
    expect(oneSided.atmTermStructure).toHaveLength(1);

    // APT on 2026-09-17, spot 5.27, the 10-09 expiry with dollar strikes: the
    // ATM is 5, the wings nearest 5.0065 and 5.5335 on either side are 4 and
    // 6, at 76% and 114% of spot. The preview said so (relativeStrike); the
    // skew row, read alone, called that a "95%/105%" skew. Each wing on the
    // row now says how far from spot it actually sits.
    const dollarStrikes = summarizeIvSurface({
      ticker: 'APT', date: '2026-09-17', spotPrice: 5.27,
      data: [
        { ...node(4, 1.276, 1.4608, 0), expiration: '2026-10-09' },
        { ...node(5, 1.276, 0.5275, 1.6394), expiration: '2026-10-09' },
        { ...node(6, 1.276, 1.7478, 0.9802), expiration: '2026-10-09' },
      ],
    }) as any;
    expect(dollarStrikes.skewSummary[0]).toMatchObject({
      atmStrike: 5, putStrike: 4, putRelativeStrike: 0.759, callStrike: 6, callRelativeStrike: 1.139, putIV: 1.4608, callIV: 0.9802, putCallSkew: 0.4806,
    });

    // The fallbacks, in the proxy's order: no usable smv and a usable call
    // mid is the call mid; only a usable put mid is the put mid.
    const fallbacks = summarizeIvSurface({
      ticker: 'APT', date: '2026-09-16', spotPrice: 5.25,
      data: [node(4.5, 0, 0.5, 0), node(5, 9.5, 0.4, 0.45), node(5.5, null, 0.6, 0)],
    }) as any;
    const fb = Object.fromEntries(fallbacks.surfacePreview.map((row: any) => [row.bucket, row]));
    expect(fb['put wing']).toMatchObject({ iv: 0.5, ivSource: 'put-mid' });
    expect(fb.atm).toMatchObject({ iv: 0.45, ivSource: 'call-mid' });
    expect(fb['call wing']).toMatchObject({ iv: 0.6, ivSource: 'put-mid' });
    // A row without the raw smv beside it cannot be placed: value kept,
    // source null.
    const noSmv = summarizeIvSurface({
      ticker: 'APT', date: '2026-09-16', spotPrice: 5.25,
      data: [node(4.5, 0.3, 0.3, 0.3), node(5, 0.3, 0.3, 0.3), node(5.5, 0.3, 0.3, 0.3)].map(({ smv: _s, ...rest }) => rest),
    }) as any;
    expect(noSmv.surfacePreview.every((row: any) => row.iv === 0.3 && row.ivSource === null)).toBe(true);
  });

  test('handles sparse expirations without duplicating strikes', () => {
    const payload = {
      ticker: 'SPY',
      date: '2026-03-26',
      spotPrice: 100,
      expirations: ['2026-04-01'],
      data: [
        { expiration: '2026-04-01', strike: 100, yte: 0.01, iv: 0.2, putIV: 0.21, callIV: 0.19 },
        { expiration: '2026-04-01', strike: 103, yte: 0.01, iv: 0.205, putIV: 0.215, callIV: 0.195 },
      ],
    };

    const summary = summarizeIvSurface(payload) as any;

    expect(summary.atmTermStructure).toEqual([
      { expiration: '2026-04-01', yte: 0.01, atmStrike: 100, atmIV: 0.2, atmIvSource: null, callIV: 0.19, putIV: 0.21 },
    ]);
    expect(summary.skewSummary).toEqual([]);
    expect(summary.surfacePreview).toEqual([
      { expiration: '2026-04-01', bucket: 'atm', strike: 100, relativeStrike: 1, yte: 0.01, iv: 0.2, ivSource: null, putIV: 0.21, callIV: 0.19 },
      { expiration: '2026-04-01', bucket: 'call wing', strike: 103, relativeStrike: 1.03, yte: 0.01, iv: 0.205, ivSource: null, putIV: 0.215, callIV: 0.195 },
    ]);
  });
});
