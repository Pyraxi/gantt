# @pyraxi/cpm-engine

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
