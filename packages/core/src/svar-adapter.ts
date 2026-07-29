// Project → SVAR ITask adapter.
//
// Extracted from Gantt.tsx so the conversion is unit-testable without
// mounting a full <Gantt> component (happy-dom + SVAR canvas = unreliable;
// per test-strategy memory reference_test_strategy_svar_happy_dom).
//
// ADR-002: SVAR types (ITask) stay here and in Gantt.tsx only — they must
// not appear in GanttProps or in exported public types.

import { defaultToolbarButtons } from '@svar-ui/gantt-store';
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
  TaskType,
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
  /** Same-row baseline underlay geometry (baselineRender='inline'); % of the live bar box. */
  baseline_inline?: { leftPct: number; widthPct: number };
  /** Consumer carry-through bag (`Task.extra`), threaded so the hover tooltip can
   *  read host-app fields the engine doesn't model (e.g. assignee, trade). */
  extra?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Native SVAR interaction bridge
// ---------------------------------------------------------------------------

/**
 * Normalized descriptor for structural mutations that the bridge (Task 8)
 * turns into callbacks. Discriminated union of the four event types SVAR
 * emits: delete-task, add-task, move-task, indent-task.
 */
export type StructuralEdit =
  | { kind: 'delete'; id: TaskId }
  // Carries SVAR's raw add-task shape (`target` + `before/after/child` mode).
  // Resolving `before`/`after` needs the target's parent from the live project,
  // so — like `reorder` — the classifier stays pure and `buildStructuralCommit`
  // (or `resolveAddPosition`) does the project-aware placement.
  | { kind: 'add'; task: Partial<ITask>; target?: TaskId; mode?: 'before' | 'after' | 'child' }
  | { kind: 'move'; id: TaskId; direction: 'up' | 'down' }
  | { kind: 'indent'; id: TaskId; direction: 'indent' | 'outdent' }
  // Row drag-and-drop reorder (distinct from the toolbar/menu up/down `move`).
  // Carries the raw SVAR drop info; the `{parent,index}` resolution needs the
  // live project and happens in `buildStructuralCommit`, keeping this classifier
  // pure. `mode: 'child'` drops onto a row as its child; `before`/`after` drop
  // relative to `target` within its sibling group.
  | { kind: 'reorder'; id: TaskId; target: TaskId; mode: 'before' | 'after' | 'child' };

/**
 * Translate SVAR's native structural mutation events (delete-task, add-task,
 * move-task, indent-task) into a normalized StructuralEdit descriptor.
 *
 * Returns the appropriate discriminated union variant, or null for unknown events.
 * - delete-task: { id } → { kind: 'delete'; id }
 * - add-task: { task, target, mode } → { kind: 'add'; task; target?; mode? }
 *   (raw `target`+`mode` preserved; SVAR's own reducer resolves `child` as a
 *   nested append and `before`/`after` as a sibling insert around `target`)
 * - move-task: { id, mode: 'up'|'down' } → { kind: 'move'; id; direction }.
 *   SVAR also fires `move-task` for row drag-and-drop reordering, with a
 *   DIFFERENT shape: { id, mode: 'before'|'after', target, inProgress }. That
 *   shape is NOT a toolbar/menu reorder and must not be bridged as one — it
 *   classifies to null here so the caller lets SVAR handle its own native
 *   drag (bridging drag-reorder is a documented follow-up, not done here).
 * - indent-task: { id, mode: boolean } → { kind: 'indent'; id; direction }
 *   (mode: true → 'indent'; mode: false → 'outdent')
 */
export function classifyStructuralEvent(
  name: string,
  ev: Record<string, unknown>,
): StructuralEdit | null {
  switch (name) {
    case 'delete-task':
      return { kind: 'delete', id: ev.id as TaskId };
    case 'move-task': {
      // Toolbar/menu "Move up"/"Move down": mode is 'up'|'down'.
      if (ev.mode === 'up' || ev.mode === 'down') {
        return { kind: 'move', id: ev.id as TaskId, direction: ev.mode };
      }
      // Row drag-and-drop reorder: mode is 'before'|'after'|'child' with an
      // `inProgress` flag. Bridge only on drag-END (inProgress === false) — while
      // dragging, SVAR animates natively and we must not round-trip per frame.
      if (
        (ev.mode === 'before' || ev.mode === 'after' || ev.mode === 'child') &&
        ev.inProgress === false
      ) {
        return { kind: 'reorder', id: ev.id as TaskId, target: ev.target as TaskId, mode: ev.mode };
      }
      return null;
    }
    case 'indent-task':
      return {
        kind: 'indent',
        id: ev.id as TaskId,
        direction: ev.mode ? 'indent' : 'outdent',
      };
    case 'add-task':
      return {
        kind: 'add',
        task: ev.task as Partial<ITask>,
        target: ev.target as TaskId | undefined,
        // SVAR's grid `+` always sends 'child'; the context menu sends
        // before/after/child. Default an absent mode to 'child' (grid behavior).
        mode: (ev.mode as 'before' | 'after' | 'child' | undefined) ?? 'child',
      };
    default:
      return null;
  }
}

/**
 * Decide how a SVAR `show-editor` event routes when `onTaskEditRequest` is wired.
 * SVAR's built-in "Edit" context-menu item and a task double-click both dispatch
 * `show-editor` (`{ id }`); `{ id: null }` is its close-editor/escape path.
 *
 * Returns the task id to hand the consumer (caller then vetoes SVAR's built-in
 * Editor modal and opens the consumer's own editor), or `null` to let SVAR
 * handle it natively — when no handler is wired, or on the close path.
 */
export function resolveEditRequest(ev: { id?: TaskId | null }, hasHandler: boolean): TaskId | null {
  if (!hasHandler) return null;
  return ev.id ?? null;
}

const STRUCTURAL_TASK_TYPES: readonly TaskType[] = ['task', 'summary', 'milestone'];

/**
 * Map a SVAR add-task partial (`Partial<ITask>`) to a full engine `Task`,
 * supplying engine defaults SVAR doesn't carry: `scheduleMode: 'auto'`,
 * `duration: 480` (1 working day min; the engine re-derives auto-task bounds
 * from dates/predecessors), and `start`/`end` falling back to `projectStart`.
 * Shared by the `onTaskAdd` consumer wiring and `buildStructuralCommit`'s add
 * path so both construct identical tasks.
 */
export function svarPartialToTask(partial: Partial<ITask>, projectStart: Date): Task {
  const type = STRUCTURAL_TASK_TYPES.includes(partial.type as TaskType)
    ? (partial.type as TaskType)
    : 'task';
  return {
    id: (partial.id as TaskId) ?? `t-${Date.now()}`,
    text: (partial.text as string) ?? 'New task',
    type,
    scheduleMode: 'auto',
    duration: 480,
    start: partial.start instanceof Date ? partial.start : projectStart,
    end: partial.end instanceof Date ? partial.end : projectStart,
    progress: typeof partial.progress === 'number' ? partial.progress : 0,
  };
}

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

/**
 * Decide whether a direct (non-drag) SVAR `update-task` edit should be bridged
 * into our pipeline — returning the patch to hand `onTaskEdit` — or passed
 * through to SVAR's native handling (return `null`).
 *
 * Mirrors `resolveEditRequest`'s tri-state discipline and the structural
 * intercepts' fall-through rule (`if (!onTaskXRef.current) return true`): when
 * no consumer handler is wired, do NOT veto SVAR's own mutation — otherwise the
 * edit gesture becomes a silent no-op (F3). An empty/non-mappable delta (e.g.
 * duration-only) also falls through, matching `svarUpdateToPatch`'s contract.
 */
export function resolveDirectEdit(
  delta: Partial<ITask>,
  hasHandler: boolean,
): TaskEditPatch | null {
  if (!hasHandler) return null;
  const patch = svarUpdateToPatch(delta);
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Whether a SVAR `update-task` event is a bar drag / resize / move.
 *
 * SVAR encodes the displacement of a drag in `ev.diff` (whole scale columns) and
 * leaves `ev.task` holding the task's ORIGINAL dates — it only shifts them inside
 * its own store reducer, which runs AFTER `intercept` handlers. So a drag event
 * cannot be bridged at intercept time: the new dates don't exist yet, and reading
 * `ev.task` there yields an original→original no-op patch (dirty fires, zero
 * positional delta, no cascade — Finding-A). Drag events are instead bridged in
 * an `on('update-task')` handler, which runs after the reducer has rewritten
 * `ev.task` to the computed (shifted) task. Direct field / Editor-modal edits
 * carry real values in `ev.task` and no `diff`, so they bridge at intercept time.
 */
export function isSvarDragEvent(ev: { diff?: unknown }): boolean {
  return ev.diff !== undefined && ev.diff !== null;
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
// (the CM zoom-crash bug). Format tokens mirror SVAR's own defaults
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
 * Convert a construction-gantt GanttZoomConfig (agnostic named levels) to
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
// Preset resolution (Task 6) — bundles editMode/editor/toolbar/contextMenu
// on for `preset="msproject"`, unless the caller passed that specific prop.
// ---------------------------------------------------------------------------

export interface PresetInput {
  preset?: 'msproject';
  editMode?: boolean;
  editor?: boolean | GanttEditorConfig;
  toolbar?: boolean | GanttToolbarConfig;
  contextMenu?: boolean | GanttContextMenuConfig;
}
export interface ResolvedChrome {
  editMode: boolean;
  editor: boolean | GanttEditorConfig;
  toolbar: boolean | GanttToolbarConfig;
  contextMenu: boolean | GanttContextMenuConfig;
}

/**
 * Resolve the bundled `preset="msproject"` chrome defaults against explicit
 * per-prop overrides. Presence check is `!== undefined` — an explicitly
 * passed prop (even `false`) always wins over the preset default.
 */
export function resolvePreset(input: PresetInput): ResolvedChrome {
  const on = input.preset === 'msproject';
  const pick = <T>(explicit: T | undefined, presetDefault: T, off: T): T =>
    explicit !== undefined ? explicit : on ? presetDefault : off;
  return {
    editMode: pick(input.editMode, true, false),
    editor: pick(input.editor, true, false),
    toolbar: pick(input.toolbar, true, false),
    contextMenu: pick(input.contextMenu, true, false),
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

/**
 * SVAR 2.6.1's `defaultToolbarButtons` mislabels the copy icon's tooltip as
 * "Ctrl+V" (the `text` field is the tooltip); paste is also "Ctrl+V". We return
 * the default array with the copy-task item corrected to "Ctrl+C". Transforming
 * SVAR's own source (not re-enumerating) keeps this upgrade-safe: if the item is
 * renamed/removed upstream, the map is a harmless no-op.
 */
export function correctedToolbarButtons(): unknown[] {
  const source = defaultToolbarButtons as unknown as Array<Record<string, unknown>>;
  return source.map((item) => (item.id === 'copy-task' ? { ...item, text: 'Ctrl+C' } : item));
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
export function workingMinutesPerDay(calendar: Calendar): number {
  for (const day of calendar.workWeek) {
    if (day && day.length > 0) {
      const mins = day.reduce((sum, iv) => sum + (iv.endMinutes - iv.startMinutes), 0);
      if (mins > 0) return mins;
    }
  }
  return 480;
}

/**
 * Escape a task id for safe interpolation into a double-quoted CSS
 * `[data-id="…"]` attribute selector that we inject via a `<style>` element.
 * Backslash-escapes CSS string terminators (`"`, `\`, newlines) so the selector
 * stays valid, and unicode-escapes `<`/`>` so an id can never emit a literal
 * `</style>` and break out of the stylesheet. Defence-in-depth: ids are usually
 * system-generated, but the public API accepts arbitrary `TaskId` strings.
 */
function cssAttrId(id: TaskId): string {
  return String(id).replace(/["\\<>\n\r]/g, (c) => `\\${c.codePointAt(0)?.toString(16)} `);
}

/** Non-editable phantom grid rows: baseline ghosts + the live edit-preview. */
export function isPhantomRow(task: SvarTaskWithComputed): boolean {
  return task.is_baseline_ghost === true || task.is_edit_preview === true;
}

/**
 * Suffix check for a phantom-row id, for the SVAR event bridges that only see an
 * `ev.id`/`ev.target` (no `is_*_ghost` flag). Mirrors the ids minted by
 * `makeBaselinePhantom` (`${id}__baseline_${n}`) and `makeEditPreviewPhantom`
 * (`${id}__edit_preview`). A gesture on such a row must never reach the engine
 * or the consumer — the id doesn't exist in the project.
 */
export function isPhantomRowId(id: TaskId | null | undefined): boolean {
  if (id === null || id === undefined) return false;
  const s = String(id);
  return s.endsWith('__edit_preview') || /__baseline_\d+$/.test(s);
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
export function buildSignalCss(
  tasks: Task[],
  scopeClass: string,
  opts?: { critical?: boolean; deadline?: boolean },
): string | null {
  const showCritical = opts?.critical !== false;
  const showDeadline = opts?.deadline !== false;
  const rules: string[] = [];
  for (const t of tasks) {
    // SVAR's `setID` prefixes string ids with ':' (data-id=":site") but leaves
    // numeric ids bare (data-id="5"). Target both so critical/deadline styling
    // works regardless of the consumer's TaskId type.
    const eid = cssAttrId(t.id);
    const sel =
      `.${scopeClass} .wx-bar[data-id=":${eid}"],` + `.${scopeClass} .wx-bar[data-id="${eid}"]`;
    if (showCritical && t.computed?.isCritical) {
      rules.push(
        t.type === 'summary'
          ? `${sel}{--wx-gantt-summary-fill-color:#c32b64;--wx-gantt-summary-color:#d9306f;}`
          : `${sel}{--wx-gantt-task-fill-color:#de3a3a;--wx-gantt-task-color:#f3a9a9;}`,
      );
    }
    if (showDeadline && t.computed?.deadlineMissed) {
      rules.push(`${sel}{outline:2px solid #dc2626;outline-offset:1px;}`);
    }
  }
  return rules.length > 0 ? rules.join('\n') : null;
}

/**
 * Grid-row styling CSS, injected per instance (scoped by `scopeClass`) and —
 * unlike {@link buildSignalCss}, which styles bars and is suppressed in edit /
 * ghost mode — emitted in ALL modes, because grid rows render regardless.
 *
 * Currently: **bold summary rows** (MS-Project / P6 convention). SVAR tags every
 * grid row with `data-id=":<id>"` but gives summary and leaf rows the same class,
 * so summary rows are targeted by id. Ids are batched into one selector to keep
 * the injected rule compact. Returns `null` when disabled or there are no
 * summary rows. (`setID` prefixes string ids with ':' but leaves numeric ids
 * bare — target both, same as buildSignalCss.)
 */
export function buildRowStyleCss(
  tasks: Task[],
  scopeClass: string,
  opts?: { boldSummary?: boolean },
): string | null {
  if (opts?.boldSummary === false) return null;
  const summaryIds = tasks.filter((t) => t.type === 'summary').map((t) => t.id);
  if (summaryIds.length === 0) return null;
  const sel = summaryIds
    .map((id) => {
      const eid = cssAttrId(id);
      return `.${scopeClass} .wx-row[data-id=":${eid}"],.${scopeClass} .wx-row[data-id="${eid}"]`;
    })
    .join(',');
  return `${sel}{font-weight:600;}`;
}

export function toSvarTask(
  t: Task,
  baseline: Baseline | undefined,
  calendar: Calendar | undefined,
  hasChildren = true,
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
    ...(t.extra !== undefined ? { extra: t.extra } : {}),
  };

  // `open` only meaningful on summary tasks. Setting it on leaves trips
  // SVAR's child-iteration path (null forEach). A summary with NO children is a
  // leaf to SVAR's tree-builder — its `data` array is never initialised — so
  // marking it `open` makes SVAR's tree-walker recurse into that null child
  // collection (`Ct` → `null.forEach`) and crash the whole schedule page. This
  // is the exact state of a freshly-templated BC job (all-summary phase spine,
  // no child tasks yet). Only mark a summary open when it actually has children;
  // a childless summary renders as an empty leaf bar. (CM crash 2026-07-28.)
  if (t.type === 'summary' && hasChildren) base.open = t.open ?? true;

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
  baselineRender: 'inline' | 'row' = 'row',
): SvarTaskWithComputed[] {
  const ghostById = new Map<TaskId, Task>(editGhostProject?.tasks.map((t) => [t.id, t]) ?? []);

  // Ids that appear as some rendered task's `parent` — i.e. summaries that
  // actually have children in this render. A summary NOT in this set is childless
  // and must not be marked `open` (SVAR's tree-walker would recurse into its null
  // child array and crash — CM childless-summary crash 2026-07-28).
  // Truthiness, not `!= null`, is the correct edge to match SVAR: its `parse`
  // does `r.parent = r.parent || 0`, re-rooting EVERY falsy parent (`''`, `0`,
  // `null`, `undefined`) to the virtual root — so only a truthy parent forms a
  // real parent→child edge in SVAR's pool. This also drops the id-0 noise entry.
  const parentIds = new Set<TaskId>();
  for (const t of renderableTasks) {
    if (t.parent) parentIds.add(t.parent);
  }
  const summaryHasChildren = (t: Task): boolean => t.type !== 'summary' || parentIds.has(t.id);

  if (!ghostBarsEnabled || resolvedBaselines.length === 0) {
    const primary = resolvedBaselines[0];
    const out = renderableTasks.map((t) => toSvarTask(t, primary, calendar, summaryHasChildren(t)));
    if (ghostById.size > 0) {
      for (const t of renderableTasks) {
        if (t.type === 'summary') continue;
        if (t.unscheduled) continue; // F8: unscheduled tasks have no primary bar → no ghost
        const ghost = ghostById.get(t.id);
        if (
          ghost &&
          (ghost.start.getTime() !== t.start.getTime() || ghost.end.getTime() !== t.end.getTime())
        ) {
          out.push(makeEditPreviewPhantom(t, ghost, calendar));
        }
      }
    }
    return out;
  }
  const out: SvarTaskWithComputed[] = [];
  for (const t of renderableTasks) {
    const liveBarBaseline = resolvedBaselines.length === 1 ? resolvedBaselines[0] : undefined;
    const live = toSvarTask(t, liveBarBaseline, calendar, summaryHasChildren(t));
    out.push(live);
    if (t.type === 'summary') continue;
    if (t.unscheduled) continue; // F8: unscheduled tasks have no primary bar → no phantoms
    for (let i = 0; i < resolvedBaselines.length; i++) {
      const b = resolvedBaselines[i];
      if (!b) continue;
      if (i === 0 && baselineRender === 'inline') {
        // Same-row underlay: attach geometry to the live row instead of a phantom row.
        const snap = b.tasks.get(t.id);
        if (snap) {
          const geom = inlineBaselineGeom(
            { start: t.start, end: t.end },
            { start: snap.start, end: snap.end },
          );
          if (geom) live.baseline_inline = geom;
        }
        continue;
      }
      const phantom = makeBaselinePhantom(t, b, calendar);
      if (phantom) out.push(phantom);
    }
    // Edit preview phantom goes last (renders below baseline phantoms).
    const ghost = ghostById.get(t.id);
    if (
      ghost &&
      (ghost.start.getTime() !== t.start.getTime() || ghost.end.getTime() !== t.end.getTime())
    ) {
      out.push(makeEditPreviewPhantom(t, ghost, calendar));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Phantom row helpers
// ---------------------------------------------------------------------------

/**
 * Position a baseline bar as a percentage of the live task's bar box, using
 * calendar-time (SVAR positions bars on the wall-clock axis, so % is
 * zoom-agnostic — no pixel measurement, no SVAR internals). Returns null when
 * the live span is zero (milestone — no underlay).
 */
export function inlineBaselineGeom(
  live: { start: Date; end: Date },
  base: { start: Date; end: Date },
): { leftPct: number; widthPct: number } | null {
  const span = live.end.getTime() - live.start.getTime();
  if (span <= 0) return null;
  return {
    leftPct: ((base.start.getTime() - live.start.getTime()) / span) * 100,
    widthPct: ((base.end.getTime() - base.start.getTime()) / span) * 100,
  };
}

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
    // Convert working-MINUTES → SVAR working-DAYS, same as `toSvarTask` does for live
    // rows. Passing raw minutes here made SVAR read e.g. 16200 as ~16200 day-units and
    // auto-scale an end ~40 years out (Jan 2066), which its expand-only `_end` bound then
    // latched until reload (CM axis-latch bug, 2026-07-04).
    duration: calendar ? Math.round(snap.duration / workingMinutesPerDay(calendar)) : snap.duration,
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

export function makeEditPreviewPhantom(
  liveTask: Task,
  ghostTask: Task,
  calendar: Calendar | undefined,
): SvarTaskWithComputed {
  return {
    id: `${liveTask.id}__edit_preview`,
    text: 'Preview',
    start: ghostTask.start,
    end: ghostTask.end,
    // Convert working-MINUTES → SVAR working-DAYS, same as `toSvarTask` and
    // `makeBaselinePhantom`. Forwarding raw minutes made SVAR read e.g. 16200 as
    // ~16200 day-units and auto-scale an end ~40 years out (Jan 2066), which its
    // expand-only `_end` bound then latched until reload — the CM "vetoed-add"
    // axis blow-out (editing a freshly-added task drives this preview).
    duration: calendar
      ? Math.round(ghostTask.duration / workingMinutesPerDay(calendar))
      : ghostTask.duration,
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
