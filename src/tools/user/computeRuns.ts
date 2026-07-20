import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { syncedDataOutputSchema } from '../outputSchemas.js';
import { isCurrentComputeRunRecord, recordMatchesComputeFilters, sanitizeComputeRunsWireOutput, summarizeComputeRunsResponse, trimFullComputeRunsResponse } from './computeRunsShaping.js';
import { sanitizeFullSyncResponse } from './syncResponseShaping.js';

const ISO_CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RFC3339_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function isValidCalendarDate(year: string, month: string, day: string): boolean {
  const value = `${year}-${month}-${day}`;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime())
    && date.getUTCFullYear() === Number(year)
    && date.getUTCMonth() + 1 === Number(month)
    && date.getUTCDate() === Number(day);
}

function isStrictSince(value: string): boolean {
  const calendarMatch = ISO_CALENDAR_DATE.exec(value);
  if (calendarMatch?.[0] === value) {
    return isValidCalendarDate(calendarMatch[1], calendarMatch[2], calendarMatch[3]);
  }

  const instantMatch = RFC3339_INSTANT.exec(value);
  if (instantMatch?.[0] !== value) return false;

  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = instantMatch;
  if (!isValidCalendarDate(year, month, day)
    || Number(hour) > 23
    || Number(minute) > 59
    || Number(second) > 59
    || (offsetHour !== undefined && Number(offsetHour) > 23)
    || (offsetMinute !== undefined && Number(offsetMinute) > 59)) {
    return false;
  }

  // Keep the MCP contract aligned with the proxy, which converts this exact string to epoch ms.
  return Number.isFinite(Date.parse(value));
}

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_compute_runs',
    {
      title: 'AI Compute Suite Runs',
      description: 'Get the user\'s AI Compute Suite run history — portfolio-wide batch analyses across multiple pricing models. Default response returns compact run summaries, model-dispersion highlights, exposure levels, and representative position/model consensus summaries. Use view=\'detailed\' to inspect per-model outputs for one matched run; detailed view only takes effect when exactly one run matches, and multi-run responses are always summarized.',
      inputSchema: {
        run_key: z.string().optional().describe('Exact run key for one specific compute run'),
        status: z.enum(['completed', 'cancelled', 'failed']).optional().describe('Filter by terminal run status'),
        scope: z.enum(['core', 'full']).optional().describe('Filter by compute scope'),
        quality: z.enum(['balanced', 'precise']).optional().describe('Filter by compute quality'),
        underlying: z.string().optional().describe('Only runs containing this underlying symbol'),
        view: z.enum(['summary', 'detailed']).default('summary').describe('summary returns compact model consensus across all returned runs; detailed returns per-model outputs and only applies when exactly one run is returned'),
        limit: z.number().int().min(1).max(50).default(5).describe('Max runs to return (default 5)'),
        since: z.string()
          // Date.parse alone accepts locale forms, epoch-like values, and calendar overflow. Accept only
          // an exact calendar date or a complete RFC3339 instant with an explicit timezone.
          .refine(isStrictSince, {
            message: 'since must be YYYY-MM-DD or an RFC3339 instant with an explicit timezone',
          })
          .optional()
          .describe('Only runs on or after this ISO date or RFC3339 instant (timezone required)'),
        full: z.boolean().default(false).describe('Return less-summarized sanitized compute-run rows instead of the compact assistant view'),
      },
      outputSchema: syncedDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ run_key, status, scope, quality, underlying, view, limit, since, full }) => {
      const res = await client.get('/sync/analysis-data', {
        type: 'compute',
        // Compute runs are retained server-side in a bounded 200-row window.
        // Always inspect that complete window: applying a heuristic fetch size
        // before nested filters can hide an otherwise valid older match.
        limit: '200',
        ...(since ? { since } : {}),
        ...(run_key ? { run_key } : {}),
        ...(status ? { status } : {}),
        ...(scope ? { scope } : {}),
        ...(quality ? { quality } : {}),
        ...(underlying ? { underlying } : {}),
      }) as any;

      if (res && Array.isArray(res.data)) {
        const hasFilter = Boolean(run_key || status || scope || quality || underlying || since);
        const matched = res.data
          .filter(isCurrentComputeRunRecord)
          .filter((record: unknown) => recordMatchesComputeFilters(record, {
            runKey: run_key,
            status,
            scope,
            quality,
            underlying,
          }));
        res.data = matched.slice(0, limit);
        res.count = res.data.length;
        // Only attach selection metadata (requestedLimit/matchedCount/hasMore) when a filter was
        // actually supplied or something matched. Otherwise a truly-empty, no-filter account would
        // always carry selection metadata and get the "No data matched the requested filters"
        // message instead of falling through to toolHandler's sync-enable guidance.
        if (hasFilter || matched.length > 0) {
          res.requestedLimit = limit;
          res.matchedCount = matched.length;
          res.hasMore = matched.length > res.count;
        }
      }

      if (full && res != null) {
        sanitizeFullSyncResponse(res);
        sanitizeComputeRunsWireOutput(res);
        trimFullComputeRunsResponse(res);
        return { _skipSizeGuard: true, data: res };
      }
      return summarizeComputeRunsResponse(res, view);
    }, { isSyncTool: true }),
  );
}
