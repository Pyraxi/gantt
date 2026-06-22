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
import '@svar-ui/react-gantt/style.css';
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
  filterTasksByVisibility,
  formatDuration,
  isWorkingDay,
  isWorkingTime,
  schedule,
} from '@pyraxi/cpm-engine';
import {
  type FC,
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import {
  buildSignalCss,
  buildSvarTasks,
  formatShortDate,
  projectHasSplitTasks,
  projectHasUnscheduledTasks,
  type SvarTaskWithComputed,
  svarUpdateToPatch,
  toSvarContextMenu,
  toSvarEditorItems,
  toSvarToolbar,
  toSvarZoom,
} from './svar-adapter.js';

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
  // --- v0.4 editing ---
  editMode?: boolean;
  onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void;
  onLinkCreate?: (source: TaskId, target: TaskId, type: DependencyType) => void;
  onLinkDelete?: (linkId: LinkId) => void;
  // --- v0.5 chrome ---
  /**
   * Enable scroll-wheel zoom with named levels.
   * Converted internally to SVAR's IZoomConfig (ADR-002).
   * Example: `zoom={{ levels: ['day','week','month'], default: 'week' }}`
   */
  zoom?: GanttZoomConfig;
  /**
   * Custom tooltip rendered when hovering a task bar.
   * Receives the (scheduled) Task; return any ReactNode.
   * Example: `tooltip={(task) => <span>{task.text}</span>}`
   */
  tooltip?: (task: Task) => ReactNode;
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
    columns,
    visibleTaskIds,
    editMode = false,
    onTaskEdit,
    onLinkCreate,
    onLinkDelete,
    zoom,
    tooltip,
    editor,
    contextMenu,
    toolbar = true,
    locale,
  },
  ref,
) {
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
    () => (editMode || ghostBarsEnabled ? null : buildSignalCss(scheduled.tasks, ganttScopeClass)),
    [scheduled.tasks, ganttScopeClass, editMode, ghostBarsEnabled],
  );

  const svarTasks: ITask[] = useMemo(
    () =>
      buildSvarTasks(
        renderableTasks,
        resolvedBaselines,
        calendar,
        ghostBarsEnabled,
        editGhostProject ?? undefined,
      ),
    [renderableTasks, resolvedBaselines, calendar, ghostBarsEnabled, editGhostProject],
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

  // Convert our SVAR-agnostic GanttColumn[] to SVAR's IColumnConfig[].
  // undefined → don't pass columns to SVAR (use SVAR defaults).
  // [] → pass false to SVAR (hide grid entirely).
  // [...] → convert each column.
  // In editMode, inject interactive cell renderers for known editable fields.
  // biome-ignore lint/correctness/useExhaustiveDependencies: editState.activeCell is intentionally used as a dep — editStateRef/onTaskEditRef are accessed at event time via refs, so only activeCell (which changes cell-to-cell) drives column recompute
  const svarColumns: IColumnConfig[] | false | undefined = useMemo(() => {
    if (!editMode) {
      if (columns === undefined) return undefined;
      if (columns.length === 0) return false;
      return columns.map(toSvarColumn);
    }
    const effectiveCols = columns ?? DEFAULT_EDIT_COLUMNS;
    if (effectiveCols.length === 0) return false;
    return effectiveCols.map((col) => {
      if (col.render || !col.field || !EDITABLE_FIELDS.has(col.field as string)) {
        return toSvarColumn(col);
      }
      const base = toSvarColumn(col);
      return {
        ...base,
        cell: buildEditableCell(col.field as EditableField, editStateRef, onTaskEditRef),
      };
    });
  }, [columns, editMode, editState.activeCell]);

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
    if (!editMode) return ConstructionBar as FC<{ data: ITask }>;
    // Wrap ConstructionBar with a drag handle at the right edge of each task bar.
    const EditableBar: FC<{ data: SvarTaskWithComputed }> = ({ data }) => (
      <div
        data-task-id={data.id !== undefined ? String(data.id) : undefined}
        style={{ position: 'relative', width: '100%', height: '100%' }}
      >
        <ConstructionBar data={data} />
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
  }, [editMode, ghostBarsEnabled, onBarMouseDown]);

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
  const svarToolbarItems = useMemo(
    () => (toolbar && typeof toolbar !== 'boolean' ? toSvarToolbar(toolbar) : undefined),
    [toolbar],
  );
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
    if (!tooltip) return undefined;
    const tooltipFn = tooltip;
    const Wrapper: FC<{ data: ITask }> = ({ data }) => {
      // SVAR may invoke the content component with no row data (e.g. before a
      // task is hovered); render nothing rather than dereferencing undefined.
      if (!data) return null;
      // F2 fix: SVAR invokes the tooltip for every hovered bar including
      // baseline-ghost and edit-preview phantom rows. Return null for phantoms
      // so consumers never see phantom data passed to their tooltip function.
      if (
        (data as SvarTaskWithComputed).is_baseline_ghost ||
        (data as SvarTaskWithComputed).is_edit_preview
      )
        return null;
      // Map SVAR ITask back to our Task shape (fields relevant for tooltip display only).
      // Note: scheduleMode is omitted — the tooltip Task carries display fields only;
      // the adapter back-map doesn't have access to the original scheduleMode.
      const task: Task = {
        id: data.id as TaskId,
        text: (data.text as string) ?? '',
        type: (data.type as Task['type']) ?? 'task',
        scheduleMode: 'auto', // display-only sentinel; tooltip consumers should not rely on this
        start: data.start as Date,
        end: data.end as Date,
        duration: (data.duration as number) ?? 0,
        progress: (data.progress as number) ?? 0,
        parent: data.parent as TaskId | undefined,
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
        if (editMode) {
          // Bridge SVAR-native bar drag/resize (and Editor-modal field edits) into
          // our edit pipeline. Without this, SVAR mutates only its own internal
          // task store on a drag — our engine never re-runs (successors don't
          // cascade) and the change never reaches the dirty/commit pipeline.
          //
          // Intercept-and-own: return false to veto SVAR's optimistic mutation and
          // route the change through onTaskEdit, keeping our engine the single
          // source of truth (ADR-005). A timing change pins the task to manual
          // (svarUpdateToPatch), so auto successors cascade off the new dates on the
          // next schedule() pass. Unmappable deltas (e.g. SVAR's working-days-unit
          // duration with no dates) yield an empty patch — let SVAR handle those.
          api.intercept('update-task', (ev: { id: TaskId; task: Partial<ITask> }) => {
            const patch = svarUpdateToPatch(ev.task);
            if (Object.keys(patch).length === 0) return true;
            onTaskEditRef.current?.(ev.id, patch);
            return false;
          });
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
      style={{ position: 'relative', height }}
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
      {signalCss && (
        // biome-ignore lint/security/noDangerouslySetInnerHtml: generated from our own task ids + fixed colour literals, no user HTML
        <style dangerouslySetInnerHTML={{ __html: signalCss }} />
      )}
      {toolbar && svarApi && (
        <SvarToolbar api={svarApi} {...(svarToolbarItems ? { items: svarToolbarItems } : {})} />
      )}
      {ganttWithMenu}
      {editor && svarApi && (
        <SvarEditor
          api={svarApi}
          {...(svarEditorItems ? { items: svarEditorItems } : {})}
          {...(editorPlacement ? { placement: editorPlacement } : {})}
        />
      )}
      {tooltip && TooltipContent && svarApi && (
        <SvarTooltip api={svarApi} content={TooltipContent} />
      )}
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

export const ConstructionBar: FC<{ data: SvarTaskWithComputed }> = ({ data }) => {
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
  const showSlackIndicator = !isSummary && !isCritical && totalSlack >= 270; // >= 30 min more than half a day
  const hasDeadline = data.deadline != null;
  const deadlineMissed = data.deadline_missed ?? false;

  // Bar fill: defer entirely to SVAR's Willow theme tokens so our bars match
  // the renderer's clean default look (and re-skin with any consumer theme /
  // the `--wx-*` surface, as a consumer can). SVAR two-tones every bar — a lighter
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
        overflow: 'hidden',
        fontSize: 'var(--wx-font-size-sm, 12px)',
        fontWeight: isSummary ? 600 : 500,
        color: 'var(--wx-gantt-task-font-color, #fff)',
        background: trackBg,
        borderRadius: 'var(--wx-gantt-bar-border-radius, 3px)',
      }}
    >
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
      <span
        style={{
          position: 'relative',
          zIndex: 1,
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {data.text}
      </span>
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

function getInputValue(task: Task, field: EditableField): string {
  switch (field) {
    case 'text':
      return task.text;
    case 'start':
      return formatShortDate(task.start);
    case 'end':
      return formatShortDate(task.end);
    case 'duration':
      return formatDuration(task.duration);
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

function buildEditableCell(
  field: EditableField,
  editStateRef: { readonly current: EditState },
  onTaskEditRef: { readonly current: GanttProps['onTaskEdit'] },
): IColumnConfig['cell'] {
  return ({ row }: { row: unknown }) => {
    const editState = editStateRef.current;
    const task = row as SvarTaskWithComputed;
    if (task.is_baseline_ghost || (task as { is_edit_preview?: boolean }).is_edit_preview) {
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
      if (field === 'duration') return formatDuration(task.duration ?? 0);
      if (field === 'progress') return String(task.progress ?? 0);
      return String((task as Record<string, unknown>)[field] ?? '');
    })();

    if (isReadOnly || task.id === undefined) {
      return <span>{displayValue}</span>;
    }

    const taskId = task.id as TaskId;
    const activate = () =>
      editStateRef.current.activateCell(
        taskId,
        field,
        getInputValue(task as unknown as Task, field),
      );

    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: cell activation via keyboard handled by the input that renders on activate
      // biome-ignore lint/a11y/noStaticElementInteractions: grid cell — role="gridcell" would be on the parent SVAR element
      <span style={{ cursor: 'text', display: 'block', width: '100%' }} onClick={activate}>
        {displayValue}
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
