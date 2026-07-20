import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { AuthError, SubscriptionError } from '../../types.js';
import { summarizeDarkPoolResponse } from './darkPoolDataShaping.js';

type FetchResult = { kind: 'ok'; data: any } | { kind: 'missing' } | { kind: 'failed'; error: string };

/** Fetch with partial-failure support: rethrow auth/subscription errors, tag others */
async function safeGet(client: ProxyClient, path: string): Promise<FetchResult> {
  try {
    const data = await client.get(path);
    return data == null ? { kind: 'missing' } : { kind: 'ok', data };
  } catch (err: any) {
    if (err instanceof AuthError || err instanceof SubscriptionError) throw err;
    return { kind: 'failed', error: err.message };
  }
}

function firmResult(result: FetchResult, missingNote: string, failedNote: string): { data?: unknown; note?: string } {
  if (result.kind === 'ok') return { data: result.data };
  if (result.kind === 'missing') return { note: missingNote };
  return { note: `${failedNote}: ${result.error}` };
}

const DARK_POOL_DESCRIPTION = `Get FINRA OTC (dark pool / non-ATS) and ATS (Alternative Trading System) weekly trading statistics for a symbol. The \`view\` param controls the granularity:

• view="summary" (default) — aggregate weekly OTC + ATS volume/trade trends with a compact summary + trend analysis.
• view="dealers" — per-DEALER breakdown of OTC (non-ATS) activity. Top 15 MPIDs per week with participant name, shares, and trades. Answers "who is executing this flow off-exchange, off-ATS?"
• view="venues" — per-VENUE breakdown of ATS activity. Top 15 dark-pool venues per week with MPID, venue name, shares, and trades. Answers "which dark pools are matching this ticker?"
• view="all" — returns summary + dealers + venues in one payload. Larger — expect more token usage.

Optional: \`weeks\` (1..260, default 12) narrows the history window for dealers/venues/all. High dark-pool activity can signal institutional accumulation or distribution; per-dealer and per-venue views surface who specifically is active.`;

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_dark_pool_data',
    {
      title: 'Dark Pool & ATS Data',
      description: DARK_POOL_DESCRIPTION,
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        view: z.enum(['summary', 'dealers', 'venues', 'all']).default('summary').describe('Aggregate summary (default), per-dealer OTC breakdown, per-venue ATS breakdown, or all three.'),
        weeks: z.number().int().min(1).max(260).optional().describe('Only for view=dealers/venues/all: history weeks (default 12).'),
        full: z.boolean().optional().describe('Only for view=summary: return the less-summarized OTC and ATS weekly history (raw shape, still subject to the MCP response budget).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, view, weeks, full }) => {
      const sym = encodeURIComponent(symbol.toUpperCase());
      const weeksParam = weeks != null ? `?weeks=${weeks}` : '';
      // Belt-and-suspenders: Zod applies default('summary') server-side,
      // but this keeps direct-invocation paths (tests, custom callers)
      // behaving the same.
      const effectiveView = view ?? 'summary';

      if (effectiveView === 'summary') {
        const [otcResult, atsResult] = await Promise.all([
          safeGet(client, `/finra/otc-trading/${sym}`),
          safeGet(client, `/finra/ats-data/${sym}`),
        ]);
        const bothMissing = otcResult.kind === 'missing' && atsResult.kind === 'missing';
        const bothFailed = otcResult.kind === 'failed' && atsResult.kind === 'failed';
        if (bothMissing) return null;
        if (bothFailed) throw new Error('Both OTC and ATS data sources failed for this symbol');
        const result: Record<string, unknown> = {};
        if (otcResult.kind === 'ok') result.otcTrading = otcResult.data;
        else result._otc_note = otcResult.kind === 'failed' ? `OTC data unavailable: ${otcResult.error}` : 'No OTC data for this symbol';
        if (atsResult.kind === 'ok') result.atsData = atsResult.data;
        else result._ats_note = atsResult.kind === 'failed' ? `ATS data unavailable: ${atsResult.error}` : 'No ATS data for this symbol';
        if (full) return { _skipSizeGuard: true, data: result };
        return summarizeDarkPoolResponse(result);
      }

      if (effectiveView === 'dealers') {
        const res = await safeGet(client, `/finra/otc-trading/${sym}/firms${weeksParam}`);
        if (res.kind === 'missing') return null;
        if (res.kind === 'failed') throw new Error(`OTC dealer breakdown unavailable: ${res.error}`);
        return res.data;
      }

      if (effectiveView === 'venues') {
        const res = await safeGet(client, `/finra/ats-data/${sym}/firms${weeksParam}`);
        if (res.kind === 'missing') return null;
        if (res.kind === 'failed') throw new Error(`ATS venue breakdown unavailable: ${res.error}`);
        return res.data;
      }

      // view === 'all' — aggregate + dealers + venues in one shot.
      // `weeks` applies to ALL four paths (aggregate + firm-level), so a
      // caller asking for weeks=4 gets consistent window sizing across
      // the whole envelope, not a 4-week firm breakdown against a
      // default-12-week aggregate summary.
      const [otcAggResult, atsAggResult, otcFirmsResult, atsFirmsResult] = await Promise.all([
        safeGet(client, `/finra/otc-trading/${sym}${weeksParam}`),
        safeGet(client, `/finra/ats-data/${sym}${weeksParam}`),
        safeGet(client, `/finra/otc-trading/${sym}/firms${weeksParam}`),
        safeGet(client, `/finra/ats-data/${sym}/firms${weeksParam}`),
      ]);
      const allMissing = [otcAggResult, atsAggResult, otcFirmsResult, atsFirmsResult]
        .every(r => r.kind === 'missing');
      if (allMissing) return null;

      const aggregate: Record<string, unknown> = {};
      if (otcAggResult.kind === 'ok') aggregate.otcTrading = otcAggResult.data;
      if (atsAggResult.kind === 'ok') aggregate.atsData = atsAggResult.data;

      // Mirror view='summary' behavior: expose aggregate partial failures
      // as _otc_note / _ats_note so callers can distinguish "no data"
      // from "upstream failed" without a silent drop.
      const otcAggNote = otcAggResult.kind === 'failed'
        ? `OTC aggregate unavailable: ${otcAggResult.error}`
        : otcAggResult.kind === 'missing'
          ? 'No OTC aggregate data for this symbol'
          : undefined;
      const atsAggNote = atsAggResult.kind === 'failed'
        ? `ATS aggregate unavailable: ${atsAggResult.error}`
        : atsAggResult.kind === 'missing'
          ? 'No ATS aggregate data for this symbol'
          : undefined;

      const otcFirms = firmResult(otcFirmsResult, 'No OTC dealer breakdown for this symbol', 'OTC dealer breakdown unavailable');
      const atsFirms = firmResult(atsFirmsResult, 'No ATS venue breakdown for this symbol', 'ATS venue breakdown unavailable');

      const summary = Object.keys(aggregate).length > 0
        ? summarizeDarkPoolResponse(aggregate)
        : null;

      return {
        summary,
        _otc_note: otcAggNote,
        _ats_note: atsAggNote,
        dealers: otcFirms.data ?? null,
        _dealers_note: otcFirms.note,
        venues: atsFirms.data ?? null,
        _venues_note: atsFirms.note,
      };
    }),
  );
}
