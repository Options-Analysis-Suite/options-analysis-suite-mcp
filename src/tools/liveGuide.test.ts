import { describe, expect, test } from 'bun:test';
import {
  BUDGET_UNKNOWN, liveErrorMeaning, PRECHECK_CODES, rateLimitGuide, spotClockGuide, type LiveTool,
} from './liveGuide.js';

/**
 * The shared guidance of the live tools: what each error code means
 * and what to do instead, the budget line keyed on the `rateLimit` field whatever the code, the budget-unknown line on
 * every error without one that is not a verified precheck refusal, and the spot clock's meaning.
 */
const BUDGET = { limit: 120, remaining: 119, resetSeconds: 43, provider: 'tradier' };

describe('PRECHECK_CODES: the verified precheck refusals, per tool', () => {
  test('exactly the table', () => {
    const common = ['BROKER_NOT_CONNECTED', 'INVALID_SYMBOL', 'PRO_TIER_REQUIRED', 'UNKNOWN_PROVIDER'];
    const want: Record<LiveTool, string[]> = {
      quote: common,
      chain: [...common, 'INVALID_EXPIRATION'],
      dealer: [...common, 'INVALID_EXPIRATION', 'INVALID_REQUEST'],
      scan: [...common, 'INVALID_REQUEST'],
      ranking: [...common, 'INVALID_REQUEST'],
      bars: [...common, 'BARS_NOT_SUPPORTED', 'INVALID_REQUEST'],
    };
    for (const [tool, codes] of Object.entries(want)) expect([...PRECHECK_CODES[tool as LiveTool]].sort()).toEqual([...codes].sort());
  });
});

describe('liveErrorMeaning: the code legend', () => {
  test('BROKER_REJECTED: the same request on the same broker will not help, check that account, another stored broker may', () => {
    const m = liveErrorMeaning('quote', 'BROKER_REJECTED', { rateLimit: BUDGET }, false)!;
    expect(m).toMatch(/refused the request itself/);
    expect(m).toMatch(/Retrying the same request on the same broker will not help/);
    expect(m).toMatch(/check that broker's account/);
    expect(m).toMatch(/another stored broker may answer/);
    expect(m).toMatch(/not a credential refusal or a failed sign-in/);
  });

  test('BROKER_REJECTED on the bars carries the 4xx rule its description no longer spells out', () => {
    const m = liveErrorMeaning('bars', 'BROKER_REJECTED', { rateLimit: BUDGET }, false)!;
    expect(m).toMatch(/an HTTP 4xx other than 408, 409, 425 and 429/);
    expect(m).toMatch(/Public, for one, answers a symbol it does not list with a 400/);
    expect(m).toMatch(/Retrying the same request on the same broker will not help/);
    expect(m).toMatch(/another stored broker may answer/);
  });

  test('BROKER_ENTITLEMENT_MISSING: moomoo lacks the permission or the market; not retryable; another broker may', () => {
    const m = liveErrorMeaning('chain', 'BROKER_ENTITLEMENT_MISSING', {}, false)!;
    expect(m).toMatch(/moomoo/);
    expect(m).toMatch(/real-time permission/);
    expect(m).toMatch(/does not serve that market or instrument/);
    expect(m).toMatch(/another stored broker may answer/);
  });

  test('BROKER_UNAVAILABLE names every brokerFailure value and that no broker text is passed on', () => {
    const m = liveErrorMeaning('dealer', 'BROKER_UNAVAILABLE', { brokerFailure: 'timeout' }, false)!;
    for (const v of ['"http-status"', 'brokerStatus', '"timeout"', '"unreadable-response"', '"no-usable-answer"', '"other"']) expect(m).toContain(v);
    expect(m).toMatch(/no broker text is passed on/i);
    expect(m).toMatch(/may be retried/);
  });

  test('quote no-usable-answer names the five price fields, not a missing chain or spot', () => {
    const m = liveErrorMeaning('quote', 'BROKER_UNAVAILABLE', { brokerFailure: 'no-usable-answer' }, false)!;
    for (const field of ['last', 'bid', 'ask', 'mark', 'previousClose']) expect(m).toContain(field);
    expect(m).toMatch(/finite number/);
    expect(m).not.toMatch(/strikes or spot/);
    expect(m).toMatch(/no item for the symbol is classified as "other"/);
  });

  test('a broker\'s wait survives a switch to another stored broker', () => {
    const HOLDS = /Another stored broker has its own budget and is not held by this wait\. If one answers, still (give this refusal's wait|say in the answer)/;
    expect(liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: { ...BUDGET, remaining: 0 }, retryAfterSeconds: 56 }, false)).not.toMatch(/switching does not lift/);
    expect(liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: 56 }, false)).toMatch(HOLDS);
    expect(liveErrorMeaning('scan', 'RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: 56 }, false)).toMatch(HOLDS);
    expect(liveErrorMeaning('scan', 'RATE_LIMITED', { retryAfterSeconds: 5 }, false)).not.toMatch(HOLDS);
    expect(liveErrorMeaning('scan', 'RATE_LIMITED', {}, true)).not.toMatch(HOLDS);
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 12 }, false)).toMatch(HOLDS);
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: null }, false)).toMatch(HOLDS);
  });

  test('a switcher is told to give this refusal\'s wait, with its figure', () => {
    const zero = { ...BUDGET, remaining: 0 };
    const capacity = liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: zero, retryAfterSeconds: 56 }, false)!;
    expect(capacity).toContain("shared limiter capacity can refuse it too. If one answers, still give this refusal's wait "
      + "(56 seconds) in the answer and say the platform's limiter, not the broker, refused the tradier request.");
    const holds = liveErrorMeaning('scan', 'RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: 12 }, false)!;
    expect(holds).toContain("is not held by this wait. If one answers, still give this refusal's wait (12 seconds) in the "
      + "answer and say the platform's limiter, not the broker, refused the tradier request.");
    // RATE_LIMITED with no retryAfterSeconds waits until the budget resets
    expect(liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: BUDGET }, false))
      .toContain("still give this refusal's wait (43 seconds) in the answer");
    expect(liveErrorMeaning('quote', 'RATE_LIMITED', { rateLimit: { ...BUDGET, provider: null }, retryAfterSeconds: 1 }, false))
      .toContain("still give this refusal's wait (1 second) in the answer and say the platform's limiter, not the broker, refused the request.");
    const broker = liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: 12 }, false)!;
    expect(broker).toContain("is not held by this wait. If one answers, still give this refusal's wait (12 seconds) in the "
      + 'answer and say tradier itself refused.');
    // the platform's meter resets on its own clock: a broker refusal's wait is only the broker's retryAfterSeconds
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: null }, false))
      .toContain('If one answers, still say in the answer that tradier itself refused and did not say how long to wait.');
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 30 }, false))
      .toContain("still give this refusal's wait (30 seconds) in the answer and say the broker itself refused.");
    for (const m of [capacity, holds, broker]) expect(m).not.toContain('the answer still');
    // the refusing broker rides in details.provider (liveApiClient's BROKER_RATE_LIMITED), with or without a rateLimit
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 12, provider: 'schwab' }, false))
      .toContain("still give this refusal's wait (12 seconds) in the answer and say schwab itself refused.");
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: null, provider: 'schwab' }, false))
      .toContain('still say in the answer that schwab itself refused and did not say how long to wait.');
  });

  test('the budget-unknown line names no cause', () => {
    expect(BUDGET_UNKNOWN).not.toMatch(/proxy/);
    expect(BUDGET_UNKNOWN).toContain('a request that timed out or did not complete can still have used broker requests (the missing budget alone does not say where it stopped)');
    expect(BUDGET_UNKNOWN).toContain('For an error, only a refusal made before the broker is called establishes that nothing was charged.');
  });

  test('an invalid broker wait is unknown, not an instruction to wait it or proof the broker said nothing', () => {
    for (const wait of [-1, NaN, Infinity, -Infinity, '12', undefined]) {
      const meaning = liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: wait }, false)!;
      expect(meaning).not.toContain('Wait retryAfterSeconds before retrying');
      expect(meaning).not.toContain('did not say how long');
      expect(meaning).toContain('wait is unknown here');
      expect(meaning).toMatch(/back off/i);
    }
    expect(liveErrorMeaning('quote', 'BROKER_RATE_LIMITED', { retryAfterSeconds: null }, false))
      .toContain('did not say how long');
  });

  test('an unreported platform wait is reported as unknown after a switch', () => {
    const meaning = liveErrorMeaning('chain', 'RATE_LIMITED', {
      retryAfterSeconds: -1, rateLimit: { ...BUDGET, provider: '', resetSeconds: Infinity },
    }, false)!;
    expect(meaning).not.toContain('still give this refusal\'s wait in the answer');
    expect(meaning).toContain('wait is unknown here');
    expect(meaning).toContain('refused the request');
    // A bad retry value can still fall back to a usable platform reset; it never substitutes for a broker wait.
    expect(liveErrorMeaning('chain', 'RATE_LIMITED', { retryAfterSeconds: -1, rateLimit: BUDGET }, false))
      .toContain("still give this refusal's wait (43 seconds)");
  });

  test('the switch reminder preserves who refused, even with budget remaining', () => {
    const platform = liveErrorMeaning('dealer', 'RATE_LIMITED', {
      rateLimit: { ...BUDGET, remaining: 1 }, retryAfterSeconds: 12,
    }, false)!;
    expect(platform).toContain('This was the live-broker limiter');
    expect(platform).not.toContain("reports this broker's refusal");
    expect(platform).toContain("still give this refusal's wait (12 seconds) in the answer and say the platform's limiter, not the broker, refused");
    const broker = liveErrorMeaning('dealer', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 12 }, false)!;
    expect(broker).toContain("the broker's own rate limit, not the platform's");
    expect(broker).not.toContain("the platform's limiter");
    expect(broker).toContain("still give this refusal's wait (12 seconds) in the answer and say the broker itself refused.");
  });

  test('an absent budget does not erase a known failure location', () => {
    const meaning = liveErrorMeaning('chain', 'UPSTREAM_TRUNCATED', {}, false)!;
    // This code says the reply was cut off in transit, even though it cannot report broker spend.
    expect(meaning).not.toContain('the error does not say where it stopped');
    expect(meaning).toContain('the missing budget alone does not say where it stopped');
  });

  test('RATE_LIMITED with zero remaining can be shared limiter capacity, not spent broker quota', () => {
    const zero = { ...BUDGET, remaining: 0 };
    for (const tool of ['quote', 'chain', 'dealer', 'scan', 'ranking', 'bars'] as const) {
      const meaning = liveErrorMeaning(tool, 'RATE_LIMITED', { rateLimit: zero, retryAfterSeconds: 60 }, false)!;
      expect(meaning).toMatch(/remaining 0.*shared limiter capacity/);
      expect(meaning).toMatch(/without this account exhausting its broker quota/);
      expect(meaning).toMatch(/resetSeconds and retryAfterSeconds.*advisory.*not.*budget reset/);
      // The real limiter, with a full map, refused Tradier, Schwab and tastytrade for the same new caller.
      // Zero remaining cannot distinguish that shared-capacity refusal from an exhausted broker bucket.
      expect(meaning).not.toContain('is not held by this wait');
      expect(meaning).toContain('shared limiter capacity can refuse it too');
      expect(meaning).toContain("If one answers, still give this refusal's wait (60 seconds) in the answer and say the platform's limiter, not the broker, refused the tradier request.");
      expect(meaning).not.toContain("still give this refusal's wait in the answer");
      expect(liveErrorMeaning(tool, 'RATE_LIMITED', { rateLimit: BUDGET }, false)).not.toMatch(/shared limiter capacity/);
      expect(liveErrorMeaning(tool, 'RATE_LIMITED', { rateLimit: null }, false)).not.toMatch(/shared limiter capacity/);
      expect(liveErrorMeaning(tool, 'RATE_LIMITED', {}, false)).not.toMatch(/shared limiter capacity/);
      expect(liveErrorMeaning(tool, 'RATE_LIMITED', { rateLimit: zero }, true)).not.toMatch(/shared limiter capacity/);
      expect(liveErrorMeaning(tool, 'BROKER_RATE_LIMITED', { rateLimit: zero }, false)).not.toMatch(/shared limiter capacity/);
    }
  });

  test('BROKER_RATE_LIMITED beside rateLimit: the platform meter can show requests left while the broker refuses', () => {
    const withBudget = liveErrorMeaning('scan', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 30, rateLimit: BUDGET }, false)!;
    expect(withBudget).toMatch(/rateLimit is the platform's meter, so it can show requests left while the broker itself refuses/);
    expect(liveErrorMeaning('scan', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 30 }, false)).not.toMatch(/platform's meter/);
  });

  test('BROKER_RATE_LIMITED: wait retryAfterSeconds; a null wait says to back off', () => {
    const named = liveErrorMeaning('scan', 'BROKER_RATE_LIMITED', { retryAfterSeconds: 30 }, false)!;
    expect(named).toMatch(/broker's own rate limit/);
    expect(named).toMatch(/retryAfterSeconds/);
    expect(named).not.toMatch(/back off/);
    const unnamed = liveErrorMeaning('scan', 'BROKER_RATE_LIMITED', { retryAfterSeconds: null }, false)!;
    expect(unnamed).toMatch(/back off/);
  });

  test('RATE_LIMITED from the live limiter: a refused extension comes after charged requests, so it does not mean nothing reached the broker', () => {
    const live = liveErrorMeaning('chain', 'RATE_LIMITED', { rateLimit: BUDGET, retryAfterSeconds: 12 }, false)!;
    expect(live).toMatch(/platform limiter refused/);
    expect(live).toMatch(/charges nothing/);
    expect(live).toMatch(/part way/);
    expect(live).toMatch(/does not mean nothing reached the broker/);
    const general = liveErrorMeaning('chain', 'RATE_LIMITED', { retryAfterSeconds: 12 }, false)!;
    expect(general).toMatch(/general per-minute limit/);
    expect(general).not.toMatch(/part way/);
  });

  test('BUDGET_UNKNOWN scopes its last sentence to errors', () => {
    expect(BUDGET_UNKNOWN).toMatch(/For an error, only a refusal made before the broker is called establishes that nothing was charged\.$/);
  });

  test('a precheck code of THIS tool says nothing was charged; the same code on a tool that does not precheck it is budget unknown', () => {
    const pre = liveErrorMeaning('chain', 'INVALID_EXPIRATION', {}, false)!;
    expect(pre).toMatch(/INVALID_EXPIRATION is refused before the broker is called, so nothing was charged/);
    expect(pre).not.toContain(BUDGET_UNKNOWN);
    const notPre = liveErrorMeaning('quote', 'INVALID_EXPIRATION', {}, false)!;
    expect(notPre).toContain(BUDGET_UNKNOWN);
    expect(notPre).not.toMatch(/is refused before the broker is called/);
  });
});

describe('liveErrorMeaning: the field-keyed budget lines', () => {
  test('an error carrying rateLimit gets the budget line and no budget-unknown line, whatever the code', () => {
    const m = liveErrorMeaning('quote', 'BROKER_REJECTED', { rateLimit: BUDGET }, false)!;
    expect(m).toMatch(/budget after this call/);
    expect(m).not.toContain(BUDGET_UNKNOWN);
  });

  test('a code-less error carrying rateLimit (a non-JSON body after the charge) gets the budget line', () => {
    const m = liveErrorMeaning('quote', undefined, { rateLimit: BUDGET }, false)!;
    expect(m).toMatch(/budget after this call/);
    expect(m).not.toContain(BUDGET_UNKNOWN);
  });

  test('an error without rateLimit that is not a precheck refusal is budget unknown (a transport timeout included)', () => {
    expect(liveErrorMeaning('quote', 'BROKER_UNAVAILABLE', {}, false)).toContain(BUDGET_UNKNOWN);
    expect(liveErrorMeaning('chain', 'UPSTREAM_UNAVAILABLE', {}, false)).toContain(BUDGET_UNKNOWN);
    expect(liveErrorMeaning('ranking', 'BROKER_CREDENTIAL_INVALID', {}, false)).toContain(BUDGET_UNKNOWN);
  });

  test('details dropped for size (detailsOmitted) leave the budget unknown even where they carried rateLimit', () => {
    const m = liveErrorMeaning('quote', 'BROKER_UNAVAILABLE', { rateLimit: BUDGET }, true)!;
    expect(m).toContain(BUDGET_UNKNOWN);
    expect(m).not.toMatch(/budget after this call/);
  });

  test('BUDGET_UNKNOWN says an absent rateLimit proves nothing and only a precheck refusal establishes no charge', () => {
    expect(BUDGET_UNKNOWN).toMatch(/says nothing about whether broker quota was spent/);
    expect(BUDGET_UNKNOWN).toMatch(/timed out/);   // Reworded from "a timeout or an unreachable proxy"
    expect(BUDGET_UNKNOWN).toMatch(/before the broker/);
  });
});

describe('rateLimitGuide', () => {
  test('absent field: no line', () => {
    expect(rateLimitGuide(undefined)).toBeUndefined();
  });

  test('present: remaining of limit on provider, the reset, the brokers\' own documented quotas', () => {
    const g = rateLimitGuide(BUDGET)!;
    expect(g).toMatch(/budget after this call/);
    expect(g).toMatch(/broker's own requests/);
    for (const fact of ['120 a minute on Tradier and Schwab', '600 on Public', '120 on tastytrade', '30 on moomoo']) expect(g).toContain(fact);
  });

  test('null: the proxy reported none, and no number is invented', () => {
    const g = rateLimitGuide(null)!;
    expect(g).toMatch(/reported no budget/);
    expect(g).not.toMatch(/\d/);
  });

  test('the budget is the platform\'s meter, never a figure the broker reports', () => {
    const g = rateLimitGuide(BUDGET)!;
    expect(g).toMatch(/^rateLimit is the platform's own count of this broker's budget after this call \(the proxy's meter, not a figure the broker reports\)/);
    expect(rateLimitGuide(null)).toMatch(/^rateLimit is null: the proxy reported no budget for this call/);
    expect(rateLimitGuide(null)).not.toMatch(/the broker reported/);
    expect(g).toContain('not a per-call spend report');
  });

  test('the shared window tracks broker requests and reservations, not tool-call count or this call alone', () => {
    // A one-request call can leave 119/120; a subsequent cache hit leaves the same 119/120. An outstanding
    // nine-request reservation then publishes 110/120 before those requests are sent (liveBrokerLimiter.ts).
    for (const remaining of [119, 110]) {
      const g = rateLimitGuide({ ...BUDGET, remaining })!;
      expect(g).toContain('broker requests and outstanding reservations');
      expect(g).toContain("across this account's calls in the window");
      expect(g).toContain('Cache-only calls send no broker requests');
      expect(g).not.toContain('counts every call');
      expect(g).not.toContain('is not what this call spent');
    }
  });
});

describe('spotClockGuide', () => {
  test('the print time, the stale rule stated in full, both null without a print time', () => {
    const g = spotClockGuide('tradier');
    expect(g).toMatch(/print time/);
    expect(g).toMatch(/09:30 New York open of the last session that has started/);
    expect(g).toMatch(/null/);
  });

  test('the moomoo clause only on moomoo, never on a null or unknown provider', () => {
    expect(spotClockGuide('moomoo')).toMatch(/moomoo[^.]*update time/);
    expect(spotClockGuide(null)).not.toMatch(/moomoo/);
    expect(spotClockGuide(undefined)).not.toMatch(/moomoo/);
    expect(spotClockGuide('tastytrade')).not.toMatch(/moomoo/);
  });
});

describe('the legend and the spot clock', () => {
  const BUDGET2 = { limit: 120, remaining: 0, resetSeconds: 30, provider: 'tradier' };
  test('quote and bars RATE_LIMITED: refused before it was sent, nothing charged - no part-way clause', () => {
    for (const tool of ['quote', 'bars'] as const) {
      const m = liveErrorMeaning(tool, 'RATE_LIMITED', { rateLimit: BUDGET2 }, false)!;
      expect(m).toMatch(/before it was sent/);
      expect(m).toMatch(/nothing was charged/);
      expect(m).not.toMatch(/does not mean nothing reached the broker/);
    }
  });
  test('RATE_LIMITED with its details dropped does not claim which limiter it was', () => {
    const m = liveErrorMeaning('chain', 'RATE_LIMITED', {}, true)!;
    expect(m).not.toMatch(/This one carries no live budget/);
    expect(m).toMatch(/either/);
  });
  test('quota figures move out of descriptions into every present-budget guide', () => {
    for (const tool of ['quote', 'bars', 'chain'] as const) {
      expect(liveErrorMeaning(tool, 'BROKER_REJECTED', { rateLimit: BUDGET2 }, false)).toMatch(/120 a minute/);
    }
  });
  test('spotClockGuide: null also with no session on file; null is unknown, never fresh', () => {
    expect(spotClockGuide('tradier')).toMatch(/no session is on file/);
    expect(spotClockGuide('tradier')).toMatch(/never fresh/);
  });
});
