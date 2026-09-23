import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeEodDealerPositioning } from './eodDealerPositioningShaping.js';

/**
 * End-of-day dealer positioning, from the stored options snapshot.
 *
 * This tool was cut from the live-data plan on the belief that the snapshot's
 * exposure summary covered only the ~125 regime symbols. Measured against
 * production on 2026-09-09: 5,568 tickers carry net_gex_0_60d and
 * dealer_regime. No Pro requirement (the server itself requires entitlement:
 * a subscription, or a developer or comped account, so nothing here is
 * free-tier), cached upstream by the nightly cron, no broker.
 *
 * A SEPARATE TOOL FROM get_live_dealer_positioning, deliberately, and never a
 * fallback inside it. A live gamma flip and an end-of-day one are different
 * claims: this one is the snapshot's coarse-grid level and carries no search
 * status or resolution, and the summary says so on every answer.
 */

/** The calendar date and the minute in New York, "YYYY-MM-DDTHH:MM" on a 24-hour clock, so it sorts as text. */
export function newYorkDateTime(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/** The calendar date in New York, YYYY-MM-DD. */
export function newYorkDate(now: Date = new Date()): string {
  return newYorkDateTime(now).slice(0, 10);
}

const isWeekend = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 || day === 6;
};

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nextCalendarDate = (date: string): string => addDays(date, 1);

// The proxy's NOT_FOUND carries retryable false for every missing date
// (proxy/routes/eod.ts), so a session that had not been imported YET read
// word for word like a Sunday: "No exposure data found for KBE on
// 2026-09-18. Retrying will not succeed." at 20:10Z on 2026-09-18, when that
// file lands overnight and the same call succeeds the next morning. A
// weekday date is not final until 09:30 New York on the next calendar day.
// That cutoff is this tool's, not the producer's, which has none: the equity
// import is scheduled 01:00 ET Tue-Sat and the regime cron's retry loop
// re-pulls it in half-hour steps to about 06:00 ET
// (proxy/services/ScannerCronJob.ts), and the exposure summary for every
// session from 2026-09-08 to 09-17 landed 02:31-02:34 ET the next day
// (option_ticker_snapshots.exposure_computed_at), but the loop's waits are
// not a bound on its execution and a catch-up import runs as long as it has
// days (review: eight simulated 20-minute catch-ups reached
// 08:40 ET, past the 08:00 that commit called the window's end). Until the
// cutoff the answer is marked retryable (the flag is a possibility) with a
// conditional sentence; after it the proxy's answer stands, and the
// description says the flag is the proxy's, not a promise: a failed
// exposure computation leaves the import "success" with no re-attempt
// (review), so a session can appear after a later successful
// import or repair, and nothing here can say whether one is coming. "Today
// or later" alone left the session BEFORE its import, at 00:30 ET the next
// day, reading "Retrying will not succeed." (review). Weekends
// are never sessions and keep the proxy's answer at any hour. The proxy
// answers NOT_FOUND alike for an absent row,
// an imported row with no exposure summary (a futures contract, a name with
// no near-term options) and a weekday holiday, and this server carries no
// holiday calendar (no @oas/shared dependency), so the sentence names the
// cases that stay not-found rather than promising a file (review).
// The conditional is present tense: the window admits tomorrow's date, and
// "was a trading session" read wrong for it (seventeenth run, 2026-09-22
// asked for at 13:47 ET on 09-21).
const NOT_FINAL_UNTIL = 'T09:30';

const importWindowOpen = (date: string, now: Date): boolean =>
  !isWeekend(date) && newYorkDateTime(now) < `${nextCalendarDate(date)}${NOT_FINAL_UNTIL}`;

const notOnFileYet = (date: string): string =>
  ` That session is not on file. If ${date} is a trading session, its equity import is scheduled for 01:00 US Eastern the next day and usually lands about 02:30, so ask again after that; this tool treats the answer as not final until 09:30 US Eastern that day. A market holiday has no session, and a symbol with no exposure summary (a futures contract, or one with no near-term options) stays not-found.`;

// The proxy validates `date` against a window whose upper edge is one day
// past the current UTC date and moves with it (proxy/routes/eod.ts
// EOD_EXPOSURE_DATE_BOUNDS, maxFutureDays 1, through @oas/shared
// calendarDate.ts parseBoundedCalendarDate), answering INVALID_REQUEST with
// retryable false before any not-found: the sixteenth run asked for next
// Monday at 20:46Z on 2026-09-18 and got "date must fall inside the
// available data window 1990-01-01..2026-09-19. Retrying will not
// succeed.", which the moving edge makes untrue for a future weekday. The
// proxy accepts a date once its UTC day is at least the date less
// maxFutureDays, so the first day the date can be asked for from is the
// date less that reach, a fixed policy: subtracting the message's bound
// from THIS server's clock used two clocks, and in the seconds around UTC
// midnight they differ by a day (review). The reach mirrors
// EOD_EXPOSURE_DATE_BOUNDS.maxFutureDays and a change there must change
// it here. The proxy stays the authority on the window (this server does
// not re-check it), and a message in another form, a weekend date (never
// a session) or a date before the window keep the proxy's answer. The
// pattern is the proxy's current message; a change there leaves its text
// as it is.
const WINDOW_REJECTION = /must fall inside the available data window (\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;
const WINDOW_REACH_DAYS = 1;

const beyondWindow = (date: string, askFrom: string): string =>
  ` The window's upper edge moves forward with the UTC date, so ${date} can be asked for from ${askFrom} UTC; if it is a trading session, its equity import usually lands about 02:30 US Eastern the next day, and this tool treats a not-found as not final until 09:30 US Eastern that day. A market holiday has no session.`;

export function register(server: McpServer, client: LiveApiClient, now: () => Date = () => new Date()): void {
  server.registerTool(
    'get_dealer_positioning',
    {
      title: 'EOD Dealer Positioning / GEX',
      description:
        'Get END-OF-DAY dealer positioning for a symbol from the most recent session on file, over the 0-60 day expiration window: '
        + 'net GEX and DEX, the dealer regime, the gamma flip, the call wall and put wall (the call wall is the strike with the largest positive call gamma and the put wall the strike with the most negative put gamma (ties go to the lower strike; a side with no such strike leaves that wall null), and nothing orders them, so the put wall can sit above the call wall), the gamma magnet (largest absolute gamma strike), '
        + 'the 30-day expected move (as a decimal fraction of spot, and in dollars), and the top contributing strikes. Covers roughly 5,500 listed equities and ETFs. '
        + 'Positive net gamma means dealers hedge against moves and dampen them; negative means they hedge with moves and amplify them. '
        + '`dealerRegime` is the sign of the 0-60 day net gamma interpolated at spot between the two strikes that bracket it (the nearest strike\'s gamma when spot is outside the strike range), not the sign of `netGex` and not which side of `gammaFlip` spot sits on; it can disagree with both (SPY on 2026-09-17: netGex -5.5 billion, spot 763.01 below the flip 764.97, regime positive), and only with fewer than two gamma-bearing strikes in that window is it the sign of `netGex` itself. '
        + 'The gamma flip here is a coarse-grid level from the stored snapshot with no search status or resolution; for the flip as of NOW, repriced from a live chain with its search status, use get_live_dealer_positioning (Pro and above), which is a different claim and is never substituted here. '
        + 'Pass `date` for a past session; omit it for the most recent on file. `date` in the result is the session it describes and is authoritative; do not present it as today\'s close. `date` is accepted from 1990-01-01 to one day past the current UTC date, the proxy\'s window, which moves forward with the date; a later weekday date is rejected as INVALID_REQUEST until the window reaches it, marked retryable with the UTC day it can be asked for from, and a later weekend date keeps the rejection as final, since it is never a session. The equity import is scheduled for 01:00 US Eastern the next day and usually lands about 02:30, so in the evening the most recent on file is usually the previous session, and it can be older when an import is late. A not-found for a weekday date inside that window is not final until 09:30 US Eastern on the following calendar day, and is marked retryable until then. That cutoff is this tool\'s, not a deadline of the producer\'s, which has none: the import is scheduled for 01:00 US Eastern, retried in half-hour steps to about 06:00, and runs later when it has days to catch up. If that date is a trading session its file usually lands about 02:30 US Eastern the next day (02:31 to 02:34 for every session from 2026-09-08 to 09-17), so before then it is usually not on file yet; a market holiday, a futures contract or a name with no near-term options stays not-found, and this tool cannot tell those apart from the date alone. After the cutoff the response is the proxy\'s answer for any absent row and says retrying will not succeed; that is the proxy\'s flag for a row absent on the normal schedule, not a promise that the file can never arrive: a session whose import or exposure computation failed can appear after a later successful import or repair, and nothing here says whether one is coming. Max pain is not here; it is in get_options_snapshot. A symbol with no exposure summary (a futures contract, or a session with no near-term options) reports not-found rather than a neutral regime. '
        + 'Distinct from get_regime with scope="symbol", which reports the daily regime classification and its authoritative Greek exposures.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('Session date in YYYY-MM-DD, from 1990-01-01 to one day past the current UTC date (a later date is rejected until the window reaches it). Defaults to the most recent session on file, whatever its date; read `date` in the result.'),
        strikeLimit: z.number().int().min(1).max(10).optional()
          .describe('Contributing strikes to return, in stored order. Default 10, which is all the snapshot keeps.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, date, strikeLimit }) => {
      const params: Record<string, string> = {};
      if (date) params.date = date;

      let res: Record<string, unknown>;
      try {
        res = await client.get(
          `/eod/exposure/${encodeURIComponent(symbol.toUpperCase())}`,
          params,
        ) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof LiveApiError && err.code === 'NOT_FOUND' && date && importWindowOpen(date, now())) {
          throw new LiveApiError(`${err.message}.${notOnFileYet(date)}`, err.statusCode, err.code, true, err.actionUrl, err.details);
        }
        if (err instanceof LiveApiError && err.code === 'INVALID_REQUEST' && date && !isWeekend(date)) {
          const window = WINDOW_REJECTION.exec(err.message);
          if (window && date > window[2]) {
            const askFrom = addDays(date, -WINDOW_REACH_DAYS);
            throw new LiveApiError(`${err.message}.${beyondWindow(date, askFrom)}`, err.statusCode, err.code, true, err.actionUrl, err.details);
          }
        }
        throw err;
      }

      return summarizeEodDealerPositioning(res, { strikeLimit });
    }),
  );
}
