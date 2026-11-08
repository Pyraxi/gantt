# @pyraxi/cpm-engine

## 1.3.0

### Minor Changes

- 5a40b16: **Multi-project programmes: `combineProjects` and `analyseCombined`.** Show several jobs in one `<Gantt>`, with one critical path across them.

  - **`combineProjects(parts, options?)`** combines `{ key, name?, project }[]` into one ordinary `Project`, so `schedule()` gives float and the critical path across jobs.
    - **Ids:** every task, link, calendar, resource, assignment and baseline id becomes `${key}/${id}`.
    - **Summary rows:** each job becomes a summary row (id `key`) over its own tasks.
    - **Start:** the programme starts at the earliest job start. A job that starts later floors its auto-scheduled tasks at its own start, snapped into each task's calendar.
      - The floor is an injected or raised SNET, listed in `notes`. **It isn't the PM's:** save a whole task back through `toPart(task)`, which removes the floor or restores the original constraint (keeping any constraint the host set since), and un-namespaces its ids.
      - Under a status date, only not-started tasks are floored.
    - **Status dates:** one data date applies to the whole programme. Parts' status dates must agree, unless `options.statusDate` sets one.
    - **Finish anchors:** a job's `end` doesn't bound the programme. It is passed through on `parts`.
    - **Baselines:** combined by index.
    - **Code types:** merged.
    - **Mapping ids back:** `locate(id)` maps a combined id back to `{ key, id }`, so an edit patch can be routed to its own job; `idOf(key, id)` is the inverse. `toPart(task)` gives a whole task back as its job's own.
    - **Cross-project links:** the optional `options.links` (`{ id, from: { key, id }, to: { key, id }, type, lag }`) become ordinary links with id `x:${id}`. An unknown end throws.
  - **`analyseCombined(scheduled, combined)`** gives the programme view: the finish, the critical path across jobs (each task located to its job), and each job's start, finish, own `end` anchor, float (unfinished tasks only) and whether it is critical.

  Single projects are unchanged.

- 780598f: New `baselineFrom(before, index, options)` turns a schedule revision into a `Baseline`, built from its forecast. Add it to the current project's `baselines` and show it with `baselineIndices`: the earlier revision draws as ghost rows, and the variance pills show the revision's slip or gain, like MS Project's Compare Project Versions. Its deltas match `compareSchedules` for tasks on the project's default calendar. Baseline variance counts working time in the default calendar, while `compareSchedules` counts each task in its own calendar. Pass the revision's date as `capturedAt`, because the ghost label reads "captured <date>".
- dc2f827: New `compareSchedules(before, after, { dates? })`: what changed between two revisions of a programme, like P6's Claim Digger or MS Project's Compare Project Versions.

  - **Tasks** are matched by id and marked added, removed or changed. For changed tasks, only the fields that differ are listed: name, start, finish, duration, progress, total float, critical, constraint and parent. Moves carry signed working-minute deltas.
  - **Links** are matched by predecessor → successor, so regenerated link ids don't show up as churn. Each is added, removed, or changed in type or lag.
  - **The summary** counts moved, duration-changed and logic changes, tasks that became or stopped being critical, and the project finish delta.

  Deltas are in each task's own calendar, and about 100 ms covers a 5,000-task comparison. Status changes, actual dates, unscheduled tasks and task type changes are reported; a task that simply completed doesn't count as "no longer critical". Summaries are listed but not counted.

  It's pure: it schedules either side if needed (or always, with `reschedule: true`) and never changes the input.

- c93a676: Driving-path analysis:

  - **`analyseDriving(project)`:** analyse once, then ask for any number of driving paths. Use this when highlighting many tasks; every task's path at 665 tasks takes about 0.1 s.
  - **`getLinkDriving(project)`:** each link's relationship free float, in the successor's calendar, and whether it drives the successor. Because it uses the successor's calendar, a link can drive while its predecessor still has free slack.
  - **`getDrivingPath(project, taskId)`:** every task and link that sets a task's start, like MS Project's Task Path.
  - **`getLongestPath(project)`:** P6's Longest Path, the driving chain to the latest early finish among tasks with logic. A dangling constrained end milestone can't hijack it.
  - **`getFloatPaths(project, { endTaskId?, maxPaths? })`:** ranked float paths. Path 1 is the driving path to the end task; later paths go by lowest total float. This is close to, but not identical with, P6's total-float mode.

  All are pure, and they schedule the project if needed. An unknown, summary or unscheduled task id gives an empty path.

- 84e2eee: `schedule()` now honours task and resource calendars. Each task works in its effective calendar: `Task.calendarId` (or the project default) intersected with the calendar of every assigned resource that has an explicit `calendarId`. Set `Task.ignoreResourceCalendar` to opt a task out of that.

  - Lag runs in the successor's calendar. Total, free and deadline slack are measured in the task's own calendar. Summaries keep the default calendar.
  - `Calendar.baseCalendarId` inheritance is now applied: the base's exceptions fill in dates the derived calendar doesn't override, and the new `Calendar.inheritedDays` take the base's weekly hours.
  - MSPDI: a derived calendar's missing `<WeekDay>`s parse as `inheritedDays`. Serialize writes `BaseCalendarUID` (following the integer remap) and omits the inherited days. `<IgnoreResourceCalendar>` round-trips.
  - New exports: `getEffectiveCalendar(project, taskId)` and `resolveCalendar(project, id)`, plus the types `EffectiveCalendar` and `CalendarFallback`.
  - `schedule()` never throws over task or resource calendar data. An unknown `calendarId`, or a task calendar with no working time, falls back to the default. Task and resource calendars with no common working time fall back to the task's own calendar. Each case sets `computed.calendarFallback`. Only a missing or empty _project default_ calendar still throws, as before.

  **Behaviour change:** projects whose tasks or resources set `calendarId` will now schedule in those calendars, as the docs always said. Projects that set none produce the same output as before.

- 9520d3d: Elapsed durations: `Task.durationElapsed` runs a task's duration in wall-clock time, through nights, weekends and holidays. This is MS Project's `3ed`, for curing and drying.
  - **Engine:**
    - The duration runs on a 24/7 calendar (`ELAPSED_CALENDAR`), and `duration` is wall-clock minutes (3 days = 4,320). The task's own and its resources' calendars are overridden, as in MS Project.
    - Lags into the task still run in its real calendar: a "1d" lag is a working day. `getEffectiveCalendar` reports that calendar as `lagCalendar`.
    - Float is exact, leads included: slipping any task by its float never moves the project finish. It's fuzz-tested across mixed calendars (see the cross-calendar float fix).
    - Baseline variance is now measured in each task's own calendar, which agrees with `compareSchedules`.
    - New `formatElapsedDuration` / `parseElapsedDuration` helpers (`3ed`, `36eh`).
  - **MSPDI:**
    - `DurationFormat` elapsed codes (em/eh/ed/ew/emo and their estimated variants) parse to `durationElapsed`. Summaries are excluded.
    - Elapsed tasks serialize with `DurationFormat` 8, and MPXJ reads them back as `3.0ed`.
    - Manual tasks also write `FreeformDurationFormat`. Without it, MS Project desktop opened a manual `2ed` task as 2 working days (run 12).
  - **`@pyraxi/gantt`:**
    - Elapsed tasks draw as 24-hour days and show as `3ed`.
    - Typed or pasted durations on them are elapsed days (`3`, `3d` and `3ed` all mean 3 × 24 h).
  - Projects without the flag schedule exactly as before: a 1,502-project main-vs-branch differential showed 0 differences.
- bf90a34: **MS Project stable-id round-trip (MSPDI ExtendedAttributes + integer UIDs).**

  - `serializeMspdi(project, { extendedAttributes: [{ field: 'Text1', extraKey: 'cmTaskId' }] })` writes `Task.extra` values into MS Project's local Text custom field (project-level `<ExtendedAttributes>` definition + per-task values). `parseMspdi` reads them back onto `Task.extra[alias]`. `Text1` is the supported field today.
  - `remapIdsToIntegers: true` (+ optional `idRemap` collector) emits every UID as a sequential integer from 1 per namespace, with all cross-references rewritten consistently. MS Project needs integer UIDs, and the original id travels in the Text field as your merge key.
  - New exported types: `ExtendedAttributeMapping`, `IdRemapEntry`.
  - Serialize now emits `<Project>` children in schema order (Tasks before Resources), which MS Project's importer requires.

  **Behaviour changes (minor):**

  - `parseMspdi` populates `Task.extra` from local custom fields that have a definition. These used to be ignored.
  - `parseMspdi` skips MS Project's project-summary row (UID 0 at OutlineLevel 0) and reports it in `droppedFields`, together with any link from it.
  - `serializeMspdi` never emits a reference to an id that isn't in the project: a link source, an assignment endpoint, or a task/resource `calendarId`. The referencing element is dropped and reported in `droppedFields`. Previously such ids were written verbatim. Links whose target task is missing, and baseline snapshots for unknown tasks, were already silently omitted; they are now reported too. Duplicate ids within a namespace are reported, because they share a UID.
  - `serializeMspdi` emits `<Task>` children in MSPDI schema order. A mapped `extra` value that is an object is skipped and reported, not written as `[object Object]`.
  - `parseMspdi` keeps the model's references consistent so a real-file round-trip is clean:
    - MS Project's unassigned-task placeholder assignments (`ResourceUID -65535`) are skipped, with one summary entry.
    - An assignment to a task or resource that isn't in the file is dropped and reported.
    - A task or resource `calendarId` naming a calendar that isn't in the file is cleared and reported.
    - An empty `<Alias/>` falls back to the FieldName, and a definition ignored as a duplicate key is reported.

- a72ffef: MSPDI outline codes ↔ activity codes.

  - **`parseMspdi`** reads MS Project task outline codes (Outline Code1–10) into `Project.codeTypes` and `Task.codes`, with no config.
    - Each code type is named by its alias. Hierarchical values read as their full path.
    - A task value is resolved by `ValueGUID` first (Project 2007+), then by `ValueID` (Project 2003, MPXJ). Values carried as a task `ExtendedAttribute` are read too.
    - An outline code's paired ExtendedAttribute definition no longer creates a `Task.extra` key. Its text values go to `Task.codes` instead, even when the file has no lookup table.
    - An aliased outline code with no values reads as an empty code type.
    - Unresolvable values are reported in `droppedFields`.
  - **`serializeMspdi({ outlineCodes: [{ codeTypeId, field }] })`** writes, for each mapped code type:
    - the lookup table and its paired definition (`Guid` = `Ltuid`, both deterministic);
    - each task's value, in both forms (`ValueID` and `ValueGUID`).
    - A task value missing from the table is appended to it.
    - Config errors throw: an unknown field, a duplicate field, an unknown code type, or a name already used as an alias, case-insensitively (by another code type or an `extendedAttributes` mapping). MS Project needs custom-field aliases unique.
    - Values are trimmed; whitespace-only values are absent.
    - **Reported in `droppedFields`:** unmapped code types, orphan task codes and value colours.
  - **Verified with MPXJ 16.4 both ways.** MPXJ reads our tables and values, and we read MPXJ's.
  - **Not yet checked in MS Project desktop:** an outline-code file is part of the pending release check.

- dfd4285: Percent and elapsed lag:

  - **`Link.lagPercent`** expresses a lag as a percentage of the predecessor's duration, like MS Project's `FS+50%`. Negative values are leads.
  - **`Link.lagElapsed`** runs the lag in wall-clock time, through nights and weekends. Use it for curing and drying.
  - Both work in `schedule()`'s forward and backward passes and in free slack. They're also counted by `checkSchedule` and reported by `compareSchedules`.

  **Non-working time:** an elapsed lag can end in non-working time, for example Sat 17:00.

  - A finish constraint there is met by finishing at the end of the previous working period (Fri 17:00), the same way an FNET dated on a Saturday is.
  - A start waits for the next working moment.
  - So model cure and dry times as **FS** elapsed lags. There the gap bites the right way: the successor starts after the lag. An FF lag that ends in non-working time is absorbed up to the previous period end.
  - Float stays exact either way. This was fuzz-tested: slipping any task by its total float moves no finish.

  **Percent lag under a status date** uses the predecessor's full duration everywhere, as MS Project does.

  **Elapsed percent** (`lagPercent` with `lagElapsed`, MS Project's `e%`) round-trips through MSPDI. Its scheduling is a best guess (percent of duration, applied as elapsed minutes) until it's checked against MS Project.

  **MSPDI fix:** `parseMspdi` now respects `LagFormat`. Before, a 50% lag from MS Project read as 5 minutes, and elapsed lags were compressed into working time. Percent and elapsed lags round-trip, and MPXJ accepts them. The "estimated" `LagFormat` variants (51/52 and 36–44) are read too.

  **Also:**

  - `lagMinutes(link, source)` is exported.
  - `updateLink(id, { lag })` on a percent link now replaces the percent; before, `lagPercent` silently kept overriding.
  - `@pyraxi/gantt`'s predecessor column shows `FS+50%`, `SS-25e%` and `FS+2 edays` instead of mis-rendering these links as working lag.

  Links without the new fields schedule exactly as before: a 1,502-project main-vs-branch differential showed 0 differences.

- 4a08af3: Physical % complete.

  - **`Task.physicalProgress`** (0–100) records how much work is in place, judged on site, independently of `progress` (duration %), as MS Project and P6 do. It never drives scheduling.
  - **MSPDI** reads and writes `<PhysicalPercentComplete>`, in schema order (after `IgnoreResourceCalendar`, before `PredecessorLink`; checked against MPXJ). MS Project's `0` on every task isn't kept.
  - **Progress line:** `progressPoints(project, statusDate, { basis: 'physical' })` and `<Gantt progressLine={{ basis: 'physical' }}>` place each point by physical % (P6's option). A task without one falls back to duration %.
  - **`compareSchedules`** reports `physicalProgress` changes.

- f2ca87d: Baseline pills are now measured in the task's own calendar, as `getTaskBaselineVarianceAll` and `compareSchedules` measure:
  - **Variance and slip/ahead pills:** a task on a 24-hour or other calendar shows its variance in that calendar.
  - **Float labels:** the pill's day length follows the task's calendar too. A 40-hour slip of a 24-hour task reads `+2d`, not `+4d`. Elapsed tasks read `ed`.
  - **Unchanged:** rows on the default calendar.
  - **Engine:** exports `createCalendarResolver` for per-task effective-calendar lookups. It's O(1) per task, where `getEffectiveCalendar` builds a resolver on every call.
- f212fa2: Set a task's predecessors in one undoable edit.

  - `setPredecessors(targetId, preds)` / `SetPredecessorsCommand` replaces the target's incoming links with `PredecessorSpec[]` (`{ source, type, lag, lagPercent?, lagElapsed? }`).
    - Unchanged links keep their ids. Changed ones are updated in place, and new ones get `source->target` ids.
    - It refuses (with an `EditError`) a self-reference, an unknown task, a task listed twice and anything that would create a dependency loop.
    - Ids match by `String()`, and new links carry the task's own id (so `'1'` for numeric task `1` is written as `1`).
    - Undo restores the previous links exactly.
  - `diffPredecessors(targetId, links, preds)` returns the `{ create, remove, update }` plan without applying it.
  - `predecessorsCreateCycle(targetId, links, preds)` is the loop check on its own, for validating input before committing.

- 457ba21: Progress line, the weekly-update view from MS Project and P6:
  - **`@pyraxi/gantt`:** new `progressLine` prop (`true`, or `{ statusDate, color }`; default off). It draws the jagged line from the status date through each task's progress point, bending left for tasks behind and right for tasks ahead.
    - It's positioned from SVAR's own layout, so it lines up at every zoom level.
    - Nothing is drawn without a status date, or when the status date is off the timeline.
    - It isn't included in PNG/PDF exports yet.
    - Colour: `--cg-progress-line-color`.
  - **`@pyraxi/cpm-engine`:** new `progressPoints(project, statusDate?)` returns each task's progress point.
    - Complete tasks, and tasks not yet due, sit on the status date.
    - Otherwise the point is the task's start plus the work done, in working time. Work done follows the engine's forecast: `remainingDuration` when set, otherwise `progress%`. A task that started early sits right of the line.
- ce70fe3: Resource usage and over-allocation.

  - **`resourceUsage(project, { from?, to?, bucket? })`:** per resource, each day (or Monday-start week) has a `load` against its `capacity`, flagged `overAllocated` when load exceeds capacity.
    - `load` is assigned working minutes: units × the minutes each task actually works, on its effective calendar. A split task's gap is idle. An in-progress task under a status date counts its work done, then its remaining work from the remaining start, not the idle gap between.
    - Assignments are `project.assignments` plus `Task.resourceIds` (units 1).
    - Each period lists the tasks that load it (`taskIds`).
    - `capacity` is the resource calendar's working minutes.
  - **`overAllocations(project)`:** the over-allocated stretches, merged, with the tasks that load them. They're ready to list, or to feed `<Gantt highlights>`.
  - **Read-only:** it never moves a task (levelling is out of scope, ADR-003). Completed work counts, as in MS Project's Resource Graph.
  - **Buckets** are whole days or weeks; `from` / `to` pick buckets rather than clip load.
  - **Speed:** about 0.5 s at 5,000 tasks and 50 resources over two years of days, scheduling included.

- ab2deae: New `checkSchedule(project, options?)`: a DCMA-14-style schedule quality report. It covers:

  - missing logic
  - leads, lags, non-FS links, SF links
  - hard constraints
  - high and negative float
  - long durations
  - invalid dates (with an optional `statusDate`)
  - whether a critical path exists

  Each check returns its DCMA number, unit, count, ratio, threshold, pass/fail, and the offending task or link ids, ready to list or highlight. Thresholds and the 44-working-day limits are configurable.

  Populations follow DCMA as P6 and Acumen apply it:

  - Link checks count only links between tasks (never summaries) whose successor is incomplete.
  - Day limits use each task's own calendar.
  - Long durations are judged on remaining duration.

  It's a pure function: it schedules the project itself if needed (or always, with `reschedule: true`) and never changes the input. Also exports the types `ScheduleCheck`, `ScheduleCheckId`, `ScheduleCheckResult` and `CheckScheduleOptions`.

- 5cea0bd: P6 secondary constraint and Expected Finish:
  - **`Task.secondaryConstraint`** takes SNET, SNLT, FNET or FNLT and is applied after the primary, for example a start floor plus a finish deadline. It's ignored when the primary is MSO or MFO, as P6 disallows that combination. In-progress tasks honour a secondary finish constraint.
  - **`Task.expectedFinish`:** with a status date, an in-progress task's remaining work runs from the status date to this date. It overrides `remainingDuration` and `progress`.
  - **`remainingMinutes(task, { statusDate, calendar })`** now accounts for Expected Finish. `schedule`, driving-path analysis, `checkSchedule` and `progressPoints` all use it.
  - **MS Project files:** neither field exists in MSPDI, but the forecast survives export. An in-progress task with an Expected Finish writes the engine's `RemainingDuration`. Both fields are reported in `droppedFields`.
  - **`checkSchedule`:** the hard-constraints check counts a secondary SNLT/FNLT.
  - **Scope:** Expected Finish applies to in-progress work only.
  - Projects without these fields schedule exactly as before: a 1,502-project main-vs-branch differential showed 0 differences.
- 4328240: Status date and progress scheduling (opt-in). Set `project.statusDate`, and `schedule()` schedules from the actuals the way MS Project does. MS Project desktop checked every case (desktop runs 8 and 9):

  - **Complete tasks** (`actualFinish`, or 100%) are fixed at their actual dates, with no float.
  - **In-progress tasks** (`actualStart`, or 0 < progress < 100) keep their actual start. Their remaining work (`remainingDuration`, else derived from progress) follows straight after the work done.
  - **The status date itself moves nothing,** as in MS Project. Unstarted work stays where its logic puts it, even behind the status date. `checkSchedule()` reports work like that as invalid dates.
  - **`rescheduleAfterStatusDate: true`** forecasts from the status date instead, like P6's data date or MS Project's "Reschedule uncompleted work to start after": remaining work starts no earlier than the status date, and nothing unstarted is forecast before it, except a hard MSO/MFO pin.
  - **Progress mode:** `progressMode: 'retained-logic'` (the default, and MS Project's behaviour) makes remaining work wait for unfinished predecessors, and MS Project then splits the task. `'progress-override'` ignores them.
  - **Constraints:** once a task has started, start constraints stop applying; finish constraints (FNLT, MFO, FNET) still do, so a late task shows negative float against its contractual finish.
  - **Manual-mode tasks** keep their own dates, as in MS Project. Only their `status` is reported. This is deliberate. Re-forecasting manual tasks would be a future opt-in.
  - **New `computed` fields:** `status`, `remainingStart` and `outOfSequence`. `outOfSequence` covers an FS predecessor not yet finished or an SS one not yet started. In-progress float is finish float.
  - **Driving paths and `checkSchedule`** use the same progress model: remaining start and remaining duration.
  - **MSPDI:** `StatusDate`, `ActualStart`, `ActualFinish` and `RemainingDuration` round-trip, and MPXJ accepts them.
  - **`checkSchedule()`:** uses `project.statusDate` by default.

  **No status date, no change.** Output is byte-identical to the previous release. A main-vs-branch differential over 1,502 random projects showed 0 differences, including projects carrying progress and actuals but no status date. The tool is at `docs/superpowers/tools/schedule-differential.ts`.

- 65386be: Task Path highlight, MS Project's "why is this task late?" view:
  - **`@pyraxi/gantt`:** new `taskPath` prop (`'driving' | 'driven' | 'both'`, default off). It highlights the selected task's driving predecessors (orange) and the successors it drives (purple), with their driving links.
    - `taskPathFor` lets a host panel choose the task instead of the selection.
    - Colours: `--cg-path-driving-color` / `--cg-path-driven-color`.
    - Bars get a scoped stylesheet; path links are painted inline. Selecting a task never re-maps rows or re-parses links: about 100 ms a click at 5k tasks.
  - **`@pyraxi/cpm-engine`:** `DrivingAnalysis.drivenPath(id)` and `getDrivenPath(project, id)` return the task's driven successors. It's the mirror of `drivingPath` over the same driving links.
- 5b8e26d: WBS, activity codes, grouping and filtering:

  - **`computeWbs(project)`:** outline numbers (`1.2.3`) from the hierarchy.
  - **Activity codes:** `Project.codeTypes` (with values, descriptions and colours) and `Task.codes`. These are metadata like P6 activity codes or MS Project outline codes; the scheduler ignores them.
  - **`groupProject(project, by)`:** a display copy regrouped under one virtual summary row per code value (or per the result of any function), for viewing a programme by trade, area or subcontractor.
    - Group rows carry a typed `Task.group` marker, so a UI can treat them as read-only.
    - They span their members' dates, so a pre-scheduled view draws them.
    - A group id that collides with a task id throws a clear error.
  - **`filterProject(project, predicate)`:** matching task ids plus their ancestors, ready for `visibleTaskIds`.

  Also exports the types `CodeType`, `CodeValue` and `GroupProjectOptions`.

- 1ea1ebf: `workingMinutesPerDay(calendar)` is exported: the working minutes in a calendar's first working weekday (its standard day; 480 when it has none), for converting days to minutes. Inverted or zero-length intervals count as no time.

### Patch Changes

- 39ced11: Fix: total float could be overstated when linked tasks use different calendars, for example a Mon–Fri task feeding a 24-hour or elapsed one. Slipping such a task by its reported float could still delay the project, and that could hide negative float.
  - **Cause:** a working-time boundary (Fri 17:00 ≡ Mon 08:00) that the other calendar doesn't share.
  - **Fixes:**
    - A latest start handed across calendars is now a start the forward pass can actually produce.
    - A lead counted back in the successor's lag calendar now resolves to the earliest equivalent moment.
  - **Verified:** float across calendars is now exact. Over 90,000 fuzz checks with std, split-shift, 24h and elapsed tasks, every link type, leads and elapsed lags, slipping any task by its float never moves the project finish, and an hour more always does.
  - **Reading the claim:** float is exact in each task's own calendar.
  - **Leads into elapsed tasks:** an elapsed (24/7) successor driven by a lead can now start at the earliest equivalent moment. That's the previous working day's end rather than the next day's start: a deliberate convention, not yet checked against MS Project.
  - **Interval-end starts:** a task whose start sits exactly on an interval end (a manual or SNET start at 17:00) feeding another calendar reports −1 min of float. It's still critical.
  - Single-calendar projects schedule exactly as before: a 1,502-project main-vs-branch differential showed 0 differences.
- 856d87a: A work interval that starts inside a skipped daylight-saving hour now counts as no time. In zones that spring forward at midnight (e.g. Chile), an interval such as 00:22–01:13 on the change-over day was built with its end before its start, so `workingMinutesBetween` subtracted minutes and could disagree with the slack counter. NZ, Australian, EU and US zones change at 02:00 or later and weren't affected by ordinary calendars.
- 693c350: Milestones sit where MS Project puts them, checked against MS Project desktop (runs 7 and 9) and five real programmes (562/562 tasks to the minute):

  - **At the predecessor's finish:** a milestone FS after a task finishing Fri 17:00 is at Fri 17:00, not Mon 08:00. Across a shutdown, it used to show weeks late.
  - **Never snapped to working time.** After an elapsed lag that ends on Saturday 03:00, or on a Saturday SNET or project start, it stays there.
  - **`combineProjects`** keeps a part's milestones on that part's start as it is, as `schedule()` does. An unstarted milestone floored by a status date still sits at a working moment.
  - **An FF or SF lead** that lands on a morning puts it at the end of the previous day (Tue 17:00 − 1d gives Mon 17:00). An FS or SS lead still lands on the next morning.

  Float and successors are unchanged, because the moments are equivalent in working time. A milestone's dates, and those of a summary that ends on one, move earlier or stay; they never move later. Its late dates aren't snapped either.

- f741e3e: MSPDI import skips MS Project's blank rows. A blank row has `IsNull` set and no name or outline level. It used to be read as a top-level task, which detached every later task from its summary. It's now reported in `droppedFields`.
- 019f5e5: **MSPDI export opens correctly in MS Project desktop.** It was checked in Project Professional 2609.

  - **The 0-day bug:** without `<RemainingDuration>`, MS Project's importer turned every task that starts at the project start with no predecessor into a "0 days?" milestone. `serializeMspdi` now writes `RemainingDuration` on every task: the whole duration when not started, 0 when complete, and when in progress the remaining work `schedule()` uses (Expected Finish forecast, `remainingDuration`, or the % complete's share).
  - **Not estimates:** every task also writes `Estimated` 0 (imported tasks were marked estimated, shown as `?`). `DurationFormat` is 7 (days), or 8 for elapsed durations.
  - **Project calendar:** the project root writes `ScheduleFromStart` 1, the project calendar's `CalendarUID`, its `DefaultStartTime` / `DefaultFinishTime`, and `MinutesPerDay` / `MinutesPerWeek` from that calendar (a derived calendar is resolved through its base). Before, MS Project assumed an 8-hour day, so 27 hours on a 9-hour calendar showed as 3.38 days.
  - **Ignore resource calendars:** a task with `ignoreResourceCalendar` and no `calendarId` now writes the default calendar as its task calendar. MS Project honours "ignore resource calendars" only on a task with its own calendar. On re-import the task carries that `calendarId`, and its dates are the same.
  - **Import:** `parseMspdi` takes the project's default calendar from the root `<CalendarUID>` when it names a parsed calendar. Before, it guessed the first base calendar. An in-progress task's `RemainingDuration` is kept only when it differs from the % complete's share, so a round trip doesn't pin the remaining work against later % edits.

- ae39a94: MSPDI export opens correctly in MS Project desktop, part 2 (desktop check run 2):

  - A started task writes `ActualDuration`. Without it, MS Project took the remaining work as the whole duration. For a complete task it's the working time between the actual dates.
  - An in-progress task whose remaining work doesn't follow straight on (held by a predecessor, or forecast from the status date) writes `Stop` / `Resume` at the split (wall-clock for elapsed durations; not for summaries or manual tasks).
  - Assignments write `Start`, `Finish`, `Work` and `RemainingWork` (plus `ActualStart` / `ActualWork` once started). An assignment with non-finite units is dropped and reported. With `Units` alone, MS Project imported the task as a 0-day milestone at 0%.
  - Import skips MS Project's nameless UID 0 placeholder resource, which is in every file it saves.

- 88e06bc: MSPDI export names a derived calendar used by exactly one resource after that resource. MS Project treats it as that resource's calendar, and lists it as "Unassigned" without the name.
- d5cda2a: MSPDI export: MS Project now keeps the progress the file says, including the gap in a split, instead of rebuilding it. Checked in MS Project desktop (runs 5–8).

  - **The project header writes `<ProjectExternallyEdited>0</ProjectExternallyEdited>`,** as MS Project's own saves do. Without it, MS Project treats the file as edited externally and rebuilds in-progress work from the status date. A split then lost its actual work and its gap, and showed 3 of 5 days.
  - **A split task writes `<ResumeValid>1</ResumeValid>`.** Without it, MS Project closes the gap.
  - **The split is also written as per-day timephased work** on the task's assignments: actual work up to `Stop`, remaining work from `Resume`, and no entry for the gap. A task with no resource gets MS Project's placeholder assignment (`ResourceUID -65535`), which import skips.
  - **A manual task writes `ManualStart`/`ManualFinish`/`ManualDuration`,** as MS Project's own saves do. With the header flag set, MS Project schedules a manual task by them. Its remaining work is the share that fits its kept dates.
  - **A started task's `Duration` is `ActualDuration + RemainingDuration`**, and its % complete is actual ÷ duration, the way MS Project holds them.
    - A task finished early or late shows its actual duration at 100%. Before, a task done in 3 of 5 planned days showed 60% and ran on to the planned finish.
    - An in-progress task with a host `remainingDuration` gets a longer duration and a lower % complete.
    - The planned duration survives only in a baseline: export→import now gives a started task its actual (or forecast) duration, so set a baseline first to keep the plan.
  - **`PercentComplete` is a whole number** (xsd:integer), computed from the actual minutes as MS Project does. An in-progress task never rounds to 100, or (with no actual start) to 0.
  - **Import reads progress as the exact actual ÷ duration** when a file holds `Duration = ActualDuration + RemainingDuration`, so the remaining work doesn't drift by the whole-percent rounding on each round trip. A started task's `progress` can now be fractional after import.

  Known limits:

  - An `unscheduled` task (written as `IsNull 1`) is dropped by MS Project as a blank row. This is a pre-existing issue, to be followed up.
  - MS Project can't round-trip an elapsed-duration split through XML, not even from its own save. The dates and the gap come through, but it shows the elapsed duration including the gap.

- 6ec4b40: MSPDI: an `unscheduled` task (ADR-007) now opens in MS Project, with its duration, and survives MS Project's own save. Before, it was written as `IsNull 1`, which MS Project reads as a null row, so it dropped the task. All of this was checked in MS Project desktop (runs 10 and 11).
  - **Export:** an unscheduled task is written as a manual, estimated task, with "TBD" as its start and finish text, plus its duration. Nothing is dated: no Start, Finish, actuals or split.
    - **In MS Project:** the task shows "TBD" for its start and finish and its duration as an estimate (`2 days?`). Its bar sits at the project start, because MS Project can't hold a task with no dates.
    - **Its assignments:** keep their units and work, but carry no dates or timephased work.
    - **Reported in `droppedFields`:** any progress, and an auto mode (it's written as manual).
    - **Links to or from it are written,** so the logic survives a round trip. MS Project schedules them from the placeholder bar, though, so an auto successor can open later there than in `schedule()`, which leaves those links inert until the task is scheduled.
  - **Import:**
    - A manual task with text for both its start and its finish is read as unscheduled, with its duration. That covers our files and MS Project's saves of them, which add placeholder dates but keep the text.
    - Also read as unscheduled: a manual task with no dates at all, and a named `IsNull` task from older files.
    - Text on only one date of a dated task is reported in `droppedFields`. The empty text fields MS Project writes on every task aren't.
    - Through `@pyraxi/gantt-mpp` (MPXJ), a manual `.mpp` task whose dates were left blank now imports as unscheduled, in the grid only, instead of at the project start.
  - **Summaries, elapsed and 0-day tasks** (MS Project desktop, run 12):
    - An elapsed duration shows as `2 edays?`.
    - A 0-day task writes its 0, and shows as `0 days?`. Otherwise MS Project gives it a 1-day placeholder, and makes it a milestone as it does any 0-day task.
    - An unscheduled summary is kept as a "TBD" summary. That was checked with no duration of its own; one with its own duration hasn't been checked.
    - A scheduled summary over an unscheduled task rolls up the task's placeholder in MS Project, so it can run longer there than in `schedule()`, which leaves the task out.
- 9062ac0: `schedule()`: a Start No Earlier Than constraint on a summary task now applies to every task under it, as in MS Project. It used to be ignored, so a programme anchored by its summary's SNET scheduled from the project start date instead.
- e8dc42f: Built-in WBS column.

  - `wbsColumn(tasks, { header?, width?, code? })` shows MS Project's WBS / outline number (`1`, `1.2`, `1.2.3`) from the parent / child structure.
  - `code(task)` returns a host-owned code (`task.codes`, or a host field such as `extra.wbsCode`), which wins where it's non-empty. An empty code falls back to the outline number, as in MS Project.
  - Group rows are always blank. For a `groupProject` view, pass the source project's tasks so members keep their real numbers. Phantom rows are blank too.
  - Custom render columns now see `task.codes` (it's carried on SVAR rows, like `extra`).
  - Engine: `computeWbs` accepts any `{ tasks }` (it only ever read the tasks).

## 1.2.5

### Patch Changes

- 537c686: The link-cycle error from `schedule()` / `topologicalSort()` now names every loop's tasks, e.g. `Link graph contains a cycle; topological sort is not possible — loops: [A1 → A2 → A1], [B1 → B2 → B1]`. A self-link shows as `[a → a]`. The message still starts with the old text, so code matching on it keeps working.
- cb2d34f: **`CreateLinkCommand` now refuses a second link between the same two tasks** in the same direction, whatever its type, throwing `EditError` ("a link from a to b already exists"). Only one link per ordered pair is allowed, as in MS Project. To change an existing link's type or lag, use `UpdateLinkCommand`. Creating a link with an id that's already used still reports `duplicate link id`.
- 537c686: **`schedule()` now throws on duplicate task ids**, naming them (`schedule(): duplicate task id "a"`), before scheduling anything. Before, a duplicated id silently gave every row with that id the same dates, or was misreported as a link cycle. `topologicalSort()` throws the same way (`topologicalSort(): duplicate task id "a"`). If you build projects from external data, de-duplicate ids first.
- 537c686: **Free float values change.** A task with no successors (or whose successors are all unscheduled) now gets free float up to the project's early finish, never more than its total slack. Before, it was reported as `0`. This matches MS Project and P6. Tasks with constraining successors are unchanged.

  `schedule()` measures long total and free float spans (60 days or more) with one cached working-time counter instead of walking day by day for each task. The values are the same; 5,000 unlinked 1–10-day tasks beside one 250-day task schedule in ~0.4 s on the test machine. `workingMinutesBetween` (and so `totalSlack` / `freeSlack`) now returns `0` instead of `-0` for a backward span with no working time in it, for example on a milestone at the end of a working day.

- 92f7009: A calendar work interval whose end is at or before its start (inverted or zero-length) now counts as no working time everywhere working time is read. Before, it added negative time, so durations across such a day came out too long, and a default calendar made only of them made `schedule()` hang. Such a default calendar now throws the same "no working time" error as an empty one. The grid's minutes-per-day ignores these intervals too. `serializeMspdi` no longer writes these intervals, and a week day or working exception made only of them is written as non-working.

  MSPDI import now reads a `ToTime` of `00:00:00` as the end of the day (minute 1440), as MS Project and MPXJ do. MS Project's "24 Hours" calendar (`00:00:00` to `00:00:00`) was otherwise read as zero-length, so it had no working time. `serializeMspdi` writes an interval ending at 1440 as `00:00:00`, so it round-trips.

- f707d03: `schedule()` indexes links by endpoint once instead of scanning the full link list per task. Large schedules no longer scale quadratically: 5,000 tasks now take ~200 ms on a 2 GHz Xeon, down from ~1.7 s. Output is unchanged.

## 1.2.4

### Patch Changes

- b780b41: Fix an over-correction in the 1.2.3 MSPDI recurrence guard (Codex cross-model review).

  The recurrence guard added in 1.2.3 keyed on the mere _presence_ of a recurrence pattern element (`<Period>`/`<DaysOfWeek>`/`<MonthItem>`/`<MonthDay>`) to skip an `<Exception>`. But MS Project writes those pattern fields with **default values on one-off exceptions too**, so a legitimate non-recurring shutdown (e.g. a Christmas break `24 Dec – 5 Jan` with `Occurrences=1, Type=1, Period=1`) was wrongly skipped — silently dropping a real holiday and letting the schedule ignore the break. The guard now keys only on `Occurrences > 1` (the sole reliable multi-occurrence signal); one-off exceptions expand as intended, and the multi-occurrence recurring case is still skipped + reported. (Date-bounded recurrence is not distinguishable from a one-off by fields and is left to expand, bounded by the day cap.)

## 1.2.3

### Patch Changes

- ccd37a4: Fixes from the Fable pre-publish review of the 1.7.1 diff (caught before npm).

  **Engine (`@pyraxi/cpm-engine`)**

  - **Recurring MSPDI `<Exception>` no longer darkens its whole span.** The 1.2.2 modern-`<Exceptions>` parser took a recurring exception's `TimePeriod` literally — a yearly holiday (`Occurrences` > 1, `FromDate` first-occurrence → `ToDate` last-occurrence) expanded to ~400 consecutive non-working days. Recurring exceptions (detected via `Occurrences` > 1 or a recurrence pattern element) are now skipped + reported via `droppedFields` instead of mis-expanded; single-span exceptions expand as before.
  - **`<OutlineLevel>` overflow crash closed.** The 1.2.2 guard caught non-numeric values but a finite value ≥ 2³² (e.g. `5000000000`) still threw `RangeError: Invalid array length`. Valid levels are now bounded to ≤ 255; anything else degrades to top-level + reports.
  - Calendar exception parsing also now reports a reversed `FromDate..ToDate` range, reports the raw XML text (not `"Invalid Date"`) on an unparseable `FromDate`, and gives each expanded day its own `intervals` array.

  **Core (`@pyraxi/gantt`)**

  - `resolveDirectEdit` / `resolveEditRequest` liveness checks use `!= null`, so a loosely-typed consumer passing an explicit `onTaskEdit={null}` / `onTaskEditRequest={null}` doesn't reintroduce the F3 silent-no-op.

  **Release note (behavior change from 1.2.2, applies here):** MSPDI import now honors `<Manual>` → `scheduleMode: 'manual'`. Because MS Project 2013+ defaults new tasks to _Manually Scheduled_, real `.mpp`/MSPDI files that previously imported as all-auto (and were CPM-rescheduled) will now pin those tasks to their stored dates. This is correct MS-Project semantics, but consumers relying on the old always-reschedule behavior on import should be aware.

## 1.2.2

### Patch Changes

- 7f15236: Correctness fixes from the 2026-07-08 project review (P1 tranche + one verified P2).

  **Core (`@pyraxi/gantt`)**

  - **`update-task` falls through to SVAR when `onTaskEdit` is unwired (F3).** In `editMode` (e.g. `preset="msproject"`) with `onStructuralCommit` wired but not `onTaskEdit`, an Editor/field edit was silently vetoed into a dead no-op instead of falling through to SVAR's native handling — breaking the same rule the structural intercepts follow. The direct-edit decision is now a pure `resolveDirectEdit` helper.

  **Engine (`@pyraxi/cpm-engine`)**

  - **`ReparentTaskCommand.inverse` restores promoted/demoted task types (F12).** Indent→undo left a phantom `summary`; outdent→undo left a stuck `task` — violating the `inverse(apply(P))=P` contract on the two commands the MS-Project preset fires most (and persisting a phantom `type` downstream via `onStructuralCommit`). Now snapshots + restores parent types like `MoveTaskToCommand`.
  - **MSPDI malformed-input guards (F-1/F-2/F-11).** Non-numeric `<OutlineLevel>` no longer crashes parse with `RangeError`; a partial `<Baseline>` without Start/Finish no longer re-serializes as `NaN-NaN-NaN`; a garbage `<ConstraintDate>` is dropped instead of stored as an inert Invalid Date. All three now degrade gracefully and report via `droppedFields`.
  - **MSPDI round-trips manual scheduleMode + per-task calendarId (F-3).** A round-trip no longer silently flips manually-scheduled tasks to `auto` (which caused the engine to reschedule pinned tasks) or drops calendar overrides — `<Manual>` and per-task `<CalendarUID>` are now emitted and parsed.
  - **MSPDI parses modern `<Exceptions>` and expands multi-day exceptions (F-4).** A legacy multi-day exception (e.g. the NZ Christmas shutdown, 24 Dec–5 Jan) no longer collapses to a single non-working day, and modern (Project 2007+) `<Exceptions><Exception>` holidays are now parsed instead of silently dropped — both had caused CPM dates to diverge from MS Project.
  - **Westland Anniversary date rule corrected (P2).** Now the Monday **nearest** 1 December (per employment.govt.nz), not the first Monday of December — fixes wrong dates in 2022/2026/2027 for West Coast calendars.

## 1.2.1

### Patch Changes

- 5224603: Correctness fixes from the 2026-07-08 project review (engine):

  - **Stale `computed` no longer survives re-scheduling.** Re-running `schedule()` on prior output and marking a task `unscheduled` now strips its old `computed` (dates/slack/criticality) instead of returning it verbatim. Matches ADR-007 ("unscheduled → no computed") on the edit round-trip a consumer actually runs, and stops phantom critical-path rows.
  - **Negative (lead) lag no longer fabricates negative slack / false criticality.** The backward pass and free-slack now use a sign-aware `subtractWorkingTime` (mirror of `addWorkingTime`) for every `link.lag` subtraction across all four link types (FS/SS/FF/SF), instead of the raw `subtractWorkingMinutes` that silently no-ops on negative input. A feasible lead-lag network (e.g. "start cladding 2 days before framing completes") reported phantom negative slack before; it now reports the correct value.
  - **`moveTaskTo` rejects hierarchy cycles.** Moving a task under itself or one of its own descendants now throws `EditError` instead of persisting a parent cycle — important because this command is the ADR-010 drag-reorder bridge target.
