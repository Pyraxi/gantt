import { describe, expect, test } from 'vitest';
import type { Calendar, Project, Task } from '../types.js';
import { CompositeCommand } from './composite-command.js';
import { cancel, commit, enqueue, newDraft } from './draft-project.js';
import { EditError } from './errors.js';
import { renameTask } from './factories.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, text = `Task ${id}`): Task {
  return {
    id,
    text,
    type: 'task',
    scheduleMode: 'auto',
    duration: 480,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
  };
}

function projectOf(tasks: Task[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('newDraft', () => {
  test('returns isDirty: false and effective === base', () => {
    const p = projectOf([task('a')]);
    const d = newDraft(p);
    expect(d.isDirty).toBe(false);
    expect(d.pending).toHaveLength(0);
    expect(d.effective).toBe(p);
    expect(d.base).toBe(p);
  });
});

describe('enqueue', () => {
  test('appends command to pending and applies it to effective', () => {
    const p = projectOf([task('a', 'Old')]);
    const d1 = newDraft(p);
    const d2 = enqueue(d1, renameTask('a', 'New'));
    expect(d2.pending).toHaveLength(1);
    expect(d2.effective.tasks[0].text).toBe('New');
    expect(d2.base).toBe(p); // base unchanged
    expect(d2.isDirty).toBe(true);
  });

  test('stacks multiple enqueues in order', () => {
    const p = projectOf([task('a', 'Old')]);
    const d1 = newDraft(p);
    const d2 = enqueue(d1, renameTask('a', 'Mid'));
    const d3 = enqueue(d2, renameTask('a', 'New'));
    expect(d3.pending).toHaveLength(2);
    expect(d3.effective.tasks[0].text).toBe('New');
  });
});

describe('commit', () => {
  test('with a single pending command returns it directly (no composite wrap)', () => {
    const p = projectOf([task('a', 'Old')]);
    const cmd = renameTask('a', 'New');
    const d = enqueue(newDraft(p), cmd);
    const result = commit(d);
    expect(result.compound).toBe(cmd);
    expect(result.newBase).toBe(d.effective);
  });

  test('with multiple pending commands wraps them in a CompositeCommand', () => {
    const p = projectOf([task('a', 'Old')]);
    const d = enqueue(enqueue(newDraft(p), renameTask('a', 'Mid')), renameTask('a', 'New'));
    const result = commit(d, 'My edits');
    expect(result.compound).toBeInstanceOf(CompositeCommand);
    expect((result.compound as CompositeCommand).members).toHaveLength(2);
    expect((result.compound as CompositeCommand).label).toBe('My edits');
  });

  test('on an empty draft throws EditError', () => {
    const p = projectOf([task('a')]);
    const d = newDraft(p);
    expect(() => commit(d)).toThrow(EditError);
  });
});

describe('cancel', () => {
  test('resets effective back to base and clears pending', () => {
    const p = projectOf([task('a', 'Old')]);
    const d = enqueue(newDraft(p), renameTask('a', 'New'));
    const d2 = cancel(d);
    expect(d2.pending).toHaveLength(0);
    expect(d2.effective).toBe(p);
    expect(d2.isDirty).toBe(false);
    expect(d2.base).toBe(p);
  });
});
