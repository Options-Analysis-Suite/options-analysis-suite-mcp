/**
 * Tool Registry
 *
 * Registers all MCP tools on the server.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AccessTokenProvider, ProxyClient } from '../proxy/proxyClient.js';
import type { LiveApiClient } from '../proxy/liveApiClient.js';

// Market data tools
import { register as ivHistory } from './market/ivHistory.js';
import { register as greeksHistory } from './market/greeksHistory.js';
import { register as regime } from './market/regime.js';
import { register as earnings } from './market/earnings.js';
import { register as news } from './market/news.js';
import { register as fundamentals } from './market/fundamentals.js';
import { register as dividends } from './market/dividends.js';
import { register as rates } from './market/rates.js';
import { register as insiderTrading } from './market/insiderTrading.js';
import { register as institutionalOwnership } from './market/institutionalOwnership.js';
import { register as congressTrades } from './market/congressTrades.js';
import { register as optionsAnalyticsHistory } from './market/optionsAnalyticsHistory.js';
import { register as ivSurface } from './market/ivSurface.js';
import { register as stockPrices } from './market/stockPrices.js';
import { register as stockSplits } from './market/stockSplits.js';
import { register as shortData } from './market/shortData.js';
import { register as analystData } from './market/analystData.js';
import { register as calendar } from './market/calendar.js';
import { register as optionsChain } from './market/optionsChain.js';
import { register as secFilings } from './market/secFilings.js';
import { register as failToDeliver } from './market/failToDeliver.js';
import { register as thresholdHistory } from './market/thresholdList.js';
import { register as darkPoolData } from './market/darkPoolData.js';
import { register as tradingHalts } from './market/tradingHalts.js';
import { register as activistFilings } from './market/activistFilings.js';
import { register as companyProfile } from './market/companyProfile.js';
import { register as screeners } from './market/screeners.js';
import { register as liveOptionsChain } from './market/liveOptionsChain.js';
import { register as optionsSnapshot } from './market/optionsSnapshot.js';
import { register as regimeFits } from './market/regimeFits.js';
import { register as dealerPositioning } from './market/dealerPositioning.js';
import { register as strategyScan } from './market/strategyScan.js';
import { register as eodDealerPositioning } from './market/eodDealerPositioning.js';
import { register as blackScholes } from './market/blackScholes.js';
import { register as liveQuote } from './market/liveQuote.js';
import { register as liveBars } from './market/liveBars.js';
import { register as liveSkewGex } from './market/liveSkewGex.js';
import { register as computeScenario } from './market/computeScenario.js';

// Platform info
import { registerPlatformInfo } from './platformInfo.js';

// User data tools (synced from browser)
import { register as analysisHistory } from './user/analysisHistory.js';
import { register as snapshot } from './user/snapshot.js';
import { register as analysisRollups } from './user/analysisRollups.js';
import { register as fftResults } from './user/fftResults.js';
import { register as queryAnalysis } from './user/queryAnalysis.js';
import { register as computeRuns } from './user/computeRuns.js';

/**
 * The server every tool registers on, with each tool's `title` also given as
 * `annotations.title`.
 *
 * MCP carries a tool's display name in two places: the top-level `title` and
 * the older `annotations.title`. Anthropic's connector directory reads the
 * second for its listing and flags a tool without one. Each tool declares
 * its title once, and it is copied here, so the two cannot drift apart.
 */
function withAnnotationTitles(server: McpServer): McpServer {
  const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  return new Proxy(server, {
    get(target, property) {
      if (property === 'registerTool') {
        return (name: string, config: { title?: string; annotations?: Record<string, unknown> }, ...rest: unknown[]) =>
          registerTool(name, typeof config.title === 'string'
            ? { ...config, annotations: { ...config.annotations, title: config.title } }
            : config, ...rest);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function registerAllTools(
  target: McpServer,
  client: ProxyClient,
  _tokenManager: AccessTokenProvider,
  liveClient: LiveApiClient,
): void {
  const server = withAnnotationTitles(target);
  // Market data tools. Several previously individual tools were consolidated
  // into enum-driven unified tools (run_screener, get_regime, get_snapshot,
  // get_market_calendar, get_rates, get_short_data) to keep the tool count
  // in the 20–40 sweet spot for LLM discoverability.
  ivHistory(server, client);
  greeksHistory(server, client);
  regime(server, client);
  // History from the proxy client; the moves (includeMoves) through the live client's structured envelope.
  earnings(server, client, liveClient);
  news(server, client);
  fundamentals(server, client);
  dividends(server, client);
  rates(server, client);
  insiderTrading(server, client);
  institutionalOwnership(server, client);
  congressTrades(server, client);
  optionsAnalyticsHistory(server, client);
  ivSurface(server, client);
  stockPrices(server, client);
  stockSplits(server, client);
  shortData(server, client);
  analystData(server, client);
  calendar(server, client);
  optionsChain(server, client);
  secFilings(server, client);
  failToDeliver(server, client);
  thresholdHistory(server, client);
  darkPoolData(server, client);
  tradingHalts(server, client);
  activistFilings(server, client);
  companyProfile(server, client);
  screeners(server, client);

  // Live broker data and the two EOD reads no other tool covers, through the
  // proxy's structured routes. Registered UNCONDITIONALLY, whatever the
  // entitlement (every session has passed TokenManager.initialize's check: an
  // active or trialing subscription, or a developer or comped account, so no
  // caller here is free-tier).
  //
  // The proxy gates the two live tools, the fit history and Black-Scholes to
  // Pro and above; this process resolves no tier at all. Doing so would mean
  // an async lookup before the tool list exists, on every session - and a
  // hidden tool means a non-Pro subscriber never discovers that live data is
  // what Pro buys. A visible tool
  // that answers "this needs Pro, upgrade at <url>" is the better answer, and
  // the proxy's envelope (code PRO_TIER_REQUIRED, retryable false, upgradeUrl)
  // is what makes that answer specific.
  //
  // get_options_snapshot and get_regime_fits spend no broker call, so both
  // keep openWorldHint false. The snapshot reads are anonymous on the proxy.
  liveOptionsChain(server, liveClient);
  optionsSnapshot(server, liveClient);
  regimeFits(server, liveClient);
  dealerPositioning(server, liveClient);
  // Strategy candidates from one live expiration: a broker call, openWorldHint true.
  strategyScan(server, liveClient);
  // The underlying's quote now: one broker request, openWorldHint true.
  liveQuote(server, liveClient);
  // One session's intraday bars with VWAP: one broker request, openWorldHint true.
  liveBars(server, liveClient);
  // A watchlist of up to 50 symbols ranked by live skew and GEX on the user's own broker budget.
  liveSkewGex(server, liveClient);
  // The end-of-day twin of the live positioning tool (no Pro requirement, no
  // broker) and Black-Scholes from explicit inputs (Pro, no broker). Separate tools,
  // never a fallback inside the live one: an end-of-day gamma flip and a live
  // one are different claims.
  eodDealerPositioning(server, liveClient);
  blackScholes(server, liveClient);
  // A strategy across spot, vol and time with an optional fit against held positions (Pro, no broker).
  computeScenario(server, liveClient);

  // Platform info (1 tool).
  registerPlatformInfo(server);

  // User data (synced from browser via /sync/* endpoints)
  analysisHistory(server, client);
  snapshot(server, client);
  analysisRollups(server, client);
  fftResults(server, client);
  queryAnalysis(server, client);
  computeRuns(server, client);
}
