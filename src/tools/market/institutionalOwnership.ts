import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ProxyClient } from '../../proxy/proxyClient.js';
import { toolHandler } from '../helpers.js';
import { marketDataOutputSchema } from '../outputSchemas.js';
import { ETF_HOLDERS_NONE, INSTITUTIONAL_NOTE, INSTITUTIONAL_READ_FAILED, fitEtfHolders, noInstitutionalRecord, shapeEtfHolders, shapeInstitutionalOwnership } from './institutionalOwnershipShaping.js';

export const INSTITUTIONAL_OWNERSHIP_DESCRIPTION =
  'Get a company\'s (or an ETF\'s) institutional ownership from quarterly Form 13F filings: who owns it among investment managers and how that changed. '
  + 'For the newest quarter on file: `institutions` (managers holding shares), `shares`, `reportedValue`, `pctOfMarketCap` (the reported value over the market cap on file within a week before the quarter end, `marketCapDate`; `marketCapSharedWith` and `marketCapNote` when another security of the company, the same issuer number and name on file, carries about the same market cap, so it is likely the company\'s whole market cap), `changeFromPriorQuarter`, `positionChanges` (new, closed, increased and decreased positions), `calls` and `puts` (managers and the shares underlying, counted apart from shares), `coverage` (`institutionsWithSharesOnAnotherBasis`: in `institutions` and `reportedValue`, those shares not in `shares`; `managersUnplaced`: managers with lines that may be the company\'s but could not be matched, those lines in nothing; every `history` quarter carries its own), and `filedThrough` (the newest filing date read); '
  + '`topHolders` by shares, each with its `priorShares` (null when the manager has no comparable report for the quarter before, or its earlier or current quantity is not known, as `change` says; 0 when its comparable report listed none), `change`, and `someSharesOnAnotherBasis` when `reportedValue` includes shares not in `shares`; and `history`, the newest quarters on file, newest first and the newest included (as many as `quarters` asks, 8 at most). `newerQuarterNote` says when a newer quarter on file holds none of the symbol. '
  + 'The figures are as of each quarter end and filed up to 45 days later, so they are weeks to months old by design. `institutionalNote` gives the rules: restated filings applied, values as reported, shares that more than one manager reports counted twice, changes only among comparable reports. '
  + '`institutionalStatus` says when no quarter on file holds the symbol, or when the 13F read failed (the ETF holders, read apart, still answer). '
  + '`etfHolders` lists the ETFs whose latest holdings file shows the security itself, by reported value, with `etfHoldersMeta` (the basis and what is excluded); shares, value and weight are as reported in each fund\'s file, `holdingsUpdated` the data source\'s update of the file, and `splitWarnings` flags a split close to or after the file\'s date.';

const ETF_FAILED = Symbol('etf holders read failed');
const INST_FAILED = Symbol('13F read failed');

export function register(server: McpServer, client: ProxyClient): void {
  server.registerTool(
    'get_institutional_ownership',
    {
      title: 'Institutional Ownership',
      description: INSTITUTIONAL_OWNERSHIP_DESCRIPTION,
      inputSchema: {
        symbol: z.string().describe('Ticker symbol (e.g., AAPL, SPY).'),
        holders: z.number().int().min(1).max(20).default(10).describe('How many top holders to list (1-20, default 10).'),
        quarters: z.number().int().min(1).max(8).default(8).describe('How many quarters of `history` to give, newest first (1-8, default 8).'),
        etfHolders: z.number().int().min(0).max(50).default(10).describe('How many ETFs holding the security to list, by reported value (0-50, default 10; 0 skips them).'),
      },
      outputSchema: marketDataOutputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    toolHandler(async ({ symbol, holders, quarters, etfHolders }) => {
      const upper = symbol.toUpperCase();
      const enc = encodeURIComponent(upper);
      // The ETF holders read stands apart: its outage leaves the 13F answer standing, and the reverse.
      let instError: unknown = null;
      const [res, etf] = await Promise.all([
        (client.get(`/institutional-ownership/${enc}`) as Promise<any>).catch((err: unknown) => { instError = err; return INST_FAILED; }),
        etfHolders > 0 ? (client.get(`/etf-holders/${enc}?limit=${etfHolders}`) as Promise<any>).then(r => r, () => ETF_FAILED) : Promise.resolve(undefined),
      ]);
      const etfPart = etf === ETF_FAILED ? { etfHoldersStatus: 'ETF holdings could not be read right now.' }
        : etf === undefined ? {}
        : etf == null ? { etfHolders: [], etfHoldersNote: ETF_HOLDERS_NONE }
        : shapeEtfHolders(etf, etfHolders);
      // A 13F outage keeps a holders answer that was read, saying which read failed; with nothing else read, the
      // outage is the answer.
      if (res === INST_FAILED) {
        if (etf === undefined || etf === ETF_FAILED) throw instError;
        return fitEtfHolders({ symbol: upper, institutionalStatus: INSTITUTIONAL_READ_FAILED }, etfPart);
      }
      // Nothing on file (a 404) is an answer: the status says so.
      if (res == null) return fitEtfHolders(noInstitutionalRecord(upper), etfPart);
      return fitEtfHolders(shapeInstitutionalOwnership(res, { holders, quarters }), etfPart);
    }),
  );
}

export { INSTITUTIONAL_NOTE };
