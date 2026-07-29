import { describe, expect, test } from 'vitest';
import { getCriticalPath, getProjectStats } from './analysis';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

const DAY = 540;
const PROJECT_START = new Date(2026, 0, 5, 8, 0);

function task(id: string, duration: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: PROJECT_START,
    end: PROJECT_START,
    progress: 0,
    ...overrides,
  };
}

function fs(source: string, target: string): Link {
  return { id: `${source}-${target}`, source, target, type: 'FS', lag: 0 };
}

function project(tasks: Task[], links: Link[] = []): Project {
  return {
    start: PROJECT_START,
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('getCriticalPath', () => {
  test('returns all tasks for a single-task project (everything is critical)', () => {
    const a = task('a', DAY);
    const result = getCriticalPath(schedule(project([a])));
    expect(result.map((t) => t.id)).toEqual(['a']);
  });

  test('returns the chain for a linear FS chain (all critical)', () => {
    const a = task('a', DAY);
    const b = task('b', DAY);
    const c = task('c', DAY);
    const result = getCriticalPath(schedule(project([a, b, c], [fs('a', 'b'), fs('b', 'c')])));
    expect(result.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  test('excludes non-critical tasks in a diamond (shorter branch dropped)', () => {
    // A → B(1d) → D and A → C(2d) → D. C is critical, B is not.
    const a = task('a', DAY);
    const b = task('b', DAY);
    const c = task('c', 2 * DAY);
    const d = task('d', DAY);
    const result = getCriticalPath(
      schedule(project([a, b, c, d], [fs('a', 'b'), fs('a', 'c'), fs('b', 'd'), fs('c', 'd')])),
    );
    const ids = result.map((t) => t.id);
    expect(ids).toContain('a');
    expect(ids).toContain('c');
    expect(ids).toContain('d');
    expect(ids).not.toContain('b');
  });

  test('excludes summary tasks from the critical path list (consumer-facing)', () => {
    // Summary tasks aggregate child dates; including them as "critical
    // tasks" in a list is double-counting. Leaves only.
    const phase = task('phase', 0, { type: 'summary' });
    const c1 = task('c1', DAY, { parent: 'phase' });
    const c2 = task('c2', DAY, { parent: 'phase' });
    const result = getCriticalPath(schedule(project([phase, c1, c2], [fs('c1', 'c2')])));
    expect(result.map((t) => t.id)).not.toContain('phase');
  });

  test('returns tasks ordered by earlyStart (chronological)', () => {
    const a = task('a', DAY);
    const b = task('b', DAY);
    const c = task('c', DAY);
    // No links — all start at projectStart, all critical (no slack against project end).
    // Order should be earliest-first; with identical earlyStart, stable-sorted by task id is fine.
    const result = getCriticalPath(schedule(project([a, b, c])));
    const starts = result.map((t) => t.computed!.earlyStart.getTime());
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1]!);
    }
  });
});

describe('getProjectStats', () => {
  test('counts total tasks excluding summaries', () => {
    const phase = task('phase', 0, { type: 'summary' });
    const c1 = task('c1', DAY, { parent: 'phase' });
    const c2 = task('c2', DAY, { parent: 'phase' });
    const stats = getProjectStats(schedule(project([phase, c1, c2])));
    expect(stats.totalTasks).toBe(2);
  });

  test('counts critical tasks (leaves only)', () => {
    const a = task('a', DAY);
    const b = task('b', DAY);
    const c = task('c', 2 * DAY);
    const d = task('d', DAY);
    const stats = getProjectStats(
      schedule(project([a, b, c, d], [fs('a', 'b'), fs('a', 'c'), fs('b', 'd'), fs('c', 'd')])),
    );
    // a, c, d critical (b on shorter branch has slack)
    expect(stats.criticalTasks).toBe(3);
  });

  test('reports the project finish (latest earlyFinish across leaf tasks)', () => {
    const a = task('a', DAY);
    const b = task('b', DAY);
    const stats = getProjectStats(schedule(project([a, b], [fs('a', 'b')])));
    expect(stats.projectFinish).toEqual(new Date(2026, 0, 6, 17, 0));
  });

  test('counts late tasks (negative totalSlack)', () => {
    // Project ends Mon 5pm but task needs 2 working days
    const a = task('a', 2 * DAY);
    const p = project([a]);
    p.end = new Date(2026, 0, 5, 17, 0);
    const stats = getProjectStats(schedule(p));
    expect(stats.lateTasks).toBe(1);
  });

  test('computes average progress weighted by duration', () => {
    const a = task('a', 1000, { progress: 50 });
    const b = task('b', 3000, { progress: 100 });
    // weighted: (1000*50 + 3000*100) / 4000 = (50000 + 300000) / 4000 = 87.5
    const stats = getProjectStats(schedule(project([a, b])));
    expect(stats.weightedProgress).toBeCloseTo(87.5, 1);
  });

  test('returns zero weightedProgress for an empty project (no division by zero)', () => {
    const stats = getProjectStats(schedule(project([])));
    expect(stats.weightedProgress).toBe(0);
    expect(stats.totalTasks).toBe(0);
  });
});
