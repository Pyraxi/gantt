import { describe, expect, test } from 'vitest';
import type { Calendar, Link, Project, Task } from '../types.js';
import {
  CreateLinkCommand,
  CreateTaskCommand,
  DeleteLinkCommand,
  DeleteTaskCommand,
  UpdateLinkCommand,
  UpdateTaskCommand,
} from './commands.js';
import { EditError } from './errors.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, text = `Task ${id}`, duration = 480): Task {
  return {
    id,
    text,
    type: 'task',
    scheduleMode: 'auto',
    duration,
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

describe('CreateTaskCommand', () => {
  test('apply appends the task; tasks.length grows by 1', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateTaskCommand(task('b', 'New task'));
    const next = cmd.apply(p);
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks[1].id).toBe('b');
    expect(next.tasks[1].text).toBe('New task');
  });

  test('apply does not mutate the input project', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateTaskCommand(task('b'));
    cmd.apply(p);
    expect(p.tasks).toHaveLength(1);
  });

  test('apply throws EditError when a task with the same id already exists', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateTaskCommand(task('a'));
    expect(() => cmd.apply(p)).toThrow(EditError);
    expect(() => cmd.apply(p)).toThrow(/duplicate/i);
  });

  test('inverse(apply(P)) === P (structural equality)', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateTaskCommand(task('b'));
    const next = cmd.apply(p);
    const inv = cmd.inverse(next);
    const back = inv.apply(next);
    expect(back.tasks).toEqual(p.tasks);
  });

  test('label is descriptive', () => {
    const cmd = new CreateTaskCommand(task('b', 'Foundation pour'));
    expect(cmd.label).toBe('Create task "Foundation pour"');
  });
});

describe('UpdateTaskCommand', () => {
  test('apply patches only the targeted task', () => {
    const p = projectOf([task('a', 'Old'), task('b', 'Other')]);
    const cmd = new UpdateTaskCommand('a', { text: 'New' });
    const next = cmd.apply(p);
    expect(next.tasks[0].text).toBe('New');
    expect(next.tasks[1].text).toBe('Other');
  });

  test('apply preserves untouched fields', () => {
    const p = projectOf([task('a', 'Old', 480)]);
    const cmd = new UpdateTaskCommand('a', { text: 'New' });
    const next = cmd.apply(p);
    expect(next.tasks[0].duration).toBe(480);
    expect(next.tasks[0].type).toBe('task');
  });

  test('apply throws EditError when the target task does not exist', () => {
    const p = projectOf([task('a')]);
    const cmd = new UpdateTaskCommand('missing', { text: 'X' });
    expect(() => cmd.apply(p)).toThrow(EditError);
    expect(() => cmd.apply(p)).toThrow(/missing/);
  });

  test('inverse(apply(P)) === P (structural equality)', () => {
    const p = projectOf([task('a', 'Old', 480)]);
    const cmd = new UpdateTaskCommand('a', { text: 'New', duration: 960 });
    const next = cmd.apply(p);
    const inv = cmd.inverse(next);
    const back = inv.apply(next);
    expect(back.tasks[0].text).toBe('Old');
    expect(back.tasks[0].duration).toBe(480);
  });

  test('label names the patched fields', () => {
    const cmd = new UpdateTaskCommand('a', { text: 'New' });
    expect(cmd.label).toMatch(/Update task/i);
  });
});

describe('DeleteTaskCommand', () => {
  test('apply removes the target task', () => {
    const p = projectOf([task('a'), task('b'), task('c')]);
    const cmd = new DeleteTaskCommand('b');
    const next = cmd.apply(p);
    expect(next.tasks).toHaveLength(2);
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'c']);
  });
});

function link(id: string, source: string, target: string): Link {
  return { id, source, target, type: 'FS', lag: 0 };
}

describe('DeleteTaskCommand (full)', () => {
  test('apply removes the task', () => {
    const p = projectOf([task('a'), task('b')]);
    const cmd = new DeleteTaskCommand('a');
    const next = cmd.apply(p);
    expect(next.tasks).toHaveLength(1);
    expect(next.tasks[0].id).toBe('b');
  });

  test('apply removes all incident links (incoming + outgoing)', () => {
    const p: Project = {
      ...projectOf([task('a'), task('b'), task('c')]),
      links: [
        link('l1', 'a', 'b'), // outgoing from a
        link('l2', 'c', 'a'), // incoming to a
        link('l3', 'b', 'c'), // unrelated to a
      ],
    };
    const cmd = new DeleteTaskCommand('a');
    const next = cmd.apply(p);
    expect(next.tasks.map((t) => t.id)).toEqual(['b', 'c']);
    expect(next.links).toHaveLength(1);
    expect(next.links[0].id).toBe('l3');
  });

  test('apply throws EditError when task does not exist', () => {
    const p = projectOf([task('a')]);
    const cmd = new DeleteTaskCommand('missing');
    expect(() => cmd.apply(p)).toThrow(EditError);
  });

  test('inverse(apply(P)) restores task + all incident links — single command instance', () => {
    const p: Project = {
      ...projectOf([task('a'), task('b'), task('c')]),
      links: [link('l1', 'a', 'b'), link('l2', 'c', 'a'), link('l3', 'b', 'c')],
    };
    const cmd = new DeleteTaskCommand('a');
    // Per snapshot-at-apply design: apply MUST be called first; it captures
    // pre-state into the command instance. Inverse then reads from snapshot.
    const after = cmd.apply(p);
    const inv = cmd.inverse(after);
    const back = inv.apply(after);

    expect(back.tasks).toEqual(p.tasks);
    expect(back.links).toEqual(p.links);
  });

  test('inverse throws if apply was not called first', () => {
    const cmd = new DeleteTaskCommand('a');
    const p = projectOf([task('a')]);
    expect(() => cmd.inverse(p)).toThrow(EditError);
    expect(() => cmd.inverse(p)).toThrow(/apply.*not called/i);
  });

  test('label names the task being deleted', () => {
    const cmd = new DeleteTaskCommand('a');
    expect(cmd.label).toBe('Delete task "a"');
  });
});

describe('CreateLinkCommand', () => {
  test('apply appends the link', () => {
    const p = projectOf([task('a'), task('b')]);
    const cmd = new CreateLinkCommand(link('l1', 'a', 'b'));
    const next = cmd.apply(p);
    expect(next.links).toHaveLength(1);
    expect(next.links[0].id).toBe('l1');
  });

  test('apply throws EditError on duplicate link id', () => {
    const p: Project = { ...projectOf([task('a'), task('b')]), links: [link('l1', 'a', 'b')] };
    const cmd = new CreateLinkCommand(link('l1', 'a', 'b'));
    expect(() => cmd.apply(p)).toThrow(EditError);
  });

  test('apply throws EditError when source or target task does not exist', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateLinkCommand(link('l1', 'a', 'missing'));
    expect(() => cmd.apply(p)).toThrow(EditError);
  });

  test('apply throws EditError on self-link (source === target)', () => {
    const p = projectOf([task('a')]);
    const cmd = new CreateLinkCommand(link('l1', 'a', 'a'));
    expect(() => cmd.apply(p)).toThrow(EditError);
    expect(() => cmd.apply(p)).toThrow(/self/i);
  });

  test('inverse(apply(P)) === P', () => {
    const p = projectOf([task('a'), task('b')]);
    const cmd = new CreateLinkCommand(link('l1', 'a', 'b'));
    const next = cmd.apply(p);
    const inv = cmd.inverse(next);
    const back = inv.apply(next);
    expect(back.links).toEqual(p.links);
  });
});

describe('UpdateLinkCommand', () => {
  test('apply patches the targeted link', () => {
    const p: Project = { ...projectOf([task('a'), task('b')]), links: [link('l1', 'a', 'b')] };
    const cmd = new UpdateLinkCommand('l1', { lag: 1440 });
    const next = cmd.apply(p);
    expect(next.links[0].lag).toBe(1440);
    expect(next.links[0].type).toBe('FS');
  });

  test('apply throws when link does not exist', () => {
    const p = projectOf([task('a')]);
    const cmd = new UpdateLinkCommand('missing', { lag: 60 });
    expect(() => cmd.apply(p)).toThrow(EditError);
  });

  test('inverse(apply(P)) === P', () => {
    const p: Project = { ...projectOf([task('a'), task('b')]), links: [link('l1', 'a', 'b')] };
    const cmd = new UpdateLinkCommand('l1', { lag: 1440 });
    const next = cmd.apply(p);
    const inv = cmd.inverse(next);
    const back = inv.apply(next);
    expect(back.links).toEqual(p.links);
  });

  test('inverse throws if apply was not called first', () => {
    const cmd = new UpdateLinkCommand('l1', { lag: 60 });
    const p: Project = { ...projectOf([task('a'), task('b')]), links: [link('l1', 'a', 'b')] };
    expect(() => cmd.inverse(p)).toThrow(EditError);
    expect(() => cmd.inverse(p)).toThrow(/apply.*not called/i);
  });
});

describe('DeleteLinkCommand', () => {
  test('apply removes the link', () => {
    const p: Project = {
      ...projectOf([task('a'), task('b')]),
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'a')],
    };
    const cmd = new DeleteLinkCommand('l1');
    const next = cmd.apply(p);
    expect(next.links).toHaveLength(1);
    expect(next.links[0].id).toBe('l2');
  });

  test('apply throws when link does not exist', () => {
    const p = projectOf([task('a')]);
    const cmd = new DeleteLinkCommand('missing');
    expect(() => cmd.apply(p)).toThrow(EditError);
  });

  test('inverse(apply(P)) === P — single command instance, snapshot-at-apply', () => {
    const p: Project = {
      ...projectOf([task('a'), task('b'), task('c')]),
      links: [link('l1', 'a', 'b'), link('l2', 'b', 'c'), link('l3', 'a', 'c')],
    };
    const cmd = new DeleteLinkCommand('l2');
    // apply first to snapshot pre-state, then inverse.
    const after = cmd.apply(p);
    const inv = cmd.inverse(after);
    const back = inv.apply(after);
    expect(back.links).toEqual(p.links); // restored in original order
  });

  test('inverse throws if apply was not called first', () => {
    const cmd = new DeleteLinkCommand('l1');
    const p: Project = { ...projectOf([task('a'), task('b')]), links: [link('l1', 'a', 'b')] };
    expect(() => cmd.inverse(p)).toThrow(EditError);
    expect(() => cmd.inverse(p)).toThrow(/apply.*not called/i);
  });
});
