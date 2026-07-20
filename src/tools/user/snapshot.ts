import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { syncedDataOutputSchema } from '../outputSchemas.js';
import {
  compactPortfolioHistoryResponse,
  dedupePortfolioSnapshotRecords,
  dedupeRiskSnapshotRecords,
  normalizePortfolioSnapshotSymbols,
  replaceDuplicatedDataField,
  shapePortfolioDetails,
  shapeRiskDetails,
  stripSyncRecordMetadata,
} from './syncResponseShaping.js';

/**
 * Unified user-snapshot tool. Replaces get_gex_snapshot /
 * get_portfolio_snapshot / get_risk_snapshot with one enum-driven
 * tool. Each type keeps its own shaping, dedupe, and response shape.
 */

const GEX_KEY_HUMANIZE: Record<string, string> = {
  callWall: 'call wall',
  putWall: 'put wall',
  gammaFlip: 'gamma flip',
  absGamma: 'abs gamma',
  gammaTilt: 'gamma tilt',
  secondaryFlips: 'secondary flips',
};

/** Rename camelCase wall/flip/tilt keys on a GEX record block to space-separated
 *  equivalents so the LLM doesn't surface backend identifiers verbatim. Mutates
 *  in place; only rewrites keys that appear in GEX_KEY_HUMANIZE. */
function humanizeGexLevels(target: unknown): void {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return;
  const obj = target as Record<string, unknown>;
  for (const [k, humanK] of Object.entries(GEX_KEY_HUMANIZE)) {
    if (k in obj) {
      obj[humanK] = obj[k];
      delete obj[k];
    }
  }
}

function readNumericKey(target: unknown, keys: string[]): number | null {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null;
  const obj = target as Record<string, unknown>;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function enrichGexComboDetails(record: unknown): void {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return;
  const row = record as Record<string, any>;
  const details = row.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return;
  const rawCombos = Array.isArray(details.comboStrikes) ? details.comboStrikes : [];
  if (!rawCombos.length) return;
  const rawStrikeCount = new Set(
    rawCombos
      .map((combo: any) => Number(combo?.strike))
      .filter((strike: number) => Number.isFinite(strike))
  ).size;

  const callWall = readNumericKey(row.data, ['callWall', 'call wall']) ?? readNumericKey(row, ['callWall', 'call wall']);
  const putWall = readNumericKey(row.data, ['putWall', 'put wall']) ?? readNumericKey(row, ['putWall', 'put wall']);
  if (callWall == null || putWall == null) {
    details.rawComboStrikeCount = rawStrikeCount;
    details.visibleComboStrikeCount = 0;
    details.visibleComboStrikes = [];
    return;
  }

  const low = Math.min(callWall, putWall);
  const high = Math.max(callWall, putWall);
  const seen = new Set<number>();
  const visibleCombos = rawCombos.filter((combo: any) => {
    const strike = Number(combo?.strike);
    if (!Number.isFinite(strike) || strike < low || strike > high || seen.has(strike)) return false;
    seen.add(strike);
    return true;
  });

  details.rawComboStrikeCount = rawStrikeCount;
  details.visibleComboStrikeCount = visibleCombos.length;
  details.visibleComboStrikes = visibleCombos;
}

function stripRiskContributionBreakdowns(value: unknown, depth = 0): void {
  if (depth > 20 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) stripRiskContributionBreakdowns(item, depth + 1);
    return;
  }

  const obj = value as Record<string, unknown>;
  delete obj.positionContributions;
  delete obj.position_contributions;
  for (const child of Object.values(obj)) {
    stripRiskContributionBreakdowns(child, depth + 1);
  }
}

function replaceDuplicatedDetailsInSnapshotRows(res: any): void {
  if (!res || !Array.isArray(res.data)) return;
  for (const record of res.data) {
    replaceDuplicatedDataField(record, 'details', '[see top-level details]');
  }
}

const SNAPSHOT_DESCRIPTION = `Get the user's synced snapshot history by type. Each type serves a different question:

• type="gex" — per-symbol Gamma Exposure snapshots. REQUIRED: \`symbol\`. Returns the 3 most recent snapshots (no dedupe — rows may be near-duplicates if recorded back-to-back). Includes per-expiration breakdown, call/put walls, gamma flip point, abs gamma anchor, unusual activity, expected move data, and raw vs in-wall visible combo-strike counts.
• type="portfolio" — account-wide portfolio snapshots with market-scaled raw Greeks (no \$): first-order delta, gamma, theta/day, vega/1% IV, rho/1% rate; second-order vanna/1% IV, charm/day (delta decay), vomma/1% IV², veta/day (vega decay, sign-flipped for market convention). Default view collapses consecutive identical snapshots to surface the latest distinct states. For \$-impact views of the same Greeks, use type="risk".
• type="risk" — account-wide risk-analysis snapshots: Value-at-Risk (95%/99%), Conditional VaR, portfolio beta, Sharpe ratio, maximum drawdown, volatility, stress test results, and aggregate Greek \$-impact exposure. \$-Greeks include first-order dollarDelta, dollarGamma (per 1% move), dollarTheta/day, dollarVega (per 1% IV), dollarRho (per 1% rate) and second-order dollarVanna (per 1% IV move), dollarCharm (daily \$Δ decay), dollarVomma (per 1% IV), dollarVeta (daily vega decay). Units & sign convention: var95/var99/cvar95/maxDrawdown/volatility are in PERCENT (e.g., 2.5 = 2.5%); volatility is annualized; var95/var99/cvar95/maxDrawdown are POSITIVE loss magnitudes (e.g., var95=2.5 means a 2.5% loss). beta/sharpeRatio are dimensionless. stressResults[].impact is signed \$ P&L; impactPercent is signed % of portfolio. details.historicalVarDetails: worstDay is POSITIVE magnitude of the worst single-day LOSS (worstDay=13.46 means a 13.46% loss, NOT a 13.46% gain); bestDay and avgReturn are SIGNED percent returns. Default view collapses consecutive identical snapshots. For raw-unit Greeks, use type="portfolio".`;

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_snapshot',
    {
      title: 'Account Snapshots',
      description: SNAPSHOT_DESCRIPTION,
      inputSchema: {
        type: z.enum(['gex', 'portfolio', 'risk']).describe('Which snapshot feed to fetch.'),
        symbol: z.string().optional().describe('Required for type=gex; ignored otherwise.'),
        limit: z.number().int().min(1).max(50).default(3).describe('Max snapshots (default 3)'),
        full: z.boolean().default(false).describe('Return the less-summarized sanitized payload including detail tables, correlation matrices, and per-position breakdowns, still subject to the MCP response budget.'),
      },
      outputSchema: syncedDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ type, symbol, limit, full }) => {
      if (type === 'gex') {
        if (!symbol) throw new Error("type='gex' requires `symbol`");
        const res = await client.get('/sync/analysis-data', { type: 'gex', symbol, limit: String(limit) }) as any;
        // Humanize wall/flip/tilt keys on every GEX record's data block (and the
        // record root, defensively) before either default shaping OR full-mode
        // raw return so backend identifiers (callWall, gammaFlip, etc.) don't
        // surface verbatim in user-facing summaries.
        if (res && Array.isArray(res.data)) {
          for (const record of res.data) {
            stripSyncRecordMetadata(record);
            enrichGexComboDetails(record);
            humanizeGexLevels(record);
            if (record && typeof record === 'object' && record.data && typeof record.data === 'object') {
              humanizeGexLevels(record.data);
            }
          }
        }
        if (full && res != null) {
          replaceDuplicatedDetailsInSnapshotRows(res);
          return { _skipSizeGuard: true, data: res };
        }
        // Details contain per-expiration arrays — strip those and keep summary.
        if (res && Array.isArray(res.data)) {
          res.data = res.data.map((record: any) => {
            stripSyncRecordMetadata(record);
            if (record.details && typeof record.details === 'object') {
              const d = record.details;
              if (Array.isArray(d)) {
                record.details = { _omitted: [`expiration breakdowns (${d.length} items)`] };
              } else {
                const summary: Record<string, unknown> = {};
                const omittedKeys: string[] = [];
                for (const [k, v] of Object.entries(d)) {
                  if (Array.isArray(v)) {
                    const human = k.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
                    omittedKeys.push(`${human} (${v.length} items)`);
                  } else { summary[k] = v; }
                }
                if (omittedKeys.length) summary._omitted = omittedKeys;
                record.details = summary;
              }
            }
            replaceDuplicatedDataField(record, 'details', '[see top-level details]');
            return record;
          });
        }
        return res;
      }

      if (type === 'portfolio') {
        const fetchLimit = full ? limit : Math.min(limit * 5, 50);
        const res = await client.get('/sync/analysis-data', { type: 'portfolio', limit: String(fetchLimit) }) as any;
        if (full && res != null) {
          if (res && Array.isArray(res.data)) {
            for (const record of res.data) {
              stripSyncRecordMetadata(record);
            }
          }
          replaceDuplicatedDetailsInSnapshotRows(res);
          return { _skipSizeGuard: true, data: res };
        }
        if (res && Array.isArray(res.data)) {
          res.data = res.data.map((record: any) => {
            stripSyncRecordMetadata(record);
            normalizePortfolioSnapshotSymbols(record);
            if (record.details && typeof record.details === 'object') {
              record.details = shapePortfolioDetails(record.details);
            }
            replaceDuplicatedDataField(record, 'details', '[see top-level details]');
            return record;
          });
          const deduped = dedupePortfolioSnapshotRecords(res.data, limit);
          res.data = deduped.records;
          res.count = res.data.length;
          if (deduped.omittedCount > 0) {
            res._dedupe_meta = { collapsed_repeated: deduped.omittedCount };
          }
          compactPortfolioHistoryResponse(res);
        }
        return res;
      }

      // type === 'risk'
      const fetchLimit = full ? limit : Math.min(limit * 5, 50);
      const res = await client.get('/sync/analysis-data', { type: 'risk', limit: String(fetchLimit) }) as any;
      if (full && res != null) {
        if (res && Array.isArray(res.data)) {
          for (const record of res.data) {
            stripSyncRecordMetadata(record);
          }
        }
        stripRiskContributionBreakdowns(res);
        replaceDuplicatedDetailsInSnapshotRows(res);
        return { _skipSizeGuard: true, data: res };
      }
      if (res && Array.isArray(res.data)) {
        res.data = res.data.map((record: any) => {
          stripSyncRecordMetadata(record);
          if (record.details && typeof record.details === 'object') {
            record.details = shapeRiskDetails(record.details);
          }
          replaceDuplicatedDataField(record, 'details', '[see top-level details]');
          return record;
        });
        const deduped = dedupeRiskSnapshotRecords(res.data, limit);
        res.data = deduped.records;
        res.count = res.data.length;
        if (deduped.omittedCount > 0) {
          res._dedupe_meta = { collapsed_repeated: deduped.omittedCount };
        }
      }
      return res;
    }, { isSyncTool: true }),
  );
}
