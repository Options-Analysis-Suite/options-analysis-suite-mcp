type RiskFreeRatePayload = {
  [key: string]: unknown;
  rate?: unknown;
  value?: unknown;
  maturity?: unknown;
  source?: unknown;
  provider?: unknown;
  timestamp?: unknown;
};

function normalizeBenchmarkSource(source: unknown): unknown {
  if (typeof source !== 'string') return source;
  if (!/supabase/i.test(source)) return source;
  if (/fred/i.test(source)) return 'FRED (Federal Reserve Economic Data)';
  return 'Platform benchmark';
}

export function annotateRiskFreeRate(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const response = payload as RiskFreeRatePayload;
  if (response.maturity !== '10Y') return response;

  return {
    ...response,
    source: normalizeBenchmarkSource(response.source),
    _rate_meta: { source: 'platform 10Y benchmark', maturity: '10Y' },
  };
}
