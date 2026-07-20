import { describe, expect, test } from 'bun:test';
import { registerPlatformInfo } from './platformInfo.js';
import { registerAllTools } from './registry.js';

function captureRegisteredTools() {
  const tools: Array<{ name: string; config: Record<string, unknown>; handler: Function }> = [];
  const server = {
    registerTool(name: string, config: Record<string, unknown>, handler: Function) {
      tools.push({ name, config, handler });
    },
  };
  return { tools, server };
}

describe('MCP tool output schemas', () => {
  test('all registered tools advertise an outputSchema', () => {
    const { tools, server } = captureRegisteredTools();

    registerAllTools(
      server as any,
      { get: async () => ({}), post: async () => ({}) } as any,
      { getAccessToken: async () => 'token' } as any,
    );

    expect(tools).toHaveLength(32);
    expect(tools.map((tool) => tool.name).sort()).toEqual([...new Set(tools.map((tool) => tool.name))].sort());
    for (const tool of tools) {
      expect(tool.config.outputSchema, `${tool.name} outputSchema`).toBeTruthy();
    }
  });

  test('get_platform_info returns structuredContent and advertises an outputSchema', async () => {
    const { tools, server } = captureRegisteredTools();
    registerPlatformInfo(server as any);

    expect(tools).toHaveLength(1);
    expect(tools[0].config.outputSchema).toBeTruthy();

    const result = await tools[0].handler({ topic: 'models' });
    expect(result.structuredContent).toMatchObject({
      topic: 'models',
      text: expect.stringContaining('Black-Scholes'),
    });
    expect(result.content[0].text).toContain('Black-Scholes');
  });
});
