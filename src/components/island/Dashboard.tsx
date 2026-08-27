/**
 * The one `client:load` island.
 *
 * WIRING (Track B): this component takes its build artifacts as props so Astro
 * can inline them and Vite can preload the big one. From index.astro:
 *
 *   ---
 *   import Dashboard from '../components/island/Dashboard';
 *   import manifest from '../generated/manifest.json';
 *   ---
 *   <Dashboard client:load manifest={manifest} />
 *
 * `manifest.incidents` is the content-hashed dataset URL. If the prop is
 * omitted the island falls back to a synthetic fixture in dev and to an inline
 * error card in production — it never renders a blank box, and it never takes
 * the server-rendered stat cards above it down with it.
 *
 * Everything below the filter bar recomputes on every filter change from a
 * single pass over the columnar arrays. At n = 7,325 that is well under a
 * millisecond, which is why there is no memoisation, no worker and no
 * virtualisation anywhere in this file.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { DataManifest } from '../../lib/types';
import type { DecodedDataset } from '../../lib/columnar';

// NOTE: palette.css is deliberately NOT imported here. A bare `@theme` block in
// a CSS file reached from a .tsx never goes through Tailwind's theme pass, so
// importing it from this side emits a second, unprocessed copy (and a
// "Unknown at rule: @theme" warning) while the variables still resolve to
// nothing. Track B imports it from src/styles/global.css, the Tailwind
// entrypoint, which is the only place it works. The `static` on that @theme
// block is also load-bearing: these tokens are consumed as var() inside SVG
// fills, never as utility classes, so without it Tailwind tree-shakes them all.

import FilterBar from './FilterBar';
import CalendarHeatmap, { LAST_12, type YearTab } from './CalendarHeatmap';
import DowntimeHeatmap from './DowntimeHeatmap';
import ClockHeatmap from './ClockHeatmap';
import DayDetail from './DayDetail';
import {
  MS_PER_DAY,
  countByHourDow,
  dailyWorstSeverity,
  dataset,
  datasetError,
  downtimeGrid,
  filter,
  loadDataset,
  openDay,
  serviceCounts,
  track,
  utcMidnightMs,
} from './state';
import { filterRows } from '../../lib/aggregate';

export default function Dashboard(props: { manifest?: DataManifest | null }): JSX.Element {
  const manifest = props.manifest ?? null;
  const [tab, setTab] = useState<YearTab>(LAST_12);

  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();

    const url = manifest?.incidents;
    if (url) {
      loadDataset(url, ctrl.signal).then(
        (ds) => {
          if (alive) dataset.value = ds;
        },
        (err: unknown) => {
          if (!alive || ctrl.signal.aborted) return;
          datasetError.value = err instanceof Error ? err.message : 'fetch failed';
        },
      );
    } else if (import.meta.env.DEV) {
      // Dev-only: lets the island be built and reviewed before Track A's
      // pipeline produces public/data/incidents.<hash>.json. Tree-shaken out of
      // the production bundle by the import.meta.env.DEV guard.
      void Promise.all([import('./__fixture'), import('../../lib/columnar')]).then(
        ([fx, columnar]) => {
          if (alive) dataset.value = columnar.decode(fx.fixtureDataset());
        },
      );
    } else {
      datasetError.value = 'no data manifest in this build';
    }

    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [manifest]);

  const ds = dataset.value;
  const err = datasetError.value;

  if (err && !ds) {
    return (
      <div class="card p-6" role="alert">
        <h3 class="text-base font-semibold text-ink">The interactive calendar didn’t load.</h3>
        <p class="mt-1.5 max-w-prose text-sm text-ink-muted">
          The incident dataset couldn’t be fetched ({err}). The headline numbers above are
          server-rendered and remain accurate — only this chart is missing. Reloading usually
          fixes it; if not, the{' '}
          <a
            class="font-medium text-accent underline underline-offset-2 hover:text-accent-hover"
            href="https://gitlab.com/gitlab-com/gl-infra/production/-/issues?label_name%5B%5D=incident"
            rel="noopener noreferrer nofollow"
            target="_blank"
          >
            raw incident list
          </a>{' '}
          is the source we build from.
        </p>
      </div>
    );
  }

  if (!ds) {
    return (
      <div class="grid min-h-64 place-items-center p-6" aria-busy="true">
        <p class="text-sm text-ink-muted">Loading 7,000+ incidents…</p>
      </div>
    );
  }

  return <Loaded ds={ds} manifest={manifest} tab={tab} setTab={setTab} />;
}

function Loaded(props: {
  ds: DecodedDataset;
  manifest: DataManifest | null;
  tab: YearTab;
  setTab: (t: YearTab) => void;
}): JSX.Element {
  const { ds } = props;
  const f = filter.value;
  const epochMs = useMemo(() => utcMidnightMs(ds.epoch), [ds.epoch]);

  const todayDay = useMemo(
    () => Math.floor(Date.now() / MS_PER_DAY) - Math.floor(epochMs / MS_PER_DAY),
    [epochMs],
  );

  const bounds = useMemo(() => {
    // decode() returns rows sorted ascending by day, so the ends are the extremes.
    const rows = ds.rows;
    const first = rows.length ? rows[0]!.d : 0;
    const last = Math.max(todayDay, rows.length ? rows[rows.length - 1]!.d : 0);
    return { first, last };
  }, [ds, todayDay]);

  const years = useMemo(() => {
    const y0 = new Date(epochMs + bounds.first * MS_PER_DAY).getUTCFullYear();
    const y1 = new Date(epochMs + bounds.last * MS_PER_DAY).getUTCFullYear();
    return Array.from({ length: y1 - y0 + 1 }, (_, k) => y0 + k);
  }, [epochMs, bounds]);

  // --- the one pass -------------------------------------------------------
  // filterRows is Track A's, so this island and the server-rendered stat cards
  // apply an identical predicate. Everything below derives from its output.
  const rows = useMemo(() => filterRows(ds, f), [ds, f]);
  const matched = rows.length;

  const buckets = useMemo(() => dailyWorstSeverity(rows, bounds.last + 1), [rows, bounds.last]);
  const downtime = useMemo(() => downtimeGrid(rows, ds.epoch, years), [rows, ds.epoch, years]);
  const clock = useMemo(() => countByHourDow(rows, epochMs), [rows, epochMs]);
  // Dataset-wide, NOT filter-scoped: see the prop docs on DowntimeHeatmap.
  const hasQuality0 = useMemo(() => ds.rows.some((r) => r.q === 0 && r.m >= 0), [ds]);
  const counts = useMemo(() => serviceCounts(ds, ds.services, f), [ds, f]);

  const now = new Date();
  const selected = openDay.value;

  return (
    <div class="flex flex-col gap-8">
      <FilterBar services={ds.services} counts={counts} matched={matched} total={ds.rows.length} />

      <section>
        <CalendarHeatmap
          buckets={buckets}
          epochMs={epochMs}
          firstDay={bounds.first}
          lastDay={bounds.last}
          tab={props.tab}
          years={years}
          onTab={(t) => {
            props.setTab(t);
            openDay.value = null;
            track('year_change', { year: t === LAST_12 ? 'last12' : t });
          }}
          selectedDay={selected}
          onSelectDay={(iso, count) => {
            const next = selected === iso ? null : iso;
            openDay.value = next;
            if (next) track('day_open', { date: iso, count });
          }}
        />

        {selected && (
          <DayDetail
            iso={selected}
            manifest={props.manifest}
            onClose={() => {
              openDay.value = null;
            }}
          />
        )}
      </section>

      <section class="grid gap-8 lg:grid-cols-2">
        <DowntimeHeatmap
          years={years}
          minutes={downtime.minutes}
          incidents={downtime.incidents}
          maxYear={now.getUTCFullYear()}
          maxMonth={now.getUTCMonth()}
          hasQuality0={hasQuality0}
        />
        <ClockHeatmap counts={clock} total={matched} />
      </section>
    </div>
  );
}
