/**
 * The server's MCP instructions: what a client loads at session start beside the tool names when
 * it defers tool definitions behind a search. Cross-tool workflow only - which family answers which question, the live
 * tools' prerequisites, no polling - and never the only home of a rule: each live description states its own prerequisites
 * and cost, and each answer the rules for reading it. No budget sentence. At most 1,500 characters, the key part first.
 */
export const SERVER_INSTRUCTIONS =
  'Options Analysis Suite: options analytics, dealer positioning, regime and market data, and the user\'s synced snapshots (get_snapshot). '
  + 'Two tool families answer the same questions at different freshness: the end-of-day tools read stored data and need no broker; the LIVE tools (get_live_quote, get_live_options_chain, get_live_dealer_positioning, scan_option_strategies, rank_live_skew_gex, get_intraday_bars) fetch from the user\'s broker in real time and need a broker credential stored on the user\'s account (a browser-only connection is invisible to them). '
  + 'Use a live tool when the answer depends on the current price or session (a quote, level or option price as of now), and otherwise the end-of-day sibling its description names. '
  + 'Do not poll get_live_dealer_positioning or scan_option_strategies in a loop or call them over a symbol list. For watchlist skew/GEX use rank_live_skew_gex; wait `retryAfterSeconds` before repeating its list. '
  + 'Each live description states its own prerequisites.';
