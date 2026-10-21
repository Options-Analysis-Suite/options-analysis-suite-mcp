/**
 * The Stock Charts catalogue's indicator types (packages/shared/src/indicators/catalogue.ts), as the closed list the
 * `indicators[].name` parameter of get_stock_prices and get_intraday_bars accepts. The MCP server bundles nothing from
 * outside its own directory, so the list is copied here; indicatorNames.test.ts pins it to the catalogue.
 * Every entry is a read-only computation on the bars the tool returns.
 */
export const INDICATOR_NAMES = [
  'ad', 'adx', 'alma', 'aroon', 'atr', 'awesome_osc', 'bollinger', 'cci', 'chandelier', 'choppiness', 'cmf', 'cmo',
  'connors_rsi', 'coppock', 'dema', 'dmi', 'donchian', 'dpo', 'elder_ray', 'ema', 'envelope', 'eom', 'fisher',
  'force_index', 'hma', 'ichimoku', 'keltner', 'klinger', 'kst', 'linreg', 'linreg_channel', 'macd', 'mass_index',
  'mcginley', 'mfi', 'momentum', 'net_volume', 'obv', 'ppo', 'psar', 'pvt', 'roc', 'rsi', 'rvi', 'sma', 'stddev',
  'stoch_rsi', 'stochastic', 'supertrend', 'tema', 'trix', 'ultimate_osc', 'vroc', 'vwap', 'vwma', 'williams_r',
  'wma', 'zlema',
] as const;
