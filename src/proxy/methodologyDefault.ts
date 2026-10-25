/**
 * The platform's default Greek exposure methodology (Greek exposure methodology v2): read from the proxy's public
 * GET /exposure/methodology, which serves the central setting through the proxy's own 60 s TTL reader and is never
 * cached by intermediaries (Cache-Control: no-store).
 *
 * - One reader per proxy URL: the value is global, so every session of a remote process shares it. A client with no
 *   URL (a test's fake) gets a reader of its own.
 * - 60 s TTL. Concurrent calls share one in-flight read, bounded at 5 s (the data API's bound): a read that times out
 *   frees the slot for the next call, and its late answer is discarded.
 * - After a good read, a failed re-read serves the last value marked stale; the proxy's own stale flag is carried too.
 *   A healthy flip reaches the MCP within about two TTLs in series; a stale value can be served longer, always labeled.
 * - Before any good read the default is unknown, and the caller decides what to answer. Never a guessed 1: after the
 *   cutover a guess would label methodology 1 as the platform default.
 */

export type MethodologyId = 1 | 2;

export const DEFAULT_METHODOLOGY_PATH = '/exposure/methodology';
export const DEFAULT_METHODOLOGY_TTL_MS = 60_000;
export const DEFAULT_METHODOLOGY_READ_TIMEOUT_MS = 5_000;

/** What the reader needs of a client: a GET of the public route (ProxyClient and LiveApiClient both have one) */
export interface DefaultReadClient {
  get(path: string): Promise<unknown>;
}

export type DefaultRead =
  | { known: true; methodology: MethodologyId; stale: boolean }
  | { known: false };

export class DefaultMethodologyReader {
  private last: { methodology: MethodologyId; proxyStale: boolean; at: number } | null = null;
  private inflight: Promise<DefaultRead> | null = null;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: { ttlMs?: number; timeoutMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_METHODOLOGY_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_METHODOLOGY_READ_TIMEOUT_MS;
    this.now = options.now ?? (() => Date.now());
  }

  read(client: DefaultReadClient): Promise<DefaultRead> {
    if (this.last && this.now() - this.last.at < this.ttlMs) {
      return Promise.resolve({ known: true, methodology: this.last.methodology, stale: this.last.proxyStale });
    }
    if (!this.inflight) {
      const read = this.fetchOnce(client);
      this.inflight = read;
      // the slot is freed when its own read settles (a timeout settles it), never by a later read's
      void read.finally(() => { if (this.inflight === read) this.inflight = null; });
    }
    return this.inflight;
  }

  private async fetchOnce(client: DefaultReadClient): Promise<DefaultRead> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<{ timedOut: true }>((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), this.timeoutMs); });
    let failure: string;
    try {
      const outcome = await Promise.race([
        // a client that throws before returning a promise fails the read like one that rejects
        Promise.resolve().then(() => client.get(DEFAULT_METHODOLOGY_PATH)).then((body) => ({ body }), (error: unknown) => ({ error })),
        timedOut,
      ]);
      if ('timedOut' in outcome) failure = `no answer within ${this.timeoutMs} ms`;
      else if ('error' in outcome) failure = String((outcome.error as { message?: unknown })?.message ?? outcome.error);
      else {
        const body = outcome.body as { defaultMethodology?: unknown; stale?: unknown } | null;
        const value = body && typeof body === 'object' ? body.defaultMethodology : undefined;
        if (value === 1 || value === 2) {
          this.last = { methodology: value, proxyStale: body?.stale === true, at: this.now() };
          return { known: true, methodology: value, stale: this.last.proxyStale };
        }
        failure = `the answer carried ${JSON.stringify(value) ?? 'no value'}, not 1 or 2`;
      }
    } finally {
      clearTimeout(timer);
    }
    console.error('[OAS MCP] default exposure methodology read failed:', failure);
    if (this.last) return { known: true, methodology: this.last.methodology, stale: true };
    return { known: false };
  }
}

const readersByUrl = new Map<string, DefaultMethodologyReader>();
const readersByClient = new WeakMap<object, DefaultMethodologyReader>();

/** The reader for this client's proxy: shared per proxy URL, or the client's own when it names none */
export function defaultMethodologyReaderFor(client: object): DefaultMethodologyReader {
  const url = (client as { proxyUrl?: unknown }).proxyUrl;
  if (typeof url === 'string' && url !== '') {
    let reader = readersByUrl.get(url);
    if (!reader) readersByUrl.set(url, reader = new DefaultMethodologyReader());
    return reader;
  }
  let reader = readersByClient.get(client);
  if (!reader) readersByClient.set(client, reader = new DefaultMethodologyReader());
  return reader;
}
