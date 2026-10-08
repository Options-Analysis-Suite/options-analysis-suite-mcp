import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { shapeCompanyProfileResponse } from './companyProfileShaping.js';
import { ETF_READ_FAILED, fitHoldingsPage, shapeEtfBlock, withoutFileGroup } from './etfShaping.js';
import { READ_FAILED, shapeEsg } from './marketIntelShaping.js';

export const COMPANY_PROFILE_DESCRIPTION =
  'Get company profile data for a symbol with a compact normalized default view. Returns sector, industry, market cap, float metrics, key identifiers, and a trimmed business description. '
  + 'It also returns `esg`: the environmental, social, governance and overall ESG scores (0 to 100) of the latest ESG disclosure on record, which are derived from one SEC filing (its form, the period it covers, its filing date and EDGAR link; not necessarily the company\'s newest filing), and the ESG risk rating with its fiscal year and industry rank; '
  + 'a disclosure over two years old or carrying placeholder scores, and a rating for a fiscal year more than two years back, are withheld and named in `esg.withheld`. `esg` is null with `esgNote` when none is on record (ETFs have none) or the read failed. '
  + 'For a fund, `etf` carries its facts (expense ratio in percent, AUM, NAV with `factsSourceUpdatedAt`, the data source\'s refresh time), its latest holdings file as reported (`holdingsInFile`, `holdingsBasis` direct / countMismatch / unknown with `basisEvidence`, `topHoldings` with `matchKind` and any `splitWarnings`), sector and country weights; `holdings: {offset, limit}` pages ranks 1-100 with `holdingsMeta` (beside a page, `etf.topHoldings` is left out: the page is the list). A group whose identity changed since it was read is withheld with a note. A fund with no profile on record, or whose profile read failed, answers with `etf` and `profileStatus`.';

const PROFILE_FAILED = Symbol('profile read failed');

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_company_profile',
    {
      title: 'Company Profile',
      description: COMPANY_PROFILE_DESCRIPTION,
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, TSLA)'),
        full: z.boolean().optional().describe('Return the raw synced company-profile row instead of the compact normalized summary, with `esg` beside it.'),
        holdings: z.object({
          offset: z.number().int().min(0).max(99).default(0),
          limit: z.number().int().min(1).max(100).default(50),
        }).optional().describe('For a fund: a page of its latest holdings file (ranks 1-100 by weight), with `holdingsMeta`.'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, full, holdings }) => {
      const upperSymbol = encodeURIComponent(symbol.toUpperCase());
      // Each read stands apart, in every direction: an outage in one leaves the others standing.
      let profileError: unknown = null;
      const [res, esg, fund] = await Promise.all([
        (client.get(`/company-profile/${upperSymbol}`) as Promise<any>).catch((err: unknown) => { profileError = err; return PROFILE_FAILED; }),
        (client.get(`/esg/${upperSymbol}`) as Promise<any>).then(r => shapeEsg(r), () => shapeEsg(READ_FAILED)),
        (client.get(`/etf-fund/${upperSymbol}`) as Promise<any>).then(r => r, () => ETF_READ_FAILED),
      ]);
      const etf = shapeEtfBlock(fund);
      const fundAnswered = 'etf' in etf; // a fund block, or a failed fund read (etf null + etfStatus)
      const isFund = fundAnswered && etf.etf != null;
      if (res === PROFILE_FAILED) {
        // The profile outage is the answer unless the fund's own data was read.
        if (!isFund) throw profileError;
      }
      // Both branches must guard against the proxy's documented null-on-404
      // return. Without it, full=true would emit literal "null" via
      // JSON.stringify(sanitizeMcpWireOutput(null)); returning null lets the
      // toolHandler emit the standard "No data available" message instead -
      // only for a CONFIRMED absence of both the profile and the fund.
      const profile = res === PROFILE_FAILED || res == null ? null : full ? res : shapeCompanyProfileResponse(res);
      let base: Record<string, unknown> | null;
      if (profile) base = { ...profile, ...esg, ...etf };
      else if (fundAnswered) {
        const profileStatus = res === PROFILE_FAILED ? 'The company profile could not be read right now.' : 'No company profile on record for this symbol.';
        base = { symbol: symbol.toUpperCase(), profileStatus, ...esg, ...etf };
      } else base = null;
      if (!base) return null;
      const out = holdings ? await withHoldingsPage(client, upperSymbol, base, etf, holdings) : base;
      return full ? { _skipSizeGuard: true, data: out } : out;
    }),
  );
}

/** A page of the fund's latest file beside `base`: read only when the etf block holds a file (a withheld or missing
 * file is said there already); the page's own status when it answers otherwise. */
async function withHoldingsPage(client: ProxyClient, upperSymbol: string, base: Record<string, unknown>, etf: Record<string, unknown>, req: { offset?: number; limit?: number }): Promise<Record<string, unknown>> {
  const block = etf.etf as Record<string, unknown> | null | undefined;
  if (block === undefined) return { ...base, holdingsStatus: 'No fund holdings on record for this symbol.' };
  if (!block || !('holdingsInFile' in block)) return base;
  const offset = req.offset ?? 0;
  const limit = Math.min(req.limit ?? 50, 100 - offset);
  const page = await (client.get(`/etf-holdings/${upperSymbol}?offset=${offset}&limit=${limit}`) as Promise<any>).catch(() => ETF_READ_FAILED);
  if (page === ETF_READ_FAILED) return { ...base, holdingsStatus: 'The holdings page could not be read right now.' };
  // The page is the later read: every group it withholds (facts, country weights) goes from the etf block too.
  const held = withPageWithholding(block, page?.notes);
  // The later read found the file withheld or gone: the etf block's file group (read before) goes with it.
  if (page?.holdings?.status === 'withheld') return { ...base, etf: withoutFileGroup(held, 'withheld', page.notes?.fileWithheld ?? null) };
  if (!page || page.holdings?.status !== 'ok') return { ...base, etf: withoutFileGroup(held, 'No holdings file on record.') };
  // Beside a page the page is the list: its rows as the later read serves them (links and split warnings are
  // rechecked per read), never next to the earlier read's top holdings.
  const { topHoldings: _top, ...rest } = held;
  const etfBlock = { ...rest, topHoldingsNote: 'Left out beside `holdings`, which lists the ranks asked for as this later read serves them; ask without `holdings` for the top 10.' };
  return fitHoldingsPage({ ...base, etf: etfBlock }, page, { offset, limit }, typeof block.holdingsReadAt === 'string' ? block.holdingsReadAt : null);
}

/** The etf block with every group a later read withholds taken out, with its status and note. */
function withPageWithholding(block: Record<string, unknown>, notes: any): Record<string, unknown> {
  const out = { ...block };
  if (notes?.factsWithheld) {
    delete out.facts; delete out.sectorWeights;
    out.factsStatus = 'withheld'; out.factsNote = notes.factsWithheld;
  }
  if (notes?.countryWithheld) {
    delete out.countryWeights;
    out.countryStatus = 'withheld'; out.countryNote = notes.countryWithheld;
  }
  return out;
}
