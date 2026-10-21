import { z } from 'zod';

// The 44 generic envelopes (38 market, 6 synced) carry validation only: every client reads this prose in tools/list on
// every connection, and the field names say what they hold. dataAvailable keeps a description because its meaning is
// not in its name: a structured failure sets it false too (helpers.ts, the structured API error branch).
const commonOutputFields = {
  dataAvailable: z.boolean().optional()
    .describe('False when no data was returned: nothing matched, or the call failed (a failed call also carries error and code).'),
  message: z.string().optional(),
  note: z.string().optional(),
  data: z.unknown().optional(),
  summary: z.unknown().optional(),
  count: z.number().optional(),
  // null: the request named no symbol (compute_scenario priced from supplied inputs answers `symbol: null`)
  symbol: z.string().nullable().optional(),
  source: z.string().optional(),
  status: z.string().optional(),
  responseBudget: z.unknown().optional(),
};

export const marketDataOutputSchema = z.object(commonOutputFields).passthrough();

export const syncedDataOutputSchema = z.object(commonOutputFields).passthrough();

export const platformInfoOutputSchema = z.object({
  topic: z.enum(['models', 'greeks', 'capabilities', 'all'])
    .describe('Platform context topic returned by the tool.'),
  text: z.string().describe('Static platform context text for the requested topic.'),
}).passthrough().describe('Static Options Analysis Suite platform context.');

export const customIndicatorSpecOutputSchema = z.object({
  apiVersion: z.number().describe('The custom indicator script format version (changes are additive).'),
  section: z.string().describe("'index', or the id of the fetched section."),
  text: z.string().describe('The usage text of the index, or the fetched section (markdown).'),
  part: z.string().optional().describe("The fetched section's part: format, ta, examples or pineConversion."),
  title: z.string().optional().describe("The fetched section's heading."),
  chars: z.number().optional().describe("The fetched section's length in characters."),
  sections: z.array(z.object({
    id: z.string(), part: z.string(), title: z.string(), chars: z.number(),
  })).optional().describe('The index: every fetchable section with its part, heading and size.'),
}).passthrough().describe('The custom indicator script format reference, by section.');
