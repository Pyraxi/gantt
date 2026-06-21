# @pyraxi/gantt

## 1.0.0

First public release of Pyraxi Schedule — an MIT React Gantt that ships a real scheduling engine, not just a renderer.

- **Scheduling** — forward/backward critical-path pass, all 8 MS Project constraint types, negative slack, float, manual/auto mode, summary aggregation. Engine lives in [`@pyraxi/cpm-engine`](https://www.npmjs.com/package/@pyraxi/cpm-engine).
- **Working-time calendars** — partial-day shifts, holiday exceptions, NZ public holidays pre-seeded; non-working time shaded in the view.
- **Baselines** — capture + variance, multi-baseline, MS Project–compatible.
- **MSPDI XML interop** — round-trip of tasks, links, calendars, resources, assignments, baselines, deadlines.
- **Editing model** — typed `EditCommand` values with undo/redo via `useEditableProject`; engine re-runs on every effective state change.
- **Deadlines, split tasks, unscheduled tasks, mixed-unit durations, `Task.extra` carry-through.**
- **Exports** — PNG / PDF / XLSX via an imperative ref handle, full-project render regardless of scroll.
- **Rendering** — built on free [SVAR React Gantt](https://svar.dev/) (MIT) via slot composition; SVAR types stay out of the public API.
