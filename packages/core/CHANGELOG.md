# construction-gantt

## 1.7.4

### Patch Changes

- ca84c4b: Fix a crash when a project contains a `summary` task with no children — the
  state of a freshly-templated schedule whose phase spine is seeded as all-summary
  rows before any child task is added.

  SVAR's tree-walker recurses into a node's children whenever `open === true`, but
  a childless summary never has its children array initialised (SVAR only creates
  it on a node that is named as some other task's `parent`), so it stays `null`.
  The adapter set `open: true` on **every** summary → SVAR called `.forEach` on the
  `null` child collection → `TypeError` that took down the whole schedule page into
  the app error boundary. `buildSvarTasks` now marks a summary `open` only when it
  actually has children in the rendered set; a childless summary renders as an
  empty leaf bar instead of crashing. Affects the default renderer, so every user
  of a summary-only schedule was hitting it.

## 1.7.3

### Patch Changes

- b780b41: Fix an over-correction in the 1.2.3 MSPDI recurrence guard (Codex cross-model review).

  The recurrence guard added in 1.2.3 keyed on the mere _presence_ of a recurrence pattern element (`<Period>`/`<DaysOfWeek>`/`<MonthItem>`/`<MonthDay>`) to skip an `<Exception>`. But MS Project writes those pattern fields with **default values on one-off exceptions too**, so a legitimate non-recurring shutdown (e.g. a Christmas break `24 Dec – 5 Jan` with `Occurrences=1, Type=1, Period=1`) was wrongly skipped — silently dropping a real holiday and letting the schedule ignore the break. The guard now keys only on `Occurrences > 1` (the sole reliable multi-occurrence signal); one-off exceptions expand as intended, and the multi-occurrence recurring case is still skipped + reported. (Date-bounded recurrence is not distinguishable from a one-off by fields and is left to expand, bounded by the day cap.)

- Updated dependencies [b780b41]
  - @pyraxi/cpm-engine@1.2.4

## 1.7.2

### Patch Changes

- ccd37a4: Fixes from the Fable pre-publish review of the 1.7.1 diff (caught before npm).

  **Engine (`@pyraxi/cpm-engine`)**

  - **Recurring MSPDI `<Exception>` no longer darkens its whole span.** The 1.2.2 modern-`<Exceptions>` parser took a recurring exception's `TimePeriod` literally — a yearly holiday (`Occurrences` > 1, `FromDate` first-occurrence → `ToDate` last-occurrence) expanded to ~400 consecutive non-working days. Recurring exceptions (detected via `Occurrences` > 1 or a recurrence pattern element) are now skipped + reported via `droppedFields` instead of mis-expanded; single-span exceptions expand as before.
  - **`<OutlineLevel>` overflow crash closed.** The 1.2.2 guard caught non-numeric values but a finite value ≥ 2³² (e.g. `5000000000`) still threw `RangeError: Invalid array length`. Valid levels are now bounded to ≤ 255; anything else degrades to top-level + reports.
  - Calendar exception parsing also now reports a reversed `FromDate..ToDate` range, reports the raw XML text (not `"Invalid Date"`) on an unparseable `FromDate`, and gives each expanded day its own `intervals` array.

  **Core (`@pyraxi/gantt`)**

  - `resolveDirectEdit` / `resolveEditRequest` liveness checks use `!= null`, so a loosely-typed consumer passing an explicit `onTaskEdit={null}` / `onTaskEditRequest={null}` doesn't reintroduce the F3 silent-no-op.

  **Release note (behavior change from 1.2.2, applies here):** MSPDI import now honors `<Manual>` → `scheduleMode: 'manual'`. Because MS Project 2013+ defaults new tasks to _Manually Scheduled_, real `.mpp`/MSPDI files that previously imported as all-auto (and were CPM-rescheduled) will now pin those tasks to their stored dates. This is correct MS-Project semantics, but consumers relying on the old always-reschedule behavior on import should be aware.

- Updated dependencies [ccd37a4]
  - @pyraxi/cpm-engine@1.2.3

## 1.7.1

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

- Updated dependencies [7f15236]
  - @pyraxi/cpm-engine@1.2.2

## 1.7.0

### Minor Changes

- 2ba70aa: MS-Project-parity ID column + predecessor row-references (per Rips's MSP screenshot).

  - **`idColumn(tasks)`** — a new built-in column showing the 1-based row number (MS Project's `#` column). Note: numbers follow the flat `tasks[]` array order; when the array isn't stored in DFS display order they won't line up with the visual tree rows.
  - **`formatPredecessors` now accepts `opts.tasks` and `opts.minutesPerDay`** to render predecessors MS-Project-style — by **row number** instead of raw task id, with lag in **days** (e.g. `3`, `1FS+3 days`, `2FS-1 day`; FS is shown only when there's a lag, per MSP convention). The built-in `predecessorsColumn` wires `tasks` + `calendar` so it's MSP-style by default.
  - `workingMinutesPerDay` is exported for the day-lag conversion.

  **Behavior note:** with no `opts`, `formatPredecessors` still emits raw ids, but an FS link _with_ a lag now renders as `<id>FS+<lag>` (previously `<id>+<lag>`) — the zero-lag FS case is unchanged. The MSP row-ref rendering is opt-in via the built-in column / passing `opts`.

## 1.6.1

### Patch Changes

- 5224603: Correctness fixes from the 2026-07-08 project review (core adapter + editing bridge):

  - **Inline duration-cell unit corruption fixed.** SVAR grid rows carry `duration` in working **days**; that value was fed straight into the working-**minutes** formatter, so a 3-day task displayed "3m" and a click-in/blur committed `duration: 3` _minutes_ (~480× data loss). The editable duration cell now converts days→minutes for display/seed (threading the calendar's working-minutes-per-day), and `commitCell` gained an unchanged-value guard so an untouched cell is a no-op instead of a lossy re-commit.
  - **Phantom baseline / edit-preview rows can no longer reach the event or structural bridges.** A Move/Indent gesture on a ghost row used to throw an uncaught `EditError` inside SVAR's dispatch, and "add child" on a ghost silently created a top-level task. Phantom ids are now vetoed once at the intercept entry (`select-task` / `show-editor` / `update-task` / the structural loop), and `buildStructuralCommit` swallows `EditError` (defence-in-depth against id drift) so a bad id can never crash a gesture.
  - **Drag-reorder lands in the correct slot on mixed null/undefined parents.** `resolveReorder` now groups siblings with the same strict `parent === newParent` predicate `moveTaskTo` uses (mirroring the earlier `resolveAdd` fix), so a "drop before" on a project mixing a null-parent sentinel (CM's persisted shape) with `undefined` no longer mis-slots and emits a wrong `orderIndex`.

- 574d1a5: Security: clear the export deps' advisories (P0 #7 from the 2026-07-08 review).

  - **jspdf `2.5.2` → `4.2.1`.** Clears 2 critical advisories (CVE-2025-68428 path-traversal, CVE-2026-31938 new-window HTML-injection). We only call `new jsPDF`, `addImage`, and `output('blob')` — none of the vulnerable paths — so this is a drop-in bump with no source changes.
  - **Replaced SheetJS `xlsx` `0.18.5` with `exceljs` `^4.4.0`.** The `xlsx` npm distribution is frozen at 0.18.5 and carries two unpatched parse-path advisories (the fixes ship only from SheetJS's CDN). Our `.xlsx` export is write-only, so the advisories were never reachable, but pinning a CDN tarball is an install-fragility footgun for consumers. ExcelJS (MIT, actively maintained) is now the writer. **New transitive shipped dependency** for `@pyraxi/gantt`; the `@pyraxi/gantt/export` subpath stays lazy-loaded so it's only pulled in by consumers that use the exports. The public export API (`exportXLSX`, `buildSheetRows`, `DEFAULT_XLSX_COLUMNS`, column types) is unchanged.

- Updated dependencies [5224603]
  - @pyraxi/cpm-engine@1.2.1

## 1.6.0

### Minor Changes

- d86aefe: Buildertrend-parity bar affordances:

  - **Built-in hover tooltip.** Hovering a bar now shows a default tooltip (title · date range · working days · % / status · assignee-if-present · critical / past-deadline flags) — **behavior change**: consumers who previously omitted the `tooltip` prop got no tooltip and now get this default. The `tooltip` prop becomes `((task) => ReactNode) | false`: a function still overrides the default (and its `Task` now carries `extra` + `deadline`); pass `tooltip={false}` to disable. `task.extra` is threaded through so tooltips can show host-app fields (assignee/trade) the engine doesn't model.
  - **Label overflow beside the bar.** In `editMode`, a bar label that doesn't fit now spills beside the bar (matching SVAR's native read-only rendering and Buildertrend) instead of clipping with an ellipsis. Measured via ResizeObserver so it re-evaluates on zoom/resize without per-render reflow.

## 1.5.0

### Minor Changes

- 2e50b68: Three schedule-UX additions from CM live feedback (all additive):

  - **`onTaskEditRequest(id)`** — SVAR's built-in "Edit" context-menu item and task double-click both open SVAR's Editor modal. When this callback is wired, the package vetoes that modal and hands you the id, so you can route the native Edit gesture to your own (persisted) editor without re-declaring the context menu. Independent of `editMode` / the `editor` prop.
  - **`boldSummaryRows`** (default `true`) — bolds summary task grid rows (MS-Project / P6 convention). Set `false` to opt out. Styling-only; applies in every mode.
  - **`GanttColumn.editor` + `onCellEdit(id, columnId, value)`** — inline editing for **custom** (non-engine) columns. A column with `editor: { type: 'text' | 'select', options?, getValue }` becomes click-to-edit in `editMode`; commits fire `onCellEdit` (a parallel path to `onTaskEdit`) so consumers persist host-app fields (trade/sub/state) the engine doesn't model. New exported type `GanttColumnEditor`.

## 1.4.1

### Patch Changes

- Add a client-free `@pyraxi/gantt/version` subpath export. The `VERSION` constant added in 1.4.0 was only reachable from the main entry (`.`), which drags the client-only bundle (`@svar-ui` + CSS, `jspdf`, `xlsx`) into the module graph — so importing it from a React Server Component / server build broke `next build` (Turbopack). `import { VERSION } from '@pyraxi/gantt/version'` resolves a zero-import leaf module that's safe to import server-side. The main entry still re-exports `VERSION` for client-side convenience. A test guards the leaf against ever gaining an import.

## 1.4.0

### Minor Changes

- d707497: Add `onTaskSelect(id)` (bridges SVAR's native task selection) and `GanttColumn.editable` (inline-edit a
  column that also has a custom `render`, flowing through `onTaskEdit` + live CPM preview). Together these
  let consumers drop bespoke edit-button-column + read-only-cell workarounds. Additive; existing behavior
  unchanged.
- 8df5616: Add `baselineRender: 'inline' | 'row'` (default `'row'`). `'inline'` renders the first baseline as a
  thin same-row underlay bar under the live bar (MS-Project / SVAR-PRO convention) instead of a separate
  phantom row that doubles each task's height. Additional baselines still render as rows. Additive; opt-in.
- 4571ee3: Export `VERSION` constant. Consumers read the installed package version via
  `import { VERSION } from '@pyraxi/gantt'` instead of walking the filesystem to parse `package.json` (the
  `exports` map only exposes `.` and `./export`). Kept in sync with `package.json` by a build-time test guard.
- 4571ee3: Position-aware native add. A SVAR "Add task" gesture now lands where SVAR's own reducer intends
  instead of collapsing to a flat top-level append: **Child task** nests under the target; **Task below**
  (`after`) inserts as a **sibling** of the target — same parent, positioned just below — instead of dropping
  to top-level; **Task above** (`before`) inserts as a sibling positioned just above the target, now distinct
  from "below" (previously both collapsed to the same slot). Both the `onStructuralCommit` path (exact
  placement, incl. prepend at index 0) and the thin `onTaskAdd` callback honor the resolved parent/position.

### Patch Changes

- 4571ee3: Fix axis-scale blow-out on the live inline-edit preview (the CM "vetoed-add" report). The
  edit-preview phantom forwarded its duration in engine working-**minutes** instead of SVAR working-**days** —
  the one duration path that hadn't been converted after the baseline-ghost axis-latch fix. Editing a task's
  (or a freshly-added task's) start/duration produced a preview bar SVAR read as thousands of day-units,
  auto-scaling the header ~40 years out; SVAR's expand-only axis bound then latched it until reload.
  `makeEditPreviewPhantom` now converts min→days like `toSvarTask` and `makeBaselinePhantom`, closing the last
  unconverted-duration path.

## 1.3.0

### Minor Changes

- 689234c: Add the bolt-in `onStructuralCommit` callback (ADR-010). When wired it becomes the single path for
  every structural gesture — add, delete, row drag-to-reorder (now bridged), indent/outdent — and takes
  precedence over the individual `onTask*` callbacks. The package applies the matching engine command,
  re-runs `schedule()`, and emits `StructuralChange[]` (every affected task's full post-op state: `id`,
  `parent`, `orderIndex`, `type`, `op`) plus the scheduled `nextProject`, so a persistence-only consumer
  mirrors it mechanically without re-deriving engine semantics. Deletes are `op:'delete'` tombstones; all
  resequenced siblings are emitted. New exported helper `svarPartialToTask` maps a SVAR add-task partial
  to a full engine `Task`. See `docs/persistence-contract.md`.

## 1.0.2

### Patch Changes

- **Fix: toolbar (and Editor / ContextMenu) rendered unstyled — items stacked vertically and
  ballooned the header.** SVAR ships CSS per component; we imported only
  `@svar-ui/react-gantt/style.css` (the gantt core), which omits the chrome packages' styles —
  including the toolbar's `display:flex`. Switched to `@svar-ui/react-gantt/all.css`, which bundles
  the Toolbar / Editor / Menu styles alongside the gantt core, so the chrome components we expose lay
  out correctly. No API change.

## 1.0.1

### Patch Changes

- **Default render now uses SVAR's native Willow bars.** The custom bar template
  (in-bar white label, hand-drawn progress fill, inline pills) re-implemented what
  SVAR renders natively and produced a heavy look. The default read-only path now
  renders SVAR's clean native bars (label beside the bar, native two-tone progress).
  Engine signals are layered on top instead of repainting: the **critical path** and
  **deadline overruns** are styled by overriding SVAR's own theme tokens on the
  affected bars (keyed on SVAR's `data-id`, scoped per Gantt instance), so the native
  two-tone survives. Edit-mode and baseline-ghost overlays keep their richer template
  rendering. No public API change; engine (`@pyraxi/cpm-engine`) unchanged at 1.0.0.

## Unreleased

### Minor Changes

- **Partial-day calendar shading** — at hour zoom, hours outside a calendar's working intervals (before/after a 7am–3pm shift, lunch-break gaps in split shifts) now render with the `construction-gantt-non-working` shading, matching the existing whole-day weekend/holiday shading. New exported `isWorkingTime(date, calendar)` helper. Display-only; no authoring UI.

- **Deadline markers** — new optional `Task.deadline?: Date`, an indicative contractual / sectional-completion date (NZS 3910). Non-scheduling: it never moves the task or affects the critical path (distinct from a `FNLT` constraint). `schedule()` annotates `TaskComputed.deadlineMissed` + `deadlineSlackMinutes` (signed working-minutes; negative = overrun). Rendered as an in-bar pill — amber `⚑ deadline` when met, red `Nd over deadline` + a `construction-gantt-deadline-missed` bar outline when the computed finish slips past it. Round-trips through MS Project MSPDI `<Deadline>` on parse and serialize.

### Breaking Changes

- **`SpikeGantt` removed from the public API.** It was the ADR-002 confirmation spike — a propless, hardcoded demo that rendered SVAR's raw Gantt directly (bypassing the engine), never a consumer capability. It now lives in the playground as a Storybook slot-composition example. If you imported `SpikeGantt` from `construction-gantt`, it is gone; use the documented `Gantt` component.

## 0.5.0

### Minor Changes

- **BREAKING (CSS):** all engine-signal classes now use a single `construction-gantt-*` prefix for a consistent public surface — `construction-gantt-baseline-ghost`, `construction-gantt-baseline-${N}` (indices 0–10), `construction-gantt-edit-preview`. If you override baseline ghost-row colours, update your selectors to the `construction-gantt-` prefix.

- **`Task.extra` consumer carry-through bag** — new optional `extra?: Record<string, unknown>` on `Task`. An opaque bag for host-app fields the engine doesn't model (e.g. progress actuals, WBS codes, owner/resource ids). Carried untouched through `schedule()` and the edit pipeline (including undo/redo); on MSPDI serialize, keys with no MSPDI home are reported in `droppedFields` (`lossy-on-roundtrip`) rather than silently dropped. The engine never reads or writes its contents.

- **MS Project mixed-unit duration column** — the grid duration column accepts and renders MS Project-style mixed units (`1d`, `4h`, `30m`, `1w`, `1mo`).

### Patch Changes

- **Fix: native bar drag/resize now flows through the edit pipeline.** Dragging or resizing a bar previously mutated only the renderer's internal store — the engine never re-ran (FS successors didn't cascade) and the change never reached the dirty/commit pipeline (undo/redo/commit stayed disabled). Bar edits now route through `onTaskEdit`, keeping the engine the single source of truth.

## 0.4.0

### Minor Changes

- ## v0.4 — SVAR PRO parity, split/unscheduled tasks, UX chrome, native theme passthrough

  ### Renderer (ADR-008) — extend SVAR's theme, never paint over it

  - Output is now wrapped in SVAR's `<Willow>` theme (fonts on). Previously the component rendered effectively unstyled because the theme wrapper was never applied.
  - Task-bar fills defer to SVAR's `--wx-gantt-*` custom properties (`--wx-gantt-task-fill-color`, `--wx-gantt-task-critical-fill-color`, `--wx-gantt-bar-border-radius`, …) instead of hardcoded colours. Non-signal bars keep transparent fills so SVAR's themed base shows through, and consumers can re-skin bars by remapping `--wx-*`. Only engine-specific signals (critical path, slack/late, baseline variance) are drawn by us.
  - Two-tone progress fill + bare-milestone rendering restored (previously buried by the paint-over template).
  - Fix: zoom no longer crashes the renderer — a format is emitted on every scale.

  ### Capabilities (ADR-007)

  - **Split tasks** — `Task.segments?: TaskSegment[]`; engine computes outer bounds from the segment list; rendered via SVAR's native split rendering. Manual-mode in this cut.
  - **Unscheduled tasks** — `Task.unscheduled?: boolean`; excluded from the forward/backward pass, inert links, grid-only render. ADR-005-preserving (excluded input, not an engine bypass).
  - Edit factories `splitTask` / `unsetSplit` / `setUnscheduled`; MSPDI round-trip (unscheduled clean via `IsNull`; segment lists preserved as outer bounds + reported in `droppedFields`).

  ### UX chrome — expose SVAR's free slots via the SVAR-agnostic API

  - **Zoom** (`zoom?: GanttZoomConfig`) — named levels with scroll-wheel zoom.
  - **Tooltip** (`tooltip?: (task: Task) => ReactNode`).
  - **Editor** (`editor?: boolean | GanttEditorConfig`) — task-edit form modal/sidebar; coexists with inline cell editing.
  - **Context menu** (`contextMenu?: boolean | GanttContextMenuConfig`).
  - **Toolbar** (`toolbar?: boolean | GanttToolbarConfig`) — shown by default.
  - **Locale** (`locale?: GanttLocaleWords`) via a `<Locale>` context wrapper.

  ### Engine / fixes

  - Engine scale tripwire proven: 1k tasks ~27ms, 5k ~286ms.
  - Various adapter/chrome fixes: zoom band clamping, unscheduled-summary computed guard, MSPDI absent-date handling, `onLinkDelete` typed id, tooltip phantom filtering.

## 0.3.0

### Minor Changes

- ## v0.3 — UX editing layer + construction-vertical extensions

  ### Inline editing (`editMode` prop)

  New `editMode` prop on `<Gantt>` gates interactive editing. When `true`:

  - Click any grid cell (name, start, end, duration, progress, scheduleMode) to edit inline. Enter/Tab commits; Escape cancels; blur commits.
  - `onTaskEdit(id, patch)` callback fires with only the changed field. Consumer applies via `useEditableProject` or own state.
  - Summary task date/duration cells are read-only (engine-derived).
  - `DEFAULT_EDIT_COLUMNS` (name 220px, start 100px, end 100px, duration 60px, progress 50px) used automatically when `editMode=true` and no `columns` prop is supplied.

  ### Live CPM preview while editing

  While a timing field is dirty (not yet committed), the engine runs a debounced (80ms) speculative CPM pass. Downstream tasks that would shift are rendered as blue dashed ghost bars alongside their solid live bars. Preview clears on commit or Escape. `name` / `progress` / `scheduleMode` edits skip the CPM pass (no cascade).

  ### Drag-to-link dependency creation (`onLinkCreate` callback)

  Hover a task bar in `editMode` to reveal a drag handle at the right edge. Drag to a target bar; a dashed SVG line follows the cursor. Drop fires `onLinkCreate(source, target, 'FS')`. Invalid targets (self, summary, duplicate link, phantom rows) are silently rejected.

  ### Link deletion (`onLinkDelete` callback)

  In `editMode`, clicking a rendered dependency arrow fires `onLinkDelete(linkId)`.

  ### Editing command model (`useEditableProject`)

  `useEditableProject(project)` returns `{ enqueue, commit, undo, redo, canUndo, canRedo, draft }` — a command-pattern draft layer with full undo/redo. Ten built-in factory functions: `updateTask`, `createTask`, `deleteTask`, `renameTask`, `setTaskStart`, `setTaskDuration`, `setTaskProgress`, `linkTasks`, `deleteLink`, `updateLink`.

  ### Multi-baseline UI (`baselineIndices` prop)

  `baselineIndices?: ReadonlyArray<BaselineIndex>` overlays multiple baseline snapshots as phantom ghost rows beneath each live task. Each phantom row carries its own variance pill (+Nd/−Nd). Per-baseline colour palette (up to 11 baselines). `baselineIndex` kept as a deprecated single-index alias.

  ### NZ public holidays calendar

  `nzPublicHolidays(year, region)` + `nzDefaultCalendar(options)` — all 13 statutory NZ regions, Matariki dates per Te Kāhui o Matariki Public Holiday Act 2022, Canterbury Show Day from employment.govt.nz year-by-year, pre-seeded 2022–2052.

  ### MSPDI constraint + hierarchy preservation

  `ConstraintDate` round-trips through MSPDI parse/serialize. `OutlineLevel`-based parent derivation from flat MSPDI task lists. `PercentComplete` emission added.

  ### New public API exports

  `TaskEditPatch`, `EditableField` — needed for typing `onTaskEdit` callbacks in consuming apps.

  ### New `GanttProps`

  ```ts
  editMode?: boolean;
  onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void;
  onLinkCreate?: (source: TaskId, target: TaskId, type: DependencyType) => void;
  onLinkDelete?: (linkId: LinkId) => void;
  baselineIndices?: ReadonlyArray<BaselineIndex>;
  ```

## 0.2.0

### Minor Changes

- b59d1fe: Multi-baseline UI: render multiple captured baselines simultaneously for variation-claim delay analysis under NZS 3910 / AS 4000.

  - New `baselineIndices: ReadonlyArray<BaselineIndex>` prop on `<Gantt>` overlays one phantom ghost row per selected baseline.
  - Existing `baselineIndex` prop continues to work; deprecated, removed at v1.0.
  - Each phantom row in multi-baseline mode carries its own variance pill; single-baseline mode keeps the pill on the live bar (existing behaviour).
  - Per-baseline CSS class `construction-gantt-baseline-${N}` for indices 0–10 ships with a default palette; consumers override via higher-specificity rules.
  - Phantom row label includes `baseline.name` (or `Baseline N` fallback) and formatted `capturedAt`.

  No engine changes (ADR-005 preserved). Render-layer only. Test infrastructure additions: canvas 2D context stub at `vitest.setup.ts` so SVAR mounts under happy-dom.

## 0.1.0

### Minor Changes

- First public release. Ships the v0.1 scheduling engine, v0.2 MSPDI XML interop, v0.3 NZ public holidays pre-seed, and v0.4 editing-model foundation under one MIT-licensed package on npm.

  ## What's in 0.1.0

  ### Scheduling engine (v0.1)

  - Forward + backward CPM pass with multi-path critical-path detection.
  - All 8 MS Project constraint types (ASAP, ALAP, MSO, MFO, SNET, SNLT, FNET, FNLT).
  - First-class negative slack (the contract-trouble signal every existing alternative clips to zero).
  - Manual-vs-auto schedule mode per task; summary-task aggregation as `max(child finish) − min(child start)`.
  - Working-time calendars with partial-day shifts and per-date exceptions.
  - Multi-baseline data model — up to 11 baselines matching MS Project's `Baseline 0–10`.
  - Public `<Gantt>` component rendering via free SVAR React Gantt; engine runs internally.
  - Custom columns (`GanttColumn[]`) for project-specific fields.
  - Today line + milestone markers; weekend/holiday shading; hierarchy collapse/expand.
  - Render-only visibility filter (`visibleTaskIds`) — CPM stays correct when consumers hide tasks (ADR-005).

  ### Exports (v0.1)

  - `exportPNG / exportPDF / exportXLSX` via imperative ref handle.
  - Full-project render regardless of on-screen scroll position.
  - Behind `construction-gantt/export` subpath with lazy-imported deps (consumers who never call exports pay zero bundle cost).

  ### MSPDI XML interop (v0.2)

  - Pure-TS round-trip of `parseMspdi` / `serializeMspdi`.
  - Covers Tasks + PredecessorLinks (all 4 dependency types, lag in tenths-of-a-minute), Calendars (workWeek with split shifts + exceptions), Resources (UID/Name/CalendarUID), Assignments (taskId/resourceId/units), and Baselines (per-task `<Baseline>` Number=0..10).
  - `parseMspdi` returns `{ project, droppedFields }` — unknown elements never silently drop.

  ### NZ public holidays (v0.3)

  - `nzPublicHolidays(years, region)` returns `CalendarException[]` for all 13 statutory NZ regions, years 2022–2052.
  - `nzDefaultCalendar({ years, region })` for a one-call working calendar.
  - Matariki dates from Te Kāhui o Matariki Public Holiday Act 2022; Canterbury Show Day from employment.govt.nz year-by-year (range bounded by published years).

  ### Editing model (v0.4 foundation — ADR-006)

  - `useEditableProject(initial)` React hook with `enqueue / commit / cancel / undo / redo / canUndo / canRedo / isDirty`.
  - Typed `EditCommand` interface + 6 concrete commands (Create/Update/Delete × Task/Link) + `CompositeCommand` wrapper.
  - Ten ergonomic factories: `renameTask`, `setTaskStart`, `setTaskDuration`, `setTaskProgress`, `updateTask`, `createTask`, `deleteTask`, `linkTasks`, `updateLink`, `deleteLink`.
  - Project-level draft overlay; single-stack undo with compound commits on draft commit.
  - Engine recomputes (`schedule()`) on every effective state change — ADR-005 engine-first invariant preserved.
  - UX patterns (inline-row vs modal vs drag-handle) are consumer choice — the hook is UI-agnostic.

  ## License

  MIT through v1.0 per ADR-004. Past releases stay MIT forever; future commercial-tier optionality reserved for v1.0+.

  ## Status

  292 Vitest tests, all passing. Foundational ADRs locked (ADR-001 through ADR-006). See `ROADMAP.md` for what's still pending (partial-day calendars UI, weather buffer widget, MSPDI Primavera P6 stretch, v0.4 editing-model UX patterns).
