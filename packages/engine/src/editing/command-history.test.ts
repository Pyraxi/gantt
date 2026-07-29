import { describe, expect, test } from 'vitest';
import type { Calendar, Project, Task } from '../types.js';
import { newHistory, pushCommand, redo, undo } from './command-history.js';
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

describe('newHistory', () => {
  test('returns empty stacks', () => {
    const h = newHistory();
    expect(h.past).toHaveLength(0);
    expect(h.future).toHaveLength(0);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('pushCommand', () => {
  test('appends to past and clears future', () => {
    const h0 = newHistory();
    const cmd = renameTask('a', 'New');
    const h1 = pushCommand(h0, cmd);
    expect(h1.past).toHaveLength(1);
    expect(h1.past[0]).toBe(cmd);
    expect(h1.future).toHaveLength(0);
    expect(h1.canUndo).toBe(true);
    expect(h1.canRedo).toBe(false);
  });

  test('clears future on new push (standard editor behaviour)', () => {
    const cmd1 = renameTask('a', 'One');
    const cmd2 = renameTask('a', 'Two');
    const cmd3 = renameTask('a', 'Three');
    const p = projectOf([task('a', 'Initial')]);

    let h = pushCommand(pushCommand(newHistory(), cmd1), cmd2);
    const afterCmd1 = cmd1.apply(p);
    const afterCmd2 = cmd2.apply(afterCmd1);
    const undoneOnce = undo(h, afterCmd2);
    expect(undoneOnce).not.toBeNull();
    h = undoneOnce?.nextHistory ?? h;
    expect(h.canRedo).toBe(true);

    h = pushCommand(h, cmd3);
    expect(h.canRedo).toBe(false);
    expect(h.future).toHaveLength(0);
  });
});

describe('undo', () => {
  test('on empty past returns null', () => {
    const h = newHistory();
    const p = projectOf([task('a')]);
    expect(undo(h, p)).toBeNull();
  });

  test('pops past, pushes onto future, applies inverse', () => {
    const p = projectOf([task('a', 'Old')]);
    const cmd = renameTask('a', 'New');
    const after = cmd.apply(p);
    const h1 = pushCommand(newHistory(), cmd);

    const result = undo(h1, after);
    expect(result).not.toBeNull();
    expect(result?.nextProject.tasks[0].text).toBe('Old');
    expect(result?.nextHistory.past).toHaveLength(0);
    expect(result?.nextHistory.future).toHaveLength(1);
    expect(result?.nextHistory.canUndo).toBe(false);
    expect(result?.nextHistory.canRedo).toBe(true);
  });
});

describe('redo', () => {
  test('on empty future returns null', () => {
    const h = newHistory();
    const p = projectOf([task('a')]);
    expect(redo(h, p)).toBeNull();
  });

  test('pops future, pushes onto past, applies command', () => {
    const p = projectOf([task('a', 'Old')]);
    const cmd = renameTask('a', 'New');
    const after = cmd.apply(p);

    const h1 = pushCommand(newHistory(), cmd);
    const undone = undo(h1, after);
    const result = redo(undone!.nextHistory, undone!.nextProject);

    expect(result).not.toBeNull();
    expect(result?.nextProject.tasks[0].text).toBe('New');
    expect(result?.nextHistory.past).toHaveLength(1);
    expect(result?.nextHistory.future).toHaveLength(0);
  });
});

describe('round-trip', () => {
  test('multiple undo/redo cycles preserve project state', () => {
    const p = projectOf([task('a', 'V0')]);
    const cmd1 = renameTask('a', 'V1');
    const cmd2 = renameTask('a', 'V2');

    const afterCmd1 = cmd1.apply(p);
    const afterCmd2 = cmd2.apply(afterCmd1);

    let h = pushCommand(pushCommand(newHistory(), cmd1), cmd2);

    // undo, undo
    let proj: Project = afterCmd2;
    let res = undo(h, proj);
    proj = res!.nextProject;
    h = res!.nextHistory;
    expect(proj.tasks[0].text).toBe('V1');

    res = undo(h, proj);
    proj = res!.nextProject;
    h = res!.nextHistory;
    expect(proj.tasks[0].text).toBe('V0');
    expect(h.canUndo).toBe(false);

    // redo, redo
    let rRes = redo(h, proj);
    proj = rRes!.nextProject;
    h = rRes!.nextHistory;
    expect(proj.tasks[0].text).toBe('V1');

    rRes = redo(h, proj);
    proj = rRes!.nextProject;
    h = rRes!.nextHistory;
    expect(proj.tasks[0].text).toBe('V2');
    expect(h.canRedo).toBe(false);
  });
});
