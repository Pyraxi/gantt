// Internal Project → MSPDI XML. Hand-mapped, supported-subset only.
// Inverse of `parseMspdi` for the fields enumerated in this module's
// KNOWN_TASK_FIELDS + KNOWN_PROJECT_FIELDS sets.

import { XMLBuilder } from 'fast-xml-parser';
import type {
  Assignment,
  Baseline,
  Calendar,
  CalendarException,
  ConstraintType,
  DependencyType,
  Link,
  Project,
  Resource,
  Task,
  WorkInterval,
} from '../types.js';
import type { DroppedField, MspdiSerializeOptions } from './types.js';

interface MspdiPredecessorLinkOut {
  PredecessorUID: string;
  Type: number;
  LinkLag: number;
}

interface MspdiTaskBaselineOut {
  Number: number;
  Start: string;
  Finish: string;
  Duration: string;
}

interface MspdiTaskOut {
  UID: string;
  ID: string;
  Name: string;
  Start: string;
  Finish: string;
  Duration: string;
  ConstraintType: number;
  ConstraintDate?: string;
  Deadline?: string;
  Milestone: number;
  Summary: number;
  OutlineLevel: number;
  PercentComplete: number;
  /** ADR-007: emitted as 1 when Task.unscheduled is true. */
  IsNull?: number;
  PredecessorLink?: MspdiPredecessorLinkOut[];
  Baseline?: MspdiTaskBaselineOut[];
}

interface MspdiWorkingTimeOut {
  FromTime: string;
  ToTime: string;
}

interface MspdiTimePeriodOut {
  FromDate: string;
  ToDate: string;
}

interface MspdiWeekDayOut {
  /** 1=Sunday … 7=Saturday for recurring days; 0 for exceptions. */
  DayType: number;
  DayWorking: number;
  TimePeriod?: MspdiTimePeriodOut;
  WorkingTimes?: { WorkingTime: MspdiWorkingTimeOut[] };
}

interface MspdiCalendarOut {
  UID: string;
  Name: string;
  IsBaseCalendar: number;
  WeekDays: { WeekDay: MspdiWeekDayOut[] };
}

interface MspdiResourceOut {
  UID: string;
  ID: string;
  Name: string;
  Type: number; // 0=Material, 1=Work, 2=Cost. v0.2 first cut emits 1 always.
  CalendarUID: string;
}

interface MspdiAssignmentOut {
  UID: string;
  TaskUID: string;
  ResourceUID: string;
  Units: string;
}

interface MspdiProjectRootOut {
  Name: string;
  Title: string;
  Author?: string;
  StartDate: string;
  Calendars?: { Calendar: MspdiCalendarOut[] };
  Resources?: { Resource: MspdiResourceOut[] };
  Tasks: { Task: MspdiTaskOut[] };
  Assignments?: { Assignment: MspdiAssignmentOut[] };
}

export function serializeMspdi(project: Project, options: MspdiSerializeOptions = {}): string {
  const meta = options.meta ?? {};
  const name = meta.name ?? 'Untitled';
  const title = meta.title ?? name;
  // Output accumulator for fields that can't round-trip cleanly.
  const droppedFields: DroppedField[] = options.droppedFields ?? [];

  // Group links by target so we can nest PredecessorLink elements inside Task.
  const linksByTarget = new Map<string, Link[]>();
  for (const link of project.links) {
    const key = String(link.target);
    const arr = linksByTarget.get(key) ?? [];
    arr.push(link);
    linksByTarget.set(key, arr);
  }

  // Group baselines by taskId. Each task may have one snapshot per baseline
  // (0-10), emitted as <Baseline> children nested inside the task.
  const baselinesByTask = buildBaselinesByTask(project.baselines);
  const outlineLevelByTask = buildOutlineLevels(project.tasks);

  const tasksOut: MspdiTaskOut[] = project.tasks.map((t, idx) => {
    const taskOut: MspdiTaskOut = {
      UID: String(t.id),
      ID: String(idx + 1),
      Name: t.text,
      Start: formatMspdiDate(t.start),
      Finish: formatMspdiDate(t.end),
      Duration: formatMspdiDuration(t.duration),
      ConstraintType: constraintTypeToMspdi(t.constraint?.type),
      Milestone: t.type === 'milestone' ? 1 : 0,
      Summary: t.type === 'summary' ? 1 : 0,
      OutlineLevel: outlineLevelByTask.get(t.id) ?? 1,
      PercentComplete: t.progress,
    };
    if (t.constraint?.date) {
      taskOut.ConstraintDate = formatMspdiDate(t.constraint.date);
    }
    if (t.deadline) {
      taskOut.Deadline = formatMspdiDate(t.deadline);
    }

    // ADR-007: unscheduled tasks — emit IsNull=1 so parseMspdi can recover
    // the flag. MS Project uses IsNull for manually-scheduled tasks with no
    // committed dates (provisional-sum / PC-item scenario).
    if (t.unscheduled) {
      taskOut.IsNull = 1;
    }

    // ADR-007: split tasks (segments[]) — no standard MSPDI encoding exists
    // for a segments list (TimephasedData is the closest but is extremely
    // complex and lossy). Report to droppedFields and preserve outer bounds
    // (Start/Finish) as the fallback representation.
    if (t.segments && t.segments.length > 0) {
      droppedFields.push({
        path: `Project.Tasks.Task[${idx}].segments`,
        value: JSON.stringify(
          t.segments.map((s) => ({
            start: s.start.toISOString(),
            end: s.end.toISOString(),
          })),
        ).slice(0, 200),
        reason: 'lossy-on-roundtrip',
      });
    }

    // Task.extra (consumer carry-through bag) has no MSPDI encoding — the
    // engine treats it as opaque consumer data. Report each key to
    // droppedFields so the loss is transparent rather than silent. One entry
    // per key keeps the diagnostic actionable for the consumer.
    if (t.extra) {
      for (const key of Object.keys(t.extra)) {
        droppedFields.push({
          path: `Project.Tasks.Task[${idx}].extra.${key}`,
          value: JSON.stringify(t.extra[key]).slice(0, 200),
          reason: 'lossy-on-roundtrip',
        });
      }
    }

    const incoming = linksByTarget.get(String(t.id));
    if (incoming?.length) {
      taskOut.PredecessorLink = incoming.map(toMspdiLink);
    }

    const taskBaselines = baselinesByTask.get(String(t.id));
    if (taskBaselines?.length) {
      taskOut.Baseline = taskBaselines;
    }

    return taskOut;
  });

  const calendarsOut = project.calendars.map(toMspdiCalendar);
  const resourcesOut = project.resources.map(toMspdiResource);
  const assignmentsOut = project.assignments.map(toMspdiAssignment);

  const projectRoot: MspdiProjectRootOut = {
    Name: name,
    Title: title,
    ...(meta.author !== undefined ? { Author: meta.author } : {}),
    StartDate: formatMspdiDate(project.start),
    ...(calendarsOut.length > 0 ? { Calendars: { Calendar: calendarsOut } } : {}),
    ...(resourcesOut.length > 0 ? { Resources: { Resource: resourcesOut } } : {}),
    Tasks: { Task: tasksOut },
    ...(assignmentsOut.length > 0 ? { Assignments: { Assignment: assignmentsOut } } : {}),
  };

  const builder = new XMLBuilder({
    ignoreAttributes: true,
    format: true,
    indentBy: '  ',
    suppressEmptyNode: true,
    suppressBooleanAttributes: true,
    processEntities: true,
  });

  const inner = builder.build({ Project: projectRoot }) as string;

  // fast-xml-parser doesn't emit a namespace on the root, so we inject
  // the standard MSPDI namespace declaration. Trim leading whitespace
  // first so the regex anchor is reliable.
  const trimmed = inner.replace(/^\s+/, '');
  const withNamespace = trimmed.replace(
    /^<Project>/,
    '<Project xmlns="http://schemas.microsoft.com/project">',
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${withNamespace}`;
}

function toMspdiLink(link: Link): MspdiPredecessorLinkOut {
  return {
    PredecessorUID: String(link.source),
    Type: dependencyTypeToMspdi(link.type),
    LinkLag: (link.lag ?? 0) * 10, // tenths of a minute on the MSPDI side
  };
}

function dependencyTypeToMspdi(t: DependencyType): number {
  switch (t) {
    case 'FF':
      return 0;
    case 'FS':
      return 1;
    case 'SF':
      return 2;
    case 'SS':
      return 3;
  }
}

function constraintTypeToMspdi(t: ConstraintType | undefined): number {
  switch (t) {
    case undefined:
    case 'ASAP':
      return 0;
    case 'ALAP':
      return 1;
    case 'MSO':
      return 2;
    case 'MFO':
      return 3;
    case 'SNET':
      return 4;
    case 'SNLT':
      return 5;
    case 'FNET':
      return 6;
    case 'FNLT':
      return 7;
  }
}

function buildOutlineLevels(tasks: Task[]): Map<Task['id'], number> {
  const parentById = new Map(tasks.map((t) => [t.id, t.parent]));
  const cache = new Map<Task['id'], number>();

  function depth(taskId: Task['id']): number {
    const cached = cache.get(taskId);
    if (cached !== undefined) return cached;

    const parentId = parentById.get(taskId);
    const value = parentId === undefined ? 1 : depth(parentId) + 1;
    cache.set(taskId, value);
    return value;
  }

  return new Map(tasks.map((t) => [t.id, depth(t.id)]));
}

function formatMspdiDate(d: Date): string {
  // MSPDI emits local time without timezone (e.g. `2026-01-05T08:00:00`).
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

function formatMspdiDuration(totalMinutes: number): string {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `PT${hours}H${minutes}M0S`;
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

function toMspdiCalendar(cal: Calendar): MspdiCalendarOut {
  const weekDays: MspdiWeekDayOut[] = [];

  // 7 recurring entries — MSPDI DayType 1=Sun … 7=Sat; our DayOfWeek 0=Sun … 6=Sat
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const intervals = cal.workWeek[dayOfWeek] ?? [];
    weekDays.push(toRecurringWeekDay(dayOfWeek + 1, intervals));
  }

  // Exception entries — DayType=0 with TimePeriod
  for (const ex of cal.exceptions) {
    weekDays.push(toExceptionWeekDay(ex));
  }

  return {
    UID: String(cal.id),
    Name: cal.name,
    IsBaseCalendar: cal.baseCalendarId === undefined ? 1 : 0,
    WeekDays: { WeekDay: weekDays },
  };
}

function toRecurringWeekDay(mspdiDayType: number, intervals: WorkInterval[]): MspdiWeekDayOut {
  const working = intervals.length > 0;
  const out: MspdiWeekDayOut = {
    DayType: mspdiDayType,
    DayWorking: working ? 1 : 0,
  };
  if (working) {
    out.WorkingTimes = { WorkingTime: intervals.map(toMspdiWorkingTime) };
  }
  return out;
}

function toExceptionWeekDay(ex: CalendarException): MspdiWeekDayOut {
  const dayStart = startOfDay(ex.date);
  const dayEnd = endOfDay(ex.date);
  const out: MspdiWeekDayOut = {
    DayType: 0,
    DayWorking: ex.isWorking ? 1 : 0,
    TimePeriod: {
      FromDate: formatMspdiDate(dayStart),
      ToDate: formatMspdiDate(dayEnd),
    },
  };
  if (ex.isWorking && ex.intervals?.length) {
    out.WorkingTimes = { WorkingTime: ex.intervals.map(toMspdiWorkingTime) };
  }
  return out;
}

function toMspdiWorkingTime(w: WorkInterval): MspdiWorkingTimeOut {
  return {
    FromTime: formatMspdiTime(w.startMinutes),
    ToTime: formatMspdiTime(w.endMinutes),
  };
}

function formatMspdiTime(minutesFromMidnight: number): string {
  const h = Math.floor(minutesFromMidnight / 60);
  const m = minutesFromMidnight % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:00`;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
}

function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0);
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

function toMspdiResource(r: Resource, idx: number): MspdiResourceOut {
  return {
    UID: String(r.id),
    ID: String(idx + 1),
    Name: r.name,
    Type: 1, // Work — the v0.2 default. Material/Cost typing is future work.
    CalendarUID: r.calendarId !== undefined ? String(r.calendarId) : '-1',
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function toMspdiAssignment(a: Assignment): MspdiAssignmentOut {
  return {
    UID: String(a.id),
    TaskUID: String(a.taskId),
    ResourceUID: String(a.resourceId),
    Units: (a.units ?? 1).toString(),
  };
}

// ---------------------------------------------------------------------------
// Baselines
// ---------------------------------------------------------------------------

/**
 * Pivot project-level baselines into per-task entries for MSPDI emission.
 * Each task ends up with a sorted list of <Baseline> children (one per
 * baseline that has a snapshot for that task).
 */
function buildBaselinesByTask(baselines: Baseline[]): Map<string, MspdiTaskBaselineOut[]> {
  const out = new Map<string, MspdiTaskBaselineOut[]>();
  // Sort by baseline index so emission order is stable.
  const sorted = [...baselines].sort((a, b) => a.index - b.index);
  for (const baseline of sorted) {
    for (const [taskId, snap] of baseline.tasks) {
      const key = String(taskId);
      const entry: MspdiTaskBaselineOut = {
        Number: baseline.index,
        Start: formatMspdiDate(snap.start),
        Finish: formatMspdiDate(snap.end),
        Duration: formatMspdiDuration(snap.duration),
      };
      const existing = out.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        out.set(key, [entry]);
      }
    }
  }
  return out;
}
