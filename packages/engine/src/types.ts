// Core data model for construction-gantt.
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

  /**
   * Duration in minutes: working minutes, or wall-clock minutes when
   * `durationElapsed`. For milestones this is 0.
   */
  duration: number;

  /**
   * The duration runs in elapsed (wall-clock) time — through nights, weekends
   * and holidays (MS Project `3ed`; curing, drying). Scheduled on a 24/7
   * calendar that overrides the task's and its resources' calendars.
   */
  durationElapsed?: boolean;

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

  /**
   * Physical % complete, 0-100: how much of the work is in place, judged on
   * site, independently of `progress` (duration %). MS Project / P6 keep both;
   * it drives earned value and, optionally, the progress line
   * (`progressPoints(…, { basis: 'physical' })`). Never schedules.
   */
  physicalProgress?: number;

  /**
   * When work actually started. With `Project.statusDate` set, a task with an
   * actual start (or 0 < progress < 100) is in progress: its start is fixed
   * and its remaining work follows the work done (see `Project.statusDate`).
   */
  actualStart?: Date;
  /** When work actually finished. With `Project.statusDate` set, the task is complete and fixed. */
  actualFinish?: Date;
  /**
   * Activity-code values, keyed by `CodeType.id` (trade, area, level,
   * subcontractor). Metadata for grouping / filtering; never scheduled on.
   */
  codes?: Record<string, string>;
  /**
   * Set only on the virtual rows `groupProject` creates: which grouping and
   * value the row stands for. A UI can use it to treat the row as read-only.
   */
  group?: { by: string; value: string; color?: string };
  /**
   * Working minutes left. With `Project.statusDate` set and this absent, it's
   * `duration × (1 − progress / 100)` (P6 duration % complete).
   */
  remainingDuration?: number;

  constraint?: Constraint;
  /**
   * P6 secondary constraint: one of SNET / SNLT / FNET / FNLT, applied after
   * `constraint` (e.g. primary SNET + secondary FNLT — a start floor and a
   * finish deadline). Ignored when the primary is mandatory (MSO / MFO), as
   * P6 disallows it. Not in MSPDI (MS Project has one constraint per task).
   */
  secondaryConstraint?: Constraint;
  /**
   * P6 Expected Finish: with a status date, an in-progress task's remaining
   * work is the working time from the status date to this date (overriding
   * `remainingDuration` / `progress`). Ignored without a status date.
   */
  expectedFinish?: Date;

  /** Resource assignments. Order is not meaningful. */
  resourceIds?: ResourceId[];

  /**
   * Calendar override. If unset, the task uses the project default calendar.
   * `schedule()` works the task in this calendar intersected with the
   * calendar of every assigned resource that has an explicit `calendarId`
   * (see `getEffectiveCalendar`). An unknown id falls back to the default.
   */
  calendarId?: CalendarId;

  /**
   * When true, assigned resources' calendars are ignored and the task works
   * in its own (or the default) calendar only. MSPDI `<IgnoreResourceCalendar>`.
   */
  ignoreResourceCalendar?: boolean;

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
  /** Present only when `Project.statusDate` is set: where the task stands at the status date. */
  status?: 'not-started' | 'in-progress' | 'complete';
  /** In-progress tasks (status date set): when the remaining work is forecast to start. */
  remainingStart?: Date;
  /**
   * In-progress tasks (status date set): started before a finish-to-start /
   * finish-to-finish predecessor finished, or a start-to-start /
   * start-to-finish predecessor started.
   */
  outOfSequence?: boolean;
  /**
   * Present only when the engine could not use the task's calendars as given
   * and fell back. `'unknown-calendar'`: the task's `calendarId` matches no
   * calendar, so the default was used. `'empty-calendar'`: the task's calendar
   * has no working time (or its base chain is broken), so the default was used.
   * `'empty-intersection'`: the task and resource calendars share no working
   * time, so resource calendars were ignored.
   */
  calendarFallback?: 'unknown-calendar' | 'empty-calendar' | 'empty-intersection';
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
   * Lag in minutes — working minutes, or wall-clock minutes when `lagElapsed`.
   * Positive = delay, negative = lead. Ignored when `lagPercent` is set.
   * Construction example: 3-day cure time on a FS link = lag of 3 working days
   * converted to minutes via the calendar.
   */
  lag: number;
  /**
   * Lag as a percentage of the predecessor's duration (MS Project `FS+50%`;
   * negative = lead). When set it overrides `lag`: the effective lag is
   * `round(source.duration × lagPercent / 100)` minutes (see `lagMinutes`) —
   * working, or elapsed when `lagElapsed` is also set.
   */
  lagPercent?: number;
  /**
   * The lag runs in elapsed (wall-clock) time — through nights, weekends and
   * holidays — instead of working time (MS Project `2ed`; concrete curing).
   */
  lagElapsed?: boolean;
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
 * - `baseCalendarId` lets resource/task calendars inherit from a base:
 *   the base's exceptions apply on dates the derived calendar doesn't
 *   override, and `inheritedDays` take the base's weekly intervals.
 */
export interface Calendar {
  id: CalendarId;
  name: string;
  workWeek: WorkInterval[][];
  exceptions: CalendarException[];
  baseCalendarId?: CalendarId;
  /**
   * Weekdays whose intervals come from the base calendar instead of
   * `workWeek` (the `workWeek` entry for those days is ignored). Only
   * meaningful with `baseCalendarId`. MSPDI derived calendars omit the
   * `<WeekDay>`s they inherit; the parser records them here.
   */
  inheritedDays?: DayOfWeek[];
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
   * Note: 'inline' clashes with construction-gantt's own inline cell editing;
   * use 'modal' or 'sidebar' for SVAR's Editor.
   */
  placement?: 'modal' | 'sidebar';
}

/**
 * Locale word overrides for construction-gantt + SVAR UI strings.
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
  /**
   * Status date. When set, `schedule()` schedules from the actuals, as MS
   * Project does: complete tasks are fixed at their actual dates, and an
   * in-progress task keeps its actual start, with its remaining work right
   * after the work done (or after an unfinished predecessor, with retained
   * logic). The status date itself moves nothing, so unstarted or remaining
   * work can sit behind it; `checkSchedule()` reports that as invalid dates.
   * Set `rescheduleAfterStatusDate` to forecast from it instead (P6).
   * Manual-mode tasks keep their user dates; only their `computed.status` is
   * reported. Unset = progress is cosmetic (byte-identical to before).
   */
  statusDate?: Date;
  /**
   * Forecast work left to do from the status date, like P6's data date or MS
   * Project's "Reschedule uncompleted work to start after": in-progress
   * remaining work starts no earlier than the status date, and nothing
   * unstarted is forecast before it (except a hard MSO / MFO pin, which wins).
   * Default `false`: MS Project's own scheduling (see `statusDate`).
   */
  rescheduleAfterStatusDate?: boolean;
  /**
   * How in-progress remaining work treats its predecessors (status date set).
   * `'retained-logic'` (default): it still waits for unfinished predecessors.
   * `'progress-override'`: logic is ignored for work already under way.
   */
  progressMode?: 'retained-logic' | 'progress-override';
  /** Activity-code vocabularies (P6 activity codes / MS Project outline codes, flat). */
  codeTypes?: CodeType[];
}

// ---------------------------------------------------------------------------
// Activity codes (parity row 8)
// ---------------------------------------------------------------------------

/** One activity-code vocabulary, e.g. Trade: Plumbing, Framing, … */
export interface CodeType {
  id: string;
  name: string;
  /** Allowed values, in display / grouping order. */
  values: CodeValue[];
}

export interface CodeValue {
  value: string;
  /** Display name (group-row title); defaults to `value`. */
  description?: string;
  /** Group / bar colour hint (CSS colour). */
  color?: string;
}
