type OptionContract = {
  [key: string]: unknown;
  optionSymbol?: string;
  underlyingSymbol?: string;
  strike?: number;
  expiration?: string;
  optionType?: string;
  dte?: number;
  bid?: number | null;
  ask?: number | null;
  mid?: number | null;
  lastPrice?: number | null;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number | null;
  delta?: number | null;
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  pricingSource?: string;
  spotPrice?: number | null;
};

type OptionsChainPayload = {
  [key: string]: unknown;
  ticker?: string;
  date?: string;
  expiration?: string | null;
  spotPrice?: number | null;
  contractCount?: number;
  contracts?: unknown;
  pricingTier?: string;
};

type ExpirationBucket = {
  minDte: number;
  maxDte: number;
};

type ExpirationGroup = {
  expiration: string;
  dte: number;
  contracts: OptionContract[];
};

const REPRESENTATIVE_BUCKETS: ExpirationBucket[] = [
  { minDte: 0, maxDte: 7 },
  { minDte: 8, maxDte: 21 },
  { minDte: 22, maxDte: 45 },
  { minDte: 46, maxDte: 90 },
  { minDte: 91, maxDte: 180 },
  { minDte: 181, maxDte: Number.POSITIVE_INFINITY },
];

const MAX_EXPIRATION_SUMMARIES = 6;
const MAX_PAIR_SUMMARIES = 4;
const MAX_CONTRACTS_PER_BUCKET = 4;
const PREFERRED_MIN_DELTA = 0.15;
const PREFERRED_MAX_DELTA = 0.85;
const FALLBACK_MIN_DELTA = 0.08;
const FALLBACK_MAX_DELTA = 0.92;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function contractType(contract: OptionContract): 'call' | 'put' | null {
  if (contract.optionType === 'call' || contract.optionType === 'put') return contract.optionType;
  return null;
}

function contractOpenInterest(contract: OptionContract): number {
  return asNumber(contract.openInterest) ?? 0;
}

function contractVolume(contract: OptionContract): number {
  return asNumber(contract.volume) ?? 0;
}

function contractMid(contract: OptionContract): number | null {
  const mid = asNumber(contract.mid);
  if (mid != null) return mid;
  const bid = asNumber(contract.bid);
  const ask = asNumber(contract.ask);
  return bid != null && ask != null ? (bid + ask) / 2 : null;
}

function contractIv(contract: OptionContract): number | null {
  return asNumber(contract.impliedVolatility);
}

function contractStrike(contract: OptionContract): number | null {
  return asNumber(contract.strike);
}

function contractDelta(contract: OptionContract): number | null {
  return asNumber(contract.delta);
}

function isRepresentativeDelta(contract: OptionContract): boolean {
  const delta = contractDelta(contract);
  if (delta == null) return true;
  const absDelta = Math.abs(delta);
  return absDelta >= FALLBACK_MIN_DELTA && absDelta <= FALLBACK_MAX_DELTA;
}

function isPreferredRepresentativeDelta(contract: OptionContract): boolean {
  const delta = contractDelta(contract);
  if (delta == null) return true;
  const absDelta = Math.abs(delta);
  return absDelta >= PREFERRED_MIN_DELTA && absDelta <= PREFERRED_MAX_DELTA;
}

function hasNonZeroDte(contract: OptionContract): boolean {
  const dte = asNumber(contract.dte);
  return dte != null && dte >= 1;
}

function trimContract(contract: OptionContract): Record<string, unknown> {
  return {
    optionSymbol: contract.optionSymbol,
    strike: contract.strike,
    expiration: contract.expiration,
    dte: contract.dte,
    mid: contractMid(contract),
    impliedVolatility: contract.impliedVolatility,
    delta: contract.delta,
    openInterest: contract.openInterest,
    volume: contract.volume,
  };
}

function compareByDte(left: ExpirationGroup, right: ExpirationGroup): number {
  if (left.dte !== right.dte) return left.dte - right.dte;
  return left.expiration.localeCompare(right.expiration);
}

function compareByLiquidity(left: OptionContract, right: OptionContract): number {
  const liquidityScore = (contract: OptionContract) => (contractOpenInterest(contract) * 2) + contractVolume(contract);
  const liquidityDelta = liquidityScore(right) - liquidityScore(left);
  if (liquidityDelta !== 0) return liquidityDelta;
  const midDelta = (contractMid(right) ?? 0) - (contractMid(left) ?? 0);
  if (midDelta !== 0) return midDelta;
  return String(left.optionSymbol ?? '').localeCompare(String(right.optionSymbol ?? ''));
}

function compareByVolume(left: OptionContract, right: OptionContract): number {
  const volumeDelta = contractVolume(right) - contractVolume(left);
  if (volumeDelta !== 0) return volumeDelta;
  return compareByLiquidity(left, right);
}

function moneynessDistance(contract: OptionContract, spotPrice: number): number {
  const strike = contractStrike(contract);
  return strike != null && spotPrice > 0 ? Math.abs(strike - spotPrice) / spotPrice : Number.POSITIVE_INFINITY;
}

function bestContractForStrike(contracts: OptionContract[], type: 'call' | 'put', strike: number): OptionContract | null {
  return contracts
    .filter((contract) => contractType(contract) === type && contractStrike(contract) === strike)
    .sort(compareByLiquidity)[0] ?? null;
}

function findAtmPair(contracts: OptionContract[], spotPrice: number): { strike: number | null; call: OptionContract | null; put: OptionContract | null } {
  const strikeSet = new Set<number>();
  for (const contract of contracts) {
    const strike = contractStrike(contract);
    if (strike != null) strikeSet.add(strike);
  }

  const strikes = Array.from(strikeSet.values())
    .sort((left, right) => {
      const distDelta = Math.abs(left - spotPrice) - Math.abs(right - spotPrice);
      if (distDelta !== 0) return distDelta;
      return left - right;
    });

  for (const strike of strikes) {
    const call = bestContractForStrike(contracts, 'call', strike);
    const put = bestContractForStrike(contracts, 'put', strike);
    if (call || put) {
      return { strike, call, put };
    }
  }

  return { strike: null, call: null, put: null };
}

function find25DeltaOption(contracts: OptionContract[], type: 'call' | 'put', spotPrice: number): OptionContract | null {
  const filtered = contracts.filter((contract) => contractType(contract) === type);
  if (filtered.length === 0) return null;

  const otmFiltered = filtered.filter((contract) => {
    const strike = contractStrike(contract);
    if (strike == null) return false;
    return type === 'call' ? strike >= spotPrice : strike <= spotPrice;
  });
  const candidates = otmFiltered.length > 0 ? otmFiltered : filtered;
  const targetDelta = type === 'call' ? 0.25 : -0.25;

  return candidates
    .slice()
    .sort((left, right) => {
      const leftDelta = contractDelta(left);
      const rightDelta = contractDelta(right);
      const leftDistance = leftDelta != null ? Math.abs(leftDelta - targetDelta) : Number.POSITIVE_INFINITY;
      const rightDistance = rightDelta != null ? Math.abs(rightDelta - targetDelta) : Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      const leftMoneyness = moneynessDistance(left, spotPrice);
      const rightMoneyness = moneynessDistance(right, spotPrice);
      if (leftMoneyness !== rightMoneyness) return leftMoneyness - rightMoneyness;
      return compareByLiquidity(left, right);
    })[0] ?? null;
}

function groupByExpiration(contracts: OptionContract[]): ExpirationGroup[] {
  const groups = new Map<string, ExpirationGroup>();

  for (const contract of contracts) {
    if (typeof contract.expiration !== 'string') continue;
    const existing = groups.get(contract.expiration);
    const dte = asNumber(contract.dte) ?? Number.MAX_SAFE_INTEGER;
    if (!existing) {
      groups.set(contract.expiration, {
        expiration: contract.expiration,
        dte,
        contracts: [contract],
      });
      continue;
    }
    existing.dte = Math.min(existing.dte, dte);
    existing.contracts.push(contract);
  }

  return Array.from(groups.values()).sort(compareByDte);
}

function pickRepresentativeGroups(groups: ExpirationGroup[]): ExpirationGroup[] {
  const selected = new Map<string, ExpirationGroup>();

  for (const bucket of REPRESENTATIVE_BUCKETS) {
    const match = groups.find((group) => group.dte >= bucket.minDte && group.dte <= bucket.maxDte);
    if (match) selected.set(match.expiration, match);
  }

  if (selected.size < MAX_EXPIRATION_SUMMARIES) {
    for (const group of groups) {
      if (selected.size >= MAX_EXPIRATION_SUMMARIES) break;
      if (!selected.has(group.expiration)) selected.set(group.expiration, group);
    }
  }

  return Array.from(selected.values()).sort(compareByDte).slice(0, MAX_EXPIRATION_SUMMARIES);
}

function summarizeExpiration(group: ExpirationGroup, spotPrice: number): Record<string, unknown> {
  const callContracts = group.contracts.filter((contract) => contractType(contract) === 'call');
  const putContracts = group.contracts.filter((contract) => contractType(contract) === 'put');
  const atm = findAtmPair(group.contracts, spotPrice);
  const otmCall = find25DeltaOption(group.contracts, 'call', spotPrice);
  const otmPut = find25DeltaOption(group.contracts, 'put', spotPrice);
  const atmCallMid = atm.call ? contractMid(atm.call) : null;
  const atmPutMid = atm.put ? contractMid(atm.put) : null;
  const atmCallIv = atm.call ? contractIv(atm.call) : null;
  const atmPutIv = atm.put ? contractIv(atm.put) : null;

  return {
    expiration: group.expiration,
    dte: group.dte,
    contractCount: group.contracts.length,
    callContracts: callContracts.length,
    putContracts: putContracts.length,
    atmStrike: atm.strike,
    atmCallMid,
    atmPutMid,
    atmStraddleMid: atmCallMid != null && atmPutMid != null ? atmCallMid + atmPutMid : null,
    atmCallIv,
    atmPutIv,
    atmAverageIv: atmCallIv != null && atmPutIv != null ? (atmCallIv + atmPutIv) / 2 : (atmCallIv ?? atmPutIv),
    put25DeltaIv: otmPut ? contractIv(otmPut) : null,
    call25DeltaIv: otmCall ? contractIv(otmCall) : null,
    putCallSkew: otmPut && otmCall && contractIv(otmPut) != null && contractIv(otmCall) != null
      ? contractIv(otmPut)! - contractIv(otmCall)!
      : null,
    callOpenInterest: callContracts.reduce((sum, contract) => sum + contractOpenInterest(contract), 0),
    putOpenInterest: putContracts.reduce((sum, contract) => sum + contractOpenInterest(contract), 0),
    callVolume: callContracts.reduce((sum, contract) => sum + contractVolume(contract), 0),
    putVolume: putContracts.reduce((sum, contract) => sum + contractVolume(contract), 0),
  };
}

function pickNearMoneyContracts(
  contracts: OptionContract[],
  spotPrice: number,
  type: 'call' | 'put',
  compare: (left: OptionContract, right: OptionContract) => number,
): Record<string, unknown>[] {
  const baseCandidates = contracts
    .filter((contract) => contractType(contract) === type)
    .filter((contract) => moneynessDistance(contract, spotPrice) <= 0.05)
    .filter((contract) => (asNumber(contract.dte) ?? Number.MAX_SAFE_INTEGER) <= 120);

  const nonZeroDteCandidates = baseCandidates.filter(hasNonZeroDte);
  const dteCandidates = nonZeroDteCandidates.length > 0 ? nonZeroDteCandidates : baseCandidates;
  const preferredDeltaCandidates = dteCandidates.filter(isPreferredRepresentativeDelta);
  const deltaCandidates = preferredDeltaCandidates.length >= MAX_CONTRACTS_PER_BUCKET
    ? preferredDeltaCandidates
    : dteCandidates.filter(isRepresentativeDelta);
  const representativeGroups = pickRepresentativeGroups(groupByExpiration(deltaCandidates));
  const selected: OptionContract[] = [];
  const seenSymbols = new Set<string>();

  for (const group of representativeGroups) {
    const topContract = group.contracts
      .filter((contract) => contractType(contract) === type)
      .sort(compare)[0];
    const optionSymbol = typeof topContract?.optionSymbol === 'string' ? topContract.optionSymbol : '';
    if (!topContract || !optionSymbol || seenSymbols.has(optionSymbol)) continue;
    selected.push(topContract);
    seenSymbols.add(optionSymbol);
    if (selected.length >= MAX_CONTRACTS_PER_BUCKET) break;
  }

  if (selected.length < MAX_CONTRACTS_PER_BUCKET) {
    for (const contract of deltaCandidates.slice().sort(compare)) {
      const optionSymbol = typeof contract.optionSymbol === 'string' ? contract.optionSymbol : '';
      if (!optionSymbol || seenSymbols.has(optionSymbol)) continue;
      selected.push(contract);
      seenSymbols.add(optionSymbol);
      if (selected.length >= MAX_CONTRACTS_PER_BUCKET) break;
    }
  }

  return selected.map(trimContract);
}

export function summarizeOptionsChain(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  const typed = payload as OptionsChainPayload;
  const rawContracts = Array.isArray(typed.contracts)
    ? typed.contracts.filter((contract): contract is OptionContract => contract != null && typeof contract === 'object')
    : [];

  if (rawContracts.length === 0) {
    return {
      ticker: typed.ticker,
      date: typed.date,
      expiration: typed.expiration ?? null,
      spotPrice: typed.spotPrice ?? null,
      pricingTier: typed.pricingTier,
      contractCount: typed.contractCount ?? 0,
      summary: {
        expirationCount: 0,
        totalCallOpenInterest: 0,
        totalPutOpenInterest: 0,
        totalCallVolume: 0,
        totalPutVolume: 0,
      },
      expirations: [],
      nearAtmPairs: [],
      liquidNearMoney: { calls: [], puts: [] },
      activeNearMoney: { calls: [], puts: [] },
    };
  }

  const spotPrice = asNumber(typed.spotPrice) ?? asNumber(rawContracts[0]?.spotPrice) ?? 0;
  const expirationGroups = groupByExpiration(rawContracts);
  const representativeGroups = pickRepresentativeGroups(expirationGroups);
  const totalCallOpenInterest = rawContracts
    .filter((contract) => contractType(contract) === 'call')
    .reduce((sum, contract) => sum + contractOpenInterest(contract), 0);
  const totalPutOpenInterest = rawContracts
    .filter((contract) => contractType(contract) === 'put')
    .reduce((sum, contract) => sum + contractOpenInterest(contract), 0);
  const totalCallVolume = rawContracts
    .filter((contract) => contractType(contract) === 'call')
    .reduce((sum, contract) => sum + contractVolume(contract), 0);
  const totalPutVolume = rawContracts
    .filter((contract) => contractType(contract) === 'put')
    .reduce((sum, contract) => sum + contractVolume(contract), 0);

  return {
    ticker: typed.ticker,
    date: typed.date,
    expiration: typed.expiration ?? null,
    spotPrice: typed.spotPrice ?? null,
    pricingTier: typed.pricingTier,
    contractCount: typed.contractCount ?? rawContracts.length,
    summary: {
      expirationCount: expirationGroups.length,
      nearestExpiration: representativeGroups[0]?.expiration ?? expirationGroups[0]?.expiration ?? null,
      farthestExpiration: expirationGroups.at(-1)?.expiration ?? null,
      totalCallOpenInterest,
      totalPutOpenInterest,
      putCallOpenInterestRatio: totalCallOpenInterest > 0 ? totalPutOpenInterest / totalCallOpenInterest : null,
      totalCallVolume,
      totalPutVolume,
      putCallVolumeRatio: totalCallVolume > 0 ? totalPutVolume / totalCallVolume : null,
    },
    expirations: representativeGroups.map((group) => summarizeExpiration(group, spotPrice)),
    nearAtmPairs: representativeGroups
      .slice(0, MAX_PAIR_SUMMARIES)
      .map((group) => {
        const atm = findAtmPair(group.contracts, spotPrice);
        return {
          expiration: group.expiration,
          dte: group.dte,
          atmStrike: atm.strike,
          call: atm.call ? trimContract(atm.call) : null,
          put: atm.put ? trimContract(atm.put) : null,
        };
      }),
    liquidNearMoney: {
      calls: pickNearMoneyContracts(rawContracts, spotPrice, 'call', compareByLiquidity),
      puts: pickNearMoneyContracts(rawContracts, spotPrice, 'put', compareByLiquidity),
    },
    activeNearMoney: {
      calls: pickNearMoneyContracts(rawContracts, spotPrice, 'call', compareByVolume),
      puts: pickNearMoneyContracts(rawContracts, spotPrice, 'put', compareByVolume),
    },
    _contracts_meta: {
      summarized: true,
      total_contracts: typed.contractCount ?? rawContracts.length,
      expirations: expirationGroups.length,
    },
  };
}
