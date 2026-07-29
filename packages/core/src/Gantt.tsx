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
  Link,
  LinkId,
  Project,
  Task,
  TaskId,
} from '@pyraxi/cpm-engine';
import {
  createTask,
  deleteTask,
  filterTasksByVisibility,
  formatDuration,
  indentTask,
  isWorkingDay,
  isWorkingTime,
  moveTask,
  moveTaskTo,
  outdentTask,
  schedule,
} from '@pyraxi/cpm-engine';
import {
  type CSSProperties,
  type FC,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
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
  type EditableField,
  type EditState,
  type TaskEditPatch,
  useEditState,
} from './editing/useEditState.js';
import { usePreviewEngine } from './editing/usePreviewEngine.js';
import type {
  GanttHandle,
  PdfExportOptions,
  PngExportOptions,
  XlsxExportOptions,
} from './export/types.js';
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
  type SvarTaskWithComputed,
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
  };
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
}

const DEFAULT_EDIT_COLUMNS: GanttColumn[] = [
  { id: 'text', header: 'Task Name', field: 'text', width: 220 },
  { id: 'start', header: 'Start', field: 'start', width: 100, align: 'center' },
  { id: 'end', header: 'Finish', field: 'end', width: 100, align: 'center' },
  { id: 'duration', header: 'Duration', field: 'duration', width: 70, align: 'right' },
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
    onLinkCreate,
    onLinkDelete,
    onTaskAdd,
    onTaskDelete,
    onTaskReorder,
    onTaskIndent,
    onStructuralCommit,
    onTaskSelect,
    onTaskEditRequest,
    onCellEdit,
    boldSummaryRows = true,
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
  const renderableTasks = useMemo(
    () => filterTasksByVisibility(scheduled.tasks, visibleTaskIds),
    [scheduled.tasks, visibleTaskIds],
  );

  const calendar = useMemo(
    () => scheduled.calendars.find((c) => c.id === scheduled.defaultCalendarId),
    [scheduled.calendars, scheduled.defaultCalendarId],
  );

  const editState = useEditState();
  const editStateRef = useRef<typeof editState>(editState);
  editStateRef.current = editState;
  const onTaskEditRef = useRef(onTaskEdit);
  onTaskEditRef.current = onTaskEdit;
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
  const rowStyleCss = useMemo(
    () => buildRowStyleCss(scheduled.tasks, ganttScopeClass, { boldSummary: boldSummaryRows }),
    [scheduled.tasks, ganttScopeClass, boldSummaryRows],
  );

  const svarTasks: ITask[] = useMemo(
    () =>
      buildSvarTasks(
        renderableTasks,
        resolvedBaselines,
        calendar,
        ghostBarsEnabled,
        editGhostProject ?? undefined,
        baselineRender ?? 'row',
      ),
    [
      renderableTasks,
      resolvedBaselines,
      calendar,
      ghostBarsEnabled,
      editGhostProject,
      baselineRender,
    ],
  );
  const svarLinks: ILink[] = useMemo(() => scheduled.links.map(toSvarLink), [scheduled.links]);

  const projectEnd = useMemo(() => getProjectEnd(scheduled), [scheduled]);
  // Mark calendar referenced even when consumed only by useMemo args (TS unused-let guard)
  void calendar;

  const svarMarkers: SvarMarker[] = useMemo(
    () => resolveMarkers(markers, scheduled.start, projectEnd),
    [markers, scheduled.start, projectEnd],
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

  // Convert a GanttColumn to SVAR's IColumnConfig, injecting the interactive
  // editable-cell renderer for known editable fields in editMode. Not
  // memoised itself (cheap, called only from inside the svarColumns useMemo
  // below); reads editStateRef/onTaskEditRef via stable ref objects, so its
  // recreation every render doesn't affect the memo's correctness.
  const buildDisplayColumn = (col: GanttColumn): IColumnConfig => {
    // Custom-column inline editor (host-app fields, not engine fields) — commits
    // via onCellEdit, self-contained state, no CPM re-run. Takes precedence over
    // the engine-field editable path for a column that declares `editor`.
    if (col.editor && editMode) {
      return {
        ...toSvarColumn(col),
        cell: buildCustomEditableCell(col.editor, col.id, onCellEditRef, col.render),
      };
    }
    if (!isColumnEditable(col, editMode)) {
      return toSvarColumn(col);
    }
    // Editable: route through buildEditableCell, keeping col.render (if any) as
    // the inactive-cell display so formatting survives (GanttColumn.editable).
    return {
      ...toSvarColumn(col),
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
      return columns.map(toSvarColumn);
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

  useImperativeHandle(
    ref,
    () => ({
      async exportPNG(options?: PngExportOptions): Promise<Blob> {
        const { exportPNG } = await import('./export/png.js');
        return exportPNG({
          scheduled,
          ganttProps: {
            cellWidth,
            cellHeight,
            markers,
            baselineIndex,
            baselineIndices,
            showBaselineBars,
            columns,
            height,
            visibleTaskIds,
          },
          options: options ?? {},
        });
      },
      async exportPDF(options?: PdfExportOptions): Promise<Blob> {
        const { exportPDF } = await import('./export/pdf.js');
        return exportPDF({
          scheduled,
          ganttProps: {
            cellWidth,
            cellHeight,
            markers,
            baselineIndex,
            baselineIndices,
            showBaselineBars,
            columns,
            height,
            visibleTaskIds,
          },
          options: options ?? {},
        });
      },
      async exportXLSX(options?: XlsxExportOptions): Promise<Blob> {
        const { exportXLSX } = await import('./export/xlsx.js');
        return exportXLSX({ scheduled, options: options ?? {} });
      },
    }),
    [
      scheduled,
      cellWidth,
      cellHeight,
      markers,
      baselineIndex,
      baselineIndices,
      showBaselineBars,
      columns,
      height,
      visibleTaskIds,
    ],
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
      start={scheduled.start}
      end={projectEnd}
      cellWidth={cellWidth}
      cellHeight={cellHeight}
      markers={svarMarkers}
      highlightTime={highlightTime}
      taskTemplate={taskTemplate}
      init={(api) => {
        setSvarApi(api);
        // Native selection → onTaskSelect. SVAR fires `select-task` with the
        // selected task id (confirmed in @svar-ui/gantt-store). Read-only, non-
        // blocking — registered regardless of editMode (selection is a read gesture).
        api.on('select-task', (ev: { id?: TaskId }) => {
          // Never surface a phantom baseline/edit-preview row to the consumer —
          // that id doesn't exist in their project (CM runs baselines[0] +
          // onTaskSelect in prod).
          if (ev.id !== undefined && !isPhantomRowId(ev.id)) onTaskSelectRef.current?.(ev.id);
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
          if (isPhantomRowId(ev.id)) return false;
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
            if (isPhantomRowId(ev.id)) return false;
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
            if (isPhantomRowId(ev.id)) return;
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
              if (isPhantomRowId(subjectId) || isPhantomRowId(targetId)) return false;

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
                case 'add':
                  if (!onTaskAddRef.current) return true;
                  onTaskAddRef.current(edit.task, resolveAddPosition(projectRef.current, edit));
                  return false;
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
      {...(zoom ? { zoom: toSvarZoom(zoom) } : {})}
    />
  );
  const ganttWithMenu = contextMenu ? (
    <SvarContextMenu
      api={svarApi ?? undefined}
      {...(svarContextMenuOptions
        ? { options: svarContextMenuOptions as Parameters<typeof SvarContextMenu>[0]['options'] }
        : {})}
    >
      {ganttElement}
    </SvarContextMenu>
  ) : (
    ganttElement
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
        />
      )}
      {signalCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own task ids + fixed colour literals, no user HTML
        <style dangerouslySetInnerHTML={{ __html: signalCss }} />
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
            style={{
              padding: '0 6px',
              background: '#fed7aa',
              color: '#7c2d12',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
            }}
            title="Drifted later than the baseline"
          >
            +{workingMinutesToShortLabel(data.start_variance ?? 0)}
          </span>
        )}
        {phantomAhead && (
          <span
            style={{
              padding: '0 6px',
              background: '#bbf7d0',
              color: '#14532d',
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 700,
              lineHeight: '16px',
              whiteSpace: 'nowrap',
            }}
            title="Ahead of the baseline"
          >
            −{workingMinutesToShortLabel(data.start_variance ?? 0)}
          </span>
        )}
      </div>
    );
  }

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
        overflow: data.baseline_inline || labelOverflows ? 'visible' : 'hidden',
        fontSize: 'var(--wx-font-size-sm, 12px)',
        fontWeight: isSummary ? 600 : 500,
        color: 'var(--wx-gantt-task-font-color, #fff)',
        background: trackBg,
        borderRadius: 'var(--wx-gantt-bar-border-radius, 3px)',
      }}
    >
      {data.baseline_inline && (
        <div
          className="construction-gantt-baseline-inline"
          style={{
            left: `${data.baseline_inline.leftPct}%`,
            width: `${data.baseline_inline.widthPct}%`,
          }}
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
      {/* Overflow label beside the bar (matches SVAR native `.wx-text-out`). */}
      {labelOverflows && (
        <span
          className="construction-gantt-bar-label-out"
          style={{
            position: 'absolute',
            left: '100%',
            marginLeft: 6,
            zIndex: 1,
            whiteSpace: 'nowrap',
            fontWeight: isSummary ? 600 : 500,
            color: 'var(--wx-color-font, #334155)',
            pointerEvents: 'none',
          }}
        >
          {data.text}
        </span>
      )}
      {isSlipped && (
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0 6px',
            background: '#fed7aa',
            color: '#7c2d12',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
          title="Drifted later than the baseline"
        >
          +{workingMinutesToShortLabel(data.start_variance ?? 0)}
        </span>
      )}
      {isAhead && (
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0 6px',
            background: '#bbf7d0',
            color: '#14532d',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
          title="Ahead of the baseline"
        >
          −{workingMinutesToShortLabel(data.start_variance ?? 0)}
        </span>
      )}
      {showSlackIndicator && (
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0 6px',
            background: '#dbeafe',
            color: '#1e3a8a',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 600,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
          title="Total float — how much this task can slip before becoming critical"
        >
          {workingMinutesToShortLabel(totalSlack)} float
        </span>
      )}
      {isLate && (
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0 6px',
            background: '#fde68a',
            color: '#78350f',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
          title="Negative slack — contract trouble"
        >
          {workingMinutesToShortLabel(data.total_slack ?? 0)} late
        </span>
      )}
      {hasDeadline && (
        <span
          style={{
            position: 'relative',
            zIndex: 1,
            padding: '0 6px',
            background: deadlineMissed ? '#fecaca' : '#fde68a',
            color: deadlineMissed ? '#7f1d1d' : '#78350f',
            borderRadius: 3,
            fontSize: 10,
            fontWeight: 700,
            lineHeight: '16px',
            whiteSpace: 'nowrap',
          }}
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
function toSvarColumn(c: GanttColumn): IColumnConfig {
  let cell: IColumnConfig['cell'] | undefined;

  if (c.render) {
    const Render = c.render;
    cell = (props: { row: unknown }) => <Render task={props.row as Task} />;
  } else if (c.field) {
    const field = c.field;
    cell = (props: { row: unknown }) => {
      const task = props.row as Task;
      const value = task[field as keyof Task];
      if (value === undefined || value === null) return <span />;
      if (value instanceof Date) return <span>{value.toISOString().slice(0, 10)}</span>;
      return <span>{String(value)}</span>;
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
      // `task.duration` on a SVAR grid row is in working DAYS when a calendar
      // is present; convert back to working minutes before formatting.
      return formatDuration(minutesPerDay ? task.duration * minutesPerDay : task.duration);
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

export function buildEditableCell(
  field: EditableField,
  editStateRef: { readonly current: EditState },
  onTaskEditRef: { readonly current: GanttProps['onTaskEdit'] },
  displayRender?: FC<{ task: Task }>,
  minutesPerDay?: number,
): IColumnConfig['cell'] {
  return ({ row }: { row: unknown }) => {
    const editState = editStateRef.current;
    const task = row as SvarTaskWithComputed;
    if (isPhantomRow(task)) {
      return <span />;
    }
    const isReadOnly =
      task.type === 'summary' && (field === 'start' || field === 'end' || field === 'duration');

    const isActive =
      editState.activeCell?.taskId === task.id && editState.activeCell?.field === field;

    if (isActive) {
      return (
        <input
          // biome-ignore lint/a11y/noAutofocus: intentional — cell was clicked
          autoFocus
          key={`${editState.activeCell?.taskId}-${field}`}
          type={getInputType(field)}
          defaultValue={editState.dirtyValue}
          style={{ width: '100%', boxSizing: 'border-box' }}
          onChange={(e) => editStateRef.current.setValue(e.target.value)}
          onBlur={() => editStateRef.current.commitCell(onTaskEditRef.current)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              editStateRef.current.commitCell(onTaskEditRef.current);
            } else if (e.key === 'Escape') {
              editStateRef.current.cancelCell();
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
      if (field === 'duration') {
        // Row duration is in working DAYS (calendar present) → back to minutes.
        const mins = minutesPerDay ? (task.duration ?? 0) * minutesPerDay : (task.duration ?? 0);
        return formatDuration(mins);
      }
      if (field === 'progress') return String(task.progress ?? 0);
      return String((task as Record<string, unknown>)[field] ?? '');
    })();

    // When a custom display renderer is supplied (GanttColumn.editable on a
    // render-bearing column), use it for the inactive cell so the column keeps
    // its formatting; the active-edit <input> above is unaffected.
    const DisplayRender = displayRender;
    const shown = DisplayRender ? <DisplayRender task={task as unknown as Task} /> : displayValue;

    if (isReadOnly || task.id === undefined) {
      return <span>{shown}</span>;
    }

    const taskId = task.id as TaskId;
    const activate = () =>
      editStateRef.current.activateCell(
        taskId,
        field,
        getInputValue(task as unknown as Task, field, minutesPerDay),
      );

    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: cell activation via keyboard handled by the input that renders on activate
      // biome-ignore lint/a11y/noStaticElementInteractions: grid cell — role="gridcell" would be on the parent SVAR element
      <span style={{ cursor: 'text', display: 'block', width: '100%' }} onClick={activate}>
        {shown}
      </span>
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
            // Only an explicit pick commits; a bare blur (opened then clicked
            // away without choosing) closes WITHOUT committing — otherwise a
            // `current` not present in `options` would silently commit option[0].
            onChange={(e) => settle(e.target.value)}
            onBlur={() => settle()}
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
          onBlur={(e) => settle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              settle((e.target as HTMLInputElement).value);
            } else if (e.key === 'Escape') {
              settle(); // cancel — no commit
            }
          }}
        />
      );
    }

    const shown = DisplayRender ? <DisplayRender task={task as unknown as Task} /> : current;
    if (taskId === undefined) return <span>{shown}</span>;
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: activation renders a focusable input/select
      // biome-ignore lint/a11y/noStaticElementInteractions: grid cell — role lives on the SVAR parent
      <span
        style={{ cursor: 'pointer', display: 'block', width: '100%' }}
        onClick={() => {
          settledRef.current = false;
          setActive(true);
        }}
      >
        {shown}
      </span>
    );
  };
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

function workingMinutesToShortLabel(minutes: number): string {
  const abs = Math.abs(minutes);
  if (abs >= 540) {
    // Approximate working-days from 9h-per-day. Display is "best-effort"
    // since real durations depend on each task's calendar — good enough
    // for an in-bar pill.
    const days = Math.round(abs / 540);
    return `${days}d`;
  }
  if (abs >= 60) {
    const hours = Math.round(abs / 60);
    return `${hours}h`;
  }
  return `${Math.round(abs)}m`;
}
