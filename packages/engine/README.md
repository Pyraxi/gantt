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

## MS Project stable-id round-trip

MS Project renumbers UIDs freely and needs them to be integers, so a host's own task id can't travel as the UID. Carry it in a Text custom field instead, and let the serializer emit integer UIDs:

```ts
import { parseMspdi, serializeMspdi, type IdRemapEntry } from '@pyraxi/cpm-engine';

const idRemap: IdRemapEntry[] = []; // optional: original id → emitted UID, per namespace
const xml = serializeMspdi(project, {
  remapIdsToIntegers: true,
  idRemap,
  extendedAttributes: [{ field: 'Text1', extraKey: 'hostTaskId' }], // Task.extra.hostTaskId → Text1
});

// …edited in MS Project and saved as XML…
const { project: edited } = parseMspdi(savedXml);
edited.tasks.forEach((t) => t.extra?.hostTaskId); // your merge key (undefined = a task added in MS Project)
```

Parse keys each value onto the field's alias (`alias` defaults to `extraKey`), so set an `alias` only if you want MS Project to show a different name, and then read the value back as `extra[alias]`. Re-serializing a parsed project with the same mapping still writes it. Values are trimmed on parse, and MS Project caps Text fields at 255 characters.

References to ids that aren't in the project (a link to a missing task, an assignment to a missing resource, a `calendarId` with no calendar) are never written; they're reported in `droppedFields` instead.

## MS Project outline codes (activity codes)

`Project.codeTypes` / `Task.codes` (trade, area, subcontractor) travel as MS Project **outline codes**, so a programme grouped by trade in MS Project keeps its grouping, and so does yours:

```ts
const xml = serializeMspdi(project, {
  outlineCodes: [
    { codeTypeId: 'trade', field: 1 }, // → Outline Code1, shown in MS Project as the code type's name
    { codeTypeId: 'area', field: 2 },
  ],
});
const { project: back } = parseMspdi(xml); // codeTypes + task codes, keyed by name
```

- **Parse needs no config.** Every task outline code becomes a code type, named by its alias, and each task's value lands in `codes[name]`. Hierarchical values read as their full path (`SITE.ELEC`).
- **Code type ids after a round-trip:** a code type comes back with `id` equal to its `name`, since MS Project keeps only the alias.
- **Values outside the table:** a task value not in the code type's `values` is added to the lookup table.
- **Reported in `droppedFields`:** unmapped code types, task codes with no code type, and value colours, which MSPDI has no field for.
- **Field ids:** we write both the `ValueID` (Project 2003, MPXJ) and the `ValueGUID` (Project 2007+) forms. GUIDs are stable across exports.

## License

MIT © Rips Cassels / Pyraxis. See [LICENSE.md](./LICENSE.md).

---

Part of **[Pyraxi](https://github.com/Pyraxi)** — Pyraxis's construction software.
