/**
 * Shared types for the MCP server.
 */

/** Config provided by Claude Desktop extension manifest */
export interface McpConfig {
  email: string;
  password: string;
  proxyUrl: string;
  authServerUrl: string;
}

/** JWT tokens from auth server */
export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix ms
}

/** User profile from auth server */
export interface UserProfile {
  user: {
    id: number;
    email: string;
    role: string;
    isDeveloper?: boolean;
    bypassSubscription?: boolean;
  };
  subscription: {
    status: string; // 'active' | 'trialing' | 'past_due' | 'cancelled'
    planType: string;
    currentPeriodEnd?: string;
    daysRemaining?: number;
  } | null;
}

/** Standard error types for MCP tool responses */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class SubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubscriptionError';
  }
}

export class ApiError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'ApiError';
  }
}
