/**
 * get_custom_indicator_spec (2026-10-09): the format reference for custom indicator scripts on the Stock Charts page,
 * served from the generated copy of apps/web's AI prompt (customIndicatorSpec.generated.ts, pinned to the builder by
 * apps/web's aiPrompt.test.ts). The default call is an INDEX of fetchable sections; a call with a section id returns
 * that part or subsection; the `format` part is served by subsection only (its whole is over the 50 KB response
 * budget); every answer goes through toolHandler (the wire sanitizer, the vendor scrub, the size guard).
 */
import { describe, expect, test } from 'bun:test';
import { USAGE_READING_LIST, registerCustomIndicatorSpec, splitSubsections, sectionSlug } from './customIndicatorSpec.js';
import { CUSTOM_INDICATOR_SPEC } from './customIndicatorSpec.generated.js';
import { MAX_RESPONSE_BYTES, utf8ByteLength } from './helpers.js';

function capture() {
  const tools: Array<{ name: string; config: Record<string, any>; handler: (args: any) => Promise<any> }> = [];
  const server = { registerTool(name: string, config: Record<string, any>, handler: (args: any) => Promise<any>) { tools.push({ name, config, handler }); } };
  registerCustomIndicatorSpec(server as any);
  expect(tools).toHaveLength(1);
  const tool = tools[0];
  const call = async (args: Record<string, unknown>) => {
    const r = await tool.handler(args);
    expect(r.isError, JSON.stringify(r).slice(0, 300)).toBeFalsy();
    const text: string = r.content[0].text;
    expect(utf8ByteLength(text)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);   // the size guard never trips: no section is over the budget
    return { body: JSON.parse(text), structured: r.structuredContent };
  };
  return { tool, call };
}

describe('get_custom_indicator_spec', () => {
  test('registers read-only with a title, an output schema and a section enum of the index plus every fetchable id', () => {
    const { tool } = capture();
    expect(tool.name).toBe('get_custom_indicator_spec');
    expect(tool.config.title).toBe('Custom Indicator Spec');
    expect(tool.config.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    expect(tool.config.outputSchema).toBeTruthy();
    const values: string[] = tool.config.inputSchema.section.unwrap().options ?? tool.config.inputSchema.section.options;
    expect(values[0]).toBe('index');
    expect(values).toContain('ta');
    expect(values).toContain('examples');
    expect(values).toContain('pineConversion');
    expect(values).toContain('format.intro');
    expect(values).toContain('format.input');
    expect(values).not.toContain('format');   // the whole format part is over the budget: by subsection only
    expect(values).not.toContain('all');
  });

  test("the enum is EXACTLY 'index' plus the index's ids (a direct handler call bypasses the SDK's input validation, so an id missing from the enum would still answer here - a review survivor)", async () => {
    const { tool, call } = capture();
    const values: string[] = tool.config.inputSchema.section.unwrap().options ?? tool.config.inputSchema.section.options;
    const { body } = await call({});
    expect([...values].sort()).toEqual(['index', ...body.sections.map((s: any) => s.id)].sort());
    for (const id of USAGE_READING_LIST) expect(body.sections.map((s: any) => s.id)).toContain(id);   // the usage text's reading list names live ids
    expect(body.text).toMatch(/when the engine gives one/);
    expect(body.text).toMatch(/'examples' for the complete scripts as one part or 'examples\.<slug>' for one of them \(the index lists both\)/);
    expect(body.text).toMatch(/one complete script per indicator asked for, each in its own code block/);   // the same instruction as the format section's intro (review)
    expect(body.text).not.toMatch(/ONE complete script/);
  });

  test('the format and examples parts rebuilt from the HANDLER responses equal the generated copy byte for byte (the splitter pin alone let a same-length edit of the returned text through - review\'s round-1 survivor)', async () => {
    const { call } = capture();
    const { body } = await call({});
    for (const part of ['format', 'examples'] as const) {
      const ids = body.sections.filter((s: any) => s.id.startsWith(`${part}.`)).map((s: any) => s.id);
      const texts: string[] = [];
      for (const id of ids) texts.push((await call({ section: id })).body.text);
      expect(texts.join('\n')).toBe(CUSTOM_INDICATOR_SPEC[part]);
    }
  });

  test("every quoted section reference in the usage text - either quote style, any part, with or without a subsection slug - is an id of the index (the reading list builds its sentence; a stray reference elsewhere in the text fails here too - review)", async () => {
    const { call } = capture();
    const { body } = await call({});
    const ids = new Set(body.sections.map((s: any) => s.id));
    const named = [...body.text.matchAll(/['"]((?:format|ta|examples|pineConversion)(?:\.[a-z0-9-]+)?)['"]/g)].map((m: RegExpMatchArray) => m[1]);   // `'format.*'` (a wildcard, not an id) does not match
    expect(named.length).toBeGreaterThanOrEqual(USAGE_READING_LIST.length + 3);
    for (const id of named) expect(ids.has(id), id).toBe(true);
    for (const id of USAGE_READING_LIST) expect(named).toContain(id);
  });

  test('the index: apiVersion 1, a usage text naming the page, and every fetchable section with its part, title and size - ids unique, format absent, each resolving to a text of that size', async () => {
    const { call } = capture();
    const { body, structured } = await call({});
    expect(structured).toEqual(body);
    expect(body.apiVersion).toBe(1);
    expect(body.section).toBe('index');
    expect(body.text).toMatch(/Stock Charts/);
    expect(body.text).toMatch(/NOT Pine Script/);
    const ids = body.sections.map((s: any) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('format');
    expect(ids.slice(0, 3)).toEqual(['format.intro', 'format.execution-model', 'format.globals-available-to-the-script']);
    expect(ids).toContain('ta');
    expect(ids).toContain('examples');
    expect(ids).toContain('pineConversion');
    expect(ids.filter((id: string) => id.startsWith('format.'))).toHaveLength(18);   // the intro + the 17 `##` subsections
    expect(ids.filter((id: string) => id.startsWith('ta.'))).toHaveLength(0);   // no `##` in the ta table: the whole part only, no duplicate intro
    expect(ids.filter((id: string) => id.startsWith('examples.'))).toHaveLength(9);   // the intro + the eight examples
    for (const s of body.sections) {
      expect(['format', 'ta', 'examples', 'pineConversion']).toContain(s.part);
      expect(typeof s.title).toBe('string');
      const { body: one } = await call({ section: s.id });
      expect(one.section).toBe(s.id);
      expect(one.title).toBe(s.title);
      expect(one.chars).toBe(s.chars);
      expect(one.text.length).toBe(s.chars);
      expect(one.apiVersion).toBe(1);
    }
  });

  test('a part is served whole and VERBATIM (no scrub rewrites it): ta, examples and pineConversion equal the generated copy', async () => {
    const { call } = capture();
    expect((await call({ section: 'ta' })).body.text).toBe(CUSTOM_INDICATOR_SPEC.ta);
    expect((await call({ section: 'examples' })).body.text).toBe(CUSTOM_INDICATOR_SPEC.examples);
    expect((await call({ section: 'pineConversion' })).body.text).toBe(CUSTOM_INDICATOR_SPEC.pineConversion);
    expect(CUSTOM_INDICATOR_SPEC.ta.startsWith('# ta.* - the technical analysis library')).toBe(true);
    expect(CUSTOM_INDICATOR_SPEC.pineConversion.startsWith('# Converting a Pine Script')).toBe(true);
  });

  test('a subsection is the heading line through the line before the next heading; the subsections of a part joined with a newline rebuild the part exactly', async () => {
    const { call } = capture();
    const { body: input } = await call({ section: 'format.input' });
    expect(input.text.startsWith('## input.*')).toBe(true);
    expect(input.text).not.toMatch(/\n## /);   // one subsection, no other heading inside
    expect(input.title).toBe('input.*');
    const { body: intro } = await call({ section: 'format.intro' });
    expect(intro.text.startsWith('# Custom indicator script - format reference (apiVersion: 1)')).toBe(true);
    expect(intro.text).toMatch(/NOT Pine Script/);
    for (const part of ['format', 'examples'] as const) {
      const chunks = splitSubsections(part, CUSTOM_INDICATOR_SPEC[part]);
      expect(chunks.map((c) => c.text).join('\n')).toBe(CUSTOM_INDICATOR_SPEC[part]);
      expect(chunks[0].id).toBe(`${part}.intro`);
      for (const c of chunks.slice(1)) expect(c.text.startsWith('## ')).toBe(true);
    }
    expect(splitSubsections('ta', CUSTOM_INDICATOR_SPEC.ta)).toHaveLength(1);   // the ta table has no `##`: the part alone
  });

  test('sectionSlug: lowercase words to the first colon, parenthesis or dash clause, non-alphanumerics to hyphens, 48 chars at most, never empty', () => {
    expect(sectionSlug('Execution model: whole-series arrays, one run')).toBe('execution-model');
    expect(sectionSlug('plot(), hline(), plotcandle(), plotbar()')).toBe('plot');
    expect(sectionSlug('input.*')).toBe('input');
    expect(sectionSlug('RSI with an optional moving average (a pane script)')).toBe('rsi-with-an-optional-moving-average');
    expect(sectionSlug('Drawing objects: label, line, box, polyline, linefill (and chart.point)')).toBe('drawing-objects');
    expect(sectionSlug('Channel breakout with shapes, a tinted background and recolored bars (an overlay script)')).toBe('channel-breakout-with-shapes-a-tinted-background');
    expect(sectionSlug('ta.* - the technical analysis library')).toBe('ta');
    expect(sectionSlug('(((')).toBe('section');
    expect(sectionSlug('---').length).toBeGreaterThan(0);
  });

  test('duplicate headings get numbered ids, in order, and a numbered id is RESERVED: Same, Same, Same-2 never collide (review\'s round-1 P3)', () => {
    const chunks = splitSubsections('examples', '# X\n\n## Same (a)\n\nbody a\n\n## Same (b)\n\nbody b\n');
    expect(chunks.map((c) => c.id)).toEqual(['examples.intro', 'examples.same', 'examples.same-2']);
    expect(chunks.map((c) => c.title)).toEqual(['X', 'Same (a)', 'Same (b)']);
    const clash = splitSubsections('examples', '# X\n\n## Same\n\na\n\n## Same\n\nb\n\n## Same-2\n\nc\n');
    expect(clash.map((c) => c.id)).toEqual(['examples.intro', 'examples.same', 'examples.same-2', 'examples.same-2-2']);
    expect(new Set(clash.map((c) => c.id)).size).toBe(clash.length);
  });

  test('the whole spec would not fit one answer, which is why the format part is by subsection: its text is over the budget while every served section is under it', () => {
    expect(utf8ByteLength(JSON.stringify({ text: CUSTOM_INDICATOR_SPEC.format }))).toBeGreaterThan(MAX_RESPONSE_BYTES);
    const whole = [CUSTOM_INDICATOR_SPEC.format, CUSTOM_INDICATOR_SPEC.ta, CUSTOM_INDICATOR_SPEC.examples, CUSTOM_INDICATOR_SPEC.pineConversion].join('\n');
    expect(whole.length).toBeGreaterThan(90000);
    expect(CUSTOM_INDICATOR_SPEC.apiVersion).toBe(1);
  });
});
