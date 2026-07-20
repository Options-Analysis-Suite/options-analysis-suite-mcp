type NewsArticle = {
  [key: string]: unknown;
  title?: string;
  summary?: string;
  text?: string;
  snippet?: string;
  url?: string;
  source?: string;
  published_date?: string;
  date?: string;
  publishedDate?: string;
  is_press_release?: boolean;
  symbol?: string;
};

type CompanyProfile = {
  [key: string]: unknown;
  company_name?: string;
  description?: string;
  sector?: string;
  industry?: string;
  is_etf?: boolean;
};

type NewsResponse = {
  [key: string]: unknown;
  results?: unknown;
};

const MAX_RESULTS = 10;
const MIN_RELEVANCE_SCORE = 18;
const CORPORATE_SUFFIXES = new Set([
  'inc', 'inc.', 'corp', 'corp.', 'corporation', 'company', 'co', 'co.', 'ltd', 'ltd.', 'limited', 'plc',
  'holdings', 'holding', 'group', 'technologies', 'technology', 'systems', 'industries', 'international',
]);
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'their', 'they', 'will', 'after', 'before',
  'have', 'has', 'about', 'over', 'under', 'through', 'while', 'where', 'what', 'when', 'which', 'whose',
  'into', 'online', 'week', 'weeks', 'returns', 'return', 'announces', 'announced', 'introduces', 'introduced',
  'launches', 'launched', 'debuts', 'debuted', 'says', 'said', 'news', 'today', 'most', 'more', 'less',
  'than', 'year', 'years', 'month', 'months', 'quarter', 'quarters', 'new', 'all', 'across', 'support',
]);
const ACTION_WORDS = new Set([
  'announces', 'announced', 'introduces', 'introduced', 'launches', 'launched', 'debuts', 'debuted',
  'reports', 'reported', 'guides', 'guidance', 'returns', 'return', 'unveils', 'unveiled', 'posts',
  'posted', 'reveals', 'revealed', 'refreshes', 'refreshed', 'expands', 'expanded', 'hosts', 'host',
  'plans', 'planned', 'wins', 'won', 'loses', 'lost', 'falls', 'fell', 'drops', 'dropped', 'slips',
  'slipped', 'surges', 'surged', 'jumps', 'jumped', 'cuts', 'cut', 'raises', 'raised', 'faces', 'faced',
  'settles', 'settled', 'sues', 'sued', 'beats', 'beat', 'misses', 'missed', 'invests', 'invested',
  'buys', 'bought', 'sells', 'sold', 'partners', 'partnered', 'fined', 'fines', 'releases', 'released',
  'hire', 'hires', 'hired', 'appoints', 'appointed', 'names', 'named', 'offers', 'offered', 'gives',
  'gave', 'brings', 'brought', 'builds', 'built',
]);
const CONTEXT_WORDS = new Set([
  'stock', 'shares', 'earnings', 'revenue', 'sales', 'profit', 'profits', 'guidance', 'outlook',
  'results', 'forecast', 'forecasts', 'dividend', 'buyback', 'tariff', 'tariffs', 'antitrust',
  'regulator', 'regulators', 'lawsuit', 'court', 'supplier', 'suppliers', 'supply', 'chain',
  'iphone', 'ipad', 'mac', 'macbook', 'watch', 'ios', 'app', 'apps', 'store', 'services',
  'device', 'devices', 'software', 'hardware', 'developer', 'developers', 'ai', 'chip', 'chips',
  'semiconductor', 'semiconductors', 'phone', 'phones', 'smartphone', 'smartphones', 'tablet',
  'tablets', 'computer', 'computers', 'wearables', 'accessories', 'quarter', 'quarters', 'fiscal',
  'financial', 'production', 'deliveries', 'delivery', 'deployment', 'deployments', 'vehicle',
  'vehicles', 'energy', 'investor', 'investors', 'deal', 'deals', 'data', 'center', 'centers',
  'marketing', 'manufacturing', 'infrastructure', 'factory', 'factories', 'plant', 'plants',
  'shareholder', 'shareholders', 'judge', 'judges', 'case', 'cases', 'recuse', 'recusal', 'legal',
  'gaming', 'game', 'games', 'gpu', 'gpus', 'cpu', 'cpus', 'processor', 'processors', 'chipmaker',
  'chipmakers', 'graphics', 'rendering', 'tool', 'tools', 'platform', 'platforms', 'robotaxi',
  'robotaxis', 'rack', 'architecture', 'data-center', 'datacenter',
]);
const TITLE_PREFIX_SKIP_WORDS = new Set([
  'first', 'second', 'third', 'fourth', 'fiscal', 'full', 'year', 'annual', 'q1', 'q2', 'q3', 'q4', 'fy',
]);
const NEGATIVE_PHRASES = [
  'golden apple',
  'apple isports',
  'apple podcasts',
];
const FILING_STYLE_TITLE_PHRASES = [
  'largest position',
  'increases stake',
  'increased stake',
  'cuts stake',
  'cut its stake',
  'stake cut',
  'stake reduced',
  'trims stake',
  'trimmed stake',
  'shares bought',
  'shares sold',
  'makes new investment',
  'makes new',
  'purchases shares',
  'purchased shares',
  'buys shares',
  'sells shares',
];
const FILING_STYLE_TEXT_PHRASES = [
  'most recent filing with the securities and exchange commission',
  'most recent filing with the sec',
  'most recent disclosure with the securities and exchange commission',
  'most recent disclosure with the sec',
  'in a filing disclosed on',
  'the representative disclosed',
  'the senator disclosed',
  'form 13f filing',
  '13f filing',
  'institutional investor',
  'grew its stake in shares of',
  'cut its holdings in shares of',
  'purchased a new stake in',
  'bought a new position in',
];
const LOW_SIGNAL_TITLE_PHRASES = [
  'stock market today',
  'the big 3',
  'time to buy',
  'which stock should',
  'fell more than broader market',
  'price target',
  'price prediction',
  'opinion',
  ' vs ',
  'forecasts',
  'what s ahead',
  'strong sell',
  'strong buy',
  'solid hold',
  'maintaining my',
  'keeping my',
  'why i m',
  'why i am',
  'tries to break',
  'catches a break',
  'a lot more important than it may seem',
  'the stock is falling',
  'broader market today',
  'stock falls',
  'stock struggles',
  'here s why',
  'could fall',
  'big winner',
  'mag 7',
  'should care about',
  'final trades',
  'death cross',
  'call options',
  'put options',
  'just paid dividends',
  'what can stop the rot',
  'lean into the fear',
  'seen entering',
  'selloff continues',
  'rare selloff',
  'extends decline',
  'pressure may not abate',
  'worst week',
  'legal woes',
  'lost canada',
  'moving in fast',
  'hit a bottom',
  'spending spree',
  'expert says',
  'recuse herself',
  'drops fresh clues',
  'isn t getting a boost',
  'etf prime',
  'tactical roadmap',
  'mixing sector etfs',
  'equal sector strategy',
  'smart way to generate regular income',
  'might grow to be worth',
  'peak has passed',
  'best performing stocks today',
  'worth buying',
  'attracting investor attention',
  'what you should know',
  'surpasses market returns',
  'some facts worth knowing',
  'top stock for the long term',
  'good investment by brokers',
  'gaining today',
  'dead money',
  'found its floor',
  'gone nowhere',
  'bargain of the ai boom',
  'a sign of more upside',
  'investor alert',
  'attorneys at law',
  'breach of fiduciary duties',
  'while market falls',
  'some facts to note',
  'lowest valuation',
  'underestimated by analysts',
  'set to open lower',
  'fear greed index',
  'countertrend rally',
  'snapshot',
  'rally today',
  'how much longer until',
  'buying opportunity',
  'top rated stocks',
];
const LOW_SIGNAL_SOURCE_HINTS = [
  'youtube com',
  '247wallst com',
];
const LOW_SIGNAL_SUMMARY_PHRASES = [
  'what s next for',
  'wealth preservation',
  'investors have lost some of their fascination',
  'shares remained under pressure',
  'price target',
  'outperform rating',
  'investor faith',
  'significantly overvalued',
  'bears think',
];
const ANALYST_OR_VALUATION_PHRASES = [
  'analyst',
  'analysts',
  'valuation',
  'upside',
  'downside',
  'underestimated',
  'overvalued',
  'undervalued',
  'bargain',
  'cheap',
  'expensive',
  'price target',
  'price targets',
  'worth buying',
];
const COMMENTARY_SOURCE_HINTS = [
  'gurufocus com',
  'seekingalpha com',
  'fool com',
  'zacks com',
  'benzinga com',
  'marketwatch com',
  'finbold com',
];
const ETF_COMPARISON_TITLE_PHRASES = [
  'should you invest in',
  'which is the better',
  'better investment',
  'belongs in your portfolio',
  'compared to',
  'compare to',
  'compares to',
  'compared with',
  'versus',
  'best artificial intelligence etf',
];
const COMPARISON_SIGNAL_TITLE_PHRASES = [
  'better',
  'best',
  'compare',
  'compared',
  'comparison',
  'versus',
  'vs',
  'than',
  'broader',
  'cheaper',
  'fees',
  'performance',
  'yield',
  'risk',
];
const TICKER_LIKE_TITLE_SKIP_TOKENS = new Set([
  'ETF', 'ETFS', 'SPDR', 'NYSE', 'NASDAQ', 'NYSEARCA', 'AI', 'USA', 'US', 'ADR', 'IPO',
]);
const LEGAL_PRESS_RELEASE_TITLE_PHRASES = [
  'law firm',
  'class action',
  'wrongful death lawsuit',
  'investigation announced',
  'investigates',
  'investigation of',
];
const LOW_SIGNAL_SOURCE_PATTERNS = [
  { sourceHint: 'seekingalpha com', titleHints: ['strong sell', 'strong buy', 'solid hold', 'hold', 'buy', 'sell', 'lean into the fear'] },
  { sourceHint: 'seekingalpha com', titleHints: ['why the', 'is just starting'] },
  { sourceHint: 'zacks com', titleHints: ['what s ahead'] },
  { sourceHint: 'benzinga com', titleHints: ['tries to break', 'finally catches a break', 'final trades', 'death cross', 'drops fresh clues', 'beware'] },
  { sourceHint: 'gurufocus com', titleHints: ['stock falls', 'predicts', 'price target', 'seen entering'] },
  { sourceHint: 'invezz com', titleHints: ['stock struggles', 'broader market today', 'investor faith'] },
  { sourceHint: 'invezz com', titleHints: ['buying opportunity'] },
  { sourceHint: 'fool com', titleHints: ['could fall', 'here s why', '1 reason', 'worth buying', 'might grow to be worth'] },
  { sourceHint: 'zacks com', titleHints: ['what you should know', 'surpasses market returns', 'some facts worth knowing', 'top stock for the long term', 'good investment by brokers', 'attracting investor attention'] },
  { sourceHint: 'marketwatch com', titleHints: ['why ', 'worth buying', 'top rated stocks'] },
  { sourceHint: 'techxplore com', titleHints: ['expert says'] },
  { sourceHint: 'businessinsider com', titleHints: ['recuse', 'lawsuit'] },
  { sourceHint: 'etftrends com', titleHints: ['etf prime', 'roadmap for sector investing', 'mixing sector etfs', 'equal sector strategy'] },
  { sourceHint: 'defenseworld net', titleHints: ['call options', 'put options'] },
  { sourceHint: 'finbold com', titleHints: ['just paid dividends'] },
  { sourceHint: 'businesswire com', titleHints: ['investor alert', 'attorneys at law', 'breach of fiduciary duties'] },
  { sourceHint: 'zacks com', titleHints: ['while market falls', 'some facts to note'] },
  { sourceHint: 'gurufocus com', titleHints: ['underestimated by analysts', 'rally as'] },
  { sourceHint: 'finbold com', titleHints: ['lowest valuation'] },
  { sourceHint: 'marketwatch com', titleHints: ['how much longer until'] },
  { sourceHint: 'fxempire com', titleHints: ['countertrend rally', 'rally today', 'us indices'] },
  { sourceHint: 'etftrends com', titleHints: ['snapshot'] },
];
const SOURCE_SCORE_ADJUSTMENTS = [
  { hint: 'reuters com', delta: 36 },
  { hint: 'cnbc com', delta: 18 },
  { hint: 'wsj com', delta: 16 },
  { hint: 'bloomberg com', delta: 14 },
  { hint: 'barrons com', delta: 12 },
  { hint: 'apnews com', delta: 8 },
  { hint: 'cnet com', delta: 6 },
  { hint: 'proactiveinvestors com', delta: 4 },
  { hint: 'pymnts com', delta: -12 },
  { hint: 'fool com', delta: -10 },
  { hint: 'seekingalpha com', delta: -10 },
  { hint: 'zacks com', delta: -10 },
  { hint: 'benzinga com', delta: -10 },
  { hint: 'businessinsider com', delta: -6 },
  { hint: 'gurufocus com', delta: -8 },
  { hint: 'invezz com', delta: -14 },
  { hint: 'fxempire com', delta: -12 },
  { hint: 'marketwatch com', delta: -6 },
  { hint: 'techxplore com', delta: -8 },
  { hint: 'etftrends com', delta: -10 },
  { hint: 'defenseworld net', delta: -18 },
  { hint: 'accessnewswire com', delta: -14 },
  { hint: 'finbold com', delta: -10 },
];
const SECONDARY_TITLE_MENTION_PHRASES = [
  ' and ',
  ' vs ',
  ' with ',
  ' on ',
  ' too much ',
  ' apple pay ',
  ' google pay ',
  ' final trades ',
  ' death cross ',
];
const ETF_CONTEXT_WORDS = new Set([
  'etf', 'etfs', 'fund', 'funds', 'trust', 'trusts', 'index', 'indexes', 'sector', 'sectors',
  'spdr', 'ishares', 'invesco', 'vanguard', 'proshares', 'direxion',
]);
const SYMBOL_LED_ETF_CONTEXT_WORDS = new Set([
  'diversification', 'diversified', 'exposure', 'holdings', 'basket', 'benchmark', 'benchmarks', 'constituents',
  'constituent', 'stock', 'stocks', 'investment', 'investments', 'compare', 'comparison', 'leaders', 'leader',
  'concentrated',
]);
const ETF_FUND_SPECIFIC_CONTEXT_WORDS = new Set([
  'flow', 'flows', 'inflow', 'inflows', 'outflow', 'outflows', 'short', 'interest', 'assets', 'aum', 'rebalance',
  'rebalancing', 'weight', 'weights', 'concentration', 'borrow', 'borrowed', 'creation', 'creations', 'redemption',
  'redemptions', 'holdings', 'basket', 'constituents', 'constituent',
]);
const BROAD_MARKET_MACRO_CONTEXT_WORDS = new Set([
  'benchmark', 'benchmarks', 'index', 'indices', 'correction', 'corrections', 'target', 'targets', 'forecast',
  'forecasts', 'breadth', 'futures', 'inflation', 'rate', 'rates', 'oil', 'war', 'tariff', 'tariffs', 'selloff',
  'volatility', 'vix', 'sector', 'sectors', 'economy', 'economic', 'recession', 'ceasefire', 'fear', 'greed',
]);
const BROAD_MARKET_LOW_SIGNAL_TITLE_PHRASES = [
  'snapshot',
  'fear greed index',
  'rally today',
  'set to open lower',
  'top rated stocks',
  'best performing stocks',
  'countertrend rally',
];
const GENERIC_ETF_REFERENCE_TOKENS = new Set([
  ...ETF_CONTEXT_WORDS,
  'market', 'markets', 'investing', 'investment', 'investments', 'core', 'income', 'yield', 'growth',
  'portfolio', 'portfolios', 'strategy', 'strategies', 'themes', 'theme', 'building', 'blocks', 'compare',
  'comparison', 'risk', 'concentration', 'advisor', 'advisors', 'active', 'allocation', 'broad', 'broader',
]);
const TOPIC_DEDUPE_STOPWORDS = new Set([
  ...STOPWORDS,
  ...ACTION_WORDS,
  ...TITLE_PREFIX_SKIP_WORDS,
  'company', 'companies', 'business', 'market', 'markets', 'report', 'reports', 'reporting', 'reported',
  'news', 'week', 'weeks', 'day', 'days', 'month', 'months', 'year', 'years', 'today', 'latest', 'amid',
  'push', 'plan', 'plans', 'planned', 'allow', 'allows', 'open', 'opens', 'return', 'returns', 'returning',
  'head', 'heads', 'week', 'weeks', 'current', 'former', 'fresh', 'possible', 'others', 'other', 'people',
]);
const MONTH_NAME_TO_INDEX = new Map<string, number>([
  ['jan', 0], ['january', 0],
  ['feb', 1], ['february', 1],
  ['mar', 2], ['march', 2],
  ['apr', 3], ['april', 3],
  ['may', 4],
  ['jun', 5], ['june', 5],
  ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7],
  ['sep', 8], ['sept', 8], ['september', 8],
  ['oct', 9], ['october', 9],
  ['nov', 10], ['november', 10],
  ['dec', 11], ['december', 11],
]);

type RelevanceProfile = {
  symbol: string;
  companyName: string | null;
  alias: string | null;
  nameTokens: string[];
  keywordTokens: string[];
  ambiguousSingleTokenAlias: boolean;
  isEtf: boolean;
  broadMarketEtf: boolean;
  benchmarkPhrases: string[];
};

const ETF_BENCHMARK_PHRASES = [
  's p 500',
  'nasdaq 100',
  'dow jones',
  'dow 30',
  'russell 2000',
  'russell 1000',
  'midcap 400',
  'total stock market',
  'msci eafe',
  'msci emerging markets',
];

type InferredEtfHints = {
  isEtf: boolean;
  broadMarketEtf: boolean;
  benchmarkPhrases: string[];
};

function hasProfileEtfSignal(value: string | null): boolean {
  if (!value) return false;
  return /\b(etf|fund|trust|spdr|ishares|invesco|vanguard|proshares|direxion)\b/.test(value)
    || value.includes('select sector')
    || ETF_BENCHMARK_PHRASES.some((phrase) => value.includes(phrase));
}

function shouldInferEtfFromFeed(
  profile: CompanyProfile | null,
  companyName: string | null,
  description: string,
  sector: string,
  industry: string,
): boolean {
  if (profile?.is_etf === true) return false;
  if (!companyName) return true;

  const issuerOrBenchmarkText = `${companyName} ${description}`.trim();
  const hasIssuerHint = /\b(state street|spdr|ishares|invesco|vanguard|proshares|direxion)\b/.test(issuerOrBenchmarkText);
  const hasBenchmarkHint = issuerOrBenchmarkText.includes('select sector')
    || ETF_BENCHMARK_PHRASES.some((phrase) => issuerOrBenchmarkText.includes(phrase));
  const hasAssetManagementContext = sector.includes('financial services') && industry.includes('asset management');

  return hasIssuerHint || hasBenchmarkHint || hasAssetManagementContext;
}

function normalizeText(value: unknown): string {
  return typeof value === 'string'
    ? value
      .toLowerCase()
      .replace(/[®™]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
    : '';
}

function tokenize(value: unknown): string[] {
  const normalized = normalizeText(value);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(Boolean);
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function stripCorporateSuffixes(name: string): string {
  const tokens = tokenize(name).filter((token) => !CORPORATE_SUFFIXES.has(token));
  return tokens.join(' ').trim();
}

function buildKeywordTokens(profile: CompanyProfile | null): string[] {
  if (!profile) return [];
  const excludedTokens = new Set(
    typeof profile.company_name === 'string'
      ? tokenize(stripCorporateSuffixes(profile.company_name))
      : [],
  );
  const rawTokens = [
    ...tokenize(profile.description),
    ...tokenize(profile.industry),
    ...tokenize(profile.sector),
  ];

  return dedupe(
    rawTokens.filter((token) => {
      if (token.length < 3) return false;
      if (STOPWORDS.has(token) || CORPORATE_SUFFIXES.has(token)) return false;
      if (excludedTokens.has(token)) return false;
      return true;
    }),
  ).slice(0, 30);
}

function fuzzyTokenMatch(articleTokens: Set<string>, keyword: string): boolean {
  for (const token of articleTokens) {
    if (token === keyword) return true;
    if (token.length >= 5 && keyword.length >= 3 && token.startsWith(keyword)) return true;
    if (keyword.length >= 5 && token.length >= 3 && keyword.startsWith(token)) return true;
  }
  return false;
}

function findTokenSequenceIndexes(tokens: string[], phraseTokens: string[]): number[] {
  if (tokens.length === 0 || phraseTokens.length === 0 || phraseTokens.length > tokens.length) return [];
  const matches: number[] = [];
  for (let index = 0; index <= tokens.length - phraseTokens.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < phraseTokens.length; offset += 1) {
      if (tokens[index + offset] !== phraseTokens[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(index);
  }
  return matches;
}

function containsPhraseTokens(tokens: string[], phrase: string | null): boolean {
  if (!phrase) return false;
  return findTokenSequenceIndexes(tokens, tokenize(phrase)).length > 0;
}

function startsWithPhraseTokens(tokens: string[], phrase: string | null): boolean {
  if (!phrase) return false;
  return findTokenSequenceIndexes(tokens, tokenize(phrase)).includes(0);
}

function inferEtfProfileHints(symbol: string, items: NewsArticle[]): InferredEtfHints {
  const symbolToken = symbol.toLowerCase();
  const benchmarkPhrases = new Set<string>();
  let directEtfTitleHits = 0;
  let etfContextHits = 0;
  let sectorContextHits = 0;

  for (const item of items) {
    const text = normalizeText(`${item.title ?? ''} ${item.summary ?? item.text ?? item.snippet ?? ''}`);
    const titleTokens = tokenize(item.title);
    const textTokens = tokenize(text);
    const hasRawSymbolMatch = typeof item.symbol === 'string' && item.symbol.toUpperCase() === symbol.toUpperCase();
    const hasSymbolMention = hasRawSymbolMatch || titleTokens.includes(symbolToken) || textTokens.includes(symbolToken);

    if (!hasSymbolMention) continue;

    const hasEtfContext = textTokens.some((token) => ETF_CONTEXT_WORDS.has(token));
    const hasFundSpecificContext = textTokens.some((token) => ETF_FUND_SPECIFIC_CONTEXT_WORDS.has(token));
    const hasExchangeTaggedSymbol = text.includes(`nysearca ${symbolToken}`)
      || text.includes(`nasdaq ${symbolToken}`)
      || text.includes(`amex ${symbolToken}`);
    const hasSymbolLedEtfContext = titleTokens.includes(symbolToken)
      && titleTokens.some((token) => ETF_CONTEXT_WORDS.has(token) || SYMBOL_LED_ETF_CONTEXT_WORDS.has(token));

    if (hasEtfContext || hasFundSpecificContext || hasExchangeTaggedSymbol || hasSymbolLedEtfContext) {
      etfContextHits += 1;
    }
    if (hasExchangeTaggedSymbol || hasSymbolLedEtfContext) {
      directEtfTitleHits += 1;
    }
    const hasSectorEtfContext = text.includes('select sector')
      || text.includes('sector spdr')
      || text.includes('sector etf')
      || text.includes('sector fund');
    if (hasSectorEtfContext) {
      sectorContextHits += 1;
    }

    for (const phrase of ETF_BENCHMARK_PHRASES) {
      if (text.includes(phrase)) benchmarkPhrases.add(phrase);
    }
  }

  const inferredBenchmarkPhrases = Array.from(benchmarkPhrases);
  const isEtf = inferredBenchmarkPhrases.length > 0 || directEtfTitleHits > 0 || etfContextHits >= 2;
  const broadMarketEtf = inferredBenchmarkPhrases.length > 0 && sectorContextHits === 0;

  return {
    isEtf,
    broadMarketEtf,
    benchmarkPhrases: inferredBenchmarkPhrases,
  };
}

function buildRelevanceProfile(symbol: string, companyProfile: unknown, items: NewsArticle[]): RelevanceProfile {
  const profile = companyProfile != null && typeof companyProfile === 'object'
    ? companyProfile as CompanyProfile
    : null;
  const companyName = typeof profile?.company_name === 'string' ? normalizeText(profile.company_name) : null;
  const alias = companyName ? stripCorporateSuffixes(companyName) : null;
  const nameTokens = alias
    ? tokenize(alias).filter((token) => token.length >= 3 && !STOPWORDS.has(token))
    : [];
  const keywordTokens = buildKeywordTokens(profile);

  const description = typeof profile?.description === 'string' ? normalizeText(profile.description) : '';
  const industry = typeof profile?.industry === 'string' ? normalizeText(profile.industry) : '';
  const sector = typeof profile?.sector === 'string' ? normalizeText(profile.sector) : '';
  const profileEtfSignal = hasProfileEtfSignal(companyName)
    || hasProfileEtfSignal(description)
    || hasProfileEtfSignal(industry)
    || hasProfileEtfSignal(sector);
  const explicitEtf = profile?.is_etf === true || profileEtfSignal;
  const inferredEtfHints = shouldInferEtfFromFeed(profile, companyName, description, sector, industry)
    ? inferEtfProfileHints(symbol, items)
    : { isEtf: false, broadMarketEtf: false, benchmarkPhrases: [] };
  // Detect sector ETFs by checking whether the *name* contains "sector" — this
  // catches funds like "Financial Select Sector SPDR ETF" while allowing broad-
  // market ETFs whose descriptions merely mention the word "sectors" (e.g. SPY
  // describing "all eleven GICS sectors") to be classified as broadMarketEtf.
  const isSectorFundName = (companyName?.includes('sector') ?? false)
    || (companyName?.includes('select sector') ?? false);
  const explicitBroadMarketEtf = explicitEtf && !isSectorFundName;
  const isEtf = explicitEtf || inferredEtfHints.isEtf;
  const broadMarketEtf = explicitEtf ? explicitBroadMarketEtf : inferredEtfHints.broadMarketEtf;
  const benchmarkSourceText = `${companyName ?? ''} ${description}`.trim();
  const benchmarkPhrases = dedupe([
    ...ETF_BENCHMARK_PHRASES.filter((phrase) => benchmarkSourceText.includes(phrase)),
    ...inferredEtfHints.benchmarkPhrases,
  ]);

  return {
    symbol: symbol.toUpperCase(),
    companyName,
    alias,
    nameTokens,
    keywordTokens,
    ambiguousSingleTokenAlias: nameTokens.length === 1,
    isEtf,
    broadMarketEtf,
    benchmarkPhrases,
  };
}

function titleStartsWithAliasSignal(title: string, alias: string | null, keywordTokens: string[]): boolean {
  if (!alias) return false;
  const titleTokens = tokenize(title);
  const aliasTokens = tokenize(alias);
  const matchIndexes = findTokenSequenceIndexes(titleTokens, aliasTokens);
  if (!matchIndexes.includes(0)) return false;

  let nextIndex = aliasTokens.length;
  if (titleTokens[nextIndex] === 's') return true;
  while (nextIndex < titleTokens.length && CORPORATE_SUFFIXES.has(titleTokens[nextIndex])) {
    nextIndex += 1;
  }
  for (let offset = nextIndex; offset < Math.min(titleTokens.length, nextIndex + 4); offset += 1) {
    const token = titleTokens[offset];
    if (/^\d+$/.test(token) || TITLE_PREFIX_SKIP_WORDS.has(token)) continue;
    return ACTION_WORDS.has(token) || CONTEXT_WORDS.has(token) || keywordTokens.includes(token);
  }
  return false;
}

function hasAliasContextSignal(tokens: string[], alias: string | null, keywordTokens: string[]): boolean {
  if (!alias) return false;
  const aliasTokens = tokenize(alias);
  const matchIndexes = findTokenSequenceIndexes(tokens, aliasTokens);
  if (matchIndexes.length === 0) return false;

  for (const start of matchIndexes) {
    const end = start + aliasTokens.length - 1;
    const windowStart = Math.max(0, start - 2);
    const windowEnd = Math.min(tokens.length - 1, end + 2);
    for (let index = windowStart; index <= windowEnd; index += 1) {
      if (index >= start && index <= end) continue;
      const token = tokens[index];
      if (token === 's') continue;
      if (CONTEXT_WORDS.has(token) || keywordTokens.includes(token)) return true;
    }
  }

  return false;
}

function getSummary(article: NewsArticle): string {
  const summary = typeof article.summary === 'string'
    ? article.summary
    : typeof article.text === 'string'
      ? article.text
      : typeof article.snippet === 'string'
        ? article.snippet
        : '';
  return summary.length > 240 ? `${summary.slice(0, 240)}...` : summary;
}

function isFilingStyleArticle(article: NewsArticle): boolean {
  const title = normalizeText(article.title);
  const summary = normalizeText(article.summary ?? article.text ?? article.snippet);
  const source = normalizeText(article.source);
  const text = `${title} ${summary}`.trim();

  if (FILING_STYLE_TITLE_PHRASES.some((phrase) => title.includes(phrase))) return true;
  if (FILING_STYLE_TEXT_PHRASES.some((phrase) => text.includes(phrase))) return true;
  if (source.includes('defenseworld') && text.includes('securities and exchange commission')) return true;
  if ((title.includes('director') || summary.includes('director') || title.includes('officer') || summary.includes('officer') || title.includes('insider'))
    && (title.includes('sold') || title.includes('sells') || title.includes('bought') || title.includes('buys') || title.includes('shares'))) {
    return true;
  }
  if (source.includes('defenseworld') && (title.includes('stock') || title.includes('shares'))) return true;

  return false;
}

function isAnalystOrValuationCommentary(article: NewsArticle): boolean {
  const title = normalizeText(article.title);
  const summary = normalizeText(article.summary ?? article.text ?? article.snippet);
  const source = normalizeText(article.source);
  const url = normalizeText(article.url);
  const text = `${title} ${summary}`.trim();

  const commentarySource = COMMENTARY_SOURCE_HINTS.some((hint) => source.includes(hint) || url.includes(hint));
  if (!commentarySource) return false;

  return ANALYST_OR_VALUATION_PHRASES.some((phrase) => text.includes(phrase));
}

function normalizedArticleUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url);
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return normalizeText(url);
  }
}

function parseBusinessWireTimestampMs(url: unknown): number | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  const match = url.match(/businesswire\.com\/news\/home\/(\d{8})/i);
  if (!match) return null;
  const value = match[1];
  const year = Number.parseInt(value.slice(0, 4), 10);
  const month = Number.parseInt(value.slice(4, 6), 10);
  const day = Number.parseInt(value.slice(6, 8), 10);
  const parsed = Date.UTC(year, month - 1, day);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDatelineTimestampMs(value: unknown): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const match = value.match(/\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2}),\s+(20\d{2})\b/i);
  if (!match) return null;
  const monthKey = match[1].replace(/\./g, '').toLowerCase();
  const monthIndex = MONTH_NAME_TO_INDEX.get(monthKey);
  if (monthIndex == null) return null;
  const day = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  const parsed = Date.UTC(year, monthIndex, day);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferArticleTimestampMs(article: NewsArticle): number | null {
  return parseBusinessWireTimestampMs(article.url)
    ?? parseDatelineTimestampMs(article.summary)
    ?? parseDatelineTimestampMs(article.text)
    ?? parseDatelineTimestampMs(article.snippet)
    ?? parseDatelineTimestampMs(article.title);
}

function parseArticleTimestampMs(article: NewsArticle): number | null {
  const rawValue = article.published_date ?? article.date ?? article.publishedDate;
  if (typeof rawValue === 'string' && rawValue.trim()) {
    const parsed = Date.parse(rawValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  return inferArticleTimestampMs(article);
}

function resolvedArticleDate(article: NewsArticle): string | undefined {
  const explicit = article.published_date || article.date || article.publishedDate;
  if (typeof explicit === 'string' && explicit.trim()) return explicit;
  const inferredMs = inferArticleTimestampMs(article);
  return inferredMs != null ? new Date(inferredMs).toISOString() : undefined;
}

function relativeArticleAgeDays(publishedMs: number | null, freshestMs: number | null): number | null {
  if (publishedMs == null || freshestMs == null || publishedMs > freshestMs) return null;
  return (freshestMs - publishedMs) / 86400000;
}

function freshnessAdjustment(article: NewsArticle, freshestMs: number | null): number {
  const ageDays = relativeArticleAgeDays(parseArticleTimestampMs(article), freshestMs);
  if (ageDays == null) return 0;

  let adjustment = 0;
  if (ageDays <= 1) adjustment += 8;
  else if (ageDays <= 3) adjustment += 5;
  else if (ageDays <= 7) adjustment += 2;
  else if (ageDays > 45) adjustment -= 24;
  else if (ageDays > 21) adjustment -= 14;
  else if (ageDays > 10) adjustment -= 6;

  if (article.is_press_release) {
    if (ageDays > 21) adjustment -= 18;
    else if (ageDays > 10) adjustment -= 8;
  }

  return adjustment;
}

type ScoredArticle = {
  article: NewsArticle;
  score: number;
  sortScore: number;
  filingStyle: boolean;
  lowSignal: boolean;
  stalePressRelease: boolean;
  titleReference: boolean;
  publishedMs: number | null;
};

function normalizeTopicToken(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function buildTopicTokens(article: NewsArticle, profile: RelevanceProfile): string[] {
  const companyTokens = new Set([
    profile.symbol.toLowerCase(),
    ...tokenize(profile.companyName).map(normalizeTopicToken),
    ...tokenize(profile.alias).map(normalizeTopicToken),
  ]);

  return tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`)
    .map((token) => normalizeTopicToken(token))
    .filter((token) => {
      if (token.length < 3) return false;
      if (companyTokens.has(token)) return false;
      if (CORPORATE_SUFFIXES.has(token) || TOPIC_DEDUPE_STOPWORDS.has(token)) return false;
      return true;
    });
}

function buildTopicBigrams(article: NewsArticle, profile: RelevanceProfile): string[] {
  const tokens = buildTopicTokens(article, profile);
  const bigrams: string[] = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    const left = tokens[index];
    const right = tokens[index + 1];
    if (left === right) continue;
    bigrams.push(`${left} ${right}`);
  }
  return dedupe(bigrams);
}

function sharedCount(left: Iterable<string>, right: Set<string>): number {
  let count = 0;
  for (const value of left) {
    if (right.has(value)) count += 1;
  }
  return count;
}

function isNearDuplicateArticle(left: ScoredArticle, right: ScoredArticle, profile: RelevanceProfile): boolean {
  if (left.article.url && right.article.url && normalizedArticleUrl(left.article.url) === normalizedArticleUrl(right.article.url)) {
    return true;
  }

  const leftTitle = normalizeText(left.article.title);
  const rightTitle = normalizeText(right.article.title);
  if (leftTitle && rightTitle && leftTitle === rightTitle) return true;

  if (left.publishedMs != null && right.publishedMs != null) {
    const ageGapDays = Math.abs(left.publishedMs - right.publishedMs) / 86400000;
    if (ageGapDays > 10) return false;
  }

  const leftTokens = new Set(buildTopicTokens(left.article, profile));
  const rightTokens = new Set(buildTopicTokens(right.article, profile));
  const leftBigrams = new Set(buildTopicBigrams(left.article, profile));
  const rightBigrams = new Set(buildTopicBigrams(right.article, profile));
  const sharedTokens = sharedCount(leftTokens, rightTokens);
  const sharedBigrams = sharedCount(leftBigrams, rightBigrams);

  // ETFs — articles within a single sector or market naturally share
  // many topic tokens (energy terms, semiconductor terms, etc.).
  // Use proportional overlap so genuinely different stories survive.
  // Broad-market ETFs get the loosest threshold since ALL macro articles
  // share tokens like "correction", "rate", "war".
  if (profile.isEtf) {
    const minTokenCount = Math.min(leftTokens.size, rightTokens.size);
    const overlapRatio = minTokenCount > 0 ? sharedTokens / minTokenCount : 0;
    if (profile.broadMarketEtf) {
      if (sharedBigrams >= 4 && overlapRatio >= 0.4) return true;
      if (overlapRatio >= 0.6) return true;
    } else {
      if (sharedBigrams >= 3 && overlapRatio >= 0.35) return true;
      if (overlapRatio >= 0.5) return true;
    }
    return false;
  }

  if (sharedBigrams >= 2) return true;
  if (sharedBigrams >= 1 && sharedTokens >= 3) return true;
  if (sharedTokens >= 6) return true;

  return false;
}

function selectUniqueArticles(
  entries: ScoredArticle[],
  maxResults: number,
  profile: RelevanceProfile,
): { selected: ScoredArticle[]; nearDuplicateCount: number } {
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const selected: ScoredArticle[] = [];
  let nearDuplicateCount = 0;

  for (const entry of entries) {
    const titleKey = normalizeText(entry.article.title);
    const urlKey = normalizedArticleUrl(entry.article.url);

    if (titleKey && seenTitles.has(titleKey)) continue;
    if (urlKey && seenUrls.has(urlKey)) continue;
    if (selected.some((existing) => isNearDuplicateArticle(existing, entry, profile))) {
      nearDuplicateCount += 1;
      continue;
    }

    if (titleKey) seenTitles.add(titleKey);
    if (urlKey) seenUrls.add(urlKey);
    selected.push(entry);
    if (selected.length >= maxResults) break;
  }

  return { selected, nearDuplicateCount };
}

function hasEtfTitleContext(tokens: string[], profile: RelevanceProfile): boolean {
  if (!profile.isEtf) return false;
  if (tokens.some((token) => ETF_CONTEXT_WORDS.has(token))) return true;

  const articleTokens = new Set(tokens);
  const matchedNameTokens = profile.nameTokens.filter((token) => !/^\d+$/.test(token) && articleTokens.has(token)).length;
  const matchedKeywordTokens = profile.keywordTokens.filter((token) => !/^\d+$/.test(token) && articleTokens.has(token)).length;
  return matchedNameTokens > 0 || matchedKeywordTokens > 0;
}

function countDistinctiveEtfTitleMatches(tokens: string[], profile: RelevanceProfile): number {
  const articleTokens = new Set(tokens);
  const matched = new Set<string>();

  for (const token of profile.nameTokens) {
    if (/^\d+$/.test(token)) continue;
    if (GENERIC_ETF_REFERENCE_TOKENS.has(token)) continue;
    if (articleTokens.has(token)) matched.add(token);
  }
  for (const token of profile.keywordTokens) {
    if (/^\d+$/.test(token)) continue;
    if (GENERIC_ETF_REFERENCE_TOKENS.has(token)) continue;
    if (articleTokens.has(token)) matched.add(token);
  }

  return matched.size;
}

function hasOtherTickerHeadlinePrefix(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.isEtf || typeof article.title !== 'string') return false;
  const match = article.title.trim().match(/^([A-Z]{2,6})(?=:\s)/);
  return !!match && match[1] !== profile.symbol;
}

function hasStrongEtfTitleReference(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.isEtf) return true;
  const titleTokens = tokenize(article.title);
  const combinedTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  const normalizedTitle = normalizeText(article.title);
  const titleStartsWithSymbol = titleTokens[0] === profile.symbol.toLowerCase();
  const hasSymbolLedEtfContext = titleTokens.some((token) => SYMBOL_LED_ETF_CONTEXT_WORDS.has(token));
  const hasFundSpecificContext = combinedTokens.some((token) => ETF_FUND_SPECIFIC_CONTEXT_WORDS.has(token));
  const hasExchangeTaggedSymbol = normalizedTitle.includes(`nysearca ${profile.symbol.toLowerCase()}`)
    || normalizedTitle.includes(`nasdaq ${profile.symbol.toLowerCase()}`)
    || normalizedTitle.includes(`amex ${profile.symbol.toLowerCase()}`);
  if (startsWithCompanyReference(titleTokens, profile)) return true;
  if (hasCompanyReference(titleTokens, profile) && hasFundSpecificContext) return true;
  if (profile.nameTokens.length === 0 && profile.keywordTokens.length === 0) {
    if (hasExchangeTaggedSymbol) return true;
    if (titleTokens.includes(profile.symbol.toLowerCase()) && hasEtfTitleContext(titleTokens, profile)) return true;
  }
  if (titleStartsWithSymbol) {
    return hasEtfTitleContext(combinedTokens, profile)
      || hasSymbolLedEtfContext
      || hasFundSpecificContext
      || countDistinctiveEtfTitleMatches(combinedTokens, profile) > 0;
  }
  if (!hasEtfTitleContext(titleTokens, profile)) return false;
  return hasFundSpecificContext || countDistinctiveEtfTitleMatches(combinedTokens, profile) > 0;
}

function isIndirectEcosystemMentionArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (article.is_press_release) return false;

  const titleTokens = tokenize(article.title);
  const startsWithReference = startsWithCompanyReference(titleTokens, profile);
  const symbolIndex = titleTokens.indexOf(profile.symbol.toLowerCase());
  const hasLeadingReference = startsWithReference || symbolIndex === 0;
  if (!hasLeadingReference) return false;

  const referenceEndIndex = startsWithReference
    ? Math.max(tokenize(profile.companyName).length, tokenize(profile.alias).length, 1) - 1
    : symbolIndex;
  const nextToken = titleTokens[referenceEndIndex + 1];
  if (nextToken === 'backed') return true;

  const title = normalizeText(article.title);
  return title.includes('backed startup') || title.includes('backed company');
}

function isEtfComparisonListicle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.isEtf) return false;

  const title = normalizeText(article.title);
  const titleTokens = tokenize(article.title);
  const startsWithReference = startsWithCompanyReference(titleTokens, profile) || titleTokens[0] === profile.symbol.toLowerCase();
  const hasQuestionOrCompareSignal = title.includes('?')
    || title.includes(' vs ')
    || title.includes(' compared ')
    || title.includes(' compare ')
    || ETF_COMPARISON_TITLE_PHRASES.some((phrase) => title.includes(phrase));

  const otherTickerLikeSymbols = typeof article.title === 'string'
    ? dedupe(
      (article.title.match(/\b[A-Z]{2,5}\b/g) ?? [])
        .filter((token) => token !== profile.symbol)
        .filter((token) => !TICKER_LIKE_TITLE_SKIP_TOKENS.has(token)),
    )
    : [];
  const hasGenericComparisonSignal = otherTickerLikeSymbols.length > 0
    && COMPARISON_SIGNAL_TITLE_PHRASES.some((phrase) => title.includes(phrase));

  if (!hasQuestionOrCompareSignal && !hasGenericComparisonSignal) return false;

  const hasDescriptiveLead = startsWithReference
    && titleTokens.some((token) => SYMBOL_LED_ETF_CONTEXT_WORDS.has(token) || ACTION_WORDS.has(token));

  if (hasDescriptiveLead && !title.includes(' vs ') && !title.includes(' compared ')) return false;
  return true;
}

function isDirectEtfLeadArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.isEtf) return false;

  const titleTokens = tokenize(article.title);
  const startsWithReference = startsWithCompanyReference(titleTokens, profile) || titleTokens[0] === profile.symbol.toLowerCase();
  if (!startsWithReference) return false;
  if (!hasStrongEtfTitleReference(article, profile)) return false;
  if (isEtfComparisonListicle(article, profile)) return false;
  return true;
}

function isFundSpecificEtfArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.isEtf) return false;

  const titleTokens = tokenize(article.title);
  const textTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  if (!hasCompanyReference(textTokens, profile)) return false;
  if (!hasCompanyReference(titleTokens, profile) && !hasStrongEtfTitleReference(article, profile)) return false;
  if (!textTokens.some((token) => ETF_FUND_SPECIFIC_CONTEXT_WORDS.has(token))) return false;
  if (isEtfComparisonListicle(article, profile)) return false;

  return true;
}

function isBroadMarketEtfBenchmarkArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.broadMarketEtf || profile.benchmarkPhrases.length === 0) return false;
  if (isEtfComparisonListicle(article, profile)) return false;

  const text = normalizeText(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  return profile.benchmarkPhrases.some((phrase) => text.includes(phrase));
}

function isBroadMarketBenchmarkMacroArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!profile.broadMarketEtf || profile.benchmarkPhrases.length === 0) return false;
  if (isEtfComparisonListicle(article, profile) || hasOtherTickerHeadlinePrefix(article, profile)) return false;

  const title = normalizeText(article.title);
  const titleTokens = tokenize(article.title);
  const textTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  const text = normalizeText(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  if (!profile.benchmarkPhrases.some((phrase) => text.includes(phrase))) return false;
  if (BROAD_MARKET_LOW_SIGNAL_TITLE_PHRASES.some((phrase) => title.includes(phrase))) return false;

  const hasDirectBenchmarkTitle = hasCompanyReference(titleTokens, profile) || hasBenchmarkPhrase(title, profile);
  const hasMacroContext = textTokens.some((token) => BROAD_MARKET_MACRO_CONTEXT_WORDS.has(token));
  if (hasDirectBenchmarkTitle && hasMacroContext) return true;
  if (hasDirectBenchmarkTitle && sourceScoreAdjustment(article) >= 10) return true;

  return sourceScoreAdjustment(article) >= 10 && hasMacroContext;
}

function isDirectOperatingArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  const titleTokens = tokenize(article.title);
  const textTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  const symbolIndex = titleTokens.indexOf(profile.symbol.toLowerCase());
  const hasLeadingReference = startsWithCompanyReference(titleTokens, profile) || symbolIndex === 0;
  if (!hasLeadingReference) return false;
  if (isSecondaryTitleMentionArticle(article, profile)) return false;
  if (isIndirectEcosystemMentionArticle(article, profile)) return false;

  const hasActionWord = textTokens.some((token) => ACTION_WORDS.has(token));
  const hasContextWord = textTokens.some((token) => CONTEXT_WORDS.has(token) || profile.keywordTokens.includes(token));
  return hasActionWord || hasContextWord;
}

function isLowSignalArticle(article: NewsArticle, profile?: RelevanceProfile): boolean {
  if (profile?.broadMarketEtf && isBroadMarketBenchmarkMacroArticle(article, profile)) return false;
  if (profile?.isEtf && isFundSpecificEtfArticle(article, profile)) return false;

  const title = normalizeText(article.title);
  const summary = normalizeText(article.summary ?? article.text ?? article.snippet);
  const source = normalizeText(article.source);
  const url = normalizeText(article.url);
  const titleTokens = tokenize(article.title);
  const hasSymbolLedEtfContext = profile?.isEtf
    && (titleTokens[0] === profile.symbol.toLowerCase() || startsWithCompanyReference(titleTokens, profile))
    && titleTokens.some((token) => SYMBOL_LED_ETF_CONTEXT_WORDS.has(token));

  if (LOW_SIGNAL_TITLE_PHRASES.some((phrase) => title.includes(phrase))) return true;
  if (LOW_SIGNAL_SUMMARY_PHRASES.some((phrase) => summary.includes(phrase))) return true;
  if (LOW_SIGNAL_SOURCE_HINTS.some((hint) => source.includes(hint))) return true;
  if (article.is_press_release && LEGAL_PRESS_RELEASE_TITLE_PHRASES.some((phrase) => title.includes(phrase) || summary.includes(phrase))) return true;
  if (profile && hasOtherTickerHeadlinePrefix(article, profile)) return true;
  if (isAnalystOrValuationCommentary(article)) return true;
  if (profile && isEtfComparisonListicle(article, profile)) return true;
  if (profile?.isEtf && titleTokens.includes(profile.symbol.toLowerCase()) && !hasStrongEtfTitleReference(article, profile)) return true;
  if (profile?.isEtf && hasCompanyReference(titleTokens, profile) && !hasEtfTitleContext(titleTokens, profile) && !hasSymbolLedEtfContext) return true;
  if (profile && isIndirectEcosystemMentionArticle(article, profile)) return true;

  for (const pattern of LOW_SIGNAL_SOURCE_PATTERNS) {
    if (!source.includes(pattern.sourceHint) && !url.includes(pattern.sourceHint)) continue;
    if (pattern.titleHints.some((phrase) => title.includes(phrase) || summary.includes(phrase) || url.includes(phrase.replace(/ /g, '_')))) {
      return true;
    }
  }

  if (source.includes('zacks com') && (url.includes('quick_take') || url.includes('analyst_blog'))) return true;

  return false;
}

function hasCompanyReference(tokens: string[], profile: RelevanceProfile): boolean {
  return tokens.includes(profile.symbol.toLowerCase())
    || containsPhraseTokens(tokens, profile.companyName)
    || containsPhraseTokens(tokens, profile.alias);
}

function firstCompanyReferenceIndex(tokens: string[], profile: RelevanceProfile): number | null {
  const indexes: number[] = [];
  const symbolIndex = tokens.indexOf(profile.symbol.toLowerCase());
  if (symbolIndex >= 0) indexes.push(symbolIndex);
  indexes.push(...findTokenSequenceIndexes(tokens, tokenize(profile.companyName)));
  indexes.push(...findTokenSequenceIndexes(tokens, tokenize(profile.alias)));
  if (indexes.length === 0) return null;
  return Math.min(...indexes);
}

function startsWithCompanyReference(tokens: string[], profile: RelevanceProfile): boolean {
  return tokens[0] === profile.symbol.toLowerCase()
    || startsWithPhraseTokens(tokens, profile.companyName)
    || startsWithPhraseTokens(tokens, profile.alias);
}

function isIndirectThirdPartyPressRelease(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (!article.is_press_release) return false;

  const titleTokens = tokenize(article.title);
  const textTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);
  const startsWithCompany = startsWithCompanyReference(titleTokens, profile);
  const hasCompanyMention = hasCompanyReference(textTokens, profile);

  return hasCompanyMention && !startsWithCompany;
}

function isIndirectMentionArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (article.is_press_release) return false;

  const titleTokens = tokenize(article.title);
  const textTokens = tokenize(`${article.title ?? ''} ${article.summary ?? article.text ?? article.snippet ?? ''}`);

  if (!hasCompanyReference(textTokens, profile)) return false;
  if (hasCompanyReference(titleTokens, profile)) return false;
  // For broad-market ETFs, a benchmark phrase in the title (e.g. "S&P 500") counts
  // as a direct reference — don't treat these as indirect mentions.
  if (profile.broadMarketEtf && hasBenchmarkPhrase(normalizeText(article.title), profile)) return false;
  return true;
}

function isSecondaryTitleMentionArticle(article: NewsArticle, profile: RelevanceProfile): boolean {
  if (article.is_press_release) return false;
  // For broad-market ETFs, benchmark-led titles are direct references
  if (profile.broadMarketEtf && hasBenchmarkPhrase(normalizeText(article.title), profile)) return false;

  const title = normalizeText(article.title);
  const titleTokens = tokenize(article.title);
  if (!hasCompanyReference(titleTokens, profile)) return false;
  if (startsWithCompanyReference(titleTokens, profile)) return false;
  if (hasAliasContextSignal(titleTokens, profile.alias, profile.keywordTokens)) return false;
  if (titleStartsWithAliasSignal(title, profile.alias, profile.keywordTokens)) return false;
  const firstReferenceIndex = firstCompanyReferenceIndex(titleTokens, profile);
  if (
    firstReferenceIndex != null
    && firstReferenceIndex > 2
  ) {
    const postContextTokens = titleTokens.slice(firstReferenceIndex + 1, firstReferenceIndex + 5);
    const hasStrongPostContext = postContextTokens.some((token) =>
      CONTEXT_WORDS.has(token) || profile.keywordTokens.includes(token),
    );
    if (!hasStrongPostContext) return true;
  }

  return SECONDARY_TITLE_MENTION_PHRASES.some((phrase) => title.includes(phrase));
}

function isStalePressRelease(article: NewsArticle, freshestMs: number | null): boolean {
  if (!article.is_press_release) return false;
  const ageDays = relativeArticleAgeDays(parseArticleTimestampMs(article), freshestMs);
  return ageDays != null && ageDays > 10;
}

function sourceScoreAdjustment(article: NewsArticle): number {
  const source = normalizeText(article.source);
  const url = normalizeText(article.url);

  let adjustment = 0;
  for (const entry of SOURCE_SCORE_ADJUSTMENTS) {
    if (source.includes(entry.hint) || url.includes(entry.hint)) adjustment += entry.delta;
  }
  return adjustment;
}

function hasBenchmarkPhrase(value: string, profile: RelevanceProfile): boolean {
  return profile.benchmarkPhrases.some((phrase) => value.includes(phrase));
}

export function scoreNewsArticle(article: unknown, profile: RelevanceProfile): number {
  if (article == null || typeof article !== 'object') return Number.NEGATIVE_INFINITY;
  const item = article as NewsArticle;
  const title = normalizeText(item.title);
  const summary = normalizeText(item.summary ?? item.text ?? item.snippet);
  const text = `${title} ${summary}`.trim();
  const textTokens = tokenize(text);
  const articleTokens = new Set(textTokens);
  const titleTokens = tokenize(item.title);
  const hasSymbolMatch = typeof item.symbol === 'string' && item.symbol.toUpperCase() === profile.symbol;
  const hasSymbolMention = articleTokens.has(profile.symbol.toLowerCase());
  const hasCompanyName = containsPhraseTokens(textTokens, profile.companyName);
  const hasAliasMention = containsPhraseTokens(textTokens, profile.alias);
  const hasTitleAliasSignal = titleStartsWithAliasSignal(title, profile.alias, profile.keywordTokens);
  const hasAliasContext = hasAliasContextSignal(textTokens, profile.alias, profile.keywordTokens);
  const hasEtfContextInTitle = profile.isEtf && hasEtfTitleContext(titleTokens, profile);
  const hasExactSymbolTokenInTitle = titleTokens.includes(profile.symbol.toLowerCase());
  const titleStartsWithSymbol = titleTokens[0] === profile.symbol.toLowerCase();
  const hasBenchmarkReference = hasBenchmarkPhrase(text, profile);

  let score = 0;

  if (hasSymbolMatch) score += 80;
  if (hasSymbolMention) score += 60;
  if (hasCompanyName) score += 55;
  if (hasAliasMention) score += profile.ambiguousSingleTokenAlias ? 6 : 12;
  if (hasTitleAliasSignal) score += 25;
  if (hasAliasContext) score += 20;
  if (hasEtfContextInTitle) score += 18;
  if (profile.broadMarketEtf && hasBenchmarkPhrase(title, profile)) score += 26;
  else if (profile.broadMarketEtf && hasBenchmarkPhrase(text, profile)) score += 14;

  const matchedNameTokens = profile.nameTokens.filter((token) => fuzzyTokenMatch(articleTokens, token)).length;
  score += profile.ambiguousSingleTokenAlias
    ? Math.min(matchedNameTokens * 6, 8)
    : Math.min(matchedNameTokens * 8, 16);

  const matchedKeywordTokens = profile.keywordTokens.filter((token) => fuzzyTokenMatch(articleTokens, token)).length;
  score += Math.min(matchedKeywordTokens * 6, 24);

  const hasActionWord = Array.from(articleTokens).some((token) => ACTION_WORDS.has(token));
  if (hasActionWord && (matchedKeywordTokens > 0 || hasTitleAliasSignal || hasAliasContext || hasCompanyName || hasSymbolMention || hasSymbolMatch)) {
    score += 8;
  }

  for (const phrase of NEGATIVE_PHRASES) {
    if (text.includes(phrase)) score -= 30;
  }

  if (
    profile.ambiguousSingleTokenAlias
    && hasAliasMention
    && matchedKeywordTokens === 0
    && !hasTitleAliasSignal
    && !hasAliasContext
    && !hasCompanyName
    && !hasSymbolMention
    && !hasSymbolMatch
  ) {
    score -= 20;
  }

  if (profile.isEtf && hasExactSymbolTokenInTitle && !hasEtfContextInTitle) {
    score -= 40;
  }
  if (profile.isEtf && titleStartsWithSymbol && !hasEtfContextInTitle && matchedNameTokens === 0 && matchedKeywordTokens === 0) {
    score -= 60;
  }
  if (profile.isEtf && hasSymbolMatch && !hasCompanyReference(textTokens, profile) && !hasBenchmarkReference && !hasStrongEtfTitleReference(item, profile)) {
    score -= 90;
  }

  score += sourceScoreAdjustment(item);

  return score;
}

function trimArticle(article: NewsArticle): Record<string, unknown> {
  return {
    title: article.title,
    date: resolvedArticleDate(article),
    source: article.source,
    url: article.url,
    is_press_release: article.is_press_release,
    summary: getSummary(article),
  };
}

export function shapeNewsResponse(symbol: string, payload: unknown, companyProfile?: unknown): unknown {
  const items: NewsArticle[] = Array.isArray(payload)
    ? payload as NewsArticle[]
    : payload && typeof payload === 'object' && Array.isArray((payload as NewsResponse).results)
      ? (payload as NewsResponse).results as NewsArticle[]
      : [];
  const profile = buildRelevanceProfile(symbol, companyProfile, items);
  const freshestMs = items
    .map((article) => parseArticleTimestampMs(article))
    .reduce<number | null>((latest, value) => {
      if (value == null) return latest;
      if (latest == null || value > latest) return value;
      return latest;
    }, null);

  const scored = items
    .map((article) => {
      const score = scoreNewsArticle(article, profile);
      const stalePressRelease = isStalePressRelease(article, freshestMs);
      const fundSpecificEtf = profile.isEtf && isFundSpecificEtfArticle(article, profile);
      return {
        article,
        score,
        sortScore: score + freshnessAdjustment(article, freshestMs),
        filingStyle: isFilingStyleArticle(article),
        lowSignal: isLowSignalArticle(article, profile)
        || isIndirectThirdPartyPressRelease(article, profile)
        || isIndirectMentionArticle(article, profile)
        || (!fundSpecificEtf && isSecondaryTitleMentionArticle(article, profile))
        || stalePressRelease,
        stalePressRelease,
        titleReference: hasCompanyReference(tokenize(article.title), profile),
        publishedMs: parseArticleTimestampMs(article),
      };
    })
    .sort((left, right) =>
      right.sortScore - left.sortScore
      || (right.publishedMs ?? Number.NEGATIVE_INFINITY) - (left.publishedMs ?? Number.NEGATIVE_INFINITY)
      || right.score - left.score
    );

  const filtered = scored.filter((entry) => entry.score >= MIN_RELEVANCE_SCORE);
  const filteredPrimary = filtered.filter((entry) => !entry.filingStyle && !entry.lowSignal);
  const filteredEtfFundSpecific = profile.isEtf
    ? filteredPrimary.filter((entry) => isFundSpecificEtfArticle(entry.article, profile))
    : [];
  const filteredDirectOperating = filteredPrimary.filter((entry) => isDirectOperatingArticle(entry.article, profile));
  const filteredEtfLead = profile.isEtf
    ? filtered.filter((entry) => !entry.filingStyle && isDirectEtfLeadArticle(entry.article, profile))
    : [];
  const filteredBroadMarketEtfMacro = profile.broadMarketEtf
    ? filteredPrimary.filter((entry) => isBroadMarketBenchmarkMacroArticle(entry.article, profile))
    : [];
  const filteredBroadMarketEtfBenchmark = profile.broadMarketEtf
    ? filteredPrimary.filter((entry) => isBroadMarketEtfBenchmarkArticle(entry.article, profile))
    : [];
  const filteredPrimaryTitleReferenced = filteredPrimary.filter((entry) => entry.titleReference);
  const filteredEtfPrimary = profile.isEtf
    ? filteredPrimary.filter((entry) => hasStrongEtfTitleReference(entry.article, profile))
    : [];
  const filteredEtfNonFiling = profile.isEtf
    ? filtered.filter((entry) =>
      !entry.filingStyle && hasStrongEtfTitleReference(entry.article, profile))
    : [];
  const filteredNonFiling = filtered.filter((entry) => !entry.filingStyle);
  // Don't prefer a narrow ETF pool over a much richer general pool.
  // When filteredPrimary is large (>= 6 articles), require the ETF
  // pool to have at least 3 articles before choosing it; otherwise a
  // single-article ETF pool can crowd out a diverse general feed.
  // For small feeds (< 6 articles), any non-empty pool is acceptable.
  const etfMinPool = filteredPrimary.length >= 6 ? 3 : 1;
  const okPool = (pool: ScoredArticle[]) => pool.length >= etfMinPool;

  const selectedPool = okPool(filteredBroadMarketEtfMacro)
    ? filteredBroadMarketEtfMacro
    : okPool(filteredEtfFundSpecific)
      ? filteredEtfFundSpecific
      : okPool(filteredEtfLead)
        ? filteredEtfLead
        : okPool(filteredBroadMarketEtfBenchmark)
          ? filteredBroadMarketEtfBenchmark
          : okPool(filteredEtfPrimary)
            ? filteredEtfPrimary
            : okPool(filteredEtfNonFiling)
              ? filteredEtfNonFiling
              : filteredDirectOperating.length > 0
                ? filteredDirectOperating
                : filteredPrimaryTitleReferenced.length > 0
                  ? filteredPrimaryTitleReferenced
                  : filteredPrimary.length > 0
                    ? filteredPrimary
                    : filteredNonFiling.length > 0
                      ? filteredNonFiling
                      : filtered.length > 0
                        ? filtered
                        : scored;
  const { selected, nearDuplicateCount } = selectUniqueArticles(selectedPool, MAX_RESULTS, profile);
  const trimmed = selected.map(({ article }) => trimArticle(article));
  const filingStyleOmitted = filtered.length > 0
    ? filtered.filter((entry) => entry.filingStyle).length
    : 0;
  const stalePressReleaseOmitted = filteredPrimary.length > 0
    ? filtered.filter((entry) => entry.stalePressRelease).length
    : 0;
  const lowSignalOmitted = filteredPrimary.length > 0
    ? filtered.filter((entry) => entry.lowSignal && !entry.stalePressRelease).length
    : 0;

  if (Array.isArray(payload)) {
    return trimmed;
  }

  if (payload && typeof payload === 'object') {
    const response = payload as NewsResponse;
    response.results = trimmed;
    const meta: Record<string, unknown> = {};
    if (items.length > trimmed.length) {
      meta.showing = trimmed.length;
      meta.total = items.length;
      meta.relevanceRanked = filtered.length > 0;
    }
    if (nearDuplicateCount > 0) meta.nearDuplicatesCollapsed = nearDuplicateCount;
    if (filingStyleOmitted > 0 && filteredNonFiling.length > 0) meta.filingStyleOmitted = filingStyleOmitted;
    if (stalePressReleaseOmitted > 0) meta.stalePressReleaseOmitted = stalePressReleaseOmitted;
    if (lowSignalOmitted > 0) meta.lowSignalOmitted = lowSignalOmitted;
    if (Object.keys(meta).length > 0) response._results_meta = meta;
    return response;
  }

  return trimmed;
}
