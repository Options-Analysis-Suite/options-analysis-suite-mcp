/**
 * Shape the 8-model calibration fit history for a model.
 *
 * The endpoint returns every model's row for each of `days` market dates,
 * each carrying a JSONB params blob. At the 365-day maximum that is nearly
 * three thousand rows, so the raw payload cannot reach a model at all - and
 * the size guard's truncation would hand back an arbitrary prefix of dates,
 * which answers no question anyone asked.
 *
 * The question this data answers is "how well do these models fit this symbol,
 * and are the fits stable". So it is grouped BY MODEL rather than by date: the
 * latest calibrated parameters, the fit error beside them, and a short error
 * history to show drift.
 *
 * `diagnostics` (iterations, runtime_ms, convergence counters) is deliberately
 * dropped. It describes our calibration run, not the market, and a model
 * relaying it to a user is relaying our operational trivia as analysis.
 */

export interface RegimeFitRow {
  market_date?: unknown;
  model_name?: unknown;
  model_version?: unknown;
  params?: unknown;
  fit_error?: unknown;
}

export interface RegimeFitsResponse {
  symbol?: unknown;
  count?: unknown;
  data?: unknown;
}

export interface ShapeRegimeFitsOptions {
  /** Error-history entries kept per model, newest first. */
  historyLimit?: number;
}

const DEFAULT_HISTORY_LIMIT = 10;
const MAX_MODELS = 24;
/**
 * Total history entries across ALL models, so the payload cannot reach the
 * generic response guard.
 *
 * Sixteen model/version entries at a 60-day history overran the budget, and
 * the guard then chose what to drop by size rather than by meaning - it can
 * take whole model entries, and coverage went on reporting sixteen models
 * while five had been removed. Losing a model is far worse than losing its
 * error history: the history is context, the latest parameters are the answer.
 * So the history is shortened HERE, deliberately and visibly, rather than
 * letting a generic rule pick.
 */
const MAX_TOTAL_HISTORY_ENTRIES = 200;

const num = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null =>
  (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null);

interface FitError {
  ivRmse: number | null;
  priceRmse: number | null;
  nOptions: number | null;
  /**
   * TRUE means the fit FAILED A QUALITY CHECK. Three different things set it
   * (calibration-runner.ts:720-727): the calibration did not converge, fewer
   * than three options could be repriced, or the RMSE exceeded the threshold.
   * Only the first substitutes parameters - the other two leave a real fitted
   * parameter set that was then rejected. Either way the fit was not accepted,
   * so a caller must not present those parameters as a good fit for this
   * symbol, and this travels beside them everywhere they go.
   *
   * NOT named `isFallback`. That key is on the shared wire sanitizer's global
   * strip list, so the flag was being removed on the way out while the
   * parameters it qualifies stayed - the worst possible half of the pair to
   * lose. The name is also more accurate than the one it replaced.
   */
  failedQualityCheck: boolean | null;
}

function readFitError(raw: unknown): FitError {
  const fit = obj(raw) ?? {};
  const fallback = fit.is_fallback ?? fit.isFallback;
  return {
    ivRmse: num(fit.iv_rmse ?? fit.ivRmse),
    priceRmse: num(fit.price_rmse ?? fit.priceRmse),
    nOptions: num(fit.n_options ?? fit.nOptions),
    failedQualityCheck: typeof fallback === 'boolean' ? fallback : null,
  };
}

type BuiltModel = {
  model: string | null;
  version: string | null;
  asOf: string | null;
  params: Record<string, unknown> | null;
  fit: FitError;
  fitDays: number;
  daysFailingQualityCheck: number;
  history: Array<{ date: string | null; ivRmse: number | null; failedQualityCheck: boolean | null }>;
};

/**
 * Compare versions by NUMERIC component, so v1.11 outranks v1.9.
 *
 * A lexical compare puts v1.9 above v1.11, which is not a cosmetic ordering
 * problem: the family representative is picked by this, so the newest
 * calibration was being dropped in favour of an older one whenever a family
 * crossed a ten.
 */
function compareVersions(a: string | null, b: string | null): number {
  const parts = (v: string | null): number[] =>
    (v ?? '').split(/[^0-9]+/).filter((part) => part !== '').map(Number);
  const left = parts(a);
  const right = parts(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // Identical numerically: fall back to the raw string so ordering is total.
  return (a ?? '').localeCompare(b ?? '');
}

const byModelThenVersion = (a: BuiltModel, b: BuiltModel): number =>
  (a.model ?? '').localeCompare(b.model ?? '') || compareVersions(a.version, b.version);

/**
 * Fill the cap by MODEL FAMILY first, older versions only with what is left.
 *
 * Slicing a list sorted by name meant four versions of eight models pushed the
 * alphabetically last families off the end entirely. A missing model does not
 * read as "trimmed for space", it reads as "we do not fit this model for this
 * symbol" - a claim that is simply false. One entry per family costs at most
 * eight slots and makes that impossible.
 */
function allocateModelSlots(models: BuiltModel[], cap: number): BuiltModel[] {
  const families = new Map<string, BuiltModel[]>();
  for (const model of models) {
    const key = model.model ?? '?';
    const family = families.get(key);
    if (family) family.push(model); else families.set(key, [model]);
  }

  const primary: BuiltModel[] = [];
  const remainder: BuiltModel[] = [];
  for (const family of families.values()) {
    // The newest fit represents the family; ties break on the higher version,
    // because that is the calibration in service.
    const ranked = [...family].sort((a, b) => byDateDesc({ date: a.asOf }, { date: b.asOf })
      || compareVersions(b.version, a.version));
    primary.push(ranked[0]);
    remainder.push(...ranked.slice(1));
  }
  return [...primary, ...remainder].slice(0, cap).sort(byModelThenVersion);
}

/** Newest first. A row with no usable date sorts last rather than disappearing. */
function byDateDesc(a: { date: string | null }, b: { date: string | null }): number {
  if (a.date === b.date) return 0;
  if (a.date === null) return 1;
  if (b.date === null) return -1;
  return a.date < b.date ? 1 : -1;
}

export function summarizeRegimeFits(
  response: RegimeFitsResponse,
  options: ShapeRegimeFitsOptions = {},
) {
  const requestedHistory = Math.max(1, Math.trunc(options.historyLimit ?? DEFAULT_HISTORY_LIMIT));
  const rows = Array.isArray(response?.data) ? response.data as RegimeFitRow[] : [];

  // Keyed by name AND version: the table's own uniqueness is
  // (market_date, symbol, model_name, model_version), so two versions of one
  // model are two different calibrations whose params are not interchangeable.
  const groups = new Map<string, {
    model: string | null;
    version: string | null;
    entries: Array<{ date: string | null; params: Record<string, unknown> | null; fit: FitError }>;
  }>();

  const dates = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const model = str(row.model_name);
    const version = str(row.model_version);
    const date = str(row.market_date);
    if (date) dates.add(date);
    const key = `${model ?? '?'} ${version ?? '?'}`;
    let group = groups.get(key);
    if (!group) { group = { model, version, entries: [] }; groups.set(key, group); }
    group.entries.push({ date, params: obj(row.params), fit: readFitError(row.fit_error) });
  }

  // Decided after grouping, because the share each model gets depends on how
  // many models there are.
  const historyLimit = Math.max(
    1,
    Math.min(requestedHistory, Math.floor(MAX_TOTAL_HISTORY_ENTRIES / Math.max(1, groups.size))),
  );

  const built = [...groups.values()]
    .map((group) => {
      const entries = [...group.entries].sort(byDateDesc);
      const latest = entries[0];
      return {
        model: group.model,
        version: group.version,
        asOf: latest?.date ?? null,
        // The parameters of the LATEST fit only. An older set is not a worse
        // answer to "what are the parameters", it is a wrong one.
        params: latest?.params ?? null,
        fit: latest?.fit ?? readFitError(null),
        fitDays: entries.length,
        daysFailingQualityCheck: entries.filter((e) => e.fit.failedQualityCheck === true).length,
        history: entries.slice(0, historyLimit)
          .map((e) => ({ date: e.date, ivRmse: e.fit.ivRmse, failedQualityCheck: e.fit.failedQualityCheck })),
      };
    })
    .sort(byModelThenVersion);

  const models = allocateModelSlots(built, MAX_MODELS);
  const sortedDates = [...dates].sort();
  return {
    symbol: str(response?.symbol),
    asOf: sortedDates.at(-1) ?? null,
    windowStart: sortedDates[0] ?? null,
    models,
    coverage: {
      rows: rows.length,
      dates: sortedDates.length,
      models: built.length,
      modelsReturned: models.length,
      // A LIMIT, named as one. Reporting 60 beside a single fit read as sixty
      // days of history the caller never received.
      historyLimitPerModel: historyLimit,
      historyReturnedMax: models.reduce((most, model) => Math.max(most, model.history.length), 0),
      // Stated when it differs, so a caller that asked for sixty days and got
      // twelve is not left believing twelve is all there was.
      ...(historyLimit < requestedHistory ? { historyRequested: requestedHistory } : {}),
    },
  };
}
