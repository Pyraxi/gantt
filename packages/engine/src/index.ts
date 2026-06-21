// @pyraxi/cpm-engine — headless construction scheduling engine.
//
// Pure TypeScript: forward/backward critical-path pass, 8 MS Project constraint
// types, negative slack, working-time calendars, baselines, MSPDI interop,
// command-pattern editing model. No React, no SVAR, no DOM. The renderer-agnostic IP.

export type { ProjectStats } from './analysis.js';
export { getCriticalPath, getProjectStats } from './analysis.js';
export type { TaskBaselineVariance } from './baseline.js';
export {
  captureBaseline,
  getTaskBaselineVariance,
  getTaskBaselineVarianceAll,
} from './baseline.js';
// NZ public holidays + default calendar
export type { NZDefaultCalendarOptions, NZRegion } from './calendars/nz-holidays.js';
export { nzDefaultCalendar, nzPublicHolidays } from './calendars/nz-holidays.js';
export type { DurationUnitMinutes } from './duration-units.js';
export { DEFAULT_DURATION_UNITS, formatDuration, parseDuration } from './duration-units.js';
export * from './editing/command-history.js';
// Editing model (command-pattern; ADR-006)
export type { EditCommand } from './editing/commands.js';
export * from './editing/draft-project.js';
export { EditError } from './editing/errors.js';
export {
  createTask,
  deleteLink,
  deleteTask,
  linkTasks,
  renameTask,
  setTaskDuration,
  setTaskProgress,
  setTaskStart,
  setUnscheduled,
  splitTask,
  unsetSplit,
  updateLink,
  updateTask,
} from './editing/factories.js';
// MSPDI XML interop
export { parseMspdi } from './mspdi/parse.js';
export { serializeMspdi } from './mspdi/serialize.js';
export type { DroppedField, MspdiParseResult, MspdiSerializeOptions } from './mspdi/types.js';
// Scheduling engine
export { schedule } from './schedule.js';
export { topologicalSort } from './topological-sort.js';
// Data model + chrome config types
export type {
  Assignment,
  AssignmentId,
  Baseline,
  BaselineIndex,
  BaselineTaskSnapshot,
  Calendar,
  CalendarException,
  CalendarId,
  Constraint,
  ConstraintType,
  DayOfWeek,
  DependencyType,
  GanttContextMenuConfig,
  GanttContextMenuItem,
  GanttEditorConfig,
  GanttEditorField,
  GanttEditorFieldComp,
  GanttLocaleWords,
  GanttToolbarConfig,
  GanttToolbarItem,
  GanttZoomConfig,
  GanttZoomLevel,
  Link,
  LinkId,
  Project,
  Resource,
  ResourceId,
  ScheduleMode,
  Task,
  TaskComputed,
  TaskId,
  TaskSegment,
  TaskType,
  WorkInterval,
} from './types.js';
// ---------------------------------------------------------------------------
// Internal surface consumed by @pyraxi/gantt (the view's editing hooks + render
// preview). Not part of the curated public API — re-exported so the sibling
// view package can build against the engine. @internal
// ---------------------------------------------------------------------------
export { filterTasksByVisibility } from './visibility.js';
export {
  addWorkingMinutes,
  getDayWorkingMinutes,
  isWorkingDay,
  isWorkingTime,
  snapToNextWorkingMoment,
  snapToPreviousWorkingMoment,
  subtractWorkingMinutes,
  workingMinutesBetween,
} from './working-time.js';
