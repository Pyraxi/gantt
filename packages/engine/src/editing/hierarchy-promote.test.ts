import { describe, expect, test } from 'vitest';
import type { Project, Task, TaskType } from '../types.js';
import { promoteParentIfLeaf } from './factories.js';

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
const typeOf = (p: Project, id: string) => p.tasks.find((t) => t.id === id)?.type;

describe('promoteParentIfLeaf', () => {
  test('flips a leaf parent to summary', () => {
    const out = promoteParentIfLeaf(project([task('p')]), 'p');
    expect(typeOf(out, 'p')).toBe('summary');
  });
  test('leaves an existing summary untouched (same reference)', () => {
    const p = project([task('p', 'summary')]);
    expect(promoteParentIfLeaf(p, 'p')).toBe(p);
  });
  test('does not promote a milestone', () => {
    const p = project([task('m', 'milestone')]);
    expect(promoteParentIfLeaf(p, 'm')).toBe(p);
    expect(typeOf(p, 'm')).toBe('milestone');
  });
  test('undefined parentId is a no-op (same reference)', () => {
    const p = project([task('p')]);
    expect(promoteParentIfLeaf(p, undefined)).toBe(p);
  });
  test('unknown parentId is a no-op (same reference)', () => {
    const p = project([task('p')]);
    expect(promoteParentIfLeaf(p, 'nope')).toBe(p);
  });
  test('does not mutate the input project', () => {
    const p = project([task('p')]);
    promoteParentIfLeaf(p, 'p');
    expect(p.tasks[0]!.type).toBe('task');
  });
});
