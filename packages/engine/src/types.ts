// Core data model for the Pyraxi CPM engine.
//
// Designed to overlap with MS Project's data shape where it matters for
// MSPDI XML round-trip (ADR-003): all 8 constraint types, manual/auto
// scheduling per task, multi-baseline (0-10), working-time calendars with
// partial-day shifts.
//
// These types are public API and SVAR-agnostic per ADR-002. The wrapper
// converts them to SVAR's ITask before handing to the renderer.

export type TaskId = string | number;
export type LinkId = string | number;
export type ResourceId = string | number;
export type CalendarId = string | number;
export type AssignmentId = string | number;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskType = 'task' | 'summary' | 'milestone';

export type ScheduleMode = 'auto' | 'manual';

/**
 * MS Project's 8 constraint types.
 *
 * - ASAP / ALAP: scheduling preferences, no date required.
 * - MSO / MFO:   hard constraints, pin the date; override predecessor logic.
 * - SNET / SNLT / FNET / FNLT: soft date bounds.
 *
 * Hard constraints can produce negative slack — the contract-trouble
 * signal we surface rather than silently clip to zero (ADR-003).
 */
export type ConstraintType = 'ASAP' | 'ALAP' | 'MSO' | 'MFO' | 'SNET' | 'SNLT' | 'FNET' | 'FNLT';

export interface Constraint {
  type: ConstraintType;
  /** Required for all types except ASAP and ALAP. */
  date?: Date;
}

export interface Task {
  id: TaskId;
  text: string;
  /** Hierarchy parent. Undefined = top-level. */
  parent?: TaskId;
  type: TaskType;
  scheduleMode: ScheduleMode;

  /**
   * For summary tasks: are children currently expanded?
   * Default true (expanded). Toggled by the user via the renderer's
   * collapse/expand chevron.
   */
  open?: boolean;

  /** Working-time duration in minutes. For milestones this is 0. */
  duration: number;

  /**
   * User-set start / end. For manual-scheduled tasks these are authoritative.
   * For auto-scheduled tasks the engine recomputes them and writes the
   * result back. Either way, the engine populates `computed` with the
   * full forward/backward-pass data.
   */
  start: Date;
  end: Date;

  /** Percent complete, 0-100. */
  progress: number;

  constraint?: Constraint;

  /** Resource assignments. Order is not meaningful. */
  resourceIds?: ResourceId[];

  /**
   * Calendar override. If unset, the task uses the project default calendar.
   * If a resource on the task has a calendar, the engine reconciles them
   * (resource calendar wins for activities depending on that resource).
   */
  calendarId?: CalendarId;

  /** Populated by the scheduling engine. Read-only for user code. */
  computed?: TaskComputed;

  /**
   * When present, the task is split into discrete working spans separated by
   * non-working gaps (a pour paused for weather, resumed later). `duration`
   * is the sum of working-time across segments. Absent = contiguous (default).
   * Per ADR-007.
   */
  segments?: TaskSegment[];

  /**
   * When true, the task has no committed dates: excluded from forward/backward
   * pass, rendered in the grid but not the timeline, contributes nothing to
   * summary aggregation or critical path. Per ADR-007.
   */
  unscheduled?: boolean;

  /**
   * Consumer-owned fields the engine neither reads nor writes — an opaque
   * carry-through bag for host-app data this component doesn't model (e.g.
   * `actualStart`/`actualFinish`/`wbsCode`/`ownerUserId`). Carried untouched
   * through `schedule()` and the edit pipeline; on MSPDI serialize, keys with
   * no MSPDI home are reported in `droppedFields` (transparent loss), never
   * silently dropped. The escape hatch for host-app data: the component
   * guarantees the bag survives a round trip and never interprets its contents.
   */
  extra?: Record<string, unknown>;

  /**
   * Indicative contractual / sectional-completion date (NZS 3910). Non-scheduling:
   * never moves the task or affects CPM. The engine flags `deadlineMissed` when the
   * computed finish slips past it. Distinct from a FNLT constraint, which limits/moves.
   */
  deadline?: Date;
}

/** One working span of a split (interrupted) task. */
export interface TaskSegment {
  start: Date;
  end: Date;
}

/**
 * Forward/backward-pass output. Filled in by `schedule()`.
 *
 * `totalSlack` is the contract-trouble signal: when negative, the task is
 * already late against a downstream constraint and the schedule is
 * infeasible without intervention. We display this; we don't clip it.
 */
export interface TaskComputed {
  earlyStart: Date;
  earlyFinish: Date;
  lateStart: Date;
  lateFinish: Date;
  /** Working-minutes of total float. Can be negative. */
  totalSlack: number;
  /** Working-minutes of free float (slack against the earliest successor). */
  freeSlack: number;
  isCritical: boolean;
  /** Present only when the task has a `deadline`. True iff `earlyFinish > deadline`. */
  deadlineMissed?: boolean;
  /**
   * Present only when the task has a `deadline`. Signed working-minutes from
   * `earlyFinish` to `deadline`: positive = room to spare, negative = overrun.
   * Mirrors `totalSlack`'s "negative = bad" convention.
   */
  deadlineSlackMinutes?: number;
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Dependency type, matching MS Project notation:
 * - FS = Finish-to-Start (most common in construction)
 * - SS = Start-to-Start (concurrent activities sharing a start trigger)
 * - FF = Finish-to-Finish (concurrent activities sharing a finish gate)
 * - SF = Start-to-Finish (rare; reverse-direction)
 */
export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF';

export interface Link {
  id: LinkId;
  source: TaskId;
  target: TaskId;
  type: DependencyType;
  /**
   * Lag in working-minutes. Positive = delay, negative = lead.
   * Construction example: 3-day cure time on a FS link = lag of 3 working days
   * converted to minutes via the calendar.
   */
  lag: number;
}

// ---------------------------------------------------------------------------
// Calendars (working-time)
// ---------------------------------------------------------------------------

/** Minutes-from-midnight working interval. e.g. 8am-5pm = {480, 1020}. */
export interface WorkInterval {
  startMinutes: number;
  endMinutes: number;
}

export type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6; // Sun=0 … Sat=6

/**
 * A calendar describes when work happens.
 *
 * - `workWeek` is the recurring base: 7 entries, each an array of intervals.
 *   Empty array = non-working day. Multiple intervals = split shift
 *   (e.g. 7-12 + 13-15 for concreting with a lunch break).
 * - `exceptions` override specific dates: holidays, weather days, site
 *   shutdown periods, or "this Saturday is a working day."
 * - `baseCalendarId` lets resource/task calendars inherit from a base
 *   and override only the differences.
 */
export interface Calendar {
  id: CalendarId;
  name: string;
  workWeek: WorkInterval[][];
  exceptions: CalendarException[];
  baseCalendarId?: CalendarId;
}

export interface CalendarException {
  date: Date;
  /** false = non-working day (holiday). true = working with given intervals. */
  isWorking: boolean;
  intervals?: WorkInterval[];
  /** Display name. NZ Anzac Day, Auckland Anniversary, weather day, etc. */
  name?: string;
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

export interface Resource {
  id: ResourceId;
  name: string;
  /** Optional per-resource calendar override (plasterer's 4-day week, etc.). */
  calendarId?: CalendarId;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

/**
 * Allocates a Resource to a Task. v0.2 first cut carries only the core
 * triple (taskId + resourceId + units) — enough to round-trip MSPDI
 * <Assignment> elements without losing the allocation graph.
 *
 * Per-day timephased work data + cost tracking + EV fields are MSPDI-side
 * concerns that we don't yet model internally; they appear in
 * `droppedFields` on parse rather than entering our model.
 *
 * The eventual v0.4 editing-model expansion will likely add `actualWork`,
 * `plannedWork`, and `progress` fields here, plus a separate
 * `TimephasedSpread` type for per-day allocations.
 */
export interface Assignment {
  id: AssignmentId;
  taskId: TaskId;
  resourceId: ResourceId;
  /**
   * Allocation share. 1.0 = 100% (fully assigned). 0.5 = part-time. >1.0
   * is over-allocated (MS Project allows this — the renderer surfaces it
   * with the OverAllocated flag). Default 1.0 if omitted.
   */
  units?: number;
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

/** MS Project supports 11 baselines (Baseline 0-10). We match. */
export type BaselineIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface Baseline {
  index: BaselineIndex;
  /** Display name. "Original contract programme", "Variation 1 reprogramme", etc. */
  name?: string;
  capturedAt: Date;
  /** Snapshot of task dates + durations at capture time. */
  tasks: Map<TaskId, BaselineTaskSnapshot>;
}

export interface BaselineTaskSnapshot {
  start: Date;
  end: Date;
  duration: number;
}

// ---------------------------------------------------------------------------
// Chrome config types (ADR-002: SVAR-agnostic public shapes)
// ---------------------------------------------------------------------------

/**
 * Named zoom levels for the Gantt chart.
 * Each name maps to a pair of SVAR scale rows (header + row).
 * Construction PM typical view: 'week' or 'month'.
 */
export type GanttZoomLevel = 'hour' | 'day' | 'week' | 'month' | 'quarter';

/**
 * Zoom configuration. Passed as `zoom` prop on `<Gantt>`.
 * Converted internally to SVAR's IZoomConfig (ADR-002).
 */
export interface GanttZoomConfig {
  /**
   * Named levels available via scroll-wheel zoom.
   * Default: ['day', 'week', 'month'].
   */
  levels?: GanttZoomLevel[];
  /**
   * Level active on mount. Default: first entry in `levels`.
   */
  default?: GanttZoomLevel;
}

/**
 * A single item in a custom Gantt toolbar.
 * SVAR-agnostic: converted to SVAR's IToolbarItem internally.
 */
export type GanttToolbarItem = {
  /** Button id (e.g. 'add-task', 'undo', 'redo', 'separator', or custom). */
  id?: string;
  /** Label text. */
  text?: string;
  /** Icon CSS class name (SVAR icon convention). */
  icon?: string;
  /** Click handler. */
  onClick?: (item: GanttToolbarItem) => void;
};

/**
 * Toolbar configuration. `true` = SVAR defaults; object = custom items.
 */
export interface GanttToolbarConfig {
  /**
   * Items to render. Default (when `toolbar: true`): SVAR's built-in buttons
   * (add-task, undo, redo, separators).
   */
  items?: GanttToolbarItem[];
}

/**
 * A single item in a custom Gantt context menu.
 */
export type GanttContextMenuItem = {
  id?: string;
  text?: string;
  icon?: string;
  /** Submenu items. */
  items?: GanttContextMenuItem[];
  /** Click handler. */
  onClick?: (item: GanttContextMenuItem) => void;
  separator?: boolean;
};

/**
 * Context-menu configuration. `true` = SVAR defaults; object = custom items.
 */
export interface GanttContextMenuConfig {
  /**
   * Menu items. Default (when `contextMenu: true`): SVAR built-in items
   * (add child/above/below, edit, cut, copy, paste, indent/outdent, split, delete).
   */
  items?: GanttContextMenuItem[];
}

/** Field component types for the task editor form. */
export type GanttEditorFieldComp =
  | 'text'
  | 'textarea'
  | 'date'
  | 'counter'
  | 'checkbox'
  | 'select'
  | 'combo'
  | 'slider';

/** A single field in the task editor form. */
export type GanttEditorField = {
  /** Task field key (e.g. 'text', 'start', 'end', 'duration', 'progress'). */
  key: string;
  /** Display label. */
  label?: string;
  /** Input component type. */
  comp?: GanttEditorFieldComp;
  /** Whether the field is required. */
  required?: boolean;
};

/**
 * Editor (task-edit form) configuration. `true` = SVAR defaults; object = custom.
 */
export interface GanttEditorConfig {
  /**
   * Fields to show. Default (when `editor: true`): SVAR built-in fields
   * (name, type, start, end, duration, progress, description, predecessors, successors).
   */
  fields?: GanttEditorField[];
  /**
   * Editor placement. 'modal' (default) | 'sidebar'.
   * Note: 'inline' clashes with our own inline cell editing;
   * use 'modal' or 'sidebar' for SVAR's Editor.
   */
  placement?: 'modal' | 'sidebar';
}

/**
 * Locale word overrides for Pyraxi + SVAR UI strings.
 * Partial — missing keys fall back to English defaults.
 * Passed as `locale` prop on `<Gantt>`.
 */
export interface GanttLocaleWords {
  /**
   * Gantt-specific strings. Keys match @svar-ui/gantt-locales en.js.
   */
  gantt?: Record<string, string>;
  /**
   * Calendar/date strings (day/month names, week start).
   */
  calendar?: {
    dayShort?: string[];
    dayFull?: string[];
    monthShort?: string[];
    monthFull?: string[];
    weekStart?: number;
  };
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface Project {
  /** Project start anchor. Forward pass starts here. */
  start: Date;
  /** Optional finish anchor. If set, backward pass terminates here instead of latest task EarlyFinish. */
  end?: Date;
  defaultCalendarId: CalendarId;
  tasks: Task[];
  links: Link[];
  resources: Resource[];
  calendars: Calendar[];
  /** Up to 11 entries (Baseline 0-10). */
  baselines: Baseline[];
  /** Resource-to-task allocations. Empty array if no resources are allocated. */
  assignments: Assignment[];
}
