/**
 * The popover behind a calendar day click.
 *
 * Per-year detail files are lazy: the columnar dataset deliberately drops
 * titles, so opening a day is the first time we need them. Each year is fetched
 * at most once and kept in a module-level Map — a user clicking through
 * December 2024 should pay one request, not thirty-one.
 *
 * A failed fetch renders inside the popover. The dataset, the calendar and the
 * server-rendered stats are all still fine; losing one day's titles must not
 * escalate into a broken page.
 */

import { useEffect, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DataManifest, DayDetailEntry, Severity, YearDetails } from '../../lib/types';
import { track } from './state';

const ISSUE_BASE = 'https://gitlab.com/gitlab-com/gl-infra/production/-/issues/';

const SEV_LABEL: Record<Severity, string> = {
  0: 'Unlabelled',
  1: 'S1 Critical',
  2: 'S2 Major',
  3: 'S3 Minor',
  4: 'S4 Low',
};

/** year -> parsed details, or a pending promise. Survives popover unmounts. */
const cache = new Map<string, YearDetails>();
const inflight = new Map<string, Promise<YearDetails>>();

async function loadYear(year: string, manifest: DataManifest): Promise<YearDetails> {
  const hit = cache.get(year);
  if (hit) return hit;
  const pending = inflight.get(year);
  if (pending) return pending;

  const url = manifest.details[year];
  if (!url) throw new Error(`no detail file for ${year}`);

  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`details ${res.status}`);
    const data = (await res.json()) as YearDetails;
    cache.set(year, data);
    inflight.delete(year);
    return data;
  })();
  inflight.set(year, p);
  return p;
}

export default function DayDetail(props: {
  iso: string;
  manifest: DataManifest | null;
  onClose: () => void;
}): JSX.Element {
  const [state, setState] = useState<
    { s: 'loading' } | { s: 'ok'; rows: DayDetailEntry[] } | { s: 'error'; message: string }
  >({ s: 'loading' });

  const year = props.iso.slice(0, 4);

  useEffect(() => {
    let live = true;
    if (!props.manifest) {
      setState({
        s: 'error',
        message: 'Incident titles are not available in this build yet.',
      });
      return;
    }
    setState({ s: 'loading' });
    loadYear(year, props.manifest).then(
      (data) => {
        if (!live) return;
        setState({ s: 'ok', rows: data[props.iso] ?? [] });
      },
      (err: unknown) => {
        if (!live) return;
        setState({
          s: 'error',
          message: err instanceof Error ? err.message : 'could not load that day',
        });
      },
    );
    return () => {
      live = false;
    };
  }, [props.iso, year, props.manifest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') props.onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.onClose]);

  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label={`Incidents on ${props.iso}`}
      class="card mt-4 p-4"
    >
      <div class="flex items-start justify-between gap-3">
        <h3 class="text-base font-semibold text-ink">
          <time datetime={props.iso}>{props.iso}</time>
        </h3>
        <button
          type="button"
          onClick={props.onClose}
          class="-m-1 rounded p-1 text-sm text-ink-muted hover:text-ink"
          aria-label="Close day detail"
        >
          ✕
        </button>
      </div>

      {state.s === 'loading' && (
        <p class="mt-2 text-sm text-ink-muted" aria-live="polite">
          Loading incidents for {year}…
        </p>
      )}

      {state.s === 'error' && (
        <p
          class="mt-2 rounded-md border border-border bg-alarm-soft px-3 py-2 text-sm text-ink"
          role="alert"
        >
          Couldn’t load the incident list for {year} ({state.message}).{' '}
          <a
            class="font-medium text-accent underline underline-offset-2"
            href={`https://gitlab.com/gitlab-com/gl-infra/production/-/issues?scope=all&state=all&label_name[]=incident&search=${props.iso}`}
            rel="noopener noreferrer nofollow"
            target="_blank"
          >
            Search GitLab directly
          </a>
          .
        </p>
      )}

      {state.s === 'ok' && state.rows.length === 0 && (
        <p class="mt-2 text-sm text-ink-muted">No incidents recorded on this day.</p>
      )}

      {state.s === 'ok' && state.rows.length > 0 && (
        <ul class="mt-3 flex flex-col gap-2">
          {state.rows.map((r) => (
            <li key={r.i} class="flex items-start gap-2.5">
              <span
                class="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[0.6875rem] font-semibold text-ink"
                style={{ background: 'var(--color-surface-sunken)' }}
              >
                <span
                  aria-hidden="true"
                  class="inline-block size-2 rounded-[2px]"
                  style={{
                    background: r.s === 0 ? 'var(--color-sev-unknown)' : `var(--color-sev-${r.s})`,
                  }}
                />
                {SEV_LABEL[r.s]}
              </span>
              <span class="min-w-0 flex-1">
                <a
                  class="text-sm font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
                  href={`${ISSUE_BASE}${r.i}`}
                  rel="noopener noreferrer nofollow"
                  target="_blank"
                  onClick={() => track('incident_click', { iid: r.i, sev: r.s })}
                >
                  {r.t}
                </a>
                <span class="ml-1.5 text-xs text-ink-subtle">#{r.i}</span>
                <span class="block text-xs text-ink-subtle">
                  {r.o === 1 ? (
                    <span class="font-medium text-ink">still open</span>
                  ) : /* Quality 0 is the Mitigated label event; anything else is
                        the closed_at proxy, which is not an outage length. */
                  r.q === 0 && r.m >= 0 ? (
                    <>mitigated after {formatMinutes(r.m)}</>
                  ) : (
                    <>duration not measured</>
                  )}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return rem ? `${h} h ${rem} min` : `${h} h`;
}
