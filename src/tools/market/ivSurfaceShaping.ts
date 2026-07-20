type IvSurfaceRow = {
  strike: number;
  expiration: string;
  yte?: number;
  iv?: number;
  callIV?: number;
  putIV?: number;
  smv?: number;
};

type IvSurfacePayload = {
  ticker?: string;
  date?: string;
  spotPrice?: number;
  expirations?: string[];
  rowCount?: number;
  data?: unknown;
};

const MAX_EXPIRATIONS = 6;

function round(value: unknown, decimals = 4): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Number(value.toFixed(decimals));
}

function pickNearestRow(rows: IvSurfaceRow[], targetStrike: number, used = new Set<number>()): IvSurfaceRow | undefined {
  return [...rows]
    .filter((row) => !used.has(row.strike))
    .sort((left, right) => {
      const leftDistance = Math.abs(left.strike - targetStrike);
      const rightDistance = Math.abs(right.strike - targetStrike);
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return left.strike - right.strike;
    })[0];
}

function buildExpirationSummary(expiration: string, rows: IvSurfaceRow[], spotPrice: number) {
  const used = new Set<number>();
  const atmNode = pickNearestRow(rows, spotPrice);
  if (atmNode) used.add(atmNode.strike);
  const putRows = atmNode ? rows.filter((row) => row.strike <= atmNode.strike) : rows;
  const callRows = atmNode ? rows.filter((row) => row.strike >= atmNode.strike) : rows;
  const putNode = pickNearestRow(putRows, spotPrice * 0.95, used);
  if (putNode) used.add(putNode.strike);
  const callNode = pickNearestRow(callRows, spotPrice * 1.05, used);

  const preview = [
    putNode && {
      expiration,
      bucket: 'put wing',
      strike: putNode.strike,
      relativeStrike: round(putNode.strike / spotPrice, 3),
      yte: round(putNode.yte, 5),
      iv: round(putNode.iv),
      putIV: round(putNode.putIV),
      callIV: round(putNode.callIV),
    },
    atmNode && {
      expiration,
      bucket: 'atm',
      strike: atmNode.strike,
      relativeStrike: round(atmNode.strike / spotPrice, 3),
      yte: round(atmNode.yte, 5),
      iv: round(atmNode.iv),
      putIV: round(atmNode.putIV),
      callIV: round(atmNode.callIV),
    },
    callNode && {
      expiration,
      bucket: 'call wing',
      strike: callNode.strike,
      relativeStrike: round(callNode.strike / spotPrice, 3),
      yte: round(callNode.yte, 5),
      iv: round(callNode.iv),
      putIV: round(callNode.putIV),
      callIV: round(callNode.callIV),
    },
  ].filter((x): x is NonNullable<typeof x> => Boolean(x));

  const skewSummary = atmNode && putNode && callNode
    ? {
        expiration,
        yte: round(atmNode.yte, 5),
        atmStrike: atmNode.strike,
        atmIV: round(atmNode.iv),
        putStrike: putNode.strike,
        putIV: round(putNode.putIV ?? putNode.iv),
        callStrike: callNode.strike,
        callIV: round(callNode.callIV ?? callNode.iv),
        putCallSkew: round((putNode.putIV ?? putNode.iv ?? 0) - (callNode.callIV ?? callNode.iv ?? 0)),
      }
    : undefined;

  const atmTerm = atmNode
    ? {
        expiration,
        yte: round(atmNode.yte, 5),
        atmStrike: atmNode.strike,
        atmIV: round(atmNode.iv),
        callIV: round(atmNode.callIV),
        putIV: round(atmNode.putIV),
      }
    : undefined;

  return { preview, skewSummary, atmTerm };
}

export function summarizeIvSurface(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const data = payload as IvSurfacePayload;
  if (!Array.isArray(data.data) || typeof data.spotPrice !== 'number' || !Number.isFinite(data.spotPrice)) {
    return payload;
  }

  const rows = data.data.filter((row): row is IvSurfaceRow => {
    return row != null
      && typeof row === 'object'
      && typeof (row as IvSurfaceRow).strike === 'number'
      && typeof (row as IvSurfaceRow).expiration === 'string';
  });
  if (rows.length === 0) return payload;

  const grouped = new Map<string, IvSurfaceRow[]>();
  for (const row of rows) {
    const group = grouped.get(row.expiration);
    if (group) group.push(row);
    else grouped.set(row.expiration, [row]);
  }

  const expirations = (Array.isArray(data.expirations) && data.expirations.length > 0
    ? data.expirations
    : [...grouped.keys()].sort()).slice(0, MAX_EXPIRATIONS);

  const atmTermStructure: Array<Record<string, unknown>> = [];
  const skewSummary: Array<Record<string, unknown>> = [];
  const surfacePreview: Array<Record<string, unknown>> = [];

  for (const expiration of expirations) {
    const rowsForExpiration = grouped.get(expiration);
    if (!rowsForExpiration || rowsForExpiration.length === 0) continue;
    const summary = buildExpirationSummary(expiration, rowsForExpiration, data.spotPrice);
    if (summary.atmTerm) atmTermStructure.push(summary.atmTerm);
    if (summary.skewSummary) skewSummary.push(summary.skewSummary);
    surfacePreview.push(...summary.preview);
  }

  return {
    ticker: data.ticker,
    date: data.date,
    spotPrice: round(data.spotPrice, 2),
    expirationCount: grouped.size,
    expirations,
    rowCount: data.rowCount ?? rows.length,
    atmTermStructure,
    skewSummary,
    surfacePreview,
    _surface_meta: {
      preview: true,
      smiles_per_expiration: 3,
      preview_nodes: surfacePreview.length,
      expirations: expirations.length,
    },
  };
}
