import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LiveApiClient } from '../../proxy/liveApiClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { summarizeRegimeFits } from './regimeFitsShaping.js';

/**
 * Calibration fit history, from the proxy's /regime/fits/:symbol/history.
 *
 * NOT get_regime. That reads regime DETECTION - which market state we think we
 * are in. This reads regime_model_fits: the parameters each of the eight
 * pricing models was calibrated to for this symbol, and how well each one
 * actually fit. Different table, different question, and a caller that wants
 * "what is Heston's vol-of-vol for SPY" has nowhere else to ask.
 *
 * `days` COUNTS DATES. The route walks the history newest-first by keyset and
 * stops after `days` distinct market dates, however many models wrote on each,
 * so days=30 is thirty trading sessions - not, as the former data-api route
 * had it, a budget of days*8 rows that a missing model quietly widened. Out of
 * range is refused with 400 rather than clamped; the schema here keeps the
 * same 1..365 so the refusal is never reached from this tool.
 *
 * COVERAGE IS THE REGIME UNIVERSE, about 124 symbols. A symbol outside it
 * returns an empty history, not an error, and the description says so: a
 * model told "no fits" must not read it as "this platform cannot do this".
 */
export function register(server: McpServer, client: LiveApiClient): void {
  server.registerTool(
    'get_regime_fits',
    {
      title: 'Model Calibration Fits (Pro)',
      description:
        'Get the calibrated parameters and fit quality for the eight pricing models (Black-Scholes, Heston, SABR, Variance Gamma, Merton, Kou, Bates, eSSVI) for one symbol. '
        + 'Answers "what parameters were fitted, and how well did each model fit" - use get_regime instead for which market regime a symbol is in, which is a different question and a different dataset. '
        + 'Returns each model\'s latest parameters with its IV and price RMSE, plus a short error history showing whether the fit is stable. '
        + 'failedQualityCheck true means the fit was REJECTED: it did not converge, or fewer than three options could be repriced, or its error exceeded the threshold. Only the first substitutes the parameters; the other two leave a real fitted set that was then rejected. Either way the fit was not accepted, so do not present those parameters as a good fit for this symbol. '
        + 'Coverage is the regime universe of about 124 symbols; a symbol outside it returns an empty history rather than an error. '
        + 'Requires a Pro subscription or above.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY)'),
        days: z.number().int().min(1).max(365).optional()
          .describe('How many distinct market dates to return, newest first, each carrying every model that wrote on that date. Default 30. Maximum 365.'),
        historyLimit: z.number().int().min(1).max(60).optional()
          .describe('Error-history entries kept per model, newest first. Default 10. Reduced automatically when many model versions are present so that no model is dropped; coverage.historyRequested says so when that happens.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, days, historyLimit }) => {
      const params: Record<string, string> = {};
      if (days !== undefined) params.days = String(days);

      const res = await client.get(
        `/regime/fits/${encodeURIComponent(symbol.toUpperCase())}/history`,
        params,
      ) as any;

      return summarizeRegimeFits(res, { historyLimit });
    }),
  );
}
