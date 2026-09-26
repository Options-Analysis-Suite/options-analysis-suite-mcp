import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeDealerPositioning } from './dealerPositioningShaping.js';

/**
 * Dealer positioning, computed live from the caller's own broker chain.
 *
 * The computation is not new - it is the same engine behind the WebSocket
 * exposure stream and the paid /v1/compute/exposure endpoint. What was missing
 * was a way to REACH it: /v1/compute/exposure requires the caller to POST up to
 * five thousand strike rows, which an assistant cannot produce. The data
 * existed and the computation existed, and nothing joined them. The proxy's
 * /live/exposure route joins them, from the stored broker credential.
 *
 * NO END-OF-DAY FALLBACK INSIDE THIS TOOL. A live gamma flip and an end-of-day
 * one are different claims, and a caller must be able to tell them apart; a
 * failure here reports the failure, never a quiet substitute.
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_live_dealer_positioning',
    {
      title: 'Live Dealer Positioning / GEX (Pro)',
      description:
        'Get LIVE dealer positioning for a symbol, computed in real time from the broker credential stored on your Options Analysis Suite account. '
        + 'Returns net GEX and DEX plus net vega, vanna, charm and vomma; the gamma flip (the repriced regime-change level), the call wall and put wall (the call wall is the strike with the largest positive call gamma and the put wall the strike with the most negative put gamma (ties go to the lower strike; a side with no such strike leaves that wall null), and nothing orders them, so the put wall can sit above the call wall), a gamma magnet, gamma concentration, a dealer regime, and per-strike gamma and delta contributions around spot. '
        + 'Positive net gamma means dealers hedge against moves and dampen them; negative means they hedge with moves and amplify them. '
        + '`dealerRegime` is the sign of the net gamma over the selected expirations interpolated at spot between the two strikes that bracket it (the nearest strike\'s gamma when spot is outside the strike range), not the sign of `netGex` and not which side of `gammaFlip` spot sits on; it can disagree with both, and only with fewer than two gamma-bearing strikes is it the sign of `netGex` itself. '
        + 'The gamma flip is found by repricing the book across a range of spot levels. `coverage.gammaFlipMethod` says how: "repriced" recomputed gamma from implied volatility for every leg; "frozen-gamma" means no leg had a usable IV, so every published gamma was held constant across the sweep; "mixed" means some legs were repriced and the rest held constant. A held gamma is an approximation that can materially move the level or create one where there was none, and a usable IV is finite, above 0 and at most 5 (500%): a broker-published IV of 0 or above that band counts as absent. Say which method was used when quoting the level. '
        + 'The gamma-flip search samples prices within 20% of spot. A pair of crossings within one sampling interval can be missed; no detected flip does not prove that no crossing exists within or beyond that range. '
        // The scan's step starts at spot x 5e-6, grows 1% a sample and caps at
        // spot x 0.0002 after 371 samples, 1.955% out (observed-gamma-flip.ts
        // NEAR_STEP, GROWTH, MAX_STEP); the reported resolution is the step at
        // the bracket, so a far crossing usually reads spot x 0.0002 (KBE at
        // 20:05Z: 0.013324 = 66.62 x 0.0002, 2.81% out) and a near one an
        // irregular smaller width (1.54% out at 19:39Z: 0.0106). Not always
        // (review): the width is max(step, |sample - anchor|),
        // clipped by the 20% edge (flip 120 at spot 100: 0.0046), widened by
        // zero samples between the signs (0.04 in a fixture), and about twice
        // the first step for a crossing at spot (:290).
        + '`coverage.gammaFlipResolution` is the width of the bracket the sign change was found in, not a confidence interval or an error bound. The search steps out from spot in samples starting at 0.0005% of spot, growing 1% a sample to a cap of 0.02% of spot from about 2% out, and the width is usually that step (a flip beyond about 2% out usually reads spot times 0.0002), wider when zero-valued samples sat between the two signs, narrower at the 20% search edge, and about twice the first step for a crossing at spot itself. The reported flip is the nearest crossing detected by that search, and the resolution is null when no level is reported. '
        + '`coverage.gammaFlipSearchStatus` describes the search on supported legs: "found" detected a crossing, "not-found" detected none in the sampled range, and "unresolved" means numerical signs or crossing order could not be established reliably. An unresolved null gives no conclusion about whether a crossing exists; a null status means the response did not report a recognized search status. '
        // Seventeenth run: `levelStatus.gammaFlip` read "complete" beside a
        // null flip. The status is the level's required coverage
        // (dealerPositioningShaping.ts measuredLevel), and nothing said so.
        + '`levelStatus` is each level\'s required coverage (the flip\'s sweep coverage, `coverage.gammaFlip`, which counts repriced and held legs alike, so it can be complete under "frozen-gamma" with no leg repriced; the walls\', the magnet\'s and the concentration\'s net-gamma coverage), not whether a level was found: a null `gammaFlip` beside a complete `levelStatus.gammaFlip` is a null the route reported over complete coverage, and `coverage.gammaFlipSearchStatus` says whether the search found no crossing or was unresolved. '
        + 'Each per-strike row carries `callGex` and `putGex` beside `netGex`, the two sides the walls are chosen from, only when the row\'s gamma coverage is complete or empty: the coverage counts both sides together, so under partial coverage a side could be an unmeasured zero, and both sides are then null while the partial net is still published. '
        + 'With `expiration`, every total, level and row is computed over that one listed expiration alone, which is how to see a same-day (0DTE) or single-week book, and `window.expirationSelection` is "requested"; a date the broker does not list is refused with the listed ones, never replaced by the nearest. '
        + '`byExpiration` splits the window by expiration, each entry computed alone on the same rows: `netGex`, `netDex`, `callGex` and `putGex`, and `grossGex`, the sum over its strikes of the call and put gamma exposure sizes; `daysToExpiration` in calendar days from today in New York (0 on the expiration day); and `shareOfGrossGex`, its share of the window\'s gross gamma, published only when every expiration\'s gamma coverage is complete (a same-day expiration\'s share is how concentrated the book is in 0DTE). The sides and `grossGex` follow the rule for the per-strike rows\' `callGex` and `putGex`: null under partial gamma coverage. An expiration the broker answered with no options has unknown coverage, its values are null and no expiration gets a share. '
        + 'Its `expectedMove` is the at-the-money straddle: the call and put midpoints at the strike nearest spot that lists both a call and a put (ties to the lower strike), summed as `straddle`, with `lower` and `upper` at spot minus and plus it and `pctOfSpot` its fraction of spot; it is the market\'s price for a move by that expiration, not a forecast, and is null with `expectedMoveUnavailable` saying why when that strike lacks a two-sided quote on either leg ("atm-quote-missing") or no strike lists both legs ("no-strike-with-both-legs"), never read from a strike farther than that one, a mark or a last trade. `atmIv` is the mean of those two legs\' usable implied volatilities and `ivOneSigma` is spot times `atmIv` times the square root of the years to expiration, a one-standard-deviation move; near the money the straddle is roughly 0.8 of it. Outside trading hours the midpoints are the broker\'s last quotes. '
        + 'Each `byExpiration` entry\'s `events` flags what falls between today (New York) and that expiration, the expiration day included: `earningsOnOrBefore`, the first earnings date on file, and `exDividendOnOrBefore`, the first ex-dividend date on file with its per-share `amount` and `declared` (false when no declaration dated on or before today is on file for it, as for a scheduled or estimated date); the top-level `events` lists them all from `from` through `through`, the last expiration. A null date means none ON FILE, not none scheduled: earnings are on file only once the next date is known and mostly for operating companies (a fund or ETF usually has none, though a few carry dates), and the time of day of an earnings release is not on file, so one dated on the expiration day may come before or after the close. Ex-dividend dates are not complete ahead of time either, and a fund\'s often appears only on or after the day (SPY\'s 2026-09-18 ex-dividend date was not on file beforehand), so for a fund or ETF a null says little. `events` is null, here and on every entry, when the calendar could not be read; the exposure is unaffected, since these dates feed no number in it. '
        + 'Each per-strike row also carries `callOpenInterest` and `putOpenInterest`, contracts summed over the window\'s expirations, null when the broker published no size for some leg at that strike. A row carries its `coverage` counts only when one of its statuses is not complete. `spotSides` splits the window at spot: `above` holds the strikes strictly above it and `below` those strictly below, and a strike exactly at spot (`atSpotStrike`) is in neither. Each side carries `netGex`, `callGex` and `putGex` (the two sides only when its gamma coverage is complete or empty), and `callOpenInterest` and `putOpenInterest` with their own coverage; a partial open interest is the sum of the sizes published and is labelled partial. `callOpenInterestShareAbove` is the call open interest above spot over the window\'s call open interest, the at-spot strike included in the whole, and is null unless every call leg\'s size is known. These are what a squeeze argument reads, not a squeeze signal: GEX here counts call gamma as positive and put gamma as negative, the convention that dealers are long the calls and short the puts, while a squeeze reading of out-of-the-money calls assumes customers bought them and dealers are short, and open interest does not say who holds a contract. '
        + 'Without `expiration`, computed over the first four expirations the broker lists for the live chain, which on a name with monthly listings can span months (KBE on 2026-09-18: 09-18, 10-16, 11-20, 12-18, three months; on 2026-09-21, with the 09-18 listing gone, 10-16, 11-20, 12-18, 2027-01-15, nearly four) against the EOD tools\' 0-60 days; `window.expirations` lists them. The window moves with the broker\'s list, as a listing expires or a nearer one is added, so two answers across such a change cover different books (KBE at 17:47Z on 2026-09-21: netGex -5,013,878, call wall 75, put wall 59, no flip found within 20% of spot, against 358,515, 70 and a flip at 66.68 at 20:46Z on 09-18), and the live figure can differ in sign from the 0-60 day figure on file, a different window on a different session (KBE: +184,861 on file for 09-18, +248,246 for 09-17). It reflects the current session rather than the most recent session on file. Outside trading hours the quotes are the broker\'s last, but time to expiry is measured from the wall clock when the chain rows are built, moments before `asOf`, so the repriced flip and the time-sensitive totals drift a little between calls with no new quotes; that is the clock, not the market. The broker can also refresh its Greeks after the close, and a refresh can move the levels and totals at unchanged spot (KBE on 2026-09-18 at 20:46Z against the 20:05Z snapshot, spot 66.62 both times: every per-strike vega changed, netGex 326,483 to 358,515, the call wall 66 to 70, the flip 64.75 to 66.68), so a change after hours can be a refresh rather than the market, and the payload does not say which. '
        // Fourteenth run: every per-strike vega identical between two
        // calls 23 minutes apart and netGex scaled by (S2/S1)^2 to its
        // rounding (exposure-compute.ts:791 Math.round), so the broker's
        // Greeks were one snapshot; the Tradier adapter drops
        // greeks.updated_at (brokerService.ts:637-640), so nothing dates it.
        // And charm swung -2.6M to +8.1M over 70 legs both times: the engine
        // computes vanna, charm and vomma analytically from time to expiry
        // (exposure-compute.ts:365-377), the route's expirations list is
        // cached 15 minutes with no close-time filter (live-broker.ts:58),
        // and the T floor drops a leg from those three sums at one minute
        // to its close. A same-day strike-66 leg with 1,000 OI carries charm
        // 3,276,453 at 44 minutes and 8,662 at 21 minutes through that
        // formula, against the low thousands for a one-month leg; its vanna
        // flips sign where d2 = 0, S = K*exp(-(r - q - iv^2/2)T): 66.00014
        // here, $2.25 off at K 6000 and IV 3; it rises with IV throughout but
        // sits below K while iv^2/2 < r - q, so "farther" was wrong at low
        // IV (review: charm is
        // the one that can own the book; a later review: the vanna and vomma
        // peaks were a 30%-IV grid, not an ordering, so no size comparison
        // is published; another: the input checks a published Greek
        // passes first, exposure-compute.ts:196-235, are named).
        + 'The broker\'s Greeks and implied volatilities can be a snapshot older than `asOf`, which is the fetch time, and nothing in the payload dates them: Tradier\'s refresh about hourly (KBE on 2026-09-18: every per-strike vega identical at 19:16Z and 19:39Z, different at 18:56Z). Between refreshes the published Greeks are fixed, so with the resolved rate and yield, open interest and the summed leg set also unchanged, only spot and the clock move the totals: the per-strike gamma rows move with spot squared exactly and netGex to its rounding (325,161 to 326,140 as spot went 66.485 to 66.585). On an expiration day the same-day expiration stays in the window while the broker lists it (Tradier still listed KBE\'s 2026-09-18 expiration 46 minutes after the close, and the route caches that list for 15 minutes, so it can be asked for that long after the listing ends); its legs stay eligible for gamma, delta and vega under the engine\'s input checks (a known open interest, finite and from 0 to 1e12; a finite gamma or delta of size at most 10, a finite vega of size at most 10,000; a finite contribution), and drop out of vanna, charm and vomma a minute before its close. Those three are computed from time to expiry, so on the same-day legs they change sharply with small spot moves and with the clock: charm near the money can be the largest term in the book (a strike-66 leg with 1,000 open interest: charm 3.3 million at 44 minutes to the close with spot 66.485, 8,662 at 21 minutes with spot 66.585; a one-month leg with the same open interest, in the low thousands), and its vanna changes sign at the price where d2 is zero, 66.0001 in the example (higher implied volatility raises this crossing price). On an expiration afternoon netCharm can be mostly the same-day legs and the clock (KBE 2026-09-18: -2,631,616 at 19:16Z, +8,063,999 at 19:39Z, over 70 of 106 legs both times). '
        // Fifteenth run, 20:05Z: the flip read 64.75 against 65.56 at 19:39Z
        // on one broker snapshot. observedFlipInput takes yte > 0 as having
        // time, and computeYearsToExpiration floors an elapsed expiry at one
        // minute, so the same-day legs are repriced at T = 1 minute after
        // the close for as long as the cached list carries the date.
        + 'After the close the expired legs stay inside the totals and the levels while the expiration is listed, and `window.expirations` beside `asOf` is the only sign of it. The flip sweep reprices each leg from its implied volatility at its time to expiry floored at one minute, so on an expiration day the same-day legs\' repriced gamma narrows onto their strikes through the afternoon and holds the one-minute shape after the close, and the flip moves with the clock (KBE 2026-09-18: 65.56 at 19:39Z, 64.75 at 20:05Z, on one broker snapshot, spot 66.585 to 66.62). '
        // A leg enters the vanna, charm and vomma sums only while its IV
        // passes exposure-compute.ts:365 (above .01, at most 5, time left)
        // and the gamma, delta and vega sums only while that Greek is
        // published, so the summed set moves between calls: KBE's netCharm
        // read +4,387,168 over 80 of 106 legs and, twenty minutes later,
        // -2,631,616 over 70. Nothing in the payload names the legs.
        + 'Metric coverage and statuses distinguish complete, partial, unmeasured, empty and unknown results. Partial values sum only supported option legs; they are not measurements of the whole book. A leg counts toward vanna, charm and vomma only while the broker\'s implied volatility for it is above 1% and at most 500% and its expiration\'s close is more than a minute away, and toward gamma, delta and vega only while the broker publishes that Greek for it, so the included count of a partial total moves between calls, and two partial totals minutes apart can differ by which legs were summed rather than by the market (KBE on 2026-09-18: netCharm +4,387,168 over 80 of 106 legs at 18:56Z, -2,631,616 over 70 at 19:16Z); the payload does not say which legs each summed. Unmeasured or unknown values are null. Gamma-derived levels require complete coverage. `coverage.gammaFlip` counts every leg that entered the sweep, repriced or held, so it can read complete while `gammaFlipMethod` is "mixed"; the method, not the count, says whether those legs were repriced, held, or both. '
        + 'EXPENSIVE: a call over the default four expirations is charged five weighted units against the 10-unit-per-minute live-broker limit, so at most two such calls a minute, and a call naming `expiration` is charged two, so at most five a minute. A cold request reads the expirations list and up to four chains (one with `expiration`); actual upstream request counts vary with the provider and cache state. Do not call it in a loop or for a list of symbols. A repeat for the same symbol and broker over the same expirations, asked the same way, within 15 seconds can be answered from a short in-memory cache, with the same `asOf`, totals and levels whatever `strikeRange` or `strikeWindowPct` it asks for (they only choose which computed rows are returned), and is still charged in full; the cache is per proxy instance, so a repeat can also be computed afresh. '
        + 'The risk-free rate and dividend yield are resolved from real market data and never defaulted, because the gamma flip is a repricing that depends on them; `resolved` reports what was used. '
        + '`resolved.r` is the newest stored 3-month Treasury yield from FRED, whatever its age: FRED posts a business day\'s value the next business day and the platform syncs it once each weekday evening, so `resolved.r.asOf` is usually one or two sessions before today; an older date can mean the sync is behind, a delayed publication, or a newer observation withdrawn, and the answer carries no warning either way. '
        + 'Requires a Pro subscription or above and a broker credential saved to the account under Account -> Broker -> Stored broker credentials; a broker connected only in the browser on the website is not visible to this tool. '
        + 'For the most recent session on file\'s positioning over 0-60 days, free and without a broker, use get_dealer_positioning; its gamma flip is a coarse-grid level and is a different claim from the repriced one here.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY, MU)'),
        // Every provider a stored credential may name. It must match the
        // server's list: automatic selection can pick any of them, so a
        // narrower enum here refuses by name the very broker the same call
        // would have chosen on its own.
        provider: z.enum(['tradier', 'tastytrade', 'public', 'schwab']).optional()
          .describe('Which connected broker to use. Defaults to the first one connected.'),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
          .describe('One expiration in YYYY-MM-DD to compute over instead of the nearest four, for example the same-day expiration. It must be one the broker lists; otherwise the refusal names the listed ones.'),
        strikeRange: z.number().int().min(1).max(150).optional()
          .describe('TOTAL per-strike rows nearest spot, the cap when `strikeWindowPct` is given. Default 10 (150 with `strikeWindowPct`), max 150. Totals use all supported legs in the selected expirations regardless of this display limit; metric statuses identify partial coverage. The walls and the magnet are chosen over every strike in the window (`strikes.total` of them), so they can sit outside the returned rows (KBE on 2026-09-21: walls 75 and 59 with the ten default rows spanning 62 to 71); such a level\'s own row is returned in `strikes.atLevels`, naming the level, so its `callGex` and `putGex` can be checked. Rows that would carry the answer past its 50 KB limit are dropped farthest from spot first, and `strikes.limitedBySize` is then true.'),
        strikeWindowPct: z.number().positive().max(50).optional()
          .describe('Return every strike within this percent of spot instead of a fixed count, nearest first up to `strikeRange` (for example 10 for strikes within 10% of spot). `strikes.inWindow` counts the strikes inside the window, which exceeds `strikes.returned` when the cap or the size limit cut it.'),
      },
      outputSchema: marketDataOutputSchema,
      // Unlike every other tool here except the live chain, this reaches a
      // third party: the user's own broker.
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    toolHandler(async ({ symbol, expiration, provider, strikeRange, strikeWindowPct }) => {
      const params: Record<string, string> = {};
      if (expiration) params.expiration = expiration;
      if (provider) params.provider = provider;

      const res = await client.get(
        `/live/exposure/${encodeURIComponent(symbol.toUpperCase())}`,
        params,
      ) as Record<string, unknown>;

      return summarizeDealerPositioning(res, { strikeRange, strikeWindowPct });
    }),
  );
}
