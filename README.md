# Options Analysis Suite - AI Integration

MCP server that gives Claude, ChatGPT, Perplexity, and Grok direct access to your options analysis data, market research tools, portfolio risk snapshots, and platform context.

## Supported Platforms

| Platform | Transport | Auth | Setup |
| --- | --- | --- | --- |
| Claude Desktop (`.mcpb` extension) | Local stdio | Credentials stored in OS keychain | Download extension from your account page |
| Claude Desktop / Claude Web / ChatGPT / Grok | Remote HTTP MCP | OAuth login flow | Add the remote connector URL |
| Perplexity | Remote HTTP MCP | API key (`base64(email:password)`) | Add MCP connector in settings |

## Current Tool Surface

The MCP currently exposes **32 tools** - consolidated into enum-driven unified tools where tool shapes are a clean family match (calendars, regime views, Treasury rates, FINRA short-side series, user snapshots, and options-market screeners).

- **25 market and research tools**
- **6 synced user-data tools**
- **1 platform-context tool**

## Market And Research Tools

### Volatility, chain, and pricing structure

- **IV History** (`get_iv_history`) - Historical implied and realized volatility
- **Greeks History** (`get_greeks_history`) - Historical Greeks with recent/trend summaries plus DTE and moneyness filters
- **IV Surface** (`get_iv_surface`) - Surface and skew snapshots across strikes and expirations
- **Options Chain** (`get_options_chain`) - Latest available end-of-day chain summary with expirations, ATM term structure, skew, and representative near-money contracts
- **Options Analytics History** (`get_options_analytics_history`) - Daily analytics history including IV, skew, expected move, rates, dividend yield, GEX/DEX/VEX, and net vanna/charm/vomma
- **Treasury Rates** (`get_rates`) - Unified Treasury view with `view='benchmark'` (current platform risk-free rate, 10Y-based) or `view='curve'` (full yield curve with key rates, inversion flags, and compact history)

### Flow, positioning, and market structure

- **Screeners** (`run_screener`) - Unified leaderboard surface for all 16 options-market screeners (most-active, highest-oi, highest-iv, unusual, gex, model-divergence, regime-stress, term-backwardation, put-skew, delta-exposure, vega-exposure, pre-earnings-iv, dod-change, vrp, max-pain, unusual-directional) plus market-trends (time-series aggregates) and earnings-calendar (next-14-day forward window by default, widen via `days`, filter by `symbol`)
- **Short Data** (`get_short_data`) - Unified FINRA short-side feed: `type='volume'` for daily short-volume activity, `type='interest'` for biweekly short-interest settlements (float-enriched)
- **Dark Pool / ATS** (`get_dark_pool_data`) - FINRA OTC (non-ATS) and ATS (dark pool) weekly data with four granularities: `view='summary'` (aggregate trends), `view='dealers'` (per-dealer MPID breakdown of OTC flow, top 15/week), `view='venues'` (per-venue MPID breakdown of ATS flow, top 15/week), or `view='all'` (combined)
- **Fail To Deliver** (`get_fail_to_deliver`) - SEC FTD history with recent spikes and trend context
- **Threshold History** (`get_threshold_history`) - Reg SHO threshold-list status and streak summaries
- **Trading Halts** (`get_trading_halts`) - Active and recent halts with duplicate feed rows condensed

### Regime and exposure

- **Regime** (`get_regime`) - Unified regime tool with three scopes: `scope='market'` (composite stress regime across SPY/QQQ/IWM/DIA with score bands and drivers), `scope='symbol'` (per-symbol daily regime + authoritative Greek exposures: net gamma/delta/vega/vanna/charm/vomma, call/put walls, gamma flip, abs gamma anchor, top 10 gamma strikes), or `scope='intraday'` (5 scans/day with stress scoring + Greek snapshots)

### Company, events, and filings

- **Company Profile** (`get_company_profile`) - Normalized company metadata with float metrics, identifiers, and description
- **Fundamentals** (`get_fundamentals`) - Compact fundamentals with ratios and summarized statements
- **Earnings** (`get_earnings`) - Earnings history and estimates
- **Analyst Data** (`get_analyst_data`) - Ratings, price targets, nearest forward estimate periods, and compact rating-history summaries
- **News** (`get_news`) - Relevance-ranked company or ETF news with raw-feed fallback via `full=true`
- **Insider Trading** (`get_insider_trading`) - Grouped Form 4 buy/sell activity with administrative activity summarized
- **Activist Filings** (`get_activist_filings`) - 13D/13G ownership filings with current above-threshold holders prioritized
- **SEC Filings** (`get_sec_filings`) - EDGAR filing summaries with recent filing lists
- **Dividends** (`get_dividends`) - Per-symbol dividend history
- **Stock Splits** (`get_stock_splits`) - Per-symbol split history

### Calendars and general market context

- **Market Calendar** (`get_market_calendar`) - Unified calendar feed: `type='economic'` (FOMC/CPI/NFP macro events, optional country filter, full=true bypasses catalyst-focused default), `type='ipo'` (upcoming/recent listings), `type='dividend'` (ex/record/payment dates), `type='split'` (stock splits). Per-type date-window defaults; `symbol` filter for ipo/dividend/split
- **Stock Prices** (`get_stock_prices`) - Historical OHLCV with compact trend summary

## Synced User-Data Tools

These require account sync to be enabled.

- **Analysis History** (`get_analysis_history`) - Pricing model history with near-identical reruns collapsed by default
- **Query Analysis** (`query_analysis`) - Filtered analysis-history queries by delta, volatility, and DTE
- **Compute Runs** (`get_compute_runs`) - AI Compute Suite run history with compact run summaries, exposure levels, model-dispersion highlights, and representative position/model consensus summaries across multiple pricing models; `view='detailed'` exposes per-model outputs when exactly one run matches
- **FFT Results** (`get_fft_results`) - FFT scanner mispricing signals and calibration data
- **Snapshots** (`get_snapshot`) - Unified synced-snapshot tool: `type='gex'` (per-symbol Gamma Exposure - requires `symbol`; per-expiration breakdown, call/put walls, gamma flip, abs gamma anchor, unusual activity, expected move, raw vs in-wall visible combo counts), `type='portfolio'` (account-wide portfolio snapshots with market-scaled raw Greeks - 1st + 2nd order), or `type='risk'` (account-wide VaR, CVaR, beta, Sharpe, drawdown, stress tests + $-impact Greeks)
- **Analysis Rollups** (`get_analysis_rollups`) - Daily or weekly trend aggregates over your analysis activity

## Platform Context

- **Platform Info** (`get_platform_info`) - Pricing models, Greeks definitions, data-source notes, and platform capabilities

## Enabling Sync

To give the assistant access to your personal analysis data:

1. Log in to Options Analysis Suite
2. Open `Account -> AI Settings`
3. Enable data sync
4. Run analyses, FFT scans, AI Compute Suite runs, GEX scans, or portfolio/risk snapshots in the app

Without sync enabled, the assistant can still use the market and research tools.

## Example Prompts

- "Is AAPL IV expensive relative to its last six months?"
- "Show me my most recent AAPL pricing runs and tell me which model had the highest edge."
- "Summarize my latest AI Compute Suite run and tell me which models disagreed most."
- "What do the exposure sweep levels from my most recent compute run imply for my SPY positions?"
- "How has my portfolio delta and gamma changed over the last few snapshots?"
- "Summarize current short interest, dark pool activity, and FTD behavior for AMC."
- "What does the current market regime say about stress, rates, and dealer positioning?"
- "Pull recent SEC filings and analyst changes for TSLA."
- "What are the most active and most unusual options contracts right now?"

## Privacy

- Claude Desktop stores credentials in the OS keychain
- Remote MCP clients authenticate through OAuth or explicit API-key credentials
- The tools are read-only against your synced account data
- Sync is opt-in and can be disabled at any time

## Requirements

- Active Options Analysis Suite subscription
- Claude Desktop, ChatGPT, Claude Web, Perplexity, or Grok
- Sync enabled if you want personal analysis data in addition to market data

## Support

Contact `support@optionsanalysissuite.com` or visit `optionsanalysissuite.com/documentation`.
