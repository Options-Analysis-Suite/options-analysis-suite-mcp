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

/**
 * The rate for a requested maturity (view="benchmark" with tenorYears), labelled as what it is. The route answers the
 * Treasury series matched to the maturity, or - when that series could not be read - the 3-month series with a warning
 * saying so; a warning on the answer is that fallback, labelled as one and kept. Never labelled the 10Y benchmark, even
 * when a long maturity's match is the 10-year series itself.
 */
export function annotateMatchedRiskFreeRate(payload: unknown, tenorYears: number): unknown {
  if (payload == null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const response = payload as RiskFreeRatePayload;
  const fellBack = Array.isArray(response.warnings) && response.warnings.length > 0;
  return {
    ...response,
    _rate_meta: {
      source: fellBack
        ? 'Fallback: the series matched to the requested maturity could not be read (see warnings)'
        : 'Treasury rate matched to the requested maturity',
      matched: !fellBack,
      requestedTenorYears: tenorYears,
      maturity: typeof response.maturity === 'string' ? response.maturity : null,
    },
  };
}

/** A maturity as the route reads it: a plain decimal (it refuses exponent notation such as 1e-7) */
export function tenorYearsParam(tenorYears: number): string {
  const fixed = tenorYears.toFixed(10).replace(/0+$/, '');
  return fixed.endsWith('.') ? fixed.slice(0, -1) : fixed;
}
