import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
    expect(manifest.tools?.length).toBe(45);
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
        // Behavior hints only: `title` is the display name, not a hint, and
        // the submission's form does not carry it.
        const { title: _title, ...hints } = registered.get(tool.name ?? '')!;
        expect(annotations, `${tool.name} submission annotations`).toEqual(hints);
      }
    }
  });
});

describe('tool display names', () => {
  test('every tool lists its title as annotations.title too, on the wire', async () => {
    // Anthropic's connector directory reads a tool's display name from
    // annotations.title and flags a tool without one; the SDK publishes the
    // top-level `title` separately. Listed through a real client, since the
    // directory reads tools/list, not the registration call.
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const stub = { get: async () => ({}), post: async () => ({}) } as any;
    registerAllTools(server, stub, { getAccessToken: async () => 'token' } as any, stub);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(45);
    for (const tool of tools) {
      expect(typeof tool.title === 'string' && tool.title.length > 0, `${tool.name} title`).toBe(true);
      expect(tool.annotations?.title, `${tool.name} annotations.title`).toBe(tool.title);
    }
    // The behavior hints are untouched beside it.
    const live = tools.find((tool) => tool.name === 'get_live_dealer_positioning')!;
    expect(live.annotations).toEqual({
      title: 'Live Dealer Positioning / GEX (Pro)', readOnlyHint: true, destructiveHint: false, openWorldHint: true,
    });
    await client.close();
    await server.close();
  });
});
