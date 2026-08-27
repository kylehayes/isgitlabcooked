/**
 * When does GitLab break? Hour-of-day (UTC) x day-of-week, 168 cells.
 *
 * Free: the `h` column is already in the dataset, so this costs one extra pass
 * over the same arrays and no extra bytes over the wire.
 *
 * Everything is UTC, including the day boundary. Bucketing by the reader's
 * local timezone would smear each column across two of them and quietly change
 * the answer depending on who is looking.
 */

import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import Grid, { type GridCell } from './Grid';
import Legend, { CLOCK_BINS, binColors, binOf } from './Legend';

const DOW_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DOW_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export default function ClockHeatmap(props: { counts: Uint16Array; total: number }): JSX.Element {
  const cells = useMemo(() => {
    const out: GridCell[] = [];
    for (let dow = 0; dow < 7; dow++) {
      for (let h = 0; h < 24; h++) {
        const n = props.counts[dow * 24 + h] ?? 0;
        out.push({
          x: h,
          y: dow,
          bin: binOf(CLOCK_BINS, n),
          label: `${DOW_FULL[dow]} ${String(h).padStart(2, '0')}:00–${String(h).padStart(2, '0')}:59 UTC: ${n} incident${
            n === 1 ? '' : 's'
          }`,
          cellText: String(n),
          key: `${dow}-${h}`,
        });
      }
    }
    return out;
  }, [props.counts]);

  const peak = useMemo(() => {
    let best = -1;
    let at = 0;
    for (let i = 0; i < props.counts.length; i++) {
      if (props.counts[i]! > best) {
        best = props.counts[i]!;
        at = i;
      }
    }
    return { dow: Math.floor(at / 24), hour: at % 24, n: best };
  }, [props.counts]);

  return (
    <figure class="m-0">
      <figcaption class="mb-2">
        <h3 class="text-base font-semibold text-ink">When does it break?</h3>
        <p class="mt-1 text-sm text-ink-muted">
          Incident start time, by UTC hour and UTC weekday, across the {props.total.toLocaleString()}{' '}
          incidents matching your filter.
          {peak.n > 0 && (
            <>
              {' '}
              Busiest hour: {DOW_FULL[peak.dow]} at{' '}
              <span class="tabular-nums">{String(peak.hour).padStart(2, '0')}:00</span> UTC.
            </>
          )}
        </p>
      </figcaption>

      <div class="-mx-1 overflow-x-auto px-1 pb-1">
        <div class="min-w-[520px]">
          <Grid
            cells={cells}
            cols={24}
            rows={7}
            binColors={binColors(CLOCK_BINS)}
            cellSize={18}
            gap={3}
            radius={3}
            rowLabels={DOW_SHORT}
            colTicks={Array.from({ length: 12 }, (_, k) => ({
              at: k * 2,
              text: String(k * 2).padStart(2, '0'),
            }))}
            tableColLabels={Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00 UTC`)}
            gutter={30}
            ariaLabel="Incident start times by UTC hour of day and day of week."
            tableCaption="Incident count by UTC weekday (rows) and UTC hour of day (columns)."
          />
        </div>
      </div>

      <div class="mt-3">
        <Legend title="Incidents in that hour-of-week" bins={CLOCK_BINS} />
      </div>
    </figure>
  );
}
