import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { registerAllTools } from './tools/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The tools the runtime actually registers, with the annotations it declares. */
function registeredAnnotations(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const server = {
    registerTool(name: string, config: { annotations?: Record<string, unknown> }) {
      out.set(name, config.annotations ?? {});
    },
  };
  const stub = { get: async () => ({}), post: async () => ({}) } as any;
  registerAllTools(server as any, stub, { getAccessToken: async () => 'token' } as any, stub);
  return out;
}

describe('MCP package manifest tool annotations', () => {
  test('keeps Anthropic MCPB manifest packable while submission JSON carries behavior hints', () => {
    const registered = registeredAnnotations();
    const manifestPath = resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      tools?: Array<{ name?: string; annotations?: Record<string, unknown> }>;
    };

    // Every registered tool is packaged, and nothing is packaged that the
    // runtime does not register: the two lists are the same set, not the same
    // length. A count alone let the four proxy-backed tools go unpackaged for
    // as long as they were gated off.
    expect(manifest.tools?.length).toBe(38);
    expect(new Set((manifest.tools ?? []).map((tool) => tool.name))).toEqual(new Set(registered.keys()));
    for (const tool of manifest.tools ?? []) {
      // Anthropic's .mcpb manifest schema rejects arbitrary per-tool
      // annotation keys. ChatGPT review hint data lives in the source runtime
      // descriptors and chatgpt-app-submission.json instead.
      expect(tool.annotations, `${tool.name} package manifest annotations`).toBeUndefined();
    }

    const submissionPath = resolve(__dirname, '../chatgpt-app-submission.json');
    if (existsSync(submissionPath)) {
      const submission = JSON.parse(readFileSync(submissionPath, 'utf8')) as {
        tools?: Record<string, { annotations?: Record<string, unknown> }>;
      };
      for (const tool of manifest.tools ?? []) {
        const annotations = submission.tools?.[tool.name ?? '']?.annotations;
        // The SAME hints the runtime declares, not a constant this test
        // repeats. The two live tools reach the user's own broker and say
        // openWorldHint true; a submission that said otherwise for them would
        // be a false statement to the reviewer, and a constant here would
        // have demanded exactly that.
        expect(annotations, `${tool.name} submission annotations`).toEqual(registered.get(tool.name ?? '')!);
      }
    }
  });
});
