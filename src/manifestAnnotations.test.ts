import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('MCP package manifest tool annotations', () => {
  test('keeps Anthropic MCPB manifest packable while submission JSON carries behavior hints', () => {
    const manifestPath = resolve(__dirname, '../manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      tools?: Array<{ name?: string; annotations?: Record<string, unknown> }>;
    };

    expect(manifest.tools?.length).toBe(32);
    for (const tool of manifest.tools ?? []) {
      // Anthropic's .mcpb manifest schema rejects arbitrary per-tool
      // annotation keys. ChatGPT review hint data lives in the source runtime
      // descriptors and generated chatgpt-app-submission.json instead.
      expect(tool.annotations, `${tool.name} package manifest annotations`).toBeUndefined();
    }

    const submissionPath = resolve(__dirname, '../chatgpt-app-submission.json');
    if (existsSync(submissionPath)) {
      const submission = JSON.parse(readFileSync(submissionPath, 'utf8')) as {
        tools?: Record<string, { annotations?: Record<string, unknown> }>;
      };
      for (const tool of manifest.tools ?? []) {
        const annotations = submission.tools?.[tool.name ?? '']?.annotations;
        expect(annotations, `${tool.name} submission annotations`).toEqual({
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        });
      }
    }
  });
});
