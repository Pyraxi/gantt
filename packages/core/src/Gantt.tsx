// The real <Gantt>. Consumes a Project, runs the scheduling engine, converts
// our SVAR-agnostic data model to SVAR's ITask/ILink, renders through
// SVAR's free-tier React component per ADR-002 (shape-c slot composition).
//
// Public API surface stays SVAR-agnostic: consumers pass a Project; SVAR
// is a private implementation detail. If we ever swap renderers (per
// ADR-002's seam), this file is the only consumer-facing change.

import {
  type IApi,
  type IColumnConfig,
  type ILink,
  type ITask,
  ContextMenu as SvarContextMenu,
  Editor as SvarEditor,
  Gantt as SvarGantt,
  Toolbar as SvarToolbar,
  Tooltip as SvarTooltip,
  Willow as SvarWillow,
} from '@svar-ui/react-gantt';
// `all.css` (not `style.css`) so the chrome components we expose — Toolbar,
// ContextMenu, Editor — get their own styles. `style.css` is the gantt core
// only and omits e.g. the toolbar's `display:flex`, which makes toolbar items
// stack vertically and balloon the header. all.css bundles the chrome styles.
import '@svar-ui/react-gantt/all.css';
import { Locale as SvarLocale } from '@svar-ui/react-core';
import './Gantt.css';
import type {
  Baseline,
  BaselineIndex,
  Calendar,
  DependencyType,
  GanttContextMenuConfig,
  GanttEditorConfig,
  GanttLocaleWords,
  GanttToolbarConfig,
  GanttZoomConfig,
  GanttZoomLevel,
  Link,
  LinkId,
  Project,
  Task,
  TaskId,
} from '@pyraxi/cpm-engine';
import {
  analyseDriving,
  createCalendarResolver,
  createTask,
  deleteTask,
  filterTasksByVisibility,
  formatDuration,
  formatElapsedDuration,
  indentTask,
  isWorkingDay,
  isWorkingTime,
  moveTask,
  moveTaskTo,
  outdentTask,
  progressPoints,
  schedule,
} from '@pyraxi/cpm-engine';
import {
  type CSSProperties,
  createContext,
  type FC,
  type FocusEvent,
  forwardRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { CellText } from './cell-text.js';
import { type ChartPanel, ChartPanelsLayer } from './chart-panels.js';
import { DisplayOptionsBar } from './DisplayOptionsBar.js';
import {
  displayOptionsReducer,
  initDisplayOptions,
  TOGGLEABLE_COLUMN_IDS,
  visibleColumns,
} from './display-options.js';
import {
  cancelDrag,
  DRAG_INITIAL,
  type DragLinkState,
  isDragInvalid,
  moveDrag,
  startDrag,
} from './editing/dragLink.js';
import {
  durationUnitsFor,
  type EditableField,
  type EditState,
  type TaskEditPatch,
  useEditState,
} from './editing/useEditState.js';
import { usePreviewEngine } from './editing/usePreviewEngine.js';
import { exportViewProps, readThemeTokens } from './export/export-props.js';
import type { OffscreenGanttProps } from './export/offscreen.js';
import type {
  GanttHandle,
  PdfExportOptions,
  PngExportOptions,
  XlsxExportOptions,
} from './export/types.js';
import {
  type ClipboardPlan,
  type DateOrder,
  formatClipboardTable,
  parseClipboardTable,
  planFillDown,
  planPaste,
  type SkippedCell,
  type TaskEdit,
} from './grid-clipboard.js';
import {
  decodeSvarId,
  encodeSvarId,
  findNextCellInRow,
  type GridMove,
  visibleRowOrder,
} from './grid-keyboard.js';
import { buildHighlightCss, type TaskHighlight } from './highlights.js';
import { MarkersLayer } from './markers-layer.js';
import { ProgressLineLayer } from './progress-line.js';
import { type PreviousStart, type TaskBadge, TaskBadgesLayer } from './task-badges.js';
import { buildTaskPath, paintPathLinks, type TaskPathMode } from './task-path.js';
import { placesUnderHidden, reRootOrphans } from './visible-tree.js';

type SvarRowLike = { id: TaskId; parent?: TaskId | null };

import { filterLinksForDisplay, type LinkDisplay } from './link-display.js';
import { predecessorsColumn } from './predecessors.js';
import {
  buildStructuralCommit,
  resolveAddPosition,
  type StructuralChange,
  type StructuralCommitDeps,
} from './structural-commit.js';
import {
  buildRowStyleCss,
  buildSignalCss,
  buildSvarTasks,
  classifyStructuralEvent,
  correctedToolbarButtons,
  formatShortDate,
  isPhantomRow,
  isPhantomRowId,
  isSvarDragEvent,
  projectHasSplitTasks,
  projectHasUnscheduledTasks,
  resolveDirectEdit,
  resolveEditRequest,
  resolvePreset,
  resolveZoomLevels,
  type SvarScaleState,
  type SvarTaskWithComputed,
  svarGhostBox,
  toSvarContextMenu,
  toSvarEditorItems,
  toSvarToolbar,
  toSvarZoom,
  workingMinutesPerDay,
} from './svar-adapter.js';

// Engine factories the structural-commit path applies. Module-level + stable so
// the intercept closure references one object across renders.
const STRUCTURAL_DEPS: StructuralCommitDeps = {
  schedule,
  createTask,
  deleteTask,
  moveTask,
  moveTaskTo,
  indentTask,
  outdentTask,
};

export interface GanttMarker {
  start: Date;
  text?: string;
  /**
   * Visual style. 'today' renders as a red line; 'milestone' as blue;
   * 'custom' lets you supply a `css` class name yourself.
   */
  variant?: 'today' | 'milestone' | 'custom';
  /** CSS class name when `variant: 'custom'`. */
  css?: string;
}

/**
 * Defines a column in the left-hand grid of the Gantt chart.
 * Construction-PM-facing: these are the columns site PMs expect alongside
 * the task name (WBS code, trade package, assigned subcontractor, etc.).
 *
 * This is a SVAR-agnostic type — internal conversion to SVAR's IColumnConfig
 * happens inside the <Gantt> wrapper.
 */
export interface GanttColumn<TTask = Task> {
  /** Identifier; used as SVAR column id. */
  id: string;
  /** Header label rendered in the column header row. */
  header: string;
  /**
   * The field on the task to pluck for the default cell render.
   * Optional — if `render` is provided, this is ignored.
   */
  field?: keyof TTask;
  /** Column width in pixels. Defaults to SVAR's default if unset. */
  width?: number;
  /** Text alignment for the cell. */
  align?: 'left' | 'center' | 'right';
  /**
   * Custom cell render. Receives the live (scheduled) task. Use for any
   * column more complex than displaying a single field value.
   */
  render?: FC<{ task: Task }>;
  /**
   * Make this column's cell inline-editable (click to type) even when it has a
   * custom `render`. Only applies to fields in EDITABLE_FIELDS
   * (text/start/end/duration/progress) and only in `editMode`. Edits flow through
   * `onTaskEdit`. Unset = today's behavior (editable iff no `render`); `false`
   * forces read-only.
   */
  editable?: boolean;
  /**
   * Inline editor for a **custom (non-engine) column** — a host-app field the
   * engine doesn't model (e.g. trade / subcontractor / state, typically stored
   * in `task.extra`). When set and `editMode` is on, the cell becomes
   * click-to-edit and commits fire {@link GanttProps.onCellEdit} (`(id,
   * columnId, value)`) instead of the engine `onTaskEdit` path — so the consumer
   * persists the value themselves. Engine fields (start/finish/duration/…) keep
   * using `editable` + `onTaskEdit`; don't set both on one column. The column's
   * `render` (if any) still owns the read display.
   */
  editor?: GanttColumnEditor;
}

/**
 * Inline-editor descriptor for a custom {@link GanttColumn} (see
 * `GanttColumn.editor`). `getValue` reads the current raw value off the task to
 * seed the editor (the column's `render` handles display); the committed string
 * is handed back verbatim via `onCellEdit`.
 */
export interface GanttColumnEditor {
  /** `'text'` = free-text input; `'select'` = dropdown constrained to `options`. */
  type: 'text' | 'select';
  /** Options for `type: 'select'`; `label` defaults to `value`. Ignored for text. */
  options?: Array<{ value: string; label?: string }>;
  /** Current raw editable value for the task (e.g. `t => String(t.extra?.trade ?? '')`). */
  getValue: (task: Task) => string;
  /**
   * Text editors: an error message for a value that can't be committed, or
   * undefined when it's fine. An invalid value keeps the editor open on
   * Enter / Tab (marked invalid, the message as its tooltip) and reverts on blur.
   */
  validate?: (value: string, task: Task) => string | undefined;
}

/**
 * Configuration for the opt-in `displayOptions` control bar.
 *
 * - `columns` / `signals`: show/hide that section of the bar. Both default
 *   to `true` (shown) when `displayOptions` is set at all.
 * - `defaults`: initial toggle state (which columns start hidden, which
 *   signals start on). Matches `initDisplayOptions`'s defaults shape.
 */
export interface DisplayOptionsConfig {
  columns?: boolean;
  signals?: boolean;
  defaults?: {
    hiddenColumns?: string[];
    critical?: boolean;
    slack?: boolean;
    deadline?: boolean;
    /** `taskBadges` shown. Default true. */
    badges?: boolean;
    /** `previousStart` markers shown. Default true. */
    previousStarts?: boolean;
  };
}

/**
 * The user-adjustable view, as reported by {@link GanttProps.onViewStateChange}.
 * Same shape as `DisplayOptionsConfig.defaults` (+ `zoom`), so a persisted
 * value restores directly: `displayOptions={{ defaults: saved }}` and
 * `zoom={{ ...levels, default: saved.zoom }}`.
 */
export interface GanttViewState {
  /** Column ids hidden via the displayOptions bar (`[]` when `displayOptions` is off). */
  hiddenColumns: string[];
  critical: boolean;
  slack: boolean;
  deadline: boolean;
  /** `taskBadges` shown (always true when `displayOptions` is off). */
  badges: boolean;
  /** `previousStart` markers shown (always true when `displayOptions` is off). */
  previousStarts: boolean;
  /** Current zoom level — present when the `zoom` prop is configured. */
  zoom?: GanttZoomLevel;
}

export interface GanttProps {
  project: Project;
  /** Container height. Defaults to 500 (px). */
  height?: number | string;
  /** Width of one time-scale cell (per `cellWidth` SVAR prop). Default 48. */
  cellWidth?: number;
  /** Height of one row. */
  cellHeight?: number;
  /**
   * Skip running the scheduling engine. Use when the project's tasks
   * already have `computed` populated by a prior `schedule()` call.
   */
  preScheduled?: boolean;
  /**
   * Vertical markers (today line + arbitrary milestones).
   * Default: a today line if the current date falls within the project
   * window. Pass an empty array to suppress, or your own markers list to
   * override.
   */
  markers?: GanttMarker[];
  /**
   * Baselines to overlay as phantom ghost rows beneath each live task.
   *
   * - Single-baseline mode (length 1): the live bar carries the variance pill,
   *   matching the existing single-baseline behaviour.
   * - Multi-baseline mode (length > 1): each phantom row carries its own
   *   variance pill against the live task; the live bar has no pill.
   * - Indices not present on `project.baselines` are silently skipped (no
   *   throw) so consumers can pass a fixed shape regardless of how many
   *   baselines a particular project has captured.
   *
   * Phantom rows render in array order — consumers wanting chronological
   * order should sort by `baseline.capturedAt` before passing.
   */
  baselineIndices?: ReadonlyArray<BaselineIndex>;
  /**
   * @deprecated Use `baselineIndices: [N]`. Single-index convenience prop
   * kept as a no-friction alias for v0.x consumers. Removed at v1.0.
   * If both `baselineIndex` and `baselineIndices` are set, `baselineIndices`
   * takes precedence.
   *
   * Show variance against this baseline index. If unset (or no matching
   * baseline exists on `project.baselines`), bars render without variance
   * pills. Construction-vertical use case (ADR-003): comparing the live
   * programme against the original contract programme captured under
   * NZS 3910 / AS 4000.
   */
  baselineIndex?: BaselineIndex;
  /**
   * Render the baseline as a separate "ghost" bar beneath each live task.
   * Matches the MS Project baseline-view idiom construction PMs expect
   * when reviewing variation claims. Default true when either
   * `baselineIndex` or `baselineIndices` is set; pass `false` to keep
   * variance shown only as in-bar pills.
   */
  showBaselineBars?: boolean;
  /**
   * How the first baseline renders. `'row'` (default) draws a separate phantom
   * row beneath each task; `'inline'` draws a thin same-row underlay bar under
   * the live bar (MS-Project convention). Inline applies to the first baseline;
   * additional baselines (`baselineIndices` length > 1) still render as rows.
   */
  baselineRender?: 'inline' | 'row';
  /**
   * Grid columns displayed alongside the Gantt bars.
   *
   * - `undefined` (default): SVAR renders its built-in columns (task name +
   *   duration + start + end).
   * - `[]` (empty array): hides the grid entirely (passes `columns={false}`
   *   to SVAR).
   * - `GanttColumn[]`: replaces SVAR's default columns with the supplied set.
   *
   * Construction-PM-facing columns live here: WBS code, trade package,
   * assigned subcontractor, and similar project-specific fields.
   */
  columns?: GanttColumn[];
  /**
   * Bold the grid rows of summary tasks (MS-Project / P6 convention). Default
   * `true`. Set `false` to keep summary rows the same weight as leaf rows.
   * Styling-only; applies in every mode (independent of `editMode`).
   */
  boldSummaryRows?: boolean;
  /**
   * Calendar days of empty timeline shown before the project start, so the
   * earliest bars don't butt against the chart's left edge. Default `0` (the
   * timeline starts at `project.start`, unchanged). Render-only — scheduling
   * and exports are unaffected. Coarse zoom levels may snap the visible start
   * further back to the scale unit boundary.
   */
  leadInDays?: number;
  /**
   * Render-only visibility filter. When set, only tasks whose `id` is in
   * the set are rendered. **CPM still runs on the full task set** — hidden
   * predecessors continue to drive their visible successors' computed
   * fields. The visibility filter is a render-only concern (ADR-005).
   *
   * - `undefined` (default): no filter; render everything.
   * - empty set: render nothing.
   * - set containing ids not present in `project.tasks`: those ids are
   *   ignored; only matching tasks render.
   *
   * - a matching task whose parent is filtered out is drawn under its
   *   nearest visible ancestor (or at the top level), never dropped. Keep
   *   the summaries instead with the engine's `filterProject`. Render-only:
   *   tooltips and `render` columns see the drawn parent, and a drop or add
   *   that would file a task under a filtered-out summary is refused (with
   *   `onStructuralCommit`, and for `onTaskAdd`). The thin `onTaskIndent`
   *   path is resolved by the host, so checking it is the host's job.
   *
   * Lifts the "filter-while-keeping-CPM-correct" domain rule that
   * consumer apps would otherwise have to write themselves. See
   * `visibility.ts` for the contract test.
   */
  visibleTaskIds?: ReadonlySet<TaskId>;
  /** Bundled interaction preset. `"msproject"` turns on editMode + editor +
   *  toolbar + contextMenu together; individual props override it. */
  preset?: 'msproject';
  // --- v0.4 editing ---
  editMode?: boolean;
  onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void;
  /**
   * A grid paste (Ctrl/Cmd+V of a block from Excel) or fill-down (Ctrl/Cmd+D)
   * as ONE batch — one persist, one undo step. Patches are merged per task;
   * cells that were read-only, unparseable or past the grid's edge are in
   * `info.skipped`, never forced. Unset: each task's patch goes to
   * `onTaskEdit` instead.
   */
  onTasksEdit?: (
    edits: TaskEdit[],
    info: { source: 'paste' | 'fill'; skipped: SkippedCell[] },
  ) => void;
  /**
   * The grid clipboard in `editMode`, on a focused cell: Ctrl/Cmd+V pastes a
   * block from Excel (positionally, from that cell), Ctrl/Cmd+C copies, and
   * Ctrl/Cmd+D fills down (the selected rows, or from the row above).
   * Default `true`. With `false`, SVAR's own task hotkeys apply on a focused
   * cell again (Ctrl+C/V/X copy / paste / cut the task, Ctrl+D deletes it).
   */
  gridClipboard?: boolean;
  /** How pasted `d/m/yyyy` dates are read. Default `'dmy'` (NZ / AU / UK). */
  dateOrder?: DateOrder;
  onLinkCreate?: (source: TaskId, target: TaskId, type: DependencyType) => void;
  onLinkDelete?: (linkId: LinkId) => void;
  /**
   * Fired when SVAR's native "Add task" (toolbar/menu/grid `+`) mutation is
   * intercepted. `position` mirrors SVAR's own add-task reducer: "Child task"
   * → `parent` set (the new task nests under the target); "Task below" →
   * `parent` = target's parent + `insertAfter` = target (a **sibling**, not a
   * child); "Task above" → `parent` = target's parent + `insertAfter` = the
   * target's previous sibling (`undefined` when the target is already first,
   * the one placement this shape can't express — prefer `onStructuralCommit`
   * for exact positioning). The bridge vetoes SVAR's optimistic mutation
   * (`return false`), so nothing renders until the consumer applies `createTask`
   * to the `Project` and re-renders.
   */
  onTaskAdd?: (task: Partial<ITask>, position: { parent?: TaskId; insertAfter?: TaskId }) => void;
  /**
   * Fired when SVAR's native "Delete task" mutation (toolbar/menu/hotkey) is
   * intercepted. The bridge vetoes SVAR's optimistic mutation — apply `deleteTask`
   * to the `Project` yourself.
   */
  onTaskDelete?: (id: TaskId) => void;
  /**
   * Fired when SVAR's native "Move up"/"Move down" toolbar/menu action is
   * intercepted. Row drag-and-drop reordering is a distinct SVAR event shape
   * (`mode: 'before'|'after'` + `inProgress`) not covered by this bridge yet.
   */
  onTaskReorder?: (id: TaskId, direction: 'up' | 'down') => void;
  /**
   * Fired when SVAR's native "Indent"/"Outdent" toolbar/menu action is
   * intercepted. The bridge vetoes SVAR's optimistic mutation — apply
   * `indentTask`/`outdentTask` to the `Project` yourself.
   */
  onTaskIndent?: (id: TaskId, direction: 'indent' | 'outdent') => void;
  /**
   * **Bolt-in structural-commit callback (ADR-010).** When wired, it becomes the
   * single path for every structural gesture — add, delete, row drag-reorder,
   * indent/outdent — and **takes precedence over the individual `onTask*`
   * callbacks above** (which stay supported for non-bolt-in consumers).
   *
   * The package owns the round-trip: it applies the matching engine command,
   * re-runs `schedule()`, and hands you `changes` (every affected task's full
   * post-op state — id, `parent`, `orderIndex`, `type`, `op`) plus `nextProject`
   * (the scheduled result). Persist `changes` verbatim (a mechanical mirror — no
   * engine semantics re-derived) and adopt `nextProject` to re-render. SVAR's
   * optimistic mutation is vetoed, so nothing renders until you adopt it.
   *
   * `op:'delete'` marks removed rows (tombstones — a deleted summary cascades,
   * so its whole subtree is tombstoned); `op:'add'` marks new rows; otherwise the
   * positional gesture. All resequenced siblings are emitted.
   *
   * **Precondition:** structural gestures are only intercepted when `editMode` is
   * on (directly or via `preset="msproject"`). Wire this alongside one of those.
   */
  onStructuralCommit?: (changes: StructuralChange[], nextProject: Project) => void;
  /**
   * Fired when a task bar or its grid row is selected (SVAR's native selection).
   * Use to drive a selection-aware affordance (e.g. open a task panel) without a
   * dedicated edit column. Independent of `editMode` — selection is a read gesture.
   */
  onTaskSelect?: (id: TaskId) => void;
  /**
   * Which dependency links the chart draws. Default `'all'`. SVAR draws every
   * link whether or not it's on screen, so on very large schedules (thousands
   * of links) `'critical'` (both ends critical), `'selected'` (links into or out
   * of the selected task) or `'none'` cut mount and scroll cost. Display only:
   * hidden links still schedule, and the predecessors column still lists them.
   */
  linkDisplay?: LinkDisplay;
  /**
   * MS Project's Task Path: highlight the selected task's driving
   * predecessors (`'driving'`, orange), the successors it drives (`'driven'`,
   * purple) or both, with their driving links. Default off. Colours:
   * `--cg-path-driving-color` / `--cg-path-driven-color`.
   */
  taskPath?: TaskPathMode;
  /** Highlight this task's path instead of the selected one (a host panel can drive it). */
  taskPathFor?: TaskId;
  /**
   * Draw the progress line: from the status date (default
   * `project.statusDate`) through each task's progress point — left of the
   * line when it's behind, right when it's ahead (MS Project / P6). Default
   * off; nothing is drawn without a status date. Colour:
   * `--cg-progress-line-color`. `basis: 'physical'` places each point by the
   * task's `physicalProgress` (P6), falling back to duration % without one.
   */
  progressLine?: boolean | { statusDate?: Date; color?: string; basis?: 'duration' | 'physical' };
  /**
   * Strips drawn under the chart on its timescale (one per entry, in order):
   * each `render(ctx)` gets the scheduled project, the timeline width and an
   * `xOf(date)` that lines up with SVAR's bars at every zoom, and scrolls with
   * the chart. The label sits in the gutter under the grid. Not drawn in PNG /
   * PDF exports yet. `@pyraxi/gantt-pro`'s resource histogram is one.
   */
  chartPanels?: ChartPanel[];
  /**
   * Badges beside a task's bar (just before its start): small labelled
   * indicators, e.g. make-ready status. Return `[]` / `undefined` for none.
   * Each needs a text or glyph `label` (meaning never rests on colour alone);
   * `tone` picks the colour (`--cg-badge-<tone>-bg` / `-fg`). Clickable when
   * `onTaskBadgeClick` is set. Hideable via the `displayOptions` bar.
   */
  taskBadges?: (task: Task) => readonly TaskBadge[] | null | undefined;
  /**
   * A ghost marker at a task's previous start, joined to its bar by a dashed
   * line, e.g. where a slipped task was planned to start. `pending` draws it as
   * needing attention (amber, `?`). Colours `--cg-previous-start-color` /
   * `--cg-previous-start-pending-color`. Clickable when `onTaskBadgeClick` is
   * set (kind `'previous-start'` unless the marker sets one). Hideable via the
   * `displayOptions` bar.
   */
  previousStart?: (task: Task) => PreviousStart | null | undefined;
  /** A badge or previous-start marker was clicked: the task and the badge's `kind`. */
  onTaskBadgeClick?: (taskId: TaskId, kind: string) => void;
  /**
   * Highlight task sets — e.g. `checkSchedule()`'s offending ids — with a ring
   * on their bars and a tint on their grid rows. Later sets win. Colour default
   * `--cg-highlight-color` (amber).
   */
  highlights?: TaskHighlight[];
  /**
   * Fired when the user triggers the built-in task editor — SVAR's "Edit"
   * context-menu item, or a task double-click. When wired, the package **vetoes
   * SVAR's built-in Editor modal** and calls this instead, so a consumer that
   * edits through its own panel (persisted via `onTaskEdit` / `onStructuralCommit`)
   * can route the native Edit gesture to that panel without re-declaring the
   * whole context menu. Independent of `editMode` and of the `editor` prop; takes
   * precedence over the built-in editor. (Double-clicking a cell whose column is
   * inline-`editable` still edits inline — that path never opens the editor.)
   */
  onTaskEditRequest?: (id: TaskId) => void;
  /**
   * Fired when a custom-column inline editor ({@link GanttColumn.editor}) commits
   * a new value. `(id, columnId, value)` — the task, the `GanttColumn.id`, and
   * the raw string from the editor. The consumer persists it (these are host-app
   * fields the engine doesn't model — trade/sub/state — so no CPM re-run). Engine
   * fields still commit via `onTaskEdit`. Only fires when the new value differs
   * from the editor's `getValue`.
   */
  onCellEdit?: (id: TaskId, columnId: string, value: string) => void;
  // --- v0.5 chrome ---
  /**
   * Enable scroll-wheel zoom with named levels.
   * Converted internally to SVAR's IZoomConfig (ADR-002).
   * Example: `zoom={{ levels: ['day','week','month'], default: 'week' }}`
   */
  zoom?: GanttZoomConfig;
  /**
   * Hover tooltip for a task bar.
   * - **omitted (default):** a built-in tooltip (title · date range · working
   *   days · % complete · status · assignee-if-present · deadline/critical flags).
   * - **function:** your own tooltip — receives the (scheduled) `Task` incl.
   *   `extra` and `deadline`; return any ReactNode. Overrides the default.
   * - **`false`:** disable the tooltip entirely.
   *
   * Example: `tooltip={(task) => <span>{task.text} — {String(task.extra?.assignee ?? '')}</span>}`
   */
  tooltip?: ((task: Task) => ReactNode) | false;
  /**
   * Enable the SVAR Editor modal for task editing.
   * `true` = default SVAR editor fields; object = custom fields + placement.
   * Note: coexists with inline cell editing (editMode). The SVAR Editor is a
   * full-form modal, not an in-grid input.
   */
  editor?: boolean | GanttEditorConfig;
  /**
   * Enable the right-click context menu.
   * `true` = SVAR's built-in items (add/delete/indent/etc.); object = custom items.
   */
  contextMenu?: boolean | GanttContextMenuConfig;
  /**
   * Toolbar above the Gantt. **Defaults to `true`** (SVAR's built-in
   * add-task/undo/redo buttons); pass an object for custom items, or `false`
   * to hide it. Note: it adds height above the chart area; adjust the
   * container height accordingly.
   *
   * ⚠️ The built-in buttons act on SVAR's internal store, NOT on your
   * `project` model, and fire no callback — in a controlled app (where you
   * re-render from `project`) their effects are transient. For real editing,
   * pass a custom `items` config whose `onClick` handlers dispatch your own
   * edits (via `useEditableProject` / your server actions), or set
   * `toolbar={false}` and provide your own.
   */
  toolbar?: boolean | GanttToolbarConfig;
  /**
   * Locale word overrides for SVAR UI strings (toolbar labels, context menu text, dates, etc.).
   * Partial — unset keys fall back to SVAR English defaults.
   * Structurally wraps the SVAR `<Locale>` context provider (not a direct `<Gantt>` prop).
   */
  locale?: GanttLocaleWords;
  /**
   * Optional bottom bar rendered inside the component's flex column;
   * consumer-supplied content (e.g. a status/legend strip). Rendered below
   * the gantt chart area, shrink-to-content (does not scroll with the chart).
   */
  footer?: ReactNode;
  /**
   * Show the engine's critical-path signal (recoloured bar fill on the
   * native path, `wx-critical` styling elsewhere). Default true.
   *
   * Ignored whenever `displayOptions` is enabled — the bar's live `critical`
   * toggle (seeded from `displayOptions.defaults.critical`) takes over instead.
   */
  showCritical?: boolean;
  /**
   * Show the total-slack pill on non-critical task bars (edit-mode /
   * baseline-ghost template paths only — see `ConstructionBar`). Default true.
   *
   * Ignored whenever `displayOptions` is enabled — the bar's live `slack`
   * toggle (seeded from `displayOptions.defaults.slack`) takes over instead.
   */
  showSlack?: boolean;
  /**
   * Show the deadline-overrun signal (outline on the native path). Default true.
   *
   * Ignored whenever `displayOptions` is enabled — the bar's live `deadline`
   * toggle (seeded from `displayOptions.defaults.deadline`) takes over instead.
   */
  showDeadline?: boolean;
  /**
   * Opt-in column + signal control bar rendered above the toolbar (first
   * child of the flex column). `true` enables both columns and signals
   * with all defaults on; pass a `DisplayOptionsConfig` to scope which
   * section shows or to seed initial hidden columns / signal state.
   *
   * When enabled, the bar's initial column-visibility and signal state come
   * from `displayOptions.defaults` (see `DisplayOptionsConfig.defaults`), and
   * the bar then drives `showCritical`/`showSlack`/`showDeadline`/columns
   * live from then on. The standalone `showCritical`/`showSlack`/
   * `showDeadline` props (and the static `columns` set) apply only when
   * `displayOptions` is NOT set — they are bypassed entirely once it is.
   * Default: disabled (unset), matching pre-Task-6 behaviour exactly.
   */
  displayOptions?: boolean | DisplayOptionsConfig;
  /**
   * Fires when the user changes the view — a `displayOptions` column/signal
   * toggle or a zoom level change — with the full current {@link GanttViewState}.
   * Never fires on mount. Persist it host-side and pass it back via
   * `displayOptions.defaults` / `zoom.default` to restore ("set as default view").
   */
  onViewStateChange?: (state: GanttViewState) => void;
}

const DEFAULT_EDIT_COLUMNS: GanttColumn[] = [
  { id: 'text', header: 'Task Name', field: 'text', width: 220 },
  { id: 'start', header: 'Start', field: 'start', width: 100, align: 'center' },
  { id: 'end', header: 'Finish', field: 'end', width: 100, align: 'center' },
  // 90: the bold "Duration" header needs ~84px or it ellipsizes to "Durat…".
  { id: 'duration', header: 'Duration', field: 'duration', width: 90, align: 'right' },
  { id: 'progress', header: '%', field: 'progress', width: 50, align: 'right' },
];

interface SvarMarker {
  start: Date;
  text?: string;
  css?: string;
}

function useDragLink() {
  const [dragState, setDragState] = useState<DragLinkState>(DRAG_INITIAL);
  const dragRef = useRef(dragState);
  dragRef.current = dragState;

  const onBarMouseDown = useCallback((sourceId: TaskId, e: React.MouseEvent) => {
    e.preventDefault();
    setDragState(startDrag(sourceId, e.clientX, e.clientY));
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    setDragState((s) => moveDrag(s, e.clientX, e.clientY));
  }, []);

  const onMouseUp = useCallback(
    (
      e: MouseEvent,
      project: Project,
      onLinkCreate: ((s: TaskId, t: TaskId, type: DependencyType) => void) | undefined,
    ) => {
      const current = dragRef.current;
      if (current.status !== 'dragging') return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const barEl = el?.closest('[data-task-id]');
      const targetAttr = barEl?.getAttribute('data-task-id') ?? null;
      // Resolve to a real task — rejects phantom row ids (e.g. "t1__baseline_0")
      // and preserves the original typed TaskId (fixes numeric id loss via DOM attribute).
      const targetTask = targetAttr
        ? project.tasks.find((t) => String(t.id) === targetAttr)
        : undefined;
      if (!targetTask) {
        setDragState(cancelDrag(current));
        return;
      }
      const summaryIds = new Set<TaskId>(
        project.tasks.filter((t) => t.type === 'summary').map((t) => t.id),
      );
      if (isDragInvalid(current.sourceId, targetTask.id, project.links, summaryIds)) {
        setDragState(cancelDrag(current));
        return;
      }
      onLinkCreate?.(current.sourceId, targetTask.id, 'FS');
      setDragState(DRAG_INITIAL);
    },
    [],
  );

  const cancelDragLink = useCallback(() => setDragState(DRAG_INITIAL), []);

  return { dragState, onBarMouseDown, onMouseMove, onMouseUp, cancelDragLink };
}

export const Gantt = forwardRef<GanttHandle, GanttProps>(function Gantt(
  {
    project,
    height = 500,
    cellWidth = 48,
    cellHeight = 42,
    preScheduled = false,
    markers,
    baselineIndex,
    baselineIndices,
    showBaselineBars,
    baselineRender,
    columns,
    visibleTaskIds,
    preset,
    editMode: editModeProp,
    onTaskEdit,
    onTasksEdit,
    gridClipboard = true,
    dateOrder = 'dmy',
    onLinkCreate,
    onLinkDelete,
    onTaskAdd,
    onTaskDelete,
    onTaskReorder,
    onTaskIndent,
    onStructuralCommit,
    onTaskSelect,
    linkDisplay,
    taskPath,
    taskPathFor,
    progressLine,
    chartPanels,
    taskBadges,
    previousStart,
    onTaskBadgeClick,
    highlights,
    onTaskEditRequest,
    onCellEdit,
    boldSummaryRows = true,
    leadInDays,
    zoom,
    tooltip,
    editor: editorProp,
    contextMenu: contextMenuProp,
    toolbar: toolbarProp = true,
    locale,
    footer,
    showCritical = true,
    showSlack = true,
    showDeadline = true,
    displayOptions,
    onViewStateChange,
  },
  ref,
) {
  // Resolve the bundled `preset="msproject"` chrome defaults against explicit
  // per-prop overrides (resolvePreset — Task 6). `toolbarProp` is already
  // defaulted to `true` above (pre-existing default-on toolbar behavior,
  // independent of any preset), so it always reaches resolvePreset as an
  // "explicit" value and passes through unchanged either way. `editModeProp`,
  // `editorProp`, and `contextMenuProp` are left undefined when not passed so
  // resolvePreset can tell "not passed" (preset may turn it on) apart from
  // "explicitly false" (always wins).
  const chrome = resolvePreset({
    preset,
    editMode: editModeProp,
    editor: editorProp,
    toolbar: toolbarProp,
    contextMenu: contextMenuProp,
  });
  const editMode = chrome.editMode;
  const editor = chrome.editor;
  const contextMenu = chrome.contextMenu;
  const toolbar = chrome.toolbar;

  // displayOptions (Task 6): boolean shorthand normalises to `{}` (all
  // defaults); an explicit config object passes through as-is; unset/false
  // stays `null` so every derived value below falls back to pre-Task-6
  // behaviour untouched.
  const doCfg = displayOptions === true ? {} : displayOptions || null;
  const doEnabled = !!displayOptions;
  const showDoColumns = doCfg?.columns !== false;
  const showDoSignals = doCfg?.signals !== false;
  const [doState, doDispatch] = useReducer(
    displayOptionsReducer,
    doCfg?.defaults,
    initDisplayOptions,
  );

  // Signal-visibility locals (Task 5). When displayOptions is enabled the
  // live toggle state wins; otherwise these fall straight through to the
  // static showCritical/showSlack/showDeadline props (default true), so a
  // consumer that never sets `displayOptions` sees byte-identical behaviour.
  const effectiveCritical = doEnabled ? doState.critical : showCritical;
  const effectiveSlack = doEnabled ? doState.slack : showSlack;
  const effectiveDeadline = doEnabled ? doState.deadline : showDeadline;
  const effectiveBadges = doEnabled ? doState.badges : true;
  const effectivePreviousStarts = doEnabled ? doState.previousStarts : true;

  const containerRef = useRef<HTMLDivElement>(null);
  // Per-instance scope so the engine-signal stylesheet below only touches this
  // Gantt's bars, never any sibling Gantt on the same page. useId yields a
  // string with colons (":r0:"); strip them for a valid class name.
  const ganttScopeClass = `cg-scope-${useId().replace(/:/g, '')}`;
  // SVAR calls init in a useEffect after first paint, so the IApi isn't
  // available on the first render. useState (not useRef) is required so that
  // setting the api triggers a re-render. Critically, the api-dependent chrome
  // siblings (Toolbar, ContextMenu, Editor, Tooltip) are gated on `svarApi`
  // being non-null below — SVAR's Editor/Tooltip call an UNGUARDED `useStore(api)`
  // that throws `Cannot read properties of undefined (reading 'getState')` if
  // rendered with api=undefined. Gating means they mount only after init fires.
  const [svarApi, setSvarApi] = useState<IApi | null>(null);

  const effectiveBaselineIndices = useMemo<ReadonlyArray<BaselineIndex>>(
    () => resolveEffectiveBaselineIndices(baselineIndices, baselineIndex),
    [baselineIndices, baselineIndex],
  );

  const scheduled = useMemo(
    () => (preScheduled ? project : schedule(project)),
    [project, preScheduled],
  );

  // Visibility filter is render-only — applied AFTER schedule() has run so
  // computed fields on visible tasks reflect the full project. ADR-005.
  // An orphan (parent filtered out) is re-rooted so it still renders.
  const visibleTaskIdsRef = useRef(visibleTaskIds);
  visibleTaskIdsRef.current = visibleTaskIds;
  const renderableTasks = useMemo(
    () =>
      visibleTaskIds === undefined
        ? scheduled.tasks
        : reRootOrphans(filterTasksByVisibility(scheduled.tasks, visibleTaskIds), scheduled.tasks),
    [scheduled.tasks, visibleTaskIds],
  );

  const calendar = useMemo(
    () => scheduled.calendars.find((c) => c.id === scheduled.defaultCalendarId),
    [scheduled.calendars, scheduled.defaultCalendarId],
  );

  // Durations typed / shown in the grid use the calendar's working day.
  const durationUnits = useMemo(
    () => durationUnitsFor(calendar ? workingMinutesPerDay(calendar) : undefined),
    [calendar],
  );
  // Elapsed-duration tasks (`3ed`) take typed days as 24 h.
  const elapsedIdsRef = useRef(new Set<string>());
  elapsedIdsRef.current = useMemo(
    () => new Set(scheduled.tasks.filter((t) => t.durationElapsed).map((t) => String(t.id))),
    [scheduled.tasks],
  );
  const isElapsedTask = useCallback((id: TaskId) => elapsedIdsRef.current.has(String(id)), []);
  const editState = useEditState(durationUnits, isElapsedTask);
  const editStateRef = useRef<typeof editState>(editState);
  editStateRef.current = editState;
  const onTaskEditRef = useRef(onTaskEdit);
  onTaskEditRef.current = onTaskEdit;
  const onTasksEditRef = useRef(onTasksEdit);
  onTasksEditRef.current = onTasksEdit;
  const dateOrderRef = useRef(dateOrder);
  dateOrderRef.current = dateOrder;
  const onTaskAddRef = useRef(onTaskAdd);
  onTaskAddRef.current = onTaskAdd;
  const onTaskDeleteRef = useRef(onTaskDelete);
  onTaskDeleteRef.current = onTaskDelete;
  const onTaskReorderRef = useRef(onTaskReorder);
  onTaskReorderRef.current = onTaskReorder;
  const onTaskIndentRef = useRef(onTaskIndent);
  onTaskIndentRef.current = onTaskIndent;
  const onStructuralCommitRef = useRef(onStructuralCommit);
  onStructuralCommitRef.current = onStructuralCommit;
  const onTaskSelectRef = useRef(onTaskSelect);
  onTaskSelectRef.current = onTaskSelect;
  const linkDisplayRef = useRef(linkDisplay);
  linkDisplayRef.current = linkDisplay;
  const taskPathRef = useRef(taskPath);
  taskPathRef.current = taskPath;
  // SVAR's selection (all ids, after toggles), mirrored on every select-task.
  // Only 'selected' link display needs it in state (a re-render); entering
  // that mode syncs from the ref.
  const selectedIdsRef = useRef<TaskId[]>([]);
  const [selectedIds, setSelectedIds] = useState<TaskId[]>([]);
  useEffect(() => {
    if (linkDisplay === 'selected' || taskPath) setSelectedIds(selectedIdsRef.current);
  }, [linkDisplay, taskPath]);
  const onTaskEditRequestRef = useRef(onTaskEditRequest);
  onTaskEditRequestRef.current = onTaskEditRequest;
  const onCellEditRef = useRef(onCellEdit);
  onCellEditRef.current = onCellEdit;
  // Raw (pre-schedule) project for the structural-commit path — buildStructuralCommit
  // applies the command to this and re-runs schedule() itself.
  const projectRef = useRef(project);
  projectRef.current = project;
  const editGhostProject = usePreviewEngine(scheduled, editState.activeCell, editState.dirtyValue);

  const { dragState, onBarMouseDown, onMouseMove, onMouseUp, cancelDragLink } = useDragLink();

  useEffect(() => {
    if (!editMode || dragState.status !== 'dragging') return;
    const handleMove = (e: MouseEvent) => onMouseMove(e);
    const handleUp = (e: MouseEvent) => onMouseUp(e, scheduled, onLinkCreate);
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelDragLink();
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [editMode, dragState.status, onMouseMove, onMouseUp, cancelDragLink, scheduled, onLinkCreate]);

  // Resolve effective indices → actual Baseline records, dropping any that
  // don't exist on the project. Preserves caller order so phantom rows
  // render in the array order the consumer passed.
  const resolvedBaselines = useMemo<Baseline[]>(
    () => resolveBaselines(scheduled.baselines, effectiveBaselineIndices),
    [scheduled.baselines, effectiveBaselineIndices],
  );

  const ghostBarsEnabled = resolvedBaselines.length > 0 && (showBaselineBars ?? true);

  // ADR-007: detect unscheduled / split tasks on the full scheduled set
  // (not just renderable — hidden tasks can still carry the flags).
  const hasUnscheduled = useMemo(
    () => projectHasUnscheduledTasks(scheduled.tasks),
    [scheduled.tasks],
  );
  const hasSplitTasks = useMemo(() => projectHasSplitTasks(scheduled.tasks), [scheduled.tasks]);

  // Engine-signal stylesheet for the NATIVE bar path. SVAR renders clean Willow
  // bars (label beside bar, two-tone) and tags each with `data-id=":<id>"` (its
  // setID convention — the same selector SVAR uses internally). We recolour our
  // engine's critical path and outline deadline overruns by overriding SVAR's
  // own theme tokens on those bars — no custom template, so the native look and
  // two-tone progress survive. Only emitted for the default native path; the
  // edit-mode / baseline-ghost template paths draw their own signals.
  const signalCss = useMemo(
    () =>
      editMode || ghostBarsEnabled
        ? null
        : buildSignalCss(scheduled.tasks, ganttScopeClass, {
            critical: effectiveCritical,
            deadline: effectiveDeadline,
          }),
    [
      scheduled.tasks,
      ganttScopeClass,
      editMode,
      ghostBarsEnabled,
      effectiveCritical,
      effectiveDeadline,
    ],
  );

  // Grid-row styling (bold summary rows) — emitted in ALL modes, unlike signalCss.
  // Task highlights (parity row 11): host-supplied sets, e.g. checkSchedule() ids.
  const highlightCss = useMemo(
    () => buildHighlightCss(highlights, ganttScopeClass),
    [highlights, ganttScopeClass],
  );
  // Progress line (parity row 6): points from the engine, drawn by
  // ProgressLineLayer in SVAR's chart area.
  const scheduledTasksById = useMemo(
    () => new Map(scheduled.tasks.map((t) => [String(t.id), t])),
    [scheduled.tasks],
  );
  const progressOptions = typeof progressLine === 'object' ? progressLine : undefined;
  const progressStatus = progressLine
    ? (progressOptions?.statusDate ?? scheduled.statusDate)
    : undefined;
  const progressStatusMs = progressStatus?.getTime();
  const progressBasis = progressOptions?.basis;
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by the date's value, not a host literal's identity
  const progressPts = useMemo(
    () =>
      progressStatus ? progressPoints(scheduled, progressStatus, { basis: progressBasis }) : null,
    [scheduled, progressStatusMs, progressBasis],
  );
  // Task Path (parity row 5): one driving analysis per scheduled project, one
  // cheap query per selection.
  const drivingAnalysis = useMemo(
    () => (taskPath ? analyseDriving(scheduled) : null),
    [taskPath, scheduled],
  );
  const taskPathView = useMemo(() => {
    if (!drivingAnalysis || !taskPath) return null;
    const focus = taskPathFor ?? selectedIds[selectedIds.length - 1];
    return buildTaskPath(drivingAnalysis, focus, taskPath, ganttScopeClass);
  }, [drivingAnalysis, taskPath, taskPathFor, selectedIds, ganttScopeClass]);
  const taskPathCss = taskPathView?.css ?? null;
  // Path links are painted inline (see buildTaskPath), and re-painted whenever
  // SVAR adds or replaces link polylines.
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const roles = taskPathView?.linkRoles;
    const paint = () => paintPathLinks(root, roles);
    paint();
    if (!roles || roles.size === 0) return;
    // Watch SVAR's links <svg> (it may not be mounted yet: wait for it).
    const onLinks = new MutationObserver(paint);
    const watch = (svg: Element) => {
      paint();
      onLinks.observe(svg, { childList: true });
    };
    const svg = root.querySelector('.wx-links');
    const waiting = svg
      ? null
      : new MutationObserver(() => {
          const found = root.querySelector('.wx-links');
          if (!found) return;
          waiting?.disconnect();
          watch(found);
        });
    if (svg) watch(svg);
    else waiting?.observe(root, { childList: true, subtree: true });
    return () => {
      waiting?.disconnect();
      onLinks.disconnect();
    };
  }, [taskPathView]);
  const rowStyleCss = useMemo(
    () => buildRowStyleCss(scheduled.tasks, ganttScopeClass, { boldSummary: boldSummaryRows }),
    [scheduled.tasks, ganttScopeClass, boldSummaryRows],
  );

  // Each task's effective calendar (ADR-011): baseline pills measure in it.
  const calendarOf = useMemo(() => {
    const resolver = createCalendarResolver(scheduled);
    return (t: Task) => resolver.effectiveFor(t).calendar;
  }, [scheduled]);
  const svarTasks: ITask[] = useMemo(
    () =>
      buildSvarTasks(
        renderableTasks,
        resolvedBaselines,
        calendar,
        ghostBarsEnabled,
        editGhostProject ?? undefined,
        baselineRender ?? 'row',
        calendarOf,
      ),
    [
      renderableTasks,
      resolvedBaselines,
      calendar,
      ghostBarsEnabled,
      editGhostProject,
      baselineRender,
      calendarOf,
    ],
  );
  // Only 'selected' link display depends on the selection: a selection change
  // in any other mode (e.g. with taskPath on) must not hand SVAR a new links
  // array, which it re-parses (~220 ms at 5k links).
  const linkSelection = linkDisplay === 'selected' ? selectedIds : NO_SELECTION;
  const svarLinks: ILink[] = useMemo(
    () =>
      filterLinksForDisplay(scheduled.links, scheduled.tasks, linkDisplay, linkSelection).map(
        toSvarLink,
      ),
    [scheduled.links, scheduled.tasks, linkDisplay, linkSelection],
  );

  // View-state reporting (parity row 15). Nothing is cached: the zoom level is
  // read live from SVAR's store at emit time, so a host re-render or a
  // host-applied `zoom.default` can never make a report stale.
  const onViewStateChangeRef = useRef(onViewStateChange);
  onViewStateChangeRef.current = onViewStateChange;
  const zoomConfigRef = useRef(zoom); // init runs once — read the live config
  zoomConfigRef.current = zoom;
  const svarApiRef = useRef<IApi | null>(null);
  // Virtual rows the consumer's project doesn't contain: phantom baseline /
  // edit-preview rows, and groupProject's group rows (Task.group). No edit,
  // structural or selection callback may fire for them.
  const groupRowIdsRef = useRef<Set<string>>(new Set());
  groupRowIdsRef.current = new Set(project.tasks.filter((t) => t.group).map((t) => String(t.id)));
  const isVirtualIdRef = useRef((id: TaskId | null | undefined) =>
    id === null || id === undefined
      ? false
      : isPhantomRowId(id) || groupRowIdsRef.current.has(String(id)),
  );
  const viewStateRef = useRef<Omit<GanttViewState, 'zoom'>>({
    hiddenColumns: doState.hiddenColumns,
    critical: effectiveCritical,
    slack: effectiveSlack,
    deadline: effectiveDeadline,
    badges: effectiveBadges,
    previousStarts: effectivePreviousStarts,
  });
  viewStateRef.current = {
    hiddenColumns: doState.hiddenColumns,
    critical: effectiveCritical,
    slack: effectiveSlack,
    deadline: effectiveDeadline,
    badges: effectiveBadges,
    previousStarts: effectivePreviousStarts,
  };
  const emitViewState = useCallback(() => {
    const cfg = zoomConfigRef.current;
    const api = svarApiRef.current;
    const zoom = cfg
      ? zoomLevelAt(cfg, api ? readSvarZoomLevel(api) : (toSvarZoom(cfg).level ?? -1))
      : undefined;
    onViewStateChangeRef.current?.({ ...viewStateRef.current, ...(zoom ? { zoom } : {}) });
  }, []);
  // Emit only when the toggle state actually changes. A previous-value compare
  // (not a skip-first-run flag) so StrictMode's double effect run is a no-op.
  const prevDoStateRef = useRef(doState);
  useEffect(() => {
    if (prevDoStateRef.current === doState) return;
    prevDoStateRef.current = doState;
    emitViewState();
  }, [doState, emitViewState]);

  // SVAR re-inits its zoom whenever the `zoom` prop's identity changes, which
  // reset the chart to the default level on every host re-render (hosts pass an
  // inline literal). Memoise by value; a real config change still applies.
  const zoomKey = zoom ? `${(zoom.levels ?? []).join(',')}|${zoom.default ?? ''}` : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by value (zoomKey), not identity
  const svarZoom = useMemo(() => (zoom ? toSvarZoom(zoom) : undefined), [zoomKey]);

  // Inline baseline ghosts aren't task rows, so SVAR's auto-scale never widens
  // the timeline for them (phantom rows do): fold their span in, or a baseline
  // before the project start / after its end is clipped off the chart.
  const inlineSpan = useMemo(() => inlineBaselineSpan(svarTasks), [svarTasks]);
  const projectEnd = useMemo(() => {
    const end = getProjectEnd(scheduled);
    return inlineSpan && inlineSpan.end > end ? inlineSpan.end : end;
  }, [scheduled, inlineSpan]);
  const timelineStart = useMemo(() => {
    const start = resolveTimelineStart(scheduled.start, leadInDays);
    return inlineSpan && inlineSpan.start < start ? inlineSpan.start : start;
  }, [scheduled.start, leadInDays, inlineSpan]);
  // Mark calendar referenced even when consumed only by useMemo args (TS unused-let guard)
  void calendar;

  const svarMarkers: SvarMarker[] = useMemo(
    // timelineStart (not project start) so a today inside the lead-in still shows.
    () => resolveMarkers(markers, timelineStart, projectEnd),
    [markers, timelineStart, projectEnd],
  );

  const highlightTime = useMemo(() => buildHighlightTime(calendar), [calendar]);

  // displayOptions (Task 6) base column set: the array the toggle bar's
  // checkboxes are derived from, and the array `svarColumns` below filters
  // through `doState.hiddenColumns`. Only materialised when the bar is on
  // (empty otherwise — no cost, no behaviour change, for the common case).
  // A Predecessors column isn't part of any existing default set, so it's
  // appended here (once) whenever displayOptions is enabled and one isn't
  // already present — this is what lets the bar's "Predecessors" checkbox
  // exist at all without every consumer having to add the column by hand.
  const displayOptionsBaseColumns = useMemo<GanttColumn[]>(() => {
    if (!doEnabled) return [];
    const base = columns ?? DEFAULT_EDIT_COLUMNS;
    if (base.some((c) => c.id === 'predecessors')) return base;
    // MS-Project-style: reference predecessors by row number (matching an ID
    // column) with lag in days, when a calendar is available for the conversion.
    return [
      ...base,
      predecessorsColumn(scheduled.links, {
        tasks: scheduled.tasks,
        ...(calendar ? { minutesPerDay: workingMinutesPerDay(calendar) } : {}),
      }),
    ];
  }, [doEnabled, columns, scheduled.links, scheduled.tasks, calendar]);

  // Column checkboxes for the bar: only the "recognized display columns"
  // (TOGGLEABLE_COLUMN_IDS) get a toggle — a fully-custom column id (e.g. a
  // consumer's WBS-code column) has no natural on/off semantics here, so it
  // stays permanently visible and out of the bar rather than guessing.
  const displayOptionsColumnOptions = useMemo(
    () =>
      displayOptionsBaseColumns
        .filter((c) => (TOGGLEABLE_COLUMN_IDS as readonly string[]).includes(c.id))
        .map((c) => ({ id: c.id, label: c.header })),
    [displayOptionsBaseColumns],
  );

  // Keyboard continuation for the inline editors (parity row 16): Enter /
  // Shift+Enter edit the next / previous row's cell, Tab / Shift+Tab the next
  // / previous editable column; otherwise focus returns to the grid cell.
  // Assigned every render so it always sees current rows and columns.
  const gridNavRef = useRef<GridKeyboardNav | undefined>(undefined);
  // Built lazily at keydown time (not every render — this Gantt re-renders on
  // every drag frame), from the latest rows / columns.
  const navInputsRef = useRef({
    svarTasks,
    columns,
    doEnabled,
    displayOptionsBaseColumns,
    calendar,
  });
  navInputsRef.current = { svarTasks, columns, doEnabled, displayOptionsBaseColumns, calendar };
  if (editMode && !gridNavRef.current) {
    const fieldResolver = () => {
      const n = navInputsRef.current;
      const navColumns = n.doEnabled
        ? n.displayOptionsBaseColumns
        : (n.columns ?? DEFAULT_EDIT_COLUMNS);
      const editableById = new Map(
        navColumns
          .filter((c) => !c.editor && isColumnEditable(c, true))
          .map((c) => [c.id, c.field as EditableField]),
      );
      const rowById = new Map(n.svarTasks.map((r) => [String(r.id), r as SvarTaskWithComputed]));
      const minutesPerDay = n.calendar ? workingMinutesPerDay(n.calendar) : undefined;
      const fieldFor = (rowId: TaskId, colId: string): EditableField | undefined => {
        const field = editableById.get(colId);
        const row = rowById.get(String(rowId));
        if (!field || !row || isPhantomRow(row) || row.is_group_row) return undefined;
        if (
          row.type === 'summary' &&
          (field === 'start' || field === 'end' || field === 'duration')
        ) {
          return undefined;
        }
        return field;
      };
      const cellValue = (rowId: TaskId, field: EditableField) => {
        const row = rowById.get(String(rowId));
        return row ? getInputValue(row as unknown as Task, field, minutesPerDay) : undefined;
      };
      const open = (rowId: TaskId, field: EditableField) => {
        const value = cellValue(rowId, field);
        if (value !== undefined) editStateRef.current.activateCell(rowId, field, value);
      };
      return { fieldFor, open, cellValue, minutesPerDay };
    };
    const rowOrder = () => {
      const api = svarApiRef.current;
      return visibleRowOrder(navInputsRef.current.svarTasks as SvarRowLike[], (id) => {
        const live = api?.getTask(id) as { open?: boolean } | undefined;
        return live?.open ?? true;
      });
    };
    const focusCell = (cell: Element | null) => {
      if (!cell) return;
      const rowAttr = cell.getAttribute('data-row-id');
      const colAttr = cell.getAttribute('data-col-id');
      const root = cell.closest('.wx-gantt') ?? document;
      // After the editor unmounts (next frame), SVAR may have replaced the
      // cell node: re-find it by its row / column ids.
      requestAnimationFrame(() => {
        const target = cell.isConnected
          ? cell
          : rowAttr !== null && colAttr !== null
            ? root.querySelector(cellSelector(rowAttr, colAttr))
            : null;
        (target as HTMLElement | null)?.focus();
      });
    };
    // Each move bumps this; a deferred open (target row not yet rendered)
    // only runs if no newer move happened meanwhile — otherwise fast keying
    // would reopen a stale row after the user has moved on.
    let moveSeq = 0;
    gridNavRef.current = {
      move(fromCell, move, fromRowId) {
        const seq = ++moveSeq;
        const { fieldFor, open } = fieldResolver();
        const canEdit = (r: TaskId, c: string) => fieldFor(r, c) !== undefined;
        if (move === 'next' || move === 'prev') {
          const next = findNextCellInRow(fromCell, move, canEdit);
          const field = next && fieldFor(next.rowId, next.colId);
          if (!next || !field) return false;
          svarFocusCell(svarApiRef.current, next.rowId, next.colId);
          open(next.rowId, field);
          return true;
        }
        // Up / down follow the grid's row order from data — SVAR virtualises
        // rows to the viewport, so the next row may not be in the DOM. Open
        // the editor (a state change) and scroll SVAR's chart to the row with
        // its own `scroll-chart`; the grid body isn't a scroll container, so
        // scrollIntoView does nothing.
        const rowAttr = fromCell.getAttribute('data-row-id');
        const colAttr = fromCell.getAttribute('data-col-id');
        if (rowAttr === null || colAttr === null) return false;
        const colId = String(decodeSvarId(colAttr));
        const api = svarApiRef.current;
        const order = rowOrder();
        const fromId = fromRowId ?? decodeSvarId(rowAttr);
        const at = order.findIndex((id) => String(id) === String(fromId));
        if (at < 0) return false;
        const step = move === 'down' ? 1 : -1;
        for (let i = at + step; i >= 0 && i < order.length; i += step) {
          const rowId = order[i] as TaskId;
          const field = fieldFor(rowId, colId);
          if (!field) continue;
          // Make the target SVAR's focused cell BEFORE opening its editor.
          // Otherwise SVAR keeps the originally clicked cell, and the
          // re-render a scroll triggers refocuses that one — blurring (and so
          // closing) the editor we just opened.
          const root = fromCell.closest('.wx-gantt') ?? document;
          const target = root.querySelector<HTMLElement>(
            cellSelector(encodeSvarId(rowId), colAttr),
          );
          if (target) {
            svarFocusCell(api, rowId, colId);
            open(rowId, field);
            if (api) scrollRowIntoView(api, fromCell, i);
          } else if (api) {
            // Not rendered (virtualised): bring it in, then focus + open.
            scrollRowIntoView(api, fromCell, i);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                if (seq !== moveSeq) return; // superseded by a newer move
                svarFocusCell(api, rowId, colId);
                open(rowId, field);
              }),
            );
          } else {
            open(rowId, field);
          }
          return true;
        }
        return false;
      },
      focusCell,
      isActiveCell(cell) {
        const active = editStateRef.current.activeCell;
        const rowAttr = cell.getAttribute('data-row-id');
        const colAttr = cell.getAttribute('data-col-id');
        if (!active || rowAttr === null || colAttr === null) return false;
        const { fieldFor } = fieldResolver();
        const rowId = decodeSvarId(rowAttr);
        return (
          String(active.taskId) === String(rowId) &&
          fieldFor(rowId, String(decodeSvarId(colAttr))) === active.field
        );
      },
      clipboard(cell) {
        const rowAttr = cell.getAttribute('data-row-id');
        const colAttr = cell.getAttribute('data-col-id');
        const row = cell.closest('.wx-row');
        if (rowAttr === null || colAttr === null || !row) return null;
        const { fieldFor, cellValue, minutesPerDay } = fieldResolver();
        const columns = [...row.querySelectorAll('.wx-cell[data-col-id]')].map((c) =>
          String(decodeSvarId(c.getAttribute('data-col-id') ?? '')),
        );
        return {
          rowId: decodeSvarId(rowAttr),
          colId: String(decodeSvarId(colAttr)),
          columns,
          // Phantom baseline / preview rows aren't sheet rows: a pasted column
          // must land on consecutive tasks.
          rowOrder: rowOrder().filter((id) => !isPhantomRowId(id)),
          fieldFor,
          cellValue,
          minutesPerDay,
          isElapsed: isElapsedTask,
        };
      },
      openAt(cell) {
        const rowAttr = cell.getAttribute('data-row-id');
        const colAttr = cell.getAttribute('data-col-id');
        if (rowAttr === null || colAttr === null) return false;
        const { fieldFor, open } = fieldResolver();
        const rowId = decodeSvarId(rowAttr);
        const field = fieldFor(rowId, String(decodeSvarId(colAttr)));
        if (!field) return false;
        open(rowId, field);
        return true;
      },
    };
  }

  // Keys on a focused grid CELL (not inside an editor):
  //  - the cell whose editor is open (focus briefly sits on it while SVAR
  //    re-focuses / the editor mounts, so fast typing lands here): Enter / Tab
  //    act exactly like the editor's own — commit, then move;
  //  - any other editable cell: Enter / F2 opens its editor (Bryntum / Excel).
  // Window capture phase, filtered to our grid, so it runs before SVAR's grid
  // hotkeys — which would otherwise toggle a summary open/closed on Enter.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'F2' && e.key !== 'Tab') return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (!target?.classList?.contains('wx-cell') || !el.contains(target)) return;
      const nav = gridNavRef.current;
      if (!nav) return;
      if (nav.isActiveCell(target)) {
        if (e.key === 'F2') return;
        const activeId = editStateRef.current.activeCell?.taskId;
        e.preventDefault();
        e.stopPropagation();
        const status = editStateRef.current.commitCell(onTaskEditRef.current, {
          keepOpenIfInvalid: true,
        });
        if (status === 'invalid') return;
        const move: GridMove =
          e.key === 'Enter' ? (e.shiftKey ? 'up' : 'down') : e.shiftKey ? 'prev' : 'next';
        if (!nav.move(target, move, activeId)) nav.focusCell(target);
        return;
      }
      if (e.key === 'Tab' || e.shiftKey) return;
      if (nav.openAt(target)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editMode]);

  // Grid clipboard (parity row 16): paste a block from Excel, copy, fill down —
  // on a focused grid cell, never inside an editor (the browser's own text
  // paste applies there). Window capture, filtered to our grid's cells.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editMode || !gridClipboard) return;
    const ourCell = (node: unknown) =>
      node instanceof HTMLElement && node.classList.contains('wx-cell') && el.contains(node)
        ? node
        : null;
    // Chromium targets copy / paste at the selection's node (often <body>),
    // not the focused cell — so fall back to the focused element. An open
    // editor's <input> is neither, so its own text paste is untouched.
    const focusedCell = (e: Event) => ourCell(e.target) ?? ourCell(document.activeElement);
    const deliver = (plan: ClipboardPlan, source: 'paste' | 'fill') => {
      if (plan.edits.length === 0 && plan.skipped.length === 0) return;
      const batch = onTasksEditRef.current;
      if (batch) batch(plan.edits, { source, skipped: plan.skipped });
      else for (const edit of plan.edits) onTaskEditRef.current?.(edit.id, edit.patch);
    };
    /** Selected rows (in visible order) when the focused row is among several. */
    const selectionWith = (ctx: GridClipboardContext): TaskId[] | null => {
      const selected = new Set(selectedIdsRef.current.map(String));
      if (selected.size < 2 || !selected.has(String(ctx.rowId))) return null;
      return ctx.rowOrder.filter((id) => selected.has(String(id)));
    };
    const onPaste = (e: ClipboardEvent) => {
      const cell = focusedCell(e);
      const ctx = cell && gridNavRef.current?.clipboard(cell);
      if (!ctx) return;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      e.stopPropagation();
      deliver(
        planPaste({
          table: parseClipboardTable(text),
          anchor: { rowId: ctx.rowId, colId: ctx.colId },
          rowOrder: ctx.rowOrder,
          columns: ctx.columns,
          fieldFor: ctx.fieldFor,
          minutesPerDay: ctx.minutesPerDay,
          isElapsed: ctx.isElapsed,
          dateOrder: dateOrderRef.current,
        }),
        'paste',
      );
    };
    const onCopy = (e: ClipboardEvent) => {
      const cell = focusedCell(e);
      const ctx = cell && gridNavRef.current?.clipboard(cell);
      if (!cell || !ctx || !e.clipboardData) return;
      // The user selected some text elsewhere: that's what they're copying.
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && !cell.contains(sel.anchorNode)) return;
      const valueAt = (rowId: TaskId) => {
        const field = ctx.fieldFor(rowId, ctx.colId);
        if (field) return ctx.cellValue(rowId, field) ?? '';
        return String(rowId) === String(ctx.rowId) ? (cell.textContent ?? '') : '';
      };
      const rows = selectionWith(ctx) ?? [ctx.rowId];
      e.clipboardData.setData(
        'text/plain',
        formatClipboardTable(rows.map((id) => [valueAt(id)])).replace(/\n$/, ''),
      );
      e.preventDefault();
      e.stopPropagation();
    };
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      // `code` too: on a non-Latin layout Ctrl+C has key 'с', but SVAR matches `code`.
      const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
      if (key === 'c' || key === 'v' || key === 'x') {
        // SVAR's document-level hotkeys map these to copy / paste / cut-TASK
        // (a copy then paste would insert a ghost row). The grid clipboard
        // owns them on our cells; the default stays, so the browser still
        // fires the native copy / paste events handled above.
        if (focusedCell(e)) e.stopPropagation();
        return;
      }
      if (key !== 'd') return;
      const cell = focusedCell(e);
      const ctx = cell && gridNavRef.current?.clipboard(cell);
      if (!ctx) return;
      e.preventDefault(); // not the browser's bookmark
      e.stopPropagation();
      let rows = selectionWith(ctx);
      if (!rows) {
        const at = ctx.rowOrder.findIndex((id) => String(id) === String(ctx.rowId));
        const above = at > 0 ? ctx.rowOrder[at - 1] : undefined;
        if (above === undefined) return;
        rows = [above, ctx.rowId];
      }
      deliver(
        planFillDown({
          rows,
          colId: ctx.colId,
          fieldFor: ctx.fieldFor,
          cellValue: (rowId) => {
            const field = ctx.fieldFor(rowId, ctx.colId);
            return field ? ctx.cellValue(rowId, field) : undefined;
          },
          minutesPerDay: ctx.minutesPerDay,
          isElapsed: ctx.isElapsed,
        }),
        'fill',
      );
    };
    window.addEventListener('paste', onPaste, true);
    window.addEventListener('copy', onCopy, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('paste', onPaste, true);
      window.removeEventListener('copy', onCopy, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [editMode, gridClipboard]);

  // SVAR's grid focuses its table box on every mousedown, without
  // preventScroll. When the box runs past the viewport (a gantt in the page
  // flow, or one taller than the window), the browser scrolls the page between
  // the two clicks of a double-click, so the second lands on another row and
  // opens that task's editor (CM, 2026-11-09). Capture runs before SVAR's
  // handler, so its focus call gets preventScroll. Pinned to
  // @svar-ui/react-grid 2.6.1 (dist ~line 1324, the body's onMouseDown):
  // re-check on an SVAR upgrade.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('mousedown', focusGridWithoutScroll, true);
    return () => el.removeEventListener('mousedown', focusGridWithoutScroll, true);
  }, []);

  /** Scroll SVAR's chart so row `index` (in visible order) is inside the rows viewport. */
  function scrollRowIntoView(api: IApi, fromCell: Element, index: number) {
    const state = api.getState() as { scrollTop?: number; cellHeight?: number };
    const rowPx = state.cellHeight || fromCell.getBoundingClientRect().height || 1;
    const root = fromCell.closest('.wx-gantt');
    const chart = root?.querySelector('.wx-chart');
    if (!chart) return;
    const scaleH = root?.querySelector('.wx-scale')?.getBoundingClientRect().height ?? 0;
    const viewH = chart.clientHeight - scaleH;
    const top = state.scrollTop ?? 0;
    const rowTop = index * rowPx;
    if (rowTop < top) api.exec('scroll-chart', { top: rowTop });
    else if (rowTop + rowPx > top + viewH)
      api.exec('scroll-chart', { top: rowTop + rowPx - viewH });
    // SVAR's scrollTop lags under fast keying, so the index maths can be off:
    // once the editor has rendered, correct from what's actually on screen.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const input = root?.querySelector<HTMLElement>(`[${EDITOR_ATTR}]`);
        const cell = input?.closest('.wx-cell');
        if (!input || !cell) return;
        const r = cell.getBoundingClientRect();
        const view = chart.getBoundingClientRect();
        const now = (api.getState() as { scrollTop?: number }).scrollTop ?? 0;
        if (r.top < view.top + scaleH) {
          api.exec('scroll-chart', { top: Math.max(0, now - (view.top + scaleH - r.top)) });
        } else if (r.bottom > view.bottom) {
          api.exec('scroll-chart', { top: now + (r.bottom - view.bottom) });
        }
        // Scrolling re-renders SVAR's index-keyed rows, and SVAR then restores
        // focus to its focused cell: hand it back to the open editor.
        requestAnimationFrame(() => {
          const live = root?.querySelector<HTMLElement>(`[${EDITOR_ATTR}]`);
          const active = document.activeElement;
          if (live && active !== live && (active === document.body || root?.contains(active))) {
            live.focus();
          }
        });
      }),
    );
  }

  // Convert a GanttColumn to SVAR's IColumnConfig, injecting the interactive
  // editable-cell renderer for known editable fields in editMode. Not
  // memoised itself (cheap, called only from inside the svarColumns useMemo
  // below); reads editStateRef/onTaskEditRef via stable ref objects, so its
  // recreation every render doesn't affect the memo's correctness.
  const minutesPerDay = calendar ? workingMinutesPerDay(calendar) : undefined;
  const buildDisplayColumn = (col: GanttColumn): IColumnConfig => {
    // Custom-column inline editor (host-app fields, not engine fields) — commits
    // via onCellEdit, self-contained state, no CPM re-run. Takes precedence over
    // the engine-field editable path for a column that declares `editor`.
    if (col.editor && editMode) {
      return {
        ...toSvarColumn(col, minutesPerDay),
        cell: buildCustomEditableCell(col.editor, col.id, onCellEditRef, col.render),
      };
    }
    if (!isColumnEditable(col, editMode)) {
      return toSvarColumn(col, minutesPerDay);
    }
    // Editable: route through buildEditableCell, keeping col.render (if any) as
    // the inactive-cell display so formatting survives (GanttColumn.editable).
    return {
      ...toSvarColumn(col, minutesPerDay),
      cell: buildEditableCell(
        col.field as EditableField,
        editStateRef,
        onTaskEditRef,
        col.render,
        // SVAR grid rows carry `duration` in working DAYS (toSvarTask converts it
        // when a calendar is present); pass the day length so the duration cell
        // displays/seeds in real units instead of feeding days to the
        // minutes-based formatter (a 3-day task must not read "3m").
        calendar ? workingMinutesPerDay(calendar) : undefined,
        gridNavRef,
      ),
    };
  };

  // Convert our SVAR-agnostic GanttColumn[] to SVAR's IColumnConfig[].
  // undefined → don't pass columns to SVAR (use SVAR defaults).
  // [] → pass false to SVAR (hide grid entirely).
  // [...] → convert each column.
  // In editMode, inject interactive cell renderers for known editable fields.
  // When displayOptions is enabled, the base set (Predecessors appended, see
  // displayOptionsBaseColumns above) is filtered through the live
  // hiddenColumns toggle state instead of passing straight through.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editState.activeCell is intentionally used as a dep — editStateRef/onTaskEditRef are accessed at event time via refs, so only activeCell (which changes cell-to-cell) drives column recompute
  const svarColumns: IColumnConfig[] | false | undefined = useMemo(() => {
    if (doEnabled) {
      const visible = visibleColumns(displayOptionsBaseColumns, doState.hiddenColumns);
      if (visible.length === 0) return false;
      return visible.map(buildDisplayColumn);
    }
    if (!editMode) {
      if (columns === undefined) return undefined;
      if (columns.length === 0) return false;
      return columns.map((c) => toSvarColumn(c, minutesPerDay));
    }
    const effectiveCols = columns ?? DEFAULT_EDIT_COLUMNS;
    if (effectiveCols.length === 0) return false;
    return effectiveCols.map(buildDisplayColumn);
  }, [
    columns,
    editMode,
    editState.activeCell,
    doEnabled,
    doState.hiddenColumns,
    displayOptionsBaseColumns,
  ]);

  const taskTemplate = useMemo(() => {
    // Default: no template → SVAR renders its native Willow bars (clean two-tone
    // capsule, label beside the bar, native progress). Critical-path is conveyed
    // by SVAR's own `wx-critical` styling (driven by `task.critical` + the
    // `criticalPath` prop below), so the clean default isn't repainted.
    //
    // A custom bar interior is only needed for the two opt-in modes that draw
    // their own in-bar content: edit-mode (drag-to-link handle) and baseline
    // ghost/variance overlays. Outside those, stay native.
    if (!editMode && !ghostBarsEnabled) return undefined;
    if (!editMode) {
      // Ghost-bars-only path (no edit mode): still need to thread
      // `effectiveSlack` through to ConstructionBar, so wrap rather than
      // returning the bare component reference.
      const GhostBar: FC<{ data: SvarTaskWithComputed }> = ({ data }) => (
        <ConstructionBar data={data} showSlack={effectiveSlack} />
      );
      return GhostBar as FC<{ data: ITask }>;
    }
    // Wrap ConstructionBar with a drag handle at the right edge of each task bar.
    const EditableBar: FC<{ data: SvarTaskWithComputed }> = ({ data }) => (
      <div
        data-task-id={data.id !== undefined ? String(data.id) : undefined}
        style={{ position: 'relative', width: '100%', height: '100%' }}
      >
        <ConstructionBar data={data} showSlack={effectiveSlack} />
        {!data.is_baseline_ghost && !data.is_edit_preview && (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag handle — pointer-down initiates link drag; keyboard alternative (Escape) handled at window level
          <div
            className="construction-gantt-drag-handle"
            onMouseDown={(e) => {
              if (data.id !== undefined) onBarMouseDown(data.id, e);
            }}
            title="Drag to create link"
          />
        )}
      </div>
    );
    return EditableBar as FC<{ data: ITask }>;
  }, [editMode, ghostBarsEnabled, onBarMouseDown, effectiveSlack]);

  // What an export renders: the screen's view at the moment of export (the
  // effective toggles and columns, the zoom level, the selection), read at
  // call time. Every key required: adding an exportable prop without
  // forwarding it here a type error (export/offscreen.tsx NotExported).
  const exportViewRef = useRef<() => Parameters<typeof exportViewProps>[0]>(() => {
    throw new Error('export before first render');
  });
  exportViewRef.current = () => {
    const api = svarApiRef.current;
    const props: { [K in keyof Required<OffscreenGanttProps>]: OffscreenGanttProps[K] } = {
      // SVAR's live width: a wheel step inside a zoom level changes it.
      cellWidth: (api?.getState() as { cellWidth?: number } | undefined)?.cellWidth ?? cellWidth,
      cellHeight,
      markers,
      baselineIndex,
      baselineIndices,
      showBaselineBars,
      baselineRender,
      columns,
      boldSummaryRows,
      leadInDays,
      visibleTaskIds,
      linkDisplay,
      taskPath,
      taskPathFor,
      progressLine,
      highlights,
      taskBadges,
      previousStart,
      zoom,
      locale,
      showCritical,
      showSlack,
      showDeadline,
    };
    const cfg = zoomConfigRef.current;
    return {
      scheduled,
      props,
      columns: doEnabled
        ? visibleColumns(displayOptionsBaseColumns, doState.hiddenColumns)
        : (columns ?? (editMode ? DEFAULT_EDIT_COLUMNS : undefined)),
      critical: effectiveCritical,
      slack: effectiveSlack,
      deadline: effectiveDeadline,
      badges: effectiveBadges,
      previousStarts: effectivePreviousStarts,
      zoomLevel: cfg && api ? zoomLevelAt(cfg, readSvarZoomLevel(api)) : undefined,
      selectedIds: selectedIdsRef.current,
    };
  };
  const exportArgs = useCallback(
    () => ({
      ...exportViewProps(exportViewRef.current()),
      themeVars: readThemeTokens(containerRef.current),
    }),
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      async exportPNG(options?: PngExportOptions): Promise<Blob> {
        const { exportPNG } = await import('./export/png.js');
        return exportPNG({ ...exportArgs(), options: options ?? {} });
      },
      async exportPDF(options?: PdfExportOptions): Promise<Blob> {
        const { exportPDF } = await import('./export/pdf.js');
        return exportPDF({ ...exportArgs(), options: options ?? {} });
      },
      async exportXLSX(options?: XlsxExportOptions): Promise<Blob> {
        const { exportXLSX } = await import('./export/xlsx.js');
        return exportXLSX({ scheduled, visibleTaskIds, options: options ?? {} });
      },
    }),
    [exportArgs, scheduled, visibleTaskIds],
  );

  // Build chrome component props from the agnostic config values, memoised at
  // render time. The chrome siblings are gated on `svarApi` in the JSX below,
  // so they mount only after SVAR's init delivers the IApi (see note at svarApi).
  const svarToolbarItems = useMemo(() => {
    // `toolbar === true` (SVAR's raw defaults, boolean flag): use the
    // tooltip-corrected default array (Task 5) instead of leaving `items`
    // unset, which would let SVAR fall back to its own mislabeled defaults.
    if (toolbar === true) return correctedToolbarButtons() as ReturnType<typeof toSvarToolbar>;
    return toolbar && typeof toolbar !== 'boolean' ? toSvarToolbar(toolbar) : undefined;
  }, [toolbar]);
  const svarContextMenuOptions = useMemo(
    () =>
      contextMenu && typeof contextMenu !== 'boolean' ? toSvarContextMenu(contextMenu) : undefined,
    [contextMenu],
  );
  const svarEditorItems = useMemo(
    () => (editor && typeof editor !== 'boolean' ? toSvarEditorItems(editor) : undefined),
    [editor],
  );
  const editorPlacement = editor && typeof editor !== 'boolean' ? editor.placement : undefined;

  // TooltipWrapper is a stable render component created once per tooltip function.
  // We need to close over `tooltip` but keep the component stable (no anonymous
  // FC per render — useMemo on the component factory avoids unnecessary remounts).
  const TooltipContent: FC<{ data: ITask }> | undefined = useMemo(() => {
    // `false` disables the tooltip entirely; omitted → built-in default; a
    // function → the consumer's tooltip (overrides the default).
    if (tooltip === false) return undefined;
    const tooltipFn = tooltip;
    const Wrapper: FC<{ data: ITask }> = ({ data }) => {
      // SVAR may invoke the content component with no row data (e.g. before a
      // task is hovered); render nothing rather than dereferencing undefined.
      if (!data) return null;
      const svar = data as SvarTaskWithComputed;
      // F2 fix: SVAR invokes the tooltip for every hovered bar including
      // baseline-ghost and edit-preview phantom rows. Return null for phantoms
      // so consumers never see phantom data passed to their tooltip function.
      if (isPhantomRow(svar)) return null;
      // Default built-in tooltip reads the SVAR display fields directly (duration
      // already in working-days, computed flags in snake_case).
      if (!tooltipFn) return <ConstructionTooltip data={svar} />;
      // Custom tooltip: map SVAR ITask back to our Task shape (display fields +
      // the carry-through `extra` and `deadline`). scheduleMode is a display-only
      // sentinel; duration is in SVAR working-days, not engine minutes.
      const task: Task = {
        id: data.id as TaskId,
        text: (data.text as string) ?? '',
        type: (data.type as Task['type']) ?? 'task',
        scheduleMode: 'auto',
        start: data.start as Date,
        end: data.end as Date,
        duration: (data.duration as number) ?? 0,
        progress: (data.progress as number) ?? 0,
        parent: data.parent as TaskId | undefined,
        ...(svar.extra !== undefined ? { extra: svar.extra } : {}),
        ...(svar.codes !== undefined ? { codes: svar.codes } : {}),
        ...(svar.deadline !== undefined ? { deadline: svar.deadline } : {}),
      };
      return <>{tooltipFn(task)}</>;
    };
    return Wrapper;
  }, [tooltip]);

  // The SVAR Gantt element. When `contextMenu` is enabled it must be WRAPPED by
  // SvarContextMenu, NOT placed as a sibling: SVAR's ContextMenu renders a
  // `<span onContextMenu>` over its CHILDREN and only opens for right-clicks
  // inside that subtree (verified in @svar-ui/react-menu dist). A bare sibling
  // has no DOM to listen on, so the menu never opens. ContextMenu is api-tolerant
  // (its api use lives in a guarded effect, not in render), so it can wrap from
  // the first paint with api=undefined without crashing or remounting the Gantt.
  const ganttElement = (
    <SvarGantt
      tasks={svarTasks}
      links={svarLinks}
      // Stable reference: SVAR's wrapper defaults `selected` to a fresh [] each
      // render, and its init() re-applies any changed key — so every re-render
      // (a new project, a links change) used to wipe the user's selection.
      selected={NO_SELECTION}
      start={timelineStart}
      end={projectEnd}
      cellWidth={cellWidth}
      cellHeight={cellHeight}
      highlightTime={highlightTime}
      taskTemplate={taskTemplate}
      init={(api) => {
        setSvarApi(api);
        // Zoom → onViewStateChange. `zoom-scale` handlers run after SVAR's
        // reducer, so getState().zoom.level is the new level index; report only
        // when the named level actually changes (wheel steps within a level don't).
        // Zoom → onViewStateChange. Capture the level just before each
        // zoom-scale and compare after (handlers run post-reducer): wheel steps
        // within a level don't change it and aren't reported.
        svarApiRef.current = api;
        let levelBeforeZoom = -1;
        api.intercept('zoom-scale', () => {
          levelBeforeZoom = readSvarZoomLevel(api);
          return true;
        });
        api.on('zoom-scale', () => {
          if (!zoomConfigRef.current) return;
          if (readSvarZoomLevel(api) === levelBeforeZoom) return;
          emitViewState();
        });
        // Native selection → onTaskSelect. SVAR fires `select-task` with the
        // selected task id (confirmed in @svar-ui/gantt-store). Read-only, non-
        // blocking — registered regardless of editMode (selection is a read gesture).
        api.on('select-task', (ev: { id?: TaskId }) => {
          // Never surface a phantom baseline/edit-preview row to the consumer —
          // that id doesn't exist in their project (CM runs baselines[0] +
          // onTaskSelect in prod).
          // Read SVAR's post-reducer selection, not ev.id: a toggle can remove
          // the id, and ctrl-click multi-selects.
          const ids = ((api.getState().selected ?? []) as TaskId[]).filter(
            (id) => !isVirtualIdRef.current(id),
          );
          selectedIdsRef.current = ids;
          if (linkDisplayRef.current === 'selected' || taskPathRef.current) setSelectedIds(ids);
          if (ev.id !== undefined && !isVirtualIdRef.current(ev.id))
            onTaskSelectRef.current?.(ev.id);
        });
        // Built-in Edit gesture → onTaskEditRequest. SVAR's "Edit" context-menu
        // item and a task double-click both dispatch `show-editor` ({ id }); an
        // `{ id: null }` is its close/escape path. When the consumer wires
        // onTaskEditRequest, veto SVAR's built-in Editor modal (return false) and
        // hand them the id so they open their own editor. Registered regardless
        // of editMode — like select-task, this is a routing gesture, not a
        // structural mutation.
        api.intercept('show-editor', (ev: { id?: TaskId | null }) => {
          // A phantom ghost row is not editable — veto SVAR's built-in Editor and
          // don't route it to the consumer's editor either.
          if (isVirtualIdRef.current(ev.id)) return false;
          const id = resolveEditRequest(ev, onTaskEditRequestRef.current != null);
          if (id === null) return true;
          onTaskEditRequestRef.current?.(id);
          return false;
        });
        if (editMode) {
          // Bridge SVAR-native bar drag/resize (and Editor-modal field edits) into
          // our edit pipeline. Without this, SVAR mutates only its own internal
          // task store on a drag — our engine never re-runs (successors don't
          // cascade) and the change never reaches the dirty/commit pipeline.
          //
          // Two entry points, one pipeline.
          //
          // Bar DRAG / RESIZE / MOVE: SVAR encodes the displacement in `ev.diff`
          // (scale columns) and leaves `ev.task` holding the ORIGINAL dates — it
          // shifts them only in its own store reducer, which runs *after* intercept
          // handlers. Bridging such an event at intercept time reads the unchanged
          // dates and produces an original→original no-op: the edit fires (dirty)
          // but with zero positional delta, so nothing cascades (Finding-A). So we
          // let drags pass through intercept (return true), let SVAR's reducer
          // compute the new dates (it rewrites `ev.task` to the computed task), and
          // bridge the *computed* dates in the `on('update-task')` handler below.
          //
          // Direct field / Editor-modal edits: `ev.task` already carries real
          // values and no `diff`. Intercept-and-own — return false to veto SVAR's
          // optimistic mutation and route through onTaskEdit, keeping our engine the
          // single source of truth (ADR-005). A timing change pins the task to
          // manual (svarUpdateToPatch) so auto successors cascade off the new dates.
          // Unmappable deltas (e.g. duration-only, no dates) yield an empty patch —
          // let SVAR handle those.
          type SvarUpdateEvent = { id: TaskId; task: Partial<ITask>; diff?: unknown };
          const bridgeUpdate = (ev: SvarUpdateEvent) => {
            // Fall through to SVAR's native handling when no consumer handler is
            // wired (or the delta maps to nothing) — matching the structural
            // intercepts below. Vetoing an unwired edit turns the gesture into a
            // silent no-op instead of letting SVAR apply it (F3).
            const patch = resolveDirectEdit(ev.task, onTaskEditRef.current != null);
            if (!patch) return false;
            onTaskEditRef.current?.(ev.id, patch);
            return true;
          };
          api.intercept('update-task', (ev: SvarUpdateEvent) => {
            // A drag/edit on a phantom ghost row has no real task behind it —
            // veto SVAR's mutation and never bridge it to onTaskEdit.
            if (isVirtualIdRef.current(ev.id)) return false;
            // Drags carry a diff → defer to SVAR's reducer + the on-handler below.
            if (isSvarDragEvent(ev)) return true;
            // Direct edit: bridge now and veto SVAR's optimistic mutation
            // (bridgeUpdate returns true when it bridged → veto by returning false).
            return !bridgeUpdate(ev);
          });
          api.on('update-task', (ev: SvarUpdateEvent) => {
            // Runs after SVAR's reducer shifted the dates and rewrote `ev.task`.
            // Only drags reach here — direct edits were vetoed in intercept, so
            // their default action (and this handler) never ran.
            if (isVirtualIdRef.current(ev.id)) return;
            if (!isSvarDragEvent(ev)) return;
            bridgeUpdate(ev);
          });

          // Bridge SVAR's native structural mutations (toolbar/menu-triggered
          // delete/add/reorder/indent) into our onTask* callbacks, same
          // intercept-and-veto pattern as update-task above: classify the SVAR
          // event, fire the matching callback, and return false so SVAR's own
          // optimistic store mutation never happens — the engine (via the
          // consumer's Project update) stays the single source of truth (ADR-005).
          //
          // Row drag-and-drop reordering dispatches `move-task` with a different
          // shape (`mode: 'before'|'after'` + `inProgress`) than the toolbar/menu
          // "Move up"/"Move down" actions this bridges (`mode: 'up'|'down'`,
          // verified in @svar-ui/react-gantt's row-drag handler); it is not
          // classified here and falls through to SVAR's default handling.
          //
          // Copy/paste (`copy-task`/`paste-task`) is deferred to Task 9.
          //
          // Each case only vetoes SVAR's optimistic mutation when the matching
          // onTask* callback is actually wired. An editMode consumer that hasn't
          // wired a given structural callback (e.g. a stories file that only
          // wires onTaskEdit/onLinkCreate/onLinkDelete) falls through to SVAR's
          // native handling instead of the action becoming a silent no-op.
          const STRUCTURAL = ['delete-task', 'add-task', 'move-task', 'indent-task'];
          for (const evName of STRUCTURAL) {
            api.intercept(evName, (ev: Record<string, unknown>) => {
              const edit = classifyStructuralEvent(evName, ev);
              if (!edit) return true;

              // Veto any structural gesture whose subject or drop-target is a
              // phantom baseline/edit-preview row. Move/Indent on a ghost would
              // throw an uncaught EditError inside SVAR's dispatch; add-child on a
              // ghost would silently create a top-level task. The phantom id
              // exists only in SVAR's store, never in projectRef — acting on it is
              // never correct, so no-op the gesture.
              const subjectId = 'id' in edit ? edit.id : undefined;
              const targetId = 'target' in edit ? edit.target : undefined;
              if (isVirtualIdRef.current(subjectId) || isVirtualIdRef.current(targetId))
                return false;

              // Bolt-in path (ADR-010): when onStructuralCommit is wired it owns
              // every structural gesture — build the commit, emit the change set +
              // scheduled project, veto SVAR's optimistic mutation. Takes
              // precedence over the individual onTask* callbacks.
              if (onStructuralCommitRef.current) {
                const result = buildStructuralCommit(projectRef.current, edit, STRUCTURAL_DEPS);
                // null = the engine couldn't build/rejected the op (unresolvable
                // reorder, or an EditError the command threw — e.g. the cycle
                // guard on a drop-under-own-descendant). When onStructuralCommit
                // OWNS structural state (ADR-010), letting SVAR apply the gesture
                // to its own store would diverge it from the consumer's project
                // (which never updates), surfacing as a revert on the next
                // render — or, for a rejected cycle, as an illegal nest SVAR
                // shows but the consumer never persists. Veto so the gesture
                // visibly no-ops instead.
                if (!result) return false;
                // A filtered view (visibleTaskIds) re-roots orphaned rows, so a
                // drop / add next to one can resolve under a summary the user
                // can't see: refuse it rather than file work out of sight.
                if (
                  placesUnderHidden(
                    result.changes,
                    projectRef.current.tasks,
                    visibleTaskIdsRef.current,
                  )
                )
                  return false;
                onStructuralCommitRef.current(result.changes, result.nextProject);
                return false;
              }

              switch (edit.kind) {
                case 'delete':
                  if (!onTaskDeleteRef.current) return true;
                  onTaskDeleteRef.current(edit.id);
                  return false;
                case 'move':
                  if (!onTaskReorderRef.current) return true;
                  onTaskReorderRef.current(edit.id, edit.direction);
                  return false;
                case 'indent':
                  if (!onTaskIndentRef.current) return true;
                  onTaskIndentRef.current(edit.id, edit.direction);
                  return false;
                case 'add': {
                  if (!onTaskAddRef.current) return true;
                  const position = resolveAddPosition(projectRef.current, edit);
                  if (
                    placesUnderHidden(
                      [{ parent: position.parent }],
                      projectRef.current.tasks,
                      visibleTaskIdsRef.current,
                    )
                  )
                    return false;
                  onTaskAddRef.current(edit.task, position);
                  return false;
                }
                default:
                  // 'reorder' (row drag-drop) has no thin onTask* equivalent —
                  // without onStructuralCommit it falls through to SVAR's native
                  // handling (unchanged pre-bolt-in behavior).
                  return true;
              }
            });
          }
        }
      }}
      {...(hasUnscheduled ? { unscheduledTasks: true } : {})}
      {...(hasSplitTasks ? { splitTasks: true } : {})}
      {...(svarColumns !== undefined ? { columns: svarColumns as IColumnConfig[] } : {})}
      {...(svarZoom ? { zoom: svarZoom } : {})}
    />
  );
  const ganttWithMenu = (
    // The bar template reads SVAR's live scale through this (inline ghosts).
    <SvarApiContext.Provider value={svarApi}>
      {contextMenu ? (
        <SvarContextMenu
          api={svarApi ?? undefined}
          {...(svarContextMenuOptions
            ? {
                options: svarContextMenuOptions as Parameters<typeof SvarContextMenu>[0]['options'],
              }
            : {})}
        >
          {ganttElement}
        </SvarContextMenu>
      ) : (
        ganttElement
      )}
    </SvarApiContext.Provider>
  );

  // Assemble the chrome + gantt content (without locale wrapper).
  const chromeContent = (
    // biome-ignore lint/a11y/noStaticElementInteractions: gantt container — link-delete click is an optional editing affordance, not a primary interaction target
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard alternative (Delete key) is out of scope for v0.4; Escape already handled in drag listener
    <div
      ref={containerRef}
      className={ganttScopeClass}
      style={{ display: 'flex', flexDirection: 'column', position: 'relative', height }}
      onClick={
        editMode && onLinkDelete
          ? (e) => {
              // SVAR-internal: dependency arrows render as <polyline class="wx-line ..."> with
              // data-link-id holding the link id. Re-verify on SVAR upgrades by searching
              // node_modules/@svar-ui/react-gantt/dist/index.es.js for "wx-line" + "data-link-id".
              const el = (e.target as Element).closest('.wx-line');
              if (!el) return;
              const linkId = el.getAttribute('data-link-id');
              if (!linkId) return;
              // F1 fix: el.getAttribute always returns a string; consumers with numeric link ids
              // would fail a strict-equality check. Mirror the drag-to-link target-resolution pattern
              // (project.tasks.find with String() coercion) to recover the original typed LinkId.
              const resolved = scheduled.links.find((l) => String(l.id) === linkId);
              onLinkDelete(resolved ? resolved.id : linkId);
            }
          : undefined
      }
    >
      {doEnabled && (
        <DisplayOptionsBar
          state={doState}
          columnOptions={displayOptionsColumnOptions}
          showColumns={showDoColumns}
          showSignals={showDoSignals}
          onToggleColumn={(id) => doDispatch({ kind: 'toggleColumn', id })}
          onToggleSignal={(signal) => doDispatch({ kind: 'toggleSignal', signal })}
          hasBadges={!!taskBadges}
          hasPreviousStarts={!!previousStart}
        />
      )}
      {signalCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own task ids + fixed colour literals, no user HTML
        <style dangerouslySetInnerHTML={{ __html: signalCss }} />
      )}
      <MarkersLayer api={svarApi} root={containerRef} markers={svarMarkers} />
      {((taskBadges && effectiveBadges) || (previousStart && effectivePreviousStarts)) && (
        <TaskBadgesLayer
          api={svarApi}
          root={containerRef}
          tasksById={scheduledTasksById}
          {...(taskBadges && effectiveBadges ? { badges: taskBadges } : {})}
          {...(previousStart && effectivePreviousStarts ? { previousStart } : {})}
          {...(onTaskBadgeClick ? { onClick: onTaskBadgeClick } : {})}
        />
      )}
      {progressPts && progressStatus && (
        <ProgressLineLayer
          api={svarApi}
          root={containerRef}
          points={progressPts}
          statusDate={progressStatus}
          {...(progressOptions?.color ? { color: progressOptions.color } : {})}
        />
      )}
      {highlightCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from task ids (escaped) + host colours, no user HTML
        <style dangerouslySetInnerHTML={{ __html: highlightCss }} />
      )}
      {taskPathCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own task / link ids (escaped) + fixed colour tokens, no user HTML
        <style dangerouslySetInnerHTML={{ __html: taskPathCss }} />
      )}
      {rowStyleCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own task ids + a fixed font-weight literal, no user HTML
        <style dangerouslySetInnerHTML={{ __html: rowStyleCss }} />
      )}
      {toolbar && svarApi && (
        <div style={{ flexShrink: 0 }}>
          <SvarToolbar api={svarApi} {...(svarToolbarItems ? { items: svarToolbarItems } : {})} />
        </div>
      )}
      {/* Gantt chart area. `flex: 1` claims the remaining vertical space left
       * over from the toolbar (and footer, below) instead of the full
       * container `height`; `minHeight: 0` lets it shrink below its content's
       * natural size inside the flex column (the default `min-height: auto`
       * on a flex item would otherwise let SVAR's internal `height: 100%`
       * push the container taller than `height`, overflowing the page in
       * fullscreen/toolbar layouts). `position: relative` keeps this as the
       * anchor for the Editor/Tooltip overlays, which position against the
       * chart, not the outer (toolbar+chart+footer) container. */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {ganttWithMenu}
        {editor && svarApi && (
          <SvarEditor
            api={svarApi}
            {...(svarEditorItems ? { items: svarEditorItems } : {})}
            {...(editorPlacement ? { placement: editorPlacement } : {})}
          />
        )}
        {TooltipContent && svarApi && <SvarTooltip api={svarApi} content={TooltipContent} />}
        {editMode && dragState.status === 'dragging' && (
          <svg
            aria-hidden="true"
            style={{
              position: 'fixed',
              inset: 0,
              width: '100vw',
              height: '100vh',
              pointerEvents: 'none',
              zIndex: 9999,
            }}
          >
            <line
              x1={dragState.startX}
              y1={dragState.startY}
              x2={dragState.cursorX}
              y2={dragState.cursorY}
              stroke="rgba(59,130,246,0.8)"
              strokeWidth={2}
              strokeDasharray="6 3"
            />
          </svg>
        )}
      </div>
      {chartPanels && chartPanels.length > 0 && (
        <ChartPanelsLayer
          api={svarApi}
          root={containerRef}
          project={scheduled}
          panels={chartPanels}
        />
      )}
      {footer && <div style={{ flexShrink: 0 }}>{footer}</div>}
    </div>
  );

  // Wrap in SVAR's Willow theme. Without the theme wrapper the gantt renders
  // essentially unstyled — browser-default serif font, no grid borders or
  // header chrome — because SVAR's clean default styling (font, borders,
  // spacing, calm color tokens) is scoped under the theme class Willow applies.
  const themed = <SvarWillow fonts>{chromeContent}</SvarWillow>;

  // Task 3.7: locale wrapping — when `locale` is supplied, wrap the themed
  // chrome+gantt tree in <SvarLocale> so SVAR components read locale context.
  if (locale) {
    return <SvarLocale words={locale}>{themed}</SvarLocale>;
  }

  return themed;
});

/**
 * In-bar status pill style. Colours read `--cg-pill-<kind>-bg` / `-color`
 * tokens (kinds: slip, ahead, float, late, deadline, deadline-missed) so a host
 * can re-skin them like the `--wx-*` bar tokens; the literals are the defaults.
 */
function pillStyle(kind: string, bg: string, fg: string, fontWeight = 700): CSSProperties {
  return {
    position: 'relative',
    zIndex: 1,
    padding: '0 6px',
    background: `var(--cg-pill-${kind}-bg, ${bg})`,
    color: `var(--cg-pill-${kind}-color, ${fg})`,
    borderRadius: 3,
    fontSize: 10,
    fontWeight,
    lineHeight: '16px',
    whiteSpace: 'nowrap',
  };
}

export const ConstructionBar: FC<{ data: SvarTaskWithComputed; showSlack?: boolean }> = ({
  data,
  showSlack = true,
}) => {
  // Label-overflow detection: when the in-bar label is clipped (bar too narrow),
  // render it BESIDE the bar instead — matching SVAR's native `.wx-text-out` and
  // Buildertrend. The inside <span> stays mounted (visually hidden) so the
  // measurement is stable and doesn't flip-flop. Hooks must precede early returns.
  const labelRef = useRef<HTMLSpanElement>(null);
  const [labelOverflows, setLabelOverflows] = useState(false);
  const svarApiForGhost = useContext(SvarApiContext);
  useLayoutEffect(() => {
    const el = labelRef.current;
    if (!el) return;
    // +1 tolerance for sub-pixel rounding. Measure once now, then only on actual
    // size changes via ResizeObserver — NOT every render (avoids per-bar reflow
    // thrash on large schedules) and catches CSS/zoom-driven width changes that
    // don't re-render this template.
    const measure = () => setLabelOverflows(el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.parentElement) ro.observe(el.parentElement);
    return () => ro.disconnect();
    // Empty deps: set up once per bar instance. The same <span> node persists
    // across text updates (React patches its content in place), and the observer
    // re-measures on any resulting size change — so no dep is needed or read here.
  }, []);

  if (data.is_edit_preview) {
    return <div className="construction-gantt-edit-preview" />;
  }
  // Phantom baseline row — render a slim outlined ghost bar.
  if (data.is_baseline_ghost) {
    const baselineIdx = data.baseline_index ?? 0;
    const phantomSlipped = data.is_slipped ?? false;
    const phantomAhead = data.is_ahead ?? false;
    return (
      <div
        className={`construction-gantt-baseline-ghost construction-gantt-baseline-${baselineIdx}`}
        title="Baseline position — where this task was when the baseline was captured"
      >
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{data.text}</span>
        {phantomSlipped && (
          <span
            style={pillStyle('slip', '#fed7aa', '#7c2d12')}
            title="Drifted later than the baseline"
          >
            +{workingMinutesToShortLabel(data.start_variance ?? 0, data)}
          </span>
        )}
        {phantomAhead && (
          <span style={pillStyle('ahead', '#bbf7d0', '#14532d')} title="Ahead of the baseline">
            −{workingMinutesToShortLabel(data.start_variance ?? 0, data)}
          </span>
        )}
      </div>
    );
  }

  // Inline baseline ghost (milestones never carry one), placed exactly as SVAR
  // places bars: `data` is SVAR's task copy, so `$x` is this bar's own x.
  const barX = (data as { $x?: unknown }).$x;
  const ghost =
    data.baseline_inline && svarApiForGhost && typeof barX === 'number'
      ? svarGhostBox(
          svarApiForGhost.getState() as unknown as SvarScaleState,
          data.baseline_inline,
          barX,
        )
      : null;
  const isCritical = data.is_critical ?? false;
  const isLate = data.is_late ?? false;
  const isSummary = data.type === 'summary';
  const isMilestone = data.type === 'milestone';

  if (isMilestone) {
    // Let SVAR's themed milestone diamond show bare (matches the demo); the
    // label lives in the grid. Empty content keeps the diamond shape intact.
    return <div style={{ width: '100%', height: '100%' }} />;
  }

  const isSlipped = data.is_slipped ?? false;
  const isAhead = data.is_ahead ?? false;
  // Show slack indicator for non-critical, non-summary, non-milestone tasks
  // with at least half a working day of total float. Skips the noise of "+5m"
  // pills on the visually-critical path tasks.
  const totalSlack = data.total_slack ?? 0;
  const showSlackIndicator = !isSummary && !isCritical && totalSlack >= 270 && showSlack; // >= 30 min more than half a day
  const hasDeadline = data.deadline != null;
  const deadlineMissed = data.deadline_missed ?? false;

  // Bar fill: defer entirely to SVAR's Willow theme tokens so our bars match
  // the renderer's clean default look (and re-skin with any consumer theme /
  // the `--wx-*` surface, as CM did). SVAR two-tones every bar — a lighter
  // TRACK with a darker PROGRESS portion for % complete — so we replicate that:
  //  - track  = the `-color` token (lighter); transparent for normal/summary so
  //    SVAR's own themed base bar shows through, overridden only for critical
  //    (SVAR's free renderer can't colour our engine-computed critical path).
  //  - fill   = the `-fill-color` token (darker), drawn to `progress`% width.
  const trackBg = isSummary
    ? isCritical
      ? 'var(--wx-gantt-summary-critical-color, #d9306f)'
      : 'transparent'
    : isCritical
      ? 'var(--wx-gantt-task-critical-color, #de3a3a)'
      : 'transparent';
  const fillBg = isSummary
    ? isCritical
      ? 'var(--wx-gantt-summary-critical-fill-color, #c32b64)'
      : 'var(--wx-gantt-summary-fill-color, #099f81)'
    : isCritical
      ? 'var(--wx-gantt-task-critical-fill-color, #c83434)'
      : 'var(--wx-gantt-task-fill-color, #1f6bd9)';
  const progressPct = Math.max(0, Math.min(100, data.progress ?? 0));
  const pills =
    isSlipped || isAhead || showSlackIndicator || isLate || hasDeadline ? (
      <>
        {isSlipped && (
          <span
            style={pillStyle('slip', '#fed7aa', '#7c2d12')}
            title="Drifted later than the baseline"
          >
            +{workingMinutesToShortLabel(data.start_variance ?? 0, data)}
          </span>
        )}
        {isAhead && (
          <span style={pillStyle('ahead', '#bbf7d0', '#14532d')} title="Ahead of the baseline">
            −{workingMinutesToShortLabel(data.start_variance ?? 0, data)}
          </span>
        )}
        {showSlackIndicator && (
          <span
            style={pillStyle('float', '#dbeafe', '#1e3a8a', 600)}
            title="Total float — how much this task can slip before becoming critical"
          >
            {workingMinutesToShortLabel(totalSlack, data)} float
          </span>
        )}
        {isLate && (
          <span
            style={pillStyle('late', '#fde68a', '#78350f')}
            title="Negative slack — contract trouble"
          >
            {workingMinutesToShortLabel(data.total_slack ?? 0)} late
          </span>
        )}
        {hasDeadline && (
          <span
            style={
              deadlineMissed
                ? pillStyle('deadline-missed', '#fecaca', '#7f1d1d')
                : pillStyle('deadline', '#fde68a', '#78350f')
            }
            title={
              deadlineMissed
                ? 'Past deadline — sectional completion at risk'
                : 'Deadline — sectional completion target'
            }
          >
            {deadlineMissed
              ? `${workingMinutesToShortLabel(Math.abs(data.deadline_slack ?? 0))} over deadline`
              : '⚑ deadline'}
          </span>
        )}
      </>
    ) : null;

  return (
    <div
      className={deadlineMissed ? 'construction-gantt-deadline-missed' : undefined}
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        height: '100%',
        padding: '0 8px',
        // visible (not hidden) so an inline baseline underlay extending below /
        // beyond the live bar isn't clipped, and so an overflowing label can
        // spill BESIDE the bar; label text otherwise clips at the child span.
        overflow: ghost || labelOverflows ? 'visible' : 'hidden',
        fontSize: 'var(--wx-font-size-sm, 12px)',
        fontWeight: isSummary ? 600 : 500,
        color: 'var(--wx-gantt-task-font-color, #fff)',
        background: trackBg,
        borderRadius: 'var(--wx-gantt-bar-border-radius, 3px)',
      }}
    >
      {ghost && (
        <div
          className="construction-gantt-baseline-inline"
          // px from SVAR's bar box; this content box sits inside its 1 px border.
          style={{ left: `${ghost.left - 1}px`, width: `${ghost.width}px` }}
        />
      )}
      {progressPct > 0 && (
        <div
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${progressPct}%`,
            background: fillBg,
            zIndex: 0,
          }}
        />
      )}
      {/* In-bar label — stays mounted for a stable overflow measurement; hidden
          (not unmounted) when it spills beside, so scrollWidth>clientWidth holds. */}
      <span
        ref={labelRef}
        style={{
          position: 'relative',
          zIndex: 1,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          visibility: labelOverflows ? 'hidden' : 'visible',
        }}
      >
        {data.text}
      </span>
      {/* Pills (slip/ahead/float/late/deadline). While the label spills beside
          the bar they move out with it — after the text — so they never sit on
          top of it; the in-bar copy stays laid out but hidden, keeping the
          label's overflow measurement stable (no flip-flop). */}
      {pills && (
        <span
          data-cg-pills=""
          style={{
            position: 'relative',
            zIndex: 1,
            display: 'flex',
            gap: 6,
            flexShrink: 0,
            visibility: labelOverflows ? 'hidden' : 'visible',
          }}
        >
          {pills}
        </span>
      )}
      {/* Overflow label beside the bar (matches SVAR native `.wx-text-out`). */}
      {labelOverflows && (
        <span
          className="construction-gantt-bar-label-out"
          style={{
            position: 'absolute',
            left: '100%',
            marginLeft: 6,
            zIndex: 1,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            whiteSpace: 'nowrap',
            fontWeight: isSummary ? 600 : 500,
            color: 'var(--wx-color-font, #334155)',
            pointerEvents: 'none',
          }}
        >
          {data.text}
          {/* Hoverable (unlike the label text) so pill titles still explain them. */}
          {pills && <span style={{ display: 'flex', gap: 6, pointerEvents: 'auto' }}>{pills}</span>}
        </span>
      )}
    </div>
  );
};

const TOOLTIP_ASSIGNEE_KEYS = [
  'assignee',
  'assignedSubName',
  'assignedTo',
  'assigneeName',
  'owner',
];

/** Best-effort assignee from the carry-through `extra` bag — checks a few common
 *  keys so the default tooltip shows a name when the host app supplies one. */
function pickAssignee(extra: Record<string, unknown> | undefined): string | null {
  if (!extra) return null;
  for (const k of TOOLTIP_ASSIGNEE_KEYS) {
    const v = extra[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

const tooltipBoxStyle: CSSProperties = {
  background: 'var(--wx-tooltip-background, #1f2937)',
  color: 'var(--wx-tooltip-font-color, #fff)',
  padding: '8px 10px',
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  maxWidth: 280,
  boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
  whiteSpace: 'normal',
};
const tooltipDim: CSSProperties = { opacity: 0.85 };

/**
 * Built-in hover tooltip (the default when `GanttProps.tooltip` is omitted).
 * Reads the SVAR display fields directly — `duration` is already in working-days,
 * computed flags are snake_case. Shows title, date range (or a single date for a
 * milestone), working days, % / status, an assignee if `extra` carries one, and
 * critical-path / past-deadline flags. A consumer `tooltip` fn overrides this.
 */
export const ConstructionTooltip: FC<{ data: SvarTaskWithComputed }> = ({ data }) => {
  const start = data.start instanceof Date ? formatShortDate(data.start) : '';
  const end = data.end instanceof Date ? formatShortDate(data.end) : '';
  const isMilestone = data.type === 'milestone';
  const days = typeof data.duration === 'number' ? data.duration : 0;
  const pct = Math.max(0, Math.min(100, data.progress ?? 0));
  const status = pct >= 100 ? 'Complete' : pct > 0 ? `In progress (${pct}%)` : 'Not started';
  const assignee = pickAssignee(data.extra);
  return (
    <div style={tooltipBoxStyle}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>{data.text}</div>
      <div style={tooltipDim}>{isMilestone ? start : `${start} – ${end}`}</div>
      {!isMilestone && (
        <div style={tooltipDim}>
          {days} working {days === 1 ? 'day' : 'days'}
        </div>
      )}
      {!isMilestone && <div style={tooltipDim}>{status}</div>}
      {assignee && <div style={tooltipDim}>Assignee: {assignee}</div>}
      {data.is_critical && <div style={{ color: '#fca5a5' }}>On critical path</div>}
      {data.deadline_missed && <div style={{ color: '#fca5a5' }}>Past deadline</div>}
    </div>
  );
};

function toSvarLink(l: Link): ILink {
  return {
    id: l.id,
    source: l.source,
    target: l.target,
    type: dependencyTypeToSvar(l.type),
    lag: l.lag,
  };
}

function dependencyTypeToSvar(t: DependencyType): ILink['type'] {
  switch (t) {
    case 'FS':
      return 'e2s';
    case 'SS':
      return 's2s';
    case 'FF':
      return 'e2e';
    case 'SF':
      return 's2e';
  }
}

// Re-exported for tests that import from ./Gantt directly (Gantt.test.tsx).
// Implementations now live in svar-adapter.ts.
export { buildSvarTasks, formatBaselineLabel, formatShortDate } from './svar-adapter.js';

function getProjectEnd(p: Project): Date {
  if (p.end) return p.end;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const t of p.tasks) {
    if (t.end.getTime() > latestMs) latestMs = t.end.getTime();
  }
  // Pad by one cell so the last bar isn't clipped to the right edge.
  const cushion = 24 * 60 * 60 * 1000; // 1 day
  return Number.isFinite(latestMs) ? new Date(latestMs + cushion) : new Date(p.start);
}

/**
 * Resolve the effective baseline indices from the two GanttProps inputs.
 *
 * - `baselineIndices` takes precedence when set (including when empty —
 *   passing `[]` is an explicit opt-out signal).
 * - When `baselineIndices` is undefined, fall back to wrapping `baselineIndex`
 *   in a single-element array.
 * - When both are undefined, return an empty array.
 *
 * Exported for testing. Not part of the public surface; consumers don't
 * call this directly.
 */
export function resolveEffectiveBaselineIndices(
  baselineIndices: ReadonlyArray<BaselineIndex> | undefined,
  baselineIndex: BaselineIndex | undefined,
): ReadonlyArray<BaselineIndex> {
  return baselineIndices ?? (baselineIndex !== undefined ? [baselineIndex] : []);
}

/**
 * Map effective baseline indices to actual Baseline records on a project,
 * preserving caller order. Indices not present on the project are silently
 * dropped (per spec — consumers can pass a fixed shape across projects
 * with varying baseline counts).
 *
 * Exported for testing. Not part of the public surface.
 */
export function resolveBaselines(
  allBaselines: Baseline[],
  effectiveIndices: ReadonlyArray<BaselineIndex>,
): Baseline[] {
  if (effectiveIndices.length === 0) return [];
  const byIndex = new Map(allBaselines.map((b) => [b.index, b]));
  const out: Baseline[] = [];
  for (const idx of effectiveIndices) {
    const b = byIndex.get(idx);
    if (b) out.push(b);
  }
  return out;
}

function resolveMarkers(
  userMarkers: GanttMarker[] | undefined,
  projectStart: Date,
  projectEnd: Date,
): SvarMarker[] {
  if (userMarkers) return userMarkers.map(toSvarMarker);
  // Default: today line, only if today falls within the project window.
  const today = new Date();
  if (today >= projectStart && today <= projectEnd) {
    return [{ start: today, text: 'Today', css: 'construction-gantt-marker-today' }];
  }
  return [];
}

function toSvarMarker(m: GanttMarker): SvarMarker {
  const css =
    m.css ??
    (m.variant === 'milestone'
      ? 'construction-gantt-marker-milestone'
      : m.variant === 'today'
        ? 'construction-gantt-marker-today'
        : undefined);
  return { start: m.start, text: m.text, css };
}

/**
 * Convert a public GanttColumn to SVAR's IColumnConfig.
 *
 * render takes priority over field. When only field is set we emit a default
 * cell that formats the value as a string (Date → ISO date, undefined → "").
 * We cast row to our Task type directly — the relevant fields (id, text,
 * start, end, duration, progress, type, parent, computed, constraint)
 * all overlap. SVAR's internal $x/$y/$w computed fields are never passed
 * through to the consumer's render prop.
 */
/**
 * A GanttColumn as SVAR's IColumnConfig. A plain `field` column shows dates in
 * local time (an 08:00 NZ start is the previous day in UTC) and durations with
 * units, as the editable cells do; `minutesPerDay` is the default calendar's.
 */
function toSvarColumn(c: GanttColumn, minutesPerDay?: number): IColumnConfig {
  let cell: IColumnConfig['cell'] | undefined;

  if (c.render) {
    const Render = c.render;
    // Consumer render output is passed through untouched — it owns its own
    // layout (e.g. padded pills that truncate themselves); wrapping it would clip it.
    cell = (props: { row: unknown }) => <Render task={props.row as Task} />;
  } else if (c.field) {
    const field = c.field;
    cell = (props: { row: unknown }) => {
      const task = props.row as Task;
      const value = task[field as keyof Task];
      if (value === undefined || value === null) return <span />;
      if (value instanceof Date) return <CellText>{formatShortDate(value)}</CellText>;
      if (field === 'duration' && typeof value === 'number') {
        const row = props.row as SvarTaskWithComputed;
        return <CellText>{durationText(row, row.day_minutes ?? minutesPerDay)}</CellText>;
      }
      return <CellText>{String(value)}</CellText>;
    };
  }

  const config: IColumnConfig = {
    id: c.id,
    header: c.header,
    ...(c.width !== undefined ? { width: c.width } : {}),
    ...(c.align !== undefined ? { align: c.align } : {}),
    ...(cell !== undefined ? { cell } : {}),
  };
  return config;
}

function getInputType(field: EditableField): string {
  if (field === 'start' || field === 'end') return 'date';
  if (field === 'progress') return 'number';
  return 'text';
}

function getInputValue(task: Task, field: EditableField, minutesPerDay?: number): string {
  switch (field) {
    case 'text':
      return task.text;
    case 'start':
      return formatShortDate(task.start);
    case 'end':
      return formatShortDate(task.end);
    case 'duration':
      return durationText(task as unknown as SvarTaskWithComputed, minutesPerDay);
    case 'progress':
      return String(task.progress);
    case 'scheduleMode':
      return task.scheduleMode;
  }
}

const EDITABLE_FIELDS = new Set<string>([
  'text',
  'start',
  'end',
  'duration',
  'progress',
  'scheduleMode',
]);

/**
 * Whether a column renders as an inline-editable cell. Decouples display
 * formatting (`render`) from editability (`editable`): a render-bearing column
 * is read-only unless `editable: true` opts it in; `editable: false` forces
 * read-only. Exported for unit-testing the gate.
 */
export function isColumnEditable(col: GanttColumn, editMode: boolean): boolean {
  return (
    editMode &&
    !!col.field &&
    EDITABLE_FIELDS.has(col.field as string) &&
    (col.editable ?? col.render == null)
  );
}

/**
 * Inline grid editors vs SVAR's grid event handling. Without these guards
 * click-to-edit was unusable (CM editMode, 1.7.x):
 *  - Focus steal: activating an editor remounts SVAR's grid cell, whose effect
 *    calls `cell.focus()` after our editor mounted; the blur committed and
 *    closed it. {@link guardEditor} bounces any focus landing on the editor's
 *    own `.wx-cell` straight back, in the same event, and stops it before the
 *    cell's React onFocus can re-exec `focus-cell` (a loop). No window is left
 *    for keystrokes to land on the cell (typing right after the click lost
 *    characters). `isStolenByOwnCell` keeps the blur that steal causes from
 *    committing.
 *  - Pointer: SVAR's row-reorder drag and delegated grid click are NATIVE
 *    listeners below React's root, so only a native stop on the editor works.
 *    Without it a text-select drag inside an editor reordered the task, an
 *    in-editor click re-triggered the steal (resetting date-segment / select
 *    state), a double-click opened the task editor over the inline edit, and a
 *    right-click opened the structural task menu instead of the paste menu.
 *  - `onFocus`: the editor's own focus must not reach the cell's React onFocus.
 *  - `onKeyDown`: grid-store's document hotkeys move focus on arrows (ArrowDown
 *    on a select jumped rows) and preventDefault date-segment arrows. Each
 *    editor's own Enter/Tab/Escape handling runs before the stop. Consumer
 *    document-level (bubble) keydown listeners don't see keys typed in an editor.
 */
function stopToGrid(e: { stopPropagation(): void }) {
  e.stopPropagation();
}

const noScrollBoxes = new WeakSet<HTMLElement>();

/** Mousedown capture: the grid table box under the pointer focuses with preventScroll. */
function focusGridWithoutScroll(e: Event) {
  const box = e.target instanceof Element ? e.target.closest('.wx-table-box') : null;
  if (!(box instanceof HTMLElement) || noScrollBoxes.has(box)) return;
  noScrollBoxes.add(box);
  box.focus = (options?: FocusOptions) =>
    HTMLElement.prototype.focus.call(box, { ...options, preventScroll: true });
}

const guardedEditors = new WeakSet<HTMLElement>();

/** Stable callback ref for inline editors (module-level; listeners self-scope). */
function guardEditor(editor: HTMLElement | null) {
  if (!editor || guardedEditors.has(editor)) return;
  guardedEditors.add(editor);
  // dblclick → SVAR's show-editor (onTaskEditRequest over a half-typed edit);
  // contextmenu → the task structural menu instead of the native paste menu.
  for (const type of ['mousedown', 'touchstart', 'click', 'dblclick', 'contextmenu']) {
    editor.addEventListener(type, stopToGrid);
  }
  const cell = editor.closest('.wx-cell');
  if (!cell) return;
  const onFocusIn = (e: Event) => {
    if (!editor.isConnected) {
      cell.removeEventListener('focusin', onFocusIn);
      return;
    }
    if (e.target !== cell) return;
    e.stopPropagation();
    editor.focus();
  };
  cell.addEventListener('focusin', onFocusIn);
}

const editorGuardProps = { onFocus: stopToGrid, ref: guardEditor } as const;

/**
 * Make (rowId, colId) SVAR's grid focus cell — the state SVAR re-focuses when
 * it re-renders a cell. A plain `.focus()` doesn't register with it. Uses the
 * grid's own `focus-cell` action (what its click handler runs), so there's no
 * row selection, chart scroll, or synthetic DOM event.
 */
function svarFocusCell(api: IApi | null, rowId: TaskId, colId: string) {
  const table = api?.getTable(false) as { exec?: (a: string, ev: unknown) => void } | undefined;
  table?.exec?.('focus-cell', { row: rowId, column: colId, eventSource: 'click' });
}

/** `.wx-cell` selector for SVAR's encoded row / column attributes (ids escaped). */
function cellSelector(rowAttr: string, colAttr: string): string {
  const esc = (v: string) =>
    typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
  return `.wx-cell[data-row-id="${esc(rowAttr)}"][data-col-id="${esc(colAttr)}"]`;
}

/** Marks the engine-field inline editor so lookups never hit a custom column's own inputs. */
const EDITOR_ATTR = 'data-pyraxi-editor';

function isStolenByOwnCell(e: FocusEvent<HTMLElement>): boolean {
  const cell = e.currentTarget.closest('.wx-cell');
  return !!cell && e.relatedTarget === cell;
}

/**
 * Keyboard continuation for inline editors (parity row 16), supplied by the
 * Gantt: open the editor for another cell, or put focus back on a grid cell.
 */
export interface GridKeyboardNav {
  /**
   * Open the editor `move` away from `fromCell`; false when there's no such
   * cell. `fromRowId` is the row being edited — authoritative over the cell's
   * `data-row-id`, which can be stale while SVAR recycles row slots.
   */
  move(fromCell: Element, move: GridMove, fromRowId?: TaskId): boolean;
  /** Focus a grid cell (after Escape / a commit with nowhere to go) instead of leaving it on <body>. */
  focusCell(cell: Element | null): void;
  /** Open the editor for a focused grid cell (Enter / F2); false when it isn't editable. */
  openAt(cell: Element): boolean;
  /** Whether `cell` is the one whose inline editor is currently open. */
  isActiveCell(cell: Element): boolean;
  /** What the grid clipboard needs about a focused cell; null when it isn't a task cell. */
  clipboard(cell: Element): GridClipboardContext | null;
}

export interface GridClipboardContext {
  rowId: TaskId;
  colId: string;
  /** Column ids of the cell's row, in display order. */
  columns: string[];
  /** Row ids in the grid's visible order. */
  rowOrder: TaskId[];
  fieldFor: (rowId: TaskId, colId: string) => EditableField | undefined;
  cellValue: (rowId: TaskId, field: EditableField) => string | undefined;
  minutesPerDay: number | undefined;
  /** The row's duration is elapsed (24 h days). */
  isElapsed: (rowId: TaskId) => boolean;
}

export function buildEditableCell(
  field: EditableField,
  editStateRef: { readonly current: EditState },
  onTaskEditRef: { readonly current: GanttProps['onTaskEdit'] },
  displayRender?: FC<{ task: Task }>,
  minutesPerDay?: number,
  navRef?: { readonly current: GridKeyboardNav | undefined },
): IColumnConfig['cell'] {
  return ({ row }: { row: unknown }) => {
    const editState = editStateRef.current;
    const task = row as SvarTaskWithComputed;
    if (isPhantomRow(task)) {
      return <span />;
    }
    const isReadOnly =
      task.is_group_row === true ||
      (task.type === 'summary' && (field === 'start' || field === 'end' || field === 'duration'));

    const isThisCell = (c: { taskId: TaskId; field: EditableField }) =>
      c.taskId === task.id && c.field === field;
    const isActive = !!editState.activeCell && isThisCell(editState.activeCell);

    if (isActive) {
      return (
        <input
          // biome-ignore lint/a11y/noAutofocus: intentional — cell was clicked
          autoFocus
          key={`${editState.activeCell?.taskId}-${field}`}
          type={getInputType(field)}
          {...{ [EDITOR_ATTR]: '' }}
          defaultValue={editState.dirtyValue}
          style={{ width: '100%', boxSizing: 'border-box' }}
          {...editorGuardProps}
          onChange={(e) => {
            e.currentTarget.removeAttribute('aria-invalid');
            editStateRef.current.setValue(e.target.value);
          }}
          onBlur={(e) => {
            if (isStolenByOwnCell(e)) return;
            // A trailing blur from an editor Enter/Tab already moved on from
            // must not commit (and so close) the next cell's editor.
            const active = editStateRef.current.activeCell;
            if (active?.taskId !== task.id || active?.field !== field) return;
            editStateRef.current.commitCell(onTaskEditRef.current);
          }}
          onKeyDown={(e) => {
            stopToGrid(e);
            const cellEl = e.currentTarget.closest('.wx-cell');
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const status = editStateRef.current.commitCell(onTaskEditRef.current, {
                keepOpenIfInvalid: true,
              });
              if (status === 'invalid') {
                // Imperative, not a prop: re-rendering the columns would
                // remount this input and wipe a date's untouched segments.
                e.currentTarget.setAttribute('aria-invalid', 'true');
                return;
              }
              const move: GridMove =
                e.key === 'Enter' ? (e.shiftKey ? 'up' : 'down') : e.shiftKey ? 'prev' : 'next';
              const nav = navRef?.current;
              if (cellEl && nav && !nav.move(cellEl, move, task.id as TaskId)) {
                nav.focusCell(cellEl);
              }
            } else if (e.key === 'Escape') {
              editStateRef.current.cancelCell();
              navRef?.current?.focusCell(cellEl);
            }
          }}
        />
      );
    }

    const displayValue = (() => {
      if (field === 'start' || field === 'end') {
        const d = task[field as 'start' | 'end'];
        return d instanceof Date ? formatShortDate(d) : '';
      }
      if (field === 'duration') return durationText(task, minutesPerDay);
      // A whole percent, as MS Project shows it: an imported MS Project file's
      // progress is the exact actual ÷ duration (45.56…).
      if (field === 'progress') return String(Math.round(task.progress ?? 0));
      return String((task as Record<string, unknown>)[field] ?? '');
    })();

    // When a custom display renderer is supplied (GanttColumn.editable on a
    // render-bearing column), use it for the inactive cell so the column keeps
    // its formatting; the active-edit <input> above is unaffected.
    const DisplayRender = displayRender;
    const shown = DisplayRender ? <DisplayRender task={task as unknown as Task} /> : displayValue;

    if (isReadOnly || task.id === undefined) {
      return <CellText clip={!DisplayRender}>{shown}</CellText>;
    }

    const taskId = task.id as TaskId;
    const activate = () =>
      editStateRef.current.activateCell(
        taskId,
        field,
        getInputValue(task as unknown as Task, field, minutesPerDay),
      );

    return (
      <CellText clip={!DisplayRender} style={{ cursor: 'text' }} onClick={activate}>
        {shown}
      </CellText>
    );
  };
}

/**
 * Cell renderer for a custom (non-engine) inline-editable column
 * ({@link GanttColumn.editor}). Self-contained: manages its own open/edit state
 * (custom fields don't touch the engine or the CPM preview, so no shared
 * editState) and commits via `onCellEdit(id, columnId, value)` — only when the
 * value actually changed. Returned as a SVAR `cell` **component**, so hooks are
 * valid inside. The column's `render` (if any) still owns the read display.
 */
export function buildCustomEditableCell(
  editor: GanttColumnEditor,
  columnId: string,
  onCellEditRef: { readonly current: GanttProps['onCellEdit'] },
  displayRender?: FC<{ task: Task }>,
): IColumnConfig['cell'] {
  const DisplayRender = displayRender;
  return function CustomEditableCell({ row }: { row: unknown }) {
    const task = row as SvarTaskWithComputed;
    const [active, setActive] = useState(false);
    // Guards against a late blur re-firing a commit after Enter/Escape already
    // closed the editor (unmounting a focused input can emit a trailing blur).
    const settledRef = useRef(false);
    const taskId = task.id as TaskId | undefined;
    // If SVAR recycles this cell node for a different task (index-keyed virtual
    // rows), close any open editor so stale typed text can't commit against the
    // new task. Harmless when rows are id-keyed (component remounts per task).
    // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the underlying task changes
    useEffect(() => {
      setActive(false);
      settledRef.current = false;
    }, [taskId]);
    // Phantom baseline/preview rows have no editable identity.
    if (isPhantomRow(task)) {
      return <span />;
    }
    const current = editor.getValue(task as unknown as Task);

    if (active && taskId !== undefined) {
      const settle = (commitValue?: string) => {
        if (settledRef.current) return;
        settledRef.current = true;
        setActive(false);
        if (commitValue !== undefined && commitValue !== current) {
          onCellEditRef.current?.(taskId, columnId, commitValue);
        }
      };
      if (editor.type === 'select') {
        return (
          <select
            // biome-ignore lint/a11y/noAutofocus: cell was just clicked to edit
            autoFocus
            defaultValue={current}
            style={{ width: '100%', boxSizing: 'border-box' }}
            {...editorGuardProps}
            onKeyDown={(e) => {
              stopToGrid(e);
              if (e.key === 'Escape') settle(); // cancel — no commit, like the inputs
            }}
            // Only an explicit pick commits; a bare blur (opened then clicked
            // away without choosing) closes WITHOUT committing — otherwise a
            // `current` not present in `options` would silently commit option[0].
            onChange={(e) => settle(e.target.value)}
            onBlur={(e) => {
              if (!isStolenByOwnCell(e)) settle();
            }}
          >
            {(editor.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {o.label ?? o.value}
              </option>
            ))}
          </select>
        );
      }
      return (
        <input
          // biome-ignore lint/a11y/noAutofocus: cell was just clicked to edit
          autoFocus
          type="text"
          defaultValue={current}
          style={{ width: '100%', boxSizing: 'border-box' }}
          {...editorGuardProps}
          onChange={(e) => {
            // Typing clears an earlier Enter's error mark.
            e.currentTarget.removeAttribute('aria-invalid');
            e.currentTarget.removeAttribute('title');
          }}
          onBlur={(e) => {
            if (isStolenByOwnCell(e)) return;
            const value = e.target.value;
            // An invalid value reverts on blur (like the engine-field editors).
            settle(editor.validate?.(value, task as unknown as Task) ? undefined : value);
          }}
          onKeyDown={(e) => {
            stopToGrid(e);
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              const input = e.target as HTMLInputElement;
              const error = editor.validate?.(input.value, task as unknown as Task);
              if (error) {
                // Stay open: the user fixes it, or Escape cancels.
                input.setAttribute('aria-invalid', 'true');
                input.title = error;
                return;
              }
              settle(input.value);
            } else if (e.key === 'Escape') {
              settle(); // cancel — no commit
            }
          }}
        />
      );
    }

    const shown = DisplayRender ? <DisplayRender task={task as unknown as Task} /> : current;
    // Group rows (groupProject) are virtual: show, never edit.
    if (taskId === undefined || task.is_group_row) {
      return <CellText clip={!DisplayRender}>{shown}</CellText>;
    }
    return (
      <CellText
        clip={!DisplayRender}
        style={{ cursor: 'pointer' }}
        onClick={() => {
          settledRef.current = false;
          setActive(true);
        }}
      >
        {shown}
      </CellText>
    );
  };
}

const MAX_LEAD_IN_DAYS = 3650;

/**
 * SVAR timeline start: `leadInDays` calendar days before the project start
 * (same time of day). Non-positive / non-finite values leave it unchanged;
 * capped at 10 years so an absurd value can't yield an Invalid Date.
 */
export function resolveTimelineStart(projectStart: Date, leadInDays: number | undefined): Date {
  if (!leadInDays || !Number.isFinite(leadInDays) || leadInDays <= 0) return projectStart;
  const d = new Date(projectStart);
  d.setDate(d.getDate() - Math.min(leadInDays, MAX_LEAD_IN_DAYS));
  return d;
}

/** Name of SVAR zoom level `index` under our config. */
export function zoomLevelAt(config: GanttZoomConfig, index: number): GanttZoomLevel | undefined {
  return index >= 0 ? resolveZoomLevels(config)[index] : undefined;
}

/** Stable `selected` for SVAR (see the <SvarGantt> prop). Never mutated. */
const NO_SELECTION: TaskId[] = [];

/** Earliest start / latest end of the rows' inline baseline ghosts, or null. */
function inlineBaselineSpan(rows: readonly ITask[]): { start: Date; end: Date } | null {
  let start: Date | undefined;
  let end: Date | undefined;
  for (const row of rows) {
    const base = (row as SvarTaskWithComputed).baseline_inline;
    if (!base) continue;
    if (!start || base.start < start) start = base.start;
    if (!end || base.end > end) end = base.end;
  }
  return start && end ? { start, end } : null;
}

/**
 * A SVAR row's duration as the grid shows and edits it: its `duration` is in
 * SVAR days — working days of the calendar, or 24 h days for an elapsed task
 * (`3ed`, MS Project notation).
 */
function durationText(row: SvarTaskWithComputed, minutesPerDay?: number): string {
  const days = row.duration ?? 0;
  if (row.duration_elapsed) return formatElapsedDuration(days * 1440);
  return formatDuration(
    minutesPerDay ? days * minutesPerDay : days,
    durationUnitsFor(minutesPerDay),
  );
}

/** SVAR's api for the bar template (inline baseline ghosts read its live scale). */
const SvarApiContext = createContext<IApi | null>(null);

/** SVAR store's current zoom level index (-1 when absent). */
function readSvarZoomLevel(api: IApi): number {
  return (api.getState() as { zoom?: { level?: number } }).zoom?.level ?? -1;
}

export function buildHighlightTime(
  calendar: Calendar | undefined,
): ((date: Date, unit: 'day' | 'hour') => string) | undefined {
  if (!calendar) return undefined;
  return (date, unit) => {
    if (unit === 'day') {
      return isWorkingDay(date, calendar) ? '' : 'construction-gantt-non-working';
    }
    // hour (the finest SVAR unit): shade hours outside the day's working intervals.
    return isWorkingTime(date, calendar) ? '' : 'construction-gantt-non-working';
  };
}

function workingMinutesToShortLabel(minutes: number, row?: SvarTaskWithComputed): string {
  const abs = Math.abs(minutes);
  // Days of the task's own calendar (a 24 h or elapsed task's are 24 h);
  // 9 h by default — an in-bar pill is best-effort.
  const perDay = row?.duration_elapsed ? 1440 : (row?.day_minutes ?? 540);
  if (abs >= perDay) {
    const days = Math.round(abs / perDay);
    return `${days}${row?.duration_elapsed ? 'ed' : 'd'}`;
  }
  if (abs >= 60) {
    const hours = Math.round(abs / 60);
    return `${hours}h`;
  }
  return `${Math.round(abs)}m`;
}
