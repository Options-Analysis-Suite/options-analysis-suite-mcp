type ActivistFiling = {
  formType?: string | null;
  filerName?: string | null;
  filingDate?: string | null;
  sharesOwned?: number | null;
  percentOwnership?: number | null;
  ruleBasis?: string | null;
  ownershipStatus?: string | null;
  purpose?: string | null;
  description?: string | null;
  url?: string | null;
  accessionNumber?: string | null;
  [key: string]: unknown;
};

type ActivistFilingsResponse = {
  symbol?: string;
  companyName?: string;
  filings?: ActivistFiling[];
  activistCount?: number;
  note?: string;
  [key: string]: unknown;
};

const MAX_CURRENT_HOLDERS = 10;
const MAX_RECENT_BELOW_THRESHOLD = 5;
const MAX_KEY_HOLDERS = 5;

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseDate(value: unknown): number {
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function filingRecencyCompare(left: ActivistFiling, right: ActivistFiling): number {
  return parseDate(right.filingDate) - parseDate(left.filingDate);
}

function filingPriorityScore(filing: ActivistFiling): number {
  const ownershipStatus = String(filing.ownershipStatus ?? '');
  const purpose = String(filing.purpose ?? '');
  let score = 0;

  if (ownershipStatus === 'above_threshold') score += 1000;
  if (purpose === 'board') score += 400;
  else if (purpose === 'ownership') score += 250;
  else if (purpose === 'institutional') score += 180;
  else if (purpose === 'investment') score += 120;

  const pct = toNumber(filing.percentOwnership);
  if (pct != null) score += Math.min(pct * 10, 300);
  if (String(filing.formType ?? '').includes('13D')) score += 80;

  return score;
}

function humanizeOwnershipStatus(status: unknown): string | null {
  if (typeof status !== 'string' || !status) return null;
  if (status === 'above_threshold') return 'above threshold';
  if (status === 'below_threshold') return 'below threshold';
  return status;
}

function humanizePurpose(purpose: unknown): string | null {
  if (typeof purpose !== 'string' || !purpose) return null;
  if (purpose === 'above_threshold') return 'above threshold';
  if (purpose === 'below_threshold') return 'below threshold';
  return purpose;
}

function trimFiling(filing: ActivistFiling): Record<string, unknown> {
  return {
    formType: filing.formType ?? null,
    filerName: filing.filerName ?? null,
    filingDate: filing.filingDate ?? null,
    sharesOwned: toNumber(filing.sharesOwned),
    percentOwnership: toNumber(filing.percentOwnership),
    ruleBasis: filing.ruleBasis ?? null,
    ownershipStatus: humanizeOwnershipStatus(filing.ownershipStatus),
    purpose: humanizePurpose(filing.purpose),
    description: filing.description ?? null,
    url: filing.url ?? null,
    accessionNumber: filing.accessionNumber ?? null,
  };
}

export function shapeActivistFilingsResponse(payload: ActivistFilingsResponse): Record<string, unknown> {
  const filings = Array.isArray(payload.filings)
    ? payload.filings.slice().sort(filingRecencyCompare)
    : [];

  const aboveThreshold = filings.filter((filing) => filing.ownershipStatus === 'above_threshold');
  const belowThreshold = filings.filter((filing) => filing.ownershipStatus === 'below_threshold');

  const latestByFiler = new Map<string, ActivistFiling>();
  for (const filing of filings) {
    const filerKey = typeof filing.filerName === 'string' ? filing.filerName.trim() : '';
    if (!filerKey || latestByFiler.has(filerKey)) continue;
    latestByFiler.set(filerKey, filing);
  }

  const currentHolderSnapshot = Array.from(latestByFiler.values())
    .filter((filing) => filing.ownershipStatus === 'above_threshold')
    .sort((left, right) => filingPriorityScore(right) - filingPriorityScore(left) || filingRecencyCompare(left, right))
    .slice(0, MAX_CURRENT_HOLDERS)
    .map(trimFiling);

  const keyHolderHighlights = currentHolderSnapshot
    .slice(0, MAX_KEY_HOLDERS);

  const recentBelowThreshold = belowThreshold
    .slice(0, MAX_RECENT_BELOW_THRESHOLD)
    .map(trimFiling);

  return {
    symbol: payload.symbol ?? null,
    companyName: payload.companyName ?? null,
    summary: {
      uniqueFilers: typeof payload.activistCount === 'number' ? payload.activistCount : latestByFiler.size,
      totalFilings: filings.length,
      currentAboveThresholdFilers: currentHolderSnapshot.length,
      recentBelowThresholdFilings: belowThreshold.length,
    },
    keyHolderHighlights,
    currentHolderSnapshot,
    recentBelowThreshold,
    ...(currentHolderSnapshot.length > 0
      ? { _snapshotMeta: { currentHolderSnapshots: currentHolderSnapshot.length, totalFilings: filings.length, prioritizedLatestPerFiler: true } }
      : { _snapshotStatus: 'No current above-threshold holders' }),
    ...(recentBelowThreshold.length > 0
      ? { _belowThresholdMeta: { summarizedSeparately: true } }
      : {}),
  };
}
