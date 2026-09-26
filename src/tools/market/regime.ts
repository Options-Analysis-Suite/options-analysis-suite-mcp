import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeMarketRegimeResponse, humanizeRegimeEntry } from './marketRegimeShaping.js';

/**
 * Unified regime tool. Replaces get_market_regime, get_intraday_regime,
 * and get_regime_symbol with one enum-driven tool. Each scope keeps
 * its own params, defaults, and response shape.
 */

// The producer's classifyWithHysteresis (proxy/scripts/regime-worker/
// regime-scorer.ts, STATE_THRESHOLDS in regime-config.ts) runs on every scope:
// daily symbol, intraday and the market composite. "Typical bands" described
// a lookup the producer does not do, and rode only the market shape.
const STRESS_SCORE_RULE = '`label` is a state with hysteresis, not a band read off the score. '
  + 'Entry levels: NORMAL -0.5, ELEVATED 0.5, STRESS 1.5, CRISIS 2.5, and CALM below -0.5 with no prior; exit levels: NORMAL -1.0, ELEVATED 0.0, STRESS 1.0, CRISIS 2.0. '
  // The intraday prior is the previous scan only while the worker's store
  // survives: proxy/data/intraday-regime-<date>.json on the Cron Server's
  // disk (intraday-regime.ts loadSnapshots/saveSnapshot), which every
  // redeploy wipes. On 2026-09-17 that service redeployed at 16:08Z and
  // 17:18Z; the midday and afternoon scans reproduce only against the
  // 09-16 daily label, the morning and pre-close scans against the scan
  // before them. Rows written since the producer records it carry the prior
  // and its source (vector._meta.prevLabel / prevLabelSource), surfaced on
  // each intraday scan as priorLabel / priorLabelSource.
  + 'Against the prior label the producer had (for the daily symbol and market scopes, the latest earlier daily label stored for the same symbol, symbol tier and model version; for an intraday scan, the previous scan of the day while the scan worker still holds it, else that same daily label; the worker\'s store of the day\'s scans is a file on its disk that a redeploy between two scans wipes, so the scan after one takes the daily label (SPY\'s 2026-09-17 midday scan, ELEVATED at 0.5987 with confidence 0.9414, was judged against the 2026-09-16 daily label ELEVATED, not the morning scan\'s NORMAL)), a score reaching a higher state\'s entry level moves the label up; otherwise the label is kept until the score falls below its exit level, and then it drops to the highest lower state whose entry level it still meets. '
  + 'Without a usable prior label, including when the prior could not be read, the label is the highest state whose entry level the score meets. '
  + 'So a score inside one band can carry the label above it: SPY\'s 2026-09-18 midday scan, 0.4229, is ELEVATED because the day\'s open scan took the 2026-09-17 daily label, ELEVATED at 0.506, and no scan since fell below 0.0.';

// The payload carries the rule in short: the full one ran to 1,100 characters
// on every response and its example named SPY on every symbol.
const STRESS_SCORE_NOTE = 'stressScore is a raw composite regime score, not a 0-100 index. '
  + '`label` is a state with hysteresis against the prior label, not a band read off the score (entry NORMAL -0.5, ELEVATED 0.5, STRESS 1.5, CRISIS 2.5; exit -1.0, 0.0, 1.0, 2.0), so a score inside one band can carry the label above it; the tool description has the full rule.';

// The proxy orders market_date DESC then scan_time ASC, so the newest scan is
// the last entry of the first date; a reader saw "neither newest-first nor
// oldest-first" and had nothing in the payload to go on. Scan time is not
// interval order: a rerun interval stores a later scan_time and sits after
// pre-close (review).
const INTRADAY_SCAN_ORDER = 'newest date first; within a date, by scan time ascending (a rerun scan sits after the ones before it, whatever its interval), so the newest scan is the last entry of the first date';

const REGIME_DESCRIPTION = `Get regime data at one of three scopes. Pick the scope that matches the question; irrelevant sub-params are ignored.

• scope="market" — MARKET COMPOSITE stress regime (aggregate across SPY/QQQ/IWM/DIA, not per-symbol). Returns composite stress score, confidence, key drivers, feature z-scores. The label's entry and exit levels are below. Accepts \`date\` (YYYY-MM-DD, default latest) and \`include_symbols\` (default false; true also returns up to the top 8 symbols per classification tier sorted by absolute stress score, with raw vector internals stripped).
• scope="symbol" — per-symbol daily regime + authoritative Greek exposures (net gamma/delta/vega/vanna/charm/vomma, call wall, put wall, gamma flip, gamma magnet (\`exposures.gammaMagnet\`, the strike with the largest absolute net gamma, named as on get_dealer_positioning and get_live_dealer_positioning), top 10 gamma strikes). REQUIRED: \`symbol\`. Accepts \`days\` (default 1 = latest, max 30) and \`full\` (default false; true keeps less-summarized history with vector internals stripped). This is the correct scope for "what are SPY's Greek exposures?" — do NOT use get_options_analytics_history for current exposures.
• scope="intraday" — intraday regime scan history for a symbol: 5 scans/day (open, morning, midday, afternoon, pre-close), each with stress scoring, regime classification, and compact Greek exposure snapshots. REQUIRED: \`symbol\`. Accepts \`days\` (calendar days back from the current UTC date, cutoff day included, so N spans N+1 dates: 2 on 2026-09-18 returned 09-16, 09-17 and 09-18; default 5, max 90), \`date\` (overrides days), and \`interval\` (filter to a single scan). Scans come newest date first and, within a date, by scan time ascending (not by interval: a rerun scan sits after the ones before it), so the newest scan is the last entry of the first date; \`scansMeta.order\` says so. \`scanTime\` is the run's start; each symbol's row lands when its own calibration finishes, minutes later for a slow name, so a scan can be absent for a while after its stamp. A scan stored since the producer began recording it carries \`priorLabel\`, the label its hysteresis was judged against (null when it had none), and \`priorLabelSource\`, "earlier scan" or "daily label" (null with no prior); older scans carry neither.

On every scope, \`stressScore\` is a raw composite regime score, not a 0-100 index, and ${STRESS_SCORE_RULE} \`stressScoreNote\` on every response carries the short form of this rule. Feature z-scores are winsorized to -5..5, so no |z| exceeds 5 and a value at that edge may have been clipped. On the market scope, the composite's own \`market.drivers\` carry a \`contribution\` of weight times |z|, unsigned and sorted by size, so that column does not sum to \`stressScore\` (apply the sign of \`z\` to each); every other driver list, the per-symbol breakdown under \`include_symbols\` included, and the symbol and intraday scopes, carries weight times z, signed.

The daily scan's call wall, put wall, gamma flip, gamma magnet and regime use the 0-60 day window, like get_dealer_positioning's, but the scan takes its own rate and dividend inputs (a tenor-weighted FRED rate and an estimated yield, against the snapshot's median rate and yield from the options data), so its gamma flip differs from get_dealer_positioning's for the same session (SPY 2026-09-17: 765.14 here, 764.97 there), and its \`topStrikes\` are over the whole book, so per-strike values differ too. On every scope the call wall is the strike with the largest positive call gamma and the put wall the strike with the most negative put gamma (ties go to the lower strike; a side with no such strike leaves that wall null), and nothing orders them, so the put wall can sit above the call wall (KBE on 2026-09-17: call wall 66, put wall 68, spot 66.77). A null \`exposures.gammaFlip\` on any entry means the producer's coarse-grid sweep within 20% of spot found no zero crossing, or its profile was zero at every sampled price, or no open interest sat within its window, or the stored spot was not a positive number; it is not a level of zero. \`confidence\` (0 to 1) says how secure the label is, not how severe the regime: how deep the score sits inside its band, whose lower edge is the label's exit level when the label was kept and its entry level otherwise (just entered from either direction, or no usable prior), and whose upper edge is the next state's entry level, or the previous label's exit level when it was just entered from above (CALM and CRISIS measure from their one edge over 1.5), as d, the distance to the nearer edge over half the band, through (1 - e^(-2.5 d)) / (1 - e^(-2.5)) (SPY's 2026-09-17 morning scan, 0.0138 NORMAL after the open's STRESS: band -0.5 to 1.0, 0.8929, times 0.85 for the change, 0.759); times the share of calibration models that succeeded raised to the power 1.5; times 0.85 when the label differs from its prior or had none; for the market composite's own \`confidence\` the share is symbols scored over symbols in the composite, and the rows of the \`include_symbols\` breakdown keep model coverage. \`modelCoverage\` {succeeded, attempted} on every symbol and intraday entry is that share's numerator and denominator (KBE 2026-09-17: 2 of 8, so 0.25 to the 1.5 caps its confidence at 0.125); the composite stores no such counts. The prior label a row was judged against is not stored for daily rows or for intraday scans stored before the producer began recording it, so those entries do not say whether their label was kept or which prior they took (newer intraday scans carry \`priorLabel\` and \`priorLabelSource\`), and on the symbol and intraday scopes confidence is computed from the unrounded score, so a recomputation from the four-decimal \`stressScore\` can differ in the last digit (the 2026-09-18 open scan, 1.3496, recomputes to 0.4295 against the stored 0.4296); the market composite rounds its score before computing confidence, so no such gap arises there. \`exposuresNote\` on the symbol, intraday and include_symbols shapes says which fields are over the 0-60 day window and which over the whole exposure input (the breakdown's rows carry no topStrikes, and their note names none). The symbol history past one day runs oldest first; \`historyMeta.order\` says so.

\`exposures.regime\` on any entry is the sign of the 0-60 day net gamma interpolated at spot between the two strikes that bracket it (the nearest strike's gamma when spot is outside the strike range), not the sign of \`exposures.netGamma\` and not which side of the gamma flip spot sits on; it can disagree with both (SPY's 2026-09-17 afternoon scan: netGamma -7.9 billion, regime positive), and only with fewer than two gamma-bearing strikes in that window is it the sign of \`exposures.netGamma\` itself. That field is the net gamma of the whole exposure input with no 60-day cutoff: every stored row for the daily scan; for the intraday scan, only the rows its normalizer retains from the broker chain, which drops the same-day expiration, every leg with a zero bid, no Greeks or no mid implied volatility, and every strike without a usable delta, and an expiration whose chain fetch failed is absent altogether.`;

function compactTopStrikes(topStrikes: unknown, limit = 10): unknown {
  if (!Array.isArray(topStrikes)) return topStrikes;
  return topStrikes.slice(0, limit).map((strike) => {
    if (!strike || typeof strike !== 'object' || Array.isArray(strike)) return strike;
    const row = strike as Record<string, unknown>;
    const compact: Record<string, unknown> = {};
    if ('strike' in row) compact.strike = row.strike;
    if ('netGamma' in row) compact.netGamma = row.netGamma;
    return compact;
  });
}

// The producer stores the confidence's coverage term on the row it explains
// (regime-scorer.ts: vector._meta.models_succeeded / models_attempted; the
// intraday scan: _meta.calibration {succeeded, total}), and the vector was
// stripped whole, so KBE read ELEVATED at 0.1183 with nothing saying that 2
// of 8 models calibrated. The market composite stores no counts.
function hoistModelCoverage(entry: any): void {
  const meta = entry?.vector?._meta;
  if (!meta || typeof meta !== 'object') return;
  const succeeded = meta.models_succeeded ?? meta.calibration?.succeeded;
  const attempted = meta.models_attempted ?? meta.calibration?.total;
  if (typeof succeeded === 'number' && typeof attempted === 'number') {
    entry.modelCoverage = { succeeded, attempted };
  }
}

// One `exposures` object carries two books: the levels are over the 0-60
// day window, the totals and topStrikes over the whole input (KBE 09-17:
// abs gamma 70 from the window beside topStrikes[0] at 59 from the book).
const EXPOSURES_WINDOW_CLAUSE = 'callWall, putWall, gammaFlip and gammaMagnet are over the 0-60 day window, and so is regime except with fewer than two gamma-bearing strikes there, when it is the sign of netGamma; ';
const EXPOSURES_NOTE = EXPOSURES_WINDOW_CLAUSE + 'netGamma, the other net totals and topStrikes are over the whole exposure input';
// The include_symbols rows hoist the totals and the levels only, so their
// note names no topStrikes.
const SYMBOLS_EXPOSURES_NOTE = EXPOSURES_WINDOW_CLAUSE + 'netGamma and the other net totals are over the whole exposure input';

// Which prior an intraday scan's hysteresis kept. Only rows written since the
// producer records it have the keys; an older row gets neither field rather
// than a null that would read as "no prior".
const PRIOR_LABEL_SOURCES: Record<string, string> = { 'earlier-scan': 'earlier scan', daily: 'daily label' };
function hoistPriorLabel(entry: any): void {
  const meta = entry?.vector?._meta;
  if (!meta || typeof meta !== 'object' || !Object.prototype.hasOwnProperty.call(meta, 'prevLabelSource')) return;
  entry.priorLabel = typeof meta.prevLabel === 'string' ? meta.prevLabel : null;
  entry.priorLabelSource = PRIOR_LABEL_SOURCES[meta.prevLabelSource] ?? null;
}

function hoistExposures(entry: any, topStrikeLimit = 10): any {
  hoistModelCoverage(entry);
  const gex = entry?.vector?._meta?.gex;
  if (gex) {
    entry.exposures = {
      spotPrice: gex.spotPrice,
      netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
      netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
      callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
      gammaMagnet: gex.absGamma,
      regime: gex.regime, topStrikes: compactTopStrikes(gex.topStrikes, topStrikeLimit),
    };
  }
  delete entry.vector;
  return entry;
}

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_regime',
    {
      title: 'Market Regime',
      description: REGIME_DESCRIPTION,
      inputSchema: {
        scope: z.enum(['market', 'symbol', 'intraday']).describe('Which regime view to fetch.'),
        symbol: z.string().optional().describe('Required for scope=symbol or scope=intraday.'),
        date: z.string().optional().describe('Specific date (YYYY-MM-DD). For scope=market: default is latest. For scope=intraday: overrides `days`.'),
        days: z.number().int().min(1).max(90).optional().describe('For scope=symbol: history days (default 1, max 30). For scope=intraday: calendar days back from the current UTC date, the cutoff day included, so 1 returns the previous UTC day and the current one; at midnight UTC (7 PM EST, 8 PM EDT) the cutoff advances one calendar date, and weekends and holidays are not skipped, so a window can cover days with no session and return no rows (default 5, max 90); use `date` for one session.'),
        interval: z.string().optional().describe('For scope=intraday only: filter to open | morning | midday | afternoon | pre-close.'),
        include_symbols: z.boolean().optional().describe('For scope=market only: include per-symbol breakdowns capped at the top 8 strongest per classification tier. Default false.'),
        full: z.boolean().optional().describe('For scope=symbol only: keep less-summarized multi-day history with vector internals stripped. Default false.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ scope, symbol, date, days, interval, include_symbols, full }) => {
      if (scope === 'market') {
        const res = await client.get('/regime/current', date ? { date } : {}) as any;
        // Hoist Greek exposure data from vector._meta.gex to top level for discoverability
        if (res && typeof res === 'object') {
          if (res.market) {
            const gex = res.market?.vector?._meta?.gex;
            if (gex) {
              res.market.exposures = {
                spotPrice: gex.spotPrice,
                netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
                netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
                callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
                gammaMagnet: gex.absGamma,
                regime: gex.regime,
              };
            }
          }
          if (include_symbols && res.symbols && typeof res.symbols === 'object') {
            const TOP_N_PER_TIER = 8;
            const tierMeta: Record<string, { total: number; returned: number }> = {};
            for (const [tier, scopeRows] of Object.entries(res.symbols) as [string, any[]][]) {
              if (!Array.isArray(scopeRows)) continue;
              for (const row of scopeRows) {
                hoistModelCoverage(row);
                const gex = row?.vector?._meta?.gex;
                if (gex) {
                  row.exposures = {
                    spotPrice: gex.spotPrice,
                    netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
                    netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
                    callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
                    gammaMagnet: gex.absGamma,
                    regime: gex.regime,
                  };
                }
                // Humanize per-symbol drivers + vector feature-key records so
                // include_symbols=true raw payload doesn't leak backend identifiers.
                humanizeRegimeEntry(row);
                // Per-symbol classification tier, published as `symbolTier` so
                // the output doesn't collide with the input `scope` selector.
                if (row && typeof row === 'object' && 'scope' in row) {
                  row.symbolTier = row.scope;
                  delete row.scope;
                }
                // Drop the raw vector blob now that exposures + humanized features
                // have been hoisted. The blob carried backend identifiers
                // (callWall/gammaFlip in _meta.gex, raw z/raw/data_quality maps)
                // and inflated this response from ~150 KB to ~900 KB.
                if (row && typeof row === 'object') {
                  delete row.vector;
                }
              }
              // Every tier is ordered by absolute stress score, and the long
              // ones are capped to top-N so the response stays in a
              // ChatGPT-friendly range (~124 symbols across all tiers pushed it
              // past 100 KB even after vector stripping). The sort used to run
              // only where the cap did, so the uncapped tiers came back in the
              // proxy's alphabetical order under a description that said
              // "sorted by absolute stress score".
              const stressOf = (row: any): number => {
                // Live rows expose stress_score; some legacy paths may use
                // score. Coalesce so the cap genuinely keeps the strongest
                // signals instead of silently sorting everything as 0.
                const v = row?.stress_score ?? row?.score;
                return typeof v === 'number' ? Math.abs(v) : 0;
              };
              const sorted = [...scopeRows].sort((a, b) => stressOf(b) - stressOf(a));
              if (scopeRows.length > TOP_N_PER_TIER) {
                tierMeta[tier] = { total: scopeRows.length, returned: TOP_N_PER_TIER };
                (res.symbols as any)[tier] = sorted.slice(0, TOP_N_PER_TIER);
              } else {
                (res.symbols as any)[tier] = sorted;
              }
            }
            if (Object.keys(tierMeta).length > 0) {
              res._symbols_truncation_meta = {
                selection: 'top symbols per tier by absolute stress score',
                tiers: tierMeta,
              };
            }
          }
          // The market entry takes the same shape on both paths. This one
          // used to humanize and strip it instead, so with the breakdown the
          // composite lost its feature_z_scores and their meta.
          if (include_symbols && res.market && typeof res.market === 'object') {
            res.market = (shapeMarketRegimeResponse({ market: res.market }) as { market: unknown }).market;
          }
        }
        // Don't bypass the size guard. Vector stripping + top-N-per-tier
        // typically lands the response well under 50 KB, but on rare market
        // states the guard is the safety net so we never silently emit a
        // 100+ KB blob ChatGPT cannot consume.
        // The note sits beside `market`, where the other scopes carry it.
        if (include_symbols) return res && typeof res === 'object' ? { ...res, _stress_score_note: STRESS_SCORE_NOTE, _exposures_note: SYMBOLS_EXPOSURES_NOTE } : res;
        if (res && typeof res === 'object' && 'market' in res) {
          return shapeMarketRegimeResponse({ market: res.market, _stress_score_note: STRESS_SCORE_NOTE });
        }
        return res;
      }

      if (scope === 'intraday') {
        if (!symbol) throw new Error("scope='intraday' requires `symbol`");
        const intradayDays = days ?? 5;
        const params: Record<string, string> = { days: String(intradayDays) };
        if (date) params.date = date;
        if (interval) params.interval = interval;
        const res = await client.get(`/regime/intraday/${encodeURIComponent(symbol)}`, params) as any;
        // Rename per-scan `scope` (symbol classification tier) to a prose key so it
        // doesn't collide with the top-level `scope` input parameter at the MCP boundary.
        // Also humanize per-scan driver feature names (snake_case → "Title Case") so
        // an LLM relaying the response doesn't surface backend identifiers to end users.
        if (res?.scans && Array.isArray(res.scans)) {
          for (const scan of res.scans) {
            if (scan && typeof scan === 'object') {
              if ('scope' in scan) {
                scan.symbolTier = scan.scope;
                delete scan.scope;
              }
              // Humanize drivers + vector feature-key records for the raw intraday payload.
              humanizeRegimeEntry(scan);
              hoistPriorLabel(scan);
              hoistExposures(scan, 5);
            }
          }
          res._scans_meta = { ...(res._scans_meta ?? {}), order: INTRADAY_SCAN_ORDER };
        }
        if (res && typeof res === 'object') {
          res._stress_score_note = STRESS_SCORE_NOTE;
          res._exposures_note = EXPOSURES_NOTE;
        }
        return res;
      }

      // scope === 'symbol'
      if (!symbol) throw new Error("scope='symbol' requires `symbol`");
      const symbolDays = days ?? 1;
      if (symbolDays > 30) {
        throw new Error("scope='symbol' 'days' must be between 1 and 30");
      }
      const res = await client.get(`/regime/symbol/${encodeURIComponent(symbol.toUpperCase())}`, {
        days: String(symbolDays),
      }) as any;

      if (!res?.history?.length) {
        // Return a structured no-data record instead of null so the LLM can
        // explain to the user that no daily symbol-regime classification has
        // been computed for this ticker yet, rather than reporting a tool
        // failure. Mirrors the shape used by the populated path.
        return {
          symbol: symbol.toUpperCase(),
          // Use `view` instead of `scope` so the no-data record doesn't
          // re-introduce an output `scope` field on a path where the
          // populated response uses a `symbolTier` key instead.
          view: 'symbol',
          dataAvailable: false,
          message: 'No daily symbol-regime data available for this symbol. Symbol-regime classification covers a curated universe; not every ticker is included.',
        };
      }

      // Rename top-level `scope` (symbol classification tier — bellwether/sector/etc.)
      // to `symbolTier` so it doesn't collide with the MCP input parameter named `scope`
      // (which selects 'market' | 'symbol' | 'intraday' view, a different axis entirely).
      if ('scope' in res) {
        res.symbolTier = res.scope;
        delete res.scope;
      }
      // The one-day path below rebuilds its object, so it attaches its own
      // note and carries no history to order.
      res._stress_score_note = STRESS_SCORE_NOTE;
      res._exposures_note = EXPOSURES_NOTE;
      res._history_meta = { ...(res._history_meta ?? {}), order: 'oldest first' };

      // Humanize each history entry's drivers + vector feature-key records so backend
      // identifiers don't surface to end users when the LLM relays the response.
      // Covers default mode AND full=true raw payload below.
      for (const entry of res.history) {
        humanizeRegimeEntry(entry);
      }

      if (full) {
        for (const entry of res.history) {
          hoistModelCoverage(entry);
          const gex = entry?.vector?._meta?.gex;
          if (gex) {
            entry.exposures = {
              spotPrice: gex.spotPrice,
              netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
              netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
              callWall: gex.callWall, putWall: gex.putWall, gammaFlip: gex.gammaFlip,
	              gammaMagnet: gex.absGamma,
	              regime: gex.regime, topStrikes: compactTopStrikes(gex.topStrikes),
	            };
	          }
	          delete entry.vector;
	        }
        return { _skipSizeGuard: true, data: res };
      }

      for (const entry of res.history) {
        hoistExposures(entry);
      }

      if (symbolDays === 1) {
        const latest = res.history[res.history.length - 1];
        return {
          symbol: res.symbol,
          symbolTier: res.symbolTier,
          ...latest,
          _stress_score_note: STRESS_SCORE_NOTE,
          _exposures_note: EXPOSURES_NOTE,
        };
      }

      return res;
    }),
  );
}
