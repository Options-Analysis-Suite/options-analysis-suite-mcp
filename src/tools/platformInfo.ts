/**
 * Platform Info Tool
 *
 * Returns static background information about the platform.
 * Claude calls this when it needs context about models, Greeks, or capabilities.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { platformInfoOutputSchema } from './outputSchemas.js';

const PLATFORM_INFO: Record<string, string> = {
  models: `Options Analysis Suite - 17 pricing models total (10 vanilla + 7 exotic).

Vanilla pricing models (10):
- Black-Scholes: Closed-form European pricing. Log-normal returns, constant vol. Baseline for IV extraction. Includes the Black-76 variant, auto-selected for futures tickers (symbols starting with "/") - uses the futures price directly as the forward, no carry adjustment.
- Binomial: Lattice method with selectable tree (CRR, Jarrow-Rudd, Leisen-Reimer). Handles American exercise, discrete dividends.
- Monte Carlo: Simulation-based with antithetic variates and confidence bands. Handles path-dependent payoffs.
- Heston: Stochastic volatility (mean-reverting variance, vol-of-vol, spot-vol correlation). Captures skew and smile dynamics.
- Jump Diffusion: GBM with discrete Poisson jumps (Merton-style). Captures gap risk and tail events.
- SABR: Stochastic Alpha-Beta-Rho. Strong for FX/rates and equity smile parameterization.
- Variance Gamma: Infinite-activity pure-jump (time-changed Brownian motion) process. Many small and medium discontinuities, no standard diffusion component. Models fat tails and skew.
- Local Volatility (Dupire): Non-parametric surface fit from market prices. Most accurate for exotics referencing the calibrated surface.
- FFT (Carr-Madan): Frequency-domain pricing. Efficient for characteristic-function models (Heston, Bates, Kou).
- PDE (Finite Difference): Numerical solver on the Black-Scholes PDE with optional Richardson extrapolation. Smooth Greeks, handles American exercise.

Exotic option types (7):
- Asian: Payoff on average price or average strike. Less sensitive to expiry-day manipulation.
- Barrier: Knock-in / knock-out / one-touch / no-touch. Path-dependent.
- Lookback: Payoff on extreme (max or min) price during the option's life.
- Digital: All-or-nothing (cash-or-nothing, asset-or-nothing) binary payoff.
- Compound: Option on an option (call-on-call, put-on-call, etc.).
- Chooser: Holder picks call or put at a future date. Equivalent to a call + put combination with adjusted strikes.
- Multi-Asset: Basket, spread, rainbow (best-of / worst-of) options on multiple underlyings.`,

  greeks: `Greeks - 17 sensitivities computed across the platform.

First-order (4):
- Delta: Price change per $1 move in the underlying. Calls in [0, 1], puts in [-1, 0]. Used as the linear hedge ratio.
- Vega: Price change per 1% absolute IV change. Highest for ATM options at long DTE. Core to vol trading.
- Theta: Daily price decay. Usually negative for long options under the market time-decay convention; can be positive in edge cases (e.g. deep-ITM European options with high dividends) or under raw mathematical convention. Accelerates near expiration.
- Rho: Price change per 1% absolute interest-rate change. Material for long-dated and deep-ITM options.

Second-order (5):
- Gamma: Rate of delta change per $1 underlying move. Highest ATM near expiry.
- Vanna: Cross-Greek between spot and vol - the change in delta for a change in IV (equivalently the change in vega per $1 spot move). Drives skew/smile P&L.
- Charm: Daily delta decay (delta-theta). Important for short-dated hedge rebalancing.
- Vomma (Volga): The change in vega for a change in IV. Convexity in vol - material for vol-of-vol trades.
- Veta: Daily vega decay. Picks up the time-erosion piece of vol exposure.

Third-order (5):
- Speed: Gamma change per $1 underlying move. Matters for large or fast spot moves.
- Ultima: The change in vomma for a change in IV. Third-order vol convexity.
- DcharmDvol: Charm sensitivity to volatility. Cross third-order term.
- Zomma: The change in gamma for a change in IV. Couples skew dynamics into delta-hedging risk.
- Color: Daily gamma decay (gamma-theta). Important for gamma-scalping near expiry.

Other (3):
- Lambda: Elasticity - percent change in option price per percent change in underlying. Useful for leverage analysis.
- Epsilon: Price sensitivity to continuous dividend yield.
- Phi: rho minus epsilon - the price change for a 1-point rise in the rate taken with a 1-point fall in the dividend yield, which is how every pricer here publishes it (the carry, or interest-rate differential, sensitivity; not a foreign-rate rho on its own).

Conventions - a Greek is only a number once you know its scaling, and three reach you here:
- The web app's display scaling (applyGreekScaling), carried by the records the Analysis page and the AI Compute Suite save (get_analysis_history, query_analysis, get_compute_runs), at its defaults - the producer can override the day count and the vol scale: vega, rho, epsilon and phi per 1 percentage point, EXCEPT that the Digital model's vega is left per unit of volatility (100x the per-point figure); theta, charm and color per day on a 252-trading-day year for equities (calendar days otherwise), theta with its sign flipped to the time-decay direction (usually, not always, negative for a long option); veta and dcharmDvol per percentage point per day, veta also negated; and the four vol-convexity Greeks per 1% IV move - vanna and zomma divided by 100, vomma by 10,000 and ultima by 1,000,000 from their raw per-unit-volatility values.
- Rollups (get_analysis_rollups) average vega per percentage point across models: the producer normalizes the Digital model's per-unit vega before averaging and stamps the row, so the Digital exception above does NOT apply to a rollup. The tool withholds an older row that mixed the two units and labels an older Digital-only row per unit; read its units line.
- NOT that scaling: FFT scanner results (get_fft_results) carry computeFFTGreek's raw output as the scanner synced it - vega and rho per unit (100x the web app's figures), theta per year in the mathematical direction (opposite in sign to the web app's and 252x its equity figure), delta and gamma as usual.
- The commercial API's, which compute_black_scholes publishes and names in every response as greekConvention: "dapi": vega, rho, epsilon and phi per 1 percentage point; theta, charm, color and dcharmDvol per day (365 calendar or 252 trading days, per the request's dayCount); veta per percentage point per day, not negated; vanna, vomma, zomma and ultima per unit of volatility, NOT per percentage point; delta, gamma, speed and lambda unscaled.
Between the web app's and dapi: divide dapi vanna and zomma by 100, vomma by 10,000, ultima by 1,000,000 and dcharmDvol by 100 to compare with the web app's figures; veta differs in sign. Read the tag before comparing a Greek across tools: a vanna of 0.0055 from compute_black_scholes is 0.000055 per IV point.`,

  capabilities: `Platform Capabilities:
- Market-data tools backed by the Options Analysis Suite proxy: IV history, IV surfaces, regime/exposure snapshots, options chains, fundamentals, news, calendars, and scanner rankings
- Synced user-analysis tools: local pricing-analysis history (calibrated models and standard Monte Carlo only), rollups, FFT results, saved snapshots, and AI Compute Suite run history when the user has synced them
- GEX (Gamma Exposure) context from precomputed regime/exposure data: call/put walls, gamma flip, gamma magnet, dealer positioning
- Portfolio risk context from synced snapshots: VaR, beta, Sharpe, stress tests, correlation matrix, and aggregate dollar Greek exposure when present
- Structured queries over synced user analysis: "show analyses where delta > 0.8 last month" via the user's synced records
- This MCP server does not invoke the commercial /v1 REST API. Black-Scholes pricing is available here through compute_black_scholes and strategy scenarios through compute_scenario; the other pricing models, calibration and multi-model runs are on the REST API and Python SDK`,
};

/**
 * The six proxy-backed tools that carry a tier or a broker requirement, or
 * are easily mistaken for one that does. The capabilities text is what a model
 * reads to decide what it can do, so each line says who can call it and what
 * it costs, and names the tool it is most easily confused with.
 *
 * "Every tier" was wrong here: this server refuses to start without
 * entitlement (TokenManager.initialize) and the OAuth handoff gates the same
 * way, so no caller is free-tier. Entitlement is not only a subscription:
 * developer and comped (bypassSubscription) accounts initialize with no
 * subscription row and pass the proxy's Pro gate, so the text names the check
 * rather than one way of passing it. What the EOD tools lack is the proxy's
 * Pro gate, and that is what their label says.
 */
const LIVE_CAPABILITY =
  "\n- Who can call what: every MCP session has already passed this server's entitlement check (an active or trialing subscription, or a developer or comped account), so no tool here is free-tier. 'Pro and above' below marks the tools the proxy additionally refuses to an entitled account it does not resolve to Pro or above (code PRO_TIER_REQUIRED, with an upgrade URL); 'no Pro requirement' marks the ones it does not."
  + "\n- LIVE options chains (Pro and above): get_live_options_chain fetches a real-time chain from the broker credential stored on the user's account. Every other option-CHAIN tool here is end-of-day, from the most recent session on file (get_regime with scope=\"intraday\" does expose intraday exposure, but not chain prices). It spends the user's own broker quota, metered in the broker's own requests (a chain is 2 on Tradier and Public, 1 on Schwab, 2 plus one per 100 listed contracts on tastytrade, counted across every root before they merge) against the broker's own quota (120 a minute on Tradier, Schwab and tastytrade, 600 on Public) shared with the other live tools, so prefer it when the question is about current or intraday prices, and the end-of-day tools otherwise."
  + "\n- LIVE quote (Pro and above): get_live_quote fetches one underlying's quote now from the stored broker credential: last, bid, ask, sizes, mid, mark, the session's open, high and low, the previous close, volume and the broker's quote and trade times, for a stock, ETF or index. One request on every broker against the same per-broker budget. It is the only tool with the current quote and session range; the live chain carries a spot at fetch time and no range, and get_stock_prices is end-of-day bars."
  + "\n- LIVE intraday bars (Pro and above): get_intraday_bars fetches one session's minute bars (1 to 30 minutes, regular or extended hours) from the stored credential, Tradier or Schwab only (tastytrade and Public publish no REST candles and are refused by name), with the session VWAP and its band, a session summary and up to six Stock Charts indicators computed on the same bars. One request against the same per-broker budget. It is the only tool with intraday bars and a session VWAP; get_stock_prices is end-of-day bars and get_live_quote is the quote now."
  + "\n- LIVE watchlist ranking (Pro and above): rank_live_skew_gex ranks up to 50 symbols by their 25-delta skew and net GEX over the nearest four expirations, each with its change since the prior session's close, computed by one model on both sides (IV solved from mids, Black-Scholes gamma and delta) from the live chains and the prior session's stored chains - the live counterpart of run_screener's put-skew and dod-change boards. It may spend the whole per-broker budget (about 11 of the broker's requests a symbol on Tradier with both metrics), so a long list is answered over several calls with the same list: what one call did not reach is listed as pending with a reason and a wait, and answered rows are cached 15 minutes. Its net GEX is this model's, not the broker Greeks get_live_dealer_positioning sums."
  + "\n- EOD options snapshot (no Pro requirement): get_options_snapshot returns spot, max pain, net GEX/DEX, the ATM IV term structure, IV rank/percentile and historical vol for any symbol the platform holds an options snapshot for, and is the only tool that can summarize the max-pain curve and the per-strike GEX/DEX/skew curves. It also compares up to 50 symbols in one request. Distinct from get_snapshot, which returns the GEX, portfolio and risk snapshots synced from the user's own browser session."
  + "\n- LIVE dealer positioning (Pro and above): get_live_dealer_positioning computes net GEX/DEX plus vega, vanna, charm and vomma, the gamma flip, call and put walls, gamma concentration and a positive/negative gamma regime, in real time from the user's own broker chain over the nearest four expirations that may still trade (from 4:15 PM New York time an expiration day's own is left out unless the broker lists nothing else), or over one named expiration (a same-day book, for instance). Metric coverage identifies partial sums and unavailable observations; levels require complete coverage of their inputs. It is the only tool that can answer 'where is the gamma flip right now'. A cold call reads the expirations list and four chains (one when it names an expiration), charged in the broker's own requests against that same per-broker budget; actual counts vary with provider and cache state, so it is not for looping over symbols."
  + "\n- Model calibration fits (Pro and above): get_regime_fits returns the calibrated parameters and fit quality for the eight pricing models on a symbol (IV RMSE for every model and price RMSE for all but eSSVI, an IV-surface fit that stores none), with an error history, for the regime universe of about 124 symbols; a symbol outside it returns an empty history. Distinct from get_regime, which reports which market regime a symbol is in rather than how well a model fits it."
  + "\n- LIVE strategy scan (Pro and above): scan_option_strategies builds candidate trades for one strategy (single options, vertical spreads, iron condors and butterflies, straddles and strangles) from one expiration of the broker's live chain, priced from two-sided quotes, with payoff at expiration, risk-neutral model probabilities, position Greeks, and distances to the expected move and the dealer levels. It reads the expirations list and the scanned chain, up to four more chains with the four-expiration levels, charged in the broker's own requests against the same per-broker budget."
  + "\n- EOD dealer positioning (no Pro requirement): get_dealer_positioning returns net GEX/DEX over 0-60 days from the most recent session on file (`date` in the result says which), the dealer regime, the gamma flip, call and put walls, the gamma magnet, the 30-day expected move (a decimal fraction of spot, and in dollars) and the top contributing strikes for roughly 5,500 listed equities and ETFs. Its gamma flip is a coarse-grid level with no search status; it is the end-of-day claim, and get_live_dealer_positioning is the live one - neither substitutes for the other."
  + "\n- Black-Scholes pricing (Pro and above): compute_black_scholes prices a European option from explicit inputs and returns the price, seventeen Greeks in the commercial API's convention, the expected move and the risk-neutral ITM probability. r and q are supplied or resolved from stored market data for a symbol, never defaulted. Black-Scholes only: the other pricing models, calibration and multi-model runs are on the REST API and Python SDK."
  + "\n- Scenario and portfolio fit (Pro and above): compute_scenario reprices a multi-leg strategy (legs supplied in the call, or a strategy the user sent from the Strategy page named by its strategyKey from get_snapshot; European legs Black-Scholes, American legs the Leisen-Reimer tree) across spot moves, vol-point shocks and days elapsed, with an elapsed leg at its intrinsic, and returns the P&L grid against each leg's entry plus the base Greeks in the commercial API's convention. Spot, r, q and each leg's IV are supplied or resolved from the stored end-of-day snapshot, chain and market data with their source and date named, never defaulted. Its portfolioFit takes the positions you hold and reports headline Greeks for held, candidate and combined by underlying, expiration and sector, the candidate's correlation with each held underlying over sixty daily log returns, and held and combined P&L with every underlying moved by the same percent. No broker call.";

export function registerPlatformInfo(server: McpServer): void {
  server.registerTool(
    'get_platform_info',
    {
      title: 'Platform Info',
      description: 'Get background information about the Options Analysis Suite platform - the 17 available pricing models (10 vanilla + 7 exotic), the 17 Greeks computed across them, and platform capabilities. Call this when you need context about the platform to give better answers.',
      inputSchema: {
        topic: z.enum(['models', 'greeks', 'capabilities', 'all']).default('all')
          .describe('Which topic to get info about'),
      },
      outputSchema: platformInfoOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ topic }) => {
      const capabilities = PLATFORM_INFO.capabilities + LIVE_CAPABILITY;
      const effectiveTopic = topic ?? 'all';
      if (effectiveTopic === 'all') {
        const text = [PLATFORM_INFO.models, PLATFORM_INFO.greeks, capabilities].join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: { topic: effectiveTopic, text } };
      }
      const text = effectiveTopic === 'capabilities'
        ? capabilities
        : PLATFORM_INFO[effectiveTopic] || 'Unknown topic.';
      return { content: [{ type: 'text', text }], structuredContent: { topic: effectiveTopic, text } };
    },
  );
}
