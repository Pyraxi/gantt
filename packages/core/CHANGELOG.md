# construction-gantt

## 1.8.1

### Patch Changes

- 2c78f94: A double-click on a grid row near the bottom of the window opens that row's task. SVAR's grid focused its table on every mousedown without `preventScroll`. When the gantt ran past the viewport (in the page flow, or taller than the window), the page scrolled between the two clicks, so the second one landed on a lower row and `onTaskEditRequest` reported that task. The grid now focuses without scrolling the page. The same jump stopped click-to-edit cells near the bottom edge from opening, because mousedown and mouseup landed on different rows; they open now too.

## 1.8.0

### Minor Changes

- 1ea1ebf: Chart panels: draw your own strips under the chart, on its timescale.

  - `<Gantt chartPanels={[{ id, label?, height?, render }]}>` adds one strip per entry under the chart. `render(ctx)` gets the scheduled `project`, the timeline `width`, the panel `height` and `xOf(date)`, which lines up with the task bars at every zoom. Draw an `<svg width={ctx.width}>`; the strip scrolls with the chart, and its label sits in the gutter under the grid.
  - `label` can be a function of the scheduled project.
  - Off by default. Not drawn in PNG / PDF exports yet.

- 2111c41: Grid + bar polish from live-tester and design-review findings:

  - **Grid cells no longer hard-clip mid-word.** Plain-text cells (field columns, editMode's click-to-edit cells, custom-editor cells) and the built-in `predecessorsColumn` are single-line with an ellipsis, and get a hover `title` with the full text when clipped. Custom `render` output is left untouched (never clipped). Column `align` is now honoured by editMode click-to-edit cells, which previously ignored `align: 'right'`.
  - **Status pills follow an overflowing bar label.** When a task name spills beside a narrow bar, its float/slip/late/deadline pills now render after the label instead of on top of it, and keep their hover titles (editMode / baseline-bar template path).
  - **New `leadInDays` prop** — calendar days of empty timeline before the project start (default `0`, unchanged). Render-only: PNG/PDF exports still start at the project start. The default Today line shows when today falls in the lead-in window.
  - **Themable pill + checkbox colours.** In-bar pills read `--cg-pill-<kind>-bg` / `-color` tokens (old colours are the fallbacks); the `displayOptions` checkboxes follow `--wx-color-primary`. README documents the theming selector (`.your-wrapper .wx-willow-theme { … }`).
  - Default editMode **Duration** column widened 70 → 90px so its header doesn't truncate to "Durat…".
  - **Fix: click-to-edit grid cells closed immediately.** SVAR re-focused its own grid cell ~15 ms after our inline editor mounted, and the editor's blur committed and closed it, so a click never left an editable cell open (engine-field and custom-editor cells alike). The editor now keeps focus. You can click or drag-select inside it (caret, text selection, date segments, opening a select) without it closing — and a drag inside an editor no longer starts a row reorder. Double-click inside an editor selects a word instead of opening the task editor (`onTaskEditRequest`), and right-click shows the browser's paste menu instead of the task context menu. Escape now cancels the custom select editor too. Arrow keys stay inside it instead of moving grid focus, and typing straight after the click no longer drops characters. Note: keys typed in an inline editor no longer bubble to document-level (bubble-phase) keydown listeners. Click-away, Tab and Enter still commit, and Escape cancels. Empty editable cells now have a clickable height.

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
- e1f376e: Keyboard editing in the grid (`editMode`):

  - **Enter** saves and starts editing the same column on the next row. **Shift+Enter** goes up.
  - **Tab** / **Shift+Tab** save and move to the next or previous editable column.
  - Read-only cells are skipped (summary dates and duration, baseline rows).
  - **Escape**, or a move with nowhere to go, puts focus back on the grid cell instead of dropping it.
  - A value that can't be parsed (e.g. "soon" as a duration) is no longer sent to `onTaskEdit` as an empty `{}` patch:

    - Enter or Tab keeps the editor open with `aria-invalid` set;
    - clicking away reverts it.

  - **Enter** / **F2** on a focused cell opens its editor. On a summary's name cell, Enter no longer collapses the summary.
  - Keyboard moves don't change the row selection or fire `onTaskSelect`.
  - Navigation follows the rows as shown (respecting collapsed summaries) and scrolls the chart to keep the editor in view.

  Before this change, Enter and Tab saved and closed the editor.

- f790874: Grid clipboard: paste from Excel, copy and fill-down in `editMode`.

  **Keys on a focused grid cell** (not inside an editor):

  - **Ctrl/Cmd+V** pastes a TSV block positionally from that cell, following visible rows and columns.
    - Read-only, empty, unparseable and out-of-range cells are skipped and reported, never forced.
    - Phantom baseline rows don't count as sheet rows.
    - SVAR's own Ctrl+C/V/X/D task hotkeys are shielded on grid cells.
    - Dates accept ISO, day-first `d/m/yyyy` and `19 Oct 2026`. Progress accepts `50%`.
  - **Ctrl/Cmd+C** copies the cell's editor value (or the focused column of the selected rows).
  - **Ctrl/Cmd+D** fills down from the top selected row, or from the row above.

  **New props:**

  - `onTasksEdit(edits, { source: 'paste' | 'fill', skipped })` delivers the batch: one persist, one undo step. Without it, each task's patch goes to `onTaskEdit`.
  - `gridClipboard` (default `true`) opts out.
  - `dateOrder` (`'dmy'` default, or `'mdy'`).

  **Exported helpers:** `parseClipboardTable`, `formatClipboardTable`, `parsePastedValue`.

  **On by default in `editMode`.** Paste and fill patches are identical to manual edits; only the call count differs. Wire `onTasksEdit` to get one batch, or set `gridClipboard={false}` to opt out.

- b825ff9: `<Gantt>` supports grouped projects from the engine's `groupProject()`. Group rows (tasks with `Task.group`) show their name and span, but they're read-only in `editMode`: no inline editor, drag, structural gesture or `onTaskEdit` / `onStructuralCommit` / `onTaskSelect` callback fires for them. Their ids don't exist in your real project. The tasks under a group stay fully editable.
- 39a9295: New `linkDisplay` prop: `'all'` (default) | `'critical'` | `'selected'` | `'none'`. SVAR draws every dependency link whether or not it's on screen. On very large schedules you can draw only the critical links (both ends critical), only the selected task's links, or none.

  At 5,000 tasks on a 4× throttled CPU, `'selected'` cuts mount from 3.3 s to 2.5 s and halves scroll frame time. Interaction cost (a click that changes the selection) is about the same as in `'all'`. `'selected'` follows SVAR's own selection, including ctrl-click multi-select and toggling a task off. Display only: hidden links still schedule, and the predecessors column still lists them. Also exports the `LinkDisplay` type.

- cefefc0: Paginated PDF export: `exportPDF({ pagination: 'vertical', title, subtitle, date })`. The chart fits the page width, and rows run over as many pages as needed without being cut in half.

  - Every page repeats the column header and timescale, and has a title band and a `Page N of M` footer.
  - New paper sizes: `format: 'a1' | 'a2'`, alongside A3, A4 and Letter.

  Each page is rendered at full resolution however long the programme is, and narrow charts are never enlarged past actual size. Titles can use any characters, including macrons.

  `pagination` defaults to `'none'`, the existing single-page export.

- 4a08af3: Physical % complete.

  - **`Task.physicalProgress`** (0–100) records how much work is in place, judged on site, independently of `progress` (duration %), as MS Project and P6 do. It never drives scheduling.
  - **MSPDI** reads and writes `<PhysicalPercentComplete>`, in schema order (after `IgnoreResourceCalendar`, before `PredecessorLink`; checked against MPXJ). MS Project's `0` on every task isn't kept.
  - **Progress line:** `progressPoints(project, statusDate, { basis: 'physical' })` and `<Gantt progressLine={{ basis: 'physical' }}>` place each point by physical % (P6's option). A task without one falls back to duration %.
  - **`compareSchedules`** reports `physicalProgress` changes.

- f212fa2: Type predecessors in the grid, MS Project style.

  - `predecessorsColumn(links, { editable: true, tasks, minutesPerDay })` makes the column click-to-edit in `editMode`. `tasks` is required with `editable` (enforced by the type), because the cell is read by row number.
    - Accepted forms include `3`, `3FS+2d`, `5SS-1d, 7FF`, `4FS+4 hrs`, `4FS+50%` and `2FS+3ed` (elapsed).
    - A commit fires `onCellEdit(id, 'predecessors', text)`. Apply it with `parsePredecessors` and the engine's `setPredecessors` for one undo step.
    - Unreadable text, unknown rows, self-references and loops keep the editor open, with the reason as its tooltip. Escape cancels.
  - `parsePredecessors(text, { tasks, minutesPerDay?, targetId? })` parses the MS Project text. It reads row numbers in `tasks` (each resolves to that task's own id) and returns `{ ok, preds }` or `{ ok: false, error }`. It round-trips `formatPredecessors`.
  - **Display change:** predecessor lags now show in the largest exact unit (`+4 hrs`, `+30 mins`, `+1.5 ehrs`) rather than rounded days (`+0.44 days`). Whole and two-decimal day lags look the same as before. This is what MS Project shows, and it means editing a cell never shifts the lags you didn't touch.
  - Two existing links from the same predecessor show as `1, 1SS`; that text is refused as listed twice. Retyping `1` keeps one of them.
  - `GanttColumnEditor.validate?(value, task)` gives custom text editors the same behaviour: an error message keeps the editor open on Enter/Tab, and an invalid value reverts on blur.

- 7448f21: Import a programme from Excel, CSV or a pasted table.

  - **`importProgrammeTable(table, options?)` → `{ project, skipped }`:**
    - The header row is matched against MS Project / P6 export names (ID, Name, Duration, Start, Finish, Predecessors, Outline Level / WBS, % Complete). `options.columns` overrides any of them.
    - Cells are parsed with the grid's paste parsers. Dates honour `dateOrder`; durations are `3d`, `4h`, MS Project's estimated `3 days?` and elapsed `2 edays`.
    - Predecessors are MS Project text referencing the ID column **as text**, so P6 Activity IDs like `A1000FS+2d` work. Duplicate or missing IDs fall back to row numbers, and that's reported.
    - Only a duration of exactly 0 makes a milestone; an empty or unreadable one stays a task. Finish before Start is reported.
    - Links to summaries are imported but reported, because the engine doesn't schedule them.
    - Hierarchy comes from Outline Level or WBS. A dated task with no predecessors gets SNET at its start. A missing duration is taken from Start and Finish.
    - Unreadable cells are skipped and reported in sheet order, never guessed.
  - **`readSpreadsheet(file, { sheet? })`** turns an `.xlsx` into text rows (`exceljs` loaded on demand). Percent-formatted cells read as `50%`, and merged cells are read once.
  - **CSV:** `parseClipboardTable(text, ',')` now takes a delimiter (tab by default).
  - **`parsePredecessors`** takes `resolve: (ref) => TaskId` as an alternative to `tasks`, so references can be any text.
  - **Paste and import dates** accept MS Project's short form with a weekday and a 2-digit year (`Mon 5/01/26`).

- 457ba21: Progress line, the weekly-update view from MS Project and P6:
  - **`@pyraxi/gantt`:** new `progressLine` prop (`true`, or `{ statusDate, color }`; default off). It draws the jagged line from the status date through each task's progress point, bending left for tasks behind and right for tasks ahead.
    - It's positioned from SVAR's own layout, so it lines up at every zoom level.
    - Nothing is drawn without a status date, or when the status date is off the timeline.
    - It isn't included in PNG/PDF exports yet.
    - Colour: `--cg-progress-line-color`.
  - **`@pyraxi/cpm-engine`:** new `progressPoints(project, statusDate?)` returns each task's progress point.
    - Complete tasks, and tasks not yet due, sit on the status date.
    - Otherwise the point is the task's start plus the work done, in working time. Work done follows the engine's forecast: `remainingDuration` when set, otherwise `progress%`. A task that started early sits right of the line.
- f41f7b7: Task badges and previous-start markers.

  - **`taskBadges={(task) => TaskBadge[]}`** draws small labelled badges just before a task's bar, e.g. a make-ready status. Each badge is `{ kind, label, tone?, title? }`. `label` is required text or a glyph (such as `'✓ Ready'`), so the meaning never rests on colour alone. `tone` is one of `neutral`, `info`, `success`, `warning` or `danger`, themed by `--cg-badge-<tone>-bg` / `-fg`. Badges sit above the bar's midline, so link arrows stay visible, and move after the bar when it starts at the timeline's left edge.
  - **`previousStart={(task) => PreviousStart}`** draws a ghost marker at an earlier (or later) start, joined to the bar by a dashed line, e.g. where a slipped task was planned to start. `{ date, pending?, kind?, title? }`: `pending` draws it amber with a `?`. Colours `--cg-previous-start-color` and `--cg-previous-start-pending-color`.
  - **`onTaskBadgeClick(taskId, kind)`** fires when a badge or marker is clicked: the badge's `kind`, or the marker's (default `'previous-start'`). Both are buttons with an accessible name. A click doesn't select or drag the bar.
  - **`displayOptions`** gains **Badges** and **Previous starts** toggles. Each shows only when its prop is set. `defaults.badges` / `defaults.previousStarts` seed them, and `onViewStateChange` reports `badges` / `previousStarts`.
  - PNG / PDF exports include them, minus any the view has hidden.

- 4e61af5: Task highlights: `highlights={[{ taskIds, color? }]}` rings the bars and tints the grid rows of host-supplied task sets.
  - **Typical use:** show `checkSchedule()`'s offending ids, while the host renders the check list itself.
  - **Layering:** later sets win, so severities can stack.
  - **Colour:** `--cg-highlight-color`, default amber.
  - **Rendering:** a scoped stylesheet keyed on SVAR's ids. Rows aren't re-mapped.
- 65386be: Task Path highlight, MS Project's "why is this task late?" view:
  - **`@pyraxi/gantt`:** new `taskPath` prop (`'driving' | 'driven' | 'both'`, default off). It highlights the selected task's driving predecessors (orange) and the successors it drives (purple), with their driving links.
    - `taskPathFor` lets a host panel choose the task instead of the selection.
    - Colours: `--cg-path-driving-color` / `--cg-path-driven-color`.
    - Bars get a scoped stylesheet; path links are painted inline. Selecting a task never re-maps rows or re-parses links: about 100 ms a click at 5k tasks.
  - **`@pyraxi/cpm-engine`:** `DrivingAnalysis.drivenPath(id)` and `getDrivenPath(project, id)` return the task's driven successors. It's the mirror of `drivingPath` over the same driving links.
- 0112925: **New `onViewStateChange` prop + `GanttViewState` type** — reports the user's view (displayOptions column/signal toggles and the zoom level) whenever they change it, never on mount. The shape matches `displayOptions.defaults` (+ `zoom`), so a persisted value restores directly: `displayOptions={{ defaults: saved }}` and `zoom={{ levels, default: saved.zoom }}` — "set as default view".

  **Fix: zoom no longer resets on host re-render.** The `zoom` prop is now applied by value, not identity. Passing an inline `zoom={{…}}` literal used to make SVAR re-init its zoom on every parent re-render, which snapped the chart back to the default level after any host state change (e.g. selecting a task). Changing `zoom.levels` or `zoom.default` still applies.

- e8dc42f: Built-in WBS column.

  - `wbsColumn(tasks, { header?, width?, code? })` shows MS Project's WBS / outline number (`1`, `1.2`, `1.2.3`) from the parent / child structure.
  - `code(task)` returns a host-owned code (`task.codes`, or a host field such as `extra.wbsCode`), which wins where it's non-empty. An empty code falls back to the outline number, as in MS Project.
  - Group rows are always blank. For a `groupProject` view, pass the source project's tasks so members keep their real numbers. Phantom rows are blank too.
  - Custom render columns now see `task.codes` (it's carried on SVAR rows, like `extra`).
  - Engine: `computeWbs` accepts any `{ tasks }` (it only ever read the tasks).

### Patch Changes

- d7cbb52: Fix: grid durations now use the calendar's working day.

  A 1-day task on a 9-hour calendar now reads `1d`, not `9h`, and typing `3d` saves three of that calendar's days, not three 8-hour days. Weeks are 5 days and months 20.

  If your calendar's day isn't 8 hours, duration text in the grid will change to match it.

- 0ceeadb: `parsePredecessors` now reads ids that contain `-` or `+` (P6 / sheet ids such as `EW-10`, `EW+5`) with any link type and lag, so what `formatPredecessors` writes reads back the same. `EW-10SS+2 days` is an SS link from `EW-10` with a 2-day lag. Before, an SS / FF / SF link from `EW-10` was read as `EW` with a bad lag.

  With a `resolve` function, each whole entry is tried as a task id first. With tasks `EW` and `EW-10`, the text `EW-10` now links `EW-10`. Before, it was read as `EW` with a 10-day lead. If only `EW` exists, `EW-10` still means `EW` with a 10-day lead. The whole entry wins only when the reference read out of it names no task or a different one. A tolerant resolver that also maps `3FS+2d` to row 3 therefore keeps the type and lag. `resolve` should return an id only for an exact match.

- cefefc0: Fix PNG/PDF export in real browsers:

  - **Blank output:** the capture used to come out blank. The off-screen clone kept its `left: -99999px`, so it was drawn outside the image.
  - **Missing rows:** every row is captured. Before, rows past the first screenful could be lost, and baseline rows left blank pages.
  - **White space:** no trailing white space.
  - **Scrollbar:** no scrollbar strip.
  - **Black links:** dependency links render as lines, not black filled shapes.
  - **Toolbar:** the toolbar is no longer included.

  PDFs are also compressed. Exports of more than 2,500 rows now fail fast with a clear error; pass `visibleTaskIds` to export a section.

- 4404421: PNG and PDF exports now include the overlays you see on screen: the progress line (`progressLine`), task highlights (`highlights`) and inline baselines (`baselineRender="inline"`). Before, the export's off-screen copy of the chart didn't receive these props, so they were silently missing from the image.
- 5e40d85: Export fixes from the July review.

  - **`exportXLSX` can follow the screen filter.** `options.scope: 'visible'` exports only the tasks in `visibleTaskIds`, as PNG and PDF show. The default stays `'all'`, the whole programme: a filtered spreadsheet opened later reads as the programme, so it's never truncated silently.
  - **`backgroundColor` reaches the off-screen capture container.** It used to be hard-coded white. The chart keeps its own theme surfaces, so this alone doesn't make a dark export; the option's docs now say so.
  - **`pyraxi-gantt-mpp` JSON output keeps baseline snapshots.** `Baseline.tasks` is a `Map`, which `JSON.stringify` printed as `{}`. It now prints as an object keyed by task id.

- 7e8692c: PNG and PDF exports now match what's on screen.

  - **Settings now forwarded to the export:**
    - the **current zoom level** and cell width;
    - the **effective** critical / slack / deadline toggles and **hidden columns** (after `displayOptions`);
    - `linkDisplay`: with `"selected"`, the selection's links. **Exception:** with a `taskPath` on, every link is drawn, because the path needs all of them;
    - the **task path** for the current selection;
    - `leadInDays`, `boldSummaryRows` and `locale`.
  - **Theme tokens:** `--cg-*` tokens set on a host wrapper element (not only `:root`) now reach the export.
  - **Before:** the export drew from a fixed subset of props frozen when exports shipped, so a PM's configured view and the printed PDF could differ.
  - **Grid dates in exports:** the default edit columns an export renders read-only show the **local** date and durations with units (`1d`, not `1`), as the screen does.
  - **Drift guard:** a new view prop now reaches exports by default; leaving one out is a type error.

- 3de6ee6: `idColumn()` now defaults to 56 px wide. At 44 px, SVAR's header padding and sort-icon slot truncated the bold "ID" header to "I.". Pass `width` to override.
- 6f91e3d: Fix: inline baseline ghosts (`baselineRender="inline"`) were drawn in the wrong place whenever the baseline differed from the live bar. A ghost one day early drew about 2.7 days early, and further across weekends.
  - **Cause:** the ghost was positioned as a share of the bar's working-hours span, but SVAR draws bars across whole cells.
  - **Fix:** the ghost is now placed with SVAR's own bar formula, read from its live scale at render, and uses SVAR's bar-end rule. It lands exactly where the row-mode baseline bar does, at every zoom level and after zooming.
  - Milestones never carried a ghost, and still don't.
  - **Timeline widening:** the timeline now widens to include inline baselines that start before the project or end after it. Before, they were clipped off the chart's edge, whereas row-mode baselines always widened it.
- 8c55be0: Fix: re-rendering the Gantt (for example passing a new `project` object after an edit or a refresh) no longer clears the user's task selection. SVAR's wrapper re-applied an empty selection on every re-render.
- 6a4fe05: Fix: `markers` (the "Today" line and milestone markers) never rendered. SVAR's free store switches its own markers off, so the prop was silently dropped.
  - **Fix:** markers are now drawn as a layer in the chart area, on SVAR's day grid.
  - **Styling:** they keep the `construction-gantt-marker-today` / `-milestone` classes, and a consumer's `css` class still works.
  - **Visible change:** the documented default now appears. That's a red "Today" line whenever today falls inside the project window. Pass `markers={[]}` to keep the chart without it.
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

- f2ca87d: Baseline pills are now measured in the task's own calendar, as `getTaskBaselineVarianceAll` and `compareSchedules` measure:
  - **Variance and slip/ahead pills:** a task on a 24-hour or other calendar shows its variance in that calendar.
  - **Float labels:** the pill's day length follows the task's calendar too. A 40-hour slip of a 24-hour task reads `+2d`, not `+4d`. Elapsed tasks read `ed`.
  - **Unchanged:** rows on the default calendar.
  - **Engine:** exports `createCalendarResolver` for per-task effective-calendar lookups. It's O(1) per task, where `getEffectiveCalendar` builds a resolver on every call.
- cbcf0b4: The default "%" grid column and the Excel export's "Progress (%)" column show a whole percent, as MS Project does. A programme imported with `parseMspdi` can now carry fractional progress (the exact actual ÷ duration), which used to show as `45.55555555555556`.
- d982076: Fix: ctrl/⌘ + wheel zoom now goes the right way. SVAR steps zoom levels coarse → fine, but `zoom.levels` was passed through in config order, so with the documented `['day', 'week', 'month']` a zoom-in gesture jumped to a coarser scale. Levels are now sorted coarse → fine internally, whatever order you configure them in.

  When `zoom.default` is omitted or not one of the levels, the Gantt still opens at the first configured level. Level names reported by `onViewStateChange` are unchanged.

- Updated dependencies [5a40b16]
- Updated dependencies [780598f]
- Updated dependencies [dc2f827]
- Updated dependencies [39ced11]
- Updated dependencies [c93a676]
- Updated dependencies [856d87a]
- Updated dependencies [84e2eee]
- Updated dependencies [9520d3d]
- Updated dependencies [693c350]
- Updated dependencies [f741e3e]
- Updated dependencies [bf90a34]
- Updated dependencies [019f5e5]
- Updated dependencies [ae39a94]
- Updated dependencies [a72ffef]
- Updated dependencies [88e06bc]
- Updated dependencies [d5cda2a]
- Updated dependencies [6ec4b40]
- Updated dependencies [dfd4285]
- Updated dependencies [4a08af3]
- Updated dependencies [f2ca87d]
- Updated dependencies [f212fa2]
- Updated dependencies [457ba21]
- Updated dependencies [ce70fe3]
- Updated dependencies [ab2deae]
- Updated dependencies [5cea0bd]
- Updated dependencies [4328240]
- Updated dependencies [9062ac0]
- Updated dependencies [65386be]
- Updated dependencies [5b8e26d]
- Updated dependencies [e8dc42f]
- Updated dependencies [1ea1ebf]
  - @pyraxi/cpm-engine@1.3.0

## 1.7.6

### Patch Changes

- 92f7009: A calendar work interval whose end is at or before its start (inverted or zero-length) now counts as no working time everywhere working time is read. Before, it added negative time, so durations across such a day came out too long, and a default calendar made only of them made `schedule()` hang. Such a default calendar now throws the same "no working time" error as an empty one. The grid's minutes-per-day ignores these intervals too. `serializeMspdi` no longer writes these intervals, and a week day or working exception made only of them is written as non-working.

  MSPDI import now reads a `ToTime` of `00:00:00` as the end of the day (minute 1440), as MS Project and MPXJ do. MS Project's "24 Hours" calendar (`00:00:00` to `00:00:00`) was otherwise read as zero-length, so it had no working time. `serializeMspdi` writes an interval ending at 1440 as `00:00:00`, so it round-trips.

- Updated dependencies [537c686]
- Updated dependencies [cb2d34f]
- Updated dependencies [537c686]
- Updated dependencies [537c686]
- Updated dependencies [92f7009]
- Updated dependencies [f707d03]
  - @pyraxi/cpm-engine@1.2.5

## 1.7.5

### Patch Changes

- d27eb32: Fix: a plain `field` date column (e.g. `{ id: 'start', field: 'start', header: 'Start' }` with no `render`) showed the UTC date, so in NZ an 08:00 start read as the previous day. It now shows the local date.
- d863043: Fix: with `visibleTaskIds`, a task whose parent summary was filtered out wasn't drawn at all.
  - It now renders under its nearest visible ancestor, or at the top level.
  - A drag or add that would file a task under a filtered-out summary is refused (a visible no-op), so work can't be moved out of sight.
  - To keep the summaries visible instead, include their ids in the set.
- 2149cc6: Fix: `exportXLSX` date cells showed the previous evening in NZ (an 08:00 start read `4/01/2026 7:00 PM`). `exceljs` stores a Date by its UTC epoch, so the export now writes the local wall clock. This also applies to a custom XLSX column whose `value` function returns a Date; string values are unchanged.

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
