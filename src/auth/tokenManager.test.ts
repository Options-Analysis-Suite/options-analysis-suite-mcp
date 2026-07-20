import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { AuthError, SubscriptionError } from '../types.js';

// We mock the entire authClient module so TokenManager exercises its real
// orchestration logic against deterministic auth/profile responses.
const fakes = {
  login: mock(async () => ({ accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() + 3_600_000 })),
  refreshAccessToken: mock(async () => ({ accessToken: 'tok2', refreshToken: 'r2', expiresAt: Date.now() + 3_600_000 })),
  getProfile: mock(async () => ({
    user: { isDeveloper: false, bypassSubscription: false } as any,
    subscription: { status: 'active' } as any,
  })),
};

mock.module('./authClient.js', () => fakes);

// Import AFTER mocking the dependency so TokenManager binds to the mock.
const { TokenManager } = await import('./tokenManager.js');

function activeProfile() {
  return {
    user: { isDeveloper: false, bypassSubscription: false } as any,
    subscription: { status: 'active' } as any,
  };
}
function inactiveProfile() {
  return {
    user: { isDeveloper: false, bypassSubscription: false } as any,
    subscription: { status: 'canceled' } as any,
  };
}
function expiredTokens() {
  // expiresAt in the past forces getAccessToken() into the refresh path.
  return { accessToken: 'old', refreshToken: 'old-r', expiresAt: Date.now() - 1_000 };
}
function freshTokens() {
  return { accessToken: 'new', refreshToken: 'new-r', expiresAt: Date.now() + 3_600_000 };
}

beforeEach(() => {
  fakes.login.mockReset();
  fakes.refreshAccessToken.mockReset();
  fakes.getProfile.mockReset();
});

describe('TokenManager — initialize() subscription enforcement', () => {
  test('throws SubscriptionError when subscription is inactive at startup', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await expect(tm.initialize()).rejects.toBeInstanceOf(SubscriptionError);
  });
});

describe('TokenManager — doRefresh() preserves SubscriptionError (PR #5 P1)', () => {
  test('inactive subscription on refresh path surfaces SubscriptionError, not AuthError', async () => {
    // Initialize with an active subscription so we can reach getAccessToken.
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy(); // cancel the proactive timer

    // Force an expired-token state so getAccessToken triggers doRefresh.
    (tm as any).tokens = expiredTokens();

    // Refresh succeeds, but the refreshed profile is inactive.
    fakes.refreshAccessToken.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(SubscriptionError);
  });

  test('refresh fails + re-login succeeds + subscription inactive surfaces SubscriptionError', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy();
    (tm as any).tokens = expiredTokens();

    // Refresh throws → fallback re-login → re-login succeeds → subscription inactive.
    fakes.refreshAccessToken.mockImplementation(async () => { throw new Error('refresh 401'); });
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(SubscriptionError);
  });

  test('refresh fails + re-login fails surfaces AuthError', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy();
    (tm as any).tokens = expiredTokens();

    fakes.refreshAccessToken.mockImplementation(async () => { throw new Error('refresh 401'); });
    fakes.login.mockImplementation(async () => { throw new Error('login 401'); });

    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('TokenManager — staging prevents inactive-token leak through swallowed scheduler errors', () => {
  // The scheduled-timer path in scheduleRefresh() catches and silently
  // swallows refresh failures. If doRefresh committed tokens/profile BEFORE
  // checking subscription, a fresh-but-inactive token would land in
  // this.tokens, and the next getAccessToken() would return it without
  // re-checking subscription — bypassing the entitlement gate.

  test('refresh-path SubscriptionError leaves prior tokens/profile unchanged', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy();

    (tm as any).tokens = expiredTokens();

    // Refresh returns a fresh token but for an inactive subscription.
    fakes.refreshAccessToken.mockImplementation(async () => ({
      accessToken: 'INACTIVE_FRESH', refreshToken: 'r-inactive', expiresAt: Date.now() + 3_600_000,
    }));
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(SubscriptionError);

    // The fresh-but-inactive token must NOT have been committed.
    expect((tm as any).tokens.accessToken).not.toBe('INACTIVE_FRESH');
    // Profile must not have been replaced with the inactive one.
    expect((tm as any).profile?.subscription?.status).not.toBe('canceled');
  });

  test('re-login-fallback SubscriptionError leaves prior tokens/profile unchanged', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy();
    (tm as any).tokens = expiredTokens();

    // Refresh fails → re-login succeeds with inactive subscription.
    fakes.refreshAccessToken.mockImplementation(async () => { throw new Error('refresh 401'); });
    fakes.login.mockImplementation(async () => ({
      accessToken: 'RELOGIN_INACTIVE', refreshToken: 'r-relogin', expiresAt: Date.now() + 3_600_000,
    }));
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(SubscriptionError);

    expect((tm as any).tokens.accessToken).not.toBe('RELOGIN_INACTIVE');
    expect((tm as any).profile?.subscription?.status).not.toBe('canceled');
  });

  test('scheduled-timer swallow path: post-failure getAccessToken rejects with SubscriptionError', async () => {
    fakes.login.mockImplementation(async () => freshTokens());
    fakes.getProfile.mockImplementation(async () => activeProfile());
    const tm = new TokenManager('https://auth', 'a@b.c', 'pw');
    await tm.initialize();
    tm.destroy();

    // Force the next getAccessToken to enter the refresh path.
    (tm as any).tokens = expiredTokens();

    // Refresh would return a fresh-but-inactive token if staging didn't gate.
    fakes.refreshAccessToken.mockImplementation(async () => ({
      accessToken: 'INACTIVE_FRESH', refreshToken: 'r-inactive', expiresAt: Date.now() + 3_600_000,
    }));
    fakes.getProfile.mockImplementation(async () => inactiveProfile());

    // Simulate the timer firing doRefresh and swallowing the SubscriptionError
    // (mirrors scheduleRefresh's try { await refreshPromise; } catch {}).
    try { await (tm as any).doRefresh(); } catch { /* swallowed by scheduler */ }

    // The end-to-end assertion: the next getAccessToken must NOT return a
    // fresh inactive token. Because staging held back the commit, this.tokens
    // is still the expired stub — getAccessToken re-enters refresh, refresh
    // returns inactive again, SubscriptionError surfaces.
    await expect(tm.getAccessToken()).rejects.toBeInstanceOf(SubscriptionError);
  });
});
