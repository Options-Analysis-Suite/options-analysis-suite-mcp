type CompanyProfileResponse = {
  symbol?: string | null;
  company_name?: string | null;
  sector?: string | null;
  industry?: string | null;
  ceo?: string | null;
  exchange?: string | null;
  exchange_short?: string | null;
  country?: string | null;
  currency?: string | null;
  mkt_cap?: number | null;
  beta?: number | null;
  price_range?: string | null;
  last_div?: number | null;
  vol_avg?: number | null;
  full_time_employees?: number | null;
  ipo_date?: string | null;
  website?: string | null;
  description?: string | null;
  is_etf?: boolean | null;
  is_actively_trading?: boolean | null;
  pe_ratio_ttm?: number | null;
  shares_outstanding?: number | null;
  free_float_pct?: number | null;
  free_float_shares?: number | null;
  cik?: string | null;
  updated_at?: string | null;
  error?: string;
  [key: string]: unknown;
};

const DEFAULT_DESCRIPTION_CAP = 500;

function roundNullable(value: unknown, digits = 2): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function trimDescription(description: string | null | undefined, maxLength: number): { text: string | null; trimmed: boolean } {
  if (typeof description !== 'string' || !description.trim()) {
    return { text: null, trimmed: false };
  }

  if (description.length <= maxLength) {
    return { text: description, trimmed: false };
  }

  return {
    text: `${description.slice(0, maxLength).trimEnd()}...`,
    trimmed: true,
  };
}

export function shapeCompanyProfileResponse(
  payload: CompanyProfileResponse | null,
  descriptionCap = DEFAULT_DESCRIPTION_CAP,
): Record<string, unknown> | null {
  if (!payload) return null;
  const { text: description, trimmed } = trimDescription(payload.description, descriptionCap);
  const sharesOutstanding = typeof payload.shares_outstanding === 'number' ? payload.shares_outstanding : null;
  const freeFloat = typeof payload.free_float_shares === 'number' ? payload.free_float_shares : null;
  const floatPct = typeof payload.free_float_pct === 'number' ? roundNullable(payload.free_float_pct, 1) : null;

  return {
    symbol: payload.symbol ?? null,
    companyName: payload.company_name ?? null,
    sector: payload.sector ?? null,
    industry: payload.industry ?? null,
    exchange: payload.exchange ?? payload.exchange_short ?? null,
    country: payload.country ?? null,
    currency: payload.currency ?? null,
    marketCap: typeof payload.mkt_cap === 'number' ? payload.mkt_cap : null,
    beta: roundNullable(payload.beta),
    peRatioTtm: roundNullable(payload.pe_ratio_ttm),
    sharesOutstanding,
    freeFloat,
    freeFloatPct: floatPct,
    avgVolume: typeof payload.vol_avg === 'number' ? payload.vol_avg : null,
    lastDividend: typeof payload.last_div === 'number' ? payload.last_div : null,
    priceRange: payload.price_range ?? null,
    ipoDate: payload.ipo_date ?? null,
    ceo: payload.ceo ?? null,
    employees: typeof payload.full_time_employees === 'number' ? payload.full_time_employees : null,
    website: payload.website ?? null,
    cik: payload.cik ?? null,
    isEtf: typeof payload.is_etf === 'boolean' ? payload.is_etf : null,
    isActivelyTrading: typeof payload.is_actively_trading === 'boolean' ? payload.is_actively_trading : null,
    description,
    updatedAt: payload.updated_at ?? null,
    ...(trimmed ? { _description_truncated: true } : {}),
    ...(payload.error ? { error: payload.error } : {}),
  };
}
