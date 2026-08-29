import { describe, expect, test } from 'bun:test';
import { requestSource, resolveRequestSource } from './clientSource.js';

describe('requestSource', () => {
  test('x-real-ip is the identity, and beats the socket peer', () => {
    expect(requestSource({ 'x-real-ip': '203.0.113.10' }, '10.0.0.1')).toBe('203.0.113.10');
  });

  test('a client-written x-forwarded-for is ignored unless explicitly trusted', () => {
    // Prepending a fresh address per request must not buy a fresh budget.
    expect(requestSource({ 'x-forwarded-for': '198.51.100.1' }, '10.0.0.1')).toBe('10.0.0.1');
    expect(requestSource({ 'x-real-ip': '203.0.113.10', 'x-forwarded-for': '198.51.100.1' }, '10.0.0.1'))
      .toBe('203.0.113.10');
  });

  test('when trusted, only the LAST x-forwarded-for hop counts', () => {
    expect(requestSource({ 'x-forwarded-for': '198.51.100.1, 203.0.113.7' }, '10.0.0.1', { trustXff: true }))
      .toBe('203.0.113.7');
    // A malformed rightmost hop fails closed to the socket, never leftward.
    expect(requestSource({ 'x-forwarded-for': '198.51.100.1, garbage' }, '10.0.0.1', { trustXff: true }))
      .toBe('10.0.0.1');
  });

  test('a non-IP x-real-ip is not an identity', () => {
    expect(requestSource({ 'x-real-ip': 'not-an-ip' }, '10.0.0.1')).toBe('10.0.0.1');
    expect(requestSource({ 'x-real-ip': ['203.0.113.10', '203.0.113.11'] }, undefined)).toBe('203.0.113.10');
  });

  test('reports where the identity came from, so a fallback can be surfaced', () => {
    expect(resolveRequestSource({ 'x-real-ip': '203.0.113.10' }, '10.0.0.1')).toEqual({ source: '203.0.113.10', from: 'x-real-ip' });
    expect(resolveRequestSource({ 'x-forwarded-for': '203.0.113.7' }, '10.0.0.1', { trustXff: true })).toEqual({ source: '203.0.113.7', from: 'x-forwarded-for' });
    // A present-but-invalid x-real-ip is a fallback too, not a quiet success.
    expect(resolveRequestSource({ 'x-real-ip': 'not-an-ip' }, '10.0.0.1')).toEqual({ source: '10.0.0.1', from: 'socket' });
    expect(resolveRequestSource({}, undefined)).toEqual({ source: 'unknown', from: 'unknown' });
  });

  test('with nothing usable the source is the literal unknown bucket', () => {
    expect(requestSource({}, undefined)).toBe('unknown');
    expect(requestSource({}, 'garbage')).toBe('unknown');
  });
});
