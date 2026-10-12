/**
 * The time Greeks' convention an Analysis record, compute run or rollup states (Greek exposure methodology v2):
 * 'time-passing' - Theta, Charm, Color, Veta and DcharmDvol are what one day of time passing does. A row saved
 * before carries no tag - its Charm, Color and DcharmDvol on the remaining-maturity sign, a GPU Monte Carlo or Local
 * Vol Theta the opposite of time passing - and is stated with the legacy wording.
 */
export const LEGACY_TIME_CONVENTION = 'legacy: model-dependent time sign';
export const TIME_PASSING_CONVENTION = 'time-passing';

export function statedTimeConvention(source: Record<string, unknown> | null | undefined, field = 'greekTimeConvention'): string {
  return source?.[field] === TIME_PASSING_CONVENTION ? TIME_PASSING_CONVENTION : LEGACY_TIME_CONVENTION;
}

/**
 * What a compute run's time convention (or its absence) covers: its model Greeks and their aggregates. Its exposure
 * sweep is the dealer-hedging sweep the time-convention change left unchanged, stated by EXPOSURE_SWEEP_CHARM_CONVENTION (the web app's
 * utils/greekTimeConvention.ts holds the same two strings).
 */
export const COMPUTE_GREEK_TIME_SCOPE = 'model Greeks and their aggregates (not the exposure sweep)';
export const EXPOSURE_SWEEP_CHARM_CONVENTION =
  'remaining-maturity sign, per calendar day (charm per year / 365), times open interest, multiplier and spot, '
  + 'negated for the dealer';
