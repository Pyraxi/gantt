# Pyraxi CPM Engine — `@pyraxi/cpm-engine`

> Headless construction scheduling engine. Forward/backward critical-path pass, all 8 MS Project constraint types, negative slack, working-time calendars, baselines, MSPDI interop, command-pattern editing model. **Pure TypeScript — no React, no DOM, no renderer.**

This is the framework-agnostic engine behind [`@pyraxi/gantt`](https://www.npmjs.com/package/@pyraxi/gantt) (the SVAR React view). Use it directly for server-side scheduling, a custom renderer, or any non-React frontend.

## Install

```bash
npm install @pyraxi/cpm-engine
```

Zero peer dependencies. One runtime dependency (`fast-xml-parser`, for MSPDI).

## Quick start

```ts
import { schedule, type Project } from '@pyraxi/cpm-engine';

const scheduled = schedule(project); // forward+backward CPM pass; every task gets `computed`
```

## What's in it

- **Scheduling engine** — forward + backward pass, all 8 MS Project constraint types, negative slack, float, manual/auto mode, summary aggregation, critical path. Pure, synchronous.
- **Working-time calendars** — partial-day shifts, holiday exceptions; NZ public holidays pre-seeded (13 regions, 2022–2052).
- **Baselines** — capture + variance (multi-baseline, MS Project–compatible).
- **MSPDI XML interop** — `parseMspdi` / `serializeMspdi` (Tasks, links, calendars, resources, assignments, baselines, deadlines).
- **Editing model** — command-pattern `EditCommand` factories + draft/history primitives (the React bindings live in `@pyraxi/gantt`).
- **Deadlines, split/unscheduled tasks, duration units, `Task.extra` carry-through.**

For a ready-to-render React Gantt, install `@pyraxi/gantt` (depends on this).

## License

MIT © Euripides Cassels / Pyraxis. See [LICENSE.md](./LICENSE.md).

---

Part of **[Pyraxi](https://github.com/Pyraxi)** — Pyraxis's construction software.
