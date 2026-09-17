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
import { register as eodDealerPositioning } from './market/eodDealerPositioning.js';
import { register as blackScholes } from './market/blackScholes.js';

// Platform info
import { registerPlatformInfo } from './platformInfo.js';

// User data tools (synced from browser)
import { register as analysisHistory } from './user/analysisHistory.js';
import { register as snapshot } from './user/snapshot.js';
import { register as analysisRollups } from './user/analysisRollups.js';
import { register as fftResults } from './user/fftResults.js';
import { register as queryAnalysis } from './user/queryAnalysis.js';
import { register as computeRuns } from './user/computeRuns.js';

export function registerAllTools(
  server: McpServer,
  client: ProxyClient,
  _tokenManager: AccessTokenProvider,
  liveClient: LiveApiClient,
): void {
  // Market data tools. Several previously individual tools were consolidated
  // into enum-driven unified tools (run_screener, get_regime, get_snapshot,
  // get_market_calendar, get_rates, get_short_data) to keep the tool count
  // in the 20–40 sweet spot for LLM discoverability.
  ivHistory(server, client);
  greeksHistory(server, client);
  regime(server, client);
  earnings(server, client);
  news(server, client);
  fundamentals(server, client);
  dividends(server, client);
  rates(server, client);
  insiderTrading(server, client);
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
  // The end-of-day twin of the live positioning tool (no Pro requirement, no
  // broker) and Black-Scholes from explicit inputs (Pro, no broker). Separate tools,
  // never a fallback inside the live one: a last-close gamma flip and a live
  // one are different claims.
  eodDealerPositioning(server, liveClient);
  blackScholes(server, liveClient);

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
