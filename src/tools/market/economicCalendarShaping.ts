type EconomicEvent = {
  [key: string]: unknown;
  date?: string;
  event?: string;
  impact?: string;
  country?: string;
  currency?: string;
  estimate?: unknown;
  actual?: unknown;
  previous?: unknown;
  change?: unknown;
};

type EconomicCalendarPayload = {
  [key: string]: unknown;
  events?: unknown;
};

type ScoredEvent = {
  event: EconomicEvent;
  impact: 'High' | 'Medium' | 'Low' | 'Unknown';
  score: number;
  timestamp: number;
};

type MacroTheme =
  | 'rates'
  | 'inflation'
  | 'payrolls'
  | 'jobless_claims'
  | 'growth'
  | 'confidence_housing'
  | 'other';

const DEFAULT_EVENT_CAP = 12;
const IMPACT_SCORES: Record<ScoredEvent['impact'], number> = {
  High: 36,
  Medium: 18,
  Low: 4,
  Unknown: 0,
};
const COUNTRY_SCORES: Record<string, number> = {
  US: 18,
  EU: 12,
  EZ: 12,
  UK: 10,
  JP: 10,
  CN: 9,
  CA: 6,
  AU: 6,
};
const CURRENCY_SCORES: Record<string, number> = {
  USD: 12,
  EUR: 8,
  GBP: 7,
  JPY: 7,
  CNY: 6,
  CAD: 4,
  AUD: 4,
};
const KEYWORD_WEIGHTS: Array<[RegExp, number]> = [
  [/\bfomc\b|\bfed(?:eral reserve)?\b.*\b(minutes|statement|decision|rate)\b|\binterest rate decision\b|\bmonetary policy\b|\bcentral bank\b|\becb\b|\bboe\b|\bboj\b/i, 34],
  [/\bcpi\b|\bcore cpi\b|\bpce\b|\bcore pce\b|\binflation\b|\bppi\b|\bproducer price\b|\bconsumer price\b/i, 30],
  [/\bnon[\s-]?farm\b|\bpayrolls\b|\bnfp\b|\bunemployment\b|\bjobless\b|\bemployment\b/i, 28],
  [/\bgdp\b|\bgross domestic product\b|\bretail sales\b|\bism\b|\bpmi\b|\bdurable goods\b|\bindustrial production\b/i, 22],
  [/\bconsumer confidence\b|\bconsumer sentiment\b|\bhousing starts\b|\bnew home sales\b|\bexisting home sales\b/i, 6],
];
const SUBNATIONAL_REGION_HINTS = [
  /\bbaden wuerttemberg\b/i,
  /\bbavaria\b/i,
  /\bberlin\b/i,
  /\bbrandenburg\b/i,
  /\bbremen\b/i,
  /\bhamburg\b/i,
  /\bhesse\b/i,
  /\blower saxony\b/i,
  /\bmecklenburg western pomerania\b/i,
  /\bnorth rhine westphalia\b/i,
  /\brhineland palatinate\b/i,
  /\bsaarland\b/i,
  /\bsaxony(?: anhalt)?\b/i,
  /\bschleswig holstein\b/i,
  /\bthuringia\b/i,
  /\bstate\b/i,
  /\bprovince\b/i,
  /\bregional\b/i,
  /\bprefecture\b/i,
];
const INFLATION_EVENT_PATTERN = /\bcpi\b|\bcore cpi\b|\bppi\b|\binflation\b|\bproducer price\b|\bconsumer price\b/i;
const SUBNATIONAL_EVENT_PENALTY = 55;

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function normalizeImpact(value: unknown): ScoredEvent['impact'] {
  const normalized = normalizeText(value);
  if (normalized.includes('high')) return 'High';
  if (normalized.includes('medium')) return 'Medium';
  if (normalized.includes('low')) return 'Low';
  return 'Unknown';
}

function parseTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function urgencyScore(timestamp: number, nowMs: number): number {
  if (!Number.isFinite(timestamp)) return 0;
  const diffDays = (timestamp - nowMs) / 86400000;
  if (diffDays < -1) return 0;
  if (diffDays <= 1) return 12;
  if (diffDays <= 3) return 10;
  if (diffDays <= 7) return 6;
  if (diffDays <= 14) return 3;
  return 0;
}

function keywordScore(eventName: unknown): number {
  const normalized = normalizeText(eventName);
  for (const [pattern, score] of KEYWORD_WEIGHTS) {
    if (pattern.test(normalized)) return score;
  }
  return 0;
}

function geographyScore(event: EconomicEvent): number {
  const country = typeof event.country === 'string' ? event.country.toUpperCase() : '';
  const currency = typeof event.currency === 'string' ? event.currency.toUpperCase() : '';
  return Math.max(COUNTRY_SCORES[country] ?? 0, CURRENCY_SCORES[currency] ?? 0);
}

function subnationalNoisePenalty(event: EconomicEvent): number {
  const normalizedEvent = normalizeText(event.event);
  if (!normalizedEvent || !INFLATION_EVENT_PATTERN.test(normalizedEvent)) return 0;
  return SUBNATIONAL_REGION_HINTS.some((pattern) => pattern.test(normalizedEvent))
    ? SUBNATIONAL_EVENT_PENALTY
    : 0;
}

function eventCompletenessScore(event: EconomicEvent): number {
  const fields: Array<keyof EconomicEvent> = ['impact', 'country', 'currency', 'estimate', 'actual', 'previous', 'change'];
  return fields.reduce<number>((count, field) => count + (event[field] != null && event[field] !== '' ? 1 : 0), 0);
}

function eventKey(event: EconomicEvent): string {
  return [
    typeof event.date === 'string' ? event.date : '',
    normalizeText(event.event),
    typeof event.country === 'string' ? event.country.toUpperCase() : '',
    typeof event.currency === 'string' ? event.currency.toUpperCase() : '',
  ].join('::');
}

function dedupeEvents(events: EconomicEvent[]): EconomicEvent[] {
  const byKey = new Map<string, EconomicEvent>();

  for (const event of events) {
    const key = eventKey(event);
    const existing = byKey.get(key);
    if (!existing || eventCompletenessScore(event) > eventCompletenessScore(existing)) {
      byKey.set(key, event);
    }
  }

  return Array.from(byKey.values());
}

function trimEvent(event: EconomicEvent): Record<string, unknown> {
  return {
    date: event.date,
    event: event.event,
    impact: normalizeImpact(event.impact),
    country: event.country,
    currency: event.currency,
    estimate: event.estimate,
    actual: event.actual,
    previous: event.previous,
    change: event.change,
  };
}

function rankEvents(events: EconomicEvent[], nowMs: number): ScoredEvent[] {
  return events.map((event) => {
    const impact = normalizeImpact(event.impact);
    const timestamp = parseTimestamp(event.date);
    const score = IMPACT_SCORES[impact]
      + geographyScore(event)
      + keywordScore(event.event)
      + urgencyScore(timestamp, nowMs)
      - subnationalNoisePenalty(event);

    return {
      event,
      impact,
      score,
      timestamp,
    };
  });
}

function pickThreshold(entries: ScoredEvent[], cap: number): number {
  const minimumUsefulCount = Math.min(4, Math.min(cap, entries.length));
  if (minimumUsefulCount === 0) return 0;

  for (const threshold of [50, 35]) {
    if (entries.filter((entry) => entry.score >= threshold).length >= minimumUsefulCount) {
      return threshold;
    }
  }

  return 0;
}

function compareForRanking(left: ScoredEvent, right: ScoredEvent): number {
  if (right.score !== left.score) return right.score - left.score;
  if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return String(left.event.event ?? '').localeCompare(String(right.event.event ?? ''));
}

function compareForDisplay(left: ScoredEvent, right: ScoredEvent): number {
  if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  if (right.score !== left.score) return right.score - left.score;
  return String(left.event.event ?? '').localeCompare(String(right.event.event ?? ''));
}

function macroTheme(event: EconomicEvent): MacroTheme {
  const normalized = normalizeText(event.event);
  if (/\bfomc\b|\bfed(?:eral reserve)?\b|\becb\b|\bboe\b|\bboj\b|\binterest rate decision\b|\bmonetary policy\b|\bcentral bank\b/i.test(normalized)) {
    return 'rates';
  }
  if (/\bcpi\b|\bcore cpi\b|\bpce\b|\bcore pce\b|\binflation\b|\bppi\b|\bproducer price\b|\bconsumer price\b/i.test(normalized)) {
    return 'inflation';
  }
  if (/\bnon[\s-]?farm\b|\bpayrolls\b|\bnfp\b|\bunemployment\b|\bu 6\b|\bu-6\b/i.test(normalized)) {
    return 'payrolls';
  }
  if (/\bjobless claims?\b|\bcontinuing jobless claims\b|\binitial jobless claims\b|\bclaims 4 week average\b|\bclaims\b/i.test(normalized)) {
    return 'jobless_claims';
  }
  if (/\bgdp\b|\bgross domestic product\b|\bretail sales\b|\bism\b|\bpmi\b|\bdurable goods\b|\bindustrial production\b/i.test(normalized)) {
    return 'growth';
  }
  if (/\bconsumer confidence\b|\bconsumer sentiment\b|\bhousing starts\b|\bnew home sales\b|\bexisting home sales\b/i.test(normalized)) {
    return 'confidence_housing';
  }
  return 'other';
}

function eventDayBucket(event: EconomicEvent): string {
  if (typeof event.date === 'string' && event.date.length >= 10) {
    return event.date.slice(0, 10);
  }
  return 'unknown-date';
}

function eventGeographyKey(event: EconomicEvent): string {
  if (typeof event.country === 'string' && event.country.trim()) {
    return event.country.toUpperCase();
  }
  if (typeof event.currency === 'string' && event.currency.trim()) {
    return event.currency.toUpperCase();
  }
  return 'GLOBAL';
}

function eventVariantPriority(event: EconomicEvent): number {
  const normalized = normalizeText(event.event);

  if (macroTheme(event) === 'jobless_claims') {
    if (/\binitial jobless claims\b/.test(normalized)) return 30;
    if (/\bcontinuing jobless claims\b/.test(normalized)) return 20;
    if (/\b4 week average\b/.test(normalized)) return 5;
  }

  if (macroTheme(event) === 'payrolls') {
    if ((/\bnon[\s-]?farm payrolls\b/.test(normalized) && !/\bprivate\b/.test(normalized)) || /\bnfp\b/.test(normalized)) return 35;
    if (/\bu 6\b|\bu-6\b/.test(normalized)) return 10;
    if (/\bunemployment rate\b/.test(normalized)) return 24;
    if (/\bprivate\b/.test(normalized)) return 18;
  }

  if (macroTheme(event) === 'inflation') {
    if (/\bcore pce\b|\bcore cpi\b/.test(normalized)) return 32;
    if (/\bcpi\b|\bconsumer price index\b|\binflation rate\b/.test(normalized) && /\byoy\b/.test(normalized)) return 28;
    if (/\bcpi\b|\bconsumer price index\b|\binflation rate\b/.test(normalized)) return 24;
    if (/\bpce\b/.test(normalized)) return 22;
    if (/\bppi\b|\bproducer price\b/.test(normalized)) return 18;
    if (/\bmom\b/.test(normalized)) return 14;
  }

  return 0;
}

function clusterKey(entry: ScoredEvent): string {
  return [eventDayBucket(entry.event), eventGeographyKey(entry.event), macroTheme(entry.event)].join('::');
}

function clusterCap(entry: ScoredEvent): number {
  switch (macroTheme(entry.event)) {
    case 'payrolls':
      return 2;
    default:
      return 1;
  }
}

function compareForSelection(left: ScoredEvent, right: ScoredEvent): number {
  if (right.score !== left.score) return right.score - left.score;
  const leftPriority = eventVariantPriority(left.event);
  const rightPriority = eventVariantPriority(right.event);
  if (rightPriority !== leftPriority) return rightPriority - leftPriority;
  if (Number.isFinite(left.timestamp) && Number.isFinite(right.timestamp) && left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }
  return String(left.event.event ?? '').localeCompare(String(right.event.event ?? ''));
}

function selectDiversifiedEvents(entries: ScoredEvent[], cap: number): ScoredEvent[] {
  const selected: ScoredEvent[] = [];
  const clusterCounts = new Map<string, number>();
  const minimumTarget = Math.min(Math.max(4, Math.ceil(cap / 2)), cap, entries.length);

  for (const entry of entries.sort(compareForSelection)) {
    const key = clusterKey(entry);
    const count = clusterCounts.get(key) ?? 0;
    if (count >= clusterCap(entry)) continue;
    selected.push(entry);
    clusterCounts.set(key, count + 1);
    if (selected.length >= cap) return selected;
  }

  if (selected.length >= minimumTarget) return selected;

  const selectedKeys = new Set(selected.map((entry) => eventKey(entry.event)));
  for (const entry of entries.sort(compareForSelection)) {
    if (selectedKeys.has(eventKey(entry.event))) continue;
    selected.push(entry);
    selectedKeys.add(eventKey(entry.event));
    if (selected.length >= minimumTarget) break;
  }

  return selected;
}

export function summarizeEconomicCalendar(
  payload: unknown,
  cap = DEFAULT_EVENT_CAP,
  now: Date | string = new Date(),
): unknown {
  const items: EconomicEvent[] = Array.isArray(payload)
    ? payload.filter((event): event is EconomicEvent => event != null && typeof event === 'object')
    : payload && typeof payload === 'object' && Array.isArray((payload as EconomicCalendarPayload).events)
      ? ((payload as EconomicCalendarPayload).events as unknown[]).filter((event): event is EconomicEvent => event != null && typeof event === 'object')
      : [];

  if (items.length === 0) return { events: [] };

  const nowMs = typeof now === 'string' ? parseTimestamp(now) : now.getTime();
  const deduped = dedupeEvents(items);
  const ranked = rankEvents(deduped, Number.isFinite(nowMs) ? nowMs : Date.now());
  const threshold = pickThreshold(ranked, cap);

  let selectedRanked: ScoredEvent[];
  if (threshold > 0) {
    selectedRanked = selectDiversifiedEvents(
      ranked.filter((entry) => entry.score >= threshold),
      cap,
    )
      .sort(compareForDisplay);
  } else {
    selectedRanked = ranked
      .sort(compareForDisplay)
      .slice(0, cap);
  }

  const duplicateCount = items.length - deduped.length;
  const omittedCount = deduped.length - selectedRanked.length;
  const summary = {
    totalEvents: deduped.length,
    selectedEvents: selectedRanked.length,
    highImpactEvents: ranked.filter((entry) => entry.impact === 'High').length,
    mediumImpactEvents: ranked.filter((entry) => entry.impact === 'Medium').length,
  };

  const meta: Record<string, unknown> = {};
  if (threshold > 0) {
    meta.focusedHigherSignal = true;
    meta.selected = selectedRanked.length;
    meta.uniqueAvailable = deduped.length;
    if (duplicateCount > 0) meta.duplicatesRemoved = duplicateCount;
    if (omittedCount > 0) meta.lowerSignalOmitted = omittedCount;
  } else if (deduped.length > selectedRanked.length || duplicateCount > 0) {
    meta.fallbackToUpcoming = true;
    meta.showing = selectedRanked.length;
    meta.uniqueAvailable = deduped.length;
    if (duplicateCount > 0) meta.duplicatesRemoved = duplicateCount;
  }

  return {
    events: selectedRanked.map(({ event }) => trimEvent(event)),
    summary,
    _events_meta: Object.keys(meta).length > 0 ? meta : undefined,
  };
}
