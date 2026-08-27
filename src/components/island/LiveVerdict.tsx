/**
 * The live verdict. Drops into Hero.astro's `verdict` named slot (option (a) of
 * the hydration contract at the top of that file), so the server-rendered word
 * stays in the HTML for crawlers and is replaced in place on hydrate.
 *
 * Failure policy, in order of importance:
 *   1. NEVER a false all-clear. If we cannot reach Status.io we say so; we do
 *      not quietly render "Raw".
 *   2. NEVER a spinner of death. The build-time snapshot is already a valid
 *      verdict, so there is nothing to wait for — it renders immediately and is
 *      upgraded when (if) the network answers.
 *   3. 4-second timeout, then fall back. A status page that is itself melting
 *      is exactly the moment this site gets traffic.
 *
 * Both endpoints send `access-control-allow-origin: *`, so these are direct
 * browser fetches with no proxy and no build-time coupling.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { LiveComponent, LiveStatus, Severity, StatusCode, StatusSnapshot, Verdict } from '../../lib/types';
import { computeVerdict, staleSubline, type OpenIncident } from '../../lib/verdict';
import { parseSeverity } from '../../lib/severity';
import { track } from './state';

const STATUS_URL = 'https://api.status.io/1.0/status/5b36dc6502d06804c08349f7';
// `state=opened` alone is NOT "currently broken". Incident tickets stay open
// long after the outage ends: of 100 open tickets sampled, 52 were
// Incident::Merged, 42 Incident::Resolved and 3 Incident::Mitigated — only 3
// were actually Incident::Active. Counting all of them would both inflate the
// headline and falsely trip the verdict to Cooked off a resolved ticket.
// Filtering server-side also sidesteps the per_page truncation.
const ISSUES_URL =
  'https://gitlab.com/api/v4/projects/7444821/issues' +
  '?labels=incident,Incident%3A%3AActive&state=opened&per_page=20';
const TIMEOUT_MS = 4000;
const POLL_MS = 60_000;

// --- Status.io wire shapes -------------------------------------------------
// Deliberately loose: this is a third-party API we do not control, every field
// is optional at the type level, and the normalisers below are the only place
// allowed to assume anything.

interface RawComponent {
  id?: string;
  _id?: string;
  name?: string;
  status?: string;
  status_code?: number;
  updated?: string;
}

/** An update in an incident's timeline. */
interface RawMessage {
  details?: string;
  /** Lifecycle: 100 Investigating, 200 Identified, 300 Monitoring, 400 Resolved. */
  state?: number;
  /** Severity, same scale as status_overall.status_code. NOT the same as `state`. */
  status?: number;
  datetime?: string;
}

interface RawIncident {
  _id?: string;
  name?: string;
  datetime_open?: string;
  current_active?: boolean;
  messages?: RawMessage[];
  components_affected?: { _id?: string; name?: string }[];
}

interface RawStatus {
  result?: {
    status_overall?: { updated?: string; status?: string; status_code?: number };
    status?: RawComponent[];
    incidents?: RawIncident[];
  };
}

/** The subset of a Status.io incident this UI renders. */
export interface ActiveIncident {
  id: string;
  name: string;
  openedAt: string;
  /** Newest message's prose, which is usually more current than the codes. */
  latest: string | null;
  latestAt: string | null;
  /** Lifecycle word derived from the newest message's `state`. */
  phase: string | null;
  components: string[];
}

const PHASES: Record<number, string> = {
  100: 'Investigating',
  200: 'Identified',
  300: 'Monitoring',
  400: 'Resolved',
};

function asStatusCode(n: number | undefined): StatusCode {
  return n === 300 || n === 400 || n === 500 ? n : 100;
}

function normaliseStatus(raw: RawStatus): { live: LiveStatus; incidents: ActiveIncident[] } {
  const r = raw.result ?? {};
  const components: LiveComponent[] = (r.status ?? []).map((c) => ({
    id: c.id ?? c._id ?? c.name ?? '',
    name: c.name ?? 'Unknown component',
    status: c.status ?? 'Unknown',
    status_code: asStatusCode(c.status_code),
    updated: c.updated ?? '',
  }));

  const live: LiveStatus = {
    updated: r.status_overall?.updated ?? new Date().toISOString(),
    overall: {
      status: r.status_overall?.status ?? 'Unknown',
      status_code: asStatusCode(r.status_overall?.status_code),
    },
    components,
    degradedCount: components.filter((c) => c.status_code !== 100).length,
  };

  // `incidents` is [] on any normal day; that is the common case, not an error.
  const incidents: ActiveIncident[] = (r.incidents ?? [])
    .filter((i) => i.current_active !== false)
    .map((i) => {
      const msgs = i.messages ?? [];
      // Oldest first on the wire, so the newest update is the last element.
      const newest = msgs.length ? msgs[msgs.length - 1] : undefined;
      return {
        id: i._id ?? i.name ?? 'incident',
        name: i.name ?? 'Unnamed incident',
        openedAt: i.datetime_open ?? '',
        latest: newest?.details ?? null,
        latestAt: newest?.datetime ?? null,
        phase: newest?.state !== undefined ? (PHASES[newest.state] ?? null) : null,
        components: (i.components_affected ?? [])
          .map((c) => c.name)
          .filter((n): n is string => typeof n === 'string'),
      };
    });

  return { live, incidents };
}

// --- GitLab tracker --------------------------------------------------------

interface RawIssue {
  iid?: number;
  title?: string;
  labels?: string[];
  created_at?: string;
}

/**
 * Staging and canary incidents are not user-facing, and the verdict is about
 * whether GitLab.com is cooked for a user. Cheap title check rather than
 * pulling the whole service/stage classifier into the client bundle.
 */
const NON_PROD_RE = /\b(gstg|staging|canary|cny|pre-?prod)\b/i;

function normaliseIssues(raw: RawIssue[]): OpenIncident[] {
  const out: OpenIncident[] = [];
  for (const i of raw) {
    if (typeof i.iid !== 'number') continue;
    const title = i.title ?? '';
    if (NON_PROD_RE.test(title)) continue;
    // Defence in depth: the URL already filters to Incident::Active, but if
    // that ever regresses we must not report a resolved ticket as an outage.
    const labels = i.labels ?? [];
    if (labels.some((l) => l.startsWith('Incident::') && l !== 'Incident::Active')) continue;
    out.push({
      iid: i.iid,
      t: title.replace(/^\d{4}-\d{2}-\d{2}:\s*/, ''),
      sev: parseSeverity(i.labels ?? []) as Severity,
      c: i.created_at ?? new Date().toISOString(),
    });
  }
  return out;
}

async function fetchJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// --- Component -------------------------------------------------------------

type Source = 'snapshot' | 'live';

export default function LiveVerdict(props: {
  /** Track B passes src/generated/snapshot.json through. */
  snapshot: StatusSnapshot | null;
  /** Set false to render the verdict without the component grid. */
  showComponents?: boolean;
}): JSX.Element {
  const snapshot = props.snapshot;

  const [verdict, setVerdict] = useState<Verdict>(() =>
    computeVerdict({
      live: snapshot?.live ?? null,
      open: snapshot?.openIncidents ?? [],
    }),
  );
  const [source, setSource] = useState<Source>('snapshot');
  const [live, setLive] = useState<LiveStatus | null>(snapshot?.live ?? null);
  const [incidents, setIncidents] = useState<ActiveIncident[]>([]);
  const [failed, setFailed] = useState(false);
  const reported = useRef<string>('');

  useEffect(() => {
    let alive = true;

    const tick = async () => {
      // The two calls are independent: a dead tracker must not hide a live
      // status page, and vice versa.
      const [statusRes, issuesRes] = await Promise.allSettled([
        fetchJson<RawStatus>(STATUS_URL),
        fetchJson<RawIssue[]>(ISSUES_URL),
      ]);
      if (!alive) return;

      const statusOk = statusRes.status === 'fulfilled';
      const issuesOk = issuesRes.status === 'fulfilled';

      if (!statusOk) {
        setFailed(true);
        track('status_fetch_failed', {
          reason:
            statusRes.reason instanceof Error ? statusRes.reason.message : 'unknown',
        });
        // Keep whatever verdict we already have. Explicitly NOT falling through
        // to a recomputed all-clear.
        return;
      }

      const { live: nextLive, incidents: nextIncidents } = normaliseStatus(statusRes.value);
      const open = issuesOk
        ? normaliseIssues(issuesRes.value)
        : (snapshot?.openIncidents ?? []);

      if (!issuesOk) {
        track('status_fetch_failed', { reason: 'tracker unreachable' });
      }

      setFailed(false);
      setLive(nextLive);
      setIncidents(nextIncidents);
      setVerdict(computeVerdict({ live: nextLive, open }));
      setSource('live');
    };

    void tick();
    const id = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [snapshot]);

  // Keep Hero's wrapper attributes honest for anything reading the DOM
  // (option (b) consumers, and our own CSS hooks).
  useEffect(() => {
    const mount = document.getElementById('verdict-mount');
    if (!mount) return;
    mount.dataset.verdictKey = verdict.key;
    mount.dataset.heat = String(verdict.heat);
    mount.dataset.disagreement = String(verdict.disagreement);
    mount.dataset.source = source;
  }, [verdict, source]);

  useEffect(() => {
    const sig = `${verdict.key}:${source}:${verdict.disagreement}`;
    if (reported.current === sig) return;
    reported.current = sig;
    track('verdict_shown', {
      key: verdict.key,
      heat: verdict.heat,
      disagreement: verdict.disagreement,
      source,
    });
  }, [verdict, source]);

  const stale = failed || source === 'snapshot';
  const subline =
    failed && snapshot ? staleSubline(snapshot.capturedAt) : verdict.subline;
  const isCooked = verdict.heat >= 3;

  return (
    <>
      <p class="text-lg font-semibold text-ink-muted sm:text-xl">
        Short answer: <span class="text-ink">{isCooked ? 'Yes.' : 'No.'}</span>
      </p>

      <p
        class="text-verdict font-black text-balance"
        style={{ color: `var(--color-heat-${verdict.heat})` }}
      >
        {verdict.word}
      </p>

      <p class="mt-2 max-w-xl text-center text-base text-ink-muted sm:text-lg">{subline}</p>

      {stale && !failed && (
        <p class="mt-1 text-xs text-ink-subtle">Checking status.gitlab.com…</p>
      )}

      {/* THE disagreement. The reason this site exists rather than linking to
          the status page: the status page is a statement of policy, the tracker
          is a statement of fact, and they are not always the same statement. */}
      {verdict.disagreement && (
        <div
          role="alert"
          class="mt-4 w-full max-w-2xl rounded-lg border-2 px-4 py-3 text-left"
          style={{
            borderColor: 'var(--color-heat-4)',
            background: 'var(--color-heat-soft-4)',
          }}
        >
          <p class="flex items-start gap-2 text-sm font-semibold text-ink">
            <span aria-hidden="true">⚠</span>
            <span>Status page says fine. The incident tracker disagrees.</span>
          </p>
          <p class="mt-1 pl-6 text-sm text-ink-muted">
            All 23 Status.io components report operational, but GitLab’s own infrastructure
            tracker has an open production incident right now.
          </p>
        </div>
      )}

      {incidents.length > 0 && (
        <ul class="mt-4 flex w-full max-w-2xl flex-col gap-2 text-left">
          {incidents.map((inc) => (
            <li
              key={inc.id}
              class="rounded-lg border border-border bg-surface-raised px-4 py-3"
            >
              <p class="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-ink">
                {inc.name}
                {inc.phase && (
                  <span class="rounded-full bg-surface-sunken px-2 py-0.5 text-[0.6875rem] font-medium text-ink-muted">
                    {inc.phase}
                  </span>
                )}
              </p>
              {inc.latest && <p class="mt-1 text-sm text-ink-muted">{inc.latest}</p>}
              {inc.components.length > 0 && (
                <p class="mt-1.5 text-xs text-ink-subtle">
                  Affecting: {inc.components.join(', ')}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      {props.showComponents !== false && live && (
        <ComponentGrid live={live} affected={new Set(incidents.flatMap((i) => i.components))} />
      )}
    </>
  );
}

const CODE_LABEL: Record<StatusCode, string> = {
  100: 'Operational',
  300: 'Degraded',
  400: 'Partial Outage',
  500: 'Service Disruption',
};

/** Status codes wear status colours and always ship with the word, never alone. */
function codeColor(code: StatusCode): string {
  if (code === 100) return 'var(--color-ok)';
  if (code === 300) return 'var(--color-heat-2)';
  if (code === 400) return 'var(--color-heat-3)';
  return 'var(--color-heat-4)';
}

function ComponentGrid(props: { live: LiveStatus; affected: Set<string> }): JSX.Element {
  const bad = props.live.components.filter((c) => c.status_code !== 100);
  if (bad.length === 0) return <></>;
  return (
    <ul class="mt-4 flex w-full max-w-2xl flex-wrap gap-1.5">
      {bad.map((c) => (
        <li
          key={c.id}
          class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium text-ink"
          style={{
            borderColor: codeColor(c.status_code),
            background: props.affected.has(c.name) ? 'var(--color-heat-soft-3)' : 'transparent',
          }}
        >
          <span
            aria-hidden="true"
            class="inline-block size-2 rounded-full"
            style={{ background: codeColor(c.status_code) }}
          />
          {c.name}
          <span class="text-ink-subtle">{CODE_LABEL[c.status_code]}</span>
        </li>
      ))}
    </ul>
  );
}
