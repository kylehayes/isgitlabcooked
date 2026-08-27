/**
 * UTC-only day arithmetic. No date library, no local timezone, ever.
 * A "day index" is the number of whole UTC days since `epoch`.
 */

const MS_PER_DAY = 86_400_000;

/** Milliseconds at UTC midnight of the day containing `iso`. */
export function utcMidnight(iso: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`dates: unparseable ISO timestamp ${JSON.stringify(iso)}`);
  return Math.floor(t / MS_PER_DAY) * MS_PER_DAY;
}

/** Whole UTC days from `epoch` (a YYYY-MM-DD or full ISO string) to `iso`. */
export function dayIndex(iso: string, epoch: string): number {
  return Math.round((utcMidnight(iso) - utcMidnight(epoch)) / MS_PER_DAY);
}

/** Inverse of dayIndex. Returns YYYY-MM-DD. */
export function isoFromDayIndex(index: number, epoch: string): string {
  return toIsoDate(utcMidnight(epoch) + index * MS_PER_DAY);
}

/** YYYY-MM-DD for a ms timestamp or ISO string. */
export function toIsoDate(value: number | string): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return new Date(ms).toISOString().slice(0, 10);
}

/** UTC hour 0-23. */
export function utcHour(iso: string): number {
  return new Date(Date.parse(iso)).getUTCHours();
}

/** "YYYY-MM" for an ISO timestamp or date. */
export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}

/** "YYYY-MM" for a day index. */
export function monthKeyFromDayIndex(index: number, epoch: string): string {
  return isoFromDayIndex(index, epoch).slice(0, 7);
}

/** Year as a number from an ISO timestamp or date. */
export function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/** Whole UTC days between two instants (b - a), truncated to day boundaries. */
export function daysBetween(a: string, b: string): number {
  return Math.round((utcMidnight(b) - utcMidnight(a)) / MS_PER_DAY);
}

/** The month key `n` months after `key` ("YYYY-MM" arithmetic, no Date involved). */
export function addMonths(key: string, n: number): string {
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(5, 7)) - 1 + n;
  const ny = y + Math.floor(m / 12);
  const nm = ((m % 12) + 12) % 12;
  return `${ny}-${String(nm + 1).padStart(2, '0')}`;
}

/** Minutes between two ISO instants (b - a). */
export function minutesBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 60_000;
}

export { MS_PER_DAY };
