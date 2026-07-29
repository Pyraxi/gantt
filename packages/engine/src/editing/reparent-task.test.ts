import { describe, expect, test } from 'vitest';
import type { Project, Task } from '../types.js';
import { indentTask, outdentTask } from './factories.js';

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
const byId = (p: Project, id: string) => p.tasks.find((t) => t.id === id)!;

describe('indentTask', () => {
  test('reparents under preceding sibling and makes it a summary', () => {
    const p = project([task('a'), task('b')]);
    const out = indentTask('b').apply(p);
    expect(byId(out, 'b').parent).toBe('a');
    expect(byId(out, 'a').type).toBe('summary');
  });
  test('no preceding sibling → no-op', () => {
    const p = project([task('a'), task('b')]);
    const out = indentTask('a').apply(p);
    expect(byId(out, 'a').parent).toBeUndefined();
  });
});

describe('outdentTask', () => {
  test('reparents to grandparent', () => {
    const p = project([task('a', undefined, 'summary'), task('b', 'a')]);
    const out = outdentTask('b').apply(p);
    expect(byId(out, 'b').parent).toBeUndefined();
  });
  test('reverts now-childless parent to task', () => {
    const p = project([task('a', undefined, 'summary'), task('b', 'a')]);
    const out = outdentTask('b').apply(p);
    expect(byId(out, 'a').type).toBe('task');
  });
  test('already top-level → no-op', () => {
    const p = project([task('a')]);
    expect(byId(outdentTask('a').apply(p), 'a').parent).toBeUndefined();
  });
});

describe('ReparentTaskCommand.inverse guard', () => {
  test('inverse() before apply() throws', () => {
    const p = project([task('a'), task('b')]);
    expect(() => indentTask('b').inverse(p)).toThrow(
      'inverse: apply() was not called on this command',
    );
  });
});

describe('ReparentTaskCommand.inverse round-trip (P1 F12 — restore promoted/demoted types)', () => {
  test('indent → undo restores the promoted parent back to task', () => {
    const p = project([task('a'), task('b')]);
    const cmd = indentTask('b');
    const after = cmd.apply(p);
    expect(byId(after, 'a').type).toBe('summary'); // a promoted by the indent
    const undone = cmd.inverse(after).apply(after);
    expect(byId(undone, 'b').parent).toBeUndefined(); // parent restored
    expect(byId(undone, 'a').type).toBe('task'); // TYPE restored (bug: stayed summary)
  });
  test('outdent → undo restores the demoted parent back to summary', () => {
    const p = project([task('a', undefined, 'summary'), task('b', 'a')]);
    const cmd = outdentTask('b');
    const after = cmd.apply(p);
    expect(byId(after, 'a').type).toBe('task'); // a demoted (now childless)
    const undone = cmd.inverse(after).apply(after);
    expect(byId(undone, 'b').parent).toBe('a'); // parent restored
    expect(byId(undone, 'a').type).toBe('summary'); // TYPE restored (bug: stayed task)
  });
  test('indent under an already-summary parent → undo leaves it summary (no spurious demote)', () => {
    const p = project([task('a', undefined, 'summary'), task('c', 'a'), task('b')]);
    const cmd = indentTask('b'); // preceding same-parent(undefined) sibling is a
    const after = cmd.apply(p);
    expect(byId(after, 'a').type).toBe('summary'); // unchanged — already a summary
    const undone = cmd.inverse(after).apply(after);
    expect(byId(undone, 'a').type).toBe('summary'); // must NOT demote a pre-existing summary
  });
});
