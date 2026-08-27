import type { Aggregates, FilterState, ServiceMeta, Streak } from './types';
import { DEFAULT_FILTER } from './types';
import type { DecodedDataset, DecodedRow } from './columnar';
import { addMonths, dayIndex, isoFromDayIndex, monthKeyFromDayIndex, toIsoDate } from './dates';
import { SERVICE_META } from './serviceMeta';

/**
 * Pure aggregation, shared by the build script and the browser island. No I/O, no
 * Date.now() unless it is passed in, so the numbers baked into the HTML at build
 * time and the numbers the island recomputes after a filter change agree exactly.
 */

export function matches(row: DecodedRow, filter: FilterState): boolean {
  if (filter.severities.length && !filter.severities.includes(row.sev)) return false;
  if (filter.stages.length && !filter.stages.includes(row.stg)) return false;
  if (filter.serviceMask !== 0 && (row.svc & filter.serviceMask) === 0) return false;
  return true;
}

export function filterRows(ds: DecodedDataset, filter: FilterState = DEFAULT_FILTER): DecodedRow[] {
  return ds.rows.filter((r) => matches(r, filter));
}

/** day index -> incident count, only for days that had at least one. */
export function countsByDay(rows: DecodedRow[]): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of rows) out.set(r.d, (out.get(r.d) ?? 0) + 1);
  return out;
}

/** "YYYY-MM" -> count, with every month between the first and last filled in as 0. */
export function countsByMonth(rows: DecodedRow[], epoch: string, throughDay?: number): Record<string, number> {
  if (!rows.length) return {};
  const counts = new Map<string, number>();
  let minDay = Infinity;
  let maxDay = -Infinity;
  for (const r of rows) {
    const key = monthKeyFromDayIndex(r.d, epoch);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (r.d < minDay) minDay = r.d;
    if (r.d > maxDay) maxDay = r.d;
  }
  if (throughDay !== undefined && throughDay > maxDay) maxDay = throughDay;
  const out: Record<string, number> = {};
  let cursor = monthKeyFromDayIndex(minDay, epoch);
  const last = monthKeyFromDayIndex(maxDay, epoch);
  for (let guard = 0; guard < 2400; guard++) {
    out[cursor] = counts.get(cursor) ?? 0;
    if (cursor === last) break;
    cursor = addMonths(cursor, 1);
  }
  return out;
}

/**
 * Longest run of consecutive incident-free days.
 *
 * The off-by-one everyone gets wrong: a gap between an incident on day 10 and the
 * next on day 14 is *three* clean days (11, 12, 13), not four. `start`/`end` are
 * the first and last clean day inclusive, so end - start + 1 === days.
 */
export function longestStreak(rows: DecodedRow[], epoch: string, todayDay: number): Streak {
  const days = [...new Set(rows.map((r) => r.d))].sort((a, b) => a - b);
  if (!days.length) return emptyStreak(epoch, todayDay);

  let best = { days: 0, startDay: days[0]! + 1, endDay: days[0]! };
  for (let k = 1; k < days.length; k++) {
    const gap = days[k]! - days[k - 1]! - 1;
    if (gap > best.days) best = { days: gap, startDay: days[k - 1]! + 1, endDay: days[k]! - 1 };
  }
  // The still-running streak counts too, measured up to and including today.
  const trailing = todayDay - days[days.length - 1]!;
  if (trailing > best.days) {
    best = { days: trailing, startDay: days[days.length - 1]! + 1, endDay: todayDay };
  }
  if (best.days <= 0) return emptyStreak(epoch, todayDay);
  return {
    days: best.days,
    start: isoFromDayIndex(best.startDay, epoch),
    end: isoFromDayIndex(best.endDay, epoch),
  };
}

/** Clean days since the most recent incident, up to and including today. */
export function currentStreak(rows: DecodedRow[], epoch: string, todayDay: number): Streak {
  if (!rows.length) return emptyStreak(epoch, todayDay);
  const lastDay = Math.max(...rows.map((r) => r.d));
  const days = Math.max(0, todayDay - lastDay);
  if (days === 0) {
    const today = isoFromDayIndex(todayDay, epoch);
    return { days: 0, start: today, end: today };
  }
  return {
    days,
    start: isoFromDayIndex(lastDay + 1, epoch),
    end: isoFromDayIndex(todayDay, epoch),
  };
}

function emptyStreak(epoch: string, todayDay: number): Streak {
  const today = isoFromDayIndex(todayDay, epoch);
  return { days: 0, start: today, end: today };
}

/** Whole days from the most recent matching incident to today. -1 when there are none. */
export function daysSince(rows: DecodedRow[], todayDay: number): number {
  if (!rows.length) return -1;
  return Math.max(0, todayDay - Math.max(...rows.map((r) => r.d)));
}

/**
 * Mean incidents per month over the last three *complete-ish* months, including
 * the current partial one. Averaging over a partial month understates the rate,
 * so the current month is weighted by how much of it has elapsed.
 */
export function avgPerMonthLast3(rows: DecodedRow[], epoch: string, todayDay: number): number {
  if (!rows.length) return 0;
  const current = monthKeyFromDayIndex(todayDay, epoch);
  const keys = [addMonths(current, -2), addMonths(current, -1), current];
  const counts = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const r of rows) {
    const key = monthKeyFromDayIndex(r.d, epoch);
    if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
  }
  const dayOfMonth = Number(isoFromDayIndex(todayDay, epoch).slice(8, 10));
  const daysInCurrent = daysInMonth(current);
  const elapsedMonths = 2 + dayOfMonth / daysInCurrent;
  const total = keys.reduce((sum, k) => sum + counts.get(k)!, 0);
  return Math.round((total / elapsedMonths) * 10) / 10;
}

function daysInMonth(key: string): number {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7));
  return new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - 86_400_000).getUTCDate();
}

export function worstMonth(byMonth: Record<string, number>): { month: string; count: number } {
  let best = { month: '', count: -1 };
  for (const [month, count] of Object.entries(byMonth)) {
    // Ties go to the earlier month, which is the one people remember.
    if (count > best.count) best = { month, count };
  }
  return best.count < 0 ? { month: '', count: 0 } : best;
}

/**
 * `services` defaults to the static table, but callers holding a decoded dataset
 * should pass `ds.services` — the shipped JSON carries it, and that keeps this
 * function honest if the taxonomy ever grows between a deploy and a cached payload.
 */
export function countsByService(
  rows: DecodedRow[],
  services: ServiceMeta[] = SERVICE_META,
): { key: string; count: number }[] {
  const counts = new Map<string, number>(services.map((s) => [s.key, 0]));
  for (const r of rows) {
    for (const svc of services) {
      if ((r.svc & (1 << svc.id)) !== 0) counts.set(svc.key, counts.get(svc.key)! + 1);
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function countsByRootCause(rows: DecodedRow[]): { key: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.rc ?? 'Unrecorded';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}

export function countsBySeverity(rows: DecodedRow[]): Record<string, number> {
  const out: Record<string, number> = { '0': 0, '1': 0, '2': 0, '3': 0, '4': 0 };
  for (const r of rows) out[String(r.sev)] = (out[String(r.sev)] ?? 0) + 1;
  return out;
}

/**
 * "YYYY-MM" -> total mitigation minutes. Quality 0 only: the closed_at proxy
 * overstates outages by two orders of magnitude and would make this meaningless.
 */
export function downtimeByMonth(rows: DecodedRow[], epoch: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    if (r.q !== 0 || r.m < 0) continue;
    const key = monthKeyFromDayIndex(r.d, epoch);
    out[key] = (out[key] ?? 0) + r.m;
  }
  return out;
}

export interface AggregateOptions {
  filter?: FilterState;
  /** "Today" in UTC. Defaults to the real clock; tests pass a fixed date. */
  now?: Date;
  generatedAt?: string;
}

export function computeAggregates(ds: DecodedDataset, options: AggregateOptions = {}): Aggregates {
  const filter = options.filter ?? DEFAULT_FILTER;
  const now = options.now ?? new Date();
  const todayDay = dayIndexOf(toIsoDate(now.getTime()), ds.epoch);
  const rows = filterRows(ds, filter);
  const byMonth = countsByMonth(rows, ds.epoch, todayDay);
  const allDays = ds.rows.map((r) => r.d);
  const firstDay = allDays.length ? Math.min(...allDays) : todayDay;
  const lastMatchingDay = rows.length ? Math.max(...rows.map((r) => r.d)) : firstDay;

  return {
    generatedAt: options.generatedAt ?? now.toISOString(),
    firstIncident: isoFromDayIndex(firstDay, ds.epoch),
    totalDefault: rows.length,
    totalAll: ds.rows.length,
    lastIncidentDate: isoFromDayIndex(lastMatchingDay, ds.epoch),
    daysSince: Math.max(0, daysSince(rows, todayDay)),
    avgPerMonthLast3: avgPerMonthLast3(rows, ds.epoch, todayDay),
    longestStreak: longestStreak(rows, ds.epoch, todayDay),
    currentStreak: currentStreak(rows, ds.epoch, todayDay),
    worstMonth: worstMonth(byMonth),
    byMonth,
    bySeverityAll: countsBySeverity(ds.rows),
    byRootCause: countsByRootCause(rows),
    byService: countsByService(rows, ds.services.length ? ds.services : undefined),
    downtimeByMonth: downtimeByMonth(rows, ds.epoch),
  };
}

/** Convenience wrapper so callers need not import dates.ts just for this. */
function dayIndexOf(isoDate: string, epoch: string): number {
  return dayIndex(isoDate, epoch);
}

export { dayIndexOf };
