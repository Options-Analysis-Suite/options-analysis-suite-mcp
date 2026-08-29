import { isIP } from 'node:net';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * The client identity that per-source budgets on the unauthenticated OAuth
 * routes are keyed by.
 *
 * Trust posture mirrors the auth server's `getClientIp` and data-api's
 * `clientIp.ts`: `x-real-ip` (what Railway's edge sets) is the primary source.
 * `x-forwarded-for` is honoured ONLY behind TRUST_X_FORWARDED_FOR=true, and
 * then only its LAST entry - the rightmost, append-style hop. The first entry
 * is attacker-prepended in the common ingress topology, so keying a budget on
 * it would hand every client its own fresh bucket per request and grow the
 * budget map without bound.
 *
 * Falls back to the socket peer. Behind Railway that is the edge proxy, so a
 * missing x-real-ip collapses every user into ONE bucket. That is a loud
 * symptom on purpose: a budget that silently switched itself off when its
 * header went missing would give the operator nothing to notice.
 */
const TRUST_X_FORWARDED_FOR = process.env.TRUST_X_FORWARDED_FOR === 'true';

function validIp(value: string | string[] | undefined): string | null {
  const candidate = (Array.isArray(value) ? value[0] : value)?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : null;
}

/** Where the identity came from; anything but a trusted header is a fallback worth surfacing. */
export type RequestSourceOrigin = 'x-real-ip' | 'x-forwarded-for' | 'socket' | 'unknown';

export function resolveRequestSource(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  { trustXff = TRUST_X_FORWARDED_FOR }: { trustXff?: boolean } = {},
): { source: string; from: RequestSourceOrigin } {
  const xRealIp = validIp(headers['x-real-ip']);
  if (xRealIp) return { source: xRealIp, from: 'x-real-ip' };

  if (trustXff) {
    const raw = headers['x-forwarded-for'];
    const joined = Array.isArray(raw) ? raw.join(',') : raw;
    const entries = joined?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? [];
    // Strict last-entry only: a malformed rightmost hop fails closed to the
    // socket rather than falling back to a left-side (client-written) value.
    const last = validIp(entries[entries.length - 1]);
    if (last) return { source: last, from: 'x-forwarded-for' };
  }

  const peer = validIp(socketAddress);
  return peer ? { source: peer, from: 'socket' } : { source: 'unknown', from: 'unknown' };
}

export function requestSource(
  headers: IncomingHttpHeaders,
  socketAddress: string | undefined,
  options: { trustXff?: boolean } = {},
): string {
  return resolveRequestSource(headers, socketAddress, options).source;
}
