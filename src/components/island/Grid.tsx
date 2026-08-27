/**
 * The one SVG grid primitive. All three heatmaps are this component with
 * different cells, a different bin scale and different labels.
 *
 * Design notes that are load-bearing rather than stylistic:
 *
 *  - ONE delegated pointer listener on the <svg>, not 371 (or 168, or 108) per
 *    rect listeners. Preact would otherwise allocate a closure per cell on
 *    every filter change.
 *  - ONE absolutely positioned tooltip div, moved with transform. Creating and
 *    destroying tooltip nodes on hover is what makes heatmaps feel laggy.
 *  - Quantised bins only. A continuous gradient cannot be read off a legend,
 *    so it encodes a number the reader can never recover.
 *  - role="img" + a visually hidden <table>. role="img" deliberately hides the
 *    rects from assistive tech, which is exactly why the table has to exist:
 *    it, not the SVG, is the accessible representation of the data.
 *  - Roving tabindex: one cell in the tab order, arrows move within the grid.
 *    168 tab stops would be a keyboard trap wearing a chart costume.
 */

import { useCallback, useMemo, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';

export interface GridCell {
  /** Column index, 0-based. */
  x: number;
  /** Row index, 0-based. */
  y: number;
  /** Resolved bin index; drives the fill via `binColors`. */
  bin: number;
  /** Full sentence for the tooltip, the <title> and the table cell. */
  label: string;
  /** Short value for the table cell; falls back to `label`. */
  cellText?: string;
  /** Renders the hatch overlay. A different KIND of state, not a hotter one. */
  hatched?: boolean;
  /** Cells outside the data range: drawn as a faint outline, not interactive. */
  blank?: boolean;
  /** Opaque payload handed back to onSelect. */
  key?: string;
}

export interface GridProps {
  cells: GridCell[];
  cols: number;
  rows: number;
  /** CSS colour per bin index, e.g. `var(--color-sev-1)`. */
  binColors: string[];
  cellSize?: number;
  gap?: number;
  radius?: number;
  /** Row headers: also the y-axis tick labels. */
  rowLabels?: string[];
  /** Sparse x-axis ticks: label drawn at column `at`. */
  colTicks?: { at: number; text: string }[];
  /** Column headers for the hidden table. Defaults to colTicks/indexes. */
  tableColLabels?: string[];
  ariaLabel: string;
  tableCaption: string;
  /** Width reserved for the row label gutter. 0 hides it. */
  gutter?: number;
  onSelect?: (cell: GridCell) => void;
  /** Marks a cell as the current selection (drawn with a ring). */
  selectedKey?: string | null;
}

const HATCH_ID = 'igc-hatch';

export default function Grid(props: GridProps): JSX.Element {
  const {
    cells,
    cols,
    rows,
    binColors,
    cellSize = 11,
    gap = 3,
    radius = 2,
    rowLabels,
    colTicks,
    ariaLabel,
    tableCaption,
    gutter = rowLabels ? 30 : 0,
    onSelect,
    selectedKey = null,
  } = props;

  const pitch = cellSize + gap;
  const topPad = colTicks && colTicks.length ? 14 : 0;
  const width = gutter + cols * pitch - gap;
  const height = topPad + rows * pitch - gap;

  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  /** Cell lookup by grid position, so arrow keys can move geometrically. */
  const byPos = useMemo(() => {
    const m = new Map<number, number>();
    cells.forEach((c, i) => m.set(c.y * cols + c.x, i));
    return m;
  }, [cells, cols]);

  /** First interactive cell — where the roving tabindex parks by default. */
  const firstFocusable = useMemo(() => {
    const i = cells.findIndex((c) => !c.blank);
    return i < 0 ? 0 : i;
  }, [cells]);

  const activeFocus = cells[focusIndex] && !cells[focusIndex]!.blank ? focusIndex : firstFocusable;

  /**
   * Focus also lives in a ref, and the ref is the one `move` reads.
   *
   * State alone is not enough: Preact batches, so several arrow keydowns
   * inside one render tick would every one of them compute from the same
   * stale index and collapse into a single step. That is not a theoretical
   * case — holding an arrow key down is how anyone crosses a 365-cell grid,
   * and key-repeat fires far faster than a render.
   */
  const focusRef = useRef(activeFocus);
  focusRef.current = activeFocus;

  const setFocus = useCallback((i: number) => {
    focusRef.current = i;
    setFocusIndex(i);
  }, []);

  const indexFromEvent = (e: JSX.TargetedPointerEvent<SVGSVGElement>): number | null => {
    const t = e.target as Element | null;
    const attr = t?.getAttribute?.('data-i');
    if (attr === null || attr === undefined) return null;
    const i = Number(attr);
    return Number.isFinite(i) ? i : null;
  };

  const onPointerMove = useCallback(
    (e: JSX.TargetedPointerEvent<SVGSVGElement>) => {
      const i = indexFromEvent(e);
      if (i === null || cells[i]?.blank) {
        setHover(null);
        return;
      }
      const wrap = wrapRef.current;
      if (!wrap) return;
      const r = wrap.getBoundingClientRect();
      setHover({ i, x: e.clientX - r.left, y: e.clientY - r.top });
    },
    [cells],
  );

  const onPointerLeave = useCallback(() => setHover(null), []);

  const onClick = useCallback(
    (e: JSX.TargetedMouseEvent<SVGSVGElement>) => {
      const t = e.target as Element | null;
      const attr = t?.getAttribute?.('data-i');
      if (attr === null || attr === undefined) return;
      const cell = cells[Number(attr)];
      if (!cell || cell.blank) return;
      setFocus(Number(attr));
      onSelect?.(cell);
    },
    [cells, onSelect],
  );

  const move = useCallback(
    (dx: number, dy: number) => {
      const cur = cells[focusRef.current];
      if (!cur) return;
      let x = cur.x;
      let y = cur.y;
      // Skip over blanks so arrow keys never park on an out-of-range cell.
      for (let step = 0; step < cols * rows; step++) {
        x += dx;
        y += dy;
        if (x < 0 || x >= cols || y < 0 || y >= rows) return;
        const i = byPos.get(y * cols + x);
        if (i !== undefined && !cells[i]!.blank) {
          setFocus(i);
          const el = wrapRef.current?.querySelector<SVGRectElement>(`[data-i="${i}"]`);
          el?.focus();
          return;
        }
      }
    },
    [byPos, cells, cols, rows, setFocus],
  );

  const onKeyDown = useCallback(
    (e: JSX.TargetedKeyboardEvent<SVGSVGElement>) => {
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          move(1, 0);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          move(-1, 0);
          break;
        case 'ArrowDown':
          e.preventDefault();
          move(0, 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          move(0, -1);
          break;
        case 'Enter':
        case ' ': {
          const cell = cells[focusRef.current];
          if (cell && !cell.blank) {
            e.preventDefault();
            onSelect?.(cell);
          }
          break;
        }
        default:
      }
    },
    [cells, move, onSelect],
  );

  const hovered = hover === null ? null : cells[hover.i];

  return (
    <div ref={wrapRef} class="relative">
      <svg
        role="img"
        aria-label={ariaLabel}
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        style={{ width: '100%', height: 'auto', maxWidth: `${width}px` }}
        class="block overflow-visible touch-manipulation"
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <defs>
          {/* Ongoing incidents. Texture, not another colour: "still happening"
              is a different kind of fact from "how bad was it", and stacking it
              onto the severity ramp would make the ramp mean two things. */}
          <pattern
            id={HATCH_ID}
            width="4"
            height="4"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="4" height="4" fill="transparent" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-ink)" stroke-width="1.6" />
          </pattern>
        </defs>

        {colTicks?.map((t) => (
          <text
            key={`ct-${t.at}-${t.text}`}
            x={gutter + t.at * pitch}
            y={9}
            class="fill-ink-subtle"
            style={{ fontSize: '9px' }}
          >
            {t.text}
          </text>
        ))}

        {rowLabels?.map((label, y) =>
          label ? (
            <text
              key={`rl-${y}`}
              x={gutter - 6}
              y={topPad + y * pitch + cellSize / 2 + 3}
              text-anchor="end"
              class="fill-ink-subtle"
              style={{ fontSize: '9px' }}
            >
              {label}
            </text>
          ) : null,
        )}

        {cells.map((c, i) => {
          const x = gutter + c.x * pitch;
          const y = topPad + c.y * pitch;
          if (c.blank) {
            return (
              <rect
                key={c.key ?? i}
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx={radius}
                fill="none"
                stroke="var(--color-sev-cell-ring)"
                stroke-width="0.5"
                aria-hidden="true"
              />
            );
          }
          const selected = selectedKey != null && c.key === selectedKey;
          return (
            <g key={c.key ?? i}>
              <rect
                data-i={i}
                class="igc-cell cursor-pointer"
                x={x}
                y={y}
                width={cellSize}
                height={cellSize}
                rx={radius}
                fill={binColors[c.bin] ?? binColors[0]}
                stroke="var(--color-sev-cell-ring)"
                stroke-width="0.5"
                /* lowercase: Preact passes unknown props to SVG elements via
                   setAttribute verbatim, and SVG attribute names ARE
                   case-sensitive, so `tabIndex` lands as a dead attribute and
                   the whole grid silently drops out of the tab order. */
                tabindex={i === activeFocus ? 0 : -1}
              >
                <title>{c.label}</title>
              </rect>
              {c.hatched && (
                <rect
                  x={x}
                  y={y}
                  width={cellSize}
                  height={cellSize}
                  rx={radius}
                  fill={`url(#${HATCH_ID})`}
                  opacity="0.55"
                  pointer-events="none"
                />
              )}
              {selected && (
                <rect
                  x={x - 1.5}
                  y={y - 1.5}
                  width={cellSize + 3}
                  height={cellSize + 3}
                  rx={radius + 1}
                  fill="none"
                  stroke="var(--color-focus)"
                  stroke-width="2"
                  pointer-events="none"
                />
              )}
            </g>
          );
        })}
      </svg>

      {hovered && hover && (
        <div
          role="presentation"
          class="pointer-events-none absolute z-20 max-w-64 rounded-md border border-border bg-surface-raised px-2.5 py-1.5 text-xs leading-snug text-ink shadow-lg"
          style={{
            left: 0,
            top: 0,
            transform: `translate3d(${Math.round(hover.x + 12)}px, ${Math.round(hover.y - 8)}px, 0)`,
          }}
        >
          {hovered.label}
        </div>
      )}

      <GridTable
        cells={cells}
        cols={cols}
        rows={rows}
        rowLabels={rowLabels}
        colLabels={props.tableColLabels}
        caption={tableCaption}
      />
    </div>
  );
}

/**
 * The non-visual representation. Not a nicety — with role="img" on the SVG this
 * is the only thing a screen reader can read, and it is also the answer for
 * print, forced-colors and anyone who simply wants the numbers.
 */
function GridTable(p: {
  cells: GridCell[];
  cols: number;
  rows: number;
  rowLabels?: string[];
  colLabels?: string[];
  caption: string;
}): JSX.Element {
  const grid: (GridCell | undefined)[][] = Array.from({ length: p.rows }, () =>
    new Array<GridCell | undefined>(p.cols),
  );
  for (const c of p.cells) {
    if (c.blank) continue;
    const row = grid[c.y];
    if (row) row[c.x] = c;
  }
  return (
    <table class="sr-only">
      <caption>{p.caption}</caption>
      <thead>
        <tr>
          <th scope="col">Row</th>
          {Array.from({ length: p.cols }, (_, x) => (
            <th key={x} scope="col">
              {p.colLabels?.[x] ?? String(x)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {grid.map((row, y) => (
          <tr key={y}>
            <th scope="row">{p.rowLabels?.[y] ?? String(y)}</th>
            {row.map((c, x) => (
              <td key={x}>{c ? (c.cellText ?? c.label) : ''}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
