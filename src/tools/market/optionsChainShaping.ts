import { compareByDte, sampleExpirationsAcrossCurve } from './expirationSampling.js';

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

type ExpirationGroup = {
  expiration: string;
  dte: number;
  contracts: OptionContract[];
};

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

/** A contract's open interest as carried; null when it carries none, which is unknown, never 0. */
function contractOpenInterest(contract: OptionContract): number | null {
  return asNumber(contract.openInterest);
}

/** A contract's volume as carried; null when it carries none, which is unknown, never 0. */
function contractVolume(contract: OptionContract): number | null {
  return asNumber(contract.volume);
}

/** For ranking only, never published: a count a contract does not carry ranks as none. */
function rankCount(value: number | null): number {
  return value ?? 0;
}

/**
 * A total over contracts: the sum of the counts they carry, and how many
 * carry none. A count a contract does not carry is unknown, not 0 (the live
 * chain's rule, liveChainShaping totals): it is left out of the sum and
 * counted in `missing`, and when no contract carries one the total is null.
 */
function sumCarried(contracts: OptionContract[], read: (contract: OptionContract) => number | null): { total: number | null; missing: number } {
  let total = 0;
  let missing = 0;
  for (const contract of contracts) {
    const value = read(contract);
    if (value === null) missing += 1;
    else total += value;
  }
  return { total: contracts.length > 0 && missing === contracts.length ? null : total, missing };
}

/** Put over call, or null unless both totals are known and the call total is above 0. */
function putCallRatio(put: number | null, call: number | null): number | null {
  return put !== null && call !== null && call > 0 ? put / call : null;
}

/**
 * How many call and put contracts carry no open interest, and how many no
 * volume, beside the totals that leave them out; neither when every contract
 * carries both.
 */
function missingCounts(
  calls: { openInterest: { missing: number }; volume: { missing: number } },
  puts: { openInterest: { missing: number }; volume: { missing: number } },
): Record<string, unknown> {
  return {
    ...(calls.openInterest.missing > 0 || puts.openInterest.missing > 0
      ? { contractsMissingOpenInterest: { calls: calls.openInterest.missing, puts: puts.openInterest.missing } }
      : {}),
    ...(calls.volume.missing > 0 || puts.volume.missing > 0
      ? { contractsMissingVolume: { calls: calls.volume.missing, puts: puts.volume.missing } }
      : {}),
  };
}

/** The underlying's price: a positive finite number, or null (no ATM strike and no moneyness without one). */
function asSpot(value: unknown): number | null {
  const spot = asNumber(value);
  return spot !== null && spot > 0 ? spot : null;
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

/**
 * Where a contract's impliedVolatility came from. The proxy fills it from
 * the side's own mid IV where that is usable and otherwise from the smoothed
 * SMV (SupabaseService.getOptionsChain: capIv(side) ?? capIv(smooth)), and
 * carries cMidIv, pMidIv and smoothSmvVol beside it. Stored (smv 0.3, call
 * mid 0, put mid 0) therefore arrives as 0.3 on both wings, and a skew built
 * from the two was 0 with nothing saying so. 'mid' is the side's own mid IV;
 * 'smoothed' is the surface value standing in; null is no usable IV, or a
 * payload without the per-side columns, where the source cannot be known.
 */
type IvSource = 'mid' | 'smoothed' | null;

export const CHAIN_SKEW_BASIS = '25-delta put IV minus 25-delta call IV, side mid IVs only; null unless both wings are side mids';

function contractIvSource(contract: OptionContract): IvSource {
  if (contractIv(contract) === null) return null;
  const sideKey = contractType(contract) === 'call' ? 'cMidIv' : 'pMidIv';
  if (asNumber(contract[sideKey]) !== null) return 'mid';
  // A payload without the columns lands here too: both null, source unknown.
  return asNumber(contract.smoothSmvVol) !== null ? 'smoothed' : null;
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
    ivSource: contractIvSource(contract),
    delta: contract.delta,
    openInterest: contract.openInterest,
    volume: contract.volume,
  };
}

function compareByLiquidity(left: OptionContract, right: OptionContract): number {
  const liquidityScore = (contract: OptionContract) => (rankCount(contractOpenInterest(contract)) * 2) + rankCount(contractVolume(contract));
  const liquidityDelta = liquidityScore(right) - liquidityScore(left);
  if (liquidityDelta !== 0) return liquidityDelta;
  const midDelta = (contractMid(right) ?? 0) - (contractMid(left) ?? 0);
  if (midDelta !== 0) return midDelta;
  return String(left.optionSymbol ?? '').localeCompare(String(right.optionSymbol ?? ''));
}

function compareByVolume(left: OptionContract, right: OptionContract): number {
  const volumeDelta = rankCount(contractVolume(right)) - rankCount(contractVolume(left));
  if (volumeDelta !== 0) return volumeDelta;
  return compareByLiquidity(left, right);
}

function moneynessDistance(contract: OptionContract, spotPrice: number | null): number {
  const strike = contractStrike(contract);
  return strike != null && spotPrice !== null ? Math.abs(strike - spotPrice) / spotPrice : Number.POSITIVE_INFINITY;
}

function bestContractForStrike(contracts: OptionContract[], type: 'call' | 'put', strike: number): OptionContract | null {
  return contracts
    .filter((contract) => contractType(contract) === type && contractStrike(contract) === strike)
    .sort(compareByLiquidity)[0] ?? null;
}

function findAtmPair(contracts: OptionContract[], spotPrice: number | null): { strike: number | null; call: OptionContract | null; put: OptionContract | null } {
  // Without the underlying's price there is no at-the-money strike: the
  // nearest strike to a price of 0 was the chain's lowest.
  if (spotPrice === null) return { strike: null, call: null, put: null };
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

function find25DeltaOption(contracts: OptionContract[], type: 'call' | 'put', spotPrice: number | null): OptionContract | null {
  const filtered = contracts.filter((contract) => contractType(contract) === type);
  if (filtered.length === 0) return null;

  // Out of the money is a side of the underlying's price; without one the
  // wing is chosen by delta alone.
  const otmFiltered = spotPrice === null ? [] : filtered.filter((contract) => {
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

/**
 * The expiration summaries, near-ATM pairs and nearestExpiration are built
 * from this sample; the representative contracts apply the same same-day rule
 * on their own (hasNonZeroDte) before grouping. The rule and the tenor buckets
 * are shared with the IV surface (expirationSampling.ts).
 */
function pickRepresentativeGroups(allGroups: ExpirationGroup[]): ExpirationGroup[] {
  return sampleExpirationsAcrossCurve(allGroups, MAX_EXPIRATION_SUMMARIES);
}

function summarizeExpiration(group: ExpirationGroup, spotPrice: number | null): Record<string, unknown> {
  const callContracts = group.contracts.filter((contract) => contractType(contract) === 'call');
  const putContracts = group.contracts.filter((contract) => contractType(contract) === 'put');
  const atm = findAtmPair(group.contracts, spotPrice);
  const otmCall = find25DeltaOption(group.contracts, 'call', spotPrice);
  const otmPut = find25DeltaOption(group.contracts, 'put', spotPrice);
  const atmCallMid = atm.call ? contractMid(atm.call) : null;
  const atmPutMid = atm.put ? contractMid(atm.put) : null;
  const atmCallIv = atm.call ? contractIv(atm.call) : null;
  const atmPutIv = atm.put ? contractIv(atm.put) : null;
  const calls = { openInterest: sumCarried(callContracts, contractOpenInterest), volume: sumCarried(callContracts, contractVolume) };
  const puts = { openInterest: sumCarried(putContracts, contractOpenInterest), volume: sumCarried(putContracts, contractVolume) };

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
    atmCallIvSource: atm.call ? contractIvSource(atm.call) : null,
    atmPutIv,
    atmPutIvSource: atm.put ? contractIvSource(atm.put) : null,
    atmAverageIv: atmCallIv != null && atmPutIv != null ? (atmCallIv + atmPutIv) / 2 : (atmCallIv ?? atmPutIv),
    // The contract each wing actually is. On a coarse strike grid the
    // nearest-to-25-delta OTM contract can be the ATM strike (APT at 5.25
    // with 50-cent strikes: the strike-5 put at delta -0.212), and with no
    // OTM contract on a side it is an ITM one; the strike and delta say so.
    put25DeltaStrike: otmPut ? contractStrike(otmPut) : null,
    put25DeltaDelta: otmPut ? contractDelta(otmPut) : null,
    put25DeltaIv: otmPut ? contractIv(otmPut) : null,
    put25DeltaIvSource: otmPut ? contractIvSource(otmPut) : null,
    call25DeltaStrike: otmCall ? contractStrike(otmCall) : null,
    call25DeltaDelta: otmCall ? contractDelta(otmCall) : null,
    call25DeltaIv: otmCall ? contractIv(otmCall) : null,
    call25DeltaIvSource: otmCall ? contractIvSource(otmCall) : null,
    // Put wing minus call wing, from two side mids only: a wing whose IV is
    // the smoothed stand-in, or whose source cannot be known, builds no skew.
    putCallSkew: otmPut && otmCall && contractIvSource(otmPut) === 'mid' && contractIvSource(otmCall) === 'mid'
      ? contractIv(otmPut)! - contractIv(otmCall)!
      : null,
    callOpenInterest: calls.openInterest.total,
    putOpenInterest: puts.openInterest.total,
    callVolume: calls.volume.total,
    putVolume: puts.volume.total,
    ...missingCounts(calls, puts),
  };
}

function pickNearMoneyContracts(
  contracts: OptionContract[],
  spotPrice: number | null,
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
      // No contract on file: the totals are unknown, never a book of 0.
      summary: {
        expirationCount: 0,
        totalCallOpenInterest: null,
        totalPutOpenInterest: null,
        totalCallVolume: null,
        totalPutVolume: null,
      },
      expirations: [],
      nearAtmPairs: [],
      liquidNearMoney: { calls: [], puts: [] },
      activeNearMoney: { calls: [], puts: [] },
    };
  }

  // A spot the chain does not carry is null, never 0 (see findAtmPair).
  const spotPrice = asSpot(typed.spotPrice) ?? asSpot(rawContracts[0]?.spotPrice);
  const expirationGroups = groupByExpiration(rawContracts);
  const representativeGroups = pickRepresentativeGroups(expirationGroups);
  const allCalls = rawContracts.filter((contract) => contractType(contract) === 'call');
  const allPuts = rawContracts.filter((contract) => contractType(contract) === 'put');
  const calls = { openInterest: sumCarried(allCalls, contractOpenInterest), volume: sumCarried(allCalls, contractVolume) };
  const puts = { openInterest: sumCarried(allPuts, contractOpenInterest), volume: sumCarried(allPuts, contractVolume) };

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
      totalCallOpenInterest: calls.openInterest.total,
      totalPutOpenInterest: puts.openInterest.total,
      putCallOpenInterestRatio: putCallRatio(puts.openInterest.total, calls.openInterest.total),
      totalCallVolume: calls.volume.total,
      totalPutVolume: puts.volume.total,
      putCallVolumeRatio: putCallRatio(puts.volume.total, calls.volume.total),
      ...missingCounts(calls, puts),
    },
    expirations: representativeGroups.map((group) => summarizeExpiration(group, spotPrice)),
    // get_iv_surface publishes a putCallSkew on another basis (fixed 95% and
    // 105% strikes); the two read fivefold apart on one expiration under one
    // name, so each says what it is beside the number.
    putCallSkewBasis: CHAIN_SKEW_BASIS,
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
