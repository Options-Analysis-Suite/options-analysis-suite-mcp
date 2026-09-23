/**
 * Several proxy history routes return `{ ...provenance, metadata: provenance,
 * provenance }`: the same block three times, paid for on every answer. One
 * copy stays, under `provenance`. A top-level key or a `metadata` block is
 * dropped ONLY where it repeats the provenance copy exactly; a value the
 * proxy sets differently at the top level is not a twin and is kept. With no
 * `provenance` object nothing is touched.
 */
export function collapseProvenance<T>(response: T): T {
  if (response == null || typeof response !== 'object' || Array.isArray(response)) return response;
  const record = response as Record<string, unknown>;
  const provenance = record.provenance;
  if (provenance == null || typeof provenance !== 'object' || Array.isArray(provenance)) return response;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(record)) {
    if (field === 'metadata' && same(value, provenance)) continue;
    if (field !== 'provenance' && field in (provenance as object) && same(value, (provenance as Record<string, unknown>)[field])) continue;
    out[field] = value;
  }
  return out as T;
}
