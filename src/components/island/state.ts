/**
 * Island state and the aggregation kernels the three charts share.
 *
 * Filtering is one linear pass over the columnar arrays. At n = 7,325 that is
 * tens of microseconds, which is why there is no memoisation anywhere in here:
 * caching would cost more in complexity and staleness bugs than it saves.
 */

import { signal, computed } from '@preact/signals';
import type {
  ColumnarDataset,
  DataManifest,
  FilterState,
  Severity,
  Stage,
} from '../../lib/types';
import { DEFAULT_FILTER } from '../../lib/types';
import { decode, type DecodedDataset, type DecodedRow } from '../../lib/columnar';
import { countsByService, downtimeByMonth, filterRows } from '../../lib/aggregate';
import { monthKeyFromDayIndex } from '../../lib/dates';

export { track } from '../../lib/track';

// ---------------------------------------------------------------------------
// Track A modules are REAL imports as of this writing: `decode` from
// columnar.ts, and `filterRows` / `countsByService` / `downtimeByMonth` from
// aggregate.ts. That matters more than it looks: Track B server-renders the
// stat cards from `computeAggregates`, and this island recomputes the same
// quantities after every filter change. They can only agree because both sides
// call the same functions — an independently "equivalent" reimplementation
// here would drift the moment either definition moved.
//
// Three kernels below have no counterpart in aggregate.ts and are Track C's
// own: worst-severity-per-day, the year x month downtime grid (which still
// takes its MINUTES from Track A's downtimeByMonth, and only counts incidents
// locally), and the hour x weekday clock. If Track A later grows equivalents,
// these should be deleted rather than kept in parallel.
// ---------------------------------------------------------------------------

export interface DayBuckets {
  /** Worst severity per day index; 0 = unlabelled-only, -1 = no incidents. */
  worst: Int8Array;
  count: Uint16Array;
  /** 1 when at least one incident that day is still open. */
  ongoing: Uint8Array;
}

/** Buckets days [0, days) from the dataset epoch. */
export function dailyWorstSeverity(rows: DecodedRow[], days: number): DayBuckets {
  const worst = new Int8Array(days).fill(-1);
  const count = new Uint16Array(days);
  const ongoing = new Uint8Array(days);
  for (const r of rows) {
    const day = r.d;
    if (day < 0 || day >= days) continue;
    count[day]!++;
    if (r.open === 1) ongoing[day] = 1;
    const cur = worst[day]!;
    // S1 is the worst; 0 ("unlabelled") ranks below every real severity.
    if (cur === -1) worst[day] = r.sev;
    else if (r.sev !== 0 && (cur === 0 || r.sev < cur)) worst[day] = r.sev;
  }
  return { worst, count, ongoing };
}

/**
 * The years x months downtime grid.
 *
 * MINUTES come from Track A's `downtimeByMonth`, so this chart and the
 * server-rendered `aggregates.downtimeByMonth` are the same numbers by
 * construction. That function already restricts to quality 0 — the
 * `Incident::Mitigated` label event — which in practice means S1/S2 only,
 * because those are the only severities that get the label. S3/S4 durations
 * are closed_at proxies that overstate outages by orders of magnitude.
 *
 * The per-cell incident COUNT has no aggregate.ts equivalent, so it is counted
 * here under exactly the same predicate.
 */
export function downtimeGrid(
  rows: DecodedRow[],
  epoch: string,
  years: number[],
): { minutes: Float64Array; incidents: Uint16Array; allIncidents: Uint16Array } {
  const byMonth = downtimeByMonth(rows, epoch);
  const minutes = new Float64Array(years.length * 12);
  // Incidents that CONTRIBUTED measured minutes (quality 0 only).
  const incidents = new Uint16Array(years.length * 12);
  // Every filtered incident in the month, measured or not. The difference
  // between the two is what tells the chart "we could not measure this month"
  // apart from "this month was quiet" - without it, 2018-2019 (115 real S1/S2
  // incidents, 0% duration coverage) would render identically to zero downtime.
  const allIncidents = new Uint16Array(years.length * 12);
  const y0 = years[0] ?? 0;

  const cell = (dayIndex: number): number => {
    const key = monthKeyFromDayIndex(dayIndex, epoch);
    const yi = Number(key.slice(0, 4)) - y0;
    const mi = Number(key.slice(5, 7)) - 1;
    if (yi < 0 || yi >= years.length || mi < 0 || mi > 11) return -1;
    return yi * 12 + mi;
  };

  for (const [key, mins] of Object.entries(byMonth)) {
    const yi = Number(key.slice(0, 4)) - y0;
    const mi = Number(key.slice(5, 7)) - 1;
    if (yi < 0 || yi >= years.length || mi < 0 || mi > 11) continue;
    minutes[yi * 12 + mi] = mins;
  }
  for (const r of rows) {
    const idx = cell(r.d);
    if (idx < 0) continue;
    allIncidents[idx]!++;
    if (r.q !== 0 || r.m < 0) continue;
    incidents[idx]!++;
  }
  return { minutes, incidents, allIncidents };
}

/** 7 rows (UTC weekday, Mon..Sun) x 24 cols (UTC hour). */
export function countByHourDow(rows: DecodedRow[], epochMs: number): Uint16Array {
  const out = new Uint16Array(7 * 24);
  for (const r of rows) {
    out[weekdayMon0(epochMs + r.d * MS_PER_DAY) * 24 + r.h]!++;
  }
  return out;
}

/**
 * Historical count per service id under the current severity/stage filter but
 * IGNORING the service facet itself — otherwise selecting one service would
 * zero every other count and the multiselect would look broken.
 *
 * Track A's `countsByService` keys by service key; the dataset's `services`
 * array carries the id<->key mapping, so the bitmask stays authoritative.
 */
export function serviceCounts(
  ds: DecodedDataset,
  services: { id: number; key: string }[],
  f: FilterState,
): Map<number, number> {
  const rows = filterRows(ds, { ...f, serviceMask: 0 });
  const byKey = new Map(countsByService(rows).map((c) => [c.key, c.count]));
  const out = new Map<number, number>();
  for (const s of services) out.set(s.id, byKey.get(s.key) ?? 0);
  return out;
}

// ---------------------------------------------------------------------------
// Date helpers (UTC only — mirrors src/lib/dates.ts, kept local so the island
// does not pull the whole module in for two functions)
// ---------------------------------------------------------------------------

export const MS_PER_DAY = 86_400_000;

/** 0 = Monday. Calendars that start on Sunday put the weekend in two places. */
export function weekdayMon0(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcMidnightMs(iso: string): number {
  return Math.floor(Date.parse(iso) / MS_PER_DAY) * MS_PER_DAY;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export const severities = signal<Severity[]>([...DEFAULT_FILTER.severities]);
export const stages = signal<Stage[]>([...DEFAULT_FILTER.stages]);
export const serviceMask = signal<number>(DEFAULT_FILTER.serviceMask);

export const filter = computed<FilterState>(() => ({
  severities: severities.value,
  stages: stages.value,
  serviceMask: serviceMask.value,
}));

export const dataset = signal<DecodedDataset | null>(null);
export const datasetError = signal<string | null>(null);
export const manifest = signal<DataManifest | null>(null);

/** Day the calendar is focused on, as an ISO date, or null when nothing is open. */
export const openDay = signal<string | null>(null);

export const isDefaultFilter = computed(() => {
  const f = filter.value;
  return (
    f.serviceMask === 0 &&
    f.stages.length === 1 &&
    f.stages[0] === 'gprd' &&
    f.severities.length === 2 &&
    f.severities.includes(1) &&
    f.severities.includes(2)
  );
});

export function resetFilter(): void {
  severities.value = [...DEFAULT_FILTER.severities];
  stages.value = [...DEFAULT_FILTER.stages];
  serviceMask.value = DEFAULT_FILTER.serviceMask;
}

/**
 * Fetch and decode the dataset. `decode` is Track A's, so the delta-encoded
 * iids and the column-length invariants are checked by the same code the build
 * used to write the file, and everything downstream works on DecodedRow —
 * which is also what aggregate.ts consumes.
 */
export async function loadDataset(url: string, abort?: AbortSignal): Promise<DecodedDataset> {
  const res = await fetch(url, { signal: abort });
  if (!res.ok) throw new Error(`dataset ${res.status}`);
  return decode((await res.json()) as ColumnarDataset);
}
