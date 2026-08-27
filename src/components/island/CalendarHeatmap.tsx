/**
 * GitHub-contributions-style calendar. One square per UTC day, coloured by the
 * WORST severity that day (not the count — a day with one S1 is worse than a
 * day with nine S4s, and the count is in the tooltip).
 *
 * Only ONE year is in the DOM at a time: 371 rects, not the ~3,100 a full
 * 2018-today grid would need. Switching years replaces the cell array, which
 * Preact diffs as a keyed list of the same length.
 */

import { useMemo } from 'preact/hooks';
import type { JSX } from 'preact';
import Grid, { type GridCell } from './Grid';
import Legend, { HatchSwatch, SEVERITY_BINS, binColors, severityBin } from './Legend';
import { MS_PER_DAY, isoFromMs, utcMidnightMs, weekdayMon0, type DayBuckets } from './state';

const DOW = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEV_WORD: Record<number, string> = {
  [-1]: 'none',
  0: 'unlabelled',
  1: 'S1 Critical',
  2: 'S2 Major',
  3: 'S3 Minor',
  4: 'S4 Low',
};

export const LAST_12 = 'last12';
export type YearTab = typeof LAST_12 | number;

export interface CalendarProps {
  buckets: DayBuckets;
  epochMs: number;
  /** Inclusive day-index bounds of the dataset. */
  firstDay: number;
  lastDay: number;
  tab: YearTab;
  onTab: (tab: YearTab) => void;
  years: number[];
  onSelectDay: (iso: string, count: number) => void;
  selectedDay: string | null;
}

export default function CalendarHeatmap(props: CalendarProps): JSX.Element {
  const { buckets, epochMs, firstDay, lastDay, tab } = props;

  const range = useMemo(() => {
    if (tab === LAST_12) {
      // 52 whole weeks back from the Monday of the current week, so the grid
      // is exactly 53 columns and the right edge is always "today".
      const end = lastDay;
      const start = Math.max(firstDay, end - 364);
      return { start, end };
    }
    const start = Math.round((utcMidnightMs(`${tab}-01-01`) - epochMs) / MS_PER_DAY);
    const end = Math.round((utcMidnightMs(`${tab}-12-31`) - epochMs) / MS_PER_DAY);
    return { start: Math.max(start, 0), end: Math.min(end, lastDay) };
  }, [tab, epochMs, firstDay, lastDay]);

  const { cells, cols, colTicks, tableColLabels } = useMemo(() => {
    // Column 0 is the week containing `start`; rows are Mon..Sun.
    const startDow = weekdayMon0(epochMs + range.start * MS_PER_DAY);
    const gridStart = range.start - startDow;
    const total = range.end - gridStart + 1;
    const nCols = Math.ceil(total / 7);
    const out: GridCell[] = [];
    const ticks: { at: number; text: string }[] = [];
    const colLabels: string[] = [];
    let lastMonth = -1;

    for (let col = 0; col < nCols; col++) {
      const colFirst = gridStart + col * 7;
      colLabels.push(isoFromMs(epochMs + Math.max(colFirst, 0) * MS_PER_DAY));
      for (let row = 0; row < 7; row++) {
        const day = gridStart + col * 7 + row;
        if (day < range.start || day > range.end || day < 0) {
          out.push({ x: col, y: row, bin: 0, label: '', blank: true, key: `b${col}-${row}` });
          continue;
        }
        const ms = epochMs + day * MS_PER_DAY;
        const iso = isoFromMs(ms);
        const worst = buckets.worst[day] ?? -1;
        const count = buckets.count[day] ?? 0;
        const ongoing = buckets.ongoing[day] === 1;

        // Month ticks go on the first column whose Monday starts a new month.
        if (row === 0) {
          const m = new Date(ms).getUTCMonth();
          if (m !== lastMonth) {
            ticks.push({ at: col, text: MONTHS[m]! });
            lastMonth = m;
          }
        }

        const label =
          count === 0
            ? `${iso}: no incidents`
            : `${iso}: ${count} incident${count === 1 ? '' : 's'}, worst severity ${SEV_WORD[worst] ?? 'unknown'}${
                ongoing ? ' — one is still open' : ''
              }`;

        out.push({
          x: col,
          y: row,
          bin: severityBin(worst),
          label,
          cellText: count === 0 ? '0' : `${count} (${SEV_WORD[worst] ?? '?'})`,
          hatched: ongoing,
          key: iso,
        });
      }
    }
    return { cells: out, cols: nCols, colTicks: ticks, tableColLabels: colLabels };
  }, [buckets, epochMs, range]);

  const rangeLabel =
    tab === LAST_12
      ? 'the last 12 months'
      : `${tab}`;

  return (
    <figure class="m-0">
      <figcaption class="sr-only">
        Daily incident calendar for {rangeLabel}, coloured by the worst severity recorded each day.
      </figcaption>

      <div
        class="mb-3 flex flex-wrap gap-1"
        role="tablist"
        aria-label="Calendar range"
      >
        <TabButton active={tab === LAST_12} onClick={() => props.onTab(LAST_12)}>
          Last 12 months
        </TabButton>
        {props.years.map((y) => (
          <TabButton key={y} active={tab === y} onClick={() => props.onTab(y)}>
            {y}
          </TabButton>
        ))}
      </div>

      {/* Under 640px the grid stops shrinking and scrolls instead: an 11px cell
          squeezed to 5px is not a chart, it is a texture. */}
      <div class="-mx-1 overflow-x-auto px-1 pb-1">
        <div class="min-w-[560px]">
          <Grid
            cells={cells}
            cols={cols}
            rows={7}
            binColors={binColors(SEVERITY_BINS)}
            cellSize={11}
            gap={3}
            rowLabels={DOW}
            colTicks={colTicks}
            tableColLabels={tableColLabels}
            gutter={26}
            ariaLabel={`Incident calendar for ${rangeLabel}. Worst severity per day.`}
            tableCaption={`Incidents per day for ${rangeLabel}. Columns are weeks starting on the date shown; rows are days of the week.`}
            selectedKey={props.selectedDay}
            onSelect={(c) => {
              const count = Number(/(\d+) incident/.exec(c.label)?.[1] ?? 0);
              props.onSelectDay(c.key!, count);
            }}
          />
        </div>
      </div>

      <div class="mt-3">
        <Legend
          title="Worst severity that day"
          bins={SEVERITY_BINS}
          extras={[{ label: 'still open', swatch: <HatchSwatch /> }]}
        />
      </div>
    </figure>
  );
}

function TabButton(props: {
  active: boolean;
  onClick: () => void;
  children: JSX.Element | string | number;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      class={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        props.active
          ? 'bg-accent text-accent-ink'
          : 'bg-surface-sunken text-ink-muted hover:text-ink'
      }`}
    >
      {props.children}
    </button>
  );
}
