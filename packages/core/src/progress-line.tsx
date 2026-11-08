// Progress line layer (parity row 6, core): the jagged line from the status
// date through each task row's progress point (MS Project / P6 / Bryntum).
// Drawn as an SVG in SVAR's chart area (`.wx-area`, which scrolls with the
// chart), positioned from SVAR's own store — row slots from `_tasks` order ×
// `cellHeight`, dates on SVAR's cell grid (`_scales.diff × cellWidth`, as it
// places bars) — so it lines up at every zoom.
// Spec: docs/superpowers/specs/2026-10-16-progress-line-design.md
import type { TaskId } from '@pyraxi/cpm-engine';
import type { IApi } from '@svar-ui/react-gantt';
import { createPortal } from 'react-dom';
import { cellX, type OverlayState, useSvarOverlay } from './svar-overlay.js';

/**
 * The line's points: for each row, status line at its top → the task's
 * progress point at its middle → status line at its bottom. Rows without a
 * point (summaries, phantom / group rows) stay on the status line.
 */
export function progressLinePoints(
  state: OverlayState,
  points: ReadonlyMap<TaskId, Date>,
  statusDate: Date,
): { statusX: number; height: number; points: [number, number][] } | null {
  const { cellHeight, _scales: s } = state;
  const x = (d: Date) => cellX(state, d, 'nearest');
  const statusX = x(statusDate);
  // A status date off the timeline would sweep the line across every row.
  if (statusX < 0 || (s.width !== undefined && statusX > s.width)) return null;
  const byId = new Map([...points].map(([id, d]) => [String(id), d]));
  const rows = state._tasks ?? [];
  const out: [number, number][] = [];
  rows.forEach((row, i) => {
    const point = byId.get(String(row.id));
    if (!point || point.getTime() === statusDate.getTime()) return;
    const px = x(point);
    const top = i * cellHeight;
    out.push([statusX, top], [px, top + cellHeight / 2], [statusX, top + cellHeight]);
  });
  const height = rows.length * cellHeight;
  return { statusX, height, points: [[statusX, 0], ...out, [statusX, height]] };
}

export function ProgressLineLayer({
  api,
  root,
  points,
  statusDate,
  color,
}: {
  api: IApi | null;
  root: { readonly current: HTMLElement | null };
  points: ReadonlyMap<TaskId, Date>;
  statusDate: Date;
  color?: string;
}) {
  const overlay = useSvarOverlay(api, root);
  if (!overlay) return null;
  const line = progressLinePoints(overlay.state, points, statusDate);
  if (!line) return null;
  const stroke = color ?? 'var(--cg-progress-line-color, #dc2626)';
  return createPortal(
    <svg
      className="construction-gantt-progress-line"
      aria-hidden="true"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: line.height,
        pointerEvents: 'none',
        overflow: 'visible',
        zIndex: 3,
      }}
    >
      <polyline
        points={line.points.map(([px, py]) => `${px},${py}`).join(' ')}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>,
    overlay.area,
  );
}
