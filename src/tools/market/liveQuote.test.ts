import { describe, expect, it } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LiveApiError, type LiveApiClient, type LiveRateLimit } from '../../proxy/liveApiClient.js';
import { WIRE_CEILING_BYTES } from '../helpers.js';
import { register } from './liveQuote.js';

/**
 * get_live_quote relays the proxy's quote payload: a null stays null (the
 * broker published nothing), the budget rides beside it, and the broker's
 * own rate limit reaches the model as its code and wait.
 */
async function harness(answer: () => Promise<unknown>, budget: LiveRateLimit | null = null) {
  const server = new McpServer({ name: 'live-quote-test', version: '1' });
  register(server, {
    get: async (_path: string, _params?: Record<string, string>, onRateLimit?: (r: LiveRateLimit) => void) => {
      const result = await answer();
      if (budget) onRateLimit?.(budget);
      return result;
    },
  } as unknown as LiveApiClient);
  const client = new Client({ name: 'live-quote-consumer', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const payload = {
  schemaVersion: 1, symbol: 'SPX', dataSource: 'live', provider: 'schwab', asOf: '2026-09-17T15:00:00.000Z',
  quote: {
    last: 6500.2, bid: 6500.1, ask: 6500.3, bidSize: 1, askSize: 2, mid: 6500.2, mark: 6500.25,
    open: 6490, high: 6510, low: 6480, previousClose: 6495.5, volume: null,
    quoteTime: '2026-09-17T15:00:00.000Z', tradeTime: null,
  },
  change: 4.7, changePercent: 0.0724,
};

describe('registered live quote tool', () => {
  it('keeps every null, carries the budget with its provider, and matches text to structured output', async () => {
    const { client, close } = await harness(async () => payload, { limit: 120, remaining: 119, resetSeconds: 43, provider: 'schwab' });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX', provider: 'schwab' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.quote.volume).toBeNull();
      expect(wire.quote.tradeTime).toBeNull();
      expect(wire.quote.mark).toBe(6500.25);
      expect(wire.rateLimit).toEqual({ limit: 120, remaining: 119, resetSeconds: 43, provider: 'schwab' });
      expect(wire.symbol).toBe('SPX');
    } finally {
      await close();
    }
  });

  it('reports the budget as null when the proxy sent none', async () => {
    const { client, close } = await harness(async () => payload);
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX' } });
      expect((result.structuredContent as any).rateLimit).toBeNull();
    } finally {
      await close();
    }
  });

  it('relays the broker\'s own rate limit as its code and wait', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('schwab asks for 9 seconds before the next request.', 429, 'BROKER_RATE_LIMITED', true, undefined, { retryAfterSeconds: 9, provider: 'schwab' });
    });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPX' } });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toContain('BROKER_RATE_LIMITED');
      expect(text).toContain('9 seconds');
    } finally {
      await close();
    }
  });
});

describe('get_live_quote error legend', () => {
  it('a Tradier BROKER_REJECTED reaches the client with its meaning in both channels: retrying the same broker will not help', async () => {
    const { client, close } = await harness(async () => {
      throw new LiveApiError('tradier rejected the quote request (HTTP 400)', 502, 'BROKER_REJECTED', false, undefined,
        { brokerFailure: 'http-status', brokerStatus: 400, rateLimit: { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' } });
    });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPY' } });
      expect(result.isError).toBe(true);
      const wire = result.structuredContent as any;
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(wire.code).toBe('BROKER_REJECTED');
      expect(wire.meaning).toMatch(/Retrying the same request on the same broker will not help/);
      expect(wire.meaning).toMatch(/budget after this call/);
      expect(text).toContain(wire.meaning);
    } finally {
      await close();
    }
  });
});


describe('get_live_quote guide', () => {
  const BASE: Record<string, any> = {
    schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-10-14T15:02:20.195Z',
    quote: {
      last: 772.1, bid: 772.07, ask: 772.09, bidSize: 280, askSize: 200, mid: 772.08, mark: null,
      open: 774.92, high: 776.35, low: 771.78, previousClose: 778.01, volume: 11382168,
      quoteTime: '2026-10-14T15:02:19.000Z', tradeTime: '2026-10-14T15:02:19.031Z',
    },
    change: -5.91, changePercent: -0.76, changeBasis: 'broker', changeReason: null, midReason: null,
    stale: false, staleReason: null, lastSessionOpen: '2026-10-14T09:30:00-04:00',
  };
  const BUDGET = { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' };
  type Q = typeof BASE;
  const variant = (over: Partial<Q> & { quote?: Partial<Q['quote']> }): Q =>
    ({ ...BASE, ...over, quote: { ...BASE.quote, ...(over.quote ?? {}) } }) as Q;
  async function guide(payload: unknown, budget: LiveRateLimit | null = BUDGET): Promise<Record<string, string>> {
    const { client, close } = await harness(async () => payload, budget);
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPY' } });
      expect(result.isError).not.toBe(true);
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      expect(wire.quote).toEqual((payload as Q).quote);          // responses only gain
      expect(wire.midReason).toBe((payload as Q).midReason);     // The index marker reaches the client
      return wire.guide;
    } finally {
      await close();
    }
  }
  const INDEX = variant({ symbol: 'SPX', midReason: 'index-not-executable', quote: { mid: null, bidSize: null, askSize: null, volume: null, open: null, high: null, low: null } });

  it('the plain Tradier stock answer carries exactly the every-answer keys and its provider and change keys', async () => {
    expect(Object.keys(await guide(BASE)).sort()).toEqual(
      ['asOf', 'cache', 'change', 'clocks', 'mid', 'nullIsUnknown', 'rateLimit', 'session', 'stale', 'tradier'].sort());
  });

  it('null is not zero, on every answer: never a stand-in, a zero bid or ask kept, a last of 0 goes out null', async () => {
    const g = await guide(variant({ quote: { bid: 0, last: null } }));
    expect(g.nullIsUnknown).toMatch(/did not publish/);
    expect(g.nullIsUnknown).toMatch(/never a stand-in/);
    expect(g.nullIsUnknown).toMatch(/zero bid or ask is kept/);
    expect(g.nullIsUnknown).toMatch(/last.*0.*null/);
  });

  it('the mid definition on every answer, numeric mid included', async () => {
    const g = await guide(BASE);
    expect(g.mid).toMatch(/\(bid \+ ask\) \/ 2/);
    expect(g.mid).toMatch(/both sides are above zero/);
    expect(g.mid).toMatch(/ask is not below the bid/);
    expect(g.mid).toMatch(/never last or mark/);
  });

  it('a null mid is explained - a missing, zero or crossed side, or an index - and absent when the mid is there', async () => {
    expect((await guide(BASE)).midNull).toBeUndefined();
    expect((await guide(variant({ quote: { bid: 0, mid: null } }))).midNull).toMatch(/a side missing or zero, or a crossed market/);
    const index = await guide(INDEX);
    expect(index.midNull).toMatch(/midReason "index-not-executable"/);
    expect(index.midNull).toMatch(/indicative/);
  });

  it('a missing mid gets the same unknown explanation as null', async () => {
    const body = variant({ quote: { bid: 0 } });
    delete body.quote.mid;
    expect((await guide(body)).midNull).toMatch(/a side missing or zero, or a crossed market/);
  });

  it('mark is the broker\'s own valuation, only when one is published', async () => {
    expect((await guide(BASE)).mark).toBeUndefined();
    const g = await guide(variant({ provider: 'tastytrade', quote: { mark: 772.08 } }));
    expect(g.mark).toMatch(/own valuation/);
    expect(g.mark).toMatch(/not an executable quote/);
  });

  it('the change legend per case, with the Schwab clause on Schwab', async () => {
    expect((await guide(BASE)).change).toMatch(/broker's own day change/);
    expect((await guide(BASE)).change).not.toMatch(/regular-session/);
    expect((await guide(variant({ provider: 'schwab' }))).change).toMatch(/regular-session/);
    expect((await guide(variant({ changeBasis: 'previous-close' }))).change).toMatch(/last minus previousClose/);
    expect((await guide(variant({ change: null, changePercent: null, changeBasis: null }))).change).toMatch(/never computed from a stand-in/);
    expect((await guide(variant({ changePercent: null }))).change).toMatch(/changePercent can be null/);
  });

  it('a missing change without a reason still explains why no change can be computed', async () => {
    const body = variant({ changeBasis: null, quote: { last: null } });
    delete body.change;
    delete body.changeReason;
    expect((await guide(body)).change).toMatch(/no change.*last or previousClose is missing.*never computed from a stand-in/);
  });

  it('a missing changePercent beside a numeric change still explains the unknown percent', async () => {
    const body = variant({ change: 0 });
    delete body.changePercent;
    expect((await guide(body)).change).toMatch(/changePercent can be null.*no percent, or previousClose is 0/);
  });

  it('a rolled previous close withholds the change; on moomoo it can only mean last equalled the earlier close', async () => {
    expect((await guide(BASE)).previousCloseRolled).toBeUndefined();
    const rolled = variant({ change: null, changePercent: null, changeBasis: null, changeReason: 'previous-close-rolled' });
    const g = await guide(rolled);
    expect(g.previousCloseRolled).toMatch(/cannot be read/);
    expect(g.previousCloseRolled).toMatch(/genuinely closed flat/);
    expect(g.previousCloseRolled).not.toMatch(/no broker change or a zero one/);
    expect(g.previousCloseRolled).toContain("and the broker sent either no change of its own or a change of 0 (this answer cannot tell which, so it does not show that the broker published no change)");
    const m = await guide({ ...rolled, provider: 'moomoo' });
    expect(m.previousCloseRolled).toMatch(/does not roll/);
    expect(m.previousCloseRolled).toMatch(/last equalled the earlier close/);
  });

  it('the rolled-close guide fits either proxy clock on an early-close date and a regular date', async () => {
    for (const [asOf, rolled] of [
      ['2026-11-27T18:30:00.000Z', true], // 13:30, calendar-aware proxy
      ['2026-11-27T18:30:00.000Z', false], // 13:30, fixed-close proxy
      ['2026-11-27T21:30:00.000Z', true], // 16:30, either proxy
      ['2026-12-18T20:30:00.000Z', false], // 15:30 on a regular date, either proxy
      ['2026-12-18T21:30:00.000Z', true], // 16:30 on a regular date, either proxy
    ] as const) {
      const body = variant({
        provider: 'schwab', asOf, quote: { previousClose: 772.1, quoteTime: asOf, tradeTime: asOf },
        lastSessionOpen: `${asOf.slice(0, 10)}T09:30:00-05:00`,
        change: rolled ? null : 0, changePercent: rolled ? null : 0,
        changeBasis: rolled ? null : 'previous-close', changeReason: rolled ? 'previous-close-rolled' : null,
      });
      const { client, close } = await harness(async () => body);
      try {
        const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPY', provider: 'schwab' } });
        expect(result.isError).not.toBe(true);
        const wire = result.structuredContent as any;
        expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
        expect(wire.change).toBe(rolled ? null : 0);
        if (rolled) {
          expect(wire.guide.previousCloseRolled).toMatch(/09:30 New York to the proxy's close for that date, 16:00 on a regular day/);
          expect(wire.guide.previousCloseRolled).not.toMatch(/09:30-16:00|13:00|early close/);
          expect(wire.guide.previousCloseRolled).toMatch(/withheld, never shown as 0/);
        } else {
          expect(wire.guide.previousCloseRolled).toBeUndefined();
        }
      } finally {
        await close();
      }
    }
  });

  it('a change from a stale quote is withheld; a broker\'s own change beside a stale quote is kept', async () => {
    expect((await guide(BASE)).staleChange).toBeUndefined();
    expect((await guide(variant({ change: null, changePercent: null, changeBasis: null, changeReason: 'stale-quote', stale: true }))).staleChange)
      .toMatch(/the move from the prior close to that early snapshot, not the day's/);
    expect((await guide(variant({ stale: true }))).staleChange).toMatch(/broker's own change.*kept/);
  });

  it('the stale rule on every answer, its false and null cases included', async () => {
    const g = await guide(BASE);
    expect(g.stale).toMatch(/09:30 New York open/);
    expect(g.stale).toMatch(/later of/);
    expect(g.stale).toMatch(/unknown, never fresh/);
    expect(g.stale).toMatch(/False says only/);
    expect(g.stale).toMatch(/no-session-on-file/);
  });

  it('a withheld change is this tool\'s, and true stale is not "nothing traded"', async () => {
    expect((await guide(variant({ change: null, changePercent: null, changeBasis: null, changeReason: 'stale-quote', stale: true }))).staleChange)
      .toBe('changeReason "stale-quote": this tool withheld the change it computed: the quote\'s clocks predate the last session\'s open, so last minus previousClose is the move from the prior close to that early snapshot, not the day\'s.');
    expect((await guide(BASE)).stale).toMatch(/not that the quote is current or a new price printed; true says only .*not that nothing traded since/);
  });

  for (const provider of ['tradier', 'tastytrade']) {
    it(`${provider}'s stale trade clock cannot date bid and ask updates when their clock is missing`, async () => {
      // Both adapters retain bid/ask without their quote clock. The proxy then uses the old trade time alone,
      // so a second answer can carry changed sides and still be stale; the whole snapshot is not proven frozen.
      for (const [bid, ask] of [[100.4, 100.6], [100.8, 101]]) {
        const g = await guide(variant({
          provider, stale: true, staleReason: 'before-last-session-open',
          quote: { bid, ask, quoteTime: null, tradeTime: '2026-10-13T19:59:58.000Z' },
        }));
        expect(g.stale).toMatch(/true says only that every available broker clock predates that open/);
        expect(g.stale).toMatch(/not that nothing traded since or that fields without a clock stayed unchanged/);
        expect(g.stale).not.toMatch(/record shows no update|never updated through the session/);
      }
    });
  }

  for (const [name, over] of [
    ['both clocks', {}],
    ['one quote clock', { quote: { tradeTime: null } }],
    ['one trade clock', { quote: { quoteTime: null } }],
    ['no clocks', { quote: { quoteTime: null, tradeTime: null }, stale: null, staleReason: 'no-timestamps' }],
    ['no session on file', { stale: null, staleReason: 'no-session-on-file', lastSessionOpen: null }],
    ['pre-open', { asOf: '2026-10-14T12:00:00.000Z', lastSessionOpen: '2026-10-13T09:30:00-04:00',
      quote: { quoteTime: '2026-10-13T19:00:00.000Z', tradeTime: '2026-10-13T19:00:00.000Z' } }],
    ['weekend stale quote', { asOf: '2026-10-17T12:00:00.000Z', stale: true, staleReason: 'before-last-session-open', lastSessionOpen: '2026-10-16T09:30:00-04:00' }],
  ] as const) {
    it(`${name} retains the session, one-clock, unknown and cached-flag rules`, async () => {
      const g = await guide(variant(over));
      expect(g.stale).toMatch(/session.*has started/);
      expect(g.stale).toMatch(/today.*09:30.*trading day/);
      expect(g.stale).toMatch(/otherwise.*previous trading day/);
      expect(g.stale).toMatch(/before 09:30.*weekends.*holidays/);
      expect(g.stale).toMatch(/searched back 14 days/);
      expect(g.stale).toMatch(/later of the clocks present/);
      expect(g.stale).toMatch(/one alone decides.*other is null/);
      expect(g.stale).toMatch(/false at or after/);
      expect(g.stale).toMatch(/no clock.*no-timestamps.*no session.*14 days.*no-session-on-file/);
      expect(g.stale).toMatch(/unknown, never fresh/);
      expect(g.stale).toMatch(/not.*current.*new price/);
      expect(g.stale).toMatch(/Computed when.*built.*cached repeat keeps it.*5 seconds/);
    });
  }

  it('tastytrade\'s clocks, only on tastytrade', async () => {
    expect((await guide(BASE)).tastytrade).toBeUndefined();
    const g = await guide(variant({ provider: 'tastytrade', quote: { tradeTime: null } }));
    expect(g.tastytrade).toMatch(/market-data clock/);
    expect(g.tastytrade).toMatch(/cannot catch a frozen/);
  });

  it('an index has no sizes or volume - null, never 0 - only on an index answer', async () => {
    expect((await guide(BASE)).indexQuote).toBeUndefined();
    expect((await guide(INDEX)).indexQuote).toMatch(/bidSize, askSize and volume are null/);
    expect((await guide(INDEX)).indexQuote).toMatch(/never 0/);
  });

  it('the quote clocks on every answer, never filled from asOf', async () => {
    const g = await guide(BASE);
    expect(g.clocks).toMatch(/quoteTime/);
    expect(g.clocks).toMatch(/tradeTime/);
    expect(g.clocks).toMatch(/never filled from asOf/);
  });

  it('on tastytrade and moomoo the clocks line defers to their own clock, never a bid or ask clock', async () => {
    expect((await guide(BASE)).clocks).toMatch(/last bid or ask update/);
    for (const provider of ['tastytrade', 'moomoo']) {
      const g = await guide(variant({ provider, quote: { tradeTime: null } }));
      expect(g.clocks).not.toMatch(/bid or ask/);
      expect(g.clocks).toMatch(new RegExp(`quoteTime is ${provider}'s own quote clock \\(see ${provider}\\)`));
      expect(g.clocks).toMatch(/never filled from asOf/);
    }
  });

  it('Schwab\'s previous close on every Schwab answer, its index clause on a Schwab index', async () => {
    expect((await guide(BASE)).schwab).toBeUndefined();
    const s = await guide(variant({ provider: 'schwab' }));
    expect(s.schwab).toMatch(/previous regular session's close during the session/);
    expect(s.schwab).not.toMatch(/index quote/);
    expect((await guide({ ...INDEX, provider: 'schwab' })).schwab).toMatch(/index quote there has no bid, ask, mark or quote time/);
  });

  it('Tradier\'s previous close is its prevclose, on Tradier', async () => {
    expect((await guide(BASE)).tradier).toMatch(/prevclose/);
    expect((await guide(variant({ provider: 'public' }))).tradier).toBeUndefined();
  });

  it('Public publishes no open, high or low; Tradier none for an index - only where they are missing', async () => {
    expect((await guide(variant({ provider: 'public' }))).absences).toBeUndefined();
    expect((await guide(variant({ provider: 'public', quote: { open: null, high: null, low: null } }))).absences).toMatch(/Public publishes no open, high or low/);
    expect((await guide(INDEX)).absences).toMatch(/Tradier publishes none for an index/);
    expect((await guide(BASE)).absences).toBeUndefined();
  });

  for (const provider of ['public', 'tradier']) {
    it(`missing session fields get the ${provider} absence explanation`, async () => {
      const body = variant(provider === 'tradier' ? INDEX : { provider });
      delete body.quote.open;
      delete body.quote.high;
      delete body.quote.low;
      expect((await guide(body)).absences).toMatch(/open, high and low|no open, high or low/);
    });
  }

  it('moomoo\'s fields, by provider identity', async () => {
    expect((await guide(BASE)).moomoo).toBeUndefined();
    const g = await guide(variant({ provider: 'moomoo', changeBasis: 'previous-close', quote: { tradeTime: null } }));
    expect(g.moomoo).toMatch(/does not roll/);
    expect(g.moomoo).toMatch(/no tradeTime/);
    expect(g.moomoo).toMatch(/snapshot's update time/);
  });

  it('outside the session, on every answer; the extended-hours last clause left out on moomoo', async () => {
    expect((await guide(BASE)).session).toMatch(/extended-hours trade/);
    expect((await guide(variant({ provider: 'moomoo' }))).session).not.toMatch(/extended-hours trade/);
    expect((await guide(variant({ provider: 'moomoo' }))).session).toMatch(/open, high and low describe the session/);
  });

  it('asOf is the fetch time; a repeat within 5 seconds may be this answer from cache, on every answer', async () => {
    const g = await guide(BASE);
    expect(g.asOf).toMatch(/fetched/);
    expect(g.asOf).toMatch(/not a quote or trade time/);
    expect(g.cache).toMatch(/5 seconds/);
    expect(g.cache).toMatch(/not charged/);
  });

  it('the budget line is present with rateLimit; null says the proxy reported no budget', async () => {
    expect((await guide(BASE)).rateLimit).toMatch(/budget after this call/);
    expect((await guide(BASE, null)).rateLimit).toMatch(/reported no budget/);
  });

  it('the richest answer (a Schwab index, stale, change withheld, budget) stays far inside the wire ceiling', async () => {
    const rich = { ...INDEX, provider: 'schwab', stale: true, change: null, changePercent: null, changeBasis: null, changeReason: 'stale-quote', quote: { ...INDEX.quote, mark: 6500 } };
    const g = await guide(rich);
    expect(Buffer.byteLength(JSON.stringify(g), 'utf8')).toBeLessThan(8 * 1024);
  });
});

describe('quote guide budget', () => {
  it('the full quota facts move into the response and the whole answer fits the wire ceiling', async () => {
    const payload = {
      schemaVersion: 1, symbol: 'SPY', dataSource: 'live', provider: 'tradier', asOf: '2026-10-14T15:02:20.195Z',
      quote: { last: 772.1, bid: 772.07, ask: 772.09, bidSize: 280, askSize: 200, mid: 772.08, mark: null, open: 774.92, high: 776.35, low: 771.78, previousClose: 778.01, volume: 11382168, quoteTime: '2026-10-14T15:02:19.000Z', tradeTime: '2026-10-14T15:02:19.031Z' },
      change: -5.91, changePercent: -0.76, changeBasis: 'broker', changeReason: null, midReason: null, stale: false, staleReason: null, lastSessionOpen: '2026-10-14T09:30:00-04:00',
    };
    const { client, close } = await harness(async () => payload, { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' });
    try {
      const result = await client.callTool({ name: 'get_live_quote', arguments: { symbol: 'SPY' } });
      const wire = result.structuredContent as any;
      expect(JSON.parse((result.content as { type: string; text: string }[])[0].text)).toEqual(wire);
      const g = wire.guide;
      expect(g.rateLimit).toMatch(/budget after this call/);
      expect(g.rateLimit).toMatch(/120 a minute on Tradier and Schwab/);
      expect(g.rateLimit).toMatch(/600 on Public.*10 a second/);
      expect(g.rateLimit).toMatch(/120 on tastytrade.*publishes no figure.*conservative stand-in/);
      expect(g.rateLimit).toMatch(/30 on moomoo.*per moomoo account.*shared.*other moomoo apps/);
      expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(WIRE_CEILING_BYTES);
    } finally {
      await close();
    }
  });
});
