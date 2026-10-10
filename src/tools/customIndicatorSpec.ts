/**
 * Custom Indicator Spec Tool (2026-10-09)
 *
 * The format reference for custom indicator scripts on the Stock Charts page - the exact text the page's
 * "Copy AI prompt" button gives a model (apps/web's buildAiPrompt(), checked in here as the generated copy
 * customIndicatorSpec.generated.ts, written by apps/web's writeAiPrompt.ts and pinned to the builder by its
 * aiPrompt.test.ts; this server depends on nothing in apps/web). A connector user asks a model for an indicator;
 * the model fetches the spec from here and answers with a script the user pastes into the page.
 *
 * Sectioned: the whole text is about 100 KB, twice the response budget, so the default call returns an INDEX of
 * fetchable sections and each call fetches one. The four parts are `format` (the API, served by subsection only -
 * its whole is over the budget), `ta` (the technical-analysis library), `examples` (whole, or one example) and
 * `pineConversion`; a part's `##` subsections are `<part>.<slug>` with the text before the first heading as
 * `<part>.intro`. Every answer goes through toolHandler like every other tool (the wire sanitizer, the vendor scrub,
 * the size guard - which no section reaches).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CUSTOM_INDICATOR_SPEC } from './customIndicatorSpec.generated.js';
import { customIndicatorSpecOutputSchema } from './outputSchemas.js';
import { toolHandler } from './helpers.js';

export type SpecPart = 'format' | 'ta' | 'examples' | 'pineConversion';
export interface SpecSection { id: string; part: SpecPart; title: string; text: string }

const PARTS: readonly SpecPart[] = ['format', 'ta', 'examples', 'pineConversion'];
/** The whole part is fetchable when its text fits the response budget; `format` (about 57 KB) does not. */
const WHOLE_PARTS: readonly SpecPart[] = ['ta', 'examples', 'pineConversion'];

/** A heading's id: lowercase words up to the first colon, parenthesis or " - " clause, non-alphanumerics to hyphens, 48 chars at most, never empty. */
export function sectionSlug(heading: string): string {
  const cut = heading.split(/[:(]| - /)[0] ?? '';
  const slug = cut.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug || 'section';
}

const headingTitle = (line: string): string => line.replace(/^#{1,2}\s+/, '').trim();

/**
 * A part's text split at its `## ` headings: the text before the first (the part's `# ` line and its intro) as
 * `<part>.intro`, then one chunk per heading through the line before the next; the chunks joined with a newline
 * rebuild the part exactly. Duplicate slugs are numbered in order.
 */
export function splitSubsections(part: SpecPart, text: string): SpecSection[] {
  const lines = text.split('\n');
  const starts: number[] = [];
  lines.forEach((l, i) => { if (l.startsWith('## ')) starts.push(i); });
  const out: SpecSection[] = [];
  const taken = new Set<string>();   // every EMITTED id (a numbered one too, so `same`, `same`, `same-2` never collide - the review's round 1)
  const push = (base: string, title: string, chunk: string[]) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    out.push({ id, part, title, text: chunk.join('\n') });
  };
  const firstHeading = starts.length > 0 ? starts[0] : lines.length;
  const introTitle = lines.find((l) => l.startsWith('# ')) ?? part;
  push(`${part}.intro`, headingTitle(introTitle), lines.slice(0, firstHeading));
  starts.forEach((s, k) => {
    const e = k + 1 < starts.length ? starts[k + 1] : lines.length;
    push(`${part}.${sectionSlug(headingTitle(lines[s]))}`, headingTitle(lines[s]), lines.slice(s, e));
  });
  return out;
}

/** Every fetchable section in index order: a part's subsections (format), or the whole part and then its subsections (examples), or the whole part alone (ta, pineConversion). */
function buildSections(): SpecSection[] {
  const out: SpecSection[] = [];
  for (const part of PARTS) {
    const text = CUSTOM_INDICATOR_SPEC[part];
    const sub = splitSubsections(part, text);
    if (WHOLE_PARTS.includes(part)) out.push({ id: part, part, title: headingTitle(text.split('\n')[0]), text });
    if (sub.length > 1) out.push(...sub);   // a part without `##` headings (ta) is served whole only
  }
  return out;
}

const SECTIONS = buildSections();
const BY_ID = new Map(SECTIONS.map((s) => [s.id, s]));
const INDEX = SECTIONS.map((s) => ({ id: s.id, part: s.part, title: s.title, chars: s.text.length }));
const IDS = ['index', ...SECTIONS.map((s) => s.id)] as [string, ...string[]];

/** The ids USAGE tells a model to read first - its sentence is BUILT from this list, and a test checks every id the usage text names exists in the index; a test checks each one exists in the index (a renamed heading moves an id). */
export const USAGE_READING_LIST = ['format.intro', 'format.execution-model', 'format.globals-available-to-the-script', 'format.indicator', 'format.input', 'format.plot'] as const;
const USAGE = [
  "The format reference for custom indicator scripts on the Options Analysis Suite's Stock Charts page (apiVersion 1): plain JavaScript in the page's own format, NOT Pine Script, run in a sandbox with no network, DOM, imports or timers. The whole reference is about 100 KB, so fetch the sections you need by id: the 'format.*' subsections for the API (the format part is served by subsection), 'ta' for the technical-analysis library, 'examples' for the complete scripts as one part or 'examples.<slug>' for one of them (the index lists both), 'pineConversion' to convert a Pine Script, ThinkScript or Python indicator.",
  `Read ${USAGE_READING_LIST.slice(0, -1).map((id) => `'${id}'`).join(', ')} and '${USAGE_READING_LIST[USAGE_READING_LIST.length - 1]}' before writing anything, then the sections the task needs.`,
  "Answer the user with one complete script per indicator asked for, each in its own code block; the user pastes it into the page's Indicators > Custom scripts > New script and presses Check, which reports an error with its line when the engine gives one.",
].join(' ');

export function registerCustomIndicatorSpec(server: McpServer): void {
  server.registerTool(
    'get_custom_indicator_spec',
    {
      title: 'Custom Indicator Spec',
      description: "Get the format reference for custom indicator scripts on the Stock Charts page - the exact text the page's Copy-AI-prompt button gives a model, so you can write or convert an indicator the user pastes into the page. Call without a section for the index of fetchable sections (the whole reference is about 100 KB, over one answer's budget), then fetch sections by id: 'format.*' for the API, 'ta' for the technical-analysis library, 'examples' or one example, 'pineConversion' to convert Pine Script / ThinkScript / Python.",
      inputSchema: {
        section: z.enum(IDS).default('index')
          .describe("'index' (the default) lists every fetchable section with its size; otherwise a section id from the index"),
      },
      outputSchema: customIndicatorSpecOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ section }: { section?: string }) => {
      const id = section ?? 'index';
      if (id === 'index') return { apiVersion: CUSTOM_INDICATOR_SPEC.apiVersion, section: 'index', text: USAGE, sections: INDEX };
      const s = BY_ID.get(id);
      if (!s) throw new Error(`unknown section '${id}' - call without a section for the index`);
      return { apiVersion: CUSTOM_INDICATOR_SPEC.apiVersion, section: s.id, part: s.part, title: s.title, chars: s.text.length, text: s.text };
    }),
  );
}
