import { describe, expect, test } from 'bun:test';
import { modelBackendId } from './modelLabels.js';

// Every label the two tables define, with the backend id the code gave
// it before the jump-suffix strip stopped recursing; null is a label the
// lookup does not hold, passed through as given.
const BACKEND_ID_PINS: Array<[string, string | null]> = [
  ['BlackScholes', 'BlackScholes'],
  ['Black-Scholes', 'BlackScholes'],
  ['blackScholes', 'BlackScholes'],
  ['blackscholes', 'BlackScholes'],
  ['bs', 'BlackScholes'],
  ['Black76', 'Black76'],
  ['Black-76', 'Black76'],
  ['black76', 'Black76'],
  ['JumpDiffusion', 'JumpDiffusion'],
  ['Jump Diffusion', 'JumpDiffusion'],
  ['jumpDiffusion', 'JumpDiffusion'],
  ['jumpdiffusion', 'JumpDiffusion'],
  ['VarianceGamma', 'VarianceGamma'],
  ['Variance Gamma', 'VarianceGamma'],
  ['varianceGamma', 'VarianceGamma'],
  ['variancegamma', 'VarianceGamma'],
  ['vg', 'VarianceGamma'],
  ['MonteCarlo', 'MonteCarlo'],
  ['Monte Carlo', 'MonteCarlo'],
  ['monteCarlo', 'MonteCarlo'],
  ['MonteCarlo-JumpDiffusion', 'MonteCarlo-JumpDiffusion'],
  ['Monte Carlo - Jump Diffusion', 'MonteCarlo-JumpDiffusion'],
  ['MonteCarlo-Heston', 'MonteCarlo-Heston'],
  ['Monte Carlo - Heston', 'MonteCarlo-Heston'],
  ['MonteCarlo-MeanReverting', 'MonteCarlo-MeanReverting'],
  ['Monte Carlo - Mean Reverting', 'MonteCarlo-MeanReverting'],
  ['LocalVolatility', 'LocalVol'],
  ['Local Volatility', 'LocalVol'],
  ['localVolatility', 'LocalVol'],
  ['LocalVol', 'LocalVol'],
  ['localVol', 'LocalVol'],
  ['localvol', 'LocalVol'],
  ['LocalVol-Dupire', null],
  ['Local Volatility - Dupire', 'LocalVol-Dupire'],
  ['LocalVol-CEV', null],
  ['Local Volatility - CEV', 'LocalVol-CEV'],
  ['Heston', 'Heston'],
  ['heston', 'Heston'],
  ['SABR', 'SABR'],
  ['sabr', 'SABR'],
  ['Binomial', 'Binomial'],
  ['binomial', 'Binomial'],
  ['Merton', 'Merton'],
  ['merton', 'Merton'],
  ['Kou', 'Kou'],
  ['kou', 'Kou'],
  ['ESSVI', 'ESSVI'],
  ['eSSVI', 'ESSVI'],
  ['essvi', 'ESSVI'],
  ['CGMY', 'CGMY'],
  ['cgmy', 'CGMY'],
  ['Bates', 'Bates'],
  ['bates', 'Bates'],
  ['Black Scholes', 'BlackScholes'],
  ['Black 76', 'Black76'],
  ['Local Vol', 'LocalVol'],
];

const JUMP_MODELS = ['Merton', 'Kou', 'Bates', 'Variance Gamma'];

// Case, spacing and punctuation variants of a label: each normalizes to the
// label's own lookup key.
function variants(label: string): string[] {
  return [
    label, label.toLowerCase(), label.toUpperCase(), label.replace(/ /g, '  '), label.replace(/-/g, ' '),
    label.replace(/ - /g, '-'), label.replace(/\s+/g, '_'), label.replace(/\s+/g, ''), label.replace(/-/g, '_'), `${label}.`,
  ];
}

function suffixes(jumpModel: string): string[] {
  return [` (${jumpModel})`, `(${jumpModel})`, `   (${jumpModel})`, ` (${jumpModel.toLowerCase()})`, ` (${jumpModel.toUpperCase()})`, `\t(${jumpModel})`];
}

describe('modelBackendId', () => {
  test('maps every label, and its case, spacing and punctuation variants, as before', () => {
    expect(BACKEND_ID_PINS).toHaveLength(56);
    let checked = 0;
    for (const [label, backendId] of BACKEND_ID_PINS) {
      for (const variant of variants(label)) {
        for (const padded of [variant, `  ${variant}  `, `\t${variant}\n`]) {
          expect(modelBackendId(padded), JSON.stringify(padded)).toBe(backendId ?? padded.trim());
          checked += 1;
        }
      }
    }
    expect(checked).toBe(56 * 10 * 3);
  });

  test('one jump-model suffix filters a jump-diffusion label as JumpDiffusion and leaves any other label as given', () => {
    let checked = 0;
    for (const [label, backendId] of BACKEND_ID_PINS) {
      for (const variant of variants(label)) {
        for (const jumpModel of JUMP_MODELS) {
          for (const suffix of suffixes(jumpModel)) {
            for (const padded of [`${variant}${suffix}`, `  ${variant}${suffix}  `, `\t${variant}${suffix}\n`]) {
              const expected = backendId === 'JumpDiffusion' ? 'JumpDiffusion' : padded.trim();
              expect(modelBackendId(padded), JSON.stringify(padded)).toBe(expected);
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(56 * 10 * 4 * 6 * 3);
  });

  test('a suffix it does not know, or one not at the end, leaves the label as given', () => {
    for (const label of ['Jump Diffusion (Heston)', 'Jump Diffusion (Merton', 'Jump Diffusion [Merton]', '(Merton) Jump Diffusion', 'Jump Diffusion (Merton) x', 'Jump Diffusion (VarianceGamma)']) {
      expect(modelBackendId(label), JSON.stringify(label)).toBe(label);
    }
    // A bare suffix is the label Merton.
    expect(modelBackendId(' (Merton) ')).toBe('Merton');
  });

  test('a second jump-model suffix makes the label unknown, passed through as given', () => {
    // A record is labeled with one jump model, so "Jump Diffusion (Merton)
    // (Kou)" names no stored model.
    for (const label of ['Jump Diffusion (Merton) (Kou)', 'Jump Diffusion (Kou)(Bates)', 'jumpdiffusion (Merton) (Merton)', 'Jump Diffusion (Merton) (Merton) (Merton)']) {
      expect(modelBackendId(label), JSON.stringify(label)).toBe(label);
    }
    expect(modelBackendId('  Jump Diffusion (Merton) (Kou)  ')).toBe('Jump Diffusion (Merton) (Kou)');
  });

  test('leaves unknown labels, blanks and non-strings as they came', () => {
    expect(modelBackendId('PDE')).toBe('PDE');
    expect(modelBackendId('  Barrier ')).toBe('Barrier');
    expect(modelBackendId('')).toBe('');
    expect(modelBackendId('   ')).toBe('   ');
    expect(modelBackendId(undefined)).toBeUndefined();
    expect(modelBackendId(null)).toBeNull();
    expect(modelBackendId(7)).toBe(7);
  });

  test('a label with 60,000 jump-model suffixes is one scan, not one per suffix', () => {
    // The scanner's payload: about 540 KB, under the remote endpoint's 1 MiB
    // body cap. Stripping suffixes recursively spent seconds on it and then
    // threw RangeError (maximum call stack size exceeded).
    const label = `Jump Diffusion${' (Merton)'.repeat(60_000)}`;
    expect(label).toHaveLength(540_014);
    const exec = RegExp.prototype.exec;
    let suffixScans = 0;
    RegExp.prototype.exec = function (this: RegExp, input: string) {
      if (this.source.includes('Merton|Kou|Bates|Variance Gamma')) {
        suffixScans += 1;
        // A second scan fails here, before a quadratic run can hold the suite
        // for minutes (it is synchronous, so the test timeout cannot end it).
        if (suffixScans > 1) throw new Error('the jump-suffix pattern scanned the label twice');
      }
      return exec.call(this, input);
    };
    let result: unknown;
    const started = performance.now();
    try {
      result = modelBackendId(label);
    } finally {
      RegExp.prototype.exec = exec;
    }
    const elapsedMs = performance.now() - started;
    expect(result).toBe(label);
    expect(suffixScans).toBe(1);
    expect(elapsedMs).toBeLessThan(500);
  });
});
