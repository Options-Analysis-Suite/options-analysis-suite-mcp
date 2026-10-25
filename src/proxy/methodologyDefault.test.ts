import { describe, expect, test } from 'bun:test';
import { DEFAULT_METHODOLOGY_PATH, DefaultMethodologyReader, defaultMethodologyReaderFor } from './methodologyDefault.js';

/** A client whose answers are queued per call; each call records its path */
function queuedClient(answers: Array<() => Promise<unknown>>) {
  const paths: string[] = [];
  return {
    paths,
    get: (path: string) => {
      paths.push(path);
      const next = answers.shift();
      if (!next) throw new Error('no answer queued');
      return next();
    },
  };
}

const answer = (value: unknown, stale = false) => () => Promise.resolve({ defaultMethodology: value, stale });
const refuse = (message: string) => () => Promise.reject(new Error(message));

describe('the default methodology reader', () => {
  test('a good read is served for the TTL, then read again', async () => {
    let now = 1_000;
    const reader = new DefaultMethodologyReader({ ttlMs: 60_000, now: () => now });
    const client = queuedClient([answer(1), answer(2)]);
    expect(await reader.read(client)).toEqual({ known: true, methodology: 1, stale: false });
    now += 59_999;
    expect(await reader.read(client)).toEqual({ known: true, methodology: 1, stale: false });
    expect(client.paths).toEqual([DEFAULT_METHODOLOGY_PATH]);
    now += 1;
    expect(await reader.read(client)).toEqual({ known: true, methodology: 2, stale: false });
    expect(client.paths).toHaveLength(2);
  });

  test('the proxy\'s own stale flag is carried', async () => {
    const reader = new DefaultMethodologyReader();
    expect(await reader.read(queuedClient([answer(2, true)]))).toEqual({ known: true, methodology: 2, stale: true });
  });

  test('a failed re-read serves the last good value marked stale, and a later good read clears it', async () => {
    let now = 0;
    const reader = new DefaultMethodologyReader({ ttlMs: 10, now: () => now });
    const client = queuedClient([answer(2), refuse('Proxy unavailable'), answer(2)]);
    expect(await reader.read(client)).toEqual({ known: true, methodology: 2, stale: false });
    now = 10;
    expect(await reader.read(client)).toEqual({ known: true, methodology: 2, stale: true });
    // a failure is not cached: the next call reads again
    expect(await reader.read(client)).toEqual({ known: true, methodology: 2, stale: false });
    expect(client.paths).toHaveLength(3);
  });

  test('before any good read the default is unknown, never a guessed 1', async () => {
    for (const failing of [
      refuse('HTTP 503'),
      answer(3),
      answer(null),
      answer('1'),
      () => Promise.resolve(null),
      () => Promise.resolve('not json'),
    ]) {
      const reader = new DefaultMethodologyReader();
      expect(await reader.read(queuedClient([failing]))).toEqual({ known: false });
    }
  });

  test('a client that throws before returning a promise fails the read, never rejects it', async () => {
    const reader = new DefaultMethodologyReader();
    const client = { get: () => { throw new Error('synchronous'); } };
    expect(await reader.read(client)).toEqual({ known: false });
  });

  test('concurrent calls share one in-flight read', async () => {
    let release!: (value: unknown) => void;
    const reader = new DefaultMethodologyReader();
    const client = queuedClient([() => new Promise((resolve) => { release = resolve; })]);
    const reads = [reader.read(client), reader.read(client), reader.read(client)];
    // the read starts on a later microtask
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    release({ defaultMethodology: 1, stale: false });
    expect(await Promise.all(reads)).toEqual(Array(3).fill({ known: true, methodology: 1, stale: false }));
    expect(client.paths).toHaveLength(1);
  });

  test('a read that times out frees the slot, the next call reads afresh, and the late answer is discarded', async () => {
    let releaseHung!: (value: unknown) => void;
    const reader = new DefaultMethodologyReader({ timeoutMs: 20 });
    const client = queuedClient([
      () => new Promise((resolve) => { releaseHung = resolve; }),
      answer(1),
    ]);
    const started = Date.now();
    expect(await reader.read(client)).toEqual({ known: false });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await reader.read(client)).toEqual({ known: true, methodology: 1, stale: false });
    expect(client.paths).toHaveLength(2);
    // the hung read answers late with another value: it never replaces the fresh one
    releaseHung({ defaultMethodology: 2, stale: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await reader.read(client)).toEqual({ known: true, methodology: 1, stale: false });
    expect(client.paths).toHaveLength(2);
  });

  test('one reader per proxy URL; a client naming none gets its own', () => {
    const a = { proxyUrl: 'https://proxy.example.test', get: async () => ({}) };
    const b = { proxyUrl: 'https://proxy.example.test', get: async () => ({}) };
    const c = { proxyUrl: 'https://other.example.test', get: async () => ({}) };
    expect(defaultMethodologyReaderFor(a)).toBe(defaultMethodologyReaderFor(b));
    expect(defaultMethodologyReaderFor(a)).not.toBe(defaultMethodologyReaderFor(c));
    const fakeOne = { get: async () => ({}) };
    const fakeTwo = { get: async () => ({}) };
    expect(defaultMethodologyReaderFor(fakeOne)).toBe(defaultMethodologyReaderFor(fakeOne));
    expect(defaultMethodologyReaderFor(fakeOne)).not.toBe(defaultMethodologyReaderFor(fakeTwo));
  });
});
