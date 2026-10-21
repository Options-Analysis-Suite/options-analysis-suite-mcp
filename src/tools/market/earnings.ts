import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { LiveApiError, type LiveApiClient } from '../../proxy/liveApiClient.js';
import { ApiError } from '../../types.js';
import { MAX_RESPONSE_BYTES, sanitizeMcpWireOutput, toolHandler, utf8ByteLength, WIRE_CEILING_BYTES } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { RESPONSE_MARGIN_BYTES } from './dealerPositioningShaping.js';
import { summarizeEarnings, summarizeEarningsMoves } from './earningsShaping.js';
import {
  SEARCH_BUDGET_BYTES, SUMMARY_BUDGET_BYTES, fitTranscriptBlock, shapeTranscriptSearch, shapeTranscriptSummary, transcriptRefusal,
  transcriptUnreadable,
} from './transcriptShaping.js';

/**
 * Earnings history and estimates, and with `includeMoves` the realized and
 * implied moves around each past report from the proxy's moves route. The
 * moves are a second request with its own refusals (a symbol with no report
 * on file, an outage of the closes), and a refusal there is reported in the
 * answer beside the history the caller also asked for, never in place of it.
 * `transcript` is a third such request: a generated summary of an earnings
 * call (or the summary lines matching a query), never the call's text.
 * A body that is not JSON (the live client's plain ApiError) is reported the
 * same way, as a retryable INVALID_RESPONSE; a refused sign-in (AuthError) is
 * not a refusal of one section and still fails the answer.
 */
export function register(server: McpServer, client: ProxyClient, liveClient: LiveApiClient): void {
  server.registerTool(
    'get_earnings',
    {
      title: 'Earnings',
      description: 'Get earnings history and estimates for a company. Returns actual EPS, estimates, revenue, and surprise percentages. Earnings events are the largest source of overnight gap risk for options - check if an upcoming earnings date falls within an option\'s expiration window. Shows last 8 quarters by default. '
        + 'With `includeMoves: true`, also returns the realized and implied moves around each of the last eight past reports: both one-session moves (prior close to report-day close, and report-day close to next close, because the report\'s time of day is often not on file; `timing` says when it is), the implied move from the stored at-the-money straddle on the session before the report when that chain is on file (`impliedSource: "straddle"`, within the last twelve months of stored chains) else from the stored ATM IV as a one-day approximation (`"atmIv"`) else null with the reason, the IV crush across the report on one tenor, and realized-over-implied ratios; the summary counts each implied source. '
        + 'A symbol with no report on file, or an outage of the price history, is reported under `moves` with its code while the history still returns. '
        + 'With `transcript`, also returns under `transcript` a generated summary of an earnings call - never the transcript itself - checked against the call (every quote word for word with its speaker, every figure present in the call): the prepared remarks by speaker, each analyst question with the gist of the answers, the guidance given, and up to five short quotes. `transcript: {}` gives the newest call with a summary; `fiscalYear` with `quarter` names one call; `query` instead returns the summary lines containing every query word, across the newest calls (`calls`, default 4, max 8) or in the one named call. '
        + 'Coverage today is mostly each company\'s latest call; `callsOnFile` lists the calls on file with their summary state, and a refusal (no call on file, no summary for that call) is reported under `transcript` with its code while the history still returns.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        includeMoves: z.boolean().default(false).describe('Add the realized and implied moves around each past report (one more request).'),
        transcript: z.object({
          fiscalYear: z.number().int().min(1990).max(2100).optional().describe('The call\'s fiscal year (with quarter).'),
          quarter: z.number().int().min(1).max(4).optional().describe('The call\'s fiscal quarter, 1-4 (with fiscalYear).'),
          query: z.string().min(2).max(200).optional().describe('Words to find in the summaries, e.g. "tariffs guidance"; every word must appear in a returned line.'),
          calls: z.number().int().min(1).max(8).optional().describe('With query and no fiscalYear/quarter: how many of the newest calls to search (default 4).'),
        }).optional().describe('Add a generated summary of an earnings call (one more request): {} for the newest call with a summary, fiscalYear + quarter for one call, query to search the summaries.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, includeMoves, transcript }) => {
      const upper = symbol.toUpperCase();
      const res = await client.get(`/earnings/${encodeURIComponent(upper)}`) as any;
      const history = summarizeEarnings(res, 8);
      if (includeMoves !== true && transcript === undefined) return history;
      const out: Record<string, unknown> = { ...(history as Record<string, unknown>) };
      if (includeMoves === true) {
        try {
          out.moves = summarizeEarningsMoves(await liveClient.get(`/earnings/${encodeURIComponent(upper)}/moves`));
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          out.moves = error instanceof LiveApiError
            ? { dataAvailable: false, code: error.code ?? null, message: error.message }
            : { dataAvailable: false, code: 'INVALID_RESPONSE', message: 'The moves could not be read. This may be retried.' };
        }
      }
      if (transcript !== undefined) {
        const params = new URLSearchParams();
        if (transcript.fiscalYear !== undefined) params.set('fiscalYear', String(transcript.fiscalYear));
        if (transcript.quarter !== undefined) params.set('quarter', String(transcript.quarter));
        const base = `/earnings/${encodeURIComponent(upper)}/transcripts`;
        // The block gets what the answer has left beside the history and the moves (at most its own budget), measured
        // as sent, so the 50 KB guard never has to cut the answer it is part of.
        const room = MAX_RESPONSE_BYTES - RESPONSE_MARGIN_BYTES - utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput(out)));
        let block: Record<string, unknown>;
        try {
          if (transcript.query !== undefined) {
            params.set('q', transcript.query);
            if (transcript.calls !== undefined) params.set('calls', String(transcript.calls));
            block = shapeTranscriptSearch(await liveClient.get(`${base}/search?${params}`), Math.min(SEARCH_BUDGET_BYTES, room));
          } else {
            const qs = params.toString();
            block = shapeTranscriptSummary(await liveClient.get(`${base}/summary${qs ? `?${qs}` : ''}`), Math.min(SUMMARY_BUDGET_BYTES, room));
          }
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          block = error instanceof LiveApiError ? transcriptRefusal(error) : transcriptUnreadable();
        }
        // The last word on size, for a refusal too: the whole answer measured exactly as the guard measures it, against
        // the guard's own line (WIRE_CEILING_BYTES, not the full 51,200: an answer between the two would pass here and
        // then lose list items to the guard), so a block whose fixed fields alone do not fit gives way to a notice
        // rather than costing the history and moves.
        const fits = (candidate: Record<string, unknown>) =>
          utf8ByteLength(JSON.stringify(sanitizeMcpWireOutput({ ...out, transcript: candidate }))) <= WIRE_CEILING_BYTES;
        const fitted = fitTranscriptBlock(block, fits);
        if (fitted !== undefined) out.transcript = fitted;
      }
      return out;
    }),
  );
}
