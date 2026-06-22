// Project → SVAR ITask adapter.
//
// Extracted from Gantt.tsx so the conversion is unit-testable without
// mounting a full <Gantt> component (happy-dom + SVAR canvas = unreliable;
// per test-strategy memory reference_test_strategy_svar_happy_dom).
//
// ADR-002: SVAR types (ITask) stay here and in Gantt.tsx only — they must
// not appear in GanttProps or in exported public types.

import type { ITask, IZoomConfig } from '@svar-ui/react-gantt';

// ---------------------------------------------------------------------------
// Internal SVAR shape aliases (not exported — stay in this file per ADR-002)
// Inline minimal types so we avoid direct imports from @svar-ui/react-toolbar
// and @svar-ui/react-menu (which are transitively installed but not in our
// package.json dependencies, making tsc unhappy).
// ---------------------------------------------------------------------------

type SvarToolbarItemInternal = {
  id?: string | number;
  text?: string;
  icon?: string;
  handler?: (item: SvarToolbarItemInternal, value?: unknown) => void;
  [key: string]: unknown;
};

type SvarMenuOptionInternal = {
  id?: string | number;
  text?: string;
  icon?: string;
  data?: SvarMenuOptionInternal[];
  handler?: (ev: { option: SvarMenuOptionInternal }) => void;
  [key: string]: unknown;
};

import type {
  Baseline,
  BaselineIndex,
  Calendar,
  GanttContextMenuConfig,
  GanttContextMenuItem,
  GanttEditorConfig,
  GanttEditorField,
  GanttToolbarConfig,
  GanttToolbarItem,
  GanttZoomConfig,
  GanttZoomLevel,
  Project,
  Task,
  TaskId,
} from '@pyraxi/cpm-engine';
import { getTaskBaselineVariance } from '@pyraxi/cpm-engine';
import type { TaskEditPatch } from './editing/useEditState.js';

// ---------------------------------------------------------------------------
// Extended SVAR task type (internal to the adapter + Gantt.tsx)
// ---------------------------------------------------------------------------

export interface SvarTaskWithComputed extends ITask {
  is_critical?: boolean;
  is_late?: boolean;
  total_slack?: number;
  /** Working-minutes by which start has slipped against the baseline. */
  start_variance?: number;
  /** True if startVariance >= 30 working minutes (drifted later than plan). */
  is_slipped?: boolean;
  /** True if startVariance <= -30 working minutes (ahead of plan). */
  is_ahead?: boolean;
  /** Indicative deadline date (NZS 3910), if any. */
  deadline?: Date;
  /** True when the computed finish slips past the deadline. */
  deadline_missed?: boolean;
  /** Signed working-minutes from finish to deadline (negative = overrun). */
  deadline_slack?: number;
  /** True for phantom rows representing a baseline snapshot's position. */
  is_baseline_ghost?: boolean;
  /** When set, identifies which baseline (0..10) this phantom row mirrors. */
  baseline_index?: BaselineIndex;
  /** True for phantom rows representing a live recalc preview position. */
  is_edit_preview?: boolean;
}

// ---------------------------------------------------------------------------
// Native SVAR interaction bridge
// ---------------------------------------------------------------------------

/**
 * Translate SVAR's native `update-task` payload delta (bar drag/resize, or an
 * Editor-modal field change) into our `TaskEditPatch`, so the same edit pipeline
 * inline-cell editing uses also captures SVAR-native interactions.
 *
 * A timing change (start/end) pins the task to `manual` — MS Project semantics:
 * dragging a bar fixes its dates, and auto successors cascade off the new finish.
 * Non-timing fields (text/progress) pass through untouched. SVAR's `duration` is
 * in working-DAYS (our model is working-minutes) and is redundant with start/end
 * for drags/resizes, so it is intentionally dropped — the engine re-derives
 * working-minutes duration from the pinned dates.
 */
export function svarUpdateToPatch(delta: Partial<ITask>): TaskEditPatch {
  const patch: TaskEditPatch = {};
  if (delta.start instanceof Date) patch.start = delta.start;
  if (delta.end instanceof Date) patch.end = delta.end;
  if (typeof delta.text === 'string') patch.text = delta.text;
  if (typeof delta.progress === 'number') patch.progress = delta.progress;
  if (patch.start !== undefined || patch.end !== undefined) patch.scheduleMode = 'manual';
  return patch;
}

// ---------------------------------------------------------------------------
// Zoom config conversion (Task 3.2)
// ---------------------------------------------------------------------------

// Cell-width ranges and scale rows for each named zoom level.
// The `minCellWidth`/`maxCellWidth` band sizes control at which zoom step
// SVAR switches levels; ranges chosen for typical construction monitor widths.
type ZoomLevelConfig = {
  minCellWidth: number;
  maxCellWidth: number;
  headerUnit: string;
  headerFormat: string;
  rowUnit: string;
  rowFormat: string;
};

// Each scale MUST carry a `format` — SVAR's scale formatter calls
// String.prototype.replace on it, so an undefined format crashes the renderer
// (a consumer-reported zoom-crash bug). Format tokens mirror SVAR's own defaults
// (`%F %Y`, `%j`, …) so the labels render exactly like the base component.
const ZOOM_LEVEL_CONFIGS: Record<string, ZoomLevelConfig> = {
  // F4 fix: hour and day have distinct bands to prevent scroll-wheel oscillation.
  // hour sits below day so zooming out from hour transitions to day, not back to hour.
  hour: {
    minCellWidth: 5,
    maxCellWidth: 19,
    headerUnit: 'day',
    headerFormat: '%M %j',
    rowUnit: 'hour',
    rowFormat: '%H:%i',
  },
  day: {
    minCellWidth: 20,
    maxCellWidth: 59,
    headerUnit: 'month',
    headerFormat: '%F %Y',
    rowUnit: 'day',
    rowFormat: '%j',
  },
  week: {
    minCellWidth: 60,
    maxCellWidth: 119,
    headerUnit: 'month',
    headerFormat: '%F %Y',
    rowUnit: 'week',
    rowFormat: '%M %j',
  },
  month: {
    minCellWidth: 120,
    maxCellWidth: 239,
    headerUnit: 'year',
    headerFormat: '%Y',
    rowUnit: 'month',
    rowFormat: '%M',
  },
  quarter: {
    minCellWidth: 240,
    maxCellWidth: 479,
    headerUnit: 'year',
    headerFormat: '%Y',
    rowUnit: 'quarter',
    rowFormat: '%M',
  },
};

// Fallback used when an unknown level name is passed.
const ZOOM_FALLBACK = ZOOM_LEVEL_CONFIGS.week as ZoomLevelConfig;

/**
 * Convert a Pyraxi GanttZoomConfig (agnostic named levels) to
 * SVAR's IZoomConfig (cell-width-range mechanism). ADR-002: SVAR types stay here.
 */
export function toSvarZoom(config: GanttZoomConfig): IZoomConfig {
  const levels =
    config.levels && config.levels.length > 0 ? config.levels : ['day', 'week', 'month'];
  const defaultLevel = config.default ?? levels[0] ?? 'day';
  return {
    level: Math.max(0, levels.indexOf(defaultLevel as GanttZoomLevel)),
    levels: levels.map((name) => {
      const cfg = ZOOM_LEVEL_CONFIGS[name as string] ?? ZOOM_FALLBACK;
      return {
        minCellWidth: cfg.minCellWidth,
        maxCellWidth: cfg.maxCellWidth,
        scales: [
          { unit: cfg.headerUnit, step: 1, format: cfg.headerFormat },
          { unit: cfg.rowUnit, step: 1, format: cfg.rowFormat },
        ],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Toolbar config conversion (Task 3.6)
// ---------------------------------------------------------------------------

/**
 * Convert a GanttToolbarConfig to an array of SVAR toolbar item objects.
 * Returns undefined when no custom items are set (caller passes SVAR defaults).
 * ADR-002: SVAR shape stays here and in Gantt.tsx only.
 */
export function toSvarToolbar(config: GanttToolbarConfig): SvarToolbarItemInternal[] | undefined {
  if (!config.items || config.items.length === 0) return undefined;
  return config.items.map(toolbarItemToSvar);
}

function toolbarItemToSvar(item: GanttToolbarItem): SvarToolbarItemInternal {
  const svar: SvarToolbarItemInternal = {};
  if (item.id !== undefined) svar.id = item.id;
  if (item.text !== undefined) svar.text = item.text;
  if (item.icon !== undefined) svar.icon = item.icon;
  if (item.onClick) {
    const onClick = item.onClick;
    svar.handler = (svarItem: SvarToolbarItemInternal) =>
      onClick(svarItemToGanttToolbarItem(svarItem));
  }
  return svar;
}

function svarItemToGanttToolbarItem(item: SvarToolbarItemInternal): GanttToolbarItem {
  return {
    id: item.id !== undefined ? String(item.id) : undefined,
    text: item.text as string | undefined,
    icon: item.icon as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Context menu config conversion (Task 3.5)
// ---------------------------------------------------------------------------

/**
 * Convert a GanttContextMenuConfig to SVAR menu option objects.
 * Returns undefined when no custom items are set (caller passes SVAR defaults).
 * ADR-002: SVAR shape stays here and in Gantt.tsx only.
 */
export function toSvarContextMenu(
  config: GanttContextMenuConfig,
): SvarMenuOptionInternal[] | undefined {
  if (!config.items || config.items.length === 0) return undefined;
  return config.items.map(contextMenuItemToSvar);
}

function contextMenuItemToSvar(item: GanttContextMenuItem): SvarMenuOptionInternal {
  const svar: SvarMenuOptionInternal = {};
  if (item.id !== undefined) svar.id = item.id;
  if (item.text !== undefined) svar.text = item.text;
  if (item.icon !== undefined) svar.icon = item.icon;
  if (item.separator) {
    // SVAR uses type: 'separator' for separator items in its menu options.
    svar.type = 'separator';
  }
  if (item.items && item.items.length > 0) {
    svar.data = item.items.map(contextMenuItemToSvar);
  }
  if (item.onClick) {
    const onClick = item.onClick;
    svar.handler = (ev: { option: SvarMenuOptionInternal }) => {
      onClick(svarMenuOptionToGanttItem(ev.option));
    };
  }
  return svar;
}

function svarMenuOptionToGanttItem(option: SvarMenuOptionInternal): GanttContextMenuItem {
  return {
    id: option.id !== undefined ? String(option.id) : undefined,
    text: option.text as string | undefined,
    icon: option.icon as string | undefined,
  };
}

// ---------------------------------------------------------------------------
// Editor config conversion (Task 3.4)
// ---------------------------------------------------------------------------

// SVAR's Editor items type (internal inline shape from react-editor types)
type SvarEditorItem = {
  comp?: string;
  key?: string;
  label?: string;
  required?: boolean;
  [key: string]: unknown;
};

/**
 * Convert a GanttEditorConfig to SVAR Editor items array.
 * Returns undefined when no custom fields are set (caller passes SVAR defaults).
 * ADR-002: SVAR's editor item shape stays here and in Gantt.tsx only.
 */
export function toSvarEditorItems(config: GanttEditorConfig): SvarEditorItem[] | undefined {
  if (!config.fields || config.fields.length === 0) return undefined;
  return config.fields.map(editorFieldToSvar);
}

function editorFieldToSvar(field: GanttEditorField): SvarEditorItem {
  const item: SvarEditorItem = { key: field.key };
  if (field.label !== undefined) item.label = field.label;
  if (field.comp !== undefined) item.comp = field.comp;
  if (field.required !== undefined) item.required = field.required;
  return item;
}

// ---------------------------------------------------------------------------
// Feature-flag helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the project has at least one task with `unscheduled: true`.
 * Used to set `unscheduledTasks: true` on the SVAR <Gantt> config.
 */
export function projectHasUnscheduledTasks(tasks: Task[]): boolean {
  return tasks.some((t) => t.unscheduled === true);
}

/**
 * Returns true when the project has at least one MANUAL-mode task with a
 * non-empty `segments` array. Used to set `splitTasks: true` on the SVAR
 * <Gantt> config. F6 fix: auto-mode tasks may carry stale segments that are
 * suppressed by toSvarTask; counting them here would enable SVAR's split mode
 * for projects with no visible split bars.
 */
export function projectHasSplitTasks(tasks: Task[]): boolean {
  return tasks.some(
    (t) => t.scheduleMode === 'manual' && t.segments !== undefined && t.segments.length > 0,
  );
}

// ---------------------------------------------------------------------------
// Core task conversion
// ---------------------------------------------------------------------------

/**
 * Convert a single internal Task to SVAR's ITask shape.
 *
 * Behavior-preserving extraction from the original inline code in Gantt.tsx.
 * Added in this pass: mapping of `task.unscheduled` and `task.segments` per
 * ADR-007 and the spike finding (svar-chrome-spike.md §7–8).
 */
/**
 * Working-minutes in a standard working day for `calendar` — the sum of the
 * first non-empty day's intervals. Used to display task duration in DAYS (what
 * SVAR's grid expects and what a PM reads) rather than our internal
 * working-minutes. Falls back to 480 (8h) if the calendar has no working day.
 */
function workingMinutesPerDay(calendar: Calendar): number {
  for (const day of calendar.workWeek) {
    if (day && day.length > 0) {
      const mins = day.reduce((sum, iv) => sum + (iv.endMinutes - iv.startMinutes), 0);
      if (mins > 0) return mins;
    }
  }
  return 480;
}

/**
 * Build the engine-signal stylesheet for the native (template-less) bar path.
 *
 * SVAR renders clean native Willow bars and tags each with `data-id=":<id>"`
 * (its `setID` convention — the same selector SVAR uses internally). Rather than
 * replace the bar with a custom template, we recolour our engine's critical path
 * and outline deadline overruns by overriding SVAR's own theme tokens on those
 * bars. The bar's two-tone (lighter track + darker progress fill) is preserved
 * because the tokens drive those inner elements.
 *
 * `scopeClass` confines the rules to one Gantt instance. Returns null when
 * there's nothing to style.
 */
export function buildSignalCss(tasks: Task[], scopeClass: string): string | null {
  const rules: string[] = [];
  for (const t of tasks) {
    // SVAR's `setID` prefixes string ids with ':' (data-id=":site") but leaves
    // numeric ids bare (data-id="5"). Target both so critical/deadline styling
    // works regardless of the consumer's TaskId type.
    const sel =
      `.${scopeClass} .wx-bar[data-id=":${t.id}"],` +
      `.${scopeClass} .wx-bar[data-id="${t.id}"]`;
    if (t.computed?.isCritical) {
      rules.push(
        t.type === 'summary'
          ? `${sel}{--wx-gantt-summary-fill-color:#c32b64;--wx-gantt-summary-color:#d9306f;}`
          : `${sel}{--wx-gantt-task-fill-color:#de3a3a;--wx-gantt-task-color:#f3a9a9;}`,
      );
    }
    if (t.computed?.deadlineMissed) {
      rules.push(`${sel}{outline:2px solid #dc2626;outline-offset:1px;}`);
    }
  }
  return rules.length > 0 ? rules.join('\n') : null;
}

export function toSvarTask(
  t: Task,
  baseline: Baseline | undefined,
  calendar: Calendar | undefined,
): SvarTaskWithComputed {
  const variance =
    baseline && calendar ? getTaskBaselineVariance(t, baseline, calendar) : undefined;
  const startVariance = variance?.startVariance ?? 0;

  const base: SvarTaskWithComputed = {
    id: t.id,
    text: t.text,
    start: t.start,
    end: t.end,
    // Display duration in working days (SVAR's grid unit), not our internal
    // working-minutes. Only convert when a calendar is supplied (the real
    // render path); the test-only undefined-calendar path keeps raw minutes.
    duration: calendar ? Math.round(t.duration / workingMinutesPerDay(calendar)) : t.duration,
    progress: t.progress,
    type: t.type,
    parent: t.parent,
    is_critical: t.computed?.isCritical ?? false,
    is_late: (t.computed?.totalSlack ?? 0) < 0,
    total_slack: t.computed?.totalSlack ?? 0,
    start_variance: startVariance,
    is_slipped: startVariance >= 30,
    is_ahead: startVariance <= -30,
    deadline: t.deadline,
    deadline_missed: t.computed?.deadlineMissed ?? false,
    deadline_slack: t.computed?.deadlineSlackMinutes ?? 0,
  };

  // `open` only meaningful on summary tasks. Setting it on leaves trips
  // SVAR's child-iteration path (null forEach).
  if (t.type === 'summary') base.open = t.open ?? true;

  // ADR-007: unscheduled tasks — pass the flag so SVAR renders grid-only.
  if (t.unscheduled) {
    base.unscheduled = true;
  }

  // ADR-007: split tasks — map our TaskSegment[] to SVAR's Partial<ITask>[].
  // F6 fix: only emit segments for manual-mode tasks. Auto-mode tasks may carry
  // stale segments from a previous manual-mode edit; they must not render as split
  // bars after CPM has computed fresh dates. Per ADR-007, splits are manual-only.
  if (t.scheduleMode === 'manual' && t.segments && t.segments.length > 0) {
    base.segments = t.segments.map((seg) => ({ start: seg.start, end: seg.end }));
  }

  return base;
}

// ---------------------------------------------------------------------------
// Full project → SVAR ITask[] conversion (with baseline ghost + edit preview)
// ---------------------------------------------------------------------------

/**
 * Convert the rendered tasks + resolved baselines into the SVAR ITask[]
 * shape, including phantom ghost rows for each (task × baseline) pair
 * when ghost bars are enabled.
 *
 * In single-baseline mode (resolvedBaselines.length === 1), the live row
 * carries the variance pill. In multi-baseline mode the live row gets no
 * variance fields; each phantom row gets its own.
 *
 * Exported for testing. Not part of the public surface.
 */
export function buildSvarTasks(
  renderableTasks: Task[],
  resolvedBaselines: Baseline[],
  calendar: Calendar | undefined,
  ghostBarsEnabled: boolean,
  editGhostProject?: Project,
): SvarTaskWithComputed[] {
  const ghostById = new Map<TaskId, Task>(editGhostProject?.tasks.map((t) => [t.id, t]) ?? []);

  if (!ghostBarsEnabled || resolvedBaselines.length === 0) {
    const primary = resolvedBaselines[0];
    const out = renderableTasks.map((t) => toSvarTask(t, primary, calendar));
    if (ghostById.size > 0) {
      for (const t of renderableTasks) {
        if (t.type === 'summary') continue;
        if (t.unscheduled) continue; // F8: unscheduled tasks have no primary bar → no ghost
        const ghost = ghostById.get(t.id);
        if (
          ghost &&
          (ghost.start.getTime() !== t.start.getTime() || ghost.end.getTime() !== t.end.getTime())
        ) {
          out.push(makeEditPreviewPhantom(t, ghost));
        }
      }
    }
    return out;
  }
  const out: SvarTaskWithComputed[] = [];
  for (const t of renderableTasks) {
    const liveBarBaseline = resolvedBaselines.length === 1 ? resolvedBaselines[0] : undefined;
    out.push(toSvarTask(t, liveBarBaseline, calendar));
    if (t.type === 'summary') continue;
    if (t.unscheduled) continue; // F8: unscheduled tasks have no primary bar → no phantoms
    for (const b of resolvedBaselines) {
      const phantom = makeBaselinePhantom(t, b, calendar);
      if (phantom) out.push(phantom);
    }
    // Edit preview phantom goes last (renders below baseline phantoms).
    const ghost = ghostById.get(t.id);
    if (
      ghost &&
      (ghost.start.getTime() !== t.start.getTime() || ghost.end.getTime() !== t.end.getTime())
    ) {
      out.push(makeEditPreviewPhantom(t, ghost));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phantom row helpers
// ---------------------------------------------------------------------------

export function makeBaselinePhantom(
  t: Task,
  baseline: Baseline,
  calendar: Calendar | undefined,
): SvarTaskWithComputed | null {
  const snap = baseline.tasks.get(t.id);
  if (!snap) return null;
  const variance = calendar ? getTaskBaselineVariance(t, baseline, calendar) : undefined;
  const startVariance = variance?.startVariance ?? 0;
  return {
    id: `${t.id}__baseline_${baseline.index}`,
    text: formatBaselineLabel(baseline),
    start: snap.start,
    end: snap.end,
    duration: snap.duration,
    progress: 0,
    type: 'task',
    parent: t.parent,
    is_baseline_ghost: true,
    baseline_index: baseline.index,
    start_variance: startVariance,
    is_slipped: startVariance >= 30,
    is_ahead: startVariance <= -30,
  };
}

export function makeEditPreviewPhantom(liveTask: Task, ghostTask: Task): SvarTaskWithComputed {
  return {
    id: `${liveTask.id}__edit_preview`,
    text: 'Preview',
    start: ghostTask.start,
    end: ghostTask.end,
    duration: ghostTask.duration,
    progress: 0,
    type: 'task',
    parent: liveTask.parent,
    is_baseline_ghost: true,
    is_edit_preview: true,
  };
}

// ---------------------------------------------------------------------------
// Label helpers (moved from Gantt.tsx; still exported from there for tests)
// ---------------------------------------------------------------------------

/**
 * Format a baseline's metadata for display in the phantom row's label.
 * Returns "${name ?? `Baseline ${index}`} — captured ${formatShortDate(capturedAt)}".
 */
export function formatBaselineLabel(baseline: Baseline): string {
  const name = baseline.name ?? `Baseline ${baseline.index}`;
  return `${name} — captured ${formatShortDate(baseline.capturedAt)}`;
}

/**
 * Format a Date as YYYY-MM-DD using local-time components.
 */
export function formatShortDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
