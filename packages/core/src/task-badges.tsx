// Task badges + previous-start markers: host-supplied indicators on bars,
// drawn in SVAR's chart area from its own bar geometry ($x / $y / $w / $h), so
// they sit on the same bars on every render path and at every zoom. Generic
// extension points (ADR-012): the host gives them meaning (e.g. make-ready
// status, a slipped start whose reason is owed).
import type { Task, TaskId } from '@pyraxi/cpm-engine';
import type { IApi } from '@svar-ui/react-gantt';
import type { CSSProperties, ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { type OverlayState, useSvarOverlay } from './svar-overlay.js';

/** A small labelled indicator on a task's bar. */
export interface TaskBadge {
  /** Identifies the badge to `onTaskBadgeClick`, e.g. `'readiness'`. */
  kind: string;
  /**
   * Visible text or glyph, e.g. `'✓ Ready'`. Required: the meaning never
   * rests on colour alone.
   */
  label: string;
  /** Colour family. Default `'neutral'`. */
  tone?: TaskBadgeTone;
  /** Tooltip and accessible name. Default: `label`. */
  title?: string;
}

export type TaskBadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** A ghost marker at an earlier (or later) start, joined to the bar. */
export interface PreviousStart {
  /**
   * Must be a `Date`. A date before the timeline's start is off the chart (as
   * SVAR's bars are): widen the view with `leadInDays` to show it.
   */
  date: Date;
  /** Draw it as needing attention (amber, with a `?`), e.g. a slip whose reason is owed. */
  pending?: boolean;
  /** Passed to `onTaskBadgeClick` when the marker is clicked. Default `'previous-start'`. */
  kind?: string;
  /** Tooltip and accessible name. Default: "Previous start <date>". */
  title?: string;
}

const TONES: Record<TaskBadgeTone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--cg-badge-neutral-bg, #e2e8f0)', fg: 'var(--cg-badge-neutral-fg, #1e293b)' },
  info: { bg: 'var(--cg-badge-info-bg, #dbeafe)', fg: 'var(--cg-badge-info-fg, #1e3a8a)' },
  success: { bg: 'var(--cg-badge-success-bg, #dcfce7)', fg: 'var(--cg-badge-success-fg, #14532d)' },
  warning: { bg: 'var(--cg-badge-warning-bg, #fef3c7)', fg: 'var(--cg-badge-warning-fg, #78350f)' },
  danger: { bg: 'var(--cg-badge-danger-bg, #fee2e2)', fg: 'var(--cg-badge-danger-fg, #7f1d1d)' },
};

type BarRow = {
  id: TaskId;
  type?: string;
  $x?: number;
  $y?: number;
  $w?: number;
  $h?: number;
  /** SVAR draws no bar for the row (e.g. an unscheduled task), though it lays one out. */
  $skip?: boolean;
};

const GAP = 4;
const BADGE_H = 14;
/** Gap kept between a badge and the bar's midline (a link's arrowhead). */
const LINK_CLEARANCE = 5;
/** Room needed left of a bar for badges before it (else they go after it). */
const BEFORE_MIN = 72;

/** x of a moment exactly as SVAR places a bar's start (no cell snap). */
function svarX(state: OverlayState, d: Date): number {
  const { cellWidth, _scales: s } = state;
  return Math.round(s.diff(d, s.start, s.lengthUnit) * cellWidth);
}

export function TaskBadgesLayer({
  api,
  root,
  tasksById,
  badges,
  previousStart,
  onClick,
}: {
  api: IApi | null;
  root: { readonly current: HTMLElement | null };
  tasksById: ReadonlyMap<string, Task>;
  badges?: (task: Task) => readonly TaskBadge[] | null | undefined;
  previousStart?: (task: Task) => PreviousStart | null | undefined;
  onClick?: (taskId: TaskId, kind: string) => void;
}) {
  // Row-virtualised like SVAR's own bars: only the rendered window, and
  // re-laid-out when it moves.
  const overlay = useSvarOverlay(api, root, { visibleRows: true });
  if (!overlay) return null;
  const { state } = overlay;
  const all = (state._tasks ?? []) as BarRow[];
  const rows = state.area ? all.slice(state.area.start, state.area.end) : all;
  const items: ReactElement[] = [];
  for (const row of rows) {
    // Phantom / group rows carry ids the project doesn't have.
    const task = tasksById.get(String(row.id));
    if (!task || row.$skip || typeof row.$x !== 'number' || typeof row.$y !== 'number') continue;
    // A milestone's box is its diamond's: anchor on the diamond's centre.
    const isMilestone = row.type === 'milestone';
    const x = isMilestone ? row.$x + (row.$h ?? 0) / 2 : row.$x;
    const w = isMilestone ? 0 : (row.$w ?? 0);
    const y = row.$y;
    const h = row.$h ?? state.cellHeight;
    const mid = y + h / 2;
    const prev = previousStart?.(task);
    // JSON-sourced data can hand over a string: skip it rather than throw.
    if (prev && prev.date instanceof Date && !Number.isNaN(prev.date.getTime())) {
      const px = svarX(state, prev.date);
      const left = Math.min(px, x);
      const kind = prev.kind ?? 'previous-start';
      const title = prev.title ?? `Previous start ${prev.date.toLocaleDateString()}`;
      const color = prev.pending
        ? 'var(--cg-previous-start-pending-color, #d97706)'
        : 'var(--cg-previous-start-color, #64748b)';
      items.push(
        <div
          key={`prev:${String(row.id)}`}
          className="construction-gantt-previous-start"
          data-task-id={String(row.id)}
          data-pending={String(!!prev.pending)}
          style={{
            position: 'absolute',
            left,
            top: mid - 1,
            width: Math.abs(x - px),
            height: 0,
            borderTop: `2px dashed ${color}`,
            pointerEvents: 'none',
          }}
        />,
        <button
          key={`prev-tick:${String(row.id)}`}
          type="button"
          className="construction-gantt-previous-start-marker"
          data-task-id={String(row.id)}
          data-kind={kind}
          data-pending={String(!!prev.pending)}
          title={title}
          aria-label={`${task.text}: ${title}${prev.pending ? ' (needs attention)' : ''}`}
          // The layer is portalled beside SVAR's bars, so clicks never reach
          // its select / drag handlers; document listeners (outside-click
          // closers) still see them.
          onClick={() => onClick?.(task.id, kind)}
          style={markerStyle(px, y, h, color, !!onClick)}
        >
          {prev.pending ? '?' : ''}
        </button>,
      );
    }
    const list = badges?.(task);
    if (list && list.length > 0) {
      items.push(
        <div
          key={`badges:${String(row.id)}`}
          className="construction-gantt-badges"
          data-task-id={String(row.id)}
          style={{
            position: 'absolute',
            // Just left of the bar, right-aligned to its start; after its end
            // when the bar starts too near the timeline's left edge.
            ...(x >= BEFORE_MIN ? { right: `calc(100% - ${x - GAP}px)` } : { left: x + w + GAP }),
            // Above the bar's midline, where links enter and leave it.
            top: mid - LINK_CLEARANCE - BADGE_H,
            height: BADGE_H,
            display: 'flex',
            alignItems: 'center',
            gap: 2,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          {list.map((b, i) => {
            const tone = TONES[b.tone ?? 'neutral'] ?? TONES.neutral;
            const title = b.title ?? b.label;
            return (
              <button
                // biome-ignore lint/suspicious/noArrayIndexKey: a host may repeat a kind; order is the identity
                key={`${b.kind}:${i}`}
                type="button"
                className="construction-gantt-badge"
                data-kind={b.kind}
                data-tone={b.tone ?? 'neutral'}
                title={title}
                aria-label={`${task.text}: ${title}`}
                onClick={() => onClick?.(task.id, b.kind)}
                style={badgeStyle(tone, !!onClick)}
              >
                {b.label}
              </button>
            );
          })}
        </div>,
      );
    }
  }
  if (items.length === 0) return null;
  return createPortal(
    <div
      className="construction-gantt-badges-layer"
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: '100%',
        height: all.length * state.cellHeight,
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      {items}
    </div>,
    overlay.area,
  );
}

function badgeStyle(tone: { bg: string; fg: string }, clickable: boolean): CSSProperties {
  return {
    pointerEvents: 'auto',
    cursor: clickable ? 'pointer' : 'default',
    border: 'none',
    borderRadius: 8,
    padding: '0 5px',
    height: BADGE_H,
    lineHeight: `${BADGE_H}px`,
    fontSize: 10,
    fontWeight: 600,
    fontFamily: 'inherit',
    background: tone.bg,
    color: tone.fg,
  };
}

function markerStyle(
  px: number,
  y: number,
  h: number,
  color: string,
  clickable: boolean,
): CSSProperties {
  const size = Math.max(10, Math.min(14, h - 8));
  return {
    pointerEvents: 'auto',
    cursor: clickable ? 'pointer' : 'default',
    position: 'absolute',
    left: px - size / 2,
    top: y + (h - size) / 2,
    width: size,
    height: size,
    padding: 0,
    border: `2px solid ${color}`,
    borderRadius: 2,
    background: 'var(--wx-background, #fff)',
    color,
    fontSize: size - 4,
    lineHeight: `${size - 4}px`,
    fontWeight: 700,
    fontFamily: 'inherit',
    textAlign: 'center',
  };
}
