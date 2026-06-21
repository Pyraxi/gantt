# Exports — Input Contract

What `exportPNG / exportPDF / exportXLSX` actually read from a `Project`. Intended audience: consumers who want to call the export functions against a project shape they didn't necessarily get from running our scheduling engine end-to-end — typically a SVAR-direct adopter holding their own task model.

**Status:** stable for v0.1.0. If a future version reaches into additional fields, this doc gets updated in the same PR and a minor-bump changeset accompanies the change.

**Source-of-truth pointers** (read these if you're adapting a custom shape):
- `packages/core/src/export/xlsx.ts` — explicit field-by-field reads
- `packages/core/src/export/offscreen.tsx` — what the off-screen `<Gantt>` mount uses (PNG / PDF substrate)
- `packages/core/src/types.ts` — the canonical `Project` / `Task` / `Link` / etc. type definitions

---

## TL;DR

| Export | What it reads | Where the reading happens |
|---|---|---|
| **XLSX** | Field-by-field projection of `Project.tasks[*]` per a column spec | `xlsx.ts` (`buildSheetRows` + `DEFAULT_XLSX_COLUMNS`) |
| **PNG** | Whatever the rendered `<Gantt project={…} />` paints | Off-screen DOM mount + `html-to-image` snapshot |
| **PDF** | Whatever the PNG renders, embedded onto a PDF page | jsPDF wrapping the PNG output |

XLSX is the data-driven path with the tight contract documented below. PNG and PDF inherit the renderer's contract — i.e., a full `Project` that satisfies the `<Gantt>` prop type. If you can render the project, you can PNG/PDF it.

---

## XLSX — default columns

`exportXLSX({ scheduled, options })` produces one sheet (default name: `"Programme"`) with one row per `Project.tasks` entry. The default column set, in order:

| Header | Read from | Notes |
|---|---|---|
| `ID` | `task.id` | `TaskId = string \| number` |
| `Name` | `task.text` | `string`, required |
| `Start` | `task.start` | `Date`, required |
| `End` | `task.end` | `Date`, required |
| `Duration (working minutes)` | `task.duration` | `number` (minutes), required |
| `Critical` | `task.computed?.isCritical` | `'Y' \| 'N'`. If `computed` is absent, defaults to `'N'`. |
| `Total slack (working minutes)` | `task.computed?.totalSlack` | `number` (minutes). If `computed` is absent, defaults to `0`. |
| `Progress (%)` | `task.progress` | `0–100`, required |
| `Parent` | `task.parent ?? ''` | `TaskId \| ''`. Empty string when the task has no parent. |

**What this means for SVAR-direct adopters:** if your task shape doesn't carry `computed.isCritical / totalSlack`, the `Critical` and `Total slack` columns will be `'N'` and `0` for every row. You have two ways to fix this:

- Populate `task.computed` yourself before calling `exportXLSX`. The runtime check is `computed?.isCritical` — set `computed: { isCritical: boolean, totalSlack: number, … }` to the values your engine produced.
- Pass your own `XlsxColumn[]` via `options.columns` and project from whatever fields your task shape actually has.

## XLSX — custom columns

```ts
import type { XlsxColumn } from '@pyraxi/gantt';

const columns: XlsxColumn[] = [
  { header: 'WBS',        value: 'id' },
  { header: 'Activity',   value: 'text' },
  { header: 'Trade',      value: (t) => t.resourceIds?.[0] ?? '' },
  { header: 'Crew hours', value: (t) => t.duration / 60 },
];

await ref.current.exportXLSX({ columns });
```

`XlsxColumn.value` accepts either:

- A `keyof Task` string — the cell is `task[key]`, coerced via:
  - `Date` instances pass through (sheet sets `cellDates: true`)
  - `number | string` pass through
  - `undefined | null` becomes `''`
  - Everything else `String(…)`-coerces
- A function `(task: Task) => string | number | Date | undefined` — return value passes through identically, with `undefined` becoming `''`.

The function form is the recommended path for any custom shape because it stays explicit about which task fields you're reading.

---

## PNG / PDF — what the renderer reads

PNG and PDF capture the rendered `<Gantt>` via an off-screen DOM mount. The contract is "whatever a `<Gantt project={…} />` paints." Concretely, the `<Gantt>` component's prop surface (see `packages/core/src/Gantt.tsx` and the exported `GanttProps` type):

- `project: Project` — required
- `cellWidth?, cellHeight?, height?` — display sizing
- `markers?` — vertical markers (today line + arbitrary)
- `baselineIndex?`, `showBaselineBars?` — multi-baseline display
- `columns?` — left-rail grid column config (`GanttColumn[]`)
- `visibleTaskIds?` — render-only filter

The off-screen mount during export uses `preScheduled: true` to skip re-running our engine — assumes the passed `Project` is already populated with whatever scheduling results the renderer needs. Specifically, the engine populates `task.computed` (see `packages/core/src/types.ts` for the full shape):

```ts
interface TaskComputed {
  earlyStart: Date;
  earlyFinish: Date;
  lateStart: Date;
  lateFinish: Date;
  totalSlack: number;   // negative = late
  freeSlack: number;
  isCritical: boolean;
}
```

**What this means for SVAR-direct adopters:** the PNG/PDF path inherits SVAR's rendering contract for tasks, plus our component's overlays (critical-path styling, baseline ghost bars, float pills). If your task data lacks `computed`, the critical-path / float overlays simply don't render — bars still draw from `start` / `end`. You're free to populate `computed` from your own engine's output before calling `exportPNG / exportPDF`.

---

## Project shape — minimum fields required

For all three exports to work without errors:

```ts
interface Project {
  start: Date;                       // Project anchor for the timeline
  end?: Date;                        // Optional finish anchor
  defaultCalendarId: CalendarId;     // Used by the engine, ignored by XLSX
  tasks: Task[];                     // The thing we iterate
  links: Link[];                     // Renderer draws dependency arrows
  resources: Resource[];             // Used by render only if columns reference them
  calendars: Calendar[];             // Engine input; required to exist (can be empty list)
  baselines: Baseline[];             // Required to exist (can be empty list)
  assignments: Assignment[];         // Required to exist (can be empty list — v0.2 added this)
}

interface Task {
  id: TaskId;                        // XLSX reads, renderer keys by it
  text: string;                      // XLSX 'Name', renderer label
  type: 'task' | 'summary' | 'milestone';
  scheduleMode: 'auto' | 'manual';
  duration: number;                  // Working-minutes; XLSX 'Duration'
  start: Date;                       // XLSX 'Start', renderer bar origin
  end: Date;                         // XLSX 'End', renderer bar terminus
  progress: number;                  // 0–100; XLSX 'Progress (%)'
  computed?: TaskComputed;           // Optional but populated when engine ran
  parent?: TaskId;                   // XLSX 'Parent', renderer hierarchy
  // …other fields ignored by exports unless you write a custom column reader
}
```

If your shape is leaner (e.g., a SVAR-direct adopter holding `{ id, text, start, end, duration, progress }` only), you can build a `Project`-shaped wrapper at the call site with empty arrays for `links / resources / calendars / baselines / assignments` and an `id`-only `defaultCalendarId`. The exports run; XLSX defaults to `'N' / 0` on the engine-derived columns; PNG/PDF render without overlays.

---

## What the exports do NOT touch

For confidence about adapter scope, the export pipeline does not read:

- `Task.constraint` (any field) — only matters to the scheduling engine
- `Task.resourceIds` (unless your custom XLSX column reader looks at them)
- `Task.calendarId`
- `Link.*` (PNG/PDF inherit whatever the renderer draws; XLSX doesn't touch links at all)
- `Resource.*` (renderer slot only, not the data path)
- `Baseline.*` (only if `baselineIndex` is set and a baseline bar overlay is requested; XLSX doesn't touch them)
- `Assignment.*` (the v0.2 addition; pure data field, not read by exports)

---

## Adapter sketch — minimum viable Project from a custom task shape

For a SVAR-direct adopter holding `MyTask[]`:

```ts
import type { Project, Task, CalendarId } from '@pyraxi/gantt';

type MyTask = {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  workingMinutes: number;
  percentComplete: number;
  parentId?: string;
};

function adaptToProject(myTasks: MyTask[], projectStart: Date): Project {
  const calendarId: CalendarId = 'site';
  const tasks: Task[] = myTasks.map((mt) => ({
    id: mt.id,
    text: mt.name,
    type: 'task',
    scheduleMode: 'auto',
    duration: mt.workingMinutes,
    start: mt.startDate,
    end: mt.endDate,
    progress: mt.percentComplete,
    parent: mt.parentId,
    // computed: optionally populate from your engine
  }));

  return {
    start: projectStart,
    defaultCalendarId: calendarId,
    tasks,
    links: [],
    resources: [],
    calendars: [],
    baselines: [],
    assignments: [],
  };
}
```

This adapter satisfies all three exports. XLSX renders the default columns (Critical = 'N', Total slack = 0 since `computed` is absent). PNG/PDF render the bars without critical-path/baseline/float overlays. If your engine populates `computed`, populate those fields too.

---

## When this contract evolves

Any change to the field-reads documented above counts as a public-API change. The release process:

1. Add the field-read to the appropriate export module (xlsx.ts / png.ts / pdf.ts).
2. Update the corresponding section of this doc in the same commit.
3. Add a changeset (`pnpm changeset`) describing the field that's now read.

Until v1.0 we treat additions as `minor` bumps; field-read *removals* and behaviour changes are `minor` too (the package is pre-1.0). Post-v1.0 we'll honour semver properly.

---

## Standalone package

A `@pyraxi/gantt-exports` subpackage split is parked. If the seam causes pain for consumers who only need export functionality, we'll revisit.
