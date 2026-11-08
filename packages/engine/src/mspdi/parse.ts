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
  CodeType,
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
import { TASK_FIELD_ID_MAX, TASK_FIELD_ID_MIN } from './extended-attributes.js';
import { OUTLINE_CODE_FIELD_BY_ID } from './outline-codes.js';
import type { DroppedField, MspdiParseResult } from './types.js';

/** MS Project's "no resource" sentinel on unassigned-task placeholder assignments. */
export const UNASSIGNED_RESOURCE_UID = '-65535';

// Field names we know about and either map or intentionally ignore on parse.
// Everything outside this set lands in `droppedFields`.
//
// The list is intentionally broad: real MS Project exports emit ~50 fields
// per Task, most of which are MS-Project-computed state (CPM results, EV,
// rates, costs, leveling). We don't preserve these on round-trip — our
// engine recomputes the equivalent fields. Listing them here keeps
// `droppedFields` focused on genuinely-unknown elements rather than
// recompute-able noise.
/** MSPDI `DurationFormat` / `LagFormat` codes for elapsed units (incl. estimated). */
const ELAPSED_FORMATS = new Set([4, 6, 8, 10, 12, 36, 38, 40, 42, 44]);

/** A manual task's text in place of a date (MS Project: "TBD"). */
const TEXT_DATE_FIELDS = new Set(['StartText', 'FinishText', 'DurationText']);
const hasText = (v: unknown): boolean => typeof v === 'string' && v.trim() !== '';

const KNOWN_TASK_FIELDS = new Set([
  // Mapped — read into the internal Task shape
  'ActualStart',
  'ActualFinish',
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
  'ExtendedAttribute',
  'OutlineCode', // → Task.codes (outline codes)
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
  'FreeformDurationFormat', // a manual task's; DurationFormat says the same
  'Work',
  'Stop',
  'Resume',
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
  // Manual schedule mode + per-task calendar override — mapped (F-3)
  'Manual',
  // A manual task's own dates: the same as Start / Finish / Duration in MS
  // Project's saves and ours.
  'ManualStart',
  'ManualFinish',
  'ManualDuration',
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
      jpath.endsWith('.ExtendedAttribute') ||
      jpath === 'Project.Calendars.Calendar' ||
      jpath === 'Project.Resources.Resource' ||
      jpath === 'Project.Assignments.Assignment' ||
      jpath.endsWith('.WeekDays.WeekDay') ||
      jpath.endsWith('.WorkingTimes.WorkingTime') ||
      jpath === 'Project.Tasks.Task.Baseline' ||
      jpath === 'Project.Tasks.Task.OutlineCode' ||
      jpath === 'Project.OutlineCodes.OutlineCode' ||
      jpath === 'Project.OutlineCodes.OutlineCode.Values.Value' ||
      jpath === 'Project.OutlineCodes.OutlineCode.Masks.Mask',
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

  // Project-level ExtendedAttributes definitions: FieldID → key (Alias, else
  // FieldName, else the FieldID). First-seen wins on a duplicate key. Task
  // values below map onto Task.extra[key]. Self-describing → no parse config.
  const eaDefKeyByFieldId = new Map<number, string>();
  const eaSeenKeys = new Set<string>();
  // Outline codes' paired definitions: FieldID → alias, Ltuid → FieldID.
  const ocAliasByFieldId = new Map<number, string>();
  const ocFieldIdByLtuid = new Map<string, number>();
  const rawEaDefs = (root.ExtendedAttributes as Record<string, unknown> | undefined)
    ?.ExtendedAttribute;
  const eaDefList = Array.isArray(rawEaDefs) ? rawEaDefs : rawEaDefs ? [rawEaDefs] : [];
  for (const [i, d] of eaDefList.entries()) {
    const def = d as Record<string, unknown>;
    const fid = Number(def.FieldID);
    if (!Number.isFinite(fid)) continue;
    // Only task-class fields carry Task.extra values. Resource/assignment
    // definitions (other FieldID ranges) must not claim a key — resource Text1
    // listed first would otherwise shadow task Text1.
    if (fid < TASK_FIELD_ID_MIN || fid > TASK_FIELD_ID_MAX) continue;
    // An empty <Alias/> is "no alias" — never key values onto extra[''].
    const alias = def.Alias !== undefined ? String(def.Alias) : '';
    // An outline code's paired definition names a code type, not a Text field.
    if (OUTLINE_CODE_FIELD_BY_ID.has(fid)) {
      if (alias !== '' && !ocAliasByFieldId.has(fid)) ocAliasByFieldId.set(fid, alias);
      if (def.Ltuid !== undefined) ocFieldIdByLtuid.set(String(def.Ltuid).toUpperCase(), fid);
      continue;
    }
    const key =
      alias !== '' ? alias : def.FieldName !== undefined ? String(def.FieldName) : String(fid);
    if (eaDefKeyByFieldId.has(fid) || eaSeenKeys.has(key)) {
      droppedFields.push({
        path: `Project.ExtendedAttributes.ExtendedAttribute[${i}]`,
        value: `definition FieldID ${fid} ignored: key "${key}" already defined (first wins)`,
        reason: 'unsupported-element',
      });
      continue;
    }
    eaDefKeyByFieldId.set(fid, key);
    eaSeenKeys.add(key);
  }

  const { codeTypes, outlineCodeByFieldId } = parseOutlineCodes(
    root.OutlineCodes as Record<string, unknown> | undefined,
    ocAliasByFieldId,
    ocFieldIdByLtuid,
    droppedFields,
  );

  const rawTasks: unknown[] = root.Tasks?.Task ?? [];
  if (!Array.isArray(rawTasks)) {
    throw new Error('parseMspdi: <Tasks> contained a non-array Task collection (malformed)');
  }

  // UIDs of rows skipped as MS Project's project-summary row (F-13), so links
  // from them are dropped + reported rather than left dangling.
  const skippedSummaryUids = new Set<string>();

  for (let i = 0; i < rawTasks.length; i++) {
    const raw = rawTasks[i] as Record<string, unknown>;
    const taskPath = `Project.Tasks.Task[${i}]`;

    // Map the supported fields.
    const uid = String(raw.UID ?? raw.ID ?? '');
    if (!uid) throw new Error(`parseMspdi: ${taskPath} missing UID and ID`);

    // MS Project emits the whole-project summary as UID 0 at OutlineLevel 0.
    // It is not a schedulable task (and a host merging by id must never see it).
    if (uid === '0' && String(raw.OutlineLevel ?? '') === '0') {
      skippedSummaryUids.add(uid);
      droppedFields.push({
        path: taskPath,
        value: 'project-summary row (UID 0) skipped',
        reason: 'unsupported-element',
      });
      continue;
    }
    // A blank row in MS Project: IsNull with no name and no outline level. It
    // isn't a task, and reading it as level 1 would orphan every task after it.
    if (
      String(raw.IsNull ?? '0') === '1' &&
      String(raw.Name ?? '') === '' &&
      raw.OutlineLevel === undefined
    ) {
      skippedSummaryUids.add(uid);
      droppedFields.push({
        path: taskPath,
        value: 'blank row skipped',
        reason: 'unsupported-element',
      });
      continue;
    }

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
    // Guard a bad OutlineLevel: `outlineStack.length = <value>` throws
    // RangeError deep in the loop for BOTH `NaN` (Math.max(1, NaN) = NaN) and
    // any finite value ≥ 2^32 (JS caps array length at 2^32-1). Real outline
    // levels are small; accept ≤ 255, else degrade to top-level and report
    // rather than hard-crash the whole import.
    const outlineRaw = Number(raw.OutlineLevel ?? '1');
    let outlineLevel: number;
    if (Number.isFinite(outlineRaw) && outlineRaw <= 255) {
      outlineLevel = Math.max(1, Math.trunc(outlineRaw));
    } else {
      outlineLevel = 1;
      droppedFields.push({
        path: `${taskPath}.OutlineLevel`,
        value: String(raw.OutlineLevel ?? ''),
        reason: 'unsupported-element',
      });
    }
    const parentId = outlineLevel > 1 ? outlineStack[outlineLevel - 2] : undefined;
    const constraint = parseConstraint(raw, droppedFields, taskPath);

    const parsedTask: Task = {
      id: uid,
      text: name,
      type: taskType,
      // MSPDI <Manual>1</Manual> (Project 2010+) → manual schedule mode; absent
      // → auto. Preserves the user's pin instead of rescheduling on re-import.
      scheduleMode: String(raw.Manual ?? '0') === '1' ? 'manual' : 'auto',
      duration,
      start,
      end,
      progress: Number(raw.PercentComplete ?? '0'),
    };
    if (parentId !== undefined) parsedTask.parent = parentId;
    // Per-task calendar override. MS Project uses -1 for "no override".
    if (raw.CalendarUID !== undefined) {
      const calUid = String(raw.CalendarUID);
      if (calUid !== '' && calUid !== '-1') parsedTask.calendarId = calUid;
    }
    if (String(raw.IgnoreResourceCalendar ?? '0') === '1') parsedTask.ignoreResourceCalendar = true;
    if (constraint !== undefined) parsedTask.constraint = constraint;
    if (raw.Deadline !== undefined) {
      const dl = parseMspdiDate(String(raw.Deadline));
      if (!Number.isNaN(dl.getTime())) parsedTask.deadline = dl;
    }
    // Progress actuals (parity row 6). They only reschedule when the project
    // has a status date. MS Project writes RemainingDuration on every task, so
    // keep it only where it carries information: in-progress tasks.
    for (const [field, key] of [
      ['ActualStart', 'actualStart'],
      ['ActualFinish', 'actualFinish'],
    ] as const) {
      if (raw[field] === undefined) continue;
      const v = parseMspdiDate(String(raw[field]));
      if (!Number.isNaN(v.getTime())) parsedTask[key] = v;
    }
    // MS Project writes 0 on every task: keep only a reading.
    const physical = Number(raw.PhysicalPercentComplete ?? 0);
    if (Number.isFinite(physical) && physical > 0) {
      // Whole percent, as serialize writes and MS Project stores.
      parsedTask.physicalProgress = Math.min(100, Math.round(physical));
      if (physical > 100) {
        droppedFields.push({
          path: `${taskPath}.PhysicalPercentComplete`,
          value: `${String(raw.PhysicalPercentComplete)} clamped to 100`,
          reason: 'unsupported-element',
        });
      }
    }
    // MS Project (and our export) hold Duration = ActualDuration +
    // RemainingDuration, with % complete their ratio as a whole percent. Where
    // a started task's file says so, read the exact ratio: the whole percent
    // would move the remaining work by up to 0.5% of the duration, and each
    // round trip would move it again.
    const pct = Number(raw.PercentComplete ?? 0);
    const actualDuration =
      raw.ActualDuration !== undefined ? parseMspdiDuration(String(raw.ActualDuration)) : NaN;
    const remainingDuration =
      raw.RemainingDuration !== undefined ? parseMspdiDuration(String(raw.RemainingDuration)) : NaN;
    const exact = (actualDuration / duration) * 100;
    if (
      taskType !== 'summary' &&
      pct > 0 &&
      pct < 100 &&
      actualDuration > 0 &&
      remainingDuration > 0 &&
      Math.abs(actualDuration + remainingDuration - duration) <= 1 &&
      Math.abs(exact - pct) < 1
    ) {
      parsedTask.progress = exact;
    } else if (raw.RemainingDuration !== undefined && pct > 0 && pct < 100) {
      // Kept only where it says more than the % share: MS Project (and our
      // own export) write the share on every task, and keeping it would pin
      // the remaining work against later % edits.
      if (Math.abs(remainingDuration - Math.round(duration * (1 - pct / 100))) > 1) {
        parsedTask.remainingDuration = remainingDuration;
      }
    }
    // Elapsed duration formats (MPXJ): em/eh/ed/ew/emo and their estimated
    // variants. `Duration` is already wall-clock hours (3ed = PT72H).
    // Not on summaries: their duration is derived from the children.
    if (taskType !== 'summary' && ELAPSED_FORMATS.has(Number(raw.DurationFormat))) {
      parsedTask.durationElapsed = true;
    }
    // ADR-007: a task with no committed dates. Ours: a manual task with text
    // in place of its start and finish ("TBD"), which MS Project keeps when
    // it saves, adding placeholder dates (desktop run 11). Also a manual task
    // with no dates at all, and, in older files, a named IsNull task.
    const manual = String(raw.Manual ?? '0') === '1';
    const textDated = manual && hasText(raw.StartText) && hasText(raw.FinishText);
    const manualNoDates =
      manual &&
      raw.Start === undefined &&
      raw.Finish === undefined &&
      raw.ManualStart === undefined &&
      raw.ManualFinish === undefined;
    if (textDated || manualNoDates || String(raw.IsNull ?? '0') === '1') {
      parsedTask.unscheduled = true;
    }

    // Local custom-field values → Task.extra[key], keyed by the project-level
    // definition's alias. A lookup value (ValueGUID, no Value) or a value with
    // no matching definition is reported, never guessed onto extra.
    const rawTaskEa = raw.ExtendedAttribute as unknown[] | undefined;
    for (const ea of Array.isArray(rawTaskEa) ? rawTaskEa : rawTaskEa ? [rawTaskEa] : []) {
      const e = ea as Record<string, unknown>;
      const fid = Number(e?.FieldID);
      if (OUTLINE_CODE_FIELD_BY_ID.has(fid)) {
        // An outline-code value carried as an ExtendedAttribute (text or ValueGUID).
        const oc = outlineCodeByFieldId.get(fid);
        // ValueGUID first (Project 2007+), then the text.
        const value =
          oc?.byGuid.get(String(e?.ValueGUID ?? '').toUpperCase()) ??
          (e?.Value !== undefined ? String(e.Value) : undefined);
        if (oc && value !== undefined && value !== '') {
          parsedTask.codes = { ...(parsedTask.codes ?? {}), [oc.id]: value };
          // Free text not in the table: keep codeTypes consistent with codes.
          if (!oc.type.values.some((v) => v.value === value)) oc.type.values.push({ value });
        } else {
          droppedFields.push({
            path: `${taskPath}.ExtendedAttribute[${fid}]`,
            value: `outline-code value ${String(e?.Value ?? e?.ValueGUID ?? '')} — unresolved`,
            reason: 'lossy-on-roundtrip',
          });
        }
        continue;
      }
      if (e?.Value === undefined) {
        droppedFields.push({
          path: `${taskPath}.ExtendedAttribute[${Number.isFinite(fid) ? fid : '?'}]`,
          value:
            e?.ValueGUID !== undefined
              ? 'lookup value (ValueGUID) — unresolved'
              : 'malformed ExtendedAttribute (no Value)',
          reason: 'lossy-on-roundtrip',
        });
        continue;
      }
      const key = eaDefKeyByFieldId.get(fid);
      if (key === undefined) {
        droppedFields.push({
          path: `${taskPath}.ExtendedAttribute[${Number.isFinite(fid) ? fid : '?'}]`,
          value: String(e.Value),
          reason: 'unsupported-element',
        });
        continue;
      }
      parsedTask.extra = { ...(parsedTask.extra ?? {}), [key]: String(e.Value) };
    }

    // Outline-code values → Task.codes[codeTypeId]. ValueGUID first (Project
    // 2007+ ignores ValueID), then ValueID (MPXJ, Project 2003).
    for (const o of asList(raw.OutlineCode)) {
      const fid = Number(o?.FieldID);
      const oc = outlineCodeByFieldId.get(fid);
      const value =
        oc?.byGuid.get(String(o?.ValueGUID ?? '').toUpperCase()) ??
        oc?.byValueId.get(String(o?.ValueID ?? ''));
      if (oc && value !== undefined) {
        parsedTask.codes = { ...(parsedTask.codes ?? {}), [oc.id]: value };
        continue;
      }
      droppedFields.push({
        path: `${taskPath}.OutlineCode[${Number.isFinite(fid) ? fid : '?'}]`,
        value: oc
          ? o?.ValueGUID === undefined && o?.ValueID === undefined
            ? 'no ValueID / ValueGUID (an empty placeholder)'
            : `value ${String(o?.ValueGUID ?? o?.ValueID)} is not in the lookup table`
          : 'no task outline-code definition for this FieldID',
        reason: 'lossy-on-roundtrip',
      });
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
      if (skippedSummaryUids.has(srcUid)) {
        droppedFields.push({
          path: `${taskPath}.PredecessorLink[${p}]`,
          value: `predecessor UID ${srcUid} is a skipped row (project summary or blank)`,
          reason: 'unsupported-element',
        });
        continue;
      }

      const mspdiType = Number(link.Type ?? '1');
      const linkType: DependencyType = mspdiTypeToDependencyType(mspdiType);
      // LinkLag is tenths of a minute — except for percent LagFormats (19 %,
      // 20 e%), where it's the percentage itself (MPXJ 16.4 reader + writer,
      // Aspose TaskLink docs). Elapsed formats: 4 em, 6 eh, 8 ed, 10 ew,
      // 12 emo, 20 e%. Spec: 2026-10-16-percent-elapsed-lag-design.md.
      const rawLag = Number(link.LinkLag ?? '0');
      const lagFormat = Number(link.LagFormat ?? '7');
      // MPXJ 16.4 reader: 51/52 are the "estimated" %/e%; 36–44 estimated em…emo.
      const isPercent = [19, 20, 51, 52].includes(lagFormat);
      const isElapsed = ELAPSED_FORMATS.has(lagFormat) || lagFormat === 20 || lagFormat === 52; // + e%
      const parsedLink: Link = {
        id: `${srcUid}-${uid}-${p}`,
        source: srcUid,
        target: uid,
        type: linkType,
        lag: isPercent ? 0 : Math.round(rawLag / 10),
      };
      if (isPercent) parsedLink.lagPercent = rawLag;
      if (isElapsed) parsedLink.lagElapsed = true;
      links.push(parsedLink);

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
      // Guard partial baselines (MS Project can emit work-only <Baseline>s with
      // no Start/Finish): an Invalid Date snapshot re-serializes as NaN-NaN-NaN
      // XML that MS Project rejects. Skip + report rather than carry the NaN
      // (same guard class as the task-date fix above).
      const bStart = parseMspdiDate(String(baselineRaw.Start ?? ''));
      const bEnd = parseMspdiDate(String(baselineRaw.Finish ?? ''));
      if (Number.isNaN(bStart.getTime()) || Number.isNaN(bEnd.getTime())) {
        droppedFields.push({
          path: `${taskPath}.Baseline[${b}].${Number.isNaN(bStart.getTime()) ? 'Start' : 'Finish'}`,
          value: `Start=${String(baselineRaw.Start ?? '')} Finish=${String(baselineRaw.Finish ?? '')}`,
          reason: 'lossy-on-roundtrip',
        });
        continue;
      }
      const snap: BaselineTaskSnapshot = {
        start: bStart,
        end: bEnd,
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
      // Text dates: empty in MS Project's saves, or what marks an unscheduled
      // task. Text on a dated task is reported.
      if (TEXT_DATE_FIELDS.has(key) && (value === '' || parsedTask.unscheduled)) continue;
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
      // MS Project writes a nameless UID 0 resource into every file: its
      // internal "unassigned" placeholder, not a resource the host should see.
      if (String(raw.UID ?? '') === '0' && String(raw.Name ?? '').trim() === '') {
        droppedFields.push({
          path: `Project.Resources.Resource[${i}]`,
          value: 'placeholder resource (UID 0) skipped',
          reason: 'unsupported-element',
        });
        continue;
      }
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

  // Reference consistency — the mirror of serializeMspdi's dangling-ref policy,
  // so a parse → serialize round-trip of a real MS Project file is clean:
  //  - unassigned-task placeholders (ResourceUID -65535, MS Project's "no
  //    resource" sentinel) are skipped, reported once in total;
  //  - an assignment whose task or resource isn't in the file (incl. the
  //    skipped project-summary row) is dropped + reported;
  //  - a task/resource calendarId naming no calendar in the file is cleared +
  //    reported (the entity falls back to the project default).
  const calendarIds = new Set(calendars.map((c) => String(c.id)));
  for (const t of tasks) {
    if (t.calendarId !== undefined && !calendarIds.has(String(t.calendarId))) {
      droppedFields.push({
        path: `Project.Tasks.Task[UID=${String(t.id)}].CalendarUID`,
        value: `calendar "${String(t.calendarId)}" is not in the file`,
        reason: 'unsupported-element',
      });
      delete t.calendarId;
    }
  }
  for (const r of resources) {
    if (r.calendarId !== undefined && !calendarIds.has(String(r.calendarId))) {
      droppedFields.push({
        path: `Project.Resources.Resource[UID=${String(r.id)}].CalendarUID`,
        value: `calendar "${String(r.calendarId)}" is not in the file`,
        reason: 'unsupported-element',
      });
      delete r.calendarId;
    }
  }
  const taskIds = new Set(tasks.map((t) => String(t.id)));
  const resourceIds = new Set(resources.map((r) => String(r.id)));
  let placeholderAssignments = 0;
  const consistentAssignments = assignments.filter((a, i) => {
    if (a.resourceId === UNASSIGNED_RESOURCE_UID) {
      placeholderAssignments++;
      return false;
    }
    if (taskIds.has(String(a.taskId)) && resourceIds.has(String(a.resourceId))) return true;
    droppedFields.push({
      path: `Project.Assignments.Assignment[${i}]`,
      value: `assignment "${String(a.id)}" references task "${String(a.taskId)}" / resource "${String(a.resourceId)}" not in the file`,
      reason: 'unsupported-element',
    });
    return false;
  });
  if (placeholderAssignments > 0) {
    droppedFields.push({
      path: 'Project.Assignments',
      value: `${placeholderAssignments} unassigned-task placeholder assignment(s) (ResourceUID ${UNASSIGNED_RESOURCE_UID}) skipped`,
      reason: 'unsupported-element',
    });
  }
  assignments.length = 0;
  assignments.push(...consistentAssignments);

  // The project calendar: `<CalendarUID>` on the root when it names a parsed
  // calendar (MS Project always writes it). Otherwise the first base calendar;
  // then the first calendar; then 'std'.
  let defaultCalendarId = 'std';
  const firstCalendar = calendars[0];
  const rootCalUid = root.CalendarUID !== undefined ? String(root.CalendarUID) : undefined;
  if (rootCalUid !== undefined && calendars.some((c) => String(c.id) === rootCalUid)) {
    defaultCalendarId = rootCalUid;
  } else if (firstCalendar) {
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
  if (codeTypes.length > 0) project.codeTypes = codeTypes;
  if (root.StatusDate !== undefined) {
    const sd = parseMspdiDate(String(root.StatusDate));
    if (!Number.isNaN(sd.getTime())) project.statusDate = sd;
  }

  return { project, droppedFields };
}

interface ParsedOutlineCode {
  /** The code type id (= its name): Task.codes key. */
  id: string;
  /** ValueID → full value text. */
  byValueId: Map<string, string>;
  /** Value FieldGUID (uppercase) → full value text. */
  byGuid: Map<string, string>;
  /** The CodeType itself: free-text values (no table entry) are added to it. */
  type: CodeType;
}

const asList = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : v !== undefined && v !== null && v !== '' ? [v] : []) as Record<
    string,
    unknown
  >[];

/**
 * Project <OutlineCodes> → code types. Each task outline code (Outline
 * Code1..10, by FieldID or by its Guid = a paired definition's Ltuid) becomes
 * a CodeType named by the paired ExtendedAttribute's Alias, else its own
 * Alias / FieldName. Hierarchical values flatten to their full path, joined by
 * each level's mask separator — the text MS Project shows in the cell.
 */
function parseOutlineCodes(
  raw: Record<string, unknown> | undefined,
  aliasByFieldId: ReadonlyMap<number, string>,
  fieldIdByLtuid: ReadonlyMap<string, number>,
  droppedFields: DroppedField[],
): { codeTypes: CodeType[]; outlineCodeByFieldId: Map<number, ParsedOutlineCode> } {
  const codeTypes: CodeType[] = [];
  const outlineCodeByFieldId = new Map<number, ParsedOutlineCode>();
  for (const [i, def] of asList(raw?.OutlineCode).entries()) {
    const path = `Project.OutlineCodes.OutlineCode[${i}]`;
    // An empty <FieldID/> is absent (Number('') is 0): pair by Guid instead.
    const byFieldId =
      def.FieldID !== undefined && String(def.FieldID) !== '' ? Number(def.FieldID) : Number.NaN;
    const fid = Number.isFinite(byFieldId)
      ? byFieldId
      : fieldIdByLtuid.get(String(def.Guid ?? '').toUpperCase());
    const field = fid === undefined ? undefined : OUTLINE_CODE_FIELD_BY_ID.get(fid);
    if (fid === undefined || field === undefined) {
      droppedFields.push({
        path,
        value: `lookup table for FieldID ${String(def.FieldID ?? def.Guid ?? '?')} (not a task Outline Code1–10) not read`,
        reason: 'unsupported-element',
      });
      continue;
    }
    const nonEmpty = (v: unknown) => (v !== undefined && String(v) !== '' ? String(v) : undefined);
    const name =
      aliasByFieldId.get(fid) ??
      nonEmpty(def.Alias) ??
      nonEmpty(def.FieldName) ??
      `Outline Code${field}`;
    if (outlineCodeByFieldId.has(fid) || codeTypes.some((c) => c.id === name)) {
      droppedFields.push({
        path,
        value: `outline code "${name}" (FieldID ${fid}) ignored: already defined (first wins)`,
        reason: 'unsupported-element',
      });
      continue;
    }
    const separators = new Map<number, string>();
    for (const m of asList((def.Masks as Record<string, unknown> | undefined)?.Mask)) {
      const level = Number(m.Level);
      if (Number.isFinite(level)) separators.set(level, String(m.Separator ?? '.'));
    }
    const nodes = asList((def.Values as Record<string, unknown> | undefined)?.Value).map(
      (v, k) => ({
        key: v.ValueID !== undefined ? String(v.ValueID) : `#${k}`,
        parent: v.ParentValueID !== undefined ? String(v.ParentValueID) : '0',
        text: v.Value !== undefined ? String(v.Value) : '',
        description: nonEmpty(v.Description),
        guid: v.FieldGUID !== undefined ? String(v.FieldGUID).toUpperCase() : undefined,
      }),
    );
    const byKey = new Map(nodes.map((n) => [n.key, n]));
    const fullPath = (n: (typeof nodes)[number]): string => {
      // Walk up to the root; a parent cycle stops at the first repeat.
      const chain = [n];
      const seen = new Set([n.key]);
      for (let p = byKey.get(n.parent); p && !seen.has(p.key); p = byKey.get(p.parent)) {
        chain.unshift(p);
        seen.add(p.key);
      }
      return chain
        .map((c, level) => (level === 0 ? c.text : `${separators.get(level) ?? '.'}${c.text}`))
        .join('');
    };
    const values: CodeType['values'] = [];
    const type: CodeType = { id: name, name, values };
    const oc: ParsedOutlineCode = { id: name, byValueId: new Map(), byGuid: new Map(), type };
    for (const n of nodes) {
      if (n.text === '') continue;
      const text = fullPath(n);
      oc.byValueId.set(n.key, text);
      if (n.guid) oc.byGuid.set(n.guid, text);
      if (values.some((v) => v.value === text)) continue;
      values.push(n.description ? { value: text, description: n.description } : { value: text });
    }
    outlineCodeByFieldId.set(fid, oc);
    codeTypes.push(type);
  }
  // An alias definition with no lookup table (a third-party writer): its text
  // values still read, into a code type with no table.
  for (const [fid, alias] of aliasByFieldId) {
    if (outlineCodeByFieldId.has(fid) || codeTypes.some((c) => c.id === alias)) continue;
    const type: CodeType = { id: alias, name: alias, values: [] };
    outlineCodeByFieldId.set(fid, { id: alias, byValueId: new Map(), byGuid: new Map(), type });
    codeTypes.push(type);
  }
  return { codeTypes, outlineCodeByFieldId };
}

const KNOWN_CALENDAR_FIELDS = new Set([
  'UID',
  'Name',
  'IsBaseCalendar',
  'BaseCalendarUID',
  'WeekDays',
  'Exceptions',
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

// Expand an MSPDI exception's FromDate..ToDate range into one CalendarException
// per calendar day (inclusive). MS Project writes a multi-day shutdown (the
// canonical NZ Christmas break) as a single element with a date range, but our
// model stores per-day exceptions — reading only FromDate collapses the whole
// break to one non-working day. Bounded at MAX_EXCEPTION_DAYS so a garbage/far
// ToDate can't blow up memory.
const MAX_EXCEPTION_DAYS = 400;
function expandExceptionRange(
  rawFrom: string,
  rawTo: string,
  isWorking: boolean,
  intervals: WorkInterval[] | undefined,
  name: string | undefined,
  path: string,
  droppedFields: DroppedField[],
): CalendarException[] {
  const out: CalendarException[] = [];
  const fromDate = parseMspdiDate(rawFrom);
  if (Number.isNaN(fromDate.getTime())) {
    droppedFields.push({ path: `${path}.FromDate`, value: rawFrom, reason: 'unsupported-element' });
    return out;
  }
  const start = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate());
  const toDate = parseMspdiDate(rawTo);
  let end = start; // absent/blank ToDate → single day (common, not reported)
  if (!Number.isNaN(toDate.getTime())) {
    const to = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate());
    if (to.getTime() < start.getTime()) {
      // Reversed range is malformed — treat as a single day + report.
      droppedFields.push({
        path: `${path}.ToDate`,
        value: `${rawTo} (before FromDate ${rawFrom})`,
        reason: 'unsupported-element',
      });
    } else {
      end = to;
    }
  }
  for (let d = new Date(start); d.getTime() <= end.getTime(); d.setDate(d.getDate() + 1)) {
    if (out.length >= MAX_EXCEPTION_DAYS) {
      droppedFields.push({
        path: `${path}.ToDate`,
        value: `range exceeds ${MAX_EXCEPTION_DAYS} days; truncated`,
        reason: 'lossy-on-roundtrip',
      });
      break;
    }
    const ex: CalendarException = { date: new Date(d), isWorking };
    // Per-day copy so no two days alias one intervals array.
    if (isWorking && intervals?.length) ex.intervals = intervals.slice();
    if (name) ex.name = name;
    out.push(ex);
  }
  return out;
}

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

  // Recurring weekdays the file lists. A derived calendar omits the ones it
  // inherits from its base — those become `inheritedDays`, not non-working.
  const listedDays = new Set<DayOfWeek>();

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
        listedDays.add(dayOfWeek);
      } else if (dayType === 0) {
        // Legacy exception entry: a DayType=0 WeekDay with a TimePeriod range.
        // FromDate..ToDate can span multiple days (Christmas shutdown) — expand
        // to per-day exceptions rather than collapsing to FromDate alone.
        const timePeriod = wd.TimePeriod as Record<string, unknown> | undefined;
        if (!timePeriod) continue;
        const intervals = dayWorking ? parseWorkingTimes(wd) : undefined;
        exceptions.push(
          ...expandExceptionRange(
            String(timePeriod.FromDate ?? ''),
            String(timePeriod.ToDate ?? ''),
            dayWorking,
            intervals,
            undefined,
            wdPath,
            droppedFields,
          ),
        );
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

  // Modern (Project 2007+) calendar exceptions: <Exceptions><Exception>, each
  // with its own TimePeriod range + DayWorking — distinct from the legacy
  // DayType=0 WeekDay form above. Without this, a modern export's entire holiday
  // set lands in droppedFields and the calendar has zero holidays, so CPM dates
  // silently diverge from MS Project. Non-recurring first cut: a single-span
  // exception is expanded literally; recurring ones are skipped + reported
  // (see the recurrence guard below) rather than mis-expanded across their span.
  const exceptionEls = (raw.Exceptions as Record<string, unknown> | undefined)?.Exception;
  const excArr: unknown[] = Array.isArray(exceptionEls)
    ? exceptionEls
    : exceptionEls !== undefined
      ? [exceptionEls]
      : [];
  for (let i = 0; i < excArr.length; i++) {
    const exc = excArr[i] as Record<string, unknown>;
    const tp = exc.TimePeriod as Record<string, unknown> | undefined;
    if (!tp) continue;
    // Recurrence guard: a recurring exception carries a TimePeriod spanning
    // first→last occurrence, so literal per-day expansion would darken the whole
    // multi-year span (a yearly holiday → ~400 consecutive non-working days).
    // The ONLY reliable recurrence signal is a multi-occurrence count: MS Project
    // writes the pattern fields (<Type>/<Period>/<DaysOfWeek>/<MonthItem>/
    // <MonthDay>) with DEFAULT values on one-off exceptions too, so keying on
    // their presence wrongly drops a legitimate single shutdown (Codex review
    // 2026-07-12). Date-bounded recurrence (Occurrences absent/1) is not
    // distinguishable from a one-off by fields and is left to expand, bounded by
    // the MAX_EXCEPTION_DAYS cap. Recurrence expansion itself is unsupported —
    // skip + report the multi-occurrence case.
    const occurrences = Number(exc.Occurrences ?? '1');
    const isRecurring = Number.isFinite(occurrences) && occurrences > 1;
    if (isRecurring) {
      droppedFields.push({
        path: `${path}.Exceptions.Exception[${i}]`,
        value: `recurring exception (Occurrences=${String(exc.Occurrences ?? '')}) — recurrence expansion unsupported`,
        reason: 'unsupported-element',
      });
      continue;
    }
    const dayWorking = String(exc.DayWorking ?? '0') === '1';
    const intervals = dayWorking ? parseWorkingTimes(exc) : undefined;
    const name = exc.Name !== undefined ? String(exc.Name) : undefined;
    exceptions.push(
      ...expandExceptionRange(
        String(tp.FromDate ?? ''),
        String(tp.ToDate ?? ''),
        dayWorking,
        intervals,
        name,
        `${path}.Exceptions.Exception[${i}]`,
        droppedFields,
      ),
    );
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
    calendar.inheritedDays = ([0, 1, 2, 3, 4, 5, 6] as DayOfWeek[]).filter(
      (d) => !listedDays.has(d),
    );
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
    const startMinutes = parseMspdiTime(fromTime);
    const endMinutes = parseMspdiTime(toTime);
    intervals.push({
      startMinutes,
      // A ToTime of midnight (never after FromTime) is the end of the day: MS
      // Project's "24 Hours" calendar is 00:00:00 → 00:00:00, a shift to
      // midnight 08:00:00 → 00:00:00 (MPXJ 16.4 reads them as 24 h and 16 h).
      // Only a literal midnight: a missing / unreadable ToTime stays 0.
      endMinutes: endMinutes === 0 && /^0?0:00:00$/.test(toTime) ? 1440 : endMinutes,
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

function parseConstraint(
  raw: Record<string, unknown>,
  droppedFields: DroppedField[],
  path: string,
): Task['constraint'] {
  const value = Number(raw.ConstraintType ?? '0');
  const type = MSPDI_CONSTRAINT_TO_INTERNAL[value as keyof typeof MSPDI_CONSTRAINT_TO_INTERNAL];
  if (!type || type === 'ASAP') return undefined;

  const constraint: NonNullable<Task['constraint']> = { type };
  if (raw.ConstraintDate !== undefined && raw.ConstraintDate !== '') {
    const d = parseMspdiDate(String(raw.ConstraintDate));
    // A garbage ConstraintDate parses to Invalid Date; stored, it makes the
    // constraint silently inert (all date comparisons false) and re-serializes
    // as NaN. Drop it + report, keeping the constraint type.
    if (Number.isNaN(d.getTime())) {
      droppedFields.push({
        path: `${path}.ConstraintDate`,
        value: String(raw.ConstraintDate),
        reason: 'unsupported-element',
      });
    } else {
      constraint.date = d;
    }
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
