import type { ColumnarDataset, DurationQuality, ServiceMeta, Severity, Stage } from './types';
import { STAGE_BY_CODE, STAGE_CODES } from './types';

/**
 * Columnar because the browser filters all ~7,300 incidents on every keystroke.
 * One pass over nine parallel number arrays beats 7,300 object property lookups,
 * and the JSON gzips far better than an array of objects (no repeated keys).
 *
 * The encoding is deliberately lossy about things the client never needs: the
 * title, updated_at and closed_at live in the per-year detail files instead.
 *
 * This module is imported by the browser island, so it holds only `decode`, the
 * row types, and the pure `encodeRows` used by the round-trip check. Everything
 * that needs the service table or the incident shape lives in columnar-encode.ts,
 * which only the build imports — otherwise importing `decode` would drag the
 * whole classifier regex table into the client bundle.
 */

export interface DecodedRow {
  iid: number;
  /** Day index from the dataset epoch, UTC. */
  d: number;
  /** UTC hour, 0-23. */
  h: number;
  sev: Severity;
  stg: Stage;
  /** Service bitmask. */
  svc: number;
  /** Minutes, -1 when unknown. */
  m: number;
  q: DurationQuality;
  rc: string | null;
  open: 0 | 1;
}

export interface DecodedDataset {
  epoch: string;
  services: ServiceMeta[];
  rootCauses: string[];
  rows: DecodedRow[];
}

export const DEFAULT_EPOCH = '2018-01-01';

/** Sort key: day, then iid, so the encoding is deterministic across runs. */
export function compareRows(a: DecodedRow, b: DecodedRow): number {
  return a.d - b.d || a.iid - b.iid;
}

/**
 * Encode already-decoded rows. `rootCauses` is always rebuilt from the rows, and
 * `services` must be supplied by the caller — this module deliberately has no
 * reference to the service table.
 */
export function encodeRows(input: {
  epoch: string;
  services?: ServiceMeta[];
  rootCauses?: string[];
  rows: DecodedRow[];
}): ColumnarDataset {
  const rows = [...input.rows].sort(compareRows);
  const rootCauses: string[] = [];
  const rcIndex = new Map<string, number>();
  for (const r of rows) {
    if (r.rc === null || rcIndex.has(r.rc)) continue;
    rcIndex.set(r.rc, rootCauses.length);
    rootCauses.push(r.rc);
  }

  const n = rows.length;
  const cols: ColumnarDataset['cols'] = {
    d: new Array(n),
    h: new Array(n),
    s: new Array(n),
    g: new Array(n),
    v: new Array(n),
    m: new Array(n),
    q: new Array(n),
    r: new Array(n),
    o: new Array(n),
    i: new Array(n),
  };
  let prevIid = 0;
  for (let k = 0; k < n; k++) {
    const row = rows[k]!;
    cols.d[k] = row.d;
    cols.h[k] = row.h;
    cols.s[k] = row.sev;
    cols.g[k] = STAGE_CODES[row.stg];
    cols.v[k] = row.svc;
    cols.m[k] = row.m;
    cols.q[k] = row.q;
    cols.r[k] = row.rc === null ? -1 : rcIndex.get(row.rc)!;
    cols.o[k] = row.open;
    // Delta against the previous row, not the previous iid numerically: rows are
    // day-sorted, so deltas are small and mostly positive but may go negative.
    cols.i[k] = row.iid - prevIid;
    prevIid = row.iid;
  }

  return {
    v: 1,
    epoch: input.epoch,
    n,
    services: input.services ?? [],
    rootCauses,
    cols,
  };
}

export function decode(ds: ColumnarDataset): DecodedDataset {
  if (ds.v !== 1) throw new Error(`columnar: unsupported dataset version ${ds.v}`);
  const { cols, n } = ds;
  for (const [key, col] of Object.entries(cols)) {
    if (col.length !== n) throw new Error(`columnar: column ${key} has ${col.length} entries, expected ${n}`);
  }
  const rows: DecodedRow[] = new Array(n);
  let iid = 0;
  for (let k = 0; k < n; k++) {
    iid += cols.i[k]!;
    const rIdx = cols.r[k]!;
    rows[k] = {
      iid,
      d: cols.d[k]!,
      h: cols.h[k]!,
      sev: cols.s[k]!,
      stg: STAGE_BY_CODE[cols.g[k]!] ?? 'unknown',
      svc: cols.v[k]!,
      m: cols.m[k]!,
      q: cols.q[k]!,
      rc: rIdx < 0 ? null : (ds.rootCauses[rIdx] ?? null),
      open: cols.o[k]!,
    };
  }
  return { epoch: ds.epoch, services: ds.services, rootCauses: ds.rootCauses, rows };
}
