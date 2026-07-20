import { z } from 'zod';

const commonOutputFields = {
  dataAvailable: z.boolean().optional().describe('False when the query completed but no matching data was available.'),
  message: z.string().optional().describe('Human-readable no-data, status, or guidance message.'),
  note: z.string().optional().describe('Additional analyst-facing context or caveat.'),
  data: z.unknown().optional().describe('Primary result payload, used especially when the raw tool output is an array.'),
  summary: z.unknown().optional().describe('Compact summary object when the tool provides one.'),
  count: z.number().optional().describe('Returned item count when present.'),
  symbol: z.string().optional().describe('Ticker symbol when present.'),
  source: z.string().optional().describe('Logical data-source label when present.'),
  status: z.string().optional().describe('Human-readable status when present.'),
  responseBudget: z.unknown().optional().describe('Response-size budget metadata if the payload had to be collapsed.'),
};

export const marketDataOutputSchema = z.object(commonOutputFields).passthrough()
  .describe('Assistant-ready market, regulatory, or screener data returned by Options Analysis Suite.');

export const syncedDataOutputSchema = z.object(commonOutputFields).passthrough()
  .describe('Assistant-ready synced user analysis, compute, scanner, or snapshot data returned by Options Analysis Suite.');

export const platformInfoOutputSchema = z.object({
  topic: z.enum(['models', 'greeks', 'capabilities', 'all'])
    .describe('Platform context topic returned by the tool.'),
  text: z.string().describe('Static platform context text for the requested topic.'),
}).passthrough().describe('Static Options Analysis Suite platform context.');
