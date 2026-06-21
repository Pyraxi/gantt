import { describe, expect, test } from 'vitest';
import type { Calendar, Project, Task } from '../types.js';
import { CreateLinkCommand, CreateTaskCommand, UpdateTaskCommand } from './commands.js';
import { CompositeCommand } from './composite-command.js';

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

describe('CompositeCommand', () => {
  test('apply runs each member in order', () => {
    const p = projectOf([task('a', 'Old')]);
    const composite = new CompositeCommand(
      [new UpdateTaskCommand('a', { text: 'Mid' }), new UpdateTaskCommand('a', { text: 'New' })],
      'Rename twice',
    );
    const next = composite.apply(p);
    expect(next.tasks[0].text).toBe('New');
  });

  test('apply throws if any member throws (no-partial-output guarantee)', () => {
    const p = projectOf([task('a')]);
    const composite = new CompositeCommand(
      [
        new UpdateTaskCommand('a', { text: 'New' }),
        new UpdateTaskCommand('missing', { text: 'X' }),
      ],
      'Two updates',
    );
    expect(() => composite.apply(p)).toThrow();
  });

  test('inverse(apply(P)) === P for heterogeneous members', () => {
    const p = projectOf([task('a', 'Old')]);
    const composite = new CompositeCommand(
      [
        new UpdateTaskCommand('a', { text: 'Mid' }),
        new CreateTaskCommand(task('b', 'New')),
        new CreateLinkCommand({ id: 'l1', source: 'a', target: 'b', type: 'FS', lag: 0 }),
      ],
      'Build chain',
    );
    const after = composite.apply(p);
    const inv = composite.inverse(after);
    const back = inv.apply(after);

    expect(back.tasks).toEqual(p.tasks);
    expect(back.links).toEqual(p.links);
  });

  test('single-member composite produces same apply output as the member directly', () => {
    const p = projectOf([task('a', 'Old')]);
    const composite = new CompositeCommand([new UpdateTaskCommand('a', { text: 'New' })], 'Rename');
    const after = composite.apply(p);
    const direct = new UpdateTaskCommand('a', { text: 'New' }).apply(p);
    expect(after).toEqual(direct);
  });

  test('label is the constructor argument', () => {
    const composite = new CompositeCommand([], 'My edit');
    expect(composite.label).toBe('My edit');
  });

  test('inverse label prefixes with "Undo:"', () => {
    const p = projectOf([task('a', 'Old')]);
    const composite = new CompositeCommand([new UpdateTaskCommand('a', { text: 'New' })], 'Rename');
    composite.apply(p); // single-use: apply must precede inverse for stateful members
    const inv = composite.inverse(p);
    expect(inv.label).toBe('Undo: Rename');
  });

  test('inverse throws if any member throws on its inverse (e.g. member not applied)', () => {
    const composite = new CompositeCommand([new UpdateTaskCommand('a', { text: 'New' })], 'Rename');
    // Did not call composite.apply — UpdateTaskCommand has no snapshot, will throw
    const p = projectOf([task('a')]);
    expect(() => composite.inverse(p)).toThrow();
  });
});
