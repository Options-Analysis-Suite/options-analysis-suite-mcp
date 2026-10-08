type FilingRow = {
  formType?: string | null;
  description?: string | null;
  filingDate?: string | null;
  accessionNumber?: string | null;
  primaryDocument?: string | null;
  url?: string | null;
  secUrl?: string | null;
  [key: string]: unknown;
};

type SecFilingsResponse = {
  symbol?: string;
  companyName?: string | null;
  cik?: string | null;
  filings?: FilingRow[];
  error?: string;
  message?: string;
  source?: string | null;
  [key: string]: unknown;
};

const DEFAULT_RECENT_CAP = 10;

function normalizeFormType(formType: string | null | undefined): string {
  return typeof formType === 'string' ? formType.trim().toUpperCase() : '';
}

function categorizeForm(formType: string): string {
  if (formType.startsWith('10-K')) return 'annualReport';
  if (formType.startsWith('10-Q')) return 'quarterlyReport';
  if (formType === '8-K') return 'currentReport';
  if (formType.startsWith('DEF 14A')) return 'proxyStatement';
  if (formType === '4') return 'insiderTrading';
  if (formType.startsWith('13D') || formType.startsWith('13G')) return 'beneficialOwnership';
  if (formType.startsWith('S-1') || formType.startsWith('S-3') || formType.startsWith('424B')) return 'offeringOrRegistration';
  return 'other';
}

function categoryLabel(category: string): string {
  switch (category) {
    case 'annualReport':
      return 'Annual report';
    case 'quarterlyReport':
      return 'Quarterly report';
    case 'currentReport':
      return 'Current report';
    case 'proxyStatement':
      return 'Proxy statement';
    case 'insiderTrading':
      return 'Insider trading';
    case 'beneficialOwnership':
      return 'Beneficial ownership';
    case 'offeringOrRegistration':
      return 'Offering or registration';
    default:
      return 'Other';
  }
}

function trimFiling(filing: FilingRow): Record<string, unknown> {
  return {
    formType: filing.formType ?? null,
    description: filing.description ?? filing.formType ?? null,
    filingDate: filing.filingDate ?? null,
    accessionNumber: filing.accessionNumber ?? null,
    primaryDocument: filing.primaryDocument ?? null,
    url: filing.url ?? filing.secUrl ?? null,
  };
}

export function shapeSecFilingsResponse(
  payload: SecFilingsResponse,
  recentCap = DEFAULT_RECENT_CAP,
): Record<string, unknown> {
  const filings = Array.isArray(payload.filings) ? payload.filings : [];
  const trimmedFilings = filings.map(trimFiling);
  const recentFilings = trimmedFilings.slice(0, recentCap);
  const formCounts: Record<string, number> = {};
  const filingCategories: Record<string, number> = {};
  const latestByFilingCategory: Record<string, Record<string, unknown>> = {};

  for (let i = 0; i < filings.length; i += 1) {
    const filing = filings[i];
    const formType = normalizeFormType(filing.formType);
    const category = categorizeForm(formType);

    if (formType) {
      formCounts[formType] = (formCounts[formType] ?? 0) + 1;
    }
    const label = categoryLabel(category);
    filingCategories[label] = (filingCategories[label] ?? 0) + 1;

    if (!(label in latestByFilingCategory)) {
      latestByFilingCategory[label] = trimFiling(filing);
    }
  }

  return {
    symbol: payload.symbol ?? null,
    companyName: payload.companyName ?? null,
    cik: payload.cik ?? null,
    summary: {
      totalFilings: filings.length,
      latestFilingDate: trimmedFilings[0]?.filingDate ?? null,
      latestFormType: trimmedFilings[0]?.formType ?? null,
      formCounts,
      filingCategories,
      source: payload.source ?? 'sec.gov',
    },
    latestByFilingCategory,
    recentFilings,
    ...(payload.error ? { error: payload.error } : {}),
    ...(payload.message ? { message: payload.message } : {}),
    ...(filings.length > recentCap
      ? { _recent_filings_meta: { showing: recentFilings.length, total: filings.length, truncated: true } }
      : {}),
    ...(filings.length === 0
      ? { _filings_note: payload.message ?? 'No recent SEC filings matched the requested symbol and filters.' }
      : {}),
  };
}

// ── merger and offering flags (/sec-corporate-filings, /market/mna-filings) ──

type FlagParty = { cik?: number | null; name?: string | null; tickers?: string[] | null };
type FlagRow = {
  label?: string | null;
  form?: string | null;
  dateFiled?: string | null;
  accession?: string | null;
  url?: string | null;
  counterparties?: FlagParty[] | null;
  expiresOn?: string | null;
};
type CorporateFilingsResponse = {
  asOf?: string | null;
  flags?: { merger?: FlagRow | null; offering?: FlagRow | null } | null;
};
type MnaFilingsResponse = {
  days?: number;
  asOf?: string | null;
  total?: number;
  deals?: Array<{ label?: string | null; form?: string | null; dateFiled?: string | null; accession?: string | null; url?: string | null; parties?: FlagParty[] | null }>;
};

const DEAL_FLAG_WINDOWS =
  'merger: the newest merger, tender offer or going-private filing within 120 days; ' +
  'offering: the newest shelf registration or securities offering within 30 days (a shelf or prospectus may register debt as well as stock; the filing says which)';

function shapeParty(p: FlagParty): Record<string, unknown> {
  return { name: p.name ?? null, tickers: Array.isArray(p.tickers) ? p.tickers : [], cik: p.cik ?? null };
}

function shapeFlag(flag: FlagRow | null | undefined): Record<string, unknown> | null {
  if (!flag) return null;
  return {
    label: flag.label ?? null,
    formType: flag.form ?? null,
    filingDate: flag.dateFiled ?? null,
    accessionNumber: flag.accession ?? null,
    url: flag.url ?? null,
    counterparties: (Array.isArray(flag.counterparties) ? flag.counterparties : []).map(shapeParty),
    flagUntil: flag.expiresOn ?? null,
  };
}

/**
 * The flags a company's filings raise. `payload` null means the platform holds
 * no SEC company filer for the symbol (a fund or an ETF has none); `failed`
 * means the flags could not be read this time. Neither fails the filing list.
 */
export function shapeDealFlags(payload: CorporateFilingsResponse | null, failed = false): Record<string, unknown> {
  if (failed) return { dealFlags: null, dealFlagsNote: 'Merger and offering flags were unavailable for this request; the filing list below is unaffected.' };
  if (!payload) return { dealFlags: null, dealFlagsNote: 'This symbol is not in the company filer map the flags are read from (funds and ETFs are left out of it, even those that file with the SEC), so it carries no merger or offering flags.' };
  return {
    dealFlags: {
      merger: shapeFlag(payload.flags?.merger),
      offering: shapeFlag(payload.flags?.offering),
      windows: DEAL_FLAG_WINDOWS,
      indexThrough: payload.asOf ?? null,
    },
  };
}

/** scope market: merger, tender and going-private filings naming a US-listed company, newest first, at most `limit`. */
export function shapeMnaFilings(payload: MnaFilingsResponse | null, limit: number): Record<string, unknown> {
  const deals = Array.isArray(payload?.deals) ? payload!.deals! : [];
  const shown = deals.slice(0, limit).map(d => ({
    label: d.label ?? null,
    formType: d.form ?? null,
    filingDate: d.dateFiled ?? null,
    accessionNumber: d.accession ?? null,
    url: d.url ?? null,
    parties: (Array.isArray(d.parties) ? d.parties : []).map(shapeParty),
  }));
  const total = typeof payload?.total === 'number' ? payload.total : deals.length;
  return {
    scope: 'market',
    days: payload?.days ?? null,
    indexThrough: payload?.asOf ?? null,
    totalFilings: total,
    filings: shown,
    ...(total > shown.length ? { filingsMeta: { showing: shown.length, total, truncated: true } } : {}),
    ...(shown.length === 0 ? { filingsNote: 'No merger, tender offer or going-private filings naming a covered company in this window.' } : {}),
  };
}
