// Internal Project → MSPDI XML. Hand-mapped, supported-subset only.
// Inverse of `parseMspdi` for the fields enumerated in this module's
// KNOWN_TASK_FIELDS + KNOWN_PROJECT_FIELDS sets.

import { XMLBuilder } from 'fast-xml-parser';
import { createCalendarResolver } from '../calendars/effective.js';
import { actualMinutes, progressState, remainingMinutes } from '../schedule.js';
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
import {
  addWorkingMinutes,
  subtractWorkingMinutes,
  workingIntervals,
  workingMinutesBetween,
  workingMinutesPerDay,
} from '../working-time.js';
import { type IdRemapEntry, TEXT_FIELD_IDS } from './extended-attributes.js';
import { OUTLINE_CODE_FIELD_IDS, stableGuid } from './outline-codes.js';
import { UNASSIGNED_RESOURCE_UID } from './parse.js';
import type { DroppedField, MspdiSerializeOptions } from './types.js';

interface MspdiPredecessorLinkOut {
  PredecessorUID: string;
  Type: number;
  LinkLag: number;
  LagFormat?: number;
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
  DurationFormat?: number;
  /** A manual task's duration format (after DurationFormat). MS Project reads
   *  a manual task's elapsed duration only with it: without it, 2ed opened as
   *  48 working hours, or as 2 working days between dated ends (run 12). */
  FreeformDurationFormat?: number;
  /** An in-progress task's split at the status date: where its actual work
   *  stops and its remaining work resumes. */
  Stop?: string;
  Resume?: string;
  /** 1 with Stop/Resume: without it MS Project closes the gap, resuming the
   *  remaining work straight after Stop (desktop run 6 follow-up). */
  ResumeValid?: number;
  /** 0: our durations aren't estimates. Omitted, MS Project's import marks
   *  every task estimated (`NewTasksEstimated` defaults on). */
  Estimated: number;
  ConstraintType: number;
  ConstraintDate?: string;
  Deadline?: string;
  IgnoreResourceCalendar?: number;
  /** Task.physicalProgress (after IgnoreResourceCalendar, before PredecessorLink). */
  PhysicalPercentComplete?: number;
  Milestone: number;
  Summary: number;
  OutlineLevel: number;
  PercentComplete: number;
  ActualStart?: string;
  ActualFinish?: string;
  /** Duration done. MS Project takes Duration = ActualDuration +
   *  RemainingDuration, so a started task needs both. */
  ActualDuration?: string;
  RemainingDuration?: string;
  /** MSPDI (Project 2010+): 1 when Task.scheduleMode is 'manual'. */
  Manual?: number;
  /** A manual task's text in place of a date (MS Project shows it, e.g.
   *  "TBD"; after OutlineLevel, before Start). Written for an unscheduled task. */
  StartText?: string;
  FinishText?: string;
  /** A manual task's own dates (after Duration, before DurationFormat). */
  ManualStart?: string;
  ManualFinish?: string;
  ManualDuration?: string;
  /** Per-task calendar override (Task.calendarId). */
  CalendarUID?: string;
  PredecessorLink?: MspdiPredecessorLinkOut[];
  /** Local Text custom-field values (per the Task xsd:sequence, after
   *  PredecessorLink, before Baseline). */
  ExtendedAttribute?: { FieldID: number; Value: string }[];
  Baseline?: MspdiTaskBaselineOut[];
  /** Outline-code values (after Baseline in the Task xsd:sequence). Both
   *  ValueID (Project 2003, MPXJ) and ValueGUID (Project 2007+). */
  OutlineCode?: { FieldID: number; ValueID: number; ValueGUID: string }[];
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
  BaseCalendarUID?: string;
  WeekDays: { WeekDay: MspdiWeekDayOut[] };
}

interface MspdiResourceOut {
  UID: string;
  ID: string;
  Name: string;
  Type: number; // 0=Material, 1=Work, 2=Cost. v0.2 first cut emits 1 always.
  CalendarUID: string;
}

// xsd order: UID, TaskUID, ResourceUID, ActualStart, ActualWork, Finish,
// RemainingWork, Start, Units, Work.
interface MspdiAssignmentOut {
  UID: string;
  TaskUID: string;
  ResourceUID: string;
  ActualStart?: string;
  ActualWork?: string;
  Finish?: string;
  RemainingWork: string;
  Start?: string;
  Stop?: string;
  Resume?: string;
  Units: string;
  Work: string;
  TimephasedData?: MspdiTimephasedOut[];
}

/** A task's work split, in working minutes, for its assignments. */
interface TaskWork {
  start: Date;
  end: Date;
  actualStart: Date;
  duration: number;
  actual: number;
  remaining: number;
  /** The status-date split, when there is one. */
  split?: { stop: Date; resume: Date; span: (from: Date, to: Date) => number };
  /** An unscheduled task (ADR-007): its assignments carry no dates either. */
  undated?: boolean;
}

/** An unscheduled task's StartText / FinishText: what MS Project shows in
 *  place of its dates. */
const UNSCHEDULED_TEXT = 'TBD';

// xsd order: Type, UID, Start, Finish, Unit, Value.
interface MspdiTimephasedOut {
  /** 1 = assignment remaining work, 2 = assignment actual work. */
  Type: number;
  UID: string;
  Start: string;
  Finish: string;
  Unit: number;
  Value: string;
}

interface MspdiExtendedAttributeDefOut {
  FieldID: number;
  FieldName: string;
  Alias: string;
  /** An outline code's definition: its OutlineCode Guid. */
  Ltuid?: string;
}

// xsd order: Guid, FieldID, FieldName, Alias, Values, flags, Masks.
interface MspdiOutlineCodeOut {
  Guid: string;
  FieldID: number;
  FieldName: string;
  Alias: string;
  Values: {
    Value: {
      ValueID: number;
      FieldGUID: string;
      Type: number;
      ParentValueID: number;
      Value: string;
      Description?: string;
    }[];
  };
  Enterprise: number;
  ResourceSubstitutionEnabled: number;
  LeafOnly: number;
  AllLevelsRequired: number;
  OnlyTableValuesAllowed: number;
  Masks: { Mask: { Level: number; Type: number; Length: number; Separator: string }[] };
}

// Field order MATTERS: fast-xml-parser emits keys in insertion order, and the
// MSPDI <Project> schema is an xsd:sequence — ExtendedAttributes, Calendars,
// Tasks, Resources, Assignments. Real MS Project rejects out-of-order children.
interface MspdiProjectRootOut {
  Name: string;
  Title: string;
  Author?: string;
  /** Always 1: the engine schedules forward. Omitted, MPXJ reads it as 0. */
  ScheduleFromStart: number;
  StartDate: string;
  /** The project calendar, and the day / week it implies (MS Project shows
   *  durations in days of MinutesPerDay: default 480, not the calendar's). */
  CalendarUID?: string;
  DefaultStartTime?: string;
  DefaultFinishTime?: string;
  MinutesPerDay?: number;
  MinutesPerWeek?: number;
  StatusDate?: string;
  /** Always 0, as MS Project's own saves write it. Omitted, MS Project treats
   *  the file as edited externally and rebuilds in-progress work from the
   *  status date: a split loses its gap and its actual work (run 6 follow-up). */
  ProjectExternallyEdited: number;
  OutlineCodes?: { OutlineCode: MspdiOutlineCodeOut[] };
  ExtendedAttributes?: { ExtendedAttribute: MspdiExtendedAttributeDefOut[] };
  Calendars?: { Calendar: MspdiCalendarOut[] };
  Tasks: { Task: MspdiTaskOut[] };
  Resources?: { Resource: MspdiResourceOut[] };
  Assignments?: { Assignment: MspdiAssignmentOut[] };
}

export function serializeMspdi(project: Project, options: MspdiSerializeOptions = {}): string {
  const meta = options.meta ?? {};
  const name = meta.name ?? 'Untitled';
  const title = meta.title ?? name;
  // Output accumulator for fields that can't round-trip cleanly.
  const droppedFields: DroppedField[] = options.droppedFields ?? [];

  const ids = buildIdResolver(
    project,
    options.remapIdsToIntegers === true,
    droppedFields,
    options.idRemap,
  );

  // Extended-attribute mappings: validate once, then build the project-level
  // definitions. An unknown field / over-long alias / duplicate field is a
  // config error → throw (fail fast, never emit invalid XML).
  const eaMappings = options.extendedAttributes ?? [];
  for (const m of eaMappings) {
    // Own-property check: `in` would accept prototype keys ("toString").
    if (!Object.hasOwn(TEXT_FIELD_IDS, m.field)) {
      throw new Error(`serializeMspdi: unknown extended-attribute field "${m.field}"`);
    }
    // Parse trims and treats an empty <Alias/> as absent, so an empty or padded
    // key would come back under a different name — reject it up front.
    for (const k of [m.extraKey, m.alias]) {
      if (k !== undefined && (k.trim() === '' || k.trim() !== k)) {
        throw new Error(`serializeMspdi: extended-attribute key "${k}" is empty or padded`);
      }
    }
    const alias = m.alias ?? m.extraKey;
    if (alias.length > 50) {
      throw new Error(`serializeMspdi: alias "${alias}" exceeds the MSPDI 50-char limit`);
    }
  }
  if (new Set(eaMappings.map((m) => m.field)).size !== eaMappings.length) {
    throw new Error('serializeMspdi: duplicate extended-attribute field');
  }
  // Parse keys values onto the alias, so a parsed project carries
  // extra[alias]: accept it as a fallback source (second-hop round-trip).
  const eaMappedKeys = new Set(eaMappings.flatMap((m) => [m.extraKey, m.alias ?? m.extraKey]));
  const eaDefs: MspdiExtendedAttributeDefOut[] = eaMappings.map((m) => ({
    FieldID: TEXT_FIELD_IDS[m.field] as number,
    FieldName: m.field,
    Alias: m.alias ?? m.extraKey,
  }));

  const outlineCodes = buildOutlineCodes(
    project,
    options.outlineCodes ?? [],
    droppedFields,
    eaDefs.map((d) => d.Alias),
  );
  eaDefs.push(...outlineCodes.eaDefs);

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
  const taskIdSet = new Set(project.tasks.map((t) => String(t.id)));
  for (const [taskId, entries] of baselinesByTask) {
    if (taskIdSet.has(taskId)) continue;
    droppedFields.push({
      path: 'Project.Baselines',
      value: `${entries.length} baseline snapshot(s) for task "${taskId}", which is not in the project`,
      reason: 'lossy-on-roundtrip',
    });
  }
  const outlineLevelByTask = buildOutlineLevels(project.tasks);
  const resolver = createCalendarResolver(project);

  const workByTask = new Map<string, TaskWork>();
  const tasksOut: MspdiTaskOut[] = project.tasks.map((t, idx) => {
    const taskPath = `Project.Tasks.Task[${idx}]`;
    const taskOut: MspdiTaskOut = {
      UID: ids.own('task', t.id),
      ID: String(idx + 1),
      Name: t.text,
      Start: formatMspdiDate(t.start),
      Finish: formatMspdiDate(t.end),
      Duration: formatMspdiDuration(Math.max(0, t.duration)),
      ConstraintType: constraintTypeToMspdi(t.constraint?.type),
      Estimated: 0,
      Milestone: t.type === 'milestone' ? 1 : 0,
      Summary: t.type === 'summary' ? 1 : 0,
      OutlineLevel: outlineLevelByTask.get(t.id) ?? 1,
      PercentComplete: t.progress,
    };
    // 8 = elapsed days (ed); the Duration is already wall-clock time. Other
    // durations display in days (7), as typed in MS Project.
    taskOut.DurationFormat = t.durationElapsed && t.type !== 'summary' ? 8 : 7;
    if (t.constraint?.date) {
      taskOut.ConstraintDate = formatMspdiDate(t.constraint.date);
    }
    if (t.deadline) {
      taskOut.Deadline = formatMspdiDate(t.deadline);
    }
    if (t.actualStart) taskOut.ActualStart = formatMspdiDate(t.actualStart);
    if (t.actualFinish) taskOut.ActualFinish = formatMspdiDate(t.actualFinish);
    // RemainingDuration on every task, as MS Project writes it: its importer
    // collapses an unlinked task at the project start to 0 days without one
    // (desktop check 2026-10-21). Not started: the whole duration. Complete: 0.
    // In progress: the engine's remaining work (P6 Expected Finish has no MSPDI
    // element, but its effect does, so a re-import keeps the forecast), the
    // host's `remainingDuration`, or the % complete's share: what schedule()
    // uses (`remainingMinutes`). Parse keeps it only where it says more than
    // the % share. A manual task keeps its dates, so its remaining work is the
    // share: a forecast that didn't fit them would contradict its Duration
    // (MS Project then shows 99% and cuts the finish; desktop run 8, p13).
    const state = progressState(t);
    const duration = Math.max(0, t.duration);
    const pct = Number.isFinite(t.progress) ? Math.min(100, Math.max(0, t.progress)) : 0;
    const remaining =
      state === 'complete'
        ? 0
        : state === 'not-started'
          ? Math.max(0, t.duration)
          : t.scheduleMode === 'manual'
            ? Math.round(duration * (1 - pct / 100))
            : remainingMinutes(
                t,
                t.expectedFinish && project.statusDate
                  ? { statusDate: project.statusDate, calendar: resolver.effectiveFor(t).calendar }
                  : {},
              );
    const remainingOut = Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
    taskOut.RemainingDuration = formatMspdiDuration(remainingOut);
    // Without ActualDuration MS Project reads a started task's duration as its
    // remaining work (desktop check run 2); it takes Duration = actual +
    // remaining. Complete: the working time between the actual dates (MS
    // Project's actual duration), else the duration. In progress: the rest of
    // the duration after the % share's remaining work, so the two sum exactly;
    // with a host forecast (remainingDuration / expected finish), the % share.
    // Resolved only when needed: a parsed file can have no calendars at all.
    const cal = () => resolver.effectiveFor(t).calendar;
    const span = (a: Date, b: Date) =>
      t.durationElapsed
        ? Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000))
        : workingMinutesBetween(a, b, cal());
    const rawActual =
      state === 'complete'
        ? t.actualStart && t.actualFinish
          ? span(t.actualStart, t.actualFinish)
          : duration
        : state === 'in-progress'
          ? // As schedule() places the remaining work after it, so Stop = remaining start.
            actualMinutes(t, remainingOut)
          : 0;
    const actual = Number.isFinite(rawActual) ? Math.max(0, rawActual) : 0;
    if (state !== 'not-started') taskOut.ActualDuration = formatMspdiDuration(actual);
    // MS Project holds Duration = ActualDuration + RemainingDuration and
    // % complete = actual / duration, and keeps a file's Duration over the
    // rest: a task finished early at 3 of 5 planned days shows 60% and runs on
    // to the planned finish (desktop run 8). So a started task's duration is
    // what it took (complete) or will take (in progress), as MS Project would
    // show it; the planned duration lives in the baseline.
    // Not summaries (MS Project rolls them up), milestones (a 0-day task with
    // an actual span stays a milestone) or manual tasks (their dates are kept,
    // so Duration must still fit Start → Finish).
    let total = duration;
    if (
      state !== 'not-started' &&
      t.type === 'task' &&
      t.scheduleMode !== 'manual' &&
      actual + remainingOut > 0 &&
      actual + remainingOut !== duration
    ) {
      total = actual + remainingOut;
      taskOut.Duration = formatMspdiDuration(total);
    }
    // MS Project's % complete: actual / duration, as a whole percent
    // (xsd:integer). Never across 0 or 100: rounding an in-progress task to
    // 100 would complete it, and to 0 (with no actual start) would un-start it,
    // in MS Project and on re-import.
    const ratio = total > 0 ? (actual / total) * 100 : pct;
    taskOut.PercentComplete =
      state === 'complete'
        ? 100
        : state === 'not-started'
          ? 0
          : Math.min(99, Math.max(t.actualStart ? 0 : 1, Math.round(ratio)));
    if (t.progress !== undefined && !Number.isFinite(t.progress)) {
      droppedFields.push({
        path: `${taskPath}.progress`,
        value: String(t.progress),
        reason: 'lossy-on-roundtrip',
      });
    }
    let split: TaskWork['split'];
    // Under a status date the engine forecasts an auto leaf's remaining work
    // from it (summaries and manual tasks keep their dates), so the bar can
    // span more time than its duration. Say where the split is, or MS Project
    // stretches the duration to fill Start → Finish.
    if (
      project.statusDate &&
      state === 'in-progress' &&
      t.type !== 'summary' &&
      t.scheduleMode !== 'manual' &&
      actual > 0 &&
      remainingOut > 0
    ) {
      const from = t.actualStart ?? t.start;
      const stop = t.durationElapsed
        ? new Date(from.getTime() + actual * 60_000)
        : addWorkingMinutes(from, actual, cal());
      const resume = t.durationElapsed
        ? new Date(t.end.getTime() - remainingOut * 60_000)
        : subtractWorkingMinutes(t.end, remainingOut, cal());
      if (span(stop, resume) > 0) {
        taskOut.Stop = formatMspdiDate(stop);
        taskOut.Resume = formatMspdiDate(resume);
        taskOut.ResumeValid = 1;
        split = { stop, resume, span };
      }
    }
    workByTask.set(String(t.id), {
      start: t.start,
      end: t.end,
      actualStart: t.actualStart ?? t.start,
      duration: total,
      actual,
      remaining: remainingOut,
      split,
    });
    // P6-only fields (one constraint per task in MS Project; no expected finish).
    for (const [field, value] of [
      ['secondaryConstraint', t.secondaryConstraint],
      ['expectedFinish', t.expectedFinish],
    ] as const) {
      if (value === undefined) continue;
      droppedFields.push({
        path: `${taskPath}.${field}`,
        value: JSON.stringify(value).slice(0, 200),
        reason: 'lossy-on-roundtrip',
      });
    }
    if (t.ignoreResourceCalendar) taskOut.IgnoreResourceCalendar = 1;
    if (t.physicalProgress !== undefined) {
      if (Number.isFinite(t.physicalProgress)) {
        taskOut.PhysicalPercentComplete = Math.round(
          Math.min(100, Math.max(0, t.physicalProgress)),
        );
      } else {
        // NaN would print as "NaN": not an xsd:integer MS Project can read.
        droppedFields.push({
          path: `${taskPath}.physicalProgress`,
          value: String(t.physicalProgress),
          reason: 'lossy-on-roundtrip',
        });
      }
    }

    // Manual-vs-auto is a first-class engine concept (ADR-003): emit <Manual>
    // so the parser recovers it instead of defaulting every task to auto (which
    // silently reschedules pinned tasks on re-import). Auto tasks omit it.
    if (t.scheduleMode === 'manual') {
      taskOut.Manual = 1;
      // The dates the task was given, as MS Project's own saves write them.
      // Under ProjectExternallyEdited 0 MS Project schedules a manual task by
      // these: without them a 5-day task opened as 1 day (desktop run 8).
      taskOut.ManualStart = taskOut.Start;
      taskOut.ManualFinish = taskOut.Finish;
      taskOut.ManualDuration = taskOut.Duration;
    }
    // ADR-007: an unscheduled task is a manual, estimated task with text in
    // place of its dates and no dates written, only its duration. MS Project
    // shows "TBD", places it at the project start for its duration, and keeps
    // the text when it saves (adding placeholder dates); parseMspdi reads
    // either back as unscheduled. IsNull, written before, is a null row to MS
    // Project, which dropped the task (desktop runs 10 and 11).
    if (t.unscheduled) {
      if (t.scheduleMode !== 'manual') {
        droppedFields.push({
          path: `${taskPath}.scheduleMode`,
          value: 'auto (an unscheduled task is written as manual)',
          reason: 'lossy-on-roundtrip',
        });
      }
      if (state !== 'not-started') {
        droppedFields.push({
          path: `${taskPath}.progress`,
          value: 'progress and actuals on an unscheduled task',
          reason: 'lossy-on-roundtrip',
        });
      }
      taskOut.Manual = 1;
      taskOut.Estimated = 1;
      taskOut.PercentComplete = 0;
      taskOut.StartText = UNSCHEDULED_TEXT;
      taskOut.FinishText = UNSCHEDULED_TEXT;
      // Its planned duration, not a started task's actual + remaining: its
      // progress isn't written. MS Project keeps it only with ManualDuration
      // (run 11), a 0-day one too (run 12: without it, 1 day). A 0-day
      // summary keeps the shape run 12 checked: no duration.
      const keepDuration = Number.isFinite(t.duration) && (t.duration > 0 || t.type !== 'summary');
      taskOut.Duration = formatMspdiDuration(Math.max(0, t.duration));
      if (keepDuration) taskOut.ManualDuration = taskOut.Duration;
      // Nothing dated: no timephased work, no placeholder assignment.
      workByTask.set(String(t.id), {
        start: t.start,
        end: t.end,
        actualStart: t.start,
        duration,
        actual: 0,
        remaining: duration,
        undated: true,
      });
      for (const k of [
        'Start',
        'Finish',
        ...(keepDuration ? [] : (['Duration', 'ManualDuration'] as const)),
        'ManualStart',
        'ManualFinish',
        'Stop',
        'Resume',
        'ResumeValid',
        'RemainingDuration',
        'ActualStart',
        'ActualFinish',
        'ActualDuration',
      ] as const) {
        delete taskOut[k];
      }
    }
    if (taskOut.Manual === 1) taskOut.FreeformDurationFormat = taskOut.DurationFormat;
    // Per-task calendar override → <CalendarUID>. Round-trips the id; the
    // owning calendar is serialized under <Calendars> separately.
    if (t.calendarId !== undefined) {
      const calUid = ids.ref('calendar', t.calendarId);
      if (calUid === undefined) {
        droppedFields.push({
          path: `${taskPath}.CalendarUID`,
          value: `calendar "${String(t.calendarId)}" is not in the project`,
          reason: 'lossy-on-roundtrip',
        });
      } else {
        taskOut.CalendarUID = calUid;
      }
    } else if (t.ignoreResourceCalendar) {
      // MS Project honours "ignore resource calendars" only on a task with its
      // own calendar (the box is disabled on Calendar = None). The engine's
      // calendar for such a task is the default: name it, so the flag holds.
      const calUid = ids.ref('calendar', project.defaultCalendarId);
      if (calUid !== undefined) taskOut.CalendarUID = calUid;
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
        if (eaMappedKeys.has(key)) continue; // written as an ExtendedAttribute below
        droppedFields.push({
          path: `Project.Tasks.Task[${idx}].extra.${key}`,
          value: JSON.stringify(t.extra[key]).slice(0, 200),
          reason: 'lossy-on-roundtrip',
        });
      }
    }

    const incoming = linksByTarget.get(String(t.id));
    linksByTarget.delete(String(t.id)); // emitted (or dropped) — leftovers are dangling targets
    const preds: MspdiPredecessorLinkOut[] = [];
    for (const [p, link] of (incoming ?? []).entries()) {
      const srcUid = ids.ref('task', link.source);
      if (srcUid === undefined) {
        droppedFields.push({
          path: `${taskPath}.PredecessorLink[${p}]`,
          value: `predecessor "${String(link.source)}" is not in the project`,
          reason: 'lossy-on-roundtrip',
        });
        continue;
      }
      preds.push(toMspdiLink(link, srcUid));
    }
    if (preds.length) taskOut.PredecessorLink = preds;

    // Per-task local Text custom-field values (after PredecessorLink, before
    // Baseline, per the Task xsd:sequence). Empty values are skipped —
    // suppressEmptyNode would drop an empty <Value> and break the round-trip.
    const eaValues: NonNullable<MspdiTaskOut['ExtendedAttribute']> = [];
    for (const m of eaMappings) {
      const sourceKey =
        t.extra?.[m.extraKey] === undefined && m.alias !== undefined ? m.alias : m.extraKey;
      const raw = t.extra?.[sourceKey];
      if (raw === undefined || raw === null || raw === '') continue;
      if (typeof raw === 'object' || typeof raw === 'function') {
        droppedFields.push({
          path: `${taskPath}.extra.${sourceKey}`,
          value: "non-primitive value can't be written to a Text field",
          reason: 'lossy-on-roundtrip',
        });
        continue;
      }
      eaValues.push({ FieldID: TEXT_FIELD_IDS[m.field] as number, Value: String(raw) });
    }
    if (eaValues.length) taskOut.ExtendedAttribute = eaValues;

    const taskBaselines = baselinesByTask.get(String(t.id));
    if (taskBaselines?.length) {
      taskOut.Baseline = taskBaselines;
    }

    const ocValues: NonNullable<MspdiTaskOut['OutlineCode']> = [];
    for (const oc of outlineCodes.byField) {
      const v = codeText(t.codes?.[oc.codeTypeId]);
      const entry = v ? oc.valueByText.get(v) : undefined;
      if (entry) ocValues.push({ FieldID: oc.fieldId, ValueID: entry.id, ValueGUID: entry.guid });
    }
    if (ocValues.length) taskOut.OutlineCode = ocValues;

    return inTaskSchemaOrder(taskOut);
  });

  // Links whose target task isn't in the project were never emitted above.
  for (const [target, links] of linksByTarget) {
    for (const link of links) {
      droppedFields.push({
        path: 'Project.Tasks.PredecessorLink',
        value: `link "${String(link.id)}" targets "${target}", which is not in the project`,
        reason: 'lossy-on-roundtrip',
      });
    }
  }

  // MS Project treats a derived calendar as a resource calendar and names it
  // after its resource ("Unassigned" otherwise, desktop check run 3).
  const resourceNamesByCalendar = new Map<string, string[]>();
  for (const r of project.resources) {
    if (r.calendarId === undefined) continue;
    const names = resourceNamesByCalendar.get(String(r.calendarId)) ?? [];
    names.push(r.name);
    resourceNamesByCalendar.set(String(r.calendarId), names);
  }
  const calendarsOut = project.calendars.map((cal, idx) => {
    let baseUid: string | undefined;
    if (cal.baseCalendarId !== undefined) {
      baseUid = ids.ref('calendar', cal.baseCalendarId);
      if (baseUid === undefined) {
        // Re-base onto the project default (what MS Project resource calendars
        // almost always derive from) so inherited days stay working.
        baseUid =
          String(cal.id) !== String(project.defaultCalendarId)
            ? ids.ref('calendar', project.defaultCalendarId)
            : undefined;
        droppedFields.push({
          path: `Project.Calendars.Calendar[${idx}].BaseCalendarUID`,
          value: `base calendar "${String(cal.baseCalendarId)}" is not in the project; ${baseUid !== undefined ? 'written as derived from the default calendar' : 'written as a base calendar'}`,
          reason: 'lossy-on-roundtrip',
        });
      }
    }
    const owners = resourceNamesByCalendar.get(String(cal.id));
    const owner = baseUid !== undefined && owners?.length === 1 ? owners[0]?.trim() : undefined;
    return toMspdiCalendar(
      owner ? { ...cal, name: owner } : cal,
      ids.own('calendar', cal.id),
      baseUid,
    );
  });
  const resourcesOut = project.resources.map((r, idx) => {
    let calUid = '-1';
    if (r.calendarId !== undefined) {
      const resolved = ids.ref('calendar', r.calendarId);
      if (resolved === undefined) {
        droppedFields.push({
          path: `Project.Resources.Resource[${idx}].CalendarUID`,
          value: `calendar "${String(r.calendarId)}" is not in the project`,
          reason: 'lossy-on-roundtrip',
        });
      } else {
        calUid = resolved;
      }
    }
    return toMspdiResource(r, idx, ids.own('resource', r.id), calUid);
  });
  const assignmentsOut: MspdiAssignmentOut[] = [];
  const assignedTasks = new Set<string>();
  for (const [idx, a] of project.assignments.entries()) {
    const taskUid = ids.ref('task', a.taskId);
    const resourceUid = ids.ref('resource', a.resourceId);
    if (taskUid === undefined || resourceUid === undefined) {
      droppedFields.push({
        path: `Project.Assignments.Assignment[${idx}]`,
        value: `assignment "${String(a.id)}" references a task/resource not in the project`,
        reason: 'lossy-on-roundtrip',
      });
      continue;
    }
    if (a.units !== undefined && !Number.isFinite(a.units)) {
      droppedFields.push({
        path: `Project.Assignments.Assignment[${idx}]`,
        value: `assignment "${String(a.id)}" has units ${String(a.units)}`,
        reason: 'lossy-on-roundtrip',
      });
      continue;
    }
    assignmentsOut.push(
      toMspdiAssignment(
        a,
        ids.own('assignment', a.id),
        taskUid,
        resourceUid,
        workByTask.get(String(a.taskId)) as TaskWork,
      ),
    );
    assignedTasks.add(String(a.taskId));
  }
  // MS Project keeps a split only as timephased work on an assignment: Resume
  // alone is ignored (desktop check run 3). A split task with no resource gets
  // MS Project's own placeholder assignment (ResourceUID -65535), which parse
  // skips.
  let nextUid =
    assignmentsOut.reduce((max, a) => {
      const n = Number(a.UID);
      return Number.isInteger(n) && n > max ? n : max;
    }, 0) + 1;
  for (const t of project.tasks) {
    const work = workByTask.get(String(t.id));
    const taskUid = ids.ref('task', t.id);
    if (!work?.split || taskUid === undefined || assignedTasks.has(String(t.id))) continue;
    assignmentsOut.push(
      toMspdiAssignment(
        { id: '', taskId: t.id, resourceId: '' },
        String(nextUid++),
        taskUid,
        UNASSIGNED_RESOURCE_UID,
        work,
      ),
    );
  }

  const projectRoot: MspdiProjectRootOut = {
    Name: name,
    Title: title,
    ...(meta.author !== undefined ? { Author: meta.author } : {}),
    ScheduleFromStart: 1,
    StartDate: formatMspdiDate(project.start),
    ...projectCalendarFields(project, ids.ref('calendar', project.defaultCalendarId)),
    ...(project.statusDate ? { StatusDate: formatMspdiDate(project.statusDate) } : {}),
    ProjectExternallyEdited: 0,
    ...(outlineCodes.defs.length > 0 ? { OutlineCodes: { OutlineCode: outlineCodes.defs } } : {}),
    ...(eaDefs.length > 0 ? { ExtendedAttributes: { ExtendedAttribute: eaDefs } } : {}),
    ...(calendarsOut.length > 0 ? { Calendars: { Calendar: calendarsOut } } : {}),
    Tasks: { Task: tasksOut },
    ...(resourcesOut.length > 0 ? { Resources: { Resource: resourcesOut } } : {}),
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

function toMspdiLink(link: Link, predecessorUid: string): MspdiPredecessorLinkOut {
  // Percent lag: LinkLag is the percentage, LagFormat 19 (20 elapsed).
  if (link.lagPercent !== undefined) {
    return {
      PredecessorUID: predecessorUid,
      Type: dependencyTypeToMspdi(link.type),
      LinkLag: Math.round(link.lagPercent),
      LagFormat: link.lagElapsed ? 20 : 19,
    };
  }
  return {
    PredecessorUID: predecessorUid,
    Type: dependencyTypeToMspdi(link.type),
    LinkLag: (link.lag ?? 0) * 10, // tenths of a minute on the MSPDI side
    // Elapsed lag shows as elapsed days (8 = ed); working lag keeps MS Project's default.
    ...(link.lagElapsed ? { LagFormat: 8 } : {}),
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

/**
 * `baseUid` is the resolved BaseCalendarUID, or undefined for a base calendar
 * (or a derived one whose base is missing — then written as a base, with all
 * seven weekdays, since nothing would supply the inherited ones).
 */
function toMspdiCalendar(cal: Calendar, uid: string, baseUid?: string): MspdiCalendarOut {
  const weekDays: MspdiWeekDayOut[] = [];
  const inherited = new Set<number>(baseUid !== undefined ? (cal.inheritedDays ?? []) : []);

  // Recurring entries — MSPDI DayType 1=Sun … 7=Sat; our DayOfWeek 0=Sun … 6=Sat.
  // A derived calendar omits the days it inherits (MS Project's own shape).
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    if (inherited.has(dayOfWeek)) continue;
    const intervals = cal.workWeek[dayOfWeek] ?? [];
    weekDays.push(toRecurringWeekDay(dayOfWeek + 1, intervals));
  }

  // Exception entries — DayType=0 with TimePeriod
  for (const ex of cal.exceptions) {
    weekDays.push(toExceptionWeekDay(ex));
  }

  return {
    UID: uid,
    Name: cal.name,
    IsBaseCalendar: baseUid === undefined ? 1 : 0,
    ...(baseUid !== undefined ? { BaseCalendarUID: baseUid } : {}),
    WeekDays: { WeekDay: weekDays },
  };
}

function toRecurringWeekDay(mspdiDayType: number, all: WorkInterval[]): MspdiWeekDayOut {
  // Inverted / zero-length intervals hold no working time in the engine, so
  // they aren't written; a day of only those is non-working.
  const intervals = workingIntervals(all);
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
  // As for week days: only intervals that hold working time are written, and
  // a working exception whose intervals are all inverted is non-working.
  const intervals = workingIntervals(ex.intervals ?? []);
  const working = ex.isWorking && (intervals.length > 0 || !ex.intervals?.length);
  const out: MspdiWeekDayOut = {
    DayType: 0,
    DayWorking: working ? 1 : 0,
    TimePeriod: {
      FromDate: formatMspdiDate(dayStart),
      ToDate: formatMspdiDate(dayEnd),
    },
  };
  if (working && intervals.length) {
    out.WorkingTimes = { WorkingTime: intervals.map(toMspdiWorkingTime) };
  }
  return out;
}

function toMspdiWorkingTime(w: WorkInterval): MspdiWorkingTimeOut {
  return {
    FromTime: formatMspdiTime(w.startMinutes),
    // End of day is written as midnight, as MS Project does ("24 Hours" is
    // 00:00:00 → 00:00:00); the parser reads it back as 1440.
    ToTime: formatMspdiTime(w.endMinutes === 1440 ? 0 : w.endMinutes),
  };
}

/**
 * The root's calendar block: the project calendar's UID, its day start, and
 * its working minutes per day / week, so MS Project shows durations in this
 * calendar's days (it otherwise assumes 8 h). Omitted without a resolvable
 * default calendar.
 */
function projectCalendarFields(
  project: Project,
  calendarUid: string | undefined,
): Pick<
  MspdiProjectRootOut,
  'CalendarUID' | 'DefaultStartTime' | 'DefaultFinishTime' | 'MinutesPerDay' | 'MinutesPerWeek'
> {
  if (calendarUid === undefined) return {};
  // Resolved: a derived default calendar takes its inherited days from its base.
  let cal: Calendar;
  try {
    cal = createCalendarResolver(project).defaultCalendar();
  } catch {
    return {};
  }
  const week = cal.workWeek.map((day) => workingIntervals(day ?? []));
  const firstDay = week.find((day) => day.length > 0);
  const first = firstDay?.[0];
  const last = firstDay?.[firstDay.length - 1];
  const perWeek = week.reduce(
    (sum, day) => sum + day.reduce((m, iv) => m + (iv.endMinutes - iv.startMinutes), 0),
    0,
  );
  return {
    CalendarUID: calendarUid,
    ...(first ? { DefaultStartTime: formatMspdiTime(first.startMinutes) } : {}),
    // A day ending at midnight has no finish time MS Project would type.
    ...(last && last.endMinutes < 1440
      ? { DefaultFinishTime: formatMspdiTime(last.endMinutes) }
      : {}),
    MinutesPerDay: workingMinutesPerDay(cal),
    ...(perWeek > 0 ? { MinutesPerWeek: perWeek } : {}),
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

function toMspdiResource(
  r: Resource,
  idx: number,
  uid: string,
  calendarUid: string,
): MspdiResourceOut {
  return {
    UID: uid,
    ID: String(idx + 1),
    Name: r.name,
    Type: 1, // Work — the v0.2 default. Material/Cost typing is future work.
    CalendarUID: calendarUid,
  };
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

function toMspdiAssignment(
  a: Assignment,
  uid: string,
  taskUid: string,
  resourceUid: string,
  work: TaskWork,
): MspdiAssignmentOut {
  // Work in hours: MS Project's importer reads an assignment with Units alone
  // as 0 hours and turns its task into a 0-day milestone (desktop check run 2).
  const units = a.units ?? 1;
  const scaled = (minutes: number) => {
    const m = Math.round(minutes * units);
    return Number.isFinite(m) ? Math.max(0, m) : 0;
  };
  const hours = (minutes: number) => formatMspdiDuration(scaled(minutes));
  return {
    UID: uid,
    TaskUID: taskUid,
    ResourceUID: resourceUid,
    // Work = ActualWork + RemainingWork, as for the task's durations.
    ...(work.actual > 0
      ? { ActualStart: formatMspdiDate(work.actualStart), ActualWork: hours(work.actual) }
      : {}),
    ...(work.undated ? {} : { Finish: formatMspdiDate(work.end) }),
    RemainingWork: hours(work.remaining),
    ...(work.undated ? {} : { Start: formatMspdiDate(work.start) }),
    ...(work.split
      ? { Stop: formatMspdiDate(work.split.stop), Resume: formatMspdiDate(work.split.resume) }
      : {}),
    Units: units.toString(),
    Work: hours(work.duration),
    // The split as MS Project saves it: actual work up to Stop, remaining work
    // from Resume, and no entry for the gap. A 0 h entry on the gap makes it
    // move the work to the status date or fill the gap (desktop runs 4-5).
    ...(work.split
      ? {
          TimephasedData: [
            ...dailyWork(2, work.actualStart, work.split.stop, work.split.span, uid, scaled),
            ...dailyWork(1, work.split.resume, work.end, work.split.span, uid, scaled),
          ],
        }
      : {}),
  };
}

/**
 * Timephased work from `from` to `to`, one entry per day as MS Project writes
 * it: steps of a day from `from`, a run of idle days in one 0 h entry. Values
 * round cumulatively, so they sum to the segment's scaled total.
 */
function dailyWork(
  type: number,
  from: Date,
  to: Date,
  span: (a: Date, b: Date) => number,
  uid: string,
  scaled: (minutes: number) => number,
): MspdiTimephasedOut[] {
  const out: { start: Date; finish: Date; minutes: number }[] = [];
  let done = 0;
  for (let day = from; day < to; ) {
    const next = new Date(day);
    next.setDate(next.getDate() + 1);
    const finish = next < to ? next : to;
    const worked = span(day, finish);
    const minutes = scaled(done + worked) - scaled(done);
    done += worked;
    const last = out[out.length - 1];
    if (minutes === 0 && last?.minutes === 0) last.finish = finish;
    else out.push({ start: day, finish, minutes });
    day = finish;
  }
  return out.map((e) => ({
    Type: type,
    UID: uid,
    Start: formatMspdiDate(e.start),
    Finish: formatMspdiDate(e.finish),
    Unit: 1,
    Value: formatMspdiDuration(e.minutes),
  }));
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

// ---------------------------------------------------------------------------
// UIDs (F-8)
// ---------------------------------------------------------------------------

type UidNamespace = IdRemapEntry['namespace'];

/**
 * Emitted-UID resolver. `own` gives an entity's own UID; `ref` resolves a
 * cross-reference and returns `undefined` when the referenced id isn't in the
 * project (callers drop + report — never pass a dangling id through, it could
 * collide with a real UID). With `remap`, UIDs are sequential integers from 1
 * per namespace in array order (UID 0 stays reserved for the project-summary
 * row); without it, ids are emitted as-is. Baseline join keys are internal and
 * untouched — only emission changes.
 */
function buildIdResolver(
  project: Project,
  remap: boolean,
  droppedFields: DroppedField[],
  collector?: IdRemapEntry[],
) {
  const maps: Record<UidNamespace, Map<string, number>> = {
    task: new Map(),
    resource: new Map(),
    calendar: new Map(),
    assignment: new Map(),
  };
  const add = (ns: UidNamespace, id: unknown) => {
    const key = String(id);
    if (maps[ns].has(key)) {
      droppedFields.push({
        path: `Project.${ns}`,
        value: `duplicate ${ns} id "${key}" — every copy is emitted with the same UID`,
        reason: 'lossy-on-roundtrip',
      });
      return;
    }
    const uid = maps[ns].size + 1;
    maps[ns].set(key, uid);
    if (remap) collector?.push({ namespace: ns, originalId: key, uid });
  };
  for (const t of project.tasks) add('task', t.id);
  for (const r of project.resources) add('resource', r.id);
  for (const c of project.calendars) add('calendar', c.id);
  for (const a of project.assignments) add('assignment', a.id);
  return {
    own: (ns: UidNamespace, id: unknown): string =>
      remap ? String(maps[ns].get(String(id))) : String(id),
    ref: (ns: UidNamespace, id: unknown): string | undefined => {
      const uid = maps[ns].get(String(id));
      if (uid === undefined) return undefined;
      return remap ? String(uid) : String(id);
    },
  };
}

/** MSPDI Task children, in the schema's xsd:sequence order (verified against
 *  MPXJ's JAXB propOrder for Project.Tasks.Task). MS Project's importer is
 *  order-sensitive, so the task literal is rebuilt in this order on emit. */
const TASK_ELEMENT_ORDER = [
  'UID',
  'ID',
  'Name',
  'Manual',
  'OutlineLevel',
  'StartText',
  'FinishText',
  'Start',
  'Finish',
  'Duration',
  'ManualStart',
  'ManualFinish',
  'ManualDuration',
  'DurationFormat',
  'FreeformDurationFormat',
  'Stop',
  'Resume',
  'ResumeValid',
  'Estimated',
  'Milestone',
  'Summary',
  'PercentComplete',
  'ActualStart',
  'ActualFinish',
  'ActualDuration',
  'RemainingDuration',
  'ConstraintType',
  'CalendarUID',
  'ConstraintDate',
  'Deadline',
  'IgnoreResourceCalendar',
  'PhysicalPercentComplete',
  'PredecessorLink',
  'ExtendedAttribute',
  'Baseline',
  'OutlineCode',
] as const satisfies readonly (keyof MspdiTaskOut)[];

interface OutlineCodeOut {
  codeTypeId: string;
  fieldId: number;
  valueByText: Map<string, { id: number; guid: string }>;
}

/**
 * The outline-code tables, their paired definitions and a per-code-type value
 * index for the task loop. Config errors (unknown field / code type, duplicate
 * field) throw, like `extendedAttributes`. A task value missing from the code
 * type's values is appended to the table: MS Project needs a table entry.
 */
/** A code value as table text: trimmed; null / undefined / whitespace → ''. */
function codeText(raw: unknown): string {
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

function buildOutlineCodes(
  project: Project,
  rawMappings: readonly { codeTypeId: string; field: keyof typeof OUTLINE_CODE_FIELD_IDS }[],
  droppedFields: DroppedField[],
  /** Aliases already taken by `extendedAttributes` definitions. */
  takenAliases: readonly string[],
): {
  defs: MspdiOutlineCodeOut[];
  eaDefs: MspdiExtendedAttributeDefOut[];
  byField: OutlineCodeOut[];
} {
  const codeTypes = project.codeTypes ?? [];
  // Number(): '1' and 1 are the same field (Object.hasOwn would coerce).
  const mappings = rawMappings.map((m) => ({ codeTypeId: m.codeTypeId, field: Number(m.field) }));
  const fields = new Set<number>();
  const mappedIds = new Set<string>();
  // MS Project needs custom-field aliases unique, and parse keys by alias.
  // Case-insensitive, as MS Project's "name already in use" check.
  const aliases = new Set(takenAliases.map((a) => a.toLowerCase()));
  for (const m of mappings) {
    if (!Object.hasOwn(OUTLINE_CODE_FIELD_IDS, m.field)) {
      throw new Error(`serializeMspdi: unknown outline-code field ${String(m.field)} (1–10)`);
    }
    if (fields.has(m.field)) {
      throw new Error(`serializeMspdi: duplicate outline-code field ${m.field}`);
    }
    if (mappedIds.has(m.codeTypeId)) {
      throw new Error(`serializeMspdi: code type "${m.codeTypeId}" mapped twice`);
    }
    const ct = codeTypes.find((c) => c.id === m.codeTypeId);
    if (!ct) throw new Error(`serializeMspdi: no code type "${m.codeTypeId}" in project.codeTypes`);
    if (!Array.isArray(ct.values)) {
      throw new Error(`serializeMspdi: code type "${ct.id}" has no values array`);
    }
    // Parse keys the code type by this alias; it must survive the trip.
    if (ct.name.trim() === '' || ct.name.trim() !== ct.name || ct.name.length > 50) {
      throw new Error(
        `serializeMspdi: code type name "${ct.name}" is empty, padded or over 50 chars`,
      );
    }
    if (aliases.has(ct.name.toLowerCase())) {
      throw new Error(`serializeMspdi: alias "${ct.name}" used by more than one custom field`);
    }
    aliases.add(ct.name.toLowerCase());
    fields.add(m.field);
    mappedIds.add(m.codeTypeId);
  }
  for (const ct of codeTypes) {
    if (mappedIds.has(ct.id)) continue;
    droppedFields.push({
      path: `Project.codeTypes.${ct.id}`,
      value:
        'code type not mapped to an outline code (options.outlineCodes): its values are not written',
      reason: 'lossy-on-roundtrip',
    });
  }
  // Task codes with no code type at all: reported once per key.
  const known = new Set(codeTypes.map((c) => c.id));
  const orphanKeys = new Set(
    project.tasks.flatMap((t) => Object.keys(t.codes ?? {})).filter((k) => !known.has(k)),
  );
  for (const key of orphanKeys) {
    droppedFields.push({
      path: `Project.Tasks.codes.${key}`,
      value: 'task codes with no matching code type in project.codeTypes are not written',
      reason: 'lossy-on-roundtrip',
    });
  }
  const defs: MspdiOutlineCodeOut[] = [];
  const eaDefs: MspdiExtendedAttributeDefOut[] = [];
  const byField: OutlineCodeOut[] = [];
  let nextValueId = 1; // unique across the project (schema: ValueID)
  for (const m of mappings) {
    const ct = codeTypes.find((c) => c.id === m.codeTypeId) as NonNullable<
      Project['codeTypes']
    >[number];
    const fieldId = OUTLINE_CODE_FIELD_IDS[m.field as keyof typeof OUTLINE_CODE_FIELD_IDS];
    const guid = stableGuid(`outline-code:${m.field}:${ct.id}`);
    const valueByText = new Map<string, { id: number; guid: string }>();
    const values: MspdiOutlineCodeOut['Values']['Value'] = [];
    // Parse trims, so a padded value would come back different: trim here;
    // whitespace-only is absent.
    const add = (raw: unknown, description?: string) => {
      const text = codeText(raw);
      if (text === '' || valueByText.has(text)) return;
      const entry = {
        id: nextValueId++,
        guid: stableGuid(`outline-code-value:${m.field}:${ct.id}:${text}`),
      };
      valueByText.set(text, entry);
      values.push({
        ValueID: entry.id,
        FieldGUID: entry.guid,
        Type: 21, // Text
        ParentValueID: 0,
        Value: text,
        ...(description !== undefined && description !== '' ? { Description: description } : {}),
      });
    };
    for (const v of ct.values) add(v.value, v.description);
    for (const t of project.tasks) {
      const v = t.codes?.[ct.id];
      if (v !== undefined) add(v);
    }
    if (ct.values.some((v) => v.color !== undefined)) {
      droppedFields.push({
        path: `Project.codeTypes.${ct.id}.values`,
        value: 'value colours have no MSPDI field; not written',
        reason: 'lossy-on-roundtrip',
      });
    }
    defs.push({
      Guid: guid,
      FieldID: fieldId,
      FieldName: `Outline Code${m.field}`,
      Alias: ct.name,
      Values: { Value: values },
      Enterprise: 0,
      ResourceSubstitutionEnabled: 0,
      LeafOnly: 0,
      AllLevelsRequired: 0,
      OnlyTableValuesAllowed: 0,
      // One level of any characters, as MS Project's default text code.
      Masks: { Mask: [{ Level: 1, Type: 3, Length: 0, Separator: '.' }] },
    });
    eaDefs.push({
      FieldID: fieldId,
      FieldName: `Outline Code${m.field}`,
      Alias: ct.name,
      Ltuid: guid,
    });
    byField.push({ codeTypeId: ct.id, fieldId, valueByText });
  }
  return { defs, eaDefs, byField };
}

function inTaskSchemaOrder(t: MspdiTaskOut): MspdiTaskOut {
  const out: Record<string, unknown> = {};
  for (const k of TASK_ELEMENT_ORDER) if (t[k] !== undefined) out[k] = t[k];
  return out as unknown as MspdiTaskOut;
}
