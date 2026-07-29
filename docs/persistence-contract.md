# Persistence Contract (bolt-in structural hierarchy)

**Status:** stable as of `@pyraxi/gantt` 1.3.0 · realizes ADR-010 · versioned with the package.

This is the authoritative definition of what a persistence-only consumer stores when it adopts
`@pyraxi/gantt` as a **bolt-in** hierarchy solution: the package owns every structural interaction
(add · delete · row drag-reorder · indent/outdent · paste); the consumer owns storage and mirrors a
mechanical projection of the package's output — **no engine semantics re-derived consumer-side.**

## The one callback

```ts
onStructuralCommit?: (changes: StructuralChange[], nextProject: Project) => void;
```

Wired on `<Gantt>`, it becomes the single path for structural gestures and **takes precedence over
the thin `onTask*` callbacks** (which remain supported for non-bolt-in consumers). For each completed
gesture the package applies the matching engine command, re-runs `schedule()`, and emits:

- **`changes`** — every task the gesture affected, in canonical post-op form (below).
- **`nextProject`** — the scheduled result. Adopt it to re-render; SVAR's optimistic mutation is
  vetoed, so nothing appears until you do.

## `StructuralChange`

```ts
type StructuralOp = 'add' | 'delete' | 'move' | 'indent' | 'outdent' | 'paste';

interface StructuralChange {
  id: TaskId;
  parent: TaskId | null;   // canonical hierarchy pointer; null = top-level
  orderIndex: number;      // 0-based position among same-parent siblings; -1 for tombstones
  type: TaskType;          // 'task' | 'summary' | 'milestone' — carries leaf↔summary flips
  op: StructuralOp;
}
```

### Canonical invariants (frozen — CM-confirmed 2026-07-05)

1. **`op:'delete'` ⟺ the task is absent from `nextProject`.** Removed rows (and every descendant of a
   removed subtree) arrive as tombstones: `{ id, parent, orderIndex: -1, type, op: 'delete' }`. Delete
   the mirror rows; do **not** expect them in `nextProject.tasks`.
2. **`op:'add'` ⟺ the task is new in `nextProject`** (absent from the pre-op project).
3. **Otherwise `op` is the positional gesture** (`move` / `indent` / `outdent` / `paste`). Informational
   for the mirror — persistence keys on `parent` + `orderIndex` + `type`, not on which gesture ran.
4. **Reindex breadth = all resequenced siblings.** A gesture emits **every** task whose `orderIndex`
   changed under the affected parent(s), not just the acted-on task — so a `sort_order` mirror stays
   gap-free with no consumer recompute.
5. **`parent` is normalized to `null`** for top-level (the engine's internal `undefined` never leaks).
6. **`orderIndex`** is position among same-`parent` siblings in `nextProject.tasks` array order.

### Mechanical mirror (reference: CM's relational schema)

```
for (const c of changes) {
  if (c.op === 'delete') deleteRow(c.id);
  else upsertRow(c.id, { parent_task_id: c.parent, sort_order: c.orderIndex, type: c.type });
}
adopt(nextProject); // re-render
```

`nextProject` is already scheduled — pass it back with `preScheduled` (or re-render from it directly)
to skip a redundant `schedule()` on the next render. Deleting a summary **cascades**: its whole
subtree is removed and every descendant arrives as an `op:'delete'` tombstone (no orphaned `parent`
pointers survive in `nextProject`).

Storage stays consumer-side; task rows remain load-bearing for downstream systems (budgets, claims,
ERP). This contract defines *what* is persisted, not *where*.

## Supporting engine surface (documented + stable)

The engine exports the pieces a consumer building its own draft/publish layer around this contract
relies on; these are now part of the stable, package-versioned surface:

- **`DraftProject`** — a mutable draft wrapper over a `Project` for staging structural edits.
- **`EditCommand`** — the pure `apply(project) → project` + invertible `inverse()` command contract
  every mutation flows through (ADR-006).
- **`CommitResult`** — the outcome of committing queued edits.
- **`SubtreeClipboard`** + `copySubtree` / `pasteSubtree` — cut/copy/paste of a task subtree.
- Structural factories: `createTask` (auto-promotes a leaf parent to summary on add-child),
  `moveTaskTo(id, {parent, index})` (positional reparent+reorder), `indentTask` / `outdentTask`,
  `deleteTask`, `moveTask`.

## Round-trip guarantee

Flat rows carrying `parent` + sibling order in → an identical `Project` out, including through MSPDI
import/export (`parseMspdi` / `serializeMspdi`). `type` transitions (leaf ↔ summary) follow the
promotion/demotion rules the engine applies on indent/outdent and add-child.

## Gesture → change-set examples

| Gesture | Emitted `changes` |
|---|---|
| Add child under a leaf `p` | new child `{op:'add'}` + `p` `{type:'summary', op:'move'}` |
| Delete `b` from `[a,b,c]` | `b` `{op:'delete'}` + `c` `{orderIndex:1, op:'move'}` |
| Indent `a` under preceding `p` | `p` `{type:'summary', op:'indent'}` + `a` `{parent:'p', op:'indent'}` |
| Drag `c` above `a` in `[a,b,c]` | `c` `{orderIndex:0, op:'move'}` + `a` + `b` (resequenced) |

See ADR-010 and `docs/superpowers/specs/2026-07-04-bolt-in-structural-commit-design.md` for the design
rationale.
