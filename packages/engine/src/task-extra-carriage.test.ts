// Carriage-guarantee tests for `Task.extra` (host-app carry-through bag).
//
// `extra` is a consumer-owned opaque bag the engine never reads or writes
// (surface the carry-through *pattern*, not consumer semantics). These three
// tests lock the carriage contract:
//
//   1. schedule() returns `extra` unchanged on every task.
//   2. The edit pipeline preserves `extra` across an unrelated updateTask
//      patch and across undo/redo.
//   3. MSPDI serialize routes `extra` keys (no MSPDI home) to `droppedFields`
//      — transparent loss, not a silent disappearance.

import { describe, expect, test } from 'vitest';
import { UpdateTaskCommand } from './editing/commands.js';
import { serializeMspdi } from './mspdi/serialize.js';
import type { DroppedField } from './mspdi/types.js';
import { schedule } from './schedule.js';
import type { Calendar, Project, Task } from './types.js';

// --- fixtures (self-contained, mirrors schedule.test.ts) -------------------

const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard M-F 8-5',
  workWeek: [
    [],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [],
  ],
  exceptions: [],
};

const PROJECT_START = new Date(2026, 0, 5, 8, 0); // Mon 8am

// A representative host-app carry-through bag: host-app fields gantt doesn't model.
function cmExtra(): Record<string, unknown> {
  return {
    wbsCode: '1.2.3',
    actualStart: '2026-01-05T08:00:00.000Z',
    ownerUserId: 'user-42',
    description: 'Strip footing pour',
  };
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: PROJECT_START,
    end: PROJECT_START,
    progress: 0,
    ...overrides,
  };
}

function project(tasks: Task[]): Project {
  return {
    start: PROJECT_START,
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

// --- Guarantee 1: schedule() preserves extra --------------------------------

describe('Task.extra carriage: schedule()', () => {
  test('returns extra unchanged (deep-equal) on every task', () => {
    const extra = cmExtra();
    const result = schedule(project([task('a', { extra })]));
    expect(result.tasks[0]!.extra).toEqual(extra);
  });

  test('preserves extra on an auto task whose dates the engine rewrites', () => {
    // Auto tasks get start/end overwritten by the pass — extra must ride through.
    const extra = cmExtra();
    const result = schedule(project([task('a', { scheduleMode: 'auto', extra })]));
    expect(result.tasks[0]!.start).not.toBe(PROJECT_START); // engine rewrote dates
    expect(result.tasks[0]!.extra).toEqual(extra);
  });

  test('preserves extra on a summary task (dates derived from children)', () => {
    const extra = cmExtra();
    const parentSummary = task('p', { type: 'summary', extra });
    const child = task('c', { parent: 'p' });
    const result = schedule(project([parentSummary, child]));
    expect(result.tasks.find((t) => t.id === 'p')!.extra).toEqual(extra);
  });

  test('absent extra stays absent (no spurious key added)', () => {
    const result = schedule(project([task('a')]));
    expect(result.tasks[0]!.extra).toBeUndefined();
  });
});

// --- Guarantee 2: edit pipeline preserves extra -----------------------------

describe('Task.extra carriage: edit pipeline', () => {
  test('an unrelated updateTask patch leaves extra untouched', () => {
    const extra = cmExtra();
    const p = project([task('a', { extra })]);
    const cmd = new UpdateTaskCommand('a', { progress: 50 });
    const after = cmd.apply(p);
    expect(after.tasks[0]!.progress).toBe(50);
    expect(after.tasks[0]!.extra).toEqual(extra);
  });

  test('undo of an unrelated patch restores extra intact', () => {
    const extra = cmExtra();
    const p = project([task('a', { extra })]);
    const cmd = new UpdateTaskCommand('a', { progress: 50 });
    const applied = cmd.apply(p);
    const inverse = cmd.inverse(applied);
    const undone = inverse.apply(applied);
    expect(undone.tasks[0]!.progress).toBe(0);
    expect(undone.tasks[0]!.extra).toEqual(extra);
  });

  test('a patch that overwrites extra replaces the whole bag (consumer-controlled)', () => {
    const p = project([task('a', { extra: cmExtra() })]);
    const next = { wbsCode: '9.9.9' };
    const after = new UpdateTaskCommand('a', { extra: next }).apply(p);
    expect(after.tasks[0]!.extra).toEqual(next);
  });
});

// --- Guarantee 3: MSPDI serialize routes extra to droppedFields -------------

describe('Task.extra carriage: MSPDI serialize', () => {
  test('extra keys with no MSPDI home are reported in droppedFields', () => {
    const dropped: DroppedField[] = [];
    serializeMspdi(project([task('a', { extra: { wbsCode: '1.2.3', ownerUserId: 'u-42' } })]), {
      droppedFields: dropped,
    });
    const extraDrops = dropped.filter((d) => d.path.includes('.extra'));
    expect(extraDrops.length).toBeGreaterThan(0);
    expect(extraDrops.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        'Project.Tasks.Task[0].extra.wbsCode',
        'Project.Tasks.Task[0].extra.ownerUserId',
      ]),
    );
    expect(extraDrops.every((d) => d.reason === 'lossy-on-roundtrip')).toBe(true);
  });

  test('a task without extra adds no extra droppedFields', () => {
    const dropped: DroppedField[] = [];
    serializeMspdi(project([task('a')]), { droppedFields: dropped });
    expect(dropped.filter((d) => d.path.includes('.extra'))).toHaveLength(0);
  });
});
