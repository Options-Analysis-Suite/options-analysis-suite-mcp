import { describe, expect, test } from 'bun:test';
import { LiveApiError } from '../../proxy/liveApiClient.js';
import { newYorkDate, newYorkDateTime, register } from './eodDealerPositioning.js';

// Fifteenth run: get_dealer_positioning {symbol: "KBE", date: "2026-09-18"}
// at 20:10Z on 2026-09-18 answered "No exposure data found for KBE on
// 2026-09-18. Retrying will not succeed." - the proxy's NOT_FOUND carries
// retryable false for every missing date (proxy/routes/eod.ts), and the
// text was word for word the one a Sunday gets. That session's file lands
// overnight; the same call succeeds the next morning. The tool now tells a
// session that is not on file YET from one that never will be, by the
// clock: a weekday date is not final until 09:30 New York on the next
// calendar day (review: at 00:30 EDT on the 19th, before the
// import, the 18th still read "Retrying will not succeed."). That cutoff is
// this tool's, not the producer's: the import is scheduled 01:00 ET
// Tue-Sat, the regime cron's retry loop re-pulls it in half-hour steps to
// about 06:00 ET, and the exposure summary for every session from
// 2026-09-08 to 09-17 landed 02:31-02:34 ET the next day
// (option_ticker_snapshots.exposure_computed_at), but the loop's waits are
// not a deadline and a catch-up import runs as long as it has days (review:
// eight simulated 20-minute catch-ups reached 08:40 ET, past
// the 08:00 that commit called the window's end).

function capture() {
  const tools: Array<{ name: string; handler: Function }> = [];
  const server = { registerTool(name: string, _config: unknown, handler: Function) { tools.push({ name, handler }); } };
  return { tools, server };
}

const notFound = (message: string) => ({
  get: async () => { throw new LiveApiError(message, 404, 'NOT_FOUND', false, undefined, undefined); },
} as any);

const NOT_ON_FILE_YET = 'API error (NOT_FOUND): No exposure data found for KBE on 2026-09-18. That session is not on file. If 2026-09-18 is a trading session, its equity import is scheduled for 01:00 US Eastern the next day and usually lands about 02:30, so ask again after that; this tool treats the answer as not final until 09:30 US Eastern that day. A market holiday has no session, and a symbol with no exposure summary (a futures contract, or one with no near-term options) stays not-found. This may be retried.';
const FINAL = 'API error (NOT_FOUND): No exposure data found for KBE on 2026-09-18. Retrying will not succeed.';

describe('newYorkDate', () => {
  test('is the calendar date in New York, across the UTC midnight and both offsets', () => {
    expect(newYorkDate(new Date('2026-09-18T03:59:59Z'))).toBe('2026-09-17'); // 23:59:59 EDT
    expect(newYorkDate(new Date('2026-09-18T04:00:00Z'))).toBe('2026-09-18'); // 00:00 EDT
    expect(newYorkDate(new Date('2026-12-18T04:59:59Z'))).toBe('2026-12-17'); // 23:59:59 EST
    expect(newYorkDate(new Date('2026-12-18T05:00:00Z'))).toBe('2026-12-18'); // 00:00 EST
  });

  test('newYorkDateTime is the date and the minute on a 24-hour clock, sortable as text', () => {
    expect(newYorkDateTime(new Date('2026-09-19T04:00:00Z'))).toBe('2026-09-19T00:00'); // midnight is 00, not 24 or 12
    expect(newYorkDateTime(new Date('2026-09-19T04:30:00Z'))).toBe('2026-09-19T00:30');
    expect(newYorkDateTime(new Date('2026-09-19T11:59:59Z'))).toBe('2026-09-19T07:59');
    expect(newYorkDateTime(new Date('2026-09-19T12:00:00Z'))).toBe('2026-09-19T08:00');
    expect(newYorkDateTime(new Date('2026-09-19T13:30:00Z'))).toBe('2026-09-19T09:30');
    expect(newYorkDateTime(new Date('2026-09-18T16:00:00Z'))).toBe('2026-09-18T12:00'); // noon is 12, not 00
    expect(newYorkDateTime(new Date('2026-12-19T13:00:00Z'))).toBe('2026-12-19T08:00'); // EST
  });
});

describe('get_dealer_positioning - a session not on file yet is retryable, a session that never was is not', () => {
  const at = (iso: string) => () => new Date(iso);

  test('a weekday date that is today in New York or later says the file has not landed yet', async () => {
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-18T20:10:00Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND', retryable: true });
    // review: the proxy answers NOT_FOUND alike for an absent
    // row, an imported row with no exposure summary (a futures contract, a
    // name with no near-term options) and a weekday holiday, and the date
    // cannot tell them apart, so the sentence is conditional and names the
    // cases that stay not-found; retryable true is the possibility.
    expect(result.content[0].text).toBe(NOT_ON_FILE_YET);
    // Tomorrow, too: no file can exist for it yet.
    const later: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-21' });
    expect(later.structuredContent.retryable).toBe(true);
    expect(later.content[0].text).toContain('If 2026-09-21 is a trading session');
    // Seventeenth run: the window admits tomorrow's date, and "was a trading
    // session" read wrong for it (2026-09-22 asked for at 13:47 ET on 09-21).
    expect(later.content[0].text).not.toContain('was a trading session');
  });

  test('the session before the overnight import is still not final: 00:30 EDT the next day', async () => {
    // review, reproduced through the route: at 00:30 EDT on
    // 2026-09-19 the 18th's file is half an hour from its import and the
    // answer read "Retrying will not succeed."
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-19T04:30:00Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND', retryable: true });
    expect(result.content[0].text).toBe(NOT_ON_FILE_YET);
  });

  test('the cutoff is 09:30 New York on the next calendar day, in both offsets', async () => {
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-19T12:40:00Z')); // 08:40 EDT Saturday: the
    const open: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' }); // simulated catch-up's landing time
    expect(open.structuredContent.retryable).toBe(true);
    const edge = capture();
    register(edge.server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-19T13:29:59Z')); // 09:29:59 EDT
    expect((await edge.tools[0].handler({ symbol: 'KBE', date: '2026-09-18' }) as any).structuredContent.retryable).toBe(true);

    const closed = capture();
    register(closed.server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-19T13:30:00Z')); // 09:30 EDT: a failed
    const result: any = await closed.tools[0].handler({ symbol: 'KBE', date: '2026-09-18' }); // import is the description's caveat
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(result.content[0].text).toBe(FINAL);

    // EST: Friday 2026-12-18, asked for on the Saturday.
    const est = capture();
    register(est.server as any, notFound('No exposure data found for KBE on 2026-12-18'), at('2026-12-19T14:29:59Z')); // 09:29:59 EST
    expect((await est.tools[0].handler({ symbol: 'KBE', date: '2026-12-18' }) as any).structuredContent.retryable).toBe(true);
    const estClosed = capture();
    register(estClosed.server as any, notFound('No exposure data found for KBE on 2026-12-18'), at('2026-12-19T14:30:00Z')); // 09:30 EST
    expect((await estClosed.tools[0].handler({ symbol: 'KBE', date: '2026-12-18' }) as any).structuredContent.retryable).toBe(false);
  });

  test('a Friday asked for on Sunday is past its window even though no later session exists', async () => {
    // The window is the next CALENDAR day: Friday's import runs Saturday
    // 02:30 ET, so Sunday 01:00 ET is past it.
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-20T05:00:00Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(result.structuredContent).toMatchObject({ code: 'NOT_FOUND', retryable: false });
    expect(result.content[0].text).toBe(FINAL);
  });

  test('a weekend date, a past date and a request with no date keep the proxy\'s answer', async () => {
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-20'), at('2026-09-18T20:10:00Z'));
    for (const args of [{ symbol: 'KBE', date: '2026-09-20' }, { symbol: 'KBE', date: '2026-09-13' }, { symbol: 'KBE', date: '2026-09-11' }, { symbol: 'KBE' }]) {
      const result: any = await tools[0].handler(args);
      expect(result.structuredContent, JSON.stringify(args)).toMatchObject({ code: 'NOT_FOUND', retryable: false });
      expect(result.content[0].text, JSON.stringify(args)).toContain('Retrying will not succeed.');
      expect(result.content[0].text, JSON.stringify(args)).not.toContain('is a trading session');
    }
    // A weekend date inside its own window is still never a session.
    const saturday = capture();
    register(saturday.server as any, notFound('No exposure data found for KBE on 2026-09-19'), at('2026-09-19T20:00:00Z'));
    const result: any = await saturday.tools[0].handler({ symbol: 'KBE', date: '2026-09-19' });
    expect(result.structuredContent.retryable).toBe(false);
    expect(result.content[0].text).not.toContain('is a trading session');
  });

  test('the New York clock decides, not the UTC one', async () => {
    // 03:00Z on 09-19 is 23:00 EDT on 09-18: 09-18 is still today, and its
    // file is still expected overnight.
    const { tools, server } = capture();
    register(server as any, notFound('No exposure data found for KBE on 2026-09-18'), at('2026-09-19T03:00:00Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(result.structuredContent.retryable).toBe(true);
  });

  test('a future weekday beyond the proxy\'s date window says when the window reaches it', async () => {
    // Sixteenth run: {symbol: "KBE", date: "2026-09-21"} at 20:46Z on
    // 2026-09-18 answered "API error (INVALID_REQUEST): date must fall
    // inside the available data window 1990-01-01..2026-09-19. Retrying
    // will not succeed." The proxy's window ends one day past the current
    // UTC date (proxy/routes/eod.ts EOD_EXPOSURE_DATE_BOUNDS, maxFutureDays
    // 1) and moves with it, so the rejection of a future date is not
    // final, and the not-found rule never gets to run on it.
    const { tools, server } = capture();
    const rejected = { get: async () => { throw new LiveApiError('date must fall inside the available data window 1990-01-01..2026-09-19', 400, 'INVALID_REQUEST', false, undefined, undefined); } } as any;
    register(server as any, rejected, at('2026-09-18T20:46:30Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-21' });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_REQUEST', retryable: true });
    expect(result.content[0].text).toBe('API error (INVALID_REQUEST): date must fall inside the available data window 1990-01-01..2026-09-19. The window\'s upper edge moves forward with the UTC date, so 2026-09-21 can be asked for from 2026-09-20 UTC; if it is a trading session, its equity import usually lands about 02:30 US Eastern the next day, and this tool treats a not-found as not final until 09:30 US Eastern that day. A market holiday has no session. This may be retried.');
    // A week out: the day before it, whatever the gap.
    const far: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-25' });
    expect(far.structuredContent.retryable).toBe(true);
    expect(far.content[0].text).toContain('so 2026-09-25 can be asked for from 2026-09-24 UTC');
  });

  test('the day the window reaches a date is the date less one, whatever either clock says at UTC midnight', async () => {
    // review: subtracting the message's bound from THIS
    // server's clock used two clocks, and in the seconds around UTC
    // midnight they differ by a day. The proxy accepts a date once its UTC
    // day is at least the date less maxFutureDays, which is fixed at 1
    // (proxy/routes/eod.ts), so the first accepted day is a policy, not a
    // subtraction. The proxy rejected at 23:59:59Z (max 2026-09-19); this
    // server handled it at midnight: the answer is still 2026-09-20.
    const { tools, server } = capture();
    const rejected = { get: async () => { throw new LiveApiError('date must fall inside the available data window 1990-01-01..2026-09-19', 400, 'INVALID_REQUEST', false, undefined, undefined); } } as any;
    register(server as any, rejected, at('2026-09-19T00:00:00Z'));
    const late: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-21' });
    expect(late.content[0].text).toContain('so 2026-09-21 can be asked for from 2026-09-20 UTC');
    // The other way round: the proxy just past midnight (max 2026-09-20),
    // this server just before it. Still the 20th, not the 19th, which the
    // proxy would still reject.
    const early = capture();
    register(early.server as any, { get: async () => { throw new LiveApiError('date must fall inside the available data window 1990-01-01..2026-09-20', 400, 'INVALID_REQUEST', false, undefined, undefined); } } as any, at('2026-09-18T23:59:59Z'));
    const result: any = await early.tools[0].handler({ symbol: 'KBE', date: '2026-09-21' });
    expect(result.content[0].text).toContain('so 2026-09-21 can be asked for from 2026-09-20 UTC');
  });

  test('a future weekend date, a date before the window and a rejection in another form keep the proxy\'s answer', async () => {
    const { tools, server } = capture();
    const rejected = { get: async () => { throw new LiveApiError('date must fall inside the available data window 1990-01-01..2026-09-19', 400, 'INVALID_REQUEST', false, undefined, undefined); } } as any;
    register(server as any, rejected, at('2026-09-18T20:46:30Z'));
    for (const date of ['2026-09-20', '2026-09-26', '1989-12-31']) {
      const result: any = await tools[0].handler({ symbol: 'KBE', date });
      expect(result.structuredContent, date).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
      expect(result.content[0].text, date).toBe('API error (INVALID_REQUEST): date must fall inside the available data window 1990-01-01..2026-09-19. Retrying will not succeed.');
    }
    // A rejection whose own bound already covers the date cannot come from
    // the proxy's validator; if it ever did, the message and the decision
    // would disagree, and promising a day from it would be a guess.
    const covered: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(covered.structuredContent).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(covered.content[0].text).not.toContain('can be asked for from');
    // The proxy's other INVALID_REQUEST for a date (2026-13-45 passes the
    // regex) carries no window and is left alone.
    const unreal = capture();
    register(unreal.server as any, { get: async () => { throw new LiveApiError('date must be a real calendar date (YYYY-MM-DD)', 400, 'INVALID_REQUEST', false, undefined, undefined); } } as any, at('2026-09-18T20:46:30Z'));
    const result: any = await unreal.tools[0].handler({ symbol: 'KBE', date: '2026-13-45' });
    expect(result.structuredContent).toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    expect(result.content[0].text).toBe('API error (INVALID_REQUEST): date must be a real calendar date (YYYY-MM-DD). Retrying will not succeed.');
  });

  test('another code with today\'s date is untouched', async () => {
    const { tools, server } = capture();
    const failing = { get: async () => { throw new LiveApiError('Pro required', 403, 'PRO_TIER_REQUIRED', false, 'https://x/pricing', undefined); } } as any;
    register(server as any, failing, at('2026-09-18T20:10:00Z'));
    const result: any = await tools[0].handler({ symbol: 'KBE', date: '2026-09-18' });
    expect(result.structuredContent).toMatchObject({ code: 'PRO_TIER_REQUIRED', retryable: false, actionUrl: 'https://x/pricing' });
    expect(result.content[0].text).not.toContain('is a trading session');
  });
});
