# Migrating from frappe-gantt

A guide for moving a React app off [frappe-gantt](https://github.com/frappe/gantt) onto `@pyraxi/gantt`.

frappe-gantt is a lightweight SVG bar-drawer: **you** compute every task's start and end, frappe draws the bars and emits drag callbacks. `@pyraxi/gantt` inverts that — you describe scheduling *intent* (durations, dependencies, constraints, a working-time calendar) and a real engine computes the dates, critical path, and slack for you.

That inversion is the whole migration. Most of the work is **deleting** date-math you currently maintain by hand.

---

## The mental-model shift

| | frappe-gantt | @pyraxi/gantt |
|---|---|---|
| Who computes dates | **You** (frappe just draws) | The **engine** (`schedule()` runs on every change) |
| Task duration | Implicit (`end − start`) | Explicit `duration`, in **working minutes** |
| Dates | `"YYYY-MM-DD"` strings | `Date` objects |
| Dependencies | `"id1, id2"` string, FS-only, no lag | `Link[]` — all 4 types (FS/SS/FF/SF) + lag |
| Hierarchy | none (flat list) | `parent` + `type: 'summary'` rollup |
| Milestones | zero-width bar by convention | `type: 'milestone'` |
| Calendars / non-working days | none (you pre-skip weekends) | `Calendar` with `workWeek` + `exceptions` |
| Critical path / slack | none | first-class (`computed.isCritical`, `totalSlack`, `freeSlack`) |
| Baselines | none | up to 11, MS Project–indexed |
| Edit callback | `on_date_change(task, start, end)` | `onTaskEdit(id, patch)` + `onLinkCreate` / `onLinkDelete` |
| Rendering | imperative `new Gantt(svg, tasks, opts)` | declarative `<Gantt project={...} />` |

The headline gotcha: **`duration` is in working minutes, not days, and `start`/`end` are `Date` objects, not strings.** An 8-hour working day is `480`; a 5-day task on a standard calendar is `2400`. Use the calendar helpers (below) rather than multiplying by hand — the engine respects weekends and holidays, so "5 days" is 5 *working* days, not 5 calendar days.

---

## Step 1 — the data shape

frappe takes a flat `Task[]`. @pyraxi/gantt takes a single `Project` that owns tasks, links, calendars, resources, and baselines:

```ts
import type { Project, Task, Link } from '@pyraxi/gantt';

interface Project {
  start: Date;                 // forward-pass anchor
  end?: Date;                  // optional backward-pass anchor
  defaultCalendarId: CalendarId;
  tasks: Task[];
  links: Link[];               // dependencies move OUT of the task, into here
  resources: Resource[];       // [] if unused
  calendars: Calendar[];
  baselines: Baseline[];       // [] if unused
  assignments: Assignment[];   // [] if unused
}
```

### Task field mapping

| frappe field | @pyraxi/gantt | Notes |
|---|---|---|
| `id` | `id` | `string \| number` |
| `name` | `text` | renamed |
| `start` (`"YYYY-MM-DD"`) | `start` (`Date`) | `new Date(str)` |
| `end` (`"YYYY-MM-DD"`) | `end` (`Date`) | `new Date(str)` |
| (implicit `end − start`) | `duration` (working **minutes**) | see Step 2 |
| `progress` (0–100) | `progress` | unchanged |
| `dependencies` (`"a, b"`) | → `Project.links` | leaves the task entirely |
| `custom_class` | (drop) | styling is engine/theme-driven; use `columns` or CSS hooks |
| — | `type` | `'task' \| 'summary' \| 'milestone'` — required |
| — | `scheduleMode` | `'auto' \| 'manual'` — required; default `'auto'` |

Minimum viable `Task`:

```ts
const t: Task = {
  id: 'foundations',
  text: 'Foundations',
  type: 'task',
  scheduleMode: 'auto',
  duration: 2400,            // 5 working days @ 480 min/day
  start: new Date('2026-07-01'),
  end: new Date('2026-07-07'),
  progress: 0,
};
```

For `scheduleMode: 'auto'` tasks you can pass rough `start`/`end` — the engine overwrites them from the dependency graph and calendar. They're only authoritative for `'manual'` tasks. (Mirrors frappe, where every date was authoritative because there was no engine.)

### Dependencies → links

frappe's `dependencies: "predecessor_id"` is finish-to-start with no lag. Expand each into a `Link`:

```ts
function frappeDepsToLinks(tasks: { id: string; dependencies?: string }[]): Link[] {
  const links: Link[] = [];
  for (const t of tasks) {
    for (const dep of (t.dependencies ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      links.push({ id: `${dep}->${t.id}`, source: dep, target: t.id, type: 'FS', lag: 0 });
    }
  }
  return links;
}
```

`lag` is in working minutes too (positive = delay, e.g. a 3-day concrete cure; negative = lead). Once migrated you can use `SS`/`FF`/`SF` and lag, which frappe could not express.

---

## Step 2 — durations and the calendar

Stop hand-skipping weekends. Build a calendar and let the engine do working-time arithmetic.

```ts
import { nzDefaultCalendar, workingMinutesBetween, addWorkingMinutes } from '@pyraxi/gantt';

const cal = nzDefaultCalendar({ years: [2026, 2027], region: 'auckland' }); // Mon–Fri 8–5 + NZ statutory holidays
```

Convert a frappe `start`/`end` pair into a `duration`, or a `start` + day-count into an `end`:

```ts
// frappe gave you both dates → derive working-minute duration
const duration = workingMinutesBetween(new Date(f.start), new Date(f.end), cal);

// or: you know "5 working days" → let the calendar place the end
const end = addWorkingMinutes(new Date(f.start), 5 * 480, cal);
```

If your app isn't in New Zealand, build a `Calendar` directly — `workWeek` is 7 entries of `WorkInterval[]` (`{ startMinutes, endMinutes }`), empty array = non-working day; `exceptions` are your holidays. See [README](../README.md) → working-time calendars.

---

## Step 3 — rendering

Replace the imperative frappe mount:

```ts
// before (frappe)
new Gantt('#gantt', tasks, { view_mode: 'Week', on_date_change });
```

with the declarative component. Read-only is just a `Project`:

```tsx
import { Gantt } from '@pyraxi/gantt';

<Gantt project={project} />   // engine runs internally; SVAR's free React Gantt renders
```

### Custom columns (your frappe left-rail / popups)

If you rendered custom HTML in frappe's popup or a sidebar, port it to `GanttColumn[]`:

```tsx
import type { GanttColumn } from '@pyraxi/gantt';

const columns: GanttColumn[] = [
  { id: 'text', header: 'Task', field: 'text', width: 240 },
  { id: 'trade', header: 'Trade', width: 120, render: ({ task }) => <TradeChip task={task} /> },
];

<Gantt project={project} columns={columns} />
```

---

## Step 4 — editing (replacing `on_date_change`)

frappe emitted `on_date_change(task, start, end)` after a drag and left persistence to you. @pyraxi/gantt is the same shape, split by intent. Turn on `editMode` and wire the callbacks to your existing save logic:

```tsx
<Gantt
  project={project}
  editMode
  onTaskEdit={(id, patch) => saveTask(id, patch)}        // patch: Partial<{text,start,end,duration,progress,scheduleMode}>
  onLinkCreate={(source, target, type) => saveLink({ source, target, type })}
  onLinkDelete={(linkId) => deleteLink(linkId)}
/>
```

Your persistence layer (DB writes, optimistic-concurrency, server actions) is untouched — these callbacks are the *trigger*, exactly as `on_date_change` was. The difference: an edit re-runs the engine, so downstream tasks reschedule and the critical path updates before your callback fires.

For client-side undo/redo and a draft overlay, wrap state in `useEditableProject` (see [README](../README.md) → quick start) instead of managing `project` yourself.

---

## Step 5 — things frappe didn't have (free upside)

Once migrated, these come for nothing — no extra wiring:

- **Critical path** — `task.computed?.isCritical`, red bars by default.
- **Slack signals** — `computed.totalSlack` (negative = "Nd late", the contract-trouble signal), `computed.freeSlack`.
- **Constraints** — `task.constraint` with all 8 MS Project types (MSO/MFO/SNET/…).
- **Baselines** — capture a snapshot, get `±Nd` variance bars vs plan.
- **Split + unscheduled tasks** — `Task.segments[]` (weather-paused work), `Task.unscheduled` (planned-but-undated grid rows).
- **MS Project interop** — `parseMspdi` / `serializeMspdi` round-trip to `.xml`.

---

## Carrying domain fields

frappe let you stuff arbitrary keys onto a task object. `@pyraxi/gantt`'s `Task` is a closed scheduling shape, but it carries an opaque **`extra?: Record<string, unknown>`** bag for exactly this. The engine never reads or writes it — it's preserved untouched through `schedule()` and the edit pipeline (including undo/redo).

- **Display fields** (trade, status, sub-contractor, cost) → put them in `task.extra` and read them in `GanttColumn.render` via `task.extra?.yourField`.
- **Round-trip-only fields** (external IDs you never show) → also fine in `task.extra`; on MSPDI serialize, keys with no MS Project home are reported in `droppedFields` rather than silently lost.

---

## Gotcha checklist

- [ ] `duration` is **working minutes**, not days — use `workingMinutesBetween` / `addWorkingMinutes`, don't `× 86400000`.
- [ ] `start` / `end` are `Date`, not `"YYYY-MM-DD"` strings.
- [ ] `name` → `text`; `dependencies` string → `Project.links`.
- [ ] Every task needs `type` and `scheduleMode` (default `'task'` / `'auto'`).
- [ ] Stop pre-skipping weekends — the calendar does it. Feeding pre-skipped dates *and* a working calendar double-counts.
- [ ] `auto` tasks' `start`/`end` are advisory; the engine overwrites them. Set `scheduleMode: 'manual'` to pin a date.
- [ ] Dependencies are FS by default with `lag: 0` — set `type`/`lag` to use what frappe couldn't.
