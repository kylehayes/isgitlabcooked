/**
 * The verdict. Pure, synchronous, no I/O — it is called from the build (to bake
 * snapshot.json into the HTML) and again in the browser every 60s, and the two
 * must agree given the same inputs.
 *
 * Two independent sources of truth are combined on purpose:
 *   1. Status.io — what GitLab *says* is happening.
 *   2. The incident tracker — what GitLab's own engineers have *filed*.
 * They disagree more often than you would hope. Surfacing that gap is the point
 * of this site, so `disagreement` is a first-class output rather than a note.
 */

import type { LiveStatus, Severity, StatusCode, Verdict, VerdictKey } from './types';

/** An open production incident, as read from the tracker. */
export interface OpenIncident {
  iid: number;
  t: string;
  sev: Severity;
  /** created_at, ISO 8601 UTC. */
  c: string;
}

export interface VerdictInput {
  /** Null when Status.io could not be reached at all. */
  live: LiveStatus | null;
  /** Open `gprd` incidents. Order does not matter. */
  open: OpenIncident[];
  /** Injected so the build and the browser can both be deterministic in tests. */
  now?: number;
}

const WORDS: Record<VerdictKey, string> = {
  raw: 'Raw',
  'room-temperature': 'Room Temperature',
  'warming-up': 'Warming Up',
  simmering: 'Simmering',
  cooked: 'Cooked',
  'extra-crispy': 'Extra Crispy',
};

const HEAT: Record<VerdictKey, Verdict['heat']> = {
  raw: 0,
  'room-temperature': 1,
  'warming-up': 2,
  simmering: 3,
  cooked: 4,
  'extra-crispy': 5,
};

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

/** S1 is the worst severity; 0 means "no severity label", which ranks last. */
function worstSeverity(open: OpenIncident[]): Severity {
  let worst: Severity = 0;
  for (const i of open) {
    if (i.sev === 0) continue;
    if (worst === 0 || i.sev < worst) worst = i.sev;
  }
  return worst;
}

/** Oldest open S1, in ms since epoch, or null. */
function oldestS1Age(open: OpenIncident[], now: number): number | null {
  let oldest: number | null = null;
  for (const i of open) {
    if (i.sev !== 1) continue;
    const t = Date.parse(i.c);
    if (Number.isNaN(t)) continue;
    if (oldest === null || t < oldest) oldest = t;
  }
  return oldest === null ? null : now - oldest;
}

export function computeVerdict(input: VerdictInput): Verdict {
  const now = input.now ?? Date.now();
  const live = input.live;
  const open = input.open;

  const codes: StatusCode[] = live ? live.components.map((c) => c.status_code) : [];
  // `status_overall` is unreliable — it lags the components badly and stays at
  // 500 while the newest incident message already says "resolved, monitoring".
  // Component codes are the ground truth; overall is only a floor.
  const worstCode = codes.reduce<StatusCode>(
    (a, b) => (b > a ? b : a),
    live ? live.overall.status_code : 100,
  );
  const seriousComponents = codes.filter((c) => c >= 400).length;
  const degradedCount = codes.filter((c) => c !== 100).length;

  const worstSev = worstSeverity(open);
  const hasOpenS1 = worstSev === 1;
  const hasOpenS2 = worstSev === 2;
  const s1Age = oldestS1Age(open, now);
  const longS1 = s1Age !== null && s1Age > TWO_HOURS_MS;

  let key: VerdictKey;
  if (seriousComponents >= 3 || longS1) key = 'extra-crispy';
  else if (worstCode >= 500 || hasOpenS1) key = 'cooked';
  else if (worstCode >= 400) key = 'simmering';
  else if (worstCode >= 300) key = 'warming-up';
  else if (hasOpenS2) key = 'room-temperature';
  else key = 'raw';

  // The status page claims everything is fine, but somebody has an S1 or S2
  // open against production right now. That is the interesting case.
  const statusPageAllClear = live !== null && worstCode === 100;
  const disagreement = statusPageAllClear && (hasOpenS1 || hasOpenS2);

  return {
    key,
    word: WORDS[key],
    heat: HEAT[key],
    disagreement,
    subline: subline({
      live,
      key,
      degradedCount,
      seriousComponents,
      open,
      worstSev,
      disagreement,
      longS1,
      s1Age,
    }),
  };
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function hoursAgo(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `${Math.floor(h / 24)}d`;
  if (h >= 1) return `${h}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function subline(a: {
  live: LiveStatus | null;
  key: VerdictKey;
  degradedCount: number;
  seriousComponents: number;
  open: OpenIncident[];
  worstSev: Severity;
  disagreement: boolean;
  longS1: boolean;
  s1Age: number | null;
}): string {
  if (a.live === null) {
    return a.open.length
      ? `Status page unreachable. ${plural(a.open.length, 'open production incident')} in the tracker.`
      : 'Status page unreachable.';
  }
  if (a.disagreement) {
    return 'Status page says fine. The incident tracker disagrees.';
  }
  const parts: string[] = [];
  if (a.degradedCount > 0) {
    parts.push(`${plural(a.degradedCount, 'component')} not operational`);
  } else {
    parts.push('All 23 components operational');
  }
  if (a.longS1 && a.s1Age !== null) {
    parts.push(`an S1 has been open ${hoursAgo(a.s1Age)}`);
  } else if (a.open.length > 0) {
    parts.push(`${plural(a.open.length, 'open production incident')}`);
  } else {
    parts.push('nothing open in the tracker');
  }
  return `${parts.join(', ')}.`;
}

/** The offline case: no live data, no tracker data, only a build-time capture. */
export function staleSubline(capturedAt: string): string {
  const d = new Date(Date.parse(capturedAt));
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `status page unreachable — snapshot from ${d.toISOString().slice(0, 10)} ${hh}:${mm} UTC`;
}
