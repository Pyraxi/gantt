// MSPDI XML → internal Project. Hand-mapped, supported-subset only.
// Unrecognised MSPDI elements surface in `droppedFields` rather than
// being silently discarded.

import { XMLParser } from 'fast-xml-parser';
import type {
  Assignment,
  Baseline,
  BaselineIndex,
  BaselineTaskSnapshot,
  Calendar,
  CalendarException,
  DayOfWeek,
  DependencyType,
  Link,
  Project,
  Resource,
  Task,
  TaskId,
  TaskType,
  WorkInterval,
} from '../types.js';
import type { DroppedField, MspdiParseResult } from './types.js';

// Field names we know about and either map or intentionally ignore on parse.
// Everything outside this set lands in `droppedFields`.
//
// The list is intentionally broad: real MS Project exports emit ~50 fields
// per Task, most of which are MS-Project-computed state (CPM results, EV,
// rates, costs, leveling). We don't preserve these on round-trip — our
// engine recomputes the equivalent fields. Listing them here keeps
// `droppedFields` focused on genuinely-unknown elements rather than
// recompute-able noise.
const KNOWN_TASK_FIELDS = new Set([
  // Mapped — read into the internal Task shape
  'UID',
  'ID',
  'Name',
  'Start',
  'Finish',
  'Duration',
  'ConstraintType',
  'ConstraintDate',
  'Deadline',
  'Milestone',
  'Summary',
  'OutlineLevel',
  'PredecessorLink',
  'Baseline',
  // Allowed but ignored (default-bearing structure or recompute-able state)
  'Type', // task type code; only Milestone + Summary flags affect us
  // IsNull is now mapped: IsNull=1 → Task.unscheduled=true (ADR-007)
  'IsNull',
  'CreateDate',
  'WBS',
  'OutlineNumber',
  'Priority',
  'PercentComplete',
  'PercentWorkComplete',
  'PhysicalPercentComplete',
  'EarnedValueMethod',
  'DurationFormat',
  'Work',
  'ResumeValid',
  'EffortDriven',
  'Recurring',
  'OverAllocated',
  'Estimated',
  'Critical',
  'IsSubproject',
  'IsSubprojectReadOnly',
  'ExternalTask',
  // CPM results — recomputed by our engine
  'EarlyStart',
  'EarlyFinish',
  'LateStart',
  'LateFinish',
  'StartVariance',
  'FinishVariance',
  'WorkVariance',
  'FreeSlack',
  'TotalSlack',
  // Cost + work tracking — outside our v0.2 scope
  'FixedCost',
  'FixedCostAccrual',
  'Cost',
  'OvertimeCost',
  'OvertimeWork',
  'ActualDuration',
  'ActualCost',
  'ActualOvertimeCost',
  'ActualWork',
  'ActualOvertimeWork',
  'RegularWork',
  'RemainingDuration',
  'RemainingCost',
  'RemainingWork',
  'RemainingOvertimeCost',
  'RemainingOvertimeWork',
  'ACWP',
  'CV',
  'BCWS',
  'BCWP',
  // Calendar override per task + leveling — not in our v0.2 scope
  'CalendarUID',
  'LevelAssignments',
  'LevelingCanSplit',
  'LevelingDelay',
  'LevelingDelayFormat',
  'IgnoreResourceCalendar',
  'HideBar',
  'Rollup',
  // Server/publishing — meaningless outside MS Project Server context
  'IsPublished',
  'CommitmentType',
]);

const KNOWN_PROJECT_FIELDS = new Set([
  'Name',
  'Title',
  'Author',
  'StartDate',
  'Tasks',
  // ignored without dropping for v0.2 first cut (will be supported in
  // future commits — listed here so we don't noise up droppedFields)
  'Calendars',
  'Resources',
  'Assignments',
  'WBSMasks',
  'OutlineCodes',
  'ExtendedAttributes',
  // pure metadata that consumers should preserve via meta-roundtrip but
  // doesn't enter our Project shape
  'Manager',
  'Company',
  'Subject',
  'Category',
  'Keywords',
  'Comments',
  'CreationDate',
  'LastSaved',
  'FinishDate',
  'CurrencyCode',
  'ScheduleFromStart',
  'FYStartDate',
  'CriticalSlackLimit',
  'CurrencyDigits',
  'CurrencySymbol',
  'CurrencySymbolPosition',
  'CalendarUID',
  'DefaultStartTime',
  'DefaultFinishTime',
  'MinutesPerDay',
  'MinutesPerWeek',
  'DaysPerMonth',
  'DefaultTaskType',
  'DefaultFixedCostAccrual',
  'DefaultStandardRate',
  'DefaultOvertimeRate',
  'DurationFormat',
  'WorkFormat',
  'EditableActualCosts',
  'HonorConstraints',
  'EarnedValueMethod',
  'InsertedProjectsLikeSummary',
  'MultipleCriticalPaths',
  'NewTasksEffortDriven',
  'NewTasksEstimated',
  'SplitsInProgressTasks',
  'SpreadActualCost',
  'SpreadPercentComplete',
  'TaskUpdatesResource',
  'FiscalYearStart',
  'WeekStartDay',
  'MoveCompletedEndsBack',
  'MoveRemainingStartsBack',
  'MoveRemainingStartsForward',
  'MoveCompletedEndsForward',
  'BaselineForEarnedValue',
  'AutoAddNewResourcesAndTasks',
  'StatusDate',
  'CurrentDate',
  'MicrosoftProjectServerURL',
  'Autolink',
  'NewTaskStartDate',
  'DefaultTaskEVMethod',
  'ProjectExternallyEdited',
  'ExtendedCreationDate',
  'ActualsInSync',
  'AdminProject',
  'RemoveFileProperties',
  'SaveVersion',
  'UID',
]);

const KNOWN_PREDECESSOR_FIELDS = new Set([
  'PredecessorUID',
  'Type',
  'LinkLag',
  'CrossProject',
  'CrossProjectName',
  // LagFormat is a magic number (7=minutes, 5=hours, 39=days) describing
  // how the consumer should *display* LinkLag — we always normalize to
  // minutes internally, so it's allowed-but-ignored.
  'LagFormat',
]);

export function parseMspdi(xml: string): MspdiParseResult {
  const parser = new XMLParser({
    ignoreAttributes: true,
    isArray: (_name, jpath) =>
      jpath === 'Project.Tasks.Task' ||
      jpath.endsWith('.PredecessorLink') ||
      jpath === 'Project.Calendars.Calendar' ||
      jpath === 'Project.Resources.Resource' ||
      jpath === 'Project.Assignments.Assignment' ||
      jpath.endsWith('.WeekDays.WeekDay') ||
      jpath.endsWith('.WorkingTimes.WorkingTime') ||
      jpath === 'Project.Tasks.Task.Baseline',
    parseTagValue: false, // keep everything as strings; we coerce per-field
    trimValues: true,
  });

  const doc = parser.parse(xml);
  const root = doc.Project;
  if (!root) {
    throw new Error('parseMspdi: <Project> root element missing');
  }

  const droppedFields: DroppedField[] = [];

  // Scan the project-level fields we don't know about.
  for (const [key, value] of Object.entries(root)) {
    if (KNOWN_PROJECT_FIELDS.has(key)) continue;
    droppedFields.push({
      path: `Project.${key}`,
      value: stringifyForDiag(value),
      reason: 'unsupported-element',
    });
  }

  const tasks: Task[] = [];
  const links: Link[] = [];
  const outlineStack: TaskId[] = [];
  // Per-task baseline snapshots, keyed by baseline Number (BaselineIndex).
  // Flattened into project.baselines below.
  const baselineAccum = new Map<BaselineIndex, Map<TaskId, BaselineTaskSnapshot>>();

  // F7 fix: pre-compute a project start anchor for use as a fallback when an
  // individual task's Start/Finish is absent (e.g. IsNull tasks). This avoids
  // propagating Invalid Date / NaN through the data model.
  const projectAnchorDate: Date = root.StartDate
    ? (() => {
        const d = parseMspdiDate(String(root.StartDate));
        return Number.isNaN(d.getTime()) ? new Date(0) : d;
      })()
    : new Date(0);

  const rawTasks: unknown[] = root.Tasks?.Task ?? [];
  if (!Array.isArray(rawTasks)) {
    throw new Error('parseMspdi: <Tasks> contained a non-array Task collection (malformed)');
  }

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i] as Record<string, unknown>;
    const taskPath = `Project.Tasks.Task[${i}]`;

    // Map the supported fields.
    const uid = String(raw.UID ?? raw.ID ?? '');
    if (!uid) throw new Error(`parseMspdi: ${taskPath} missing UID and ID`);

    const name = String(raw.Name ?? '');
    // F7 fix: guard against absent Start/Finish on IsNull tasks. parseMspdiDate('')
    // returns Invalid Date which propagates NaN into serialized XML. Fall back to
    // the project start anchor (never NaN) so the Task object is always valid.
    // We do NOT modify parseMspdiDate itself (shared by constraints/calendars/baselines).
    const rawStart = parseMspdiDate(String(raw.Start ?? ''));
    const rawEnd = parseMspdiDate(String(raw.Finish ?? ''));
    const start = Number.isNaN(rawStart.getTime()) ? new Date(projectAnchorDate) : rawStart;
    const end = Number.isNaN(rawEnd.getTime()) ? new Date(projectAnchorDate) : rawEnd;
    const duration = parseMspdiDuration(String(raw.Duration ?? 'PT0H0M0S'));

    const isMilestone = String(raw.Milestone ?? '0') === '1';
    const isSummary = String(raw.Summary ?? '0') === '1';
    const taskType: TaskType = isSummary ? 'summary' : isMilestone ? 'milestone' : 'task';
    const outlineLevel = Math.max(1, Number(raw.OutlineLevel ?? '1'));
    const parentId = outlineLevel > 1 ? outlineStack[outlineLevel - 2] : undefined;
    const constraint = parseConstraint(raw);

    const parsedTask: Task = {
      id: uid,
      text: name,
      type: taskType,
      scheduleMode: 'auto',
      duration,
      start,
      end,
      progress: Number(raw.PercentComplete ?? '0'),
    };
    if (parentId !== undefined) parsedTask.parent = parentId;
    if (constraint !== undefined) parsedTask.constraint = constraint;
    if (raw.Deadline !== undefined) {
      const dl = parseMspdiDate(String(raw.Deadline));
      if (!Number.isNaN(dl.getTime())) parsedTask.deadline = dl;
    }
    // ADR-007: IsNull=1 in MSPDI marks a task with no committed dates.
    // Map to our unscheduled flag. MS Project uses this for manually-scheduled
    // tasks with absent Start/Finish (provisional-sum / PC-item scenario).
    if (String(raw.IsNull ?? '0') === '1') {
      parsedTask.unscheduled = true;
    }
    tasks.push(parsedTask);

    outlineStack[outlineLevel - 1] = uid;
    outlineStack.length = outlineLevel;

    // Walk predecessor links nested inside the task.
    const preds: unknown[] = Array.isArray(raw.PredecessorLink)
      ? (raw.PredecessorLink as unknown[])
      : raw.PredecessorLink !== undefined
        ? [raw.PredecessorLink]
        : [];

    for (let p = 0; p < preds.length; p++) {
      const link = preds[p] as Record<string, unknown>;
      const srcUid = String(link.PredecessorUID ?? '');
      if (!srcUid) continue;

      const mspdiType = Number(link.Type ?? '1');
      const linkType: DependencyType = mspdiTypeToDependencyType(mspdiType);
      const lagTenthsOfMinute = Number(link.LinkLag ?? '0');
      const lagMinutes = Math.round(lagTenthsOfMinute / 10);

      links.push({
        id: `${srcUid}-${uid}-${p}`,
        source: srcUid,
        target: uid,
        type: linkType,
        lag: lagMinutes,
      });

      // Capture any unknown fields on the predecessor link.
      for (const k of Object.keys(link)) {
        if (KNOWN_PREDECESSOR_FIELDS.has(k)) continue;
        droppedFields.push({
          path: `${taskPath}.PredecessorLink[${p}].${k}`,
          value: stringifyForDiag(link[k]),
          reason: 'unsupported-element',
        });
      }
    }

    // Walk per-task <Baseline> children and accumulate into baselineAccum.
    // MSPDI Baseline lives task-level (each task has up to 11 Baseline
    // children with Number=0..10); our internal Baseline is project-level
    // with a Map<TaskId, snapshot>. Pivot during parse.
    const taskBaselines: unknown[] = Array.isArray(raw.Baseline)
      ? (raw.Baseline as unknown[])
      : raw.Baseline !== undefined
        ? [raw.Baseline]
        : [];

    for (let b = 0; b < taskBaselines.length; b++) {
      const baselineRaw = taskBaselines[b] as Record<string, unknown>;
      const numberStr = String(baselineRaw.Number ?? '');
      const number = Number(numberStr);
      if (!Number.isFinite(number) || number < 0 || number > 10) {
        droppedFields.push({
          path: `${taskPath}.Baseline[${b}].Number`,
          value: numberStr,
          reason: 'unsupported-element',
        });
        continue;
      }
      const index = number as BaselineIndex;
      const snap: BaselineTaskSnapshot = {
        start: parseMspdiDate(String(baselineRaw.Start ?? '')),
        end: parseMspdiDate(String(baselineRaw.Finish ?? '')),
        duration: parseMspdiDuration(String(baselineRaw.Duration ?? 'PT0H0M0S')),
      };
      let acc = baselineAccum.get(index);
      if (!acc) {
        acc = new Map<TaskId, BaselineTaskSnapshot>();
        baselineAccum.set(index, acc);
      }
      acc.set(uid, snap);
    }

    // Scan the task-level fields we don't know about.
    for (const [key, value] of Object.entries(raw)) {
      if (KNOWN_TASK_FIELDS.has(key)) continue;
      droppedFields.push({
        path: `${taskPath}.${key}`,
        value: stringifyForDiag(value),
        reason: 'unsupported-element',
      });
    }
  }

  const projectStart = root.StartDate
    ? parseMspdiDate(String(root.StartDate))
    : (tasks[0]?.start ?? new Date());

  // Calendars. MSPDI optionally nests <Calendars><Calendar>+. Each Calendar's
  // <WeekDays> contains DayType 1-7 entries (the recurring pattern) and
  // DayType=0 entries with TimePeriod (exceptions). See toMspdiCalendar in
  // serialize.ts for the inverse mapping.
  const calendars: Calendar[] = [];
  const rawCalendars: unknown[] = root.Calendars?.Calendar ?? [];
  if (Array.isArray(rawCalendars)) {
    for (let i = 0; i < rawCalendars.length; i++) {
      const raw = rawCalendars[i] as Record<string, unknown>;
      calendars.push(parseMspdiCalendar(raw, `Project.Calendars.Calendar[${i}]`, droppedFields));
    }
  }

  // Resources. v0.2 first cut maps only UID + Name + CalendarUID; rates,
  // types, units, cost, and other MS Project resource fields are
  // intentionally ignored without dropping (we don't yet model them).
  const resources: Resource[] = [];
  const rawResources: unknown[] = root.Resources?.Resource ?? [];
  if (Array.isArray(rawResources)) {
    for (let i = 0; i < rawResources.length; i++) {
      const raw = rawResources[i] as Record<string, unknown>;
      resources.push(parseMspdiResource(raw, `Project.Resources.Resource[${i}]`, droppedFields));
    }
  }

  // Assignments. v0.2 first cut maps only UID + TaskUID + ResourceUID + Units
  // (the resource-to-task allocation triple). Per-day timephased data, cost
  // tracking, and EV fields don't enter our model — they appear in
  // droppedFields if present.
  const assignments: Assignment[] = [];
  const rawAssignments: unknown[] = root.Assignments?.Assignment ?? [];
  if (Array.isArray(rawAssignments)) {
    for (let i = 0; i < rawAssignments.length; i++) {
      const raw = rawAssignments[i] as Record<string, unknown>;
      assignments.push(
        parseMspdiAssignment(raw, `Project.Assignments.Assignment[${i}]`, droppedFields),
      );
    }
  }

  // Pick a sensible defaultCalendarId. Prefer the first calendar with
  // `IsBaseCalendar` 1; fall back to the first calendar; fall back to 'std'.
  let defaultCalendarId = 'std';
  const firstCalendar = calendars[0];
  if (firstCalendar) {
    const firstBase = calendars.find((c) => c.baseCalendarId === undefined);
    defaultCalendarId = String((firstBase ?? firstCalendar).id);
  }

  // Flatten the per-task baseline accumulator into our project-level
  // Baseline[] shape. Sort by index for stable order.
  const baselines: Baseline[] = [];
  for (const [index, taskMap] of baselineAccum) {
    baselines.push({
      index,
      // MSPDI doesn't carry baseline name or capturedAt on individual snapshots;
      // synthesize defaults. Consumers who want named baselines can populate
      // these after parse.
      capturedAt: new Date(0),
      tasks: taskMap,
    });
  }
  baselines.sort((a, b) => a.index - b.index);

  const project: Project = {
    start: projectStart,
    defaultCalendarId,
    tasks,
    links,
    resources,
    calendars,
    baselines,
    assignments,
  };

  return { project, droppedFields };
}

const KNOWN_CALENDAR_FIELDS = new Set([
  'UID',
  'Name',
  'IsBaseCalendar',
  'BaseCalendarUID',
  'WeekDays',
]);
const KNOWN_WEEKDAY_FIELDS = new Set(['DayType', 'DayWorking', 'WorkingTimes', 'TimePeriod']);

// v0.2 first cut: only UID + Name + CalendarUID enter our Resource shape.
// Other fields exist in real MS Project exports — listed here as
// allowed-but-ignored so they don't noise up droppedFields.
const KNOWN_RESOURCE_FIELDS = new Set([
  // Mapped
  'UID',
  'ID',
  'Name',
  'CalendarUID',
  // Allowed but ignored (no internal model yet)
  'IsNull',
  'Initials',
  'Group',
  'Code',
  'EmailAddress',
  'WindowsUserAccount',
  'Type',
  'IsGeneric',
  'IsInactive',
  'IsEnterprise',
  'BookingType',
  'MaterialLabel',
  'AccrueAt',
  'MaxUnits',
  'PeakUnits',
  'OverAllocated',
  'AvailableFrom',
  'AvailableTo',
  'StandardRate',
  'StandardRateFormat',
  'OvertimeRate',
  'OvertimeRateFormat',
  'CostPerUse',
  'Cost',
  'CostVariance',
  'OvertimeCost',
  'ActualCost',
  'ActualOvertimeCost',
  'RemainingCost',
  'RemainingOvertimeCost',
  'CostCenter',
  'BudgetCost',
  'BaselineCost',
  'Work',
  'RegularWork',
  'OvertimeWork',
  'ActualWork',
  'RemainingWork',
  'ActualOvertimeWork',
  'RemainingOvertimeWork',
  'PercentWorkComplete',
  'WorkVariance',
  'StartVariance',
  'FinishVariance',
  'BudgetWork',
  'BaselineWork',
  'ACWP',
  'CV',
  'BCWS',
  'BCWP',
  'Start',
  'Finish',
  'CanLevel',
  'NotesText',
  'NotesRTF',
  'CreationDate',
  'Hyperlink',
  'HyperlinkAddress',
  'HyperlinkSubAddress',
  'PhoneticAlias',
  'ExtendedAttribute',
  'Baseline',
  'OutlineCode',
  'TimephasedData',
]);

// v0.2 first cut: only UID + TaskUID + ResourceUID + Units enter our
// Assignment shape. Per-day timephased data, cost tracking, EV fields,
// and confirmed/leveled times are all allowed-but-ignored.
const KNOWN_ASSIGNMENT_FIELDS = new Set([
  // Mapped
  'UID',
  'TaskUID',
  'ResourceUID',
  'Units',
  // Allowed but ignored (no internal model yet)
  'PercentWorkComplete',
  'ActualCost',
  'ActualWork',
  'Cost',
  'CostVariance',
  'Work',
  'WorkVariance',
  'StartVariance',
  'FinishVariance',
  'OvertimeCost',
  'OvertimeWork',
  'ActualOvertimeCost',
  'ActualOvertimeWork',
  'RegularWork',
  'RemainingCost',
  'RemainingWork',
  'RemainingOvertimeCost',
  'RemainingOvertimeWork',
  'ConfirmedFinish',
  'ConfirmedStart',
  'Start',
  'Finish',
  'Stop',
  'Resume',
  'ResumeValid',
  'LevelingDelay',
  'LevelingDelayFormat',
  'Delay',
  'NotesText',
  'NotesRTF',
  'Hyperlink',
  'HyperlinkAddress',
  'HyperlinkSubAddress',
  'CostRateTable',
  'BookingType',
  'ActualStart',
  'ActualFinish',
  'WorkContour',
  'BudgetCost',
  'BudgetWork',
  'BaselineCost',
  'BaselineWork',
  'BaselineStart',
  'BaselineFinish',
  'BaselineBudgetCost',
  'BaselineBudgetWork',
  'ACWP',
  'CV',
  'BCWS',
  'BCWP',
  'Baseline',
  'ExtendedAttribute',
  'TimephasedData',
  'CreationDate',
]);

function parseMspdiCalendar(
  raw: Record<string, unknown>,
  path: string,
  droppedFields: DroppedField[],
): Calendar {
  const id = String(raw.UID ?? raw.Name ?? 'std');
  const name = String(raw.Name ?? id);

  const workWeek: WorkInterval[][] = [[], [], [], [], [], [], []];
  const exceptions: CalendarException[] = [];

  const weekDays: unknown[] =
    ((raw.WeekDays as Record<string, unknown> | undefined)?.WeekDay as unknown[] | undefined) ?? [];

  if (Array.isArray(weekDays)) {
    for (let i = 0; i < weekDays.length; i++) {
      const wd = weekDays[i] as Record<string, unknown>;
      const wdPath = `${path}.WeekDays.WeekDay[${i}]`;
      const dayType = Number(wd.DayType ?? '0');
      const dayWorking = String(wd.DayWorking ?? '0') === '1';

      if (dayType >= 1 && dayType <= 7) {
        // Recurring weekday — DayType 1=Sun ... 7=Sat → DayOfWeek 0=Sun ... 6=Sat
        const dayOfWeek = (dayType - 1) as DayOfWeek;
        workWeek[dayOfWeek] = dayWorking ? parseWorkingTimes(wd) : [];
      } else if (dayType === 0) {
        // Exception entry
        const timePeriod = wd.TimePeriod as Record<string, unknown> | undefined;
        if (!timePeriod) continue;
        const fromDate = parseMspdiDate(String(timePeriod.FromDate ?? ''));
        // Treat as single-day exception, anchored on FromDate's local-day boundary.
        const anchored = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
        const ex: CalendarException = {
          date: anchored,
          isWorking: dayWorking,
        };
        if (dayWorking) {
          const intervals = parseWorkingTimes(wd);
          if (intervals.length) ex.intervals = intervals;
        }
        exceptions.push(ex);
      }

      // Scan unknown WeekDay fields
      for (const k of Object.keys(wd)) {
        if (KNOWN_WEEKDAY_FIELDS.has(k)) continue;
        droppedFields.push({
          path: `${wdPath}.${k}`,
          value: stringifyForDiag(wd[k]),
          reason: 'unsupported-element',
        });
      }
    }
  }

  // Scan unknown Calendar fields
  for (const k of Object.keys(raw)) {
    if (KNOWN_CALENDAR_FIELDS.has(k)) continue;
    droppedFields.push({
      path: `${path}.${k}`,
      value: stringifyForDiag(raw[k]),
      reason: 'unsupported-element',
    });
  }

  const calendar: Calendar = {
    id,
    name,
    workWeek,
    exceptions,
  };

  // BaseCalendarUID — MS Project uses -1 for "no base". Treat -1 or absent
  // as top-level; otherwise carry through.
  const baseUid = raw.BaseCalendarUID !== undefined ? String(raw.BaseCalendarUID) : undefined;
  if (baseUid !== undefined && baseUid !== '-1') {
    calendar.baseCalendarId = baseUid;
  }

  return calendar;
}

function parseWorkingTimes(wd: Record<string, unknown>): WorkInterval[] {
  const wt = wd.WorkingTimes as Record<string, unknown> | undefined;
  if (!wt) return [];
  const arr = wt.WorkingTime as unknown[] | undefined;
  if (!Array.isArray(arr)) return [];
  const intervals: WorkInterval[] = [];
  for (const w of arr) {
    const wRec = w as Record<string, unknown>;
    const fromTime = String(wRec.FromTime ?? '');
    const toTime = String(wRec.ToTime ?? '');
    intervals.push({
      startMinutes: parseMspdiTime(fromTime),
      endMinutes: parseMspdiTime(toTime),
    });
  }
  return intervals;
}

function parseMspdiTime(s: string): number {
  // `HH:MM:SS` → minutes-from-midnight. Seconds truncated.
  const match = s.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

const MSPDI_TYPE_TO_DEPENDENCY: Record<number, DependencyType> = {
  0: 'FF',
  1: 'FS',
  2: 'SF',
  3: 'SS',
};

const MSPDI_CONSTRAINT_TO_INTERNAL = {
  0: 'ASAP',
  1: 'ALAP',
  2: 'MSO',
  3: 'MFO',
  4: 'SNET',
  5: 'SNLT',
  6: 'FNET',
  7: 'FNLT',
} as const;

function mspdiTypeToDependencyType(t: number): DependencyType {
  return MSPDI_TYPE_TO_DEPENDENCY[t] ?? 'FS';
}

function parseConstraint(raw: Record<string, unknown>): Task['constraint'] {
  const value = Number(raw.ConstraintType ?? '0');
  const type = MSPDI_CONSTRAINT_TO_INTERNAL[value as keyof typeof MSPDI_CONSTRAINT_TO_INTERNAL];
  if (!type || type === 'ASAP') return undefined;

  const constraint: NonNullable<Task['constraint']> = { type };
  if (raw.ConstraintDate !== undefined && raw.ConstraintDate !== '') {
    constraint.date = parseMspdiDate(String(raw.ConstraintDate));
  }
  return constraint;
}

function parseMspdiDate(s: string): Date {
  // MSPDI emits ISO 8601 like `2026-01-05T08:00:00` (no timezone in
  // practice; MS Project writes local time). We treat it as local.
  return new Date(s);
}

function parseMspdiDuration(s: string): number {
  // MSPDI duration format: `PT{H}H{M}M{S}S` where each component is
  // optional (e.g. `PT24H0M0S`, `PT0H30M0S`). Returns total minutes
  // (seconds truncated).
  const match = s.match(/^PT(\d+)H(\d+)M(\d+)S$/);
  if (match) {
    return Number(match[1]) * 60 + Number(match[2]);
  }
  // Looser fallback — support `PT{N}M` shorthand.
  const looseMin = s.match(/^PT(\d+)M$/);
  if (looseMin) return Number(looseMin[1]);
  const looseHr = s.match(/^PT(\d+)H$/);
  if (looseHr) return Number(looseHr[1]) * 60;
  return 0;
}

function stringifyForDiag(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v).slice(0, 200);
  } catch {
    return '<unstringifiable>';
  }
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

function parseMspdiResource(
  raw: Record<string, unknown>,
  path: string,
  droppedFields: DroppedField[],
): Resource {
  const id = String(raw.UID ?? raw.ID ?? '');
  const name = String(raw.Name ?? '');

  const resource: Resource = { id, name };

  // CalendarUID — MS Project uses -1 for "no override". Treat -1, absent,
  // or empty as "use project default"; otherwise carry through.
  const calUid = raw.CalendarUID !== undefined ? String(raw.CalendarUID) : undefined;
  if (calUid !== undefined && calUid !== '-1' && calUid !== '') {
    resource.calendarId = calUid;
  }

  // Scan unknown Resource fields
  for (const k of Object.keys(raw)) {
    if (KNOWN_RESOURCE_FIELDS.has(k)) continue;
    droppedFields.push({
      path: `${path}.${k}`,
      value: stringifyForDiag(raw[k]),
      reason: 'unsupported-element',
    });
  }

  return resource;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function parseMspdiAssignment(
  raw: Record<string, unknown>,
  path: string,
  droppedFields: DroppedField[],
): Assignment {
  const id = String(raw.UID ?? '');
  const taskId = String(raw.TaskUID ?? '');
  const resourceId = String(raw.ResourceUID ?? '');

  const assignment: Assignment = { id, taskId, resourceId };

  // Units default 1.0. MSPDI stores as a decimal string. Treat absent/empty
  // or unparseable as 1.0; only emit if it differs from the default.
  if (raw.Units !== undefined) {
    const units = Number(raw.Units);
    if (Number.isFinite(units) && units !== 1) {
      assignment.units = units;
    }
  }

  // Scan unknown Assignment fields. TimephasedData specifically is large +
  // commonly present in real MS Project exports — listing it as
  // allowed-but-ignored is the honest position until we add a per-day
  // allocation model (v0.4+).
  for (const k of Object.keys(raw)) {
    if (KNOWN_ASSIGNMENT_FIELDS.has(k)) continue;
    droppedFields.push({
      path: `${path}.${k}`,
      value: stringifyForDiag(raw[k]),
      reason: 'unsupported-element',
    });
  }

  return assignment;
}

// Re-export from this entry so consumers reach it without learning the
// internal split.
export type { DroppedField, MspdiParseResult, TaskId };
