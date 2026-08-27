import { describe, expect, it } from 'vitest';
import type { Durations, Incident } from '../src/lib/types';
import { STAGE_CODES } from '../src/lib/types';
import { decode, encodeRows, DEFAULT_EPOCH } from '../src/lib/columnar';
import { encode, toRows } from '../src/lib/columnar-encode';
import { SERVICE_META } from '../src/lib/serviceMeta';

function incident(over: Partial<Incident> & Pick<Incident, 'iid' | 'c'>): Incident {
  return {
    t: `incident ${over.iid}`,
    x: null,
    u: over.c,
    st: 'closed',
    sev: 2,
    ist: 'Resolved',
    stg: 'gprd',
    svc: 1 << 0,
    rc: null,
    ...over,
  };
}

const SAMPLE: Incident[] = [
  incident({ iid: 100, c: '2018-04-28T05:06:07.000Z', sev: 1, stg: 'gprd', svc: 0b101, rc: 'Saturation' }),
  incident({ iid: 240, c: '2019-12-31T23:59:59.000Z', sev: 4, stg: 'cny', svc: 1 << 19, rc: 'DB-Migration' }),
  incident({ iid: 99, c: '2020-06-01T00:00:00.000Z', sev: 0, stg: 'unknown', svc: 1 << 17, rc: null }),
  incident({ iid: 7000, c: '2026-08-27T12:00:00.000Z', sev: 2, stg: 'gstg', st: 'opened', ist: 'Active', rc: 'Saturation' }),
  incident({ iid: 6999, c: '2026-08-27T12:30:00.000Z', sev: 3, st: 'opened', ist: null, rc: 'Indeterminate' }),
];

const DURATIONS: Durations = {
  '100': { m: 42, q: 0 },
  '240': { m: 4320, q: 1 },
  '7000': { m: -1, q: 2 },
};

describe('columnar encode/decode', () => {
  const ds = encode(SAMPLE, DURATIONS);

  it('keeps every row', () => {
    expect(ds.n).toBe(SAMPLE.length);
    for (const col of Object.values(ds.cols)) expect(col).toHaveLength(SAMPLE.length);
  });

  it('sorts ascending by day index', () => {
    expect(ds.cols.d).toEqual([...ds.cols.d].sort((a, b) => a - b));
  });

  it('delta-encodes iids against the previous row, not sorted iid order', () => {
    // Rows are day-sorted, so the delta sequence is allowed to go negative.
    expect(ds.cols.i[0]).toBe(100);
    expect(ds.cols.i.some((d) => d < 0)).toBe(true);
    const rebuilt: number[] = [];
    let acc = 0;
    for (const d of ds.cols.i) rebuilt.push((acc += d));
    expect(rebuilt).toEqual(decode(ds).rows.map((r) => r.iid));
  });

  it('round-trips losslessly: encode -> decode -> encode', () => {
    expect(encodeRows(decode(ds))).toEqual(ds);
  });

  it('round-trips every field of every row', () => {
    const rows = decode(ds);
    const expected = toRows(SAMPLE, DURATIONS);
    expect(rows.rows).toEqual(expected);
  });

  it('preserves stage through the numeric code', () => {
    const rows = decode(ds).rows;
    for (const row of rows) {
      const original = SAMPLE.find((i) => i.iid === row.iid)!;
      expect(row.stg).toBe(original.stg);
      expect(ds.cols.g[rows.indexOf(row)]).toBe(STAGE_CODES[original.stg]);
    }
  });

  it('interns root causes and uses -1 for none', () => {
    expect(new Set(ds.rootCauses).size).toBe(ds.rootCauses.length);
    expect(ds.rootCauses).toContain('Saturation');
    const rows = decode(ds).rows;
    const noRc = rows.find((r) => r.iid === 99)!;
    expect(noRc.rc).toBeNull();
    expect(ds.cols.r[rows.indexOf(noRc)]).toBe(-1);
  });

  it('stores -1 for a missing or unknown duration', () => {
    const rows = decode(ds).rows;
    expect(rows.find((r) => r.iid === 100)!.m).toBe(42);
    expect(rows.find((r) => r.iid === 100)!.q).toBe(0);
    expect(rows.find((r) => r.iid === 7000)!.m).toBe(-1);
    // 6999 has no durations entry at all.
    expect(rows.find((r) => r.iid === 6999)!).toMatchObject({ m: -1, q: 2 });
  });

  it('marks only Incident::Active as open', () => {
    const open = decode(ds).rows.filter((r) => r.open === 1).map((r) => r.iid);
    // 7000 is opened + Incident::Active. 6999 is opened but carries NO
    // Incident:: label, which means abandoned paperwork rather than an ongoing
    // outage — the real dataset's three such rows are 464-481 days old.
    expect(open.sort()).toEqual([7000]);
  });

  it('does not treat a resolved-but-open ticket as open', () => {
    // The common case by far: tickets linger open for days after mitigation.
    const resolved = encode(
      [incident({ iid: 8001, c: '2026-08-27T12:00:00.000Z', sev: 1, st: 'opened', ist: 'Resolved' })],
      {},
    );
    expect(decode(resolved).rows.every((r) => r.open === 0)).toBe(true);
  });

  it('stores the UTC hour, never the local one', () => {
    const rows = decode(ds).rows;
    expect(rows.find((r) => r.iid === 100)!.h).toBe(5);
    expect(rows.find((r) => r.iid === 240)!.h).toBe(23);
  });

  it('carries the full service table so the client can label bits', () => {
    expect(ds.services).toHaveLength(SERVICE_META.length);
    expect(ds.services.map((s) => s.key)).toEqual(SERVICE_META.map((s) => s.key));
  });

  it('uses the declared epoch for day indices', () => {
    expect(ds.epoch).toBe(DEFAULT_EPOCH);
    const first = decode(ds).rows[0]!;
    expect(first.d).toBe(117); // 2018-04-28 is 117 days after 2018-01-01
  });

  it('is deterministic: encoding twice produces identical bytes', () => {
    expect(JSON.stringify(encode(SAMPLE, DURATIONS))).toBe(JSON.stringify(encode([...SAMPLE].reverse(), DURATIONS)));
  });

  it('handles an empty dataset', () => {
    const empty = encode([], {});
    expect(empty.n).toBe(0);
    expect(decode(empty).rows).toEqual([]);
    expect(encodeRows(decode(empty))).toEqual(empty);
  });

  it('rejects a version it does not understand', () => {
    expect(() => decode({ ...ds, v: 2 as 1 })).toThrow(/version/);
  });

  it('rejects a truncated column', () => {
    const broken = { ...ds, cols: { ...ds.cols, h: ds.cols.h.slice(1) } };
    expect(() => decode(broken)).toThrow(/column h/);
  });
});
