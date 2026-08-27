/**
 * Years x months of measured downtime. 108 cells.
 *
 * THE CAVEAT IS THE CHART. Only S1 and S2 incidents carry a duration we trust:
 * it comes from the `Incident::Mitigated` label event (quality 0), which is the
 * moment the outage actually ended. S3/S4 durations are derived from when
 * somebody got round to closing the ticket, which routinely runs hundreds of
 * hours past the real event. Plotting those would produce a chart that is
 * confidently, legibly wrong — so they are excluded, and the exclusion is
 * stated on the chart rather than buried in a footnote.
 */

import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import Grid, { type GridCell } from './Grid';
import Legend, { DOWNTIME_BINS, binColors, binOf } from './Legend';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function humanMinutes(m: number): string {
  if (m <= 0) return 'no measured downtime';
  if (m < 60) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(h < 10 ? 1 : 0)} h`;
  return `${(h / 24).toFixed(1)} days`;
}

export default function DowntimeHeatmap(props: {
  years: number[];
  minutes: Float64Array;
  /** Incidents that contributed measured minutes (quality 0 only). */
  incidents: Uint16Array;
  /** Every filtered incident in the month, measured or not. */
  allIncidents: Uint16Array;
  /** Cells after this (year, month) have not happened yet. */
  maxYear: number;
  maxMonth: number;
  /**
   * Whether the dataset contains ANY quality-0 duration. Deliberately computed
   * over the whole dataset rather than the current filter: "no measured
   * downtime in this selection" is a real, meaningful empty grid, whereas "we
   * have no measured durations at all" is a missing-capability message. The two
   * must not look the same.
   */
  hasQuality0: boolean;
}): JSX.Element {
  const cells = useMemo(() => {
    const out: GridCell[] = [];
    props.years.forEach((year, y) => {
      for (let m = 0; m < 12; m++) {
        const idx = y * 12 + m;
        if (year > props.maxYear || (year === props.maxYear && m > props.maxMonth)) {
          out.push({ x: m, y, bin: 0, label: '', blank: true, key: `f-${year}-${m}` });
          continue;
        }
        const mins = props.minutes[idx] ?? 0;
        const n = props.incidents[idx] ?? 0;
        const nAll = props.allIncidents[idx] ?? 0;
        // A month with S1/S2 incidents but zero measured minutes is NOT a quiet
        // month - it is a month we cannot measure. GitLab only started applying
        // Incident::Mitigated partway through 2020, so 2018-2019 have 115 real
        // S1/S2 incidents and 0% duration coverage. Drawing those the same as
        // "none" would claim GitLab had no downtime in its two worst-documented
        // years. Hatch them instead: a different kind of state, not a colder one.
        const unmeasured = nAll > 0 && mins <= 0;
        out.push({
          x: m,
          y,
          bin: unmeasured ? 0 : binOf(DOWNTIME_BINS, mins),
          hatched: unmeasured,
          label: unmeasured
            ? `${MONTHS[m]} ${year}: ${nAll} S1/S2 incident${nAll === 1 ? '' : 's'}, duration not recorded`
            : `${MONTHS[m]} ${year}: ${humanMinutes(mins)} across ${n} S1/S2 incident${
                n === 1 ? '' : 's'
              }`,
          cellText: unmeasured ? `not measured / ${nAll}` : `${Math.round(mins)} min / ${n}`,
          key: `${year}-${String(m + 1).padStart(2, '0')}`,
        });
      }
    });
    return out;
  }, [
    props.years,
    props.minutes,
    props.incidents,
    props.allIncidents,
    props.maxYear,
    props.maxMonth,
  ]);

  const unmeasuredMonths = useMemo(
    () => cells.filter((c) => c.hatched).length,
    [cells],
  );

  const total = useMemo(() => {
    let t = 0;
    for (let i = 0; i < props.minutes.length; i++) t += props.minutes[i]!;
    return t;
  }, [props.minutes]);

  // No quality-0 durations anywhere in the dataset. Rendering 108 empty cells
  // here would state that GitLab had zero downtime since 2018, which is both
  // false and the most damaging thing this page could imply. Say what is
  // actually true instead: we cannot measure it yet.
  if (!props.hasQuality0) {
    return (
      <figure class="m-0">
        <figcaption class="mb-2">
          <h3 class="text-base font-semibold text-ink">Measured downtime by month</h3>
        </figcaption>
        <div class="card p-4">
          <p class="text-sm text-ink-muted">
            <strong class="font-medium text-ink">Not available yet.</strong> Real outage length
            comes from the timestamp on the{' '}
            <code class="font-mono text-xs">Incident::Mitigated</code> label, and GitLab’s API
            requires authentication to expose label events. Until that token is wired up, this
            chart stays empty rather than guessing.
          </p>
          <p class="mt-2 text-sm text-ink-muted">
            The unauthenticated alternative is{' '}
            <code class="font-mono text-xs">closed_at − created_at</code>, which is not an outage
            length: sampled S2 incidents come back as 265, 347 and 701 hours for outages that
            actually lasted minutes, because tickets get closed long after the problem is fixed.
            A wrong number here would be worse than no number.
          </p>
        </div>
      </figure>
    );
  }

  return (
    <figure class="m-0">
      <figcaption class="mb-2">
        <h3 class="text-base font-semibold text-ink">Measured downtime by month</h3>
        <p class="mt-1 text-sm text-ink-muted">
          <strong class="font-medium text-ink">S1 and S2 only.</strong> Minutes are measured from
          the incident opening to the <code class="font-mono text-xs">Incident::Mitigated</code>{' '}
          label. S3 and S4 issues are excluded on purpose: their only available duration is
          “when the ticket was closed”, which overshoots the real outage by hundreds of hours.
          {total > 0 && (
            <>
              {' '}
              Total shown: <span class="tabular-nums">{humanMinutes(total)}</span>.
            </>
          )}
        </p>
        {unmeasuredMonths > 0 && (
          <p class="mt-1 text-sm text-ink-muted">
            Hatched months had S1/S2 incidents whose duration was never recorded — GitLab only
            began applying the <code class="font-mono text-xs">Incident::Mitigated</code> label
            partway through 2020, so most of 2018 and 2019 cannot be measured. Those are blank
            for lack of data, not for lack of outages.
          </p>
        )}
      </figcaption>

      <div class="-mx-1 overflow-x-auto px-1 pb-1">
        <div class="min-w-[420px]">
          <Grid
            cells={cells}
            cols={12}
            rows={props.years.length}
            binColors={binColors(DOWNTIME_BINS)}
            cellSize={22}
            gap={4}
            radius={4}
            rowLabels={props.years.map(String)}
            colTicks={MONTHS.map((t, at) => ({ at, text: t }))}
            tableColLabels={MONTHS}
            gutter={34}
            ariaLabel="Measured S1 and S2 downtime minutes per month, 2018 to today."
            tableCaption="Total S1/S2 mitigation minutes and incident count per month. Rows are years, columns are months."
          />
        </div>
      </div>

      <div class="mt-3">
        <Legend title="S1/S2 downtime in the month" bins={DOWNTIME_BINS} />
        {unmeasuredMonths > 0 && (
          <p class="mt-2 flex items-center gap-2 text-xs text-ink-muted">
            <svg width="14" height="14" aria-hidden="true" class="shrink-0">
              <rect
                width="14"
                height="14"
                rx="3"
                fill="var(--color-heat-q0)"
                stroke="currentColor"
                stroke-opacity="0.35"
              />
              <rect width="14" height="14" rx="3" fill="url(#igc-hatch)" />
            </svg>
            incidents occurred, duration not recorded
          </p>
        )}
      </div>
    </figure>
  );
}
