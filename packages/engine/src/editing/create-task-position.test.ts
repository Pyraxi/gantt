import { describe, expect, test } from 'vitest';
import type { Project, Task } from '../types.js';
import { createTask } from './factories.js';

function task(id: string, parent?: string): Task {
  return {
    id,
    text: id,
    type: 'task',
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

describe('createTask positioning', () => {
  test('insertAfter splices after the named task', () => {
    const p = project([task('a'), task('b')]);
    const out = createTask(task('x'), undefined, 'a').apply(p);
    expect(ids(out)).toEqual(['a', 'x', 'b']);
  });
  test('parent overrides the task.parent field', () => {
    const p = project([task('a')]);
    const out = createTask(task('x'), 'a').apply(p);
    expect(out.tasks.find((t) => t.id === 'x')!.parent).toBe('a');
  });
  test('no position args appends at end (unchanged behavior)', () => {
    const p = project([task('a'), task('b')]);
    expect(ids(createTask(task('x')).apply(p))).toEqual(['a', 'b', 'x']);
  });
});

describe('createTask leaf→summary promotion (P1.1)', () => {
  const typeOf = (p: Project, id: string) => p.tasks.find((t) => t.id === id)!.type;

  test('adding a child under a leaf promotes the leaf to summary', () => {
    const p = project([task('a')]);
    const out = createTask(task('x'), 'a').apply(p);
    expect(typeOf(out, 'a')).toBe('summary');
    expect(out.tasks.find((t) => t.id === 'x')!.parent).toBe('a');
  });

  test('promotion also applies on the insertAfter path', () => {
    const p = project([task('a'), task('b')]);
    const out = createTask(task('x'), 'a', 'a').apply(p);
    expect(typeOf(out, 'a')).toBe('summary');
    expect(ids(out)).toEqual(['a', 'x', 'b']);
  });

  test('no parent → no promotion, unchanged behavior', () => {
    const p = project([task('a')]);
    const out = createTask(task('x')).apply(p);
    expect(typeOf(out, 'a')).toBe('task');
  });

  test('inverse deletes the child and demotes the newly-promoted parent', () => {
    const p = project([task('a')]);
    const cmd = createTask(task('x'), 'a');
    const applied = cmd.apply(p);
    const restored = cmd.inverse(applied).apply(applied);
    expect(restored.tasks.find((t) => t.id === 'x')).toBeUndefined();
    expect(typeOf(restored, 'a')).toBe('task');
  });

  test('inverse leaves an already-summary parent as summary', () => {
    const parent: Task = { ...task('a'), type: 'summary' };
    const existingChild = task('c', 'a');
    const p = project([parent, existingChild]);
    const cmd = createTask(task('x'), 'a');
    const applied = cmd.apply(p);
    const restored = cmd.inverse(applied).apply(applied);
    // parent keeps a child (c) and was already a summary → stays summary
    expect(typeOf(restored, 'a')).toBe('summary');
  });
});
