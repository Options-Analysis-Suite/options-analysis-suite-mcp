import { displayNameModelMap, modelDisplayName, modelDisplayNames } from '../modelLabels.js';
import { jsonUtf8ByteLength } from '../helpers.js';

type RawComputeRunRecord = {
  [key: string]: unknown;
  run_key?: unknown;
  scope?: unknown;
  quality?: unknown;
  status?: unknown;
  timestamp?: unknown;
  data?: unknown;
  positions?: unknown;
};

type ComputeRunFilters = {
  runKey?: string;
  status?: string;
  scope?: string;
  quality?: string;
  underlying?: string;
};

const MAX_DEFAULT_POSITIONS = 5;
const MAX_MULTI_RUN_POSITIONS = 2;
const MAX_DEFAULT_ERRORS = 5;
const MAX_ERROR_MESSAGE_CHARS = 1_000;
const MAX_ERROR_MODEL_CHARS = 128;
const MAX_ERROR_CODE_CHARS = 128;
const MAX_ERROR_UNDERLYING_CHARS = 64;
const MAX_ERROR_EXPIRATION_CHARS = 64;
const COMPUTE_SYNC_ERROR_LIMIT = 100;
const CURRENT_COMPUTE_ERROR_TEXT_MAX_LENGTH = 2_000;
const CURRENT_COMPUTE_CALIBRATION_WARNING_LIMIT = 10;
const CURRENT_COMPUTE_CALIBRATION_WARNING_MAX_LENGTH = 500;
const CURRENT_COMPUTE_EXPIRATION_MAX_LENGTH = 100;
const CURRENT_COMPUTE_EXECUTION_PATH_MAX_LENGTH = 200;
const MAX_ASSISTANT_EXCLUSIONS = 20;
const MAX_ASSISTANT_EXCLUSION_IDENTIFIER_CHARS = 128;
const MAX_ASSISTANT_EXCLUSION_REASON_CHARS = 500;
const MAX_MULTI_RUN_MODELS = 3;
const MAX_SINGLE_RUN_FALLBACK_POSITIONS = 3;
const MAX_SINGLE_RUN_FALLBACK_MODELS = 5;
const MAX_SINGLE_RUN_EMERGENCY_POSITIONS = 1;
const MAX_SINGLE_RUN_EMERGENCY_MODELS = 3;
const BUDGET_DISPERSION_KEYS = new Set(['Price', 'Delta', 'Gamma', 'Theta', 'Vega', 'Rho', 'Vanna', 'Charm', 'Vomma', 'Veta']);
const FALLBACK_STATUS = 'fallback (default parameters)';
const MODEL_SPECIFIC_CONFIDENCE_LABEL = 'model-specific calibration quality score';
const WITHIN_FAMILY_CONFIDENCE_LABEL = 'within-family model-selection score';
const CALIBRATION_CONFIDENCE_SCALE = '0-100 points';
export const CURRENT_COMPUTE_ENGINE_VERSION = '2.0.5';
const CURRENT_COMPUTE_INPUT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_COMPUTE_STATUSES = new Set(['completed', 'cancelled', 'failed']);
const CORE_COMPUTE_MODEL_IDS = new Set([
  'BlackScholes',
  'Heston',
  'JumpDiffusion',
  'SABR',
  'VarianceGamma',
]);
const FULL_COMPUTE_MODEL_IDS = new Set([
  ...CORE_COMPUTE_MODEL_IDS,
  'Binomial',
  'PDE',
  'MonteCarlo-GBM',
  'MonteCarlo-JumpDiffusion',
  'MonteCarlo-MeanReverting',
  'MonteCarlo-Heston',
  'FFT',
  'LocalVol-Dupire',
  'LocalVol-CEV',
]);
const CALIBRATION_CARRYING_MODEL_IDS = new Set([
  'Heston',
  'SABR',
  'JumpDiffusion',
  'VarianceGamma',
  'MonteCarlo-Heston',
  'MonteCarlo-JumpDiffusion',
]);
const CURRENT_COMPUTE_COMPACTION_LEVELS = new Set([
  'none',
  'variants',
  'variants+exposure',
  'models-core',
  'positions',
  'summary-only',
]);
const CURRENT_COMPUTE_GREEK_NAMES = new Set([
  'Delta', 'Vega', 'Theta', 'Rho', 'Gamma', 'Vanna', 'Charm', 'Vomma', 'Veta',
  'Speed', 'Ultima', 'DcharmDvol', 'Zomma', 'Color', 'Lambda', 'Epsilon', 'Phi',
  'VegaAlpha', 'Volga', 'Epsilon2', 'RhoR', 'RhoQ', 'KappaDer', 'ThetaParamDer',
  'VolOfVolDer', 'RhoDer',
]);
const CURRENT_COMPUTE_AGGREGATE_METRICS = new Set([
  'Price',
  ...CURRENT_COMPUTE_GREEK_NAMES,
]);
const CURRENT_EXPOSURE_STRIKE_FIELDS = [
  'strike',
  'callGamma', 'putGamma', 'gamma',
  'callDelta', 'putDelta', 'delta',
  'callVega', 'putVega', 'vega',
  'callVanna', 'putVanna', 'vanna',
  'callCharm', 'putCharm', 'charm',
  'callVomma', 'putVomma', 'vomma',
] as const;
const COMPUTE_PROVENANCE_KINDS = new Set([
  'market',
  'model',
  'calibration',
  'interpolated',
  'assumption',
  'not_applicable',
]);
const CALIBRATION_CONFIDENCE_METHODS = new Set([
  'heston-quality-v1',
  'sabr-quality-v1',
  'unified-jump-selection-v1',
  'variance-gamma-quality-v1',
]);
const AGGREGATE_EXCLUSION_REASON_LABELS: Record<string, string> = {
  incomplete_position_coverage: 'incomplete position coverage',
  invalid_value: 'non-finite aggregate value',
  unsafe_net_value: 'unstable net portfolio value',
  duplicate_source: 'duplicate source',
};
const KNOWN_ASSISTANT_MODEL_LABELS = new Set([
  'Black-Scholes',
  'Black-76',
  'Jump Diffusion',
  'Variance Gamma',
  'Monte Carlo',
  'Monte Carlo - Jump Diffusion',
  'Monte Carlo - Heston',
  'Monte Carlo - Mean Reverting',
  'Local Volatility',
  'Local Volatility - Dupire',
  'Local Volatility - CEV',
  'Heston',
  'SABR',
  'Binomial',
  'Merton',
  'Kou',
  'ESSVI',
  'CGMY',
  'Bates',
]);
const SAFE_ASSISTANT_IDENTIFIER = /^[A-Za-z][A-Za-z0-9]*(?:(?:_|-)[A-Za-z][A-Za-z0-9]*)*$/;
const UTF8_ENCODER = new TextEncoder();
/** Headroom under the 50 KB MCP response limit so the generic size guard
 *  never silently collapses the response. Mirrors fftResponseShaping. */
const COMPUTE_RUNS_SAFE_SIZE_BUDGET = 48 * 1024;

interface ConfidenceStrictness {
  current: boolean;
  /** Full-mode output renames backend model ids. Only a previously sanitized
   * row may treat those display keys as trusted input on an idempotent pass. */
  allowSanitizedDisplayIds?: boolean;
}

type ProtectedCalibrationModelId =
  | 'Heston'
  | 'SABR'
  | 'MonteCarlo-Heston'
  | 'JumpDiffusion'
  | 'VarianceGamma'
  | 'MonteCarlo-JumpDiffusion';

const EXACT_CONFIDENCE_RULES: Readonly<Partial<Record<ProtectedCalibrationModelId, {
  label: string;
  method: string;
}>>> = {
  Heston: {
    label: MODEL_SPECIFIC_CONFIDENCE_LABEL,
    method: 'heston-quality-v1',
  },
  SABR: {
    label: MODEL_SPECIFIC_CONFIDENCE_LABEL,
    method: 'sabr-quality-v1',
  },
  'MonteCarlo-Heston': {
    label: MODEL_SPECIFIC_CONFIDENCE_LABEL,
    method: 'heston-quality-v1',
  },
  JumpDiffusion: {
    label: WITHIN_FAMILY_CONFIDENCE_LABEL,
    method: 'unified-jump-selection-v1',
  },
  VarianceGamma: {
    label: MODEL_SPECIFIC_CONFIDENCE_LABEL,
    method: 'variance-gamma-quality-v1',
  },
};

function protectedCalibrationModelId(value: string): ProtectedCalibrationModelId | null {
  const lookup = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (lookup === 'heston') return 'Heston';
  if (lookup === 'sabr') return 'SABR';
  if (lookup === 'montecarloheston') return 'MonteCarlo-Heston';
  if (lookup === 'jumpdiffusion') return 'JumpDiffusion';
  if (lookup === 'variancegamma') return 'VarianceGamma';
  if (lookup === 'montecarlojumpdiffusion') return 'MonteCarlo-JumpDiffusion';
  return null;
}

function exactConfidenceRequired(
  modelId: ProtectedCalibrationModelId | null,
  strictness: ConfidenceStrictness,
): boolean {
  return strictness.current
    && modelId != null
    && EXACT_CONFIDENCE_RULES[modelId] != null;
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function hasOwn(container: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(container, key);
}

function ownField(container: Record<string, unknown> | null, key: string): unknown {
  return container && hasOwn(container, key) ? container[key] : undefined;
}

function getOwnObjectField(container: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  return getObject(ownField(container, key));
}

function getArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function asTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toIso(timestamp: unknown): string | undefined {
  const ts = asTimestamp(timestamp);
  if (ts == null || ts <= 0) return undefined;
  return new Date(ts).toISOString();
}

function toIsoPreservingNull(timestamp: unknown): string | null | undefined {
  return timestamp === null ? null : toIso(timestamp);
}

function finiteNumberOrNull(value: unknown, decimals?: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return decimals == null ? value : round(value, decimals);
}

function stringOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanOrNull(value: unknown): boolean | null | undefined {
  if (value === null) return null;
  return typeof value === 'boolean' ? value : undefined;
}

function shapeExecutionConfig(value: unknown): Record<string, unknown> | undefined {
  const config = getObject(value);
  if (!config) return undefined;

  const calibrationPolicy = config.calibrationPolicy === null
    ? null
    : typeof config.calibrationPolicy === 'string' && config.calibrationPolicy.length > 0
      ? config.calibrationPolicy
      : undefined;
  const useDiscreteDividends = config.useDiscreteDividends === null
    ? null
    : typeof config.useDiscreteDividends === 'boolean'
      ? config.useDiscreteDividends
      : undefined;
  const shaped = Object.fromEntries(Object.entries({
    calibrationPolicy,
    useDiscreteDividends,
  }).filter(([, fieldValue]) => fieldValue !== undefined));

  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

function normalizeUnderlying(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().toUpperCase() : undefined;
}

function humanizeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function boundString(value: unknown, maxChars: number): { value?: string; truncated: boolean } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { truncated: false };
  }
  if (value.length <= maxChars) return { value, truncated: false };
  return {
    value: `${value.slice(0, Math.max(0, maxChars - 1))}…`,
    truncated: true,
  };
}

/** Assistant completion reasons have both character and byte ceilings. The
 * byte ceiling keeps the worst-case pair of capped arrays below the MCP floor
 * even when every source string is multibyte. */
function boundAssistantString(value: unknown, maxChars: number): { value?: string; truncated: boolean } {
  if (typeof value !== 'string' || value.trim().length === 0) return { truncated: false };
  const trimmed = value.trim();
  const jsonContentBytes = UTF8_ENCODER.encode(JSON.stringify(trimmed)).byteLength - 2;
  if (trimmed.length <= maxChars && jsonContentBytes <= maxChars) {
    return { value: trimmed, truncated: false };
  }

  const ellipsis = '…';
  const ellipsisBytes = UTF8_ENCODER.encode(ellipsis).byteLength;
  const pieces: string[] = [];
  let bytes = 0;
  for (const character of trimmed) {
    // Count the bytes that will actually appear inside JSON quotes. Control
    // characters and quotes expand when escaped and must consume that budget.
    const characterBytes = UTF8_ENCODER.encode(JSON.stringify(character)).byteLength - 2;
    if (pieces.length >= maxChars - 1 || bytes + characterBytes > maxChars - ellipsisBytes) break;
    pieces.push(character);
    bytes += characterBytes;
  }

  return {
    value: `${pieces.join('')}${ellipsis}`,
    truncated: true,
  };
}

function getPositions(record: Record<string, unknown>): Record<string, unknown>[] {
  return getArray<Record<string, unknown>>(record.positions)
    .filter((item) => item != null && typeof item === 'object' && !Array.isArray(item));
}

/** The current wire stores the authoritative pre-compaction universe here. */
function getRunUnderlyings(record: Record<string, unknown>): string[] {
  const nested = getObject(record.data);
  return Array.from(new Set(
    getArray(nested?.underlyings)
      .map((value) => normalizeUnderlying(value))
      .filter((value): value is string => value !== undefined),
  ));
}

function getSummary(record: Record<string, unknown>): Record<string, unknown> | null {
  return getObject(getObject(record.data)?.summary);
}

function getDispersion(record: Record<string, unknown>): Record<string, unknown> | null {
  return getObject(getObject(getObject(record.data)?.portfolioAggregates)?.dispersion);
}

function materializeOwnArrayField(
  container: Record<string, unknown> | null,
  key: string,
): unknown[] | undefined {
  if (!container || !hasOwn(container, key)) return undefined;
  const source = container[key];
  if (!Array.isArray(source)) return [undefined];

  const materialized: unknown[] = [];
  for (let index = 0; index < source.length; index += 1) {
    materialized.push(Object.prototype.hasOwnProperty.call(source, index) ? source[index] : undefined);
  }
  return materialized;
}

function boundedAssistantIdentifier(value: unknown, fallback: string): string {
  return boundAssistantString(value, MAX_ASSISTANT_EXCLUSION_IDENTIFIER_CHARS).value ?? fallback;
}

function boundedAssistantModel(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'model not recorded';
  const trimmed = value.trim();
  const standardDisplayName = modelDisplayName(trimmed);
  const displayName = typeof standardDisplayName === 'string' && KNOWN_ASSISTANT_MODEL_LABELS.has(standardDisplayName)
    ? standardDisplayName
    : SAFE_ASSISTANT_IDENTIFIER.test(trimmed)
      ? trimmed
          .replace(/_+/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .replace(/\s+/g, ' ')
          .trim()
      : trimmed;
  return boundedAssistantIdentifier(displayName, 'model not recorded');
}

function humanizeAssistantReason(value: unknown, knownLabels?: Record<string, string>): string {
  if (typeof value !== 'string' || value.trim().length === 0) return 'reason not recorded';
  const trimmed = value.trim();
  const known = knownLabels && hasOwn(knownLabels, trimmed)
    ? knownLabels[trimmed]
    : undefined;
  const isWholeSafeIdentifier = SAFE_ASSISTANT_IDENTIFIER.test(trimmed)
    && (trimmed.includes('_') || trimmed.includes('-') || /[a-z][A-Z]/.test(trimmed));
  const readable = known
    ?? (isWholeSafeIdentifier
      ? humanizeIdentifier(trimmed)
      : trimmed);
  return boundAssistantString(readable, MAX_ASSISTANT_EXCLUSION_REASON_CHARS).value
    ?? 'reason not recorded';
}

function isExactDuplicateSourceBookkeeping(
  value: unknown,
  authoritativeExpected: number | null,
  strictCurrent: boolean,
): boolean {
  const entry = getObject(value);
  if (!entry || !['reason', 'model', 'metric', 'included', 'expected', 'complete'].every((key) => hasOwn(entry, key))) {
    return false;
  }
  const reason = ownField(entry, 'reason');
  const model = ownField(entry, 'model');
  const metric = ownField(entry, 'metric');
  const included = ownField(entry, 'included');
  const expected = ownField(entry, 'expected');
  const complete = ownField(entry, 'complete');
  return reason === 'duplicate_source'
    && typeof model === 'string'
    && model.trim().length > 0
    && typeof metric === 'string'
    && metric.trim().length > 0
    && typeof included === 'number'
    && Number.isSafeInteger(included)
    && included >= 0
    && typeof expected === 'number'
    && Number.isSafeInteger(expected)
    && expected > 0
    && included === expected
    && complete === false
    && (!strictCurrent || (authoritativeExpected !== null && expected === authoritativeExpected));
}

function shapeAggregateExclusion(
  value: unknown,
  authoritativeExpected: number | null,
  strictCurrent: boolean,
): Record<string, unknown> {
  const entry = getObject(value);
  const reason = ownField(entry, 'reason');
  const rawIncluded = ownField(entry, 'included');
  const rawExpected = ownField(entry, 'expected');
  let included = typeof rawIncluded === 'number'
    && Number.isSafeInteger(rawIncluded)
    && rawIncluded >= 0
    ? rawIncluded
    : null;
  let expected = typeof rawExpected === 'number'
    && Number.isSafeInteger(rawExpected)
    && rawExpected >= 0
    ? rawExpected
    : null;
  const hasCanonicalReason = typeof reason === 'string'
    && Object.prototype.hasOwnProperty.call(AGGREGATE_EXCLUSION_REASON_LABELS, reason);
  const contradictsReason = included !== null && expected !== null && (
    (reason === 'incomplete_position_coverage' && included >= expected)
    || (reason === 'invalid_value' && included <= 0)
    || ((reason === 'unsafe_net_value' || reason === 'duplicate_source') && included !== expected)
  );
  if ((strictCurrent && (!hasCanonicalReason || authoritativeExpected === null))
    || ((strictCurrent || hasCanonicalReason)
      && expected !== null
      && authoritativeExpected !== null
      && expected !== authoritativeExpected)
    || (included !== null && expected !== null && included > expected)
    || contradictsReason) {
    // A contradictory pair would imply a false coverage ratio. Preserve
    // fieldwise knowledge for unilateral invalidity, but reject this relation
    // as a pair because neither value is trustworthy in that context.
    included = null;
    expected = null;
  }
  return {
    model: boundedAssistantModel(ownField(entry, 'model')),
    metric: boundedAssistantIdentifier(ownField(entry, 'metric'), 'metric not recorded'),
    reason: humanizeAssistantReason(reason, AGGREGATE_EXCLUSION_REASON_LABELS),
    included,
    expected,
  };
}

function shapeModelExclusion(value: unknown): Record<string, unknown> {
  const entry = getObject(value);
  const rawDependency = ownField(entry, 'dependency');
  const dependency = typeof rawDependency === 'string' && rawDependency.trim().length > 0
    ? boundedAssistantModel(rawDependency)
    : undefined;
  return Object.fromEntries(Object.entries({
    model: boundedAssistantModel(ownField(entry, 'model')),
    underlying: boundedAssistantIdentifier(normalizeUnderlying(ownField(entry, 'underlying')), 'underlying not recorded'),
    expiration: boundedAssistantIdentifier(ownField(entry, 'expiration'), 'expiration not recorded'),
    reason: humanizeAssistantReason(ownField(entry, 'reason')),
    dependency,
  }).filter(([, fieldValue]) => fieldValue !== undefined));
}

function getValidOriginalModelExclusionCount(
  data: Record<string, unknown>,
  sourceLength: number,
): number | undefined {
  const summary = getOwnObjectField(data, 'summary');
  if (!summary || ![
    'modelExclusionCount',
    'includedModelExclusionCount',
    'modelExclusionsTruncated',
  ].every((key) => hasOwn(summary, key))) {
    return undefined;
  }

  const original = ownField(summary, 'modelExclusionCount');
  const included = ownField(summary, 'includedModelExclusionCount');
  const truncated = ownField(summary, 'modelExclusionsTruncated');
  if (typeof original !== 'number'
    || !Number.isSafeInteger(original)
    || original < 0
    || typeof included !== 'number'
    || !Number.isSafeInteger(included)
    || included < 0
    || included !== sourceLength
    || original < included
    || (original > 0 && included === 0)
    || typeof truncated !== 'boolean'
    || truncated !== (original > included)) {
    return undefined;
  }
  return original;
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hasNonEmptyText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasCanonicalUnderlying(value: unknown): value is string {
  return hasNonEmptyText(value)
    && value.length <= 100
    && value === value.trim().toUpperCase();
}

function hasCurrentProvenanceShape(value: unknown): boolean {
  if (value === null) return true;
  const provenance = getObject(value);
  if (!provenance
    || !COMPUTE_PROVENANCE_KINDS.has(ownField(provenance, 'kind') as string)
    || !hasNonEmptyText(ownField(provenance, 'source'))
    || (hasOwn(provenance, 'family') && typeof ownField(provenance, 'family') !== 'string')
    || (hasOwn(provenance, 'provider')
      && ownField(provenance, 'provider') !== null
      && typeof ownField(provenance, 'provider') !== 'string')
    || (hasOwn(provenance, 'observedAt')
      && ownField(provenance, 'observedAt') !== null
      && typeof ownField(provenance, 'observedAt') !== 'string'
      && !isFiniteNumber(ownField(provenance, 'observedAt')))
    || (hasOwn(provenance, 'staleAfter')
      && ownField(provenance, 'staleAfter') !== null
      && !isFiniteNumber(ownField(provenance, 'staleAfter')))
    || (hasOwn(provenance, 'assumed') && typeof ownField(provenance, 'assumed') !== 'boolean')
    || (hasOwn(provenance, 'details')
      && getObject(ownField(provenance, 'details')) == null)) {
    return false;
  }
  return true;
}

function hasRequiredNullableShape(
  value: Record<string, unknown>,
  key: string,
  validate: (candidate: unknown) => boolean,
): boolean {
  return hasOwn(value, key) && value[key] !== undefined && validate(value[key]);
}

function hasCompactMetricShape(value: unknown, allowNull: boolean): boolean {
  if (value === null) return allowNull;
  if (isFiniteNumber(value)) return true;
  const compact = getObject(value);
  if (!compact || !isFiniteNumber(ownField(compact, 'value'))) return false;
  for (const key of ['stdError', 'ciLow', 'ciHigh']) {
    const candidate = ownField(compact, key);
    if (hasOwn(compact, key) && !isFiniteNumber(candidate)) return false;
  }
  const source = ownField(compact, 'source');
  return !hasOwn(compact, 'source')
    || (source !== null && hasCurrentProvenanceShape(source));
}

function hasCurrentCalibrationShape(value: unknown): boolean {
  const calibration = getObject(value);
  const warnings = ownField(calibration, 'warnings');
  if (!calibration
    || getObject(ownField(calibration, 'params')) == null
    || !isDenseArray(warnings)
    || warnings.length > CURRENT_COMPUTE_CALIBRATION_WARNING_LIMIT
    || !warnings.every(warning => (
      typeof warning === 'string'
      && warning.length <= CURRENT_COMPUTE_CALIBRATION_WARNING_MAX_LENGTH
    ))
    || typeof ownField(calibration, 'isFallback') !== 'boolean'
    || !hasRequiredNullableShape(calibration, 'rmse', candidate => (
      candidate === null || isFiniteNumber(candidate)
    ))
    || !hasRequiredNullableShape(calibration, 'confidence', candidate => (
      candidate === null || isFiniteNumber(candidate)
    ))
    || !hasNonEmptyText(ownField(calibration, 'expirationDate'))
    || (ownField(calibration, 'expirationDate') as string).length
      > CURRENT_COMPUTE_EXPIRATION_MAX_LENGTH) {
    return false;
  }
  const executionPath = ownField(calibration, 'executionPath');
  const status = ownField(calibration, 'status');
  const failureReason = ownField(calibration, 'failureReason');
  if ((hasOwn(calibration, 'executionPath')
      && (typeof executionPath !== 'string'
        || executionPath.length > CURRENT_COMPUTE_EXECUTION_PATH_MAX_LENGTH))
    || (hasOwn(calibration, 'status')
      && !['success', 'failed', 'unavailable', 'excluded'].includes(status as string))
    || (hasOwn(calibration, 'failureReason')
      && (typeof failureReason !== 'string'
        || failureReason.length > CURRENT_COMPUTE_ERROR_TEXT_MAX_LENGTH))) {
    return false;
  }
  const semanticsValue = ownField(calibration, 'confidenceSemantics');
  if (hasOwn(calibration, 'confidenceSemantics')) {
    const semantics = getObject(semanticsValue);
    if (!semantics
      || !hasNonEmptyText(ownField(semantics, 'label'))
      || !hasNonEmptyText(ownField(semantics, 'method'))
      || !hasNonEmptyText(ownField(semantics, 'scale'))
      || ownField(semantics, 'crossModelComparable') !== false) {
      return false;
    }
  }
  return true;
}

function hasCurrentConfidenceSemantics(
  modelName: string,
  calibration: Record<string, unknown>,
): boolean {
  const confidence = ownField(calibration, 'confidence');
  const hasSemantics = hasOwn(calibration, 'confidenceSemantics');
  if (modelName === 'MonteCarlo-JumpDiffusion') {
    return confidence === null && !hasSemantics;
  }
  const expected = EXACT_CONFIDENCE_RULES[modelName as ProtectedCalibrationModelId];
  if (!expected) return !hasSemantics;
  if (confidence === null) return !hasSemantics;
  const semantics = getObject(ownField(calibration, 'confidenceSemantics'));
  return isFiniteNumber(confidence)
    && confidence >= 0
    && confidence <= 100
    && semantics != null
    && ownField(semantics, 'label') === expected.label
    && ownField(semantics, 'method') === expected.method
    && ownField(semantics, 'scale') === CALIBRATION_CONFIDENCE_SCALE
    && ownField(semantics, 'crossModelComparable') === false;
}

function compactMetricComponents(value: unknown): Record<string, number> | null {
  if (isFiniteNumber(value)) return { value };
  const compact = getObject(value);
  const metricValue = ownField(compact, 'value');
  if (!compact || !isFiniteNumber(metricValue)) return null;
  const components: Record<string, number> = { value: metricValue };
  for (const key of ['stdError', 'ciLow', 'ciHigh']) {
    const candidate = ownField(compact, key);
    if (isFiniteNumber(candidate)) components[key] = candidate;
  }
  return components;
}

function matchingCompactMetrics(left: unknown, right: unknown): boolean {
  if (isFiniteNumber(left) || isFiniteNumber(right)) return Object.is(left, right);
  const leftMetric = compactMetricComponents(left);
  const rightMetric = compactMetricComponents(right);
  if (!leftMetric || !rightMetric) return false;
  const leftKeys = Object.keys(leftMetric).sort();
  const rightKeys = Object.keys(rightMetric).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && Object.is(leftMetric[key], rightMetric[key])
    ));
}

function hasCurrentEarlyExercisePremiumShape(value: unknown, modelName: string): boolean {
  const premium = getObject(value);
  if (!premium
    || !['priceAmerican', 'priceEuropean', 'premium', 'premiumPercent']
      .every(key => isFiniteNumber(ownField(premium, key)))) {
    return false;
  }
  if (modelName === 'PDE') {
    const priceAmerican = ownField(premium, 'priceAmerican') as number;
    const priceEuropean = ownField(premium, 'priceEuropean') as number;
    const recordedPremium = ownField(premium, 'premium') as number;
    const recordedPercent = ownField(premium, 'premiumPercent') as number;
    const expectedPremium = priceAmerican - priceEuropean;
    const expectedPercent = priceEuropean > 0 ? (expectedPremium / priceEuropean) * 100 : 0;
    if (priceAmerican < priceEuropean
      || recordedPremium !== expectedPremium
      || recordedPercent !== expectedPercent) {
      return false;
    }
  }
  if (hasOwn(premium, 'numericalAdjustment')) {
    const adjustment = getObject(ownField(premium, 'numericalAdjustment'));
    if (modelName !== 'PDE'
      || !adjustment
      || ownField(adjustment, 'reason') !== 'american_below_european_within_tolerance'
      || !['rawPriceAmerican', 'rawDifference', 'tolerance']
        .every(key => isFiniteNumber(ownField(adjustment, key)))) {
      return false;
    }
    const rawPriceAmerican = ownField(adjustment, 'rawPriceAmerican') as number;
    const rawDifference = ownField(adjustment, 'rawDifference') as number;
    const tolerance = ownField(adjustment, 'tolerance') as number;
    const priceAmerican = ownField(premium, 'priceAmerican') as number;
    const priceEuropean = ownField(premium, 'priceEuropean') as number;
    const prescribedTolerance = Math.max(
      1e-6,
      1e-3 * Math.max(1, Math.abs(priceEuropean), Math.abs(rawPriceAmerican)),
    );
    if (rawDifference >= 0
      || tolerance <= 0
      || Math.abs(rawDifference) > tolerance
      || tolerance !== prescribedTolerance
      || rawPriceAmerican - priceEuropean !== rawDifference
      || priceAmerican !== priceEuropean
      || ownField(premium, 'premium') !== 0
      || ownField(premium, 'premiumPercent') !== 0) {
      return false;
    }
  }
  return true;
}

function hasConsistentPdeVariants(variants: unknown[], premiumValue: unknown): boolean {
  const canonical = (exerciseStyle: string) => variants.filter((variantValue) => {
    const variant = getObject(variantValue);
    const dimensions = getOwnObjectField(variant, 'dimensions');
    return dimensions != null
      && ownField(dimensions, 'exerciseStyle') === exerciseStyle
      && !hasOwn(dimensions, 'beta');
  }).map(value => getObject(value) as Record<string, unknown>);
  const european = canonical('european');
  const american = canonical('american');
  if (european.length > 1 || american.length > 1) return false;
  if (european.length !== 1 || american.length !== 1) return premiumValue == null;
  const successful = [european[0], american[0]].every((variant) => {
    const diagnostics = getOwnObjectField(variant, 'diagnostics');
    return !hasOwn(variant, 'error')
      && ownField(diagnostics, 'convergence') !== false;
  });
  if (premiumValue != null && !successful) return false;
  const europeanPrice = compactMetricComponents(ownField(european[0], 'price'))?.value;
  const americanPrice = compactMetricComponents(ownField(american[0], 'price'))?.value;
  if (europeanPrice == null || americanPrice == null) return premiumValue == null;
  if (successful && americanPrice < europeanPrice) return false;
  if (premiumValue == null) return true;
  const premium = getObject(premiumValue);
  if (!premium
    || ownField(premium, 'priceEuropean') !== europeanPrice
    || ownField(premium, 'priceAmerican') !== americanPrice) {
    return false;
  }
  if (!hasOwn(premium, 'numericalAdjustment')) return true;
  if (!matchingCompactMetrics(ownField(european[0], 'price'), ownField(american[0], 'price'))) {
    return false;
  }
  const europeanGreeks = getOwnObjectField(european[0], 'greeks');
  const americanGreeks = getOwnObjectField(american[0], 'greeks');
  if (!europeanGreeks || !americanGreeks) return false;
  const europeanKeys = Object.keys(europeanGreeks).sort();
  const americanKeys = Object.keys(americanGreeks).sort();
  return europeanKeys.length === americanKeys.length
    && europeanKeys.every((key, index) => (
      key === americanKeys[index]
      && matchingCompactMetrics(europeanGreeks[key], americanGreeks[key])
    ));
}

function currentComputeAllowedModels(scope: unknown): Set<string> | null {
  if (scope === 'core') return CORE_COMPUTE_MODEL_IDS;
  if (scope === 'full') return FULL_COMPUTE_MODEL_IDS;
  return null;
}

function hasCurrentModelsShape(value: unknown, scope: unknown): boolean {
  const models = getObject(value);
  const allowedModels = currentComputeAllowedModels(scope);
  if (!models || allowedModels == null) return false;
  const recordedModels = Object.keys(models);
  if (recordedModels.length !== allowedModels.size
    || [...allowedModels].some(model => !hasOwn(models, model))) {
    return false;
  }
  for (const [modelName, modelValue] of Object.entries(models)) {
    const model = getObject(modelValue);
    const variants = ownField(model, 'variants');
    const variantCount = ownField(model, 'variantCount');
    if (!hasNonEmptyText(modelName)
      || !allowedModels.has(modelName)
      || !model
      || !isDenseArray(variants)
      || !isNonNegativeSafeInteger(variantCount)
      || variantCount < 1
      || variants.length < 1
      || variantCount < variants.length
      || typeof ownField(model, 'variantsTruncated') !== 'boolean'
      || ownField(model, 'variantsTruncated') !== (variantCount > variants.length)) {
      return false;
    }
    for (const variantValue of variants) {
      const variant = getObject(variantValue);
      const dimensions = getOwnObjectField(variant, 'dimensions');
      const greeks = getOwnObjectField(variant, 'greeks');
      if (!variant
        || !dimensions
        || !['european', 'american'].includes(ownField(dimensions, 'exerciseStyle') as string)
        || (modelName === 'PDE' && hasOwn(dimensions, 'beta'))
        || (hasOwn(dimensions, 'beta') && !isFiniteNumber(ownField(dimensions, 'beta')))
        || !hasRequiredNullableShape(variant, 'price', price => hasCompactMetricShape(price, true))
        || !greeks
        || !Object.keys(greeks).every(greek => CURRENT_COMPUTE_GREEK_NAMES.has(greek))
        || !Object.values(greeks).every(greek => hasCompactMetricShape(greek, false))
        || (hasOwn(variant, 'error')
          && (typeof ownField(variant, 'error') !== 'string'
            || (ownField(variant, 'error') as string).length
              > CURRENT_COMPUTE_ERROR_TEXT_MAX_LENGTH))) {
        return false;
      }
      const diagnosticsValue = ownField(variant, 'diagnostics');
      if (hasOwn(variant, 'diagnostics')) {
        const diagnostics = getObject(diagnosticsValue);
        if (!diagnostics
          || (hasOwn(diagnostics, 'convergence')
            && typeof ownField(diagnostics, 'convergence') !== 'boolean')
          || (hasOwn(diagnostics, 'iterations')
            && !isNonNegativeSafeInteger(ownField(diagnostics, 'iterations')))
          || (hasOwn(diagnostics, 'method')
            && (typeof ownField(diagnostics, 'method') !== 'string'
              || (ownField(diagnostics, 'method') as string).length
                > CURRENT_COMPUTE_EXECUTION_PATH_MAX_LENGTH))) {
          return false;
        }
      }
    }
    const calibration = ownField(model, 'calibration');
    const calibrationObject = getObject(calibration);
    if (hasOwn(model, 'calibration')
      && (!CALIBRATION_CARRYING_MODEL_IDS.has(modelName)
        || !hasCurrentCalibrationShape(calibration)
        || !calibrationObject
        || !hasCurrentConfidenceSemantics(modelName, calibrationObject))) {
      return false;
    }
    const premium = ownField(model, 'earlyExercisePremium');
    if (hasOwn(model, 'earlyExercisePremium')
      && !hasCurrentEarlyExercisePremiumShape(premium, modelName)) return false;
    if (modelName === 'PDE' && !hasConsistentPdeVariants(variants, premium)) return false;
  }
  return true;
}

function hasCurrentPositionShape(value: unknown, scope: unknown): boolean {
  const position = getObject(value);
  if (!position
    || !['positionId', 'symbol', 'expiration']
      .every(key => hasNonEmptyText(ownField(position, key)))
    || !hasCanonicalUnderlying(ownField(position, 'underlying'))
    || typeof ownField(position, 'isCall') !== 'boolean'
    || !['strike', 'daysToExpiry', 'spot', 'iv', 'multiplier'].every(key => {
      const candidate = ownField(position, key);
      return isFiniteNumber(candidate) && candidate > 0;
    })
    || !isFiniteNumber(ownField(position, 'quantity'))
    || ownField(position, 'quantity') === 0
    || !['riskFreeRate', 'dividendYield']
      .every(key => isFiniteNumber(ownField(position, key)))
    || !hasRequiredNullableShape(position, 'marketPrice', candidate => (
      candidate === null || isFiniteNumber(candidate)
    ))
    || !hasRequiredNullableShape(position, 'timeToExpiryYears', candidate => (
      isFiniteNumber(candidate) && candidate > 0
    ))
    || !hasRequiredNullableShape(position, 'valuationTime', isFiniteNumber)
    || !hasRequiredNullableShape(position, 'assetClass', candidate => (
      candidate === null || candidate === 'equity' || candidate === 'futures'
    ))
    || !hasRequiredNullableShape(position, 'pricingBasis', candidate => (
      candidate === null || candidate === 'spot' || candidate === 'futures-forward'
    ))
    || !['spotProvenance', 'ivProvenance', 'riskFreeRateProvenance', 'dividendProvenance']
      .every(key => hasRequiredNullableShape(position, key, hasCurrentProvenanceShape))
    || !hasOwn(position, 'models')
    || !hasCurrentModelsShape(ownField(position, 'models'), scope)) {
    return false;
  }
  return true;
}

function hasCurrentErrorShape(value: unknown, authoritativeUnderlyings: Set<string>): boolean {
  const error = getObject(value);
  return error != null
    && ['positionId', 'model', 'error']
      .every(key => hasOwn(error, key) && typeof ownField(error, key) === 'string')
    && (ownField(error, 'error') as string).length <= CURRENT_COMPUTE_ERROR_TEXT_MAX_LENGTH
    && (!hasOwn(error, 'code')
      || (typeof ownField(error, 'code') === 'string'
        && (ownField(error, 'code') as string).length <= 200))
    && (!hasOwn(error, 'expiration')
      || (hasNonEmptyText(ownField(error, 'expiration'))
        && (ownField(error, 'expiration') as string).length <= 100))
    && (!hasOwn(error, 'underlying')
      || (hasCanonicalUnderlying(ownField(error, 'underlying'))
        && authoritativeUnderlyings.has(ownField(error, 'underlying') as string)));
}

function hasCurrentExecutionConfigShape(value: unknown): boolean {
  const config = getObject(value);
  return config != null
    && ownField(config, 'calibrationPolicy') === 'required'
    && typeof ownField(config, 'useDiscreteDividends') === 'boolean'
    && isNonNegativeSafeInteger(ownField(config, 'randomSeed'));
}

function hasCurrentExposureSweepShape(value: unknown, underlyings: unknown): boolean {
  if (!isDenseArray(value) || !isDenseArray(underlyings)) return false;
  const authoritativeUnderlyings = new Set(underlyings);
  return value.every((candidateValue) => {
    const candidate = getObject(candidateValue);
    const keyLevels = getOwnObjectField(candidate, 'keyLevels');
    const aggregateByStrike = ownField(candidate, 'aggregateByStrike');
    const strikeCount = ownField(candidate, 'strikeCount');
    const underlying = ownField(candidate, 'underlying');
    if (!candidate
      || !hasCanonicalUnderlying(underlying)
      || !authoritativeUnderlyings.has(underlying)
      || !isNonNegativeSafeInteger(strikeCount)
      || !isFiniteNumber(ownField(candidate, 'spot'))
      || !isFiniteNumber(ownField(candidate, 'timestamp'))
      || !keyLevels
      || !['positive-gamma', 'negative-gamma', 'unknown']
        .includes(ownField(keyLevels, 'regime') as string)
      || !['callWall', 'putWall', 'gammaFlip', 'gammaTilt'].every(key => (
        hasRequiredNullableShape(
          keyLevels,
          key,
          level => level === null || isFiniteNumber(level),
        )
      ))
      || !isDenseArray(aggregateByStrike)
      || !aggregateByStrike.every((strikeValue) => {
        const strike = getObject(strikeValue);
        return strike != null
          && CURRENT_EXPOSURE_STRIKE_FIELDS.every(field => (
            hasOwn(strike, field) && isFiniteNumber(ownField(strike, field))
          ));
      })
      || strikeCount < aggregateByStrike.length
      || typeof ownField(candidate, 'aggregateByStrikeTruncated') !== 'boolean'
      || ownField(candidate, 'aggregateByStrikeTruncated')
        !== (strikeCount > aggregateByStrike.length)) {
      return false;
    }
    return true;
  });
}

function hasCurrentIncompleteAggregateEvidence(
  value: Record<string, unknown>,
  expectedPositions: number,
): boolean {
  const included = ownField(value, 'included');
  const expected = ownField(value, 'expected');
  const reason = ownField(value, 'reason');
  if (!isNonNegativeSafeInteger(included)
    || !isNonNegativeSafeInteger(expected)
    || expected !== expectedPositions
    || included > expected
    || ownField(value, 'complete') !== false
    || typeof reason !== 'string'
    || !hasOwn(AGGREGATE_EXCLUSION_REASON_LABELS, reason)) {
    return false;
  }
  return !((reason === 'incomplete_position_coverage' && included >= expected)
    || (reason === 'invalid_value' && included <= 0)
    || ((reason === 'unsafe_net_value' || reason === 'duplicate_source')
      && included !== expected));
}

function hasCanonicalAggregateExclusions(
  value: unknown,
  expectedPositions: number,
  allowedModels: Set<string>,
): boolean {
  if (!isDenseArray(value)) return false;
  for (const candidateValue of value) {
    const candidate = getObject(candidateValue);
    if (!candidate
      || !['model', 'metric', 'included', 'expected', 'complete', 'reason']
        .every(key => hasOwn(candidate, key))
      || !allowedModels.has(ownField(candidate, 'model') as string)
      || !CURRENT_COMPUTE_AGGREGATE_METRICS.has(ownField(candidate, 'metric') as string)
      || !hasCurrentIncompleteAggregateEvidence(candidate, expectedPositions)) {
      return false;
    }
  }
  return true;
}

function hasCurrentAggregateCoverageShape(value: unknown, expectedPositions: number): boolean {
  const coverage = getObject(value);
  const included = ownField(coverage, 'included');
  const expected = ownField(coverage, 'expected');
  const complete = ownField(coverage, 'complete');
  if (!coverage
    || !['included', 'expected', 'complete'].every(key => hasOwn(coverage, key))
    || !isNonNegativeSafeInteger(included)
    || !isNonNegativeSafeInteger(expected)
    || expected !== expectedPositions
    || included > expected
    || typeof complete !== 'boolean') {
    return false;
  }
  if (complete) return included === expected && !hasOwn(coverage, 'reason');
  return hasOwn(coverage, 'reason')
    && hasCurrentIncompleteAggregateEvidence(coverage, expectedPositions);
}

function hasCurrentPortfolioAggregateShape(
  value: unknown,
  scope: unknown,
  expectedPositions: number,
  compactionLevel: unknown,
): boolean {
  const aggregates = getObject(value);
  const allowedModels = currentComputeAllowedModels(scope);
  const byModel = getOwnObjectField(aggregates, 'byModel');
  const dispersion = getOwnObjectField(aggregates, 'dispersion');
  if (!aggregates
    || !allowedModels
    || !byModel
    || !dispersion
    || !hasOwn(aggregates, 'exclusions')
    || hasOwn(aggregates, 'excluded')) return false;

  for (const [model, metricsValue] of Object.entries(byModel)) {
    const metrics = getObject(metricsValue);
    if (!allowedModels.has(model) || !metrics) return false;
    for (const [metric, metricValue] of Object.entries(metrics)) {
      if (!CURRENT_COMPUTE_AGGREGATE_METRICS.has(metric) || !isFiniteNumber(metricValue)) {
        return false;
      }
    }
  }

  for (const [metric, dispersionValue] of Object.entries(dispersion)) {
    const entry = getObject(dispersionValue);
    const min = ownField(entry, 'min');
    const max = ownField(entry, 'max');
    const mean = ownField(entry, 'mean');
    const stddev = ownField(entry, 'stddev');
    const models = ownField(entry, 'models');
    if (!CURRENT_COMPUTE_AGGREGATE_METRICS.has(metric)
      || !entry
      || !['min', 'max', 'mean', 'stddev', 'models'].every(key => hasOwn(entry, key))
      || !isFiniteNumber(min)
      || !isFiniteNumber(max)
      || !isFiniteNumber(mean)
      || !isFiniteNumber(stddev)
      || min > mean
      || mean > max
      || stddev < 0
      || !isDenseArray(models)
      || models.length < 2
      || !models.every(model => typeof model === 'string' && allowedModels.has(model))
      || new Set(models).size !== models.length) {
      return false;
    }
  }

  const hasCoverage = hasOwn(aggregates, 'coverage');
  if (hasCoverage !== (compactionLevel !== 'summary-only')) return false;
  if (hasCoverage) {
    const coverage = getOwnObjectField(aggregates, 'coverage');
    if (!coverage) return false;
    for (const [model, metricsValue] of Object.entries(coverage)) {
      const metrics = getObject(metricsValue);
      if (!allowedModels.has(model) || !metrics) return false;
      for (const [metric, coverageValue] of Object.entries(metrics)) {
        if (!CURRENT_COMPUTE_AGGREGATE_METRICS.has(metric)
          || !hasCurrentAggregateCoverageShape(coverageValue, expectedPositions)) {
          return false;
        }
      }
    }
  }

  if (!hasCanonicalAggregateExclusions(
      ownField(aggregates, 'exclusions'),
      expectedPositions,
      allowedModels,
    )) {
    return false;
  }

  return true;
}

function hasCurrentTerminalRunSemantics(
  status: unknown,
  scope: unknown,
  data: Record<string, unknown>,
  summary: Record<string, unknown>,
): boolean {
  const completionState = ownField(summary, 'completionState');
  const errorCount = ownField(summary, 'errorCount');
  if (status === 'failed') return completionState === 'partial' && (errorCount as number) > 0;
  if (status === 'cancelled') return completionState === 'partial';
  if (status !== 'completed') return false;
  const totalPositions = ownField(summary, 'totalPositions');
  if (!isNonNegativeSafeInteger(totalPositions) || totalPositions <= 0) return false;
  const allowedModels = currentComputeAllowedModels(scope);
  const aggregates = getOwnObjectField(data, 'portfolioAggregates');
  const exclusions = ownField(aggregates, 'exclusions');
  if (!aggregates
    || !allowedModels
    || !hasOwn(aggregates, 'exclusions')
    || !hasCanonicalAggregateExclusions(exclusions, totalPositions, allowedModels)) {
    return false;
  }
  const aggregateEvidence = (exclusions as Array<Record<string, unknown>>)
    .some(exclusion => ownField(exclusion, 'reason') !== 'duplicate_source');
  const hasEvidence = (errorCount as number) > 0
    || (ownField(summary, 'modelExclusionCount') as number) > 0
    || aggregateEvidence;
  return completionState === 'partial' ? hasEvidence : !hasEvidence;
}

function hasCurrentModelExclusionShape(
  value: unknown,
  allowedModels: Set<string>,
  authoritativeUnderlyings: Set<string>,
): boolean {
  const entry = getObject(value);
  return entry != null
    && hasNonEmptyText(ownField(entry, 'model'))
    && (ownField(entry, 'model') as string).length <= 200
    && allowedModels.has(ownField(entry, 'model') as string)
    && hasCanonicalUnderlying(ownField(entry, 'underlying'))
    && authoritativeUnderlyings.has(ownField(entry, 'underlying') as string)
    && hasNonEmptyText(ownField(entry, 'expiration'))
    && (ownField(entry, 'expiration') as string).length <= 100
    && hasNonEmptyText(ownField(entry, 'reason'))
    && (ownField(entry, 'reason') as string).length <= 2_000
    && (!hasOwn(entry, 'dependency')
      || (hasNonEmptyText(ownField(entry, 'dependency'))
        && (ownField(entry, 'dependency') as string).length <= 200));
}

function hasRetainedVariantTruncation(positions: unknown[]): boolean {
  return positions.some((positionValue) => {
    const position = getObject(positionValue);
    const models = getOwnObjectField(position, 'models');
    return models != null && Object.values(models).some((modelValue) => {
      const model = getObject(modelValue);
      return ownField(model, 'variantsTruncated') === true;
    });
  });
}

function hasCurrentProjectionShape(value: unknown, positions: unknown[]): boolean {
  const projection = getObject(value);
  const positionCount = positions.length;
  if (!projection
    || projection.schemaVersion !== 2
    || !CURRENT_COMPUTE_COMPACTION_LEVELS.has(ownField(projection, 'compactionLevel') as string)
    || typeof projection.originalPositionCount !== 'number'
    || !Number.isSafeInteger(projection.originalPositionCount)
    || projection.originalPositionCount < 0
    || typeof projection.includedPositionCount !== 'number'
    || !Number.isSafeInteger(projection.includedPositionCount)
    || projection.includedPositionCount !== positionCount
    || projection.originalPositionCount < projection.includedPositionCount
    || projection.positionsTruncated
      !== (projection.originalPositionCount > projection.includedPositionCount)) {
    return false;
  }
  const hasBooleanFlags = [
    'positionsTruncated',
    'variantsTruncated',
    'exposureTruncated',
    'calibrationTruncated',
    'earlyExercisePremiumTruncated',
    'portfolioAggregatesTruncated',
  ].every(key => typeof projection[key] === 'boolean');
  return hasBooleanFlags
    && (!hasRetainedVariantTruncation(positions)
      || ownField(projection, 'variantsTruncated') === true);
}

/** True only for the one compute wire contract this MCP release understands. */
export function isCurrentComputeRunRecord(value: unknown): value is RawComputeRunRecord {
  const record = getObject(value);
  const data = getOwnObjectField(record, 'data');
  const summary = getOwnObjectField(data, 'summary');
  const positions = ownField(record, 'positions');
  const underlyings = ownField(data, 'underlyings');
  const errors = ownField(data, 'errors');
  const modelExclusions = ownField(data, 'modelExclusions');
  const projection = ownField(data, 'projection');
  const portfolioAggregates = ownField(data, 'portfolioAggregates');
  const exposureSweep = ownField(data, 'exposureSweep');
  const status = ownField(record, 'status');
  const scope = ownField(record, 'scope');
  const authoritativeUnderlyings = isDenseArray(underlyings)
    ? new Set<string>(underlyings as string[])
    : null;
  const allowedModels = currentComputeAllowedModels(scope);
  const projectionObject = getObject(projection);
  if (!record
    || !data
    || !summary
    || !authoritativeUnderlyings
    || !allowedModels
    || !projectionObject
    || ownField(data, 'syncSchemaVersion') !== 2
    || ownField(data, 'runSchemaVersion') !== 2
    || ownField(summary, 'engineVersion') !== CURRENT_COMPUTE_ENGINE_VERSION
    || typeof ownField(summary, 'inputHash') !== 'string'
    || !CURRENT_COMPUTE_INPUT_HASH_PATTERN.test(ownField(summary, 'inputHash') as string)
    || typeof ownField(record, 'run_key') !== 'string'
    || (ownField(record, 'run_key') as string).trim().length === 0
    || (scope !== 'core' && scope !== 'full')
    || (ownField(record, 'quality') !== 'balanced' && ownField(record, 'quality') !== 'precise')
    || typeof status !== 'string'
    || !TERMINAL_COMPUTE_STATUSES.has(status)
    || !isFiniteNumber(ownField(record, 'timestamp'))
    || (ownField(summary, 'completionState') !== 'complete'
      && ownField(summary, 'completionState') !== 'partial')
    || !isFiniteNumber(ownField(summary, 'valuationTime'))
    || !hasCurrentExecutionConfigShape(ownField(summary, 'executionConfig'))
    || !isFiniteNumber(ownField(summary, 'completedAt'))
    || !isNonNegativeSafeInteger(ownField(summary, 'totalPositions'))
    || (ownField(summary, 'totalPositions') as number) < 1
    || !isNonNegativeSafeInteger(ownField(summary, 'totalModelRuns'))
    || !isNonNegativeSafeInteger(ownField(summary, 'totalCalibrations'))
    || !isFiniteNumber(ownField(summary, 'executionTimeMs'))
    || (ownField(summary, 'executionTimeMs') as number) < 0
    || !isNonNegativeSafeInteger(ownField(summary, 'errorCount'))
    || !isNonNegativeSafeInteger(ownField(summary, 'includedErrorCount'))
    || typeof ownField(summary, 'errorsTruncated') !== 'boolean'
    || !isDenseArray(positions)
    || !positions.every(position => hasCurrentPositionShape(position, scope))
    || !isDenseArray(underlyings)
    || underlyings.length < 1
    || !underlyings.every(hasCanonicalUnderlying)
    || underlyings.some((item, index) => (
      index > 0 && (underlyings[index - 1] as string) >= (item as string)
    ))
    || positions.some((positionValue) => {
      const position = getObject(positionValue);
      const underlying = ownField(position, 'underlying');
      return typeof underlying !== 'string' || !authoritativeUnderlyings.has(underlying);
    })
    || !isDenseArray(errors)
    || errors.length > COMPUTE_SYNC_ERROR_LIMIT
    || !errors.every(error => hasCurrentErrorShape(error, authoritativeUnderlyings))
    || ownField(summary, 'includedErrorCount') !== errors.length
    || (ownField(summary, 'errorCount') as number) < errors.length
    || ((ownField(summary, 'errorCount') as number) > 0 && errors.length === 0)
    || ownField(summary, 'errorsTruncated')
      !== ((ownField(summary, 'errorCount') as number) > errors.length)
    || !isDenseArray(modelExclusions)
    || modelExclusions.length > 100
    || !modelExclusions.every(exclusion => (
      hasCurrentModelExclusionShape(exclusion, allowedModels, authoritativeUnderlyings)
    ))
    || getValidOriginalModelExclusionCount(data, modelExclusions.length) === undefined
    || !hasCurrentPortfolioAggregateShape(
      portfolioAggregates,
      scope,
      ownField(summary, 'totalPositions') as number,
      ownField(projectionObject, 'compactionLevel'),
    )
    || !hasCurrentProjectionShape(projectionObject, positions)
    || (ownField(projectionObject, 'compactionLevel') === 'summary-only'
      ? hasOwn(data, 'exposureSweep')
      : (!hasOwn(data, 'exposureSweep')
        || !hasCurrentExposureSweepShape(exposureSweep, underlyings)))
    || ownField(summary, 'totalPositions') !== ownField(projectionObject, 'originalPositionCount')
    || !hasCurrentTerminalRunSemantics(status, scope, data, summary)) {
    return false;
  }
  return true;
}

function shapeAssistantExclusionFields(record: Record<string, unknown>): Record<string, unknown> {
  const data = getOwnObjectField(record, 'data');
  if (!data || !confidenceStrictness(record).current) return {};
  const summary = getOwnObjectField(data, 'summary');
  const rawTotalPositions = ownField(summary, 'totalPositions');
  const authoritativeExpected = typeof rawTotalPositions === 'number'
    && Number.isSafeInteger(rawTotalPositions)
    && rawTotalPositions > 0
    ? rawTotalPositions
    : null;
  const strictCurrent = requiresExactConfidenceMethod(record);
  const aggregates = getOwnObjectField(data, 'portfolioAggregates');
  const aggregateSource = materializeOwnArrayField(aggregates, 'exclusions');
  const modelSource = materializeOwnArrayField(data, 'modelExclusions');
  const out: Record<string, unknown> = {};

  if (aggregateSource !== undefined) {
    const eligible = aggregateSource.filter((entry) => !isExactDuplicateSourceBookkeeping(
      entry,
      authoritativeExpected,
      strictCurrent,
    ));
    out.aggregateExclusions = eligible.slice(0, MAX_ASSISTANT_EXCLUSIONS)
      .map(entry => shapeAggregateExclusion(entry, authoritativeExpected, strictCurrent));
    const omitted = eligible.length - Math.min(eligible.length, MAX_ASSISTANT_EXCLUSIONS);
    if (omitted > 0) out.aggregateExclusionsNotShown = omitted;
  }

  if (modelSource !== undefined) {
    const returned = modelSource.slice(0, MAX_ASSISTANT_EXCLUSIONS).map(shapeModelExclusion);
    out.modelExclusions = returned;
    const sourceTotal = getValidOriginalModelExclusionCount(data, modelSource.length) ?? modelSource.length;
    const omitted = sourceTotal - returned.length;
    if (omitted > 0) out.modelExclusionsNotShown = omitted;
  }

  return out;
}

const ASSISTANT_EXCLUSION_FIELD_NAMES = [
  'aggregateExclusions',
  'aggregateExclusionsNotShown',
  'modelExclusions',
  'modelExclusionsNotShown',
] as const;
type TrustedAssistantExclusionState = {
  data: Record<string, unknown>;
  inputHash: string;
  fields: Record<string, unknown>;
};
const TRUSTED_ASSISTANT_EXCLUSIONS_BY_RECORD = new WeakMap<object, TrustedAssistantExclusionState>();

function cloneAssistantExclusionFields(fields: Record<string, unknown>): Record<string, unknown> {
  const clone: Record<string, unknown> = {};
  for (const key of ASSISTANT_EXCLUSION_FIELD_NAMES) {
    const value = fields[key];
    if (Array.isArray(value)) {
      clone[key] = value.map((entry) => {
        const objectEntry = getObject(entry);
        return objectEntry ? { ...objectEntry } : entry;
      });
    } else if (value !== undefined) {
      clone[key] = value;
    }
  }
  return clone;
}

function hasOwnAssistantExclusionSource(data: Record<string, unknown>): boolean {
  const aggregates = getOwnObjectField(data, 'portfolioAggregates');
  return hasOwn(data, 'modelExclusions') || (aggregates != null && hasOwn(aggregates, 'exclusions'));
}

type AssistantExclusionDiscovery = {
  objects: object[];
  trustedFieldsByRecord: WeakMap<object, Record<string, unknown>>;
};

/** Snapshot every canonical projection before the mutation pass can delete a
 * shared/aliased data source. Cross-call trust is deliberately record-scoped:
 * sharing a previously sanitized data object with a new record never transfers
 * assistant-facing reasons to that record. */
function discoverAssistantExclusionFields(value: object): AssistantExclusionDiscovery {
  const objects: object[] = [];
  const trustedFieldsByRecord = new WeakMap<object, Record<string, unknown>>();
  const visited = new WeakSet<object>();
  const stack: object[] = [value];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    objects.push(current);

    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const data = getOwnObjectField(record, 'data');
      const summary = getOwnObjectField(data, 'summary');
      const inputHash = ownField(summary, 'inputHash');
      if (!data || !confidenceStrictness(record).current || typeof inputHash !== 'string') {
        TRUSTED_ASSISTANT_EXCLUSIONS_BY_RECORD.delete(record);
      } else if (hasOwnAssistantExclusionSource(data)) {
        const freshFields = cloneAssistantExclusionFields(shapeAssistantExclusionFields(record));
        trustedFieldsByRecord.set(record, freshFields);
        TRUSTED_ASSISTANT_EXCLUSIONS_BY_RECORD.set(record, {
          data,
          inputHash,
          fields: cloneAssistantExclusionFields(freshFields),
        });
      } else {
        const cached = TRUSTED_ASSISTANT_EXCLUSIONS_BY_RECORD.get(record);
        if (cached?.data === data && cached.inputHash === inputHash) {
          trustedFieldsByRecord.set(record, cloneAssistantExclusionFields(cached.fields));
        } else {
          // A different data identity is record reuse, not an idempotent second
          // pass. Forget the old projection so switching back cannot revive it.
          TRUSTED_ASSISTANT_EXCLUSIONS_BY_RECORD.delete(record);
        }
      }
    }

    for (const child of Object.values(current)) {
      if (child != null && typeof child === 'object') stack.push(child);
    }
  }

  return { objects, trustedFieldsByRecord };
}

function liftAssistantExclusionFields(
  record: Record<string, unknown>,
  trustedFieldsByRecord: WeakMap<object, Record<string, unknown>>,
): void {
  for (const key of ASSISTANT_EXCLUSION_FIELD_NAMES) delete record[key];

  const trustedFields = trustedFieldsByRecord.get(record);
  if (!trustedFields) return;
  Object.assign(record, cloneAssistantExclusionFields(trustedFields));
}

function compactMetricValue(value: unknown): number | Record<string, unknown> | undefined {
  if (typeof value === 'number') return round(value, 6);

  const asObj = getObject(value);
  if (!asObj || typeof asObj.value !== 'number') return undefined;

  const next: Record<string, unknown> = {};
  if (typeof asObj.stdError === 'number') next.stdError = round(asObj.stdError, 6);
  if (typeof asObj.ciLow === 'number') next.ciLow = round(asObj.ciLow, 6);
  if (typeof asObj.ciHigh === 'number') next.ciHigh = round(asObj.ciHigh, 6);
  if (Object.keys(next).length === 0) return round(asObj.value, 6);
  next.value = round(asObj.value, 6);
  return next;
}

function numericMetricValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const metric = getObject(value);
  return typeof metric?.value === 'number' && Number.isFinite(metric.value) ? metric.value : undefined;
}

function summarizeNumericValues(values: number[]): Record<string, number> | undefined {
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) return undefined;
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  const mean = finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
  return { min: round(min, 6)!, max: round(max, 6)!, mean: round(mean, 6)! };
}

function compactGreekMap(value: unknown): Record<string, unknown> | undefined {
  const source = getObject(value);
  if (!source) return undefined;

  const compact = Object.fromEntries(
    Object.entries(source)
      .map(([greek, greekValue]) => [greek, compactMetricValue(greekValue)])
      .filter(([, greekValue]) => greekValue !== undefined),
  );

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function compactCalibrationParams(value: unknown): Record<string, unknown> | undefined {
  const params = getObject(value);
  if (!params) return undefined;

  const compact = Object.fromEntries(
    Object.entries(params)
      .filter(([, paramValue]) => (
        paramValue == null
        || typeof paramValue === 'string'
        || typeof paramValue === 'boolean'
        || (typeof paramValue === 'number' && Number.isFinite(paramValue))
      ))
      .filter(([key]) => key !== 'seed' && key !== 'randomSeed')
      .map(([key, paramValue]) => [
        key,
        typeof paramValue === 'number' ? round(paramValue, 6) : paramValue,
      ]),
  );

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function shapeCalibrationConfidenceSemantics(
  value: unknown,
  confidence: unknown,
  modelName?: string,
  strictness: ConfidenceStrictness = { current: false },
): Record<string, unknown> | undefined {
  if (typeof confidence !== 'number'
    || !Number.isFinite(confidence)
    || confidence < 0
    || confidence > 100) return undefined;

  const semantics = getObject(value);
  const explicitMethod = semantics && hasOwn(semantics, 'method') && typeof semantics.method === 'string'
    ? semantics.method
    : undefined;
  const protectedModelId = modelName === undefined ? null : protectedCalibrationModelId(modelName);
  const exactRule = protectedModelId == null ? undefined : EXACT_CONFIDENCE_RULES[protectedModelId];
  const requireExactMethod = exactConfidenceRequired(protectedModelId, strictness);
  const methodMatchesModel = explicitMethod === 'heston-quality-v1'
    ? protectedModelId === null
      || protectedModelId === 'Heston'
      || protectedModelId === 'MonteCarlo-Heston'
    : explicitMethod === 'sabr-quality-v1'
      ? protectedModelId === null || protectedModelId === 'SABR'
      : explicitMethod === 'unified-jump-selection-v1'
        ? protectedModelId === null || protectedModelId === 'JumpDiffusion'
        : explicitMethod === 'variance-gamma-quality-v1'
          ? protectedModelId === null || protectedModelId === 'VarianceGamma'
          : true;
  const hasCanonicalProtectedName = protectedModelId === null
    || modelName === protectedModelId
    || (strictness.allowSanitizedDisplayIds === true
      && modelName === modelDisplayName(protectedModelId));
  const expectedLabel = explicitMethod === 'unified-jump-selection-v1'
    ? WITHIN_FAMILY_CONFIDENCE_LABEL
    : MODEL_SPECIFIC_CONFIDENCE_LABEL;
  if (semantics
    && ['label', 'method', 'scale', 'crossModelComparable'].every(key => hasOwn(semantics, key))
    && semantics.label === expectedLabel
    && explicitMethod !== undefined
    && CALIBRATION_CONFIDENCE_METHODS.has(explicitMethod)
    && methodMatchesModel
    && (!requireExactMethod || explicitMethod === exactRule?.method)
    && (!requireExactMethod || hasCanonicalProtectedName)
    && semantics.scale === CALIBRATION_CONFIDENCE_SCALE
    && semantics.crossModelComparable === false) {
    return {
      label: expectedLabel,
      method: explicitMethod,
      scale: CALIBRATION_CONFIDENCE_SCALE,
      crossModelComparable: false,
    };
  }
  return undefined;
}

function confidenceStrictness(record: Record<string, unknown>): ConfidenceStrictness {
  const data = getOwnObjectField(record, 'data');
  const summary = getOwnObjectField(data, 'summary');
  return {
    current: ownField(data, 'syncSchemaVersion') === 2
      && ownField(data, 'runSchemaVersion') === 2
      && ownField(summary, 'engineVersion') === CURRENT_COMPUTE_ENGINE_VERSION
      && typeof ownField(summary, 'inputHash') === 'string'
      && CURRENT_COMPUTE_INPUT_HASH_PATTERN.test(ownField(summary, 'inputHash') as string),
  };
}

function requiresExactConfidenceMethod(record: Record<string, unknown>): boolean {
  return confidenceStrictness(record).current;
}

type StrictConfidenceBindingKind = 'model-map' | 'outcome-detail' | 'array-model';

interface StrictConfidenceBinding {
  kind: StrictConfidenceBindingKind;
  owner: Record<string, unknown>;
  modelName: string;
  calibration: Record<string, unknown>;
}

interface StrictConfidenceCandidateFingerprint {
  object: Record<string, unknown>;
  hasConfidence: boolean;
  confidence: unknown;
  hasSemantics: boolean;
  semantics: unknown;
  label: unknown;
  method: unknown;
  scale: unknown;
  crossModelComparable: unknown;
}

interface StrictConfidenceGraphFingerprint {
  objects: object[];
  bindings: StrictConfidenceBinding[];
  candidates: StrictConfidenceCandidateFingerprint[];
}

interface StrictConfidenceGraphInspection {
  fingerprint: StrictConfidenceGraphFingerprint;
  candidates: Set<Record<string, unknown>>;
  unboundCandidates: Set<Record<string, unknown>>;
  bindingsByCalibration: Map<Record<string, unknown>, StrictConfidenceBinding[]>;
}

interface StrictConfidenceRecordContext {
  record: Record<string, unknown>;
  strictness: ConfidenceStrictness;
  allowSanitizedDisplayIds: boolean;
  inspection: StrictConfidenceGraphInspection;
}

interface StrictConfidenceTrustState {
  fingerprint: StrictConfidenceGraphFingerprint;
  syncSchemaVersion: unknown;
  runSchemaVersion: unknown;
  engineVersion: unknown;
  inputHash: unknown;
}

/** Full-mode model maps are renamed in place for assistant readability. Keep
 * cross-call trust record-scoped and tied to the exact reachable object graph,
 * so a raw row using display ids never inherits another row's sanitized state. */
const TRUSTED_STRICT_CONFIDENCE_BY_RECORD = new WeakMap<object, StrictConfidenceTrustState>();

function strictConfidenceTrustDiscriminator(record: Record<string, unknown>): {
  syncSchemaVersion: unknown;
  runSchemaVersion: unknown;
  engineVersion: unknown;
  inputHash: unknown;
} {
  const data = getOwnObjectField(record, 'data');
  const summary = getOwnObjectField(data, 'summary');
  return {
    syncSchemaVersion: ownField(data, 'syncSchemaVersion'),
    runSchemaVersion: ownField(data, 'runSchemaVersion'),
    engineVersion: ownField(summary, 'engineVersion'),
    inputHash: ownField(summary, 'inputHash'),
  };
}

function hasCalibrationConfidenceField(value: Record<string, unknown>): boolean {
  return hasOwn(value, 'confidence') || hasOwn(value, 'confidenceSemantics');
}

function looksCalibrationShaped(value: Record<string, unknown>): boolean {
  return hasOwn(value, 'confidenceSemantics')
    || ['params', 'rmse', 'expirationDate', 'isFallback', 'warnings', 'executionPath']
      .some(key => hasOwn(value, key));
}

function inspectStrictConfidenceGraph(record: Record<string, unknown>): StrictConfidenceGraphInspection {
  const objects: object[] = [];
  const visited = new WeakSet<object>();
  const stack: object[] = [record];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    objects.push(current);
    const children = Object.values(current);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child != null && typeof child === 'object') stack.push(child);
    }
  }

  const candidates = new Set<Record<string, unknown>>();
  const unboundCandidates = new Set<Record<string, unknown>>();
  const bindings: StrictConfidenceBinding[] = [];
  const bindingsByCalibration = new Map<Record<string, unknown>, StrictConfidenceBinding[]>();
  const allowedEdges = new Map<object, Set<string>>();

  const addCandidate = (value: Record<string, unknown>): void => {
    if (hasCalibrationConfidenceField(value)) candidates.add(value);
  };
  const addBinding = (
    kind: StrictConfidenceBindingKind,
    owner: Record<string, unknown>,
    edge: 'calibration' | 'detail',
    modelName: string,
    calibration: Record<string, unknown>,
  ): void => {
    const binding = { kind, owner, modelName, calibration };
    bindings.push(binding);
    const existing = bindingsByCalibration.get(calibration);
    if (existing) existing.push(binding);
    else bindingsByCalibration.set(calibration, [binding]);
    const edges = allowedEdges.get(owner) ?? new Set<string>();
    edges.add(edge);
    allowedEdges.set(owner, edges);
    addCandidate(calibration);
  };

  for (const current of objects) {
    if (Array.isArray(current)) continue;
    const object = current as Record<string, unknown>;
    if (hasCalibrationConfidenceField(object) && looksCalibrationShaped(object)) {
      candidates.add(object);
    }

    const models = getOwnObjectField(object, 'models');
    if (models) {
      for (const [modelName, modelValue] of Object.entries(models)) {
        const model = getObject(modelValue);
        const calibration = getOwnObjectField(model, 'calibration');
        if (model && calibration) {
          addBinding('model-map', model, 'calibration', modelName, calibration);
        }
        const calibrationSummary = getOwnObjectField(model, 'calibrationSummary');
        if (calibrationSummary && hasCalibrationConfidenceField(calibrationSummary)) {
          addCandidate(calibrationSummary);
        }
      }
    }

    const modelName = typeof ownField(object, 'model') === 'string'
      ? ownField(object, 'model') as string
      : null;
    if (modelName != null) {
      const detail = getOwnObjectField(object, 'detail');
      if (detail) addBinding('outcome-detail', object, 'detail', modelName, detail);
      const calibration = getOwnObjectField(object, 'calibration');
      if (calibration) addBinding('array-model', object, 'calibration', modelName, calibration);
      const calibrationSummary = getOwnObjectField(object, 'calibrationSummary');
      if (calibrationSummary && hasCalibrationConfidenceField(calibrationSummary)) {
        addCandidate(calibrationSummary);
      }
    }

    for (const [key, child] of Object.entries(object)) {
      const childObject = getObject(child);
      if (childObject
        && (key === 'calibration' || key === 'calibrationSummary')
        && hasCalibrationConfidenceField(childObject)) {
        candidates.add(childObject);
      }
    }
  }

  if (candidates.has(record)) unboundCandidates.add(record);
  for (const current of objects) {
    for (const [key, child] of Object.entries(current)) {
      const childObject = getObject(child);
      if (!childObject || !candidates.has(childObject)) continue;
      if (!allowedEdges.get(current)?.has(key)) unboundCandidates.add(childObject);
    }
  }
  for (const candidate of candidates) {
    if (!bindingsByCalibration.has(candidate)) unboundCandidates.add(candidate);
  }

  const candidateFingerprints = Array.from(candidates, (candidate) => {
    const semantics = getObject(candidate.confidenceSemantics);
    return {
      object: candidate,
      hasConfidence: hasOwn(candidate, 'confidence'),
      confidence: candidate.confidence,
      hasSemantics: hasOwn(candidate, 'confidenceSemantics'),
      semantics: candidate.confidenceSemantics,
      label: semantics?.label,
      method: semantics?.method,
      scale: semantics?.scale,
      crossModelComparable: semantics?.crossModelComparable,
    };
  });

  return {
    fingerprint: { objects, bindings, candidates: candidateFingerprints },
    candidates,
    unboundCandidates,
    bindingsByCalibration,
  };
}

function sameStrictConfidenceFingerprint(
  left: StrictConfidenceGraphFingerprint | undefined,
  right: StrictConfidenceGraphFingerprint,
): boolean {
  if (!left
    || left.objects.length !== right.objects.length
    || left.bindings.length !== right.bindings.length
    || left.candidates.length !== right.candidates.length) return false;
  for (let index = 0; index < left.objects.length; index += 1) {
    if (left.objects[index] !== right.objects[index]) return false;
  }
  for (let index = 0; index < left.bindings.length; index += 1) {
    const a = left.bindings[index];
    const b = right.bindings[index];
    if (a.kind !== b.kind
      || a.owner !== b.owner
      || a.modelName !== b.modelName
      || a.calibration !== b.calibration) return false;
  }
  for (let index = 0; index < left.candidates.length; index += 1) {
    const a = left.candidates[index];
    const b = right.candidates[index];
    if (a.object !== b.object
      || a.hasConfidence !== b.hasConfidence
      || !Object.is(a.confidence, b.confidence)
      || a.hasSemantics !== b.hasSemantics
      || a.semantics !== b.semantics
      || !Object.is(a.label, b.label)
      || !Object.is(a.method, b.method)
      || !Object.is(a.scale, b.scale)
      || !Object.is(a.crossModelComparable, b.crossModelComparable)) return false;
  }
  return true;
}

function sameStrictConfidenceTrustState(
  cached: StrictConfidenceTrustState | undefined,
  record: Record<string, unknown>,
  fingerprint: StrictConfidenceGraphFingerprint,
): boolean {
  if (!cached) return false;
  const discriminator = strictConfidenceTrustDiscriminator(record);
  return Object.is(cached.syncSchemaVersion, discriminator.syncSchemaVersion)
    && Object.is(cached.runSchemaVersion, discriminator.runSchemaVersion)
    && Object.is(cached.engineVersion, discriminator.engineVersion)
    && Object.is(cached.inputHash, discriminator.inputHash)
    && sameStrictConfidenceFingerprint(cached.fingerprint, fingerprint);
}

type StrictConfidenceDecision =
  | { kind: 'skip' }
  | { kind: 'keep' }
  | { kind: 'normalize'; semantics: Record<string, unknown> }
  | { kind: 'strip' };

function strictConfidenceDecision(
  binding: StrictConfidenceBinding,
  context: StrictConfidenceRecordContext,
): StrictConfidenceDecision {
  const { calibration, modelName } = binding;
  const protectedModelId = protectedCalibrationModelId(modelName);
  const independentMerton = protectedModelId === 'MonteCarlo-JumpDiffusion'
    && context.strictness.current;
  const requiresExactPair = exactConfidenceRequired(protectedModelId, context.strictness);
  if (!independentMerton && !requiresExactPair) return { kind: 'skip' };

  const allowDisplayId = binding.kind === 'model-map' && context.allowSanitizedDisplayIds;
  const canonicalModelId = protectedModelId != null && (
    modelName === protectedModelId
    || (allowDisplayId && modelName === modelDisplayName(protectedModelId))
  );
  if (!canonicalModelId || !hasOwn(calibration, 'confidence')) return { kind: 'strip' };

  const hasSemantics = hasOwn(calibration, 'confidenceSemantics');
  if (calibration.confidence === null) {
    return hasSemantics ? { kind: 'strip' } : { kind: 'keep' };
  }
  if (independentMerton
    || typeof calibration.confidence !== 'number'
    || !Number.isFinite(calibration.confidence)
    || calibration.confidence < 0
    || calibration.confidence > 100) return { kind: 'strip' };

  const semantics = shapeCalibrationConfidenceSemantics(
    calibration.confidenceSemantics,
    calibration.confidence,
    modelName,
    {
      ...context.strictness,
      allowSanitizedDisplayIds: allowDisplayId,
    },
  );
  return semantics ? { kind: 'normalize', semantics } : { kind: 'strip' };
}

function sanitizeStrictConfidenceMetadata(contexts: StrictConfidenceRecordContext[]): void {
  const strip = new Set<Record<string, unknown>>();
  const normalized = new Map<Record<string, unknown>, Record<string, unknown>>();

  for (const context of contexts) {
    const { inspection } = context;
    for (const calibration of inspection.candidates) {
      if (inspection.unboundCandidates.has(calibration)) {
        strip.add(calibration);
        continue;
      }
      const bindings = inspection.bindingsByCalibration.get(calibration);
      if (!bindings || bindings.length === 0) {
        continue;
      }
      for (const binding of bindings) {
        const decision = strictConfidenceDecision(binding, context);
        if (decision.kind === 'strip') strip.add(calibration);
        else if (decision.kind === 'normalize') normalized.set(calibration, decision.semantics);
      }
    }
  }

  for (const calibration of strip) {
    delete calibration.confidence;
    delete calibration.confidenceSemantics;
  }
  for (const [calibration, semantics] of normalized) {
    if (!strip.has(calibration)) calibration.confidenceSemantics = semantics;
  }
}

function shapeCalibrationSummary(
  value: unknown,
  modelName: string,
  strictness: ConfidenceStrictness,
): Record<string, unknown> | undefined {
  const calibration = getObject(value);
  if (!calibration) return undefined;

  // The current producer emits only `failureReason`; obsolete aliases are denylisted below and must
  // never be interpreted into assistant-facing semantics.
  const statusReason = humanizeIdentifier(calibration.failureReason);
  const confidenceSemantics = shapeCalibrationConfidenceSemantics(
    calibration.confidenceSemantics,
    calibration.confidence,
    modelName,
    strictness,
  );
  const protectedModelId = protectedCalibrationModelId(modelName);
  const isIndependentMerton = protectedModelId === 'MonteCarlo-JumpDiffusion'
    && strictness.current;
  const confidence = isIndependentMerton
    || (exactConfidenceRequired(protectedModelId, strictness) && !confidenceSemantics)
    ? undefined
    : round(calibration.confidence, 4);
  return {
    rmse: round(calibration.rmse, 6),
    confidence,
    ...(!isIndependentMerton && confidenceSemantics ? { confidenceSemantics } : {}),
    ...(calibration.isFallback === true ? { status: FALLBACK_STATUS } : {}),
    ...(calibration.isFallback === true && statusReason ? { statusReason } : {}),
    expirationDate: typeof calibration.expirationDate === 'string' ? calibration.expirationDate : undefined,
    params: compactCalibrationParams(calibration.params),
    warnings: getArray<string>(calibration.warnings).filter((warning) => typeof warning === 'string').slice(0, 5),
  };
}

/** Rename camelCase wall/flip/tilt keys to space-separated equivalents so the
 *  LLM doesn't surface backend identifiers (callWall, gammaTilt, etc.) verbatim
 *  in user-facing summaries. */
function shapeKeyLevels(value: unknown): Record<string, unknown> | undefined {
  const levels = getObject(value);
  if (!levels) return undefined;
  const KEY_MAP: Record<string, string> = {
    callWall: 'call wall',
    putWall: 'put wall',
    gammaFlip: 'gamma flip',
    absGamma: 'abs gamma',
    gammaTilt: 'gamma tilt',
    secondaryFlips: 'secondary flips',
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(levels)) {
    out[KEY_MAP[k] ?? k] = v;
  }
  return out;
}

/** Sanitize raw/full compute-run payloads at the MCP boundary. Full mode still
 *  returns the raw row structure, but backend identifiers that LLMs repeat as
 *  prose (`isFallback`, `callWall`, `gammaFlip`, etc.) are rewritten first. */
function sanitizeComputeRunsWireObject(
  obj: Record<string, unknown>,
  trustedFieldsByRecord: WeakMap<object, Record<string, unknown>>,
): void {
  // Lift only from the canonical nested v2 sources before the recursive pass
  // deletes the large portfolio aggregate object. The dispersion `excluded` diagnostic remains a
  // separate dispersion diagnostic and never feeds aggregateExclusions.
  liftAssistantExclusionFields(obj, trustedFieldsByRecord);

  if (Array.isArray(obj.errors)) {
    const shapedErrors = shapeRunErrors(obj.errors);
    if (shapedErrors.errors) obj.errors = shapedErrors.errors;
    else delete obj.errors;
    if (shapedErrors.errorsNotShown !== undefined) obj.errorsNotShown = shapedErrors.errorsNotShown;
    if (shapedErrors.errorsMeta !== undefined) obj.errorsMeta = shapedErrors.errorsMeta;
  }
  const DROP_KEYS = new Set([
    'portfolioAggregates',
    'seedRejections',
    'executionPath',
    'economicPenalty',
    'byReason',
    'runKey',
    'latestRunKey',
    'seed',
    'randomSeed',
    'key',
    'representative',
    'alternates',
  ]);

  delete obj.run_key;

  for (const key of DROP_KEYS) {
    delete obj[key];
  }

  if ('keyLevels' in obj) {
    const shaped = shapeKeyLevels(obj.keyLevels);
    if (shaped) obj.levels = shaped;
    delete obj.keyLevels;
  }
  if ('models' in obj) {
    if (Array.isArray(obj.models)) {
      obj.models = obj.models.map((item) => (
        typeof item === 'string' ? modelDisplayName(item) : item
      ));
    } else {
      const rawModels = getObject(obj.models);
      if (rawModels) {
        for (const [modelName, modelValue] of Object.entries(rawModels)) {
          const model = getObject(modelValue);
          const calibration = getObject(model?.calibration);
          if (!calibration || !hasOwn(calibration, 'confidenceSemantics')) continue;
          const confidenceSemantics = shapeCalibrationConfidenceSemantics(
            calibration.confidenceSemantics,
            calibration.confidence,
            modelName,
          );
          if (confidenceSemantics) calibration.confidenceSemantics = confidenceSemantics;
          else delete calibration.confidenceSemantics;
        }
      }
      const shaped = displayNameModelMap(obj.models);
      if (shaped) obj.models = shaped;
    }
  }
  // Idempotent: also recognize the already-sanitized FALLBACK_STATUS so a
  // second pass on the same object (e.g., when callers share a calibration
  // ref across positions) doesn't drop a previously-set statusReason via
  // the else branch below.
  const isFallbackTriggered = obj.isFallback === true
    || obj.status === 'fallback'
    || obj.status === FALLBACK_STATUS;
  const isCalibrationObject = hasOwn(obj, 'confidence') && (
    hasOwn(obj, 'confidenceSemantics')
    || hasOwn(obj, 'isFallback')
    || (hasOwn(obj, 'params') && (hasOwn(obj, 'rmse') || hasOwn(obj, 'expirationDate')))
  );
  if (isCalibrationObject) {
    const confidenceSemantics = shapeCalibrationConfidenceSemantics(
      obj.confidenceSemantics,
      obj.confidence,
    );
    if (confidenceSemantics) obj.confidenceSemantics = confidenceSemantics;
    else delete obj.confidenceSemantics;
  }
  if (isFallbackTriggered) {
    obj.status = FALLBACK_STATUS;
    const reason = humanizeIdentifier(obj.failureReason)
      ?? humanizeIdentifier(obj.statusReason);
    if (reason) obj.statusReason = reason;
    else delete obj.statusReason;
  } else {
    delete obj.statusReason;
  }
  delete obj.isFallback;
  delete obj.fallback;
  delete obj.fallbackReason;
  // The canonical backend field is `failureReason`; strip its raw snake_case code so it never
  // leaks into LLM-facing full-mode output (it's surfaced humanized via statusReason above).
  delete obj.failureReason;
}

export function sanitizeComputeRunsWireOutput(value: unknown): void {
  if (value == null || typeof value !== 'object') return;

  const { objects, trustedFieldsByRecord } = discoverAssistantExclusionFields(value);
  const strictConfidenceContexts: StrictConfidenceRecordContext[] = [];
  for (const current of objects) {
    if (!Array.isArray(current)) {
      const record = current as Record<string, unknown>;
      const strictness = confidenceStrictness(record);
      if (strictness.current) {
        const inspection = inspectStrictConfidenceGraph(record);
        strictConfidenceContexts.push({
          record,
          strictness,
          allowSanitizedDisplayIds: sameStrictConfidenceTrustState(
            TRUSTED_STRICT_CONFIDENCE_BY_RECORD.get(record),
            record,
            inspection.fingerprint,
          ),
          inspection,
        });
      } else {
        TRUSTED_STRICT_CONFIDENCE_BY_RECORD.delete(record);
      }
    }
  }
  // Decide every context before mutation. If one calibration object is shared
  // by valid and invalid locations, the invalid reference wins conservatively.
  sanitizeStrictConfidenceMetadata(strictConfidenceContexts);
  // Seed the mutation walk with every object observed before mutation. This
  // sanitizes detached aliases too; children created by shaping are appended
  // during the walk and receive the same four-field purge.
  const stack: object[] = [...objects].reverse();
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      const arrayRecord = current as unknown as Record<string, unknown>;
      for (const key of ASSISTANT_EXCLUSION_FIELD_NAMES) delete arrayRecord[key];
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const child = current[index];
        if (child != null && typeof child === 'object') stack.push(child);
      }
      continue;
    }

    const obj = current as Record<string, unknown>;
    sanitizeComputeRunsWireObject(obj, trustedFieldsByRecord);

    for (const child of Object.values(obj)) {
      if (child != null && typeof child === 'object') {
        stack.push(child);
      }
    }
  }

  for (const { record } of strictConfidenceContexts) {
    const strictness = confidenceStrictness(record);
    if (strictness.current) {
      const discriminator = strictConfidenceTrustDiscriminator(record);
      TRUSTED_STRICT_CONFIDENCE_BY_RECORD.set(record, {
        fingerprint: inspectStrictConfidenceGraph(record).fingerprint,
        ...discriminator,
      });
    } else {
      TRUSTED_STRICT_CONFIDENCE_BY_RECORD.delete(record);
    }
  }
}

function getVariantPriority(value: unknown): number {
  const variant = getObject(value);
  if (!variant) return 0;

  let score = 0;
  if (typeof variant.error !== 'string') score += 100;

  const dimensions = getObject(variant.dimensions);
  if (dimensions?.exerciseStyle === 'european') score += 40;

  const beta = typeof dimensions?.beta === 'number' ? dimensions.beta : undefined;
  if (beta == null) {
    score += 20;
  } else {
    score += Math.max(0, 20 - Math.abs(beta - 1) * 20);
  }

  return score;
}

function getCanonicalVariants(model: Record<string, unknown>): Record<string, unknown>[] {
  return [...getArray<Record<string, unknown>>(model.variants)]
    .filter((variant) => variant != null && typeof variant === 'object' && !Array.isArray(variant))
    .sort((left, right) => getVariantPriority(right) - getVariantPriority(left));
}

function shapePrimaryVariantSummary(value: unknown): Record<string, unknown> | undefined {
  const variant = getObject(value);
  if (!variant) return undefined;

  const summary: Record<string, unknown> = {
    price: compactMetricValue(variant.price),
    greeks: compactGreekMap(variant.greeks),
    dimensions: getObject(variant.dimensions) ?? undefined,
  };

  if (typeof variant.error === 'string') {
    summary.error = variant.error;
  }
  return Object.fromEntries(
    Object.entries(summary).filter(([, fieldValue]) => fieldValue !== undefined),
  );
}

function shapeModelSummary(
  value: unknown,
  modelName: string,
  strictness: ConfidenceStrictness,
): Record<string, unknown> | undefined {
  const model = getObject(value);
  if (!model) return undefined;

  const canonicalVariants = getCanonicalVariants(model);
  const primaryVariant = shapePrimaryVariantSummary(canonicalVariants[0]);
  const alternateCount = Math.max(0, canonicalVariants.length - (primaryVariant ? 1 : 0));
  const explicitVariantCount = typeof model.variantCount === 'number'
    ? model.variantCount
    : undefined;
  const variantCount = explicitVariantCount !== undefined
    ? explicitVariantCount
    : canonicalVariants.length;
  const summary: Record<string, unknown> = {
    variantCount: variantCount > 0 || explicitVariantCount === 0 ? variantCount : undefined,
    alternateCount,
    ...(typeof model.variantsTruncated === 'boolean' ? { variantsTruncated: model.variantsTruncated } : {}),
  };

  if (primaryVariant) {
    summary.price = primaryVariant.price;
    summary.greeks = primaryVariant.greeks;
    summary.dimensions = primaryVariant.dimensions;
    summary.error = primaryVariant.error;
  }

  const calibration = shapeCalibrationSummary(
    model.calibration,
    modelName,
    strictness,
  );
  if (calibration) summary.calibrationSummary = calibration;

  if (model.earlyExercisePremium && getObject(model.earlyExercisePremium)) {
    summary.earlyExercisePremium = model.earlyExercisePremium;
  }

  return Object.fromEntries(
    Object.entries(summary).filter(([, fieldValue]) => fieldValue !== undefined),
  );
}

function getModelPriority(modelName: string, modelValue: Record<string, unknown>): number {
  let score = 0;
  const calibration = getObject(modelValue.calibrationSummary);
  const price = modelValue.price;
  const greeks = getObject(modelValue.greeks);

  if (calibration && calibration.status !== FALLBACK_STATUS) score += 100;
  if (price !== undefined) score += 40;
  if (greeks && Object.keys(greeks).length > 0) score += 20;

  const preferredOrder = [
    'BlackScholes',
    'Heston',
    'SABR',
    'JumpDiffusion',
    'VarianceGamma',
    'FFT',
    'PDE',
    'Binomial',
  ];
  const preferredIndex = preferredOrder.indexOf(modelName);
  if (preferredIndex !== -1) score += 15 - preferredIndex;

  const variantCount = typeof modelValue.variantCount === 'number' ? modelValue.variantCount : 0;
  score += Math.min(variantCount, 10);

  return score;
}

function getPositionSortValue(position: Record<string, unknown>): number {
  const marketPrice = typeof position.marketPrice === 'number' ? Math.abs(position.marketPrice) : 0;
  const quantity = typeof position.quantity === 'number' ? Math.abs(position.quantity) : 0;
  const multiplier = typeof position.multiplier === 'number' ? Math.abs(position.multiplier) : 1;
  return marketPrice * quantity * multiplier;
}

function shapePosition(
  position: Record<string, unknown>,
  maxModels: number | undefined,
  strictness: ConfidenceStrictness,
): Record<string, unknown> {
  const models = getObject(position.models) ?? {};
  const allShapedModels = Object.fromEntries(
    Object.entries(models)
      .map(([modelName, modelValue]) => [
        modelName,
        shapeModelSummary(modelValue, modelName, strictness),
      ])
      .filter(([, modelValue]) => modelValue != null),
  );
  const shapedModelEntries = Object.entries(allShapedModels);
  const limitedModelEntries = typeof maxModels === 'number' && maxModels > 0 && shapedModelEntries.length > maxModels
    ? [...shapedModelEntries]
        .sort((left, right) => getModelPriority(right[0], right[1] as Record<string, unknown>) - getModelPriority(left[0], left[1] as Record<string, unknown>))
        .slice(0, maxModels)
    : shapedModelEntries;
  const shapedModels = Object.fromEntries(
    limitedModelEntries.map(([modelName, modelValue]) => [modelDisplayName(modelName), modelValue]),
  );

  const calibratedModels = Object.entries(shapedModels)
    .filter(([, modelValue]) => getObject(modelValue)?.calibrationSummary && getObject(getObject(modelValue)?.calibrationSummary)?.status !== FALLBACK_STATUS)
    .map(([modelName]) => modelName);
  const symbol = typeof position.symbol === 'string' && position.symbol.trim().length > 0
    ? position.symbol
    : normalizeUnderlying(position.underlying);
  const modelsNotShown = Math.max(0, shapedModelEntries.length - limitedModelEntries.length);

  return {
    symbol,
    underlying: normalizeUnderlying(position.underlying),
    isCall: typeof position.isCall === 'boolean' ? position.isCall : undefined,
    strike: round(position.strike, 4),
    expiration: typeof position.expiration === 'string' ? position.expiration : undefined,
    daysToExpiry: typeof position.daysToExpiry === 'number' ? position.daysToExpiry : undefined,
    spot: round(position.spot, 4),
    iv: round(position.iv, 6),
    quantity: typeof position.quantity === 'number' ? position.quantity : undefined,
    multiplier: typeof position.multiplier === 'number' ? position.multiplier : undefined,
    marketPrice: round(position.marketPrice, 6),
    riskFreeRate: round(position.riskFreeRate, 6),
    dividendYield: round(position.dividendYield, 6),
    modelCount: shapedModelEntries.length,
    calibratedModels,
    models: shapedModels,
    ...(modelsNotShown > 0 ? { modelsNotShown } : {}),
  };
}

function shapePositionHighlight(
  position: Record<string, unknown>,
  maxModelPreview: number,
  strictness: ConfidenceStrictness,
): Record<string, unknown> {
  const models = getObject(position.models) ?? {};
  const modelSummaries = Object.entries(models)
    .map(([modelName, modelValue]) => {
      const summary = shapeModelSummary(modelValue, modelName, strictness);
      return summary && getObject(summary)
        ? { modelName, label: modelDisplayName(modelName), summary: summary as Record<string, unknown> }
        : null;
    })
    .filter((entry): entry is { modelName: string; label: string; summary: Record<string, unknown> } => entry != null)
    .sort((left, right) => getModelPriority(right.modelName, right.summary) - getModelPriority(left.modelName, left.summary));

  const successfulModelSummaries = modelSummaries.filter(
    (entry) => typeof entry.summary.error !== 'string',
  );

  const prices = successfulModelSummaries
    .map((entry) => numericMetricValue(entry.summary.price))
    .filter((value): value is number => value !== undefined);
  const greeksAvailable = Array.from(new Set(
    successfulModelSummaries.flatMap((entry) => Object.keys(getObject(entry.summary.greeks) ?? {})),
  ));
  const calibratedModelCount = modelSummaries.filter((entry) => {
    const calibration = getObject(entry.summary.calibrationSummary);
    return calibration && calibration.status !== FALLBACK_STATUS;
  }).length;
  const fallbackModelCount = modelSummaries.filter((entry) => {
    const calibration = getObject(entry.summary.calibrationSummary);
    return calibration?.status === FALLBACK_STATUS;
  }).length;
  const errorCount = modelSummaries.filter((entry) => typeof entry.summary.error === 'string').length;
  const symbol = typeof position.symbol === 'string' && position.symbol.trim().length > 0
    ? position.symbol
    : normalizeUnderlying(position.underlying);

  return {
    symbol,
    underlying: normalizeUnderlying(position.underlying),
    isCall: typeof position.isCall === 'boolean' ? position.isCall : undefined,
    strike: round(position.strike, 4),
    expiration: typeof position.expiration === 'string' ? position.expiration : undefined,
    daysToExpiry: typeof position.daysToExpiry === 'number' ? position.daysToExpiry : undefined,
    quantity: typeof position.quantity === 'number' ? position.quantity : undefined,
    multiplier: typeof position.multiplier === 'number' ? position.multiplier : undefined,
    marketPrice: round(position.marketPrice, 6),
    modelSummary: {
      modelCount: modelSummaries.length,
      modelsPreview: modelSummaries.slice(0, maxModelPreview).map((entry) => entry.label),
      calibratedModelCount,
      ...(fallbackModelCount > 0 ? { fallbackModelCount } : {}),
      ...(errorCount > 0 ? { errorCount } : {}),
      price: summarizeNumericValues(prices),
      ...(greeksAvailable.length > 0 ? { greeksAvailable } : {}),
    },
  };
}

function shapeExposureSweep(value: unknown): Array<Record<string, unknown>> | undefined {
  const sweep = getArray<Record<string, unknown>>(value)
    .filter((entry) => entry != null && typeof entry === 'object' && !Array.isArray(entry))
    .map((entry) => ({
      underlying: normalizeUnderlying(entry.underlying),
      spot: round(entry.spot, 4),
      strikeCount: typeof entry.strikeCount === 'number' ? entry.strikeCount : undefined,
      levels: shapeKeyLevels(entry.keyLevels),
      timestamp: asTimestamp(entry.timestamp),
      at: toIso(entry.timestamp),
    }));

  return sweep.length > 0 ? sweep : undefined;
}

function shapeDispersion(value: Record<string, unknown> | null): Record<string, unknown> | undefined {
  if (!value) return undefined;

  const shaped = Object.fromEntries(
    Object.entries(value).map(([greek, greekValue]) => {
      const dispersion = getObject(greekValue);
      if (!dispersion) return [greek, greekValue];
      return [greek, {
        min: round(dispersion.min, 4),
        max: round(dispersion.max, 4),
        mean: round(dispersion.mean, 4),
        stddev: round(dispersion.stddev, 4),
        models: modelDisplayNames(dispersion.models),
      }];
    }),
  );

  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

function shapeRunErrors(value: unknown): {
  errors?: Array<Record<string, unknown>>;
  errorsNotShown?: number;
  errorsMeta?: Record<string, number>;
} {
  const allErrors = getArray(value)
    .map((item): Record<string, unknown> | undefined => {
      if (typeof item === 'string') {
        const message = item.trim().length === 0
          ? { value: item, truncated: false }
          : boundString(item, MAX_ERROR_MESSAGE_CHARS);
        return {
          message: message.value,
          ...(message.truncated ? { truncatedFields: ['message'] } : {}),
        };
      }
      const error = getObject(item);
      if (!error) return undefined;
      const rawMessage = typeof error.error === 'string'
        ? error.error
        : typeof error.message === 'string'
          ? error.message
          : undefined;
      if (rawMessage === undefined) return undefined;

      const rawModel = typeof error.model === 'string' && error.model.length > 0
        ? modelDisplayName(error.model)
        : undefined;
      const message = rawMessage.trim().length === 0
        ? { value: rawMessage, truncated: false }
        : boundString(rawMessage, MAX_ERROR_MESSAGE_CHARS);
      const model = boundString(rawModel, MAX_ERROR_MODEL_CHARS);
      const code = boundString(error.code, MAX_ERROR_CODE_CHARS);
      const underlying = boundString(normalizeUnderlying(error.underlying), MAX_ERROR_UNDERLYING_CHARS);
      const expiration = boundString(error.expiration, MAX_ERROR_EXPIRATION_CHARS);
      const truncatedFields = [
        ['model', model.truncated],
        ['message', message.truncated],
        ['code', code.truncated],
        ['underlying', underlying.truncated],
        ['expiration', expiration.truncated],
      ].filter((entry) => entry[1]).map((entry) => entry[0]);

      return Object.fromEntries(Object.entries({
        model: model.value,
        message: message.value,
        code: code.value,
        underlying: underlying.value,
        expiration: expiration.value,
        truncatedFields: truncatedFields.length > 0 ? truncatedFields : undefined,
      }).filter(([, fieldValue]) => fieldValue !== undefined));
    })
    .filter((error): error is Record<string, unknown> => error !== undefined);

  if (allErrors.length === 0) return {};
  const errors = allErrors.slice(0, MAX_DEFAULT_ERRORS);
  const entriesWithTruncatedFields = errors.filter((error) => Array.isArray(error.truncatedFields)).length;
  const omitted = allErrors.length - errors.length;
  return {
    errors,
    ...(omitted > 0 ? { errorsNotShown: omitted } : {}),
    ...(omitted > 0 || entriesWithTruncatedFields > 0 ? {
      errorsMeta: {
        total: allErrors.length,
        returned: errors.length,
        omitted,
        entriesWithTruncatedFields,
      },
    } : {}),
  };
}

function shapeProjection(value: unknown): Record<string, unknown> | undefined {
  const projection = getObject(value);
  if (!projection) return undefined;

  const shaped = Object.fromEntries(Object.entries({
    schemaVersion: finiteNumberOrNull(projection.schemaVersion),
    compactionLevel: stringOrNull(projection.compactionLevel),
    originalPositionCount: finiteNumberOrNull(projection.originalPositionCount),
    includedPositionCount: finiteNumberOrNull(projection.includedPositionCount),
    positionsTruncated: booleanOrNull(projection.positionsTruncated),
    variantsTruncated: booleanOrNull(projection.variantsTruncated),
    exposureTruncated: booleanOrNull(projection.exposureTruncated),
    calibrationTruncated: booleanOrNull(projection.calibrationTruncated),
    earlyExercisePremiumTruncated: booleanOrNull(projection.earlyExercisePremiumTruncated),
    portfolioAggregatesTruncated: booleanOrNull(projection.portfolioAggregatesTruncated),
  }).filter(([, fieldValue]) => fieldValue !== undefined));

  return Object.keys(shaped).length > 0 ? shaped : undefined;
}

function shapeProjectionFromRecord(value: unknown): Record<string, unknown> | undefined {
  const record = getObject(value);
  if (!record) return undefined;
  const data = getObject(record.data) ?? {};
  return shapeProjection(record.projection ?? data.projection);
}

function shapeProjectionForBudget(value: unknown): Record<string, unknown> | undefined {
  const projection = shapeProjectionFromRecord(value);
  if (!projection || typeof projection.compactionLevel !== 'string') return projection;
  return {
    ...projection,
    compactionLevel: boundString(projection.compactionLevel, 128).value,
  };
}

function limitPositionModels(position: Record<string, unknown>, maxModels: number): Record<string, unknown> {
  const models = getObject(position.models);
  if (!models) return position;

  const entries = Object.entries(models);
  if (entries.length <= maxModels) return position;
  const previousCount = typeof position.modelsNotShown === 'number'
    ? position.modelsNotShown
    : typeof position.omittedModelCount === 'number'
      ? position.omittedModelCount
      : 0;
  const { omittedModelCount: _omittedModelCount, modelsNotShown: _modelsNotShown, ...rest } = position;

  return {
    ...rest,
    models: Object.fromEntries(entries.slice(0, maxModels)),
    modelsNotShown: previousCount + entries.length - maxModels,
  };
}

function limitRunPositionsAndModels(run: Record<string, unknown>, maxPositions: number, maxModels: number): Record<string, unknown> {
  const positions = getArray<Record<string, unknown>>(run.positions);
  if (positions.length === 0) return run;
  const previousCount = typeof run.positionsNotShown === 'number'
    ? run.positionsNotShown
    : typeof run.omittedPositionCount === 'number'
      ? run.omittedPositionCount
      : 0;
  const { omittedPositionCount: _omittedPositionCount, positionsNotShown: _positionsNotShown, ...rest } = run;
  const positionsNotShown = previousCount + Math.max(0, positions.length - maxPositions);

  return {
    ...rest,
    positions: positions
      .slice(0, maxPositions)
      .map((position) => limitPositionModels(position, maxModels)),
    ...(positionsNotShown > 0 ? { positionsNotShown } : {}),
  };
}

function compactPortfolioDispersionForBudget(run: Record<string, unknown>): Record<string, unknown> {
  const dispersion = getObject(run.portfolioDispersion);
  if (!dispersion) return run;

  const compact = Object.fromEntries(
    Object.entries(dispersion)
      .filter(([greek]) => BUDGET_DISPERSION_KEYS.has(greek))
      .map(([greek, value]) => {
        const metric = getObject(value);
        if (!metric) return [greek, value];
        const { models: _models, ...withoutModels } = metric;
        return [greek, withoutModels];
      }),
  );

  return {
    ...run,
    portfolioDispersion: compact,
    _portfolioDispersion_meta: {
      modelsOmitted: true,
      kept: Object.keys(compact),
    },
  };
}

function buildComputeRunsFacetSummary(shapedRuns: Array<Record<string, unknown>>): Record<string, unknown> {
  const statuses = Array.from(new Set(
    shapedRuns.map((record) => record.status).filter((status): status is string => typeof status === 'string' && status.length > 0),
  ));
  const scopes = Array.from(new Set(
    shapedRuns.map((record) => record.scope).filter((scope): scope is string => typeof scope === 'string' && scope.length > 0),
  ));
  const qualities = Array.from(new Set(
    shapedRuns.map((record) => record.quality).filter((quality): quality is string => typeof quality === 'string' && quality.length > 0),
  ));
  const underlyings = Array.from(new Set(
    shapedRuns.flatMap((record) => getArray<string>(record.underlyings)).filter((value) => typeof value === 'string' && value.length > 0),
  ));
  const latest = shapedRuns[0];

  return {
    returnedRuns: shapedRuns.length,
    latestStatus: typeof latest?.status === 'string' ? latest.status : undefined,
    latestStartedAt: typeof latest?.startedAt === 'string' ? latest.startedAt : undefined,
    statuses,
    scopes,
    qualities,
    underlyings,
  };
}

function buildComputeRunsOutput(response: Record<string, unknown>, shapedRuns: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    ...response,
    data: shapedRuns,
    count: shapedRuns.length,
    summary: buildComputeRunsFacetSummary(shapedRuns),
  };
}

function refreshComputeRunsFacets(out: Record<string, unknown>): void {
  const shapedRuns = getArray<Record<string, unknown>>(out.data)
    .filter((record) => record != null && typeof record === 'object' && !Array.isArray(record));
  out.count = shapedRuns.length;
  out.summary = buildComputeRunsFacetSummary(shapedRuns);
  if (typeof out.matchedCount === 'number' && Number.isFinite(out.matchedCount)) {
    out.hasMore = out.matchedCount > shapedRuns.length;
  }
}

function compactSingleRunForBudget(value: unknown): Record<string, unknown> {
  const run = getObject(value) ?? {};
  const nested = getObject(run.data);
  const runSummary = getObject(run.summary) ?? getObject(nested?.summary) ?? {};
  const rawUnderlyings = Array.isArray(run.underlyings)
    ? run.underlyings
    : Array.isArray(nested?.underlyings)
      ? nested.underlyings
      : getRunUnderlyings(run);
  const underlyings = Array.from(new Set(
    rawUnderlyings
      .map((item) => normalizeUnderlying(item)?.slice(0, 32))
      .filter((item): item is string => item !== undefined),
  )).slice(0, 20);

  const compactSummary = Object.fromEntries(
    [
      'totalPositions',
      'totalModelRuns',
      'totalCalibrations',
      'executionTimeMs',
      'errorCount',
      'includedErrorCount',
      'errorsTruncated',
    ]
      .map((key) => [key, runSummary[key]])
      .filter(([, fieldValue]) => (
        fieldValue === null
        || typeof fieldValue === 'boolean'
        || (typeof fieldValue === 'number' && Number.isFinite(fieldValue))
      )),
  );
  const boundedField = (fieldValue: unknown, maxChars: number) => boundString(fieldValue, maxChars).value;
  const completedAt = run.completedAt !== undefined ? run.completedAt : runSummary.completedAt;
  const shapedProjection = shapeProjectionForBudget(run);
  const aggregateExclusions = Array.isArray(run.aggregateExclusions) ? run.aggregateExclusions : undefined;
  const modelExclusions = Array.isArray(run.modelExclusions) ? run.modelExclusions : undefined;
  const aggregateExclusionsNotShown = typeof run.aggregateExclusionsNotShown === 'number'
    && Number.isSafeInteger(run.aggregateExclusionsNotShown)
    && run.aggregateExclusionsNotShown > 0
    ? run.aggregateExclusionsNotShown
    : undefined;
  const modelExclusionsNotShown = typeof run.modelExclusionsNotShown === 'number'
    && Number.isSafeInteger(run.modelExclusionsNotShown)
    && run.modelExclusionsNotShown > 0
    ? run.modelExclusionsNotShown
    : undefined;
  // The emergency floor emits zero positions, so its current projection must
  // not retain a stale write-time included count.
  const projection = shapedProjection
    ? {
        ...shapedProjection,
        includedPositionCount: 0,
        positionsTruncated: true,
        variantsTruncated: true,
      }
    : shapedProjection;

  return Object.fromEntries(Object.entries({
    status: boundedField(run.status, 64),
    scope: boundedField(run.scope, 64),
    quality: boundedField(run.quality, 64),
    engineVersion: boundedField(run.engineVersion ?? runSummary.engineVersion, 128),
    runSchemaVersion: finiteNumberOrNull(run.runSchemaVersion ?? nested?.runSchemaVersion),
    completionState: run.completionState === null || runSummary.completionState === null
      ? null
      : boundedField(run.completionState ?? runSummary.completionState, 64),
    valuationTime: finiteNumberOrNull(run.valuationTime ?? runSummary.valuationTime),
    timestamp: asTimestamp(run.timestamp),
    startedAt: boundedField(run.startedAt, 64) ?? toIso(run.timestamp),
    completedAt: completedAt === null ? null : boundedField(completedAt, 64) ?? toIso(completedAt),
    summary: compactSummary,
    underlyings,
    aggregateExclusions,
    aggregateExclusionsNotShown,
    modelExclusions,
    modelExclusionsNotShown,
    projection,
  }).filter(([, fieldValue]) => fieldValue !== undefined));
}

function resetToSingleRunBudgetFloor(
  response: Record<string, unknown>,
  run: unknown,
  requested: number,
  includeFacetSummary: boolean,
): void {
  const requestedLimit = response.requestedLimit;
  const matchedCount = response.matchedCount;
  const previousHasMore = response.hasMore;

  for (const key of Object.keys(response)) delete response[key];
  response.data = [compactSingleRunForBudget(run)];
  response.count = 1;
  if (typeof requestedLimit === 'number' && Number.isFinite(requestedLimit)) response.requestedLimit = requestedLimit;
  if (typeof matchedCount === 'number' && Number.isFinite(matchedCount)) response.matchedCount = matchedCount;
  if (typeof matchedCount === 'number' && Number.isFinite(matchedCount)) {
    response.hasMore = matchedCount > 1;
  } else if (typeof previousHasMore === 'boolean') {
    response.hasMore = previousHasMore || requested > 1;
  }
  if (includeFacetSummary) refreshComputeRunsFacets(response);
  response._truncation_meta = {
    returned: 1,
    requested,
    selection: 'newest',
    reason: 'size budget',
    singleRunCompacted: true,
  };
}

function trimComputeRunsToBudget(out: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(out.data) || jsonUtf8ByteLength(out) <= COMPUTE_RUNS_SAFE_SIZE_BUDGET) return out;

  const requested = out.data.length;
  while (out.data.length > 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    out.data.pop();
  }

  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    out.data[0] = limitRunPositionsAndModels(out.data[0] as Record<string, unknown>, MAX_SINGLE_RUN_FALLBACK_POSITIONS, MAX_SINGLE_RUN_FALLBACK_MODELS);
  }
  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    out.data[0] = compactPortfolioDispersionForBudget(out.data[0] as Record<string, unknown>);
  }
  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    out.data[0] = limitRunPositionsAndModels(out.data[0] as Record<string, unknown>, MAX_SINGLE_RUN_EMERGENCY_POSITIONS, MAX_SINGLE_RUN_EMERGENCY_MODELS);
  }
  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    const run = out.data[0] as Record<string, unknown>;
    const positions = getArray(run.positions);
    delete run.positions;
    run._positions_meta = { omitted: true, omittedCount: positions.length, reason: 'size budget' };
  }
  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    const run = out.data[0] as Record<string, unknown>;
    delete run.portfolioDispersion;
    run._portfolioDispersion_meta = { omitted: true, reason: 'size budget' };
  }

  if (out.data.length === 1 && jsonUtf8ByteLength(out) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    resetToSingleRunBudgetFloor(out, out.data[0], requested, true);
    return out;
  }

  refreshComputeRunsFacets(out);
  out._truncation_meta = {
    returned: out.data.length,
    requested,
    selection: 'newest',
    reason: 'size budget',
  };

  return out;
}

/**
 * Full mode keeps sanitized raw row structure, but it must still trim complete
 * runs before the shared MCP guard. Otherwise that generic guard can shorten
 * data[] after count was computed and leave contradictory response metadata.
 */
export function trimFullComputeRunsResponse(payload: unknown): unknown {
  const response = getObject(payload);
  if (!response || !Array.isArray(response.data)) return payload;

  const requested = response.data.length;
  while (response.data.length > 1 && jsonUtf8ByteLength(response) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    response.data.pop();
  }

  if (response.data.length === 1 && jsonUtf8ByteLength(response) > COMPUTE_RUNS_SAFE_SIZE_BUDGET) {
    resetToSingleRunBudgetFloor(response, response.data[0], requested, false);
    return payload;
  }
  response.count = response.data.length;
  if (typeof response.matchedCount === 'number' && Number.isFinite(response.matchedCount)) {
    response.hasMore = response.matchedCount > response.data.length;
  }

  if (response.data.length < requested) {
    response._truncation_meta = {
      returned: response.data.length,
      requested,
      selection: 'newest',
      reason: 'size budget',
    };
  }

  return payload;
}

export function shapeComputeRunRecord(
  record: unknown,
  maxPositions = MAX_DEFAULT_POSITIONS,
  maxModels?: number,
  positionView: 'detailed' | 'summary' = 'detailed',
): Record<string, unknown> | unknown {
  const raw = getObject(record);
  if (!raw) return record;

  const summary = getSummary(raw) ?? {};
  const data = getObject(raw.data) ?? {};
  const positions = getPositions(raw);
  const sortedPositions = [...positions].sort((left, right) => getPositionSortValue(right) - getPositionSortValue(left));
  const shownPositions = sortedPositions.slice(0, maxPositions);
  const underlyings = getRunUnderlyings(raw);
  const runErrors = shapeRunErrors(data.errors);
  const projection = shapeProjectionFromRecord(raw);
  const runSchemaVersion = finiteNumberOrNull(data.runSchemaVersion);
  const strictness = confidenceStrictness(raw);
  const executionConfig = shapeExecutionConfig(summary.executionConfig ?? data.executionConfig);
  const assistantExclusions = shapeAssistantExclusionFields(raw);

  return {
    status: typeof raw.status === 'string' ? raw.status : undefined,
    scope: typeof raw.scope === 'string' ? raw.scope : undefined,
    quality: typeof raw.quality === 'string' ? raw.quality : undefined,
    engineVersion: stringOrNull(summary.engineVersion),
    runSchemaVersion,
    completionState: stringOrNull(summary.completionState),
    valuationTime: finiteNumberOrNull(summary.valuationTime),
    ...(executionConfig ? { executionConfig } : {}),
    timestamp: asTimestamp(raw.timestamp),
    startedAt: toIso(raw.timestamp),
    completedAt: toIsoPreservingNull(summary.completedAt),
    summary: {
      totalPositions: finiteNumberOrNull(summary.totalPositions),
      totalModelRuns: finiteNumberOrNull(summary.totalModelRuns),
      totalCalibrations: finiteNumberOrNull(summary.totalCalibrations),
      executionTimeMs: finiteNumberOrNull(summary.executionTimeMs, 2),
      errorCount: finiteNumberOrNull(summary.errorCount),
      includedErrorCount: finiteNumberOrNull(summary.includedErrorCount),
      errorsTruncated: booleanOrNull(summary.errorsTruncated),
    },
    underlyings,
    ...runErrors,
    ...assistantExclusions,
    ...(projection ? { projection } : {}),
    portfolioDispersion: shapeDispersion(getDispersion(raw)),
    exposureSweep: shapeExposureSweep(data.exposureSweep),
    positions: shownPositions.map((position) => (
      positionView === 'summary'
        ? shapePositionHighlight(
          position,
          maxModels ?? MAX_MULTI_RUN_MODELS,
          strictness,
        )
        : shapePosition(position, maxModels, strictness)
    )),
    ...(positions.length > shownPositions.length ? { positionsNotShown: positions.length - shownPositions.length } : {}),
  };
}

export function recordMatchesComputeFilters(record: unknown, filters: ComputeRunFilters): boolean {
  const raw = getObject(record);
  if (!raw) return false;

  if (filters.runKey) {
    const runKey = typeof raw.run_key === 'string' ? raw.run_key : typeof raw.runKey === 'string' ? raw.runKey : '';
    if (runKey !== filters.runKey) return false;
  }
  if (filters.status && raw.status !== filters.status) return false;
  if (filters.scope && raw.scope !== filters.scope) return false;
  if (filters.quality && raw.quality !== filters.quality) return false;
  if (filters.underlying) {
    const target = filters.underlying.trim().toUpperCase();
    const matchesUnderlying = getRunUnderlyings(raw).includes(target);
    if (!matchesUnderlying) return false;
  }
  return true;
}

export function summarizeComputeRunsResponse(payload: unknown, view: 'summary' | 'detailed' = 'summary'): unknown {
  const response = getObject(payload);
  if (!response || !Array.isArray(response.data)) return payload;
  // Apply per-position model AND positions trimming as soon as more than one
  // run is requested. The previous setup left limit=2/3 unbounded on positions
  // and only trimmed models at limit>=4; on rich-data accounts this blew the
  // 50 KB MCP budget. Cap to 3 positions × 5 models per multi-run record.
  const isMultiRun = response.data.length >= 2;
  const maxModelsPerPosition = isMultiRun ? MAX_MULTI_RUN_MODELS : undefined;
  const maxPositionsPerRun = isMultiRun ? MAX_MULTI_RUN_POSITIONS : MAX_DEFAULT_POSITIONS;
  const detailedSingleRun = view === 'detailed' && response.data.length === 1;
  const positionView = detailedSingleRun ? 'detailed' : 'summary';

  const shapedRuns = response.data
    .map((record) => shapeComputeRunRecord(record, maxPositionsPerRun, maxModelsPerPosition, positionView))
    .map((record) => (
      !detailedSingleRun && record != null && typeof record === 'object' && !Array.isArray(record)
        ? compactPortfolioDispersionForBudget(record as Record<string, unknown>)
        : record
    ))
    .filter((record): record is Record<string, unknown> => record != null && typeof record === 'object' && !Array.isArray(record));

  return trimComputeRunsToBudget(buildComputeRunsOutput(response, shapedRuns));
}
