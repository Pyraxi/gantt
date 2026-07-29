import { describe, expect, test } from 'vitest';
import type { Project, Task, TaskType } from '../types.js';
import { moveTaskTo } from './factories.js';

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
    calendars: [],
    baselines: [],
    assignments: [],
  };
}
const ids = (p: Project) => p.tasks.map((t) => t.id);
const typeOf = (p: Project, id: string) => p.tasks.find((t) => t.id === id)!.type;
const parentOf = (p: Project, id: string) => p.tasks.find((t) => t.id === id)!.parent;

describe('moveTaskTo — reorder within same parent', () => {
  test('move top-level task to index 0', () => {
    const p = project([task('a'), task('b'), task('c')]);
    const out = moveTaskTo('c', { index: 0 }).apply(p);
    expect(ids(out)).toEqual(['c', 'a', 'b']);
  });
  test('move top-level task to last index', () => {
    const p = project([task('a'), task('b'), task('c')]);
    const out = moveTaskTo('a', { index: 2 }).apply(p);
    expect(ids(out)).toEqual(['b', 'c', 'a']);
  });
  test('index beyond sibling count clamps to last', () => {
    const p = project([task('a'), task('b'), task('c')]);
    const out = moveTaskTo('a', { index: 99 }).apply(p);
    expect(ids(out)).toEqual(['b', 'c', 'a']);
  });
});

describe('moveTaskTo — reparent', () => {
  test('reparenting into a leaf promotes it to summary', () => {
    const p = project([task('p'), task('a')]);
    const out = moveTaskTo('a', { parent: 'p', index: 0 }).apply(p);
    expect(parentOf(out, 'a')).toBe('p');
    expect(typeOf(out, 'p')).toBe('summary');
  });
  test('leaving an old parent childless demotes it to task', () => {
    const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b')]);
    const out = moveTaskTo('a', { index: 2 }).apply(p);
    expect(parentOf(out, 'a')).toBeUndefined();
    expect(typeOf(out, 'p')).toBe('task');
  });
  test('old parent with remaining children stays summary', () => {
    const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b', 'task', 'p')]);
    const out = moveTaskTo('a', { index: 99 }).apply(p);
    expect(typeOf(out, 'p')).toBe('summary');
  });
});

describe('moveTaskTo — cycle guard', () => {
  test('moving a task under itself throws EditError', () => {
    const p = project([task('a'), task('b')]);
    expect(() => moveTaskTo('a', { parent: 'a', index: 0 }).apply(p)).toThrow(
      /under itself or its descendant/,
    );
  });
  test('moving a summary under its direct child throws EditError', () => {
    const p = project([task('P', 'summary'), task('k', 'task', 'P')]);
    expect(() => moveTaskTo('P', { parent: 'k', index: 0 }).apply(p)).toThrow(
      /under itself or its descendant/,
    );
  });
  test('moving a summary under a deep descendant throws EditError', () => {
    // P → k → g ; move P under g (its grandchild).
    const p = project([task('P', 'summary'), task('k', 'summary', 'P'), task('g', 'task', 'k')]);
    expect(() => moveTaskTo('P', { parent: 'g', index: 0 }).apply(p)).toThrow(
      /under itself or its descendant/,
    );
  });
  test('moving a task under an unrelated summary is allowed (no false positive)', () => {
    const p = project([task('P', 'summary'), task('k', 'task', 'P'), task('x')]);
    const out = moveTaskTo('x', { parent: 'P', index: 0 }).apply(p);
    expect(parentOf(out, 'x')).toBe('P');
  });
});

describe('moveTaskTo — errors + round-trip', () => {
  test('missing task throws EditError', () => {
    const p = project([task('a')]);
    expect(() => moveTaskTo('nope', { index: 0 }).apply(p)).toThrow(/missing task/);
  });
  test('inverse restores order, parent, and both parent types', () => {
    const p = project([task('p', 'summary'), task('a', 'task', 'p'), task('b')]);
    const cmd = moveTaskTo('a', { parent: undefined, index: 2 });
    const applied = cmd.apply(p);
    const restored = cmd.inverse(applied).apply(applied);
    expect(ids(restored)).toEqual(['p', 'a', 'b']);
    expect(parentOf(restored, 'a')).toBe('p');
    expect(typeOf(restored, 'p')).toBe('summary');
  });
});
