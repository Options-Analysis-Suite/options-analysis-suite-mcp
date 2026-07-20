/**
 * Token Manager
 *
 * Manages JWT lifecycle for the MCP server process:
 * - Initial login on startup
 * - Proactive refresh 2 minutes before expiry
 * - Subscription verification
 * - Graceful error handling for long-running stdio process
 */
import { login, refreshAccessToken, getProfile } from './authClient.js';
import type { AuthTokens, UserProfile } from '../types.js';
import { AuthError, SubscriptionError } from '../types.js';

const REFRESH_BUFFER_MS = 2 * 60 * 1000; // Refresh 2 min before expiry

export class TokenManager {
  private tokens: AuthTokens | null = null;
  private profile: UserProfile | null = null;
  private refreshTimerId: ReturnType<typeof setTimeout> | null = null;
  private refreshPromise: Promise<void> | null = null;

  constructor(
    private authServerUrl: string,
    private email: string,
    private password: string,
  ) {}

  /**
   * Login, fetch profile, verify subscription, schedule refresh.
   * Throws AuthError or SubscriptionError on failure.
   *
   * Stages tokens/profile locally and only commits them after the
   * subscription check passes — so a failed initialize never leaves
   * an inactive token cached on the instance.
   */
  async initialize(): Promise<void> {
    const tokens = await login(this.authServerUrl, this.email, this.password);
    const profile = await getProfile(this.authServerUrl, tokens.accessToken);

    TokenManager.assertProfileSubscriptionActive(profile);

    this.tokens = tokens;
    this.profile = profile;
    this.scheduleRefresh();
  }

  /**
   * Get a valid access token, refreshing if needed.
   */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) {
      throw new AuthError('Not authenticated. Please restart the MCP extension.');
    }

    // If within buffer of expiry, refresh now (deduplicate concurrent callers)
    const now = Date.now();
    if (now >= this.tokens.expiresAt - REFRESH_BUFFER_MS) {
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefresh()
          .then(() => this.scheduleRefresh())
          .finally(() => { this.refreshPromise = null; });
      }
      await this.refreshPromise;
    }

    return this.tokens.accessToken;
  }

  /**
   * Get cached user profile.
   */
  getProfileCached(): UserProfile | null {
    return this.profile;
  }

  /**
   * Check if user has active subscription.
   */
  isSubscriptionActive(): boolean {
    return this.profile != null && TokenManager.profileSubscriptionActive(this.profile);
  }

  private static profileSubscriptionActive(profile: UserProfile): boolean {
    if (profile.user.isDeveloper) return true;
    if (profile.user.bypassSubscription) return true;
    if (!profile.subscription) return false;
    const status = profile.subscription.status;
    return status === 'active' || status === 'trialing';
  }

  private static assertProfileSubscriptionActive(profile: UserProfile): void {
    if (!TokenManager.profileSubscriptionActive(profile)) {
      throw new SubscriptionError(
        'Your Options Analysis Suite subscription is not active. ' +
        'Please visit optionsanalysissuite.com/pricing to subscribe or renew.',
      );
    }
  }

  /**
   * Clean up timers.
   */
  destroy(): void {
    if (this.refreshTimerId) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }
  }

  private scheduleRefresh(): void {
    if (!this.tokens) return;

    // Clear any existing timer to prevent double-scheduling
    if (this.refreshTimerId) {
      clearTimeout(this.refreshTimerId);
      this.refreshTimerId = null;
    }

    const now = Date.now();
    const delay = Math.max(
      this.tokens.expiresAt - now - REFRESH_BUFFER_MS,
      30_000, // minimum 30s to prevent tight loops
    );

    this.refreshTimerId = setTimeout(async () => {
      // Use the same refreshPromise dedup as the inline path
      if (!this.refreshPromise) {
        this.refreshPromise = this.doRefresh()
          .then(() => this.scheduleRefresh())
          .finally(() => { this.refreshPromise = null; });
      }
      try { await this.refreshPromise; } catch {
        // Refresh failed — will retry on next getAccessToken() call
      }
    }, delay);
  }

  private async doRefresh(): Promise<void> {
    // Stage refreshed tokens/profile locally — do NOT mutate this.tokens or
    // this.profile until both auth and subscription checks succeed. The
    // scheduled-timer caller (scheduleRefresh) swallows errors silently, so
    // committing on failure would leave a fresh-but-inactive token cached
    // and bypass the subscription gate on the next getAccessToken().
    let nextTokens: AuthTokens;
    let nextProfile: UserProfile;

    try {
      // S2.4: GoTrue refresh via the captured gotrueRefreshToken cookie. Throws on a
      // missing/expired cookie or an MFA step-up the background refresh can't service - which
      // falls through to a full re-login below (the normal path post-GoTrue-cutover when the
      // connector holds no usable refresh cookie).
      nextTokens = await refreshAccessToken(this.authServerUrl, this.tokens?.refreshToken ?? '');
      nextProfile = await getProfile(this.authServerUrl, nextTokens.accessToken);
    } catch {
      // Any refresh failure -> full re-login with stored credentials.
      try {
        nextTokens = await login(this.authServerUrl, this.email, this.password);
        nextProfile = await getProfile(this.authServerUrl, nextTokens.accessToken);
      } catch {
        throw new AuthError('Session expired and re-login failed. Please restart the MCP extension.');
      }
    }

    // Validate subscription on the staged profile BEFORE committing. Throws
    // SubscriptionError without mutating state — the AuthError fallback above
    // does not mask this.
    TokenManager.assertProfileSubscriptionActive(nextProfile);

    this.tokens = nextTokens;
    this.profile = nextProfile;
  }
}
