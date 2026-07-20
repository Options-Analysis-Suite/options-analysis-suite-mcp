-- Document the units & sign convention of user_risk_snapshots.data and
-- user_risk_snapshots.details so wire consumers (anything that reads the
-- JSONB without going through the TypeScript layer) have an authoritative
-- reference.
COMMENT ON TABLE user_risk_snapshots IS
  'Per-user risk analytics snapshots. '
  'data JSONB convention: '
  'var95/var99/cvar95/maxDrawdown/volatility are PERCENT units (e.g., 2.5 = 2.5%); '
  'volatility annualized; var95/var99/cvar95/maxDrawdown are POSITIVE loss '
  'magnitudes (var95=2.5 means a 2.5% loss). sharpeRatio/beta/correlation are '
  'dimensionless. stressResults[].scenario is a human-readable label '
  '(e.g., "Market -10%", "Vol Spike +20%"); impact is signed dollar P&L; '
  'impactPercent is signed percent of portfolioValue. '
  'details JSONB convention: '
  'historicalVarDetails has worstDay (POSITIVE magnitude of the worst single-day '
  'loss — e.g., 13.46 means the worst day was a 13.46% loss, NOT a 13.46% gain), '
  'bestDay (SIGNED return of the best day, typically positive), avgReturn '
  '(SIGNED mean daily return — negative means losing on average), all in PERCENT. '
  'sampleSize / historyDays are counts. '
  'Canonical TS descriptions: apps/web/src/services/db.ts:RiskSnapshotRecord '
  'and apps/web/src/services/historicalVaRService.ts:VaRResult.';
