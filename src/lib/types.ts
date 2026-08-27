/**
 * The contract shared by the sync scripts, the Astro build, and the browser island.
 * Changing anything here means changing all three. Land it once, then leave it alone.
 */

/** Stage the incident occurred in. Only `gprd` is user-facing production. */
export type Stage = 'gprd' | 'gstg' | 'cny' | 'unknown';

/** `severity::N` label, or 0 when the issue carries no severity label. */
export type Severity = 0 | 1 | 2 | 3 | 4;

/** `Incident::*` workflow label. */
export type IncidentState = 'Active' | 'Mitigated' | 'Resolved' | 'Merged' | null;

/** How much we trust a duration. See DurationEntry. */
export const DurationQuality = {
  /** Derived from the Incident::Mitigated label event. Authoritative. */
  LabelEvent: 0,
  /** closed_at - created_at. Wildly overstates; ticket hygiene, not outage length. */
  ClosedAtProxy: 1,
  /** Unknown or still open. */
  Unknown: 2,
} as const;
export type DurationQuality = (typeof DurationQuality)[keyof typeof DurationQuality];

/** One line of data/incidents.ndjson. Keys are short because there are 7,000+ of them. */
export interface Incident {
  /** Issue iid in gitlab-com/gl-infra/production. web_url is derived, never stored. */
  iid: number;
  /** Title with the redundant `YYYY-MM-DD: ` prefix stripped. */
  t: string;
  /** created_at, ISO 8601 UTC. */
  c: string;
  /** closed_at, ISO 8601 UTC, or null while open. */
  x: string | null;
  /** updated_at, ISO 8601 UTC. Drives the incremental sync cursor. */
  u: string;
  st: 'opened' | 'closed';
  sev: Severity;
  ist: IncidentState;
  stg: Stage;
  /** Bitmask over SERVICES ids. Multi-label: one incident can touch several services. */
  svc: number;
  /** RootCause:: label with the prefix stripped, or null. */
  rc: string | null;
}

export interface DurationEntry {
  /** Minutes from created_at to mitigation. */
  m: number;
  q: DurationQuality;
}

/** data/durations.json — keyed by iid as a string. */
export type Durations = Record<string, DurationEntry>;

/** data/meta.json — sync bookkeeping and the counts validate.ts asserts against. */
export interface SyncMeta {
  schema: 1;
  lastSyncedAt: string | null;
  lastFullSyncAt: string | null;
  /** Highest iid whose durations we've attempted, so backfill can resume. */
  durationsBackfilledThrough: number;
  counts: {
    total: number;
    bySeverity: Record<string, number>;
    byYear: Record<string, number>;
  };
  /** Up to 25 titles that fell through to the `other` bucket, for classifier tuning. */
  unclassifiedSample: string[];
}

/** data/status-components.json — the 23 Status.io components, snapshotted each sync. */
export interface StatusComponent {
  id: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Status.io live API
// ---------------------------------------------------------------------------

/** 100 Operational · 300 Degraded · 400 Partial Outage · 500 Service Disruption. */
export type StatusCode = 100 | 300 | 400 | 500;

export interface LiveComponent {
  id: string;
  name: string;
  status: string;
  status_code: StatusCode;
  updated: string;
}

export interface LiveStatus {
  updated: string;
  overall: { status: string; status_code: StatusCode };
  components: LiveComponent[];
  /** Count of components not at 100. */
  degradedCount: number;
}

// ---------------------------------------------------------------------------
// Build artifacts
// ---------------------------------------------------------------------------

export interface ServiceMeta {
  id: number;
  key: string;
  label: string;
}

/**
 * public/data/incidents.<hash>.json — columnar so the browser can filter 7,000+
 * incidents in a single pass over parallel typed arrays.
 * All arrays have length `n` and are sorted ascending by `d`.
 */
export interface ColumnarDataset {
  v: 1;
  /** ISO date of day index 0. */
  epoch: string;
  n: number;
  services: ServiceMeta[];
  /** Index into this array is the value stored in cols.r. */
  rootCauses: string[];
  cols: {
    /** Day index from epoch (UTC). */
    d: number[];
    /** Hour of day 0-23 (UTC). */
    h: number[];
    s: Severity[];
    /** Stage, encoded: 0 gprd · 1 gstg · 2 cny · 3 unknown. */
    g: number[];
    /** Service bitmask. */
    v: number[];
    /** Duration minutes, -1 when unknown. */
    m: number[];
    q: DurationQuality[];
    /** Root cause index, -1 when none. */
    r: number[];
    /** 1 when still open/Active. */
    o: (0 | 1)[];
    /** iid, DELTA-encoded against the previous element. */
    i: number[];
  };
}

export const STAGE_CODES: Record<Stage, number> = { gprd: 0, gstg: 1, cny: 2, unknown: 3 };
export const STAGE_BY_CODE: Stage[] = ['gprd', 'gstg', 'cny', 'unknown'];

/** public/data/details/<year>.<hash>.json — lazy-loaded when a calendar day is opened. */
export interface DayDetailEntry {
  i: number;
  t: string;
  s: Severity;
  m: number;
  q: DurationQuality;
  o: 0 | 1;
}
export type YearDetails = Record<string, DayDetailEntry[]>;

export interface Streak {
  days: number;
  start: string;
  end: string;
}

/**
 * src/generated/aggregates.json — inlined into the HTML so the hero renders
 * with zero network round-trips. Computed for the DEFAULT filter only
 * (severity 1+2, stage gprd, all services).
 */
export interface Aggregates {
  generatedAt: string;
  firstIncident: string;
  /** Incidents matching the default filter. */
  totalDefault: number;
  /** Every incident in the tracker, unfiltered. */
  totalAll: number;
  lastIncidentDate: string;
  daysSince: number;
  avgPerMonthLast3: number;
  longestStreak: Streak;
  currentStreak: Streak;
  worstMonth: { month: string; count: number };
  /** "YYYY-MM" -> count, default filter. */
  byMonth: Record<string, number>;
  bySeverityAll: Record<string, number>;
  byRootCause: { key: string; count: number }[];
  byService: { key: string; count: number }[];
  /** "YYYY-MM" -> total S1/S2 mitigation minutes (quality 0 only). */
  downtimeByMonth: Record<string, number>;
}

/** src/generated/manifest.json — content-hashed URLs, so /data/* can be immutable. */
export interface DataManifest {
  incidents: string;
  details: Record<string, string>;
}

/** The filter state owned by the island. */
export interface FilterState {
  severities: Severity[];
  /** Service bitmask; 0 means "all". */
  serviceMask: number;
  /** Which stages to include. */
  stages: Stage[];
}

export const DEFAULT_FILTER: FilterState = {
  severities: [1, 2],
  serviceMask: 0,
  stages: ['gprd'],
};

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

export type VerdictKey =
  | 'raw'
  | 'room-temperature'
  | 'warming-up'
  | 'simmering'
  | 'cooked'
  | 'extra-crispy';

export interface Verdict {
  key: VerdictKey;
  word: string;
  subline: string;
  /** 0 = fine, 5 = catastrophic. Drives the colour ramp. */
  heat: 0 | 1 | 2 | 3 | 4 | 5;
  /** True when the status page and the incident tracker disagree. */
  disagreement: boolean;
}

/** src/generated/snapshot.json — build-time Status.io capture, the offline fallback. */
export interface StatusSnapshot {
  capturedAt: string;
  live: LiveStatus | null;
  /** Open gprd incidents at build time, worst severity first. */
  openIncidents: { iid: number; t: string; sev: Severity; c: string }[];
}
