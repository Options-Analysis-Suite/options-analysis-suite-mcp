type MarketRegimeMarket = {
  [key: string]: unknown;
  vector?: unknown;
  drivers?: unknown;
  top_driver?: unknown;
  exposures?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Convert a snake_case backend feature identifier to a human-readable label
 *  (e.g. `tail_dominance` → "Tail Dominance"). LLM clients surface the value
 *  as-is to end users, so the wire representation needs to read like prose. */
export function humanizeFeature(name: string): string {
  return name
    .split('_')
    .map((s) => (s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()))
    .join(' ');
}

/** Rewrite each driver entry's `feature` value (and any `key`-style alias) to
 *  the humanized label. Returns a new array; leaves non-array input untouched. */
export function humanizeDrivers(drivers: unknown): unknown {
  if (!Array.isArray(drivers)) return drivers;
  return drivers.map(humanizeDriverEntry);
}

/** Rewrite the keys of a feature-keyed record (e.g. z-scores, raw values) to
 *  humanized labels. Values are passed through unchanged. */
export function humanizeFeatureRecord(rec: unknown): unknown {
  if (!isRecord(rec)) return rec;
  return Object.fromEntries(Object.entries(rec).map(([k, v]) => [humanizeFeature(k), v]));
}

/** Humanize a single driver-shaped record (a `{ feature, z, ... }` entry).
 *  Used for both array elements (drivers[]) and the singleton top_driver
 *  field returned to public/non-Pro callers on /regime/current. */
function humanizeDriverEntry(entry: unknown): unknown {
  if (!isRecord(entry)) return entry;
  const next: Record<string, unknown> = { ...entry };
  if (typeof next.feature === 'string') next.feature = humanizeFeature(next.feature);
  return next;
}

/** Apply driver/feature humanization to a regime entry in place — covers the
 *  four places snake_case feature names appear: entry.drivers[].feature,
 *  entry.top_driver.feature (public-tier landing field), and
 *  entry.vector.{z,raw,data_quality} key sets. Used by raw-path returns
 *  (include_symbols=true, scope=symbol full=true, scope=intraday) so the wire
 *  output is consistent with the default-shaped response. */
export function humanizeRegimeEntry(entry: unknown): void {
  if (!isRecord(entry)) return;
  if (Array.isArray(entry.drivers)) {
    entry.drivers = humanizeDrivers(entry.drivers);
  }
  if (entry.top_driver != null) {
    entry.top_driver = humanizeDriverEntry(entry.top_driver);
  }
  const vector = isRecord(entry.vector) ? entry.vector : null;
  if (!vector) return;
  for (const subKey of ['z', 'raw', 'data_quality'] as const) {
    if (isRecord(vector[subKey])) {
      vector[subKey] = humanizeFeatureRecord(vector[subKey]);
    }
  }
}

export function shapeMarketRegimeResponse(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.market)) return payload;

  const market = payload.market as MarketRegimeMarket;
  const shaped: Record<string, unknown> = { ...market };
  const vector = isRecord(market.vector) ? market.vector : null;
  const zScores = vector && isRecord(vector.z) ? vector.z : null;

  if (zScores) {
    shaped.feature_z_scores = humanizeFeatureRecord(zScores);
    shaped._feature_vector_meta = { raw_internals_omitted: true };
  }

  if (Array.isArray(market.drivers)) {
    shaped.drivers = humanizeDrivers(market.drivers);
  }

  if (market.top_driver != null) {
    shaped.top_driver = humanizeDriverEntry(market.top_driver);
  }

  delete shaped.vector;

  return { ...payload, market: shaped };
}
