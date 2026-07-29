# Pyraxi Schedule — `@pyraxi/gantt`

> An MIT-licensed React Gantt that ships a real scheduling engine — not just a renderer. MS Project interop (MSPDI). Built for construction.

Two packages: **`@pyraxi/cpm-engine`** (the headless scheduling engine — pure TypeScript, the IP) and **`@pyraxi/gantt`** (the React view, rendered with [SVAR](https://svar.dev/) (MIT), depends on the engine). Native `.mpp` import is a separate add-on (`@pyraxi/gantt-mpp`). Part of [Pyraxi](https://github.com/Pyraxi) — Pyraxis's construction software.

## Install

```bash
pnpm add @pyraxi/gantt
# or: npm install @pyraxi/gantt
# or: yarn add @pyraxi/gantt
```

Peer deps: `react` `^18 || ^19`, `react-dom` `^18 || ^19`.

## Quick start

```tsx
import { Gantt, useEditableProject, renameTask, type Project } from '@pyraxi/gantt';

function MyGantt({ initial }: { initial: Project }) {
  const editable = useEditableProject(initial);
  return (
    <>
      <button onClick={editable.undo} disabled={!editable.canUndo}>Undo</button>
      <button onClick={editable.redo} disabled={!editable.canRedo}>Redo</button>
      <Gantt project={editable.project} />
    </>
  );
}
```

That's the editing-model entry. For read-only use, drop `useEditableProject` and pass a `Project` straight to `<Gantt>` — the engine still runs internally, the renderer is SVAR's free React Gantt under the hood.

## What's in the box

- **Scheduling engine** — forward + backward pass, all 8 MS Project constraint types, first-class negative slack, manual-vs-auto schedule mode per task, summary-task aggregation, critical-path detection.
- **Split tasks + unscheduled tasks** — `Task.segments[]` for interrupted work (the weather-paused pour); `Task.unscheduled` for planned-but-undated line items (excluded from the pass, grid-only). SVAR PRO parity (ADR-007); both render via SVAR's native fields.
- **Deadline markers** — `Task.deadline` for indicative contractual / sectional-completion dates (NZS 3910). Non-scheduling (never moves the task, unlike a `FNLT` constraint); the engine flags `computed.deadlineMissed` when the finish slips past it, shown as an in-bar pill. Round-trips through MSPDI `<Deadline>`.
- **Working-time calendars** — partial-day shifts (7am–3pm concreting), holiday exceptions, per-resource overrides. Non-working hours shade on the timeline at hour zoom.
- **NZ public holidays pre-seed** — 13 statutory regions, years 2022–2052 (Matariki + Canterbury Show Day from primary sources).
- **Editing model** — `useEditableProject` hook with command-pattern edits, draft-state overlay, single-stack undo/redo with compound commits. Engine recomputes on every effective state change.
- **UX chrome** (v0.5) — toolbar, context menu, task editor form, scroll-wheel zoom, custom tooltips, locale overrides — all wired through the SVAR-agnostic public API. See [UX chrome](#ux-chrome-v05) below.
- **`preset="msproject"`** (v1.1) — one prop turns on `editMode` + `editor` + `toolbar` + `contextMenu` together, and bridges SVAR's structural mutations (add/delete/reorder/indent-outdent) to engine commands. See [MS Project preset](#ms-project-preset-v11) below.
- **Exports** — PNG / PDF / XLSX via an imperative ref handle; full-project render regardless of on-screen scroll position.
- **MSPDI XML interop** — pure-TS round-trip of Tasks + PredecessorLinks (all 4 dependency types + lag) + Calendars + Resources + Assignments + Baselines (per-task `<Baseline>` Number=0..10).
- **Multi-baseline data model** — up to 11 baselines, MS Project–compatible.
- **Visual signals** — red critical-path bars, yellow `Nd late` (negative slack), orange/green `±Nd` vs captured baseline, blue `Nd float` on non-critical tasks.
- **Today line + milestone markers + weekend/holiday shading + hierarchy collapse/expand.**
- **Custom columns** for WBS / trade package / any project field via `GanttColumn[]`, plus built-in **`idColumn`** (MS Project `#` row number) and **`predecessorsColumn`** (MSP-style row-ref predecessors with day lag).
- **Render-only visibility filter** (`visibleTaskIds`) — CPM stays correct when consumers hide tasks.

See [`ROADMAP.md`](./ROADMAP.md) for what's pending (partial-day calendars UI surface, weather buffer widget, MSPDI Primavera P6 stretch, chronograph substrate evaluation).

### Exports

```tsx
import { Gantt, type GanttHandle } from '@pyraxi/gantt';
import { useRef } from 'react';

function MyView() {
  const ref = useRef<GanttHandle>(null);

  async function downloadPNG() {
    const blob = await ref.current!.exportPNG();
    // your download/upload logic — library returns the Blob; you decide
  }

  return <Gantt ref={ref} project={myProject} />;
}
```

Three methods on the ref handle: `exportPNG`, `exportPDF`, `exportXLSX`. Each returns `Promise<Blob>`. The export deps (`html-to-image` + `jsPDF` + `xlsx`) live behind a `@pyraxi/gantt/export` subpath and are lazy-imported by the methods — consumers who never call them don't pay the bundle cost. See [`docs/exports-contract.md`](./docs/exports-contract.md) for the field-by-field input contract (useful if you're calling the exports against a custom task shape).

### NZ public holidays

```ts
import { nzPublicHolidays, nzDefaultCalendar } from '@pyraxi/gantt';

// Low-level: drop holidays into a calendar you already own.
const myCalendar = {
  id: 'site',
  name: 'Auckland Site',
  workWeek: /* … */,
  exceptions: nzPublicHolidays([2026, 2027], 'auckland'),
};

// High-level: get a working calendar in one call.
const calendar = nzDefaultCalendar({
  years: [2026, 2027],
  region: 'auckland',
});
```

All 13 statutory NZ regions, years 2022–2052. Matariki dates from Te Kāhui o Matariki Public Holiday Act 2022; Canterbury Show Day from employment.govt.nz (range bounded by what's published).

### Editing model (v0.4)

```tsx
import { Gantt, useEditableProject, renameTask, setTaskStart } from '@pyraxi/gantt';

function MyGantt({ initial }) {
  const editable = useEditableProject(initial);

  return (
    <div>
      <button onClick={() => editable.undo()} disabled={!editable.canUndo}>Undo</button>
      <button onClick={() => editable.redo()} disabled={!editable.canRedo}>Redo</button>

      <input
        onChange={(e) => editable.enqueue(renameTask('a', e.target.value))}
        onBlur={() => editable.commit()}
      />

      <Gantt project={editable.project} />
    </div>
  );
}
```

`useEditableProject` returns a hook with `project` (always scheduled + effective), `enqueue / commit / cancel`, `undo / redo`, and `canUndo / canRedo` / `isDirty`. Edits are typed `EditCommand` values; ten factory helpers ship for ergonomic construction. The CPM engine re-runs on every effective state change — per [ADR-005](./DECISIONS.md) engine-first. Compound commits land as one undo entry. See [ADR-006](./DECISIONS.md) for the foundation design; UX patterns (inline-row vs modal vs drag-handle) are consumer choice.

### UX chrome (v0.5)

SVAR's free core ships Toolbar, ContextMenu, Editor, Tooltip, and zoom controls. v0.5 exposes all of them through Pyraxi Schedule's SVAR-agnostic public API (ADR-002 — SVAR types never appear in your imports).

#### Scroll-wheel zoom

```tsx
<Gantt
  project={project}
  zoom={{ levels: ['day', 'week', 'month'], default: 'week' }}
/>
```

Named levels: `'hour' | 'day' | 'week' | 'month' | 'quarter'`. Scroll-wheel zooms between them. `default` sets the level on mount (defaults to first entry in `levels`).

#### Custom tooltips

```tsx
<Gantt
  project={project}
  tooltip={(task) => (
    <div>
      <strong>{task.text}</strong>
      {task.computed?.isCritical && <span> ⚠ Critical</span>}
    </div>
  )}
/>
```

The render function receives the scheduled `Task` (including `task.computed` with CPM fields, plus `extra` + `deadline`). Return any `ReactNode`.

Since **v1.6**, omitting `tooltip` no longer means "no tooltip" — a built-in default tooltip (title · date range · working days · % / status · assignee-if-present · critical / past-deadline flags) is shown. Pass `tooltip={false}` to disable it, or a function to override it. `task.extra` is threaded through so tooltips can surface host-app fields (assignee/trade) the engine doesn't model. Also in v1.6: in `editMode` a bar label that doesn't fit spills **beside** the bar (matching SVAR's native read-only rendering) instead of clipping.

#### Task editor form

```tsx
// SVAR's built-in modal editor (double-click a task bar to open)
<Gantt project={project} editor={true} />

// Custom fields + placement
<Gantt
  project={project}
  editor={{
    fields: [
      { key: 'text', label: 'Task name', comp: 'text', required: true },
      { key: 'start', label: 'Start date', comp: 'date' },
      { key: 'duration', label: 'Duration (days)', comp: 'counter' },
    ],
    placement: 'modal', // or 'sidebar'
  }}
/>
```

The SVAR Editor is a full-form modal — it coexists with the inline cell editing provided by `editMode: true` (inline edits quick fields in-grid; the Editor handles the full task record).

#### Context menu

```tsx
// SVAR's built-in right-click menu (add/delete/indent/outdent/split/etc.)
<Gantt project={project} contextMenu={true} />

// Custom items
<Gantt
  project={project}
  contextMenu={{
    items: [
      { id: 'edit', text: 'Edit task', icon: 'wxi-edit' },
      { separator: true },
      { id: 'delete', text: 'Delete task', icon: 'wxi-delete' },
    ],
  }}
/>
```

#### Toolbar

```tsx
// SVAR's built-in toolbar (add task, undo, redo)
<Gantt project={project} toolbar={true} height={450} />

// Custom toolbar buttons
<Gantt
  project={project}
  height={450}
  toolbar={{
    items: [
      { id: 'export-pdf', text: 'Export PDF', icon: 'wxi-download' },
    ],
  }}
/>
```

Note: `toolbar` adds height above the chart; adjust `height` accordingly.

#### Locale overrides

```tsx
<Gantt
  project={project}
  toolbar={true}
  contextMenu={true}
  locale={{
    gantt: {
      'Add task': 'Aufgabe hinzufügen',
      Save: 'Speichern',
      Delete: 'Löschen',
    },
  }}
/>
```

Partial overrides — unset keys fall back to SVAR's English defaults. The locale prop wraps the entire chrome tree in SVAR's `<Locale>` context provider (locale is context-based in SVAR, not a direct Gantt config prop).

#### Footer + display-signal props (v1.2)

```tsx
<Gantt
  project={project}
  height={450}
  footer={<span>Last synced 2 min ago</span>}
  showCritical={true}
  showSlack={true}
  showDeadline={false}
/>
```

- `footer` — optional bottom bar rendered inside the component's own flex
  column, below the chart area, shrink-to-content (doesn't scroll with the
  chart). Use for a status strip, legend, or your own wordmark.
- `showCritical` / `showSlack` / `showDeadline` — toggle the engine's
  critical-path recolour, total-slack pill, and deadline-overrun outline
  independently. All default `true`; set `false` to suppress a signal without
  touching the underlying CPM computation.
- Fullscreen layout fix: the component's outer container is now a flex
  column (chart area `flex: 1`, toolbar/footer `flex-shrink: 0`), so
  `height="100%"` in a fullscreen Storybook layout (or any flex parent) no
  longer clips the last row — the chart area scrolls independently instead of
  the whole page overflowing.

#### Display-options control bar (v1.2)

```tsx
// Everything on — column show/hide + signal toggles
<Gantt project={project} displayOptions />

// Scope which sections appear, and seed initial state
<Gantt
  project={project}
  displayOptions={{
    columns: true,
    signals: true,
    defaults: { hiddenColumns: ['progress'], slack: false },
  }}
/>
```

Opt-in control bar rendered above the toolbar. `true` enables both the
column-visibility and signal-toggle sections with all defaults on; pass a
`DisplayOptionsConfig` to scope which section shows and seed initial toggle
state (`columns`/`signals` booleans, `defaults.hiddenColumns` +
`defaults.critical`/`slack`/`deadline`). When enabled, the bar drives
`showCritical`/`showSlack`/`showDeadline` and column visibility live — a
consumer that never sets `displayOptions` sees byte-identical behaviour to
the static props above. When `displayOptions` is enabled and no `columns`
prop is supplied, the grid falls back to the fuller default edit column set
(Task Name / Start / Finish / Duration / Predecessors / %) rather than
SVAR's bare default, so the bar's column tick-boxes have something to
toggle.

#### Predecessors column

```tsx
import { predecessorsColumn } from '@pyraxi/gantt';

<Gantt
  project={project}
  columns={[...defaultColumns, predecessorsColumn(project.links)]}
/>;
```

Built-in predecessors column computed from the project's `links`. By default it
renders **MS-Project-style** — by **row number** rather than raw task id, with
lag in **days** (e.g. `3`, `1FS+3 days`, `2FS-1 day`; the `FS` type is shown
only when there's a lag, per MSP convention). `predecessorsColumn(links, opts?)`
takes optional `header`/`width` overrides. Auto-appended when `displayOptions`
is enabled and a predecessors column is not already present in the `columns`
array. (The lower-level `formatPredecessors(links, opts?)` still emits raw ids
with minute lag when called without `opts.tasks`/`opts.minutesPerDay`.)

#### ID column (v1.7)

```tsx
import { idColumn } from '@pyraxi/gantt';

<Gantt project={project} columns={[idColumn(project.tasks), ...defaultColumns]} />;
```

`idColumn(tasks)` renders MS Project's `#` column — the 1-based row number. Numbers
follow the flat `tasks[]` array order, so store the array in DFS display order for
them to line up with the visual tree rows.

#### All chrome at once

```tsx
<Gantt
  project={project}
  height={450}
  zoom={{ levels: ['day', 'week', 'month'], default: 'week' }}
  toolbar={true}
  contextMenu={true}
  editor={true}
  tooltip={(task) => <span>{task.text}</span>}
  locale={{ gantt: { Save: 'Speichern' } }}
  displayOptions
  footer={<span>Pyraxi Schedule</span>}
/>
```

---

### MS Project preset (v1.1)

`preset="msproject"` is a single-prop bundle: it turns on `editMode` + `editor` + `toolbar` + `contextMenu` together (any explicit chrome prop still wins over the preset default) and bridges SVAR's native structural mutations — add task, delete task, move up/down, indent/outdent — into four new callbacks, so those toolbar/menu actions route through the engine's command model instead of SVAR's own optimistic state.

```tsx
import {
  Gantt, useEditableProject, createTask, deleteTask,
  indentTask, outdentTask, moveTask, updateTask, linkTasks,
  type Project, type Task, type TaskType,
} from '@pyraxi/gantt';

const TASK_TYPES: readonly TaskType[] = ['task', 'summary', 'milestone'];
const toTaskType = (t?: string): TaskType =>
  (TASK_TYPES as readonly string[]).includes(t ?? '') ? (t as TaskType) : 'task';

function MyGantt({ initial }: { initial: Project }) {
  const ep = useEditableProject(initial);
  return (
    <Gantt
      project={ep.project}
      preset="msproject"
      onTaskEdit={(id, patch) => ep.enqueue(updateTask(id, patch))}
      onTaskAdd={(task, pos) => {
        // SVAR hands a partial task; the consumer maps it to a full engine Task.
        const fullTask: Task = {
          id: task.id ?? `t-${Date.now()}`,
          text: task.text ?? 'New task',
          type: toTaskType(task.type),
          scheduleMode: 'auto',
          duration: 480, // 1 working day (min); engine re-derives for auto tasks from dates/predecessors
          start: task.start instanceof Date ? task.start : ep.project.start,
          end: task.end instanceof Date ? task.end : ep.project.start,
          progress: task.progress ?? 0,
        };
        ep.enqueue(createTask(fullTask, pos.parent, pos.insertAfter));
      }}
      onTaskDelete={(id) => ep.enqueue(deleteTask(id))}
      onTaskReorder={(id, dir) => ep.enqueue(moveTask(id, dir))}
      onTaskIndent={(id, dir) => ep.enqueue(dir === 'indent' ? indentTask(id) : outdentTask(id))}
      onLinkCreate={(s, t, type) => ep.enqueue(linkTasks(s, t, type))}
    />
  );
}
```

Each bridge vetoes SVAR's own optimistic mutation, so nothing changes on screen until the consumer applies the corresponding engine command and the `Project` re-renders — same one-way-data-flow contract as `onTaskEdit`.

- **`onTaskAdd(task, position)`** — fires for toolbar/menu/grid "Add task". `position.parent` is set for "Child task"; `position.insertAfter` is set for "Task above"/"Task below" (both SVAR menu items currently collapse to the same `insertAfter` semantics — see the known limitation below).
- **`onTaskDelete(id)`** — fires for toolbar/menu/hotkey "Delete task".
- **`onTaskReorder(id, direction)`** — fires for toolbar/menu "Move up"/"Move down" (`'up' | 'down'`).
- **`onTaskIndent(id, direction)`** — fires for toolbar/menu "Indent"/"Outdent" (`'indent' | 'outdent'`).
- **`onTaskSelect(id)`** (v1.4) — fires when a task bar or its grid row is selected (SVAR-native selection). Independent of `editMode`. Open a task panel on select instead of a dedicated edit-button column.

**Inline-editable grid columns (v1.4):** set `editable: true` on a `GanttColumn` to make its cell inline-editable (click to type) — **even when the column has a custom `render`**. It keeps the custom formatting for display and becomes an input on click, with edits flowing through `onTaskEdit` + the live CPM preview. Applies to `text`/`start`/`end`/`duration`/`progress` in `editMode`; `editable: false` forces read-only; unset keeps prior behavior (editable iff no `render`).

**Known limitation:** right-click **"Insert task above"** isn't yet distinguished from "Insert task below" — both currently insert after the target row (a follow-up for a future release).

**More editing hooks (v1.5):**

- **`onTaskEditRequest(id)`** — SVAR's built-in "Edit" context-menu item and task double-click both open SVAR's Editor modal. Wire this callback and the package vetoes that modal and hands you the id, so you can route the native Edit gesture to your own persisted editor without re-declaring the context menu. Independent of `editMode` / the `editor` prop.
- **`boldSummaryRows`** (default `true`) — bolds summary-task grid rows (MS-Project / P6 convention). Styling-only; applies in every mode. Set `false` to opt out.
- **`GanttColumn.editor` + `onCellEdit(id, columnId, value)`** — inline editing for **custom** (non-engine) columns. A column with `editor: { type: 'text' | 'select', options?, getValue }` becomes click-to-edit in `editMode`; commits fire `onCellEdit` (a parallel path to `onTaskEdit`) so consumers persist host-app fields (trade/sub/state) the engine doesn't model.

#### Bolt-in structural commit — `onStructuralCommit` (v1.3)

For consumers that want the package to own the **whole** structural round-trip (a "bolt-in" hierarchy
solution — the consumer persists, the package does everything else), wire a single callback instead of
the four `onTask*` bridges:

```tsx
<Gantt
  project={project}
  preset="msproject"
  onStructuralCommit={(changes, nextProject) => {
    for (const c of changes) {
      if (c.op === 'delete') db.deleteTask(c.id);
      else db.upsertTask(c.id, { parent: c.parent, sortOrder: c.orderIndex, type: c.type });
    }
    setProject(nextProject); // adopt the scheduled result
  }}
/>
```

When wired, `onStructuralCommit` **takes precedence over the individual `onTask*` callbacks** and covers
add · delete · **row drag-to-reorder** (now bridged) · indent/outdent. The package applies the engine
command, re-runs `schedule()`, and hands you every affected task's full post-op state (`id`, `parent`,
`orderIndex`, `type`, `op`) plus the scheduled `nextProject` — so you persist a mechanical mirror with
zero engine-semantics re-derivation. Deletes arrive as `op:'delete'` tombstones; all resequenced
siblings are emitted. Full spec: **[docs/persistence-contract.md](docs/persistence-contract.md)**.

---

### vs SVAR PRO — parity table

| Capability | @pyraxi/gantt | SVAR PRO |
|---|---|---|
| **Scheduling engine** | ✅ Full CPM (8 constraint types, negative slack, manual/auto, multi-baseline) | ⚠ Basic (forward pass only, no constraint types, no negative slack) |
| **Split tasks** | ✅ `Task.segments[]` + engine-aware bounds | ✅ Native |
| **Unscheduled tasks** | ✅ `Task.unscheduled` + engine skip | ✅ Native |
| **Toolbar** | ✅ `toolbar` prop (SVAR defaults or custom items) | ✅ |
| **Context menu** | ✅ `contextMenu` prop (SVAR defaults or custom) | ✅ |
| **Task editor form** | ✅ `editor` prop (SVAR defaults or custom fields) | ✅ |
| **Zoom** | ✅ `zoom` prop with named levels (day/week/month/etc.) | ✅ |
| **Tooltip** | ✅ `tooltip` render prop (receives scheduled Task) | ✅ |
| **Locale** | ✅ `locale` prop (partial string overrides) | ✅ |
| **NZ public holidays** | ✅ 13 regions, 2022–2052, Matariki | ❌ Not included |
| **MS Project MSPDI** | ✅ Round-trip (Tasks + Links + Calendars + Resources + Assignments + Baselines) | Limited |
| **Multi-baseline overlay** | ✅ Up to 11 baselines, simultaneous phantom rows | ❌ Single baseline |
| **Drag-to-link dependency creation** | ✅ `onLinkCreate` via drag handle | ✅ |
| **Inline cell editing** | ✅ `editMode` + `onTaskEdit` | ✅ |
| **License** | ✅ MIT | ❌ Commercial (from ~$700) |

**Engine exceeds. Chrome at parity. Construction-vertical is the moat.**

---

### Multi-baseline view (v0.2)

```tsx
import { Gantt, captureBaseline, type Project } from '@pyraxi/gantt';

// Capture each agreed programme as a baseline; up to 11 baselines per project.
const withB0 = captureBaseline(scheduledContract, 0, { name: 'Original contract' });
const withB1 = captureBaseline(scheduledReprogramme, 1, { name: 'Variation 1' });
const live = scheduleWithFurtherDrift(withB1);

// Overlay both baselines beneath every live task. Each phantom row carries
// its own variance pill (working-minutes ahead of / behind plan), per the
// NZS 3910 / AS 4000 variation-claim delay-analysis workflow.
<Gantt project={live} baselineIndices={[0, 1]} />
```

Single-baseline mode (the existing `baselineIndex={0}` shape or `baselineIndices={[0]}`) keeps the pill on the live bar. Multi-baseline mode (`baselineIndices.length > 1`) emits one phantom row per (task × baseline) pair, each phantom carrying its own variance pill against the live task. The label on each phantom shows the baseline's `name` (or `Baseline N` fallback) + formatted `capturedAt`. Per-baseline CSS class `.construction-gantt-baseline-${N}` ships with a default palette for indices 0–10; consumers override via higher specificity. The deprecated `baselineIndex` prop continues to work and is removed at v1.0.

## What this is

A drop-in React Gantt component aimed at construction project managers and the people building tooling for them. Three layers:

### Scheduling engine — the differentiator

Where every existing tool (SaaS, desktop, and library — open-source or commercial) silently clips edge cases, we get them right:

- All 8 MS Project constraint types: ASAP, ALAP, MSO, MFO, SNET, SNLT, FNET, FNLT
- **Negative slack** surfaced as a first-class signal, not clipped to zero (the contract-trouble indicator every existing alternative hides)
- Manual-vs-auto schedule toggle per task (matches MS Project 2010+ default behaviour)
- Summary-task duration computed correctly: `max(child finish) − min(child start)`, never sum
- Working-time calendar with **partial-day shifts** and **per-resource exceptions**
- Multi-baseline data model — up to 11 baselines, matching MS Project's `Baseline 0–10`
- Forward / backward pass critical-path computation with multiple-path support

### MS Project compatibility — the bridge

- MSPDI XML import + export (pure TypeScript, ~85-90% scheduling-data fidelity ceiling)
- Optionally **Primavera P6 XML** — unclaimed in the MIT React tier; standard in commercial NZ/AU construction (used by Procore and major GCs)
- `.mpp` binary import deferred to v0.4+ if requested (requires MPXJ sidecar — LGPL Java, no Node port)

### Construction-vertical — the moat

What MS Project users work around manually today:

- **NZ public holidays** with regional anniversaries (Auckland, Canterbury, Wellington, etc.) — per-region calendar sets
- **Partial-day calendars** (7am–3pm concreting shifts; sub-trade-specific working time)
- **First-class weather buffer widget** — auto-decrement against historical weather data for location + time of year (vs MS Project's manual "Adverse Weather Reserve" task hack)
- **Sub-contractor resource calendars** (plasterer on 4-day weeks, concreter no-pour-after-2pm)
- **Multi-baseline UI for variation-claim delay analysis** — overlay multiple captured baselines simultaneously (NZS 3910 / AS 4000); see [Multi-baseline view](#multi-baseline-view-v02) below
- **Milestone-as-billing-event hooks** for tying programme milestones to payment claims

## Why

The MIT React Gantt slot in 2026 is empty between *"renders a bar chart"* (frappe-gantt, ~39k weekly downloads, no PM-grade features) and *"schedules a real construction programme"* (Bryntum / DHTMLX / Syncfusion / SVAR PRO, $700–$40k commercial). Construction PM software teams who want a serious component either pay enterprise pricing or accept a tool that can't schedule a real project.

This component fills that gap. Built on top of free [SVAR React Gantt](https://svar.dev/) (MIT) for rendering — drag, hierarchy, time-scale, themes — with our own pure-TypeScript scheduling engine, MS Project file-format compatibility, and construction-vertical extensions on top.

## Architecture

See [`DECISIONS.md`](./DECISIONS.md). Foundational ADRs accepted 2026-05-15:

- **ADR-001** — stack baseline (pnpm 11 workspaces, bunchee, Storybook 10, Vitest, Biome, Node 24, changesets)
- **ADR-002** — SVAR wrapper strategy (use SVAR's renderer via slots; build our own scheduling engine; SVAR-agnostic public API)
- **ADR-003** — positioning ("MIT React Gantt with a real scheduling engine + MS Project-compatible + construction-vertical")
- **ADR-004** — license and monetization (MIT through v1.0; commercial optionality reserved post-v1)

## Roadmap

See [`ROADMAP.md`](./ROADMAP.md) for the v0.1 → v1.0 path (~2-3 months of weekend work to v1.0 public npm).

## Migrating from frappe-gantt

If you're using `frappe-gantt` in a construction PM product and need real scheduling-engine behaviour, this is built for you. See the direct migration guide: [`docs/migrating-from-frappe-gantt.md`](./docs/migrating-from-frappe-gantt.md).

## License

MIT — see [`LICENSE.md`](./LICENSE.md).

Consumers must also accept free SVAR React Gantt's MIT license. Full third-party attributions ship in [`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md) alongside this package.

Per ADR-004, the project is MIT through v1.0. A commercial tier (open-core, dual-license, or source-available shift for future versions) is reserved as a post-v1 option but not committed.

## Author & ownership

Rips Cassels — **Pyraxis-owned** IP. Published under the `@pyraxi` scope (Pyraxi Schedule).
