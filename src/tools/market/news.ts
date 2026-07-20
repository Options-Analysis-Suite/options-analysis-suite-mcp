import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeNewsResponse } from './newsShaping.js';

type FundamentalsSummary = {
  company_profile?: unknown;
  [key: string]: unknown;
};

type NewsCompanyProfile = Record<string, unknown> & {
  company_name?: string;
  description?: string;
  sector?: string;
  industry?: string;
  is_etf?: boolean;
};

function getObject(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeNewsCompanyProfile(profile: unknown): NewsCompanyProfile | null {
  const rawProfile = getObject(profile);
  if (!rawProfile) return null;

  const companyName = typeof rawProfile.company_name === 'string'
    ? rawProfile.company_name
    : typeof rawProfile.companyName === 'string'
      ? rawProfile.companyName
      : null;
  const description = typeof rawProfile.description === 'string'
    ? rawProfile.description
    : typeof rawProfile.descriptionText === 'string'
      ? rawProfile.descriptionText
      : null;
  const sector = typeof rawProfile.sector === 'string' ? rawProfile.sector : null;
  const industry = typeof rawProfile.industry === 'string' ? rawProfile.industry : null;
  const isEtf = typeof rawProfile.is_etf === 'boolean'
    ? rawProfile.is_etf
    : typeof rawProfile.isEtf === 'boolean'
      ? rawProfile.isEtf
      : typeof companyName === 'string'
        ? /\b(etf|fund|trust)\b/i.test(companyName)
        : false;

  return {
    ...rawProfile,
    ...(companyName ? { company_name: companyName } : {}),
    ...(description ? { description } : {}),
    ...(sector ? { sector } : {}),
    ...(industry ? { industry } : {}),
    is_etf: isEtf,
  };
}

function mergeNewsCompanyProfiles(
  primaryProfile: NewsCompanyProfile | null,
  fallbackProfile: NewsCompanyProfile | null,
): NewsCompanyProfile | null {
  if (!primaryProfile) return fallbackProfile;
  if (!fallbackProfile) return primaryProfile;

  return {
    ...fallbackProfile,
    ...primaryProfile,
    company_name: typeof primaryProfile.company_name === 'string' && primaryProfile.company_name.trim()
      ? primaryProfile.company_name
      : fallbackProfile.company_name,
    description: typeof primaryProfile.description === 'string' && primaryProfile.description.trim()
      ? primaryProfile.description
      : fallbackProfile.description,
    sector: typeof primaryProfile.sector === 'string' && primaryProfile.sector.trim()
      ? primaryProfile.sector
      : fallbackProfile.sector,
    industry: typeof primaryProfile.industry === 'string' && primaryProfile.industry.trim()
      ? primaryProfile.industry
      : fallbackProfile.industry,
    is_etf: primaryProfile.is_etf === true || fallbackProfile.is_etf === true,
  };
}

function hasUsableNewsCompanyName(profile: NewsCompanyProfile | null): boolean {
  return typeof profile?.company_name === 'string' && profile.company_name.trim().length > 0;
}

export function pickNewsCompanyProfile(primaryProfile: unknown, fundamentalsPayload?: unknown): NewsCompanyProfile | null {
  const normalizedPrimary = normalizeNewsCompanyProfile(primaryProfile);
  const fundamentals = getObject(fundamentalsPayload) as FundamentalsSummary | null;
  const normalizedFallback = normalizeNewsCompanyProfile(fundamentals?.company_profile);

  if (!normalizedPrimary) return normalizedFallback;
  if (!hasUsableNewsCompanyName(normalizedPrimary) && normalizedFallback) {
    return mergeNewsCompanyProfiles(normalizedPrimary, normalizedFallback);
  }

  return mergeNewsCompanyProfiles(normalizedPrimary, normalizedFallback);
}

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_news',
    {
      title: 'News',
      description: 'Get recent news headlines for a stock. Useful for understanding catalysts behind price or volatility moves, and for assessing event risk before entering an options position. Default response relevance-ranks the latest raw feed against the company profile and suppresses filing-style ownership updates when stronger catalyst news is available.',
      inputSchema: {
        symbol: z.string().describe('Ticker symbol'),
        full: z.boolean().optional().describe('Return the less-summarized recent news feed without relevance filtering (raw shape, still subject to the MCP response budget).'),
      },
      // OpenAI app review treats openWorldHint as public-state mutation. This
      // MCP call reads synced platform data and cannot publish, message, trade,
      // submit, or otherwise change public or third-party systems.
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      const res = await client.get(`/stock-news/${upperSymbol}`, { limit: '50' });
      if (full) return { _skipSizeGuard: true, data: res };

      const companyProfile = await client.get(`/company-profile/${upperSymbol}`).catch(() => null);
      const profileForShaping = pickNewsCompanyProfile(companyProfile);
      return shapeNewsResponse(symbol, res, profileForShaping);
    }),
  );
}
