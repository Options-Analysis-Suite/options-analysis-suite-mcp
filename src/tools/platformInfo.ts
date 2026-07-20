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
- Binomial: Lattice method with selectable tree (CRR, Jarrow-Rudd, Tian, Leisen-Reimer). Handles American exercise, discrete dividends.
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
- Vanna: Cross-Greek between spot and vol - change in delta per 1% IV move (equivalent to change in vega per $1 spot move). Drives skew/smile P&L.
- Charm: Daily delta decay (delta-theta). Important for short-dated hedge rebalancing.
- Vomma (Volga): Vega change per 1% IV move. Convexity in vol - material for vol-of-vol trades.
- Veta: Daily vega decay. Picks up the time-erosion piece of vol exposure.

Third-order (5):
- Speed: Gamma change per $1 underlying move. Matters for large or fast spot moves.
- Ultima: Vomma change per 1% IV move. Third-order vol convexity.
- DcharmDvol: Charm sensitivity to volatility. Cross third-order term.
- Zomma: Gamma change per 1% IV move. Couples skew dynamics into delta-hedging risk.
- Color: Daily gamma decay (gamma-theta). Important for gamma-scalping near expiry.

Other (3):
- Lambda: Elasticity - percent change in option price per percent change in underlying. Useful for leverage analysis.
- Epsilon: Price sensitivity to continuous dividend yield.
- Phi: Price sensitivity to a foreign / borrow rate (FX-style cost-of-carry).`,

  capabilities: `Platform Capabilities:
- Market-data tools backed by the Options Analysis Suite proxy: IV history, IV surfaces, regime/exposure snapshots, options chains, fundamentals, news, calendars, and scanner rankings
- Synced user-analysis tools: local pricing-analysis history, rollups, FFT results, saved snapshots, and AI Compute Suite run history when the user has synced them
- GEX (Gamma Exposure) context from precomputed regime/exposure data: call/put walls, gamma flip, abs gamma anchor, dealer positioning
- Portfolio risk context from synced snapshots: VaR, beta, Sharpe, stress tests, correlation matrix, and aggregate dollar Greek exposure when present
- Structured queries over synced user analysis: "show analyses where delta > 0.8 last month" via the user's synced records
- This MCP server does not directly invoke the commercial /v1/compute REST API; use the REST/Python SDK for fresh pricing or calibration calls`,
};

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
      const effectiveTopic = topic ?? 'all';
      if (effectiveTopic === 'all') {
        const text = Object.values(PLATFORM_INFO).join('\n\n');
        return { content: [{ type: 'text', text }], structuredContent: { topic: effectiveTopic, text } };
      }
      const text = PLATFORM_INFO[effectiveTopic] || 'Unknown topic.';
      return { content: [{ type: 'text', text }], structuredContent: { topic: effectiveTopic, text } };
    },
  );
}
