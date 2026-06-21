# Pyraxi Schedule — `@pyraxi/gantt`

> An MIT-licensed React Gantt that ships a real scheduling engine — not just a renderer. MS Project interop (MSPDI). Built for construction.

A React Gantt component powered by the headless **[`@pyraxi/cpm-engine`](https://www.npmjs.com/package/@pyraxi/cpm-engine)** (the scheduling engine) and rendered with **[SVAR's free React Gantt](https://svar.dev/)** (MIT) under the hood. Want the engine without React — for a server, a job, or a different frontend? Install `@pyraxi/cpm-engine` directly.

## Install

```bash
npm install @pyraxi/gantt
# or: pnpm add @pyraxi/gantt  /  yarn add @pyraxi/gantt
```

Peer deps: `react` `^18 || ^19`, `react-dom` `^18 || ^19`.

## Quick start

```tsx
import { Gantt, useEditableProject, type Project } from '@pyraxi/gantt';

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

For read-only use, drop `useEditableProject` and pass a `Project` straight to `<Gantt>` — the engine still runs internally.

## What's in the box

`@pyraxi/gantt` re-exports the full `@pyraxi/cpm-engine` API and adds the React component on top:

- **Scheduling engine** (via `@pyraxi/cpm-engine`) — forward + backward pass, all 8 MS Project constraint types, first-class negative slack, manual-vs-auto schedule mode per task, summary-task aggregation, critical-path detection. The engine is pure TypeScript with a single runtime dependency.
- **Split + unscheduled tasks** — `Task.segments[]` for interrupted work (the weather-paused pour); `Task.unscheduled` for planned-but-undated line items (excluded from the pass, grid-only).
- **Working-time calendars** — partial-day shifts (7am–3pm concreting), holiday exceptions, per-resource overrides.
- **NZ public holidays pre-seed** — 13 statutory regions, years 2022–2052 (Matariki + Canterbury Show Day from primary sources).
- **Editing model** — `useEditableProject` hook with command-pattern edits, draft-state overlay, single-stack undo/redo with compound commits. Engine recomputes on every effective state change.
- **UX chrome** — toolbar, context menu, task editor form, scroll-wheel zoom, custom tooltips, locale overrides — all wired through a renderer-agnostic public API.
- **Exports** — PNG / PDF / XLSX via an imperative ref handle; full-project render regardless of on-screen scroll position.
- **MSPDI XML interop** — round-trip of Tasks + PredecessorLinks (all 4 dependency types + lag) + Calendars + Resources + Assignments + Baselines + Deadlines. ~85–90% scheduling-data fidelity (financial/view-state columns drop). Native `.mpp` binary import is available separately via `@pyraxi/gantt-mpp`.
- **Multi-baseline data model** — up to 11 baselines, MS Project–style baseline capture.
- **Consumer carry-through** — `Task.extra` opaque bag for host-app fields the engine doesn't model; preserved through `schedule()`, the edit pipeline, and MSPDI round-trips.
- **Custom columns** for WBS / trade package / any project field via `GanttColumn[]`.

## Styling

The component ships its own CSS (auto-injected). Engine-specific visual signals use the `construction-gantt-*` class prefix — e.g. per-baseline ghost rows are `construction-gantt-baseline-${N}` (indices 0–10), which you can override with higher-specificity rules.

## License

MIT © Euripides Cassels / Pyraxis. See [LICENSE.md](./LICENSE.md).

---

Part of **[Pyraxi](https://github.com/Pyraxi)** — Pyraxis's construction software. Renderer: [SVAR React Gantt](https://svar.dev/) (MIT).
