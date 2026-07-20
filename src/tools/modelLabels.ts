const MODEL_NAME_LABELS: Record<string, string> = {
  BlackScholes: 'Black-Scholes',
  blackScholes: 'Black-Scholes',
  blackscholes: 'Black-Scholes',
  bs: 'Black-Scholes',
  Black76: 'Black-76',
  black76: 'Black-76',
  'Black-76': 'Black-76',
  JumpDiffusion: 'Jump Diffusion',
  jumpDiffusion: 'Jump Diffusion',
  jumpdiffusion: 'Jump Diffusion',
  VarianceGamma: 'Variance Gamma',
  varianceGamma: 'Variance Gamma',
  variancegamma: 'Variance Gamma',
  vg: 'Variance Gamma',
  MonteCarlo: 'Monte Carlo',
  monteCarlo: 'Monte Carlo',
  'MonteCarlo-JumpDiffusion': 'Monte Carlo - Jump Diffusion',
  'MonteCarlo-Heston': 'Monte Carlo - Heston',
  'MonteCarlo-MeanReverting': 'Monte Carlo - Mean Reverting',
  LocalVolatility: 'Local Volatility',
  localVolatility: 'Local Volatility',
  LocalVol: 'Local Volatility',
  localVol: 'Local Volatility',
  localvol: 'Local Volatility',
  'LocalVol-Dupire': 'Local Volatility - Dupire',
  'LocalVol-CEV': 'Local Volatility - CEV',
  Heston: 'Heston',
  heston: 'Heston',
  SABR: 'SABR',
  sabr: 'SABR',
  Binomial: 'Binomial',
  binomial: 'Binomial',
  Merton: 'Merton',
  merton: 'Merton',
  Kou: 'Kou',
  kou: 'Kou',
  ESSVI: 'ESSVI',
  eSSVI: 'ESSVI',
  essvi: 'ESSVI',
  CGMY: 'CGMY',
  cgmy: 'CGMY',
  Bates: 'Bates',
  bates: 'Bates',
};

const MODEL_DISPLAY_LABELS = new Set(Object.values(MODEL_NAME_LABELS));

const MODEL_BACKEND_IDS: Record<string, string> = {
  'Black-Scholes': 'BlackScholes',
  'Black Scholes': 'BlackScholes',
  BlackScholes: 'BlackScholes',
  blackScholes: 'BlackScholes',
  blackscholes: 'BlackScholes',
  bs: 'BlackScholes',
  'Black-76': 'Black76',
  'Black 76': 'Black76',
  Black76: 'Black76',
  black76: 'Black76',
  'Jump Diffusion': 'JumpDiffusion',
  JumpDiffusion: 'JumpDiffusion',
  jumpDiffusion: 'JumpDiffusion',
  jumpdiffusion: 'JumpDiffusion',
  'Variance Gamma': 'VarianceGamma',
  VarianceGamma: 'VarianceGamma',
  varianceGamma: 'VarianceGamma',
  variancegamma: 'VarianceGamma',
  vg: 'VarianceGamma',
  'Monte Carlo': 'MonteCarlo',
  MonteCarlo: 'MonteCarlo',
  monteCarlo: 'MonteCarlo',
  'Monte Carlo - Jump Diffusion': 'MonteCarlo-JumpDiffusion',
  'Monte Carlo - Heston': 'MonteCarlo-Heston',
  'Monte Carlo - Mean Reverting': 'MonteCarlo-MeanReverting',
  'Local Volatility': 'LocalVol',
  'Local Vol': 'LocalVol',
  LocalVol: 'LocalVol',
  localVol: 'LocalVol',
  localvol: 'LocalVol',
  'Local Volatility - Dupire': 'LocalVol-Dupire',
  'Local Volatility - CEV': 'LocalVol-CEV',
  Heston: 'Heston',
  heston: 'Heston',
  SABR: 'SABR',
  sabr: 'SABR',
  Binomial: 'Binomial',
  binomial: 'Binomial',
  Merton: 'Merton',
  merton: 'Merton',
  Kou: 'Kou',
  kou: 'Kou',
  ESSVI: 'ESSVI',
  eSSVI: 'ESSVI',
  essvi: 'ESSVI',
  CGMY: 'CGMY',
  cgmy: 'CGMY',
  Bates: 'Bates',
  bates: 'Bates',
};

function normalizeModelLookupKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const NORMALIZED_MODEL_BACKEND_IDS: Record<string, string> = {};
for (const [label, backendId] of Object.entries(MODEL_BACKEND_IDS)) {
  NORMALIZED_MODEL_BACKEND_IDS[normalizeModelLookupKey(label)] = backendId;
}

function getObject(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function modelDisplayName(modelName: string): string;
export function modelDisplayName(modelName: unknown): unknown;
export function modelDisplayName(modelName: unknown): unknown {
  if (typeof modelName !== 'string') return modelName;
  const trimmed = modelName.trim();
  if (!trimmed) return modelName;
  if (MODEL_DISPLAY_LABELS.has(trimmed)) return trimmed;
  if (MODEL_NAME_LABELS[trimmed]) return MODEL_NAME_LABELS[trimmed];
  if (/^[A-Z0-9]+$/.test(trimmed)) return trimmed;
  return trimmed
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\bBlack Scholes\b/g, 'Black-Scholes')
    .replace(/\s+/g, ' ')
    .trim();
}

export function modelBackendId(modelName: string): string;
export function modelBackendId(modelName: unknown): unknown;
export function modelBackendId(modelName: unknown): unknown {
  if (typeof modelName !== 'string') return modelName;
  const trimmed = modelName.trim();
  if (!trimmed) return modelName;
  return MODEL_BACKEND_IDS[trimmed] ?? NORMALIZED_MODEL_BACKEND_IDS[normalizeModelLookupKey(trimmed)] ?? trimmed;
}

export function modelDisplayNames(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => modelDisplayName(item));
}

export function displayNameModelMap(value: unknown): Record<string, unknown> | undefined {
  const models = getObject(value);
  if (!models) return undefined;
  const out: Record<string, unknown> = {};
  for (const [modelName, modelValue] of Object.entries(models)) {
    out[modelDisplayName(modelName)] = modelValue;
  }
  return out;
}
