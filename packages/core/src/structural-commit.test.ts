import type { Project, Task, TaskType } from '@pyraxi/cpm-engine';
import {
  createTask,
  deleteTask,
  indentTask,
  moveTask,
  moveTaskTo,
  nzDefaultCalendar,
  outdentTask,
  schedule,
} from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { buildStructuralCommit, diffStructural, resolveAddPosition } from './structural-commit.js';

const deps = { schedule, createTask, deleteTask, moveTask, moveTaskTo, indentTask, outdentTask };

function task(id: string, type: TaskType = 'task', parent?: string): Task {
  return {
    id,
    text: id,
    type,
    scheduleMode: 'auto',
    duration: 540,
    start: new Date(2026, 0, 5),
    end: new Date(2026, 0, 5),
    progress: 0,
    ...(parent ? { parent } : {}),
  };
}
function project(tasks: Task[]): Project {
  return {
    start: new Date(2026, 0, 5),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [nzDefaultCalendar({ years: 2026, id: 'std' })],
    baselines: [],
    assignments: [],
  };
}

describe('diffStructural', () => {
  test('added task → op:add with orderIndex among siblings', () => {
    const prev = project([task('a')]);
    const next = project([task('a'), task('b')]);
    const changes = diffStructural(prev, next, 'move');
    expect(changes).toEqual([{ id: 'b', parent: null, orderIndex: 1, type: 'task', op: 'add' }]);
  });

  test('removed task → op:delete tombstone', () => {
    const prev = project([task('a'), task('b')]);
    const next = project([task('a')]);
    const changes = diffStructural(prev, next, 'move');
    expect(changes).toEqual([
      { id: 'b', parent: null, orderIndex: -1, type: 'task', op: 'delete' },
    ]);
  });

  test('reordered siblings → each resequenced task emitted with the gesture op', () => {
    const prev = project([task('a'), task('b'), task('c')]);
    const next = project([task('c'), task('a'), task('b')]);
    const changes = diffStructural(prev, next, 'move');
    // c:0 (was 2), a:1 (was 0), b:2 (was 1) — all three changed index
    expect(changes).toEqual([
      { id: 'c', parent: null, orderIndex: 0, type: 'task', op: 'move' },
      { id: 'a', parent: null, orderIndex: 1, type: 'task', op: 'move' },
      { id: 'b', parent: null, orderIndex: 2, type: 'task', op: 'move' },
    ]);
  });

  test('indent → moved task reparents + parent flips to summary, both emitted', () => {
    const prev = project([task('p'), task('a')]);
    const next = project([task('p', 'summary'), task('a', 'task', 'p')]);
    const changes = diffStructural(prev, next, 'indent');
    expect(changes).toEqual([
      { id: 'p', parent: null, orderIndex: 0, type: 'summary', op: 'indent' },
      { id: 'a', parent: 'p', orderIndex: 0, type: 'task', op: 'indent' },
    ]);
  });

  test('delete gesture: removed row tombstoned, reindexed survivor labelled move', () => {
    const prev = project([task('a'), task('b'), task('c')]);
    const next = project([task('a'), task('c')]);
    // caller passes the survivor op ('move'); removal forces op:'delete'
    const changes = diffStructural(prev, next, 'move');
    expect(changes).toEqual([
      { id: 'b', parent: null, orderIndex: -1, type: 'task', op: 'delete' },
      { id: 'c', parent: null, orderIndex: 1, type: 'task', op: 'move' },
    ]);
  });

  test('unchanged task emits nothing', () => {
    const prev = project([task('a'), task('b')]);
    const next = project([task('a'), task('b')]);
    expect(diffStructural(prev, next, 'move')).toEqual([]);
  });
});

describe('buildStructuralCommit', () => {
  test('delete → tombstone change + task removed from nextProject', () => {
    const p = project([task('a'), task('b')]);
    const out = buildStructuralCommit(p, { kind: 'delete', id: 'b' }, deps)!;
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['a']);
    expect(out.changes).toContainEqual(expect.objectContaining({ id: 'b', op: 'delete' }));
  });

  test('indent → parent promoted + child reparented, both in changes', () => {
    const p = project([task('p'), task('a')]);
    const out = buildStructuralCommit(p, { kind: 'indent', id: 'a', direction: 'indent' }, deps)!;
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'p', type: 'summary', op: 'indent' }),
    );
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'a', parent: 'p', op: 'indent' }),
    );
  });

  test('reorder before → moveTaskTo applied, orderIndex reflects new position', () => {
    const p = project([task('a'), task('b'), task('c')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'reorder', id: 'c', target: 'a', mode: 'before' },
      deps,
    )!;
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'c', orderIndex: 0, op: 'move' }),
    );
  });

  test('reorder "before" past a leading null-parent sibling → index matches moveTaskTo grouping', () => {
    // Mirror of the resolveAdd null-parent regression. CM persists a null-parent
    // sentinel, so top-level tasks can mix parent:null and undefined. Dragging
    // `b` before `a` with a null-parent `n` ahead: the old norm()-merged group
    // [n, a] gave index 1, but moveTaskTo's strict undefined-group is [a] only →
    // index 1 clamps to append and `b` stays AFTER `a` (visible half-way revert).
    // Strict grouping now matches, so `b` lands directly before `a`.
    const nullParent = { ...task('n'), parent: null as unknown as undefined };
    const undef = (id: string) => ({ ...task(id), parent: undefined });
    const p = project([nullParent, undef('a'), undef('b')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'reorder', id: 'b', target: 'a', mode: 'before' },
      deps,
    )!;
    const ids = out.nextProject.tasks.map((t) => t.id);
    expect(ids.indexOf('b')).toBeLessThan(ids.indexOf('a'));
  });

  test('reorder child → reparents under target, target promoted to summary', () => {
    const p = project([task('a'), task('b')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'reorder', id: 'b', target: 'a', mode: 'child' },
      deps,
    )!;
    expect(out.nextProject.tasks.find((t) => t.id === 'b')!.parent).toBe('a');
    expect(out.changes).toContainEqual(expect.objectContaining({ id: 'a', type: 'summary' }));
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'b', parent: 'a', op: 'move' }),
    );
  });

  test('add child under a leaf → new task op:add + promoted parent in changes', () => {
    const p = project([task('p')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'add', task: { id: 'x', text: 'X' }, target: 'p', mode: 'child' },
      deps,
    )!;
    expect(out.nextProject.tasks.map((t) => t.id)).toContain('x');
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'x', parent: 'p', op: 'add' }),
    );
    expect(out.changes).toContainEqual(expect.objectContaining({ id: 'p', type: 'summary' }));
  });

  test('add with no target → top-level append', () => {
    const p = project([task('a'), task('b')]);
    const out = buildStructuralCommit(p, { kind: 'add', task: { id: 'x', text: 'X' } }, deps)!;
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['a', 'b', 'x']);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'x', parent: null, orderIndex: 2, op: 'add' }),
    );
  });

  test('add "after" a nested task → sibling of target (keeps parent), placed below', () => {
    const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b', 'task', 'p')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'add', task: { id: 'x', text: 'X' }, target: 'a', mode: 'after' },
      deps,
    )!;
    // x nests under p (NOT top-level) and sits between a and b.
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['p', 'a', 'x', 'b']);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'x', parent: 'p', orderIndex: 1, op: 'add' }),
    );
    // b was displaced down a slot → emitted with its new orderIndex.
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'b', parent: 'p', orderIndex: 2, op: 'move' }),
    );
  });

  test('add "before" a nested task → sibling placed above (distinct from after)', () => {
    const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b', 'task', 'p')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'add', task: { id: 'x', text: 'X' }, target: 'b', mode: 'before' },
      deps,
    )!;
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['p', 'a', 'x', 'b']);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'x', parent: 'p', orderIndex: 1, op: 'add' }),
    );
  });

  test('add "before" the first task → prepends at index 0 (the insertAfter-can\'t case)', () => {
    const p = project([task('a'), task('b')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'add', task: { id: 'x', text: 'X' }, target: 'a', mode: 'before' },
      deps,
    )!;
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['x', 'a', 'b']);
    expect(out.changes).toContainEqual(
      expect.objectContaining({ id: 'x', parent: null, orderIndex: 0, op: 'add' }),
    );
  });

  test('add "before" past a leading null-parent sibling → index matches moveTaskTo grouping', () => {
    // A consumer (CM persists a null-parent sentinel) can hand us top-level tasks
    // mixing parent:null and undefined. With a null-parent sibling AHEAD of the
    // target, the norm()-merged group would over-count the target's index; the
    // strict grouping resolveAdd now uses matches how moveTaskTo applies it, so
    // "before b" lands x directly above b instead of being shoved past it.
    const nullParent = { ...task('n'), parent: null as unknown as undefined };
    const p = project([nullParent, task('a'), task('b')]);
    const out = buildStructuralCommit(
      p,
      { kind: 'add', task: { id: 'x', text: 'X' }, target: 'b', mode: 'before' },
      deps,
    )!;
    // Fixed: x immediately before b. Pre-fix (norm index 2, applied to strict
    // group of 2) → insertAt past b → [n, a, b, x].
    const ids = out.nextProject.tasks.map((t) => t.id);
    expect(ids.indexOf('x')).toBe(ids.indexOf('b') - 1);
  });

  test('delete a summary cascades: whole subtree tombstoned, no orphans left', () => {
    const p = project([
      task('p', 'summary'),
      task('a', 'task', 'p'),
      task('b', 'task', 'p'),
      task('z'),
    ]);
    const out = buildStructuralCommit(p, { kind: 'delete', id: 'p' }, deps)!;
    // Every removed row is a tombstone; none survive with a dangling parent.
    expect(out.nextProject.tasks.map((t) => t.id)).toEqual(['z']);
    for (const id of ['p', 'a', 'b']) {
      expect(out.changes).toContainEqual(expect.objectContaining({ id, op: 'delete' }));
    }
    expect(out.nextProject.tasks.some((t) => t.parent === 'p')).toBe(false);
  });

  test('reorder with unknown target → null (no crash)', () => {
    const p = project([task('a')]);
    expect(
      buildStructuralCommit(p, { kind: 'reorder', id: 'a', target: 'nope', mode: 'before' }, deps),
    ).toBeNull();
  });

  test('move/indent on a missing id → null, never throws (EditError swallowed)', () => {
    // Defence-in-depth: a phantom/stale id (e.g. a ghost row, numeric-vs-string
    // drift) reaching the engine command must not throw an uncaught EditError
    // inside SVAR's intercept dispatch — buildStructuralCommit returns null.
    const p = project([task('a')]);
    expect(() =>
      buildStructuralCommit(p, { kind: 'move', id: 'a__baseline_0', direction: 'up' }, deps),
    ).not.toThrow();
    expect(
      buildStructuralCommit(p, { kind: 'move', id: 'a__baseline_0', direction: 'up' }, deps),
    ).toBeNull();
    expect(
      buildStructuralCommit(
        p,
        { kind: 'indent', id: 'ghost__edit_preview', direction: 'indent' },
        deps,
      ),
    ).toBeNull();
  });
});

describe('resolveAddPosition (onTaskAdd shape)', () => {
  const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b', 'task', 'p')]);

  test('child → parent set, no insertAfter', () => {
    expect(resolveAddPosition(p, { target: 'p', mode: 'child' })).toEqual({ parent: 'p' });
  });
  test('after → sibling parent + insertAfter target', () => {
    expect(resolveAddPosition(p, { target: 'a', mode: 'after' })).toEqual({
      parent: 'p',
      insertAfter: 'a',
    });
  });
  test('before a middle sibling → insertAfter the previous sibling', () => {
    expect(resolveAddPosition(p, { target: 'b', mode: 'before' })).toEqual({
      parent: 'p',
      insertAfter: 'a',
    });
  });
  test('before the first sibling → insertAfter undefined (append fallback)', () => {
    expect(resolveAddPosition(p, { target: 'a', mode: 'before' })).toEqual({
      parent: 'p',
      insertAfter: undefined,
    });
  });
  test('no target → empty (top-level append)', () => {
    expect(resolveAddPosition(p, {})).toEqual({});
  });
  test('unknown target → empty (no crash)', () => {
    expect(resolveAddPosition(p, { target: 'nope', mode: 'after' })).toEqual({});
  });
});
