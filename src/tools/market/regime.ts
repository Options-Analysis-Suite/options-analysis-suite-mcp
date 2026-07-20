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

const STRESS_SCORE_NOTE = 'stress_score is a raw composite regime score, not a 0-100 index. Typical bands: CALM < -0.5, NORMAL -0.5 to 0.5, ELEVATED 0.5 to 1.5, STRESS 1.5 to 2.5, CRISIS >= 2.5.';

const REGIME_DESCRIPTION = `Get regime data at one of three scopes. Pick the scope that matches the question; irrelevant sub-params are ignored.

• scope="market" — MARKET COMPOSITE stress regime (aggregate across SPY/QQQ/IWM/DIA, not per-symbol). Returns composite stress score, confidence, key drivers, feature z-scores. Bands: CALM < -0.5, NORMAL -0.5..0.5, ELEVATED 0.5..1.5, STRESS 1.5..2.5, CRISIS ≥ 2.5. Accepts \`date\` (YYYY-MM-DD, default latest) and \`include_symbols\` (default false; true also returns up to the top 8 symbols per classification tier sorted by absolute stress score, with raw vector internals stripped).
• scope="symbol" — per-symbol daily regime + authoritative Greek exposures (net gamma/delta/vega/vanna/charm/vomma, call wall, put wall, gamma flip, abs gamma anchor, top 10 gamma strikes). REQUIRED: \`symbol\`. Accepts \`days\` (default 1 = latest, max 30) and \`full\` (default false; true keeps less-summarized history with vector internals stripped). This is the correct scope for "what are SPY's Greek exposures?" — do NOT use get_options_analytics_history for current exposures.
• scope="intraday" — intraday regime scan history for a symbol: 5 scans/day (open, morning, midday, afternoon, pre-close), each with stress scoring, regime classification, and compact Greek exposure snapshots. REQUIRED: \`symbol\`. Accepts \`days\` (default 5, max 90), \`date\` (overrides days), and \`interval\` (filter to a single scan).`;

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

function hoistExposures(entry: any, topStrikeLimit = 10): any {
  const gex = entry?.vector?._meta?.gex;
  if (gex) {
    entry.exposures = {
      spotPrice: gex.spotPrice,
      netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
      netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
      'call wall': gex.callWall, 'put wall': gex.putWall, 'gamma flip': gex.gammaFlip,
      'abs gamma': gex.absGamma,
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
        days: z.number().int().min(1).max(90).optional().describe('For scope=symbol: history days (default 1, max 30). For scope=intraday: history days (default 5, max 90).'),
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
            res.market._stress_score_note = STRESS_SCORE_NOTE;
            const gex = res.market?.vector?._meta?.gex;
            if (gex) {
              res.market.exposures = {
                spotPrice: gex.spotPrice,
                netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
                netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
                'call wall': gex.callWall, 'put wall': gex.putWall, 'gamma flip': gex.gammaFlip,
                'abs gamma': gex.absGamma,
                regime: gex.regime,
              };
            }
          }
          if (include_symbols && res.symbols && typeof res.symbols === 'object') {
            res._stress_score_note = STRESS_SCORE_NOTE;
            const TOP_N_PER_TIER = 8;
            const tierMeta: Record<string, { total: number; returned: number }> = {};
            for (const [tier, scopeRows] of Object.entries(res.symbols) as [string, any[]][]) {
              if (!Array.isArray(scopeRows)) continue;
              for (const row of scopeRows) {
                const gex = row?.vector?._meta?.gex;
                if (gex) {
                  row.exposures = {
                    spotPrice: gex.spotPrice,
                    netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
                    netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
                    'call wall': gex.callWall, 'put wall': gex.putWall, 'gamma flip': gex.gammaFlip,
                    'abs gamma': gex.absGamma,
                    regime: gex.regime,
                  };
                }
                // Humanize per-symbol drivers + vector feature-key records so
                // include_symbols=true raw payload doesn't leak backend identifiers.
                humanizeRegimeEntry(row);
                // Per-symbol classification tier — use a prose key so the MCP
                // output doesn't collide with the input `scope` selector or leak
                // a camelCase boundary label.
                if (row && typeof row === 'object' && 'scope' in row) {
                  row['symbol tier'] = row.scope;
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
              // Cap each tier to top-N by absolute stress score so the response
              // stays in a ChatGPT-friendly range. Without this cap, ~124 symbols
              // across all tiers still pushed the response past 100 KB even after
              // vector stripping.
              if (scopeRows.length > TOP_N_PER_TIER) {
                const stressOf = (row: any): number => {
                  // Live rows expose stress_score; some legacy paths may use
                  // score. Coalesce so the cap genuinely keeps the strongest
                  // signals instead of silently sorting everything as 0.
                  const v = row?.stress_score ?? row?.score;
                  return typeof v === 'number' ? Math.abs(v) : 0;
                };
                const sorted = [...scopeRows].sort((a, b) => stressOf(b) - stressOf(a));
                tierMeta[tier] = { total: scopeRows.length, returned: TOP_N_PER_TIER };
                (res.symbols as any)[tier] = sorted.slice(0, TOP_N_PER_TIER);
              }
            }
            if (Object.keys(tierMeta).length > 0) {
              res._symbols_truncation_meta = {
                selection: 'top symbols per tier by absolute stress score',
                tiers: tierMeta,
              };
            }
          }
          // Also humanize the top-level market entry for include_symbols=true raw mode
          // (default scope=market path runs through shapeMarketRegimeResponse separately).
          if (include_symbols && res.market && typeof res.market === 'object') {
            humanizeRegimeEntry(res.market);
            delete (res.market as any).vector;
          }
        }
        // Don't bypass the size guard. Vector stripping + top-N-per-tier
        // typically lands the response well under 50 KB, but on rare market
        // states the guard is the safety net so we never silently emit a
        // 100+ KB blob ChatGPT cannot consume.
        if (include_symbols) return res;
        if (res && typeof res === 'object' && 'market' in res) {
          return shapeMarketRegimeResponse({ market: res.market });
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
                scan['symbol tier'] = scan.scope;
                delete scan.scope;
              }
              // Humanize drivers + vector feature-key records for the raw intraday payload.
              humanizeRegimeEntry(scan);
              hoistExposures(scan, 5);
            }
          }
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
          // populated response uses a prose "symbol tier" key instead.
          view: 'symbol',
          dataAvailable: false,
          message: 'No daily symbol-regime data available for this symbol. Symbol-regime classification covers a curated universe; not every ticker is included.',
        };
      }

      // Rename top-level `scope` (symbol classification tier — bellwether/sector/etc.)
      // to a prose key so it doesn't collide with the MCP input parameter named `scope`
      // (which selects 'market' | 'symbol' | 'intraday' view, a different axis entirely).
      if ('scope' in res) {
        res['symbol tier'] = res.scope;
        delete res.scope;
      }

      // Humanize each history entry's drivers + vector feature-key records so backend
      // identifiers don't surface to end users when the LLM relays the response.
      // Covers default mode AND full=true raw payload below.
      for (const entry of res.history) {
        humanizeRegimeEntry(entry);
      }

      if (full) {
        for (const entry of res.history) {
          const gex = entry?.vector?._meta?.gex;
          if (gex) {
            entry.exposures = {
              spotPrice: gex.spotPrice,
              netGamma: gex.netGamma, netDelta: gex.netDelta, netVega: gex.netVega,
              netVanna: gex.netVanna, netCharm: gex.netCharm, netVomma: gex.netVomma,
              'call wall': gex.callWall, 'put wall': gex.putWall, 'gamma flip': gex.gammaFlip,
	              'abs gamma': gex.absGamma,
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
          'symbol tier': res['symbol tier'],
          ...latest,
        };
      }

      return res;
    }),
  );
}
