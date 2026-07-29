import { describe, expect, test } from 'vitest';
import type { Project, Task } from '../types.js';
import { moveTask } from './factories.js';

function task(id: string, parent?: string, type: Task['type'] = 'task'): Task {
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
    calendars: [],
    baselines: [],
    assignments: [],
  };
}
const ids = (p: Project) => p.tasks.map((t) => t.id);

describe('moveTask', () => {
  test('move down swaps with next sibling', () => {
    const p = project([task('a'), task('b'), task('c')]);
    expect(ids(moveTask('a', 'down').apply(p))).toEqual(['b', 'a', 'c']);
  });
  test('move up swaps with previous sibling', () => {
    const p = project([task('a'), task('b'), task('c')]);
    expect(ids(moveTask('c', 'up').apply(p))).toEqual(['a', 'c', 'b']);
  });
  test('only reorders within the same parent', () => {
    // b1,b2 are children of a; c is a top-level sibling of a.
    const p = project([task('a'), task('b1', 'a'), task('b2', 'a'), task('c')]);
    // moving b1 down swaps with b2 (its sibling), not with c.
    expect(ids(moveTask('b1', 'down').apply(p))).toEqual(['a', 'b2', 'b1', 'c']);
  });
  test('move up at top boundary is a no-op', () => {
    const p = project([task('a'), task('b')]);
    expect(ids(moveTask('a', 'up').apply(p))).toEqual(['a', 'b']);
  });
  test('move down at bottom boundary is a no-op', () => {
    const p = project([task('a'), task('b')]);
    expect(ids(moveTask('b', 'down').apply(p))).toEqual(['a', 'b']);
  });
  test('missing task throws', () => {
    expect(() => moveTask('zzz', 'up').apply(project([task('a')]))).toThrow();
  });
  test('inverse restores original order when the moved task has children', () => {
    // X is a summary with children m1, m2; Y and n1 are unrelated top-level siblings.
    const original = project([
      task('X', undefined, 'summary'),
      task('m1', 'X'),
      task('m2', 'X'),
      task('Y'),
      task('n1'),
    ]);
    const moveDown = moveTask('X', 'down');
    const afterMove = moveDown.apply(original);
    // Sanity check: X jumps past its own children to sit after Y.
    expect(ids(afterMove)).toEqual(['m1', 'm2', 'Y', 'X', 'n1']);

    const afterInverse = moveDown.inverse(afterMove).apply(afterMove);
    expect(ids(afterInverse)).toEqual(['X', 'm1', 'm2', 'Y', 'n1']);
  });
});
