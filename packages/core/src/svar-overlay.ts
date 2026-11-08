// Overlays drawn in SVAR's chart area (`.wx-area`, which scrolls with the chart),
// positioned from SVAR's own store so they line up with its bars at every zoom.
// Used by the progress line and the markers (SVAR's free store forces its own
// `markers` / `baselines` off).
import type { TaskId } from '@pyraxi/cpm-engine';
import type { IApi } from '@svar-ui/react-gantt';
import { useEffect, useReducer, useState } from 'react';
import type { SvarScaleState } from './svar-adapter.js';

// lib-state's d.ts declares `subscribe(fn): void`, but the runtime returns an
// unsubscribe (verified); typed here as it behaves.
interface Store {
  subscribe(fn: () => void): () => void;
}

/** The slice of SVAR's store an overlay lays out from. */
export type OverlayState = SvarScaleState & {
  cellHeight: number;
  /** The rows SVAR renders: `_tasks.slice(start, end)` (its row virtualisation). */
  area?: { start: number; end: number };
  _tasks?: { id: TaskId }[];
  _scales: SvarScaleState['_scales'] & { width?: number };
};

/**
 * SVAR's chart area and live layout state, re-rendering when SVAR re-lays out
 * its rows or scale (zoom, edits) — but not on drag frames: SVAR re-publishes
 * the SAME `_tasks` array on every mousemove (re-walking 5k rows there cost
 * ~60 ms a frame). Null until SVAR has mounted.
 */
export function useSvarOverlay(
  api: IApi | null,
  root: { readonly current: HTMLElement | null },
  /** Also re-render when SVAR's rendered row window moves (vertical scroll). */
  opts?: { visibleRows?: boolean },
): { area: Element; state: OverlayState } | null {
  const visibleRows = opts?.visibleRows ?? false;
  const [, refresh] = useReducer((n: number) => n + 1, 0);
  const [area, setArea] = useState<Element | null>(null);
  useEffect(() => {
    if (!api) return;
    const rs = api.getReactiveState() as unknown as { _tasks: Store; _scales: Store; area?: Store };
    let seen: unknown[] = [];
    const onChange = () => {
      const st = api.getState() as unknown as OverlayState;
      const now = [st._tasks, st._scales, st.cellWidth, st.cellHeight];
      if (visibleRows) now.push(st.area?.start, st.area?.end);
      if (now.every((v, i) => v === seen[i])) return;
      seen = now;
      refresh();
    };
    const offTasks = rs._tasks.subscribe(onChange);
    const offScales = rs._scales.subscribe(onChange);
    const offArea = visibleRows && rs.area ? rs.area.subscribe(onChange) : undefined;
    return () => {
      offTasks();
      offScales();
      offArea?.();
    };
  }, [api, visibleRows]);
  useEffect(() => {
    const found = root.current?.querySelector('.wx-area') ?? null;
    if (found !== area) setArea(found);
  });
  if (!api || !area) return null;
  return { area, state: api.getState() as unknown as OverlayState };
}

/**
 * x of `d` on SVAR's cell grid. SVAR snaps bars to whole cells, so a moment is
 * placed at a cell edge: `'start'` — its cell's start (a marker on a date);
 * `'nearest'` — the nearer edge (a progress point: 1 day done, Mon 17:00, is
 * Monday's right edge, where the bar's fill ends). The snap is done to a
 * boundary moment rather than via `diff`'s ceil flag, which SVAR drops across
 * month cells.
 */
export function cellX(state: OverlayState, d: Date, snap: 'start' | 'nearest'): number {
  const { cellWidth, _scales: s } = state;
  const edge = cellEdge(
    d,
    s.lengthUnit,
    snap === 'nearest' && fractionOfCell(d, s.lengthUnit) >= 0.5,
  );
  return Math.round(s.diff(edge, s.start, s.lengthUnit) * cellWidth);
}

/** The start of `d`'s cell, or of the next cell. Units other than hour / day: `d` itself. */
function cellEdge(d: Date, unit: string, next: boolean): Date {
  const n = next ? 1 : 0;
  if (unit === 'hour')
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + n);
  if (unit !== 'day') return d;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** How far `d` is into its `unit` cell (0 at the cell's start). */
function fractionOfCell(d: Date, unit: string): number {
  if (unit === 'hour') return (d.getMinutes() * 60 + d.getSeconds()) / 3600;
  if (unit !== 'day') return 0;
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  return (d.getTime() - midnight.getTime()) / (next.getTime() - midnight.getTime());
}
