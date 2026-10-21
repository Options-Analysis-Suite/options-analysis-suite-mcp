import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerAllTools } from '../registry.js';
import { getMcpServerInfo } from '../../server.js';
import { INDICATOR_NAMES } from './indicatorNames.js';

/**
 * Both get_intraday_bars and get_stock_prices publish the Stock Charts catalogue as a closed enum
 * for `indicators[].name`, so clients can see every supported computation before calling either tool.
 */
// The public mirror ships the MCP server alone, without packages/shared: there the comparison has nothing to read.
const SHARED_PACKAGE = resolve(import.meta.dir, '../../../../packages/shared');
const CATALOGUE = resolve(SHARED_PACKAGE, 'src/indicators/catalogue.ts');
const catalogueTypes = () => {
  const src = readFileSync(CATALOGUE, 'utf8');
  return [...new Set([...src.matchAll(/type: '([a-zA-Z0-9_-]+)'/g)].map((m) => m[1]))].sort();
};

async function connected(calls: string[]) {
  const server = new McpServer(getMcpServerInfo());
  const record = { get: async (path: string) => { calls.push(path); return {}; }, post: async (path: string) => { calls.push(path); return {}; } } as any;
  registerAllTools(server, record, { getAccessToken: async () => 'token' } as any, record);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'indicator-names', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { server, client };
}

describe('indicator names are a closed, visible list', () => {
  test.skipIf(!existsSync(SHARED_PACKAGE))('the list equals the shared Stock Charts catalogue, every type once', () => {
    expect([...INDICATOR_NAMES] as string[]).toEqual(catalogueTypes());
    expect(INDICATOR_NAMES.length).toBe(58);
  });

  test('get_intraday_bars and get_stock_prices publish it as the name enum', async () => {
    const { server, client } = await connected([]);
    try {
      const tools = (await client.listTools()).tools;
      for (const name of ['get_intraday_bars', 'get_stock_prices']) {
        const schema = tools.find((t) => t.name === name)!.inputSchema as any;
        expect(schema.properties.indicators.items.properties.name.enum, name).toEqual([...INDICATOR_NAMES]);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  test('an unknown indicator name is refused before any request', async () => {
    const calls: string[] = [];
    const { server, client } = await connected(calls);
    try {
      for (const name of ['get_intraday_bars', 'get_stock_prices']) {
        const outcome = await client.callTool({ name, arguments: { symbol: 'SPY', indicators: [{ name: 'not_an_indicator' }] } })
          .then((r: any) => r.isError === true, () => true);
        expect(outcome, name).toBe(true);
      }
      expect(calls).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
