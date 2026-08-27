/**
 * Legend. Every heatmap gets one, and it is generated from the SAME bin
 * definition the cells are coloured from — a legend that can drift from its
 * chart is worse than no legend.
 *
 * Bucket text is always a real range ("16-60 min"), never "less -> more".
 * "Less to more" tells the reader that there is a scale without telling them
 * what it measures, which is the one thing a legend exists to do.
 */

import type { JSX } from 'preact';

export interface Bin {
  /** Inclusive lower bound. */
  min: number;
  /** Exclusive upper bound; null means unbounded. */
  max: number | null;
  /** Legend text, e.g. "1-15 min" or "S2 Major". */
  label: string;
  /** CSS colour, always a var() so light/dark swap in one place. */
  color: string;
}

/** Index of the bin `value` falls into. Bins must be ordered and contiguous. */
export function binOf(bins: Bin[], value: number): number {
  for (let i = bins.length - 1; i >= 0; i--) {
    const b = bins[i]!;
    if (value >= b.min && (b.max === null || value < b.max)) return i;
  }
  return 0;
}

export function binColors(bins: Bin[]): string[] {
  return bins.map((b) => b.color);
}

export default function Legend(props: {
  bins: Bin[];
  /** Rendered before the swatches, e.g. "S1/S2 downtime". */
  title?: string;
  /** Extra swatches appended after the ramp (e.g. the "ongoing" hatch). */
  extras?: { label: string; swatch: JSX.Element }[];
}): JSX.Element {
  return (
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-ink-muted">
      {props.title && <span class="font-medium text-ink">{props.title}</span>}
      <ul class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {props.bins.map((b) => (
          <li key={b.label} class="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              class="inline-block size-3 shrink-0 rounded-[3px] ring-1 ring-[var(--color-sev-cell-ring)]"
              style={{ background: b.color }}
            />
            <span class="tabular-nums">{b.label}</span>
          </li>
        ))}
        {props.extras?.map((e) => (
          <li key={e.label} class="flex items-center gap-1.5">
            {e.swatch}
            <span>{e.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The hatch swatch, drawn with the same pattern geometry Grid uses. */
export function HatchSwatch(): JSX.Element {
  return (
    <svg aria-hidden="true" width="12" height="12" class="inline-block shrink-0">
      <defs>
        <pattern
          id="igc-hatch-legend"
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="4" height="4" fill="var(--color-sev-3)" />
          <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-ink)" stroke-width="1.6" />
        </pattern>
      </defs>
      <rect
        width="12"
        height="12"
        rx="3"
        fill="url(#igc-hatch-legend)"
        stroke="var(--color-sev-cell-ring)"
        stroke-width="0.5"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The three bin scales. Defined here, next to the legend, so a chart cannot
// colour by one scale and describe itself with another.
// ---------------------------------------------------------------------------

/**
 * Severity. Ordinal, so it reads as a ranked ramp rather than five identities.
 * Index order is "how bad", ascending, which is the reverse of the S-number.
 */
export const SEVERITY_BINS: Bin[] = [
  { min: 0, max: 1, label: 'none', color: 'var(--color-sev-none)' },
  { min: 1, max: 2, label: 'unlabelled', color: 'var(--color-sev-unknown)' },
  { min: 2, max: 3, label: 'S4 Low', color: 'var(--color-sev-4)' },
  { min: 3, max: 4, label: 'S3 Minor', color: 'var(--color-sev-3)' },
  { min: 4, max: 5, label: 'S2 Major', color: 'var(--color-sev-2)' },
  { min: 5, max: null, label: 'S1 Critical', color: 'var(--color-sev-1)' },
];

/** Maps a worst-severity value (-1 none, 0 unlabelled, 1..4) to a bin index. */
export function severityBin(worst: number): number {
  if (worst < 0) return 0;
  if (worst === 0) return 1;
  return 6 - worst; // 4 -> 2, 3 -> 3, 2 -> 4, 1 -> 5
}

/** Minutes of S1/S2 downtime. Buckets chosen so each holds a usable share. */
export const DOWNTIME_BINS: Bin[] = [
  { min: 0, max: 1, label: 'none', color: 'var(--color-heat-q0)' },
  { min: 1, max: 60, label: '<1 h', color: 'var(--color-heat-q1)' },
  { min: 60, max: 240, label: '1–4 h', color: 'var(--color-heat-q2)' },
  { min: 240, max: 720, label: '4–12 h', color: 'var(--color-heat-q3)' },
  { min: 720, max: 1800, label: '12–30 h', color: 'var(--color-heat-q4)' },
  { min: 1800, max: null, label: '30 h +', color: 'var(--color-heat-q5)' },
];

/** Incident counts in an hour-of-week cell. */
export const CLOCK_BINS: Bin[] = [
  { min: 0, max: 1, label: '0', color: 'var(--color-heat-q0)' },
  { min: 1, max: 6, label: '1–5', color: 'var(--color-heat-q1)' },
  { min: 6, max: 16, label: '6–15', color: 'var(--color-heat-q2)' },
  { min: 16, max: 31, label: '16–30', color: 'var(--color-heat-q3)' },
  { min: 31, max: 61, label: '31–60', color: 'var(--color-heat-q4)' },
  { min: 61, max: null, label: '61 +', color: 'var(--color-heat-q5)' },
];
