import { describe, expect, it } from 'bun:test';
import { omittedRowsSentence, readOmittedRows } from './omittedRows.js';

/** The proxy's omittedRows is read strictly: a count is carried only as the proxy sent it, never guessed or patched. */
describe('readOmittedRows', () => {
  const VALID = { total: 3, quarantined: 1, invalidStrike: 0, notSuccess: 0, unquoted: 2 };

  it('a well-formed count is carried as it came', () => {
    expect(readOmittedRows(VALID)).toEqual(VALID);
  });

  it('a total of zero is nothing left out: null', () => {
    expect(readOmittedRows({ total: 0, quarantined: 0, invalidStrike: 0, notSuccess: 0, unquoted: 0 })).toBeNull();
  });

  it('any field missing, negative, fractional or not a number: null, never a partial count', () => {
    expect(readOmittedRows({ ...VALID, unquoted: undefined })).toBeNull();
    expect(readOmittedRows({ ...VALID, quarantined: -1 })).toBeNull();
    expect(readOmittedRows({ ...VALID, quarantined: 1.5 })).toBeNull();
    expect(readOmittedRows({ ...VALID, quarantined: '1' })).toBeNull();
    expect(readOmittedRows(null)).toBeNull();
    expect(readOmittedRows([VALID])).toBeNull();
  });

  it('says the count in words', () => {
    expect(omittedRowsSentence({ total: 1, quarantined: 0, invalidStrike: 0, notSuccess: 1, unquoted: 0 }))
      .toBe('The broker sent 1 row that could not be used (1 the broker marked failed); the totals leave them out.');
  });
});
