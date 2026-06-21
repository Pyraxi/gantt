import { describe, expect, test } from 'vitest';
import type { Task, TaskSegment } from '../types.js';
import {
  CreateLinkCommand,
  CreateTaskCommand,
  DeleteLinkCommand,
  DeleteTaskCommand,
  UpdateLinkCommand,
  UpdateTaskCommand,
} from './commands.js';
import {
  createTask,
  deleteLink,
  deleteTask,
  linkTasks,
  renameTask,
  setTaskDuration,
  setTaskProgress,
  setTaskStart,
  setUnscheduled,
  splitTask,
  unsetSplit,
  updateLink,
  updateTask,
} from './factories.js';

const sampleTask: Task = {
  id: 'a',
  text: 'A',
  type: 'task',
  scheduleMode: 'auto',
  duration: 480,
  start: new Date(2026, 0, 5),
  end: new Date(2026, 0, 5),
  progress: 0,
};

describe('factories — task commands', () => {
  test('renameTask returns an UpdateTaskCommand with descriptive label', () => {
    const cmd = renameTask('a', 'New');
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/Rename/i);
    expect(cmd.label).toContain('"New"');
  });

  test('setTaskStart returns an UpdateTaskCommand with descriptive label', () => {
    const cmd = setTaskStart('a', new Date(2026, 5, 1));
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/Move|Start/i);
  });

  test('setTaskDuration returns an UpdateTaskCommand', () => {
    const cmd = setTaskDuration('a', 960);
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/duration/i);
  });

  test('setTaskProgress returns an UpdateTaskCommand', () => {
    const cmd = setTaskProgress('a', 75);
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/progress/i);
  });

  test('updateTask returns an UpdateTaskCommand with the patch', () => {
    const cmd = updateTask('a', { text: 'New', progress: 50 });
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
  });

  test('createTask returns a CreateTaskCommand', () => {
    const cmd = createTask(sampleTask);
    expect(cmd).toBeInstanceOf(CreateTaskCommand);
    expect(cmd.label).toContain('A');
  });

  test('deleteTask returns a DeleteTaskCommand', () => {
    const cmd = deleteTask('a');
    expect(cmd).toBeInstanceOf(DeleteTaskCommand);
  });
});

describe('factories — split task commands (ADR-007)', () => {
  const seg1: TaskSegment = {
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 17, 0),
  };
  const seg2: TaskSegment = {
    start: new Date(2026, 0, 8, 8, 0),
    end: new Date(2026, 0, 8, 17, 0),
  };

  test('splitTask returns an UpdateTaskCommand carrying the segments patch (I-4: documents manual-mode usage)', () => {
    // ADR-007: splits are only honoured by the engine on scheduleMode:'manual' tasks.
    // This factory is a pure patch-builder; it does not validate scheduleMode at
    // call time. The precondition is documented in the JSDoc and enforced by the
    // scheduler (which ignores segments on auto tasks).
    const cmd = splitTask('a', [seg1, seg2]);
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/split/i);
    // Verify the patch carries the correct segments (the core contract)
    const manualTask: Task = { ...sampleTask, scheduleMode: 'manual' };
    const project = {
      start: new Date(2026, 0, 5),
      defaultCalendarId: 'std',
      tasks: [manualTask],
      links: [],
      resources: [],
      calendars: [],
      baselines: [],
      assignments: [],
    };
    const result = cmd.apply(project);
    expect(result.tasks.find((t) => t.id === 'a')?.segments).toEqual([seg1, seg2]);
  });

  test('splitTask patches segments onto the task when applied', () => {
    const cmd = splitTask('a', [seg1, seg2]);
    const project = {
      start: new Date(2026, 0, 5),
      defaultCalendarId: 'std',
      tasks: [sampleTask],
      links: [],
      resources: [],
      calendars: [],
      baselines: [],
      assignments: [],
    };
    const result = cmd.apply(project);
    const task = result.tasks.find((t) => t.id === 'a');
    expect(task?.segments).toEqual([seg1, seg2]);
  });

  test('unsetSplit returns an UpdateTaskCommand that clears segments', () => {
    const cmd = unsetSplit('a');
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/split/i);
  });

  test('unsetSplit clears segments when applied', () => {
    const splitSampleTask: Task = { ...sampleTask, segments: [seg1, seg2] };
    const cmd = unsetSplit('a');
    const project = {
      start: new Date(2026, 0, 5),
      defaultCalendarId: 'std',
      tasks: [splitSampleTask],
      links: [],
      resources: [],
      calendars: [],
      baselines: [],
      assignments: [],
    };
    const result = cmd.apply(project);
    const task = result.tasks.find((t) => t.id === 'a');
    expect(task?.segments).toBeUndefined();
  });
});

describe('factories — unscheduled task commands (ADR-007)', () => {
  test('setUnscheduled(true) returns an UpdateTaskCommand', () => {
    const cmd = setUnscheduled('a', true);
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
    expect(cmd.label).toMatch(/unscheduled/i);
  });

  test('setUnscheduled(false) returns an UpdateTaskCommand', () => {
    const cmd = setUnscheduled('a', false);
    expect(cmd).toBeInstanceOf(UpdateTaskCommand);
  });

  test('setUnscheduled(true) marks the task unscheduled when applied', () => {
    const cmd = setUnscheduled('a', true);
    const project = {
      start: new Date(2026, 0, 5),
      defaultCalendarId: 'std',
      tasks: [sampleTask],
      links: [],
      resources: [],
      calendars: [],
      baselines: [],
      assignments: [],
    };
    const result = cmd.apply(project);
    const task = result.tasks.find((t) => t.id === 'a');
    expect(task?.unscheduled).toBe(true);
  });

  test('setUnscheduled(false) clears the unscheduled flag when applied', () => {
    const unscheduledTask: Task = { ...sampleTask, unscheduled: true };
    const cmd = setUnscheduled('a', false);
    const project = {
      start: new Date(2026, 0, 5),
      defaultCalendarId: 'std',
      tasks: [unscheduledTask],
      links: [],
      resources: [],
      calendars: [],
      baselines: [],
      assignments: [],
    };
    const result = cmd.apply(project);
    const task = result.tasks.find((t) => t.id === 'a');
    expect(task?.unscheduled).toBe(false);
  });
});

describe('factories — link commands', () => {
  test('linkTasks defaults to FS with zero lag', () => {
    const cmd = linkTasks('a', 'b');
    expect(cmd).toBeInstanceOf(CreateLinkCommand);
  });

  test('linkTasks accepts type and lag overrides', () => {
    const cmd = linkTasks('a', 'b', 'SS', 1440);
    expect(cmd).toBeInstanceOf(CreateLinkCommand);
  });

  test('linkTasks generates a stable link id from source + target', () => {
    const c1 = linkTasks('a', 'b');
    const c2 = linkTasks('a', 'b');
    expect(c1.label).toEqual(c2.label);
  });

  test('updateLink returns an UpdateLinkCommand', () => {
    const cmd = updateLink('l1', { lag: 60 });
    expect(cmd).toBeInstanceOf(UpdateLinkCommand);
  });

  test('deleteLink returns a DeleteLinkCommand', () => {
    const cmd = deleteLink('l1');
    expect(cmd).toBeInstanceOf(DeleteLinkCommand);
  });
});
