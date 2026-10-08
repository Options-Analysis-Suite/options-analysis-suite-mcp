# Options Analysis Suite - AI Integration

MCP server that gives Claude, ChatGPT, Perplexity, and Grok direct access to your options analysis data, market research tools, portfolio risk snapshots, and platform context.

## Supported Platforms

| Platform | Transport | Auth | Setup |
| --- | --- | --- | --- |
| Claude Desktop (`.mcpb` extension) | Local stdio | Credentials stored in OS keychain | Download extension from your account page |
| Claude Desktop / Claude Web / ChatGPT / Grok | Remote HTTP MCP | OAuth login flow | Add the remote connector URL |
| Perplexity | Remote HTTP MCP | API key (`base64(email:password)`) | Add MCP connector in settings |

## Current Tool Surface

The MCP currently exposes **45 tools** - consolidated into enum-driven unified tools where tool shapes are a clean family match (calendars, regime views, Treasury rates, FINRA short-side series, user snapshots, and options-market screeners).

- **38 market, research and pricing tools**, six of them live
- **6 synced user-data tools**
- **1 platform-context tool**

Six tools read in real time from the broker connected to your account: `get_live_quote`, `get_intraday_bars`, `get_live_options_chain`, `get_live_dealer_positioning`, `scan_option_strategies` and `rank_live_skew_gex` (Pro and above). The other market tools answer from the platform's stored data - end-of-day snapshots and history, plus the intraday regime scans behind `get_regime` with `scope='intraday'` - and the synced tools from your own account data. `compute_black_scholes` prices from the inputs you give it. `compute_scenario` reprices a strategy you describe, with an optional fit against the positions you hold. `get_regime_fits`, `compute_black_scholes` and `compute_scenario` also need Pro; none needs a broker. A tool that needs more than the account has says so, with the upgrade link, rather than being hidden.

## Market And Research Tools

### Volatility, chain, and pricing structure

- **IV History** (`get_iv_history`) - Historical implied and realized volatility
- **Greeks History** (`get_greeks_history`) - Historical Greeks with recent/trend summaries plus DTE and moneyness filters
- **IV Surface** (`get_iv_surface`) - Surface and skew snapshots across strikes and expirations
- **Options Chain** (`get_options_chain`) - Latest available end-of-day chain summary with expirations, ATM term structure, skew, and representative near-money contracts
- **Live Quote** (`get_live_quote`, Pro and above) - One underlying's quote now from your connected broker: last, bid, ask, sizes, mid, mark, the session's open, high and low, previous close, volume, the broker's quote and trade times, and change against the previous close, withheld with a reason after hours when the broker has rolled the previous close to the session's own close; a null is a field the broker did not publish. One request on every broker; cached five seconds per account and broker
- **Intraday Bars and VWAP** (`get_intraday_bars`, Pro and above) - One session's minute bars (1 to 30 minutes, regular or extended hours) from Tradier or Schwab, with the session VWAP and its band, a session summary, and up to six Stock Charts indicators computed on the same bars; columnar, newest last, trimmed from the oldest when the budget binds. One request; cached fifteen seconds per account and broker
- **Live Options Chain** (`get_live_options_chain`, Pro and above) - One expiration, fetched in real time from the broker connected to your account: near-the-money strikes, the ATM pair, 25-delta wings, whole-chain volume and open interest. Spends your own broker quota, metered in your broker's own requests against its documented quota (120 a minute on Tradier and Schwab, 600 on Public, a conservative 120 on tastytrade, which publishes none); a broker's own 429 comes back as BROKER_RATE_LIMITED with its wait
- **EOD Options Snapshot** (`get_options_snapshot`) - Spot, max pain, net GEX/DEX, ATM IV term structure, IV rank and percentile, historical vol, volume and open interest for any symbol the platform holds an options snapshot for, with optional per-strike max-pain, GEX/DEX and skew curve summaries; up to 50 symbols compared in one request
- **Options Analytics History** (`get_options_analytics_history`) - Daily analytics history including IV, skew, expected move, the risk-free rate, GEX/DEX/VEX, and net vanna/charm/vomma
- **Treasury Rates** (`get_rates`) - Unified Treasury view with `view='benchmark'` (current platform risk-free rate, 10Y-based) or `view='curve'` (full yield curve with key rates, inversion flags, and compact history)

### Flow, positioning, and market structure

- **Screeners** (`run_screener`) - Unified leaderboard surface for all 16 options-market screeners (most-active, highest-oi, highest-iv, unusual, gex, model-divergence, regime-stress, term-backwardation, put-skew, delta-exposure, vega-exposure, pre-earnings-iv, dod-change, vrp, max-pain, unusual-directional) plus market-trends (time-series aggregates) and earnings-calendar (next-14-day forward window by default, widen via `days`, filter by `symbol`)
- **Short Data** (`get_short_data`) - Unified FINRA short-side feed: `type='volume'` for daily short-volume activity, `type='interest'` for biweekly short-interest settlements (float-enriched)
- **Dark Pool / ATS** (`get_dark_pool_data`) - FINRA OTC (non-ATS) and ATS (dark pool) weekly data with four granularities: `view='summary'` (aggregate trends), `view='dealers'` (per-dealer MPID breakdown of OTC flow, top 15/week), `view='venues'` (per-venue MPID breakdown of ATS flow, top 15/week), or `view='all'` (combined)
- **Fail To Deliver** (`get_fail_to_deliver`) - SEC FTD history with recent spikes and trend context
- **Threshold History** (`get_threshold_history`) - Reg SHO threshold-list status and streak summaries
- **Trading Halts** (`get_trading_halts`) - Active and recent halts with duplicate feed rows condensed

### Regime and exposure

- **Regime** (`get_regime`) - Unified regime tool with six scopes: `scope='market'` (composite stress regime across SPY/QQQ/IWM/DIA with score bands and drivers), `scope='symbol'` (per-symbol daily regime + authoritative Greek exposures: net gamma/delta/vega/vanna/charm/vomma, call/put walls, gamma flip, gamma magnet, top 10 gamma strikes), `scope='intraday'` (5 scans/day with stress scoring + Greek snapshots), `scope='volatility'` (the VIX term structure at the close: VIX1D, VIX9D, VIX, VIX3M and VIX6M with its shape, the VIX/VIX3M ratio and VVIX), `scope='sectors'` (every sector's or industry's P/E and daily change on the NYSE, NASDAQ and AMEX, with one group's daily history), or `scope='cot'` (CFTC Commitments of Traders positioning: a futures contract's family market with every trader group, its speculative line and 3-year range, or every market's speculative line, optionally by sector)
- **Live Dealer Positioning** (`get_live_dealer_positioning`, Pro and above) - Net GEX/DEX plus vega, vanna, charm and vomma, the gamma flip with its search status and resolution, call and put walls, gamma concentration and the gamma regime, computed in real time from your connected broker's chain over the nearest four expirations. The rate and dividend yield are resolved from market data or supplied as `r` and `q` (an index needs `q`). A cold call is the expirations list plus four chains, in your broker's own requests against the same per-broker budget
- **Live Strategy Scan** (`scan_option_strategies`, Pro and above) - Candidate trades for one strategy (single options, the four vertical spreads, iron condors and butterflies, straddles and strangles) from one expiration of the live chain, priced from two-sided quotes: every leg's quote, spread, IV, Greeks, open interest and volume; net mid and natural price; max profit and loss, breakevens and return on risk; risk-neutral model probabilities of profit and of max profit; position Greeks; and each strike's, breakeven's and dealer level's distance from spot, with the expiration's expected move. Filters for open interest, spread width, slippage and credit, and `r` and `q` supplied where the platform holds none (an index); the list plus the scanned chain in your broker's own requests, up to four more chains with four-expiration levels
- **Live Watchlist Skew and GEX Ranking** (`rank_live_skew_gex`, Pro and above) - Up to 50 symbols ranked by 25-delta skew or net GEX over the nearest four expirations, or by either's change since the prior session's close, computed by one model on both sides: IV solved from mids and Black-Scholes gamma on your broker's live chains and on the prior session's stored chains, so the change is like for like on every broker. May spend your whole per-broker budget (about 11 requests a symbol on Tradier with both metrics); what one call does not reach is listed as pending with a reason and a wait, answered rows are cached 15 minutes, and calling again with the same list continues it
- **EOD Dealer Positioning** (`get_dealer_positioning`) - Net GEX/DEX over 0-60 days, dealer regime, gamma flip (coarse-grid, no search status), call and put walls, gamma magnet, 30-day expected move and top contributing strikes from the most recent session on file (`date` in the result says which), for roughly 5,500 listed equities and ETFs; a past session via `date`
- **Model Calibration Fits** (`get_regime_fits`, Pro and above) - Calibrated parameters and fit quality for the eight pricing models on a symbol (IV RMSE for every model, price RMSE for every model except eSSVI, an IV-surface fit that stores none), with an error history; covers the regime universe of about 124 symbols
- **Black-Scholes Pricing** (`compute_black_scholes`, Pro and above) - Price, seventeen Greeks in the commercial API's convention, expected move and risk-neutral ITM probability from explicit inputs; `r` and `q` supplied or resolved from stored market data for a symbol, never defaulted. Black-Scholes only; the other models, calibration and multi-model runs are on the REST API and Python SDK
- **Scenario and Portfolio Fit** (`compute_scenario`, Pro and above) - A multi-leg strategy (legs supplied in the call, or a strategy sent from the Strategy page by its strategyKey; Black-Scholes, or the Leisen-Reimer tree for American legs, whose Greeks are that tree's own finite differences) repriced across spot moves, vol-point shocks and days elapsed, with an elapsed leg at its intrinsic: the P&L grid against each leg's entry and the base Greeks in the commercial API's convention. Spot, `r`, `q` and each leg's IV supplied or resolved from stored end-of-day data with their source named, never defaulted. An optional portfolio fit against the positions you hold: headline Greeks for held, candidate and combined by underlying, expiration and sector; correlation over sixty daily log returns; held and combined P&L with every underlying moved by the same percent

### Company, events, and filings

- **Company Profile** (`get_company_profile`) - Normalized company metadata with float metrics, identifiers, description, and ESG scores and risk rating (stale or placeholder ones withheld and named), and for a fund its facts, holdings and weights
- **Fundamentals** (`get_fundamentals`) - Compact fundamentals with ratios and summarized statements, plus valuation: the P/E against its sector's and industry's on its exchange, and the market cap with its one- and five-year change
- **Earnings** (`get_earnings`) - Earnings history and estimates; with `includeMoves`, the realized and implied moves around each of the last eight reports: both one-session moves (the report's time of day is often not on file), the implied move from the stored ATM straddle on the session before the report, else the stored ATM IV, the IV crush on one tenor, and realized-over-implied ratios
- **Analyst Data** (`get_analyst_data`) - Analysts' monthly rating counts and their 12-month history, individual price targets, price-target summaries, nearest forward estimate periods, recent rating changes, and a quantitative model grade
- **News** (`get_news`) - Relevance-ranked company or ETF news with raw-feed fallback via `full=true`
- **Insider Trading** (`get_insider_trading`) - Grouped Form 4 buy/sell activity with administrative activity summarized and quarterly statistics by transaction date, and a market-wide scope: purchase and sale totals, the top companies by value and the individual filing lines
- **Institutional Ownership** (`get_institutional_ownership`) - A company's or an ETF's institutional ownership from quarterly Form 13F filings: institutions, shares, reported value and share of market cap, changes from the quarter before, calls and puts, the top holders and the quarterly history, and the ETFs holding it
- **Congress Trades** (`get_congress_trades`) - Trades by members of Congress and their households from their STOCK Act reports: a company's trades with totals, or the trades first disclosed market-wide over recent days with the companies traded most; party on the trade date, amount ranges, trade and disclosure dates
- **Activist Filings** (`get_activist_filings`) - 13D/13G ownership filings with current above-threshold holders prioritized
- **SEC Filings** (`get_sec_filings`) - EDGAR filing summaries with recent filing lists, merger and offering flags with counterparties, and a market-wide list of recent merger, tender offer and going-private filings
- **Dividends** (`get_dividends`) - Per-symbol dividend history
- **Stock Splits** (`get_stock_splits`) - Per-symbol split history

### Calendars and general market context

- **Market Calendar** (`get_market_calendar`) - Unified calendar feed: `type='economic'` (FOMC/CPI/NFP macro events, optional country filter, full=true bypasses catalyst-focused default), `type='ipo'` (upcoming/recent listings), `type='dividend'` (ex/record/payment dates), `type='split'` (stock splits). Per-type date-window defaults; `symbol` filter for ipo/dividend/split
- **Stock Prices** (`get_stock_prices`) - Historical OHLCV bars at the daily, weekly or monthly interval with a compact trend summary, a labelled volume-weighted average, and up to six Stock Charts indicators (by catalogue name, with the chart's own parameters) computed on the returned bars

## Synced User-Data Tools

These require account sync to be enabled.

- **Analysis History** (`get_analysis_history`) - Pricing model history with near-identical reruns collapsed by default
- **Query Analysis** (`query_analysis`) - Filtered analysis-history queries by delta, volatility, and DTE
- **Compute Runs** (`get_compute_runs`) - AI Compute Suite run history with compact run summaries, exposure levels, model-dispersion highlights, and representative position/model consensus summaries across multiple pricing models; `view='detailed'` exposes per-model outputs when exactly one run matches
- **FFT Results** (`get_fft_results`) - FFT scanner mispricing signals and calibration data
- **Snapshots** (`get_snapshot`) - Unified synced-snapshot tool: `type='gex'` (per-symbol Gamma Exposure - requires `symbol`; per-expiration breakdown, call/put walls, gamma flip, gamma magnet, unusual activity, expected move, raw vs in-wall visible combo counts), `type='portfolio'` (account-wide portfolio snapshots with market-scaled raw Greeks - 1st + 2nd order), `type='strategy'` (the strategy definitions you sent from the Strategy page's AI Assistant panel - symbol, legs with strikes, expirations, premiums and vols, and the page's inputs; definitions only, priced on demand by `compute_scenario` via `strategyKey`), or `type='risk'` (account-wide VaR, CVaR, beta, Sharpe, drawdown, stress tests + $-impact Greeks)
- **Analysis Rollups** (`get_analysis_rollups`) - Daily or weekly trend aggregates over your analysis activity

## Platform Context

- **Platform Info** (`get_platform_info`) - Pricing models, Greeks definitions, data-source notes, and platform capabilities

## Enabling Sync

To give the assistant access to your personal analysis data:

1. Log in to Options Analysis Suite
2. Open `Account -> AI Settings`
3. Enable data sync
4. Run analyses, FFT scans, AI Compute Suite runs, GEX scans, or portfolio/risk snapshots in the app, or send a strategy from the Strategy page's AI Assistant panel (Data tab, "Send to assistant")

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
- Pro or above for the live tools, the calibration fits and Black-Scholes pricing
- A broker credential stored under Account -> Broker -> Stored broker credentials for the live tools only; the calibration fits and Black-Scholes pricing need no broker
- Claude Desktop, ChatGPT, Claude Web, Perplexity, or Grok
- Sync enabled if you want personal analysis data in addition to market data

## Support

Contact `support@optionsanalysissuite.com` or visit `optionsanalysissuite.com/documentation`.
