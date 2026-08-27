/**
 * Synthetic ColumnarDataset for developing the island before Track A's real
 * artifacts exist. NOT shipped: Dashboard only reaches for this under
 * `import.meta.env.DEV` when no manifest was handed in, so the production
 * bundle tree-shakes it away.
 *
 * It is deliberately *plausible* rather than random — the shapes it fakes are
 * the ones that break charts:
 *   - the real severity mix (S1 141, S2 823, S3 3343, S4 2861, 157 unlabelled)
 *   - durations ONLY on S1/S2 at quality 0; S3/S4 get quality 1 garbage, so a
 *     bug that lets quality-1 rows into the downtime chart shows up immediately
 *   - a UTC office-hours bias on the hour column, so the clock heatmap has a
 *     real pattern to draw instead of noise
 *   - a handful of still-open incidents in the last few days, so the ongoing
 *     hatch is exercised
 *   - one deliberately empty service bucket, so "visibly empty" is testable
 */

import type { ColumnarDataset, DurationQuality, ServiceMeta, Severity } from '../../lib/types';
import { SERVICES } from '../../lib/services';
import { MS_PER_DAY, utcMidnightMs } from './state';

const EPOCH = '2018-01-01';
const FIRST_INCIDENT = '2018-04-28';
const TOTAL = 7325;

/** Deterministic PRNG so two runs produce byte-identical fixtures. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Severity distribution, expressed as cumulative shares of TOTAL. */
const SEV_MIX: [Severity, number][] = [
  [1, 141],
  [2, 823],
  [3, 3343],
  [4, 2861],
  [0, 157],
];

function pickSeverity(rand: () => number): Severity {
  const roll = rand() * TOTAL;
  let acc = 0;
  for (const [sev, count] of SEV_MIX) {
    acc += count;
    if (roll < acc) return sev;
  }
  return 3;
}

/** Office-hours-ish, in UTC: a broad EU/US-overlap hump with a long tail. */
function pickHour(rand: () => number): number {
  const a = rand();
  const b = rand();
  if (a < 0.72) return Math.floor(9 + b * 11) % 24; // 09:00-20:00 UTC
  return Math.floor(b * 24);
}

function pickStage(rand: () => number): number {
  const r = rand();
  if (r < 0.86) return 0; // gprd
  if (r < 0.95) return 1; // gstg
  if (r < 0.99) return 2; // cny
  return 3; // unknown
}

/** Log-normal-ish minutes: most incidents are short, a few are all-nighters. */
function pickMinutes(rand: () => number, sev: Severity): number {
  const base = sev === 1 ? 95 : 42;
  const spread = Math.exp((rand() + rand() + rand() - 1.5) * 1.15);
  return Math.max(3, Math.round(base * spread));
}

/**
 * A service bitmask. Multi-label like the real classifier, weighted so the
 * big buckets (web, ci, db) dominate. Bucket 6 (GitLab Pages) is intentionally
 * left empty so the filter UI can be checked against a zero-count facet.
 */
const EMPTY_BUCKET = 6;
const WEIGHTS: [number, number][] = [
  [2, 0.22], // web
  [3, 0.18], // ci
  [7, 0.13], // db
  [0, 0.09], // git
  [1, 0.09], // api
  [8, 0.07], // jobs
  [10, 0.05], // storage
  [4, 0.04], // registry
  [14, 0.035], // auth
  [5, 0.025], // packages
  [9, 0.02], // search
  [11, 0.02], // duo
  [13, 0.015], // customers
  [15, 0.015], // comms
  [12, 0.01], // kas
  [16, 0.01], // docs
  [17, 0.04], // other
];

function pickServiceMask(rand: () => number): number {
  let mask = 0;
  for (const [id, w] of WEIGHTS) {
    if (id === EMPTY_BUCKET) continue;
    if (rand() < w) mask |= 1 << id;
  }
  if (mask === 0) mask = 1 << 17;
  return mask;
}

const ROOT_CAUSES = [
  'config-change',
  'code-change',
  'saturation',
  'external-dependency',
  'capacity',
  'hardware',
  'malicious-traffic',
  'unknown',
];

let cached: ColumnarDataset | null = null;

export function fixtureDataset(today = new Date()): ColumnarDataset {
  if (cached) return cached;

  const epochMs = utcMidnightMs(EPOCH);
  const firstDay = Math.round((utcMidnightMs(FIRST_INCIDENT) - epochMs) / MS_PER_DAY);
  const lastDay = Math.round(
    (Math.floor(today.getTime() / MS_PER_DAY) * MS_PER_DAY - epochMs) / MS_PER_DAY,
  );
  const span = Math.max(1, lastDay - firstDay);

  const rand = mulberry32(0x15c0_0ced);
  const days: number[] = [];
  for (let k = 0; k < TOTAL; k++) {
    // Incident rate rises over the years (more services, more monitoring), so
    // bias the sample toward recent days rather than sampling uniformly.
    const u = Math.pow(rand(), 0.78);
    days.push(firstDay + Math.floor(u * span));
  }
  days.sort((a, b) => a - b);

  const cols: ColumnarDataset['cols'] = {
    d: [],
    h: [],
    s: [],
    g: [],
    v: [],
    m: [],
    q: [],
    r: [],
    o: [],
    i: [],
  };

  let prevIid = 0;
  let iid = 1000;
  for (let k = 0; k < TOTAL; k++) {
    const day = days[k]!;
    const sev = pickSeverity(rand);
    // Durations exist only for S1/S2 and only from the Mitigated label event.
    // Everything else is quality 1 (closed_at proxy) or 2 (unknown) and must
    // never reach the downtime chart.
    const hasReal = sev === 1 || sev === 2;
    const q: DurationQuality = hasReal ? 0 : rand() < 0.6 ? 1 : 2;
    const minutes = hasReal
      ? pickMinutes(rand, sev)
      : q === 1
        ? Math.round(60 * (12 + rand() * 900)) // absurd: hundreds of hours
        : -1;
    // Recent incidents may still be open. Widened to 14 days because the real
    // tracker routinely carries a dozen-plus open production incidents.
    const open: 0 | 1 = day > lastDay - 14 && rand() < 0.3 ? 1 : 0;

    iid += 1 + Math.floor(rand() * 4);
    cols.d.push(day);
    cols.h.push(pickHour(rand));
    cols.s.push(sev);
    cols.g.push(pickStage(rand));
    cols.v.push(pickServiceMask(rand));
    cols.m.push(minutes);
    cols.q.push(q);
    cols.r.push(rand() < 0.82 ? Math.floor(rand() * ROOT_CAUSES.length) : -1);
    cols.o.push(open);
    cols.i.push(iid - prevIid);
    prevIid = iid;
  }

  // Guarantee the "ongoing" hatch is reachable under the DEFAULT filter
  // (S1/S2, gprd). Left to chance it is not: S1+S2+gprd in the last fortnight
  // is a thin enough slice that a random draw produced zero, which silently
  // meant the hatch path was never rendered and never reviewed.
  let forced = 0;
  for (let k = TOTAL - 1; k >= 0 && forced < 4; k--) {
    const sev = cols.s[k]!;
    if ((sev === 1 || sev === 2) && cols.g[k] === 0 && cols.d[k]! > lastDay - 14) {
      cols.o[k] = 1;
      forced++;
    }
  }

  const services: ServiceMeta[] = SERVICES.map((s) => ({ id: s.id, key: s.key, label: s.label }));

  cached = {
    v: 1,
    epoch: EPOCH,
    n: TOTAL,
    services,
    rootCauses: ROOT_CAUSES,
    cols,
  };
  return cached;
}
