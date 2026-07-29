import { describe, expect, test } from 'vitest';
import { captureBaseline, getTaskBaselineVariance, getTaskBaselineVarianceAll } from './baseline';
import type { Calendar, Project, Task } from './types';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

const STD_DAY = 540;

function task(id: string, start: Date, end: Date, duration: number): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start,
    end,
    progress: 0,
  };
}

function project(tasks: Task[]): Project {
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

describe('captureBaseline', () => {
  test('snapshots every task’s start, end, and duration', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const b = task('b', new Date(2026, 0, 6, 8, 0), new Date(2026, 0, 6, 17, 0), STD_DAY);
    const result = captureBaseline(project([a, b]), 0);
    const baseline = result.baselines.find((bl) => bl.index === 0)!;
    const snapA = baseline.tasks.get('a')!;
    const snapB = baseline.tasks.get('b')!;
    expect(snapA.start).toEqual(new Date(2026, 0, 5, 8, 0));
    expect(snapA.end).toEqual(new Date(2026, 0, 5, 17, 0));
    expect(snapA.duration).toBe(STD_DAY);
    expect(snapB.start).toEqual(new Date(2026, 0, 6, 8, 0));
  });

  test('returned project has the baseline at the requested index', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const result = captureBaseline(project([a]), 3, { name: 'Variation 3' });
    const baseline = result.baselines.find((bl) => bl.index === 3)!;
    expect(baseline).toBeDefined();
    expect(baseline.name).toBe('Variation 3');
    expect(baseline.capturedAt).toBeInstanceOf(Date);
  });

  test('overwrites an existing baseline at the same index', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const first = captureBaseline(project([a]), 0, { name: 'First' });
    // Mutate a's start, capture again at index 0
    const moved = {
      ...first,
      tasks: first.tasks.map((t) =>
        t.id === 'a'
          ? { ...t, start: new Date(2026, 0, 12, 8, 0), end: new Date(2026, 0, 12, 17, 0) }
          : t,
      ),
    };
    const second = captureBaseline(moved, 0, { name: 'Second' });
    const baselines = second.baselines.filter((bl) => bl.index === 0);
    expect(baselines).toHaveLength(1);
    expect(baselines[0]!.name).toBe('Second');
    expect(baselines[0]!.tasks.get('a')!.start).toEqual(new Date(2026, 0, 12, 8, 0));
  });

  test('preserves other baselines when adding a new one at a different index', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const withBaseline0 = captureBaseline(project([a]), 0, { name: 'Initial' });
    const withBaseline1 = captureBaseline(withBaseline0, 1, { name: 'Variation 1' });
    expect(withBaseline1.baselines).toHaveLength(2);
    expect(withBaseline1.baselines.find((bl) => bl.index === 0)!.name).toBe('Initial');
    expect(withBaseline1.baselines.find((bl) => bl.index === 1)!.name).toBe('Variation 1');
  });

  test('snapshot is decoupled from later task mutations (defensive copy)', () => {
    const start = new Date(2026, 0, 5, 8, 0);
    const a = task('a', start, new Date(2026, 0, 5, 17, 0), STD_DAY);
    const result = captureBaseline(project([a]), 0);
    // Mutate the original date — the baseline should not change
    start.setFullYear(2099);
    const snap = result.baselines[0]!.tasks.get('a')!;
    expect(snap.start.getFullYear()).toBe(2026);
  });
});

describe('getTaskBaselineVariance', () => {
  test('returns zero variance when the task has not moved', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([a]), 0);
    const baseline = captured.baselines[0]!;
    const variance = getTaskBaselineVariance(a, baseline, standardCalendar)!;
    expect(variance.startVariance).toBe(0);
    expect(variance.finishVariance).toBe(0);
    expect(variance.durationVariance).toBe(0);
  });

  test('returns positive startVariance when the task has slipped later', () => {
    const original = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([original]), 0);
    const baseline = captured.baselines[0]!;
    // Task slips one working day later
    const slipped = {
      ...original,
      start: new Date(2026, 0, 6, 8, 0),
      end: new Date(2026, 0, 6, 17, 0),
    };
    const variance = getTaskBaselineVariance(slipped, baseline, standardCalendar)!;
    expect(variance.startVariance).toBe(STD_DAY);
    expect(variance.finishVariance).toBe(STD_DAY);
  });

  test('returns negative startVariance when the task has moved earlier', () => {
    const original = task('a', new Date(2026, 0, 7, 8, 0), new Date(2026, 0, 7, 17, 0), STD_DAY);
    const captured = captureBaseline(project([original]), 0);
    const baseline = captured.baselines[0]!;
    // Task moves one working day earlier
    const earlier = {
      ...original,
      start: new Date(2026, 0, 6, 8, 0),
      end: new Date(2026, 0, 6, 17, 0),
    };
    const variance = getTaskBaselineVariance(earlier, baseline, standardCalendar)!;
    expect(variance.startVariance).toBe(-STD_DAY);
  });

  test('returns positive durationVariance when the task has grown', () => {
    const original = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([original]), 0);
    const baseline = captured.baselines[0]!;
    const grown = { ...original, end: new Date(2026, 0, 6, 17, 0), duration: 2 * STD_DAY };
    const variance = getTaskBaselineVariance(grown, baseline, standardCalendar)!;
    expect(variance.durationVariance).toBe(STD_DAY);
  });

  test('returns undefined when the task is not in the baseline', () => {
    const original = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([original]), 0);
    const baseline = captured.baselines[0]!;
    const newTask = task('z', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    expect(getTaskBaselineVariance(newTask, baseline, standardCalendar)).toBeUndefined();
  });
});

describe('getTaskBaselineVarianceAll', () => {
  test('returns an empty Map when the project has no baselines', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const p = project([a]); // baselines: []
    const result = getTaskBaselineVarianceAll(p, 0);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  test('returns a Map with one entry per task that has a snapshot in the baseline', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const b = task('b', new Date(2026, 0, 6, 8, 0), new Date(2026, 0, 6, 17, 0), STD_DAY);
    const captured = captureBaseline(project([a, b]), 0);
    const result = getTaskBaselineVarianceAll(captured, 0);
    expect(result.size).toBe(2);
    expect(result.has('a')).toBe(true);
    expect(result.has('b')).toBe(true);
  });

  test('skips tasks that were added after the baseline was captured (not in the snapshot)', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([a]), 0);
    // Add task 'z' after baseline capture
    const late = task('z', new Date(2026, 0, 7, 8, 0), new Date(2026, 0, 7, 17, 0), STD_DAY);
    const updated = { ...captured, tasks: [...captured.tasks, late] };
    const result = getTaskBaselineVarianceAll(updated, 0);
    expect(result.size).toBe(1);
    expect(result.has('a')).toBe(true);
    expect(result.has('z')).toBe(false);
  });

  test('each variance matches getTaskBaselineVariance called individually', () => {
    const original = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const captured = captureBaseline(project([original]), 0);
    // Slip task a by one working day
    const slipped = {
      ...captured,
      tasks: captured.tasks.map((t) =>
        t.id === 'a'
          ? { ...t, start: new Date(2026, 0, 6, 8, 0), end: new Date(2026, 0, 6, 17, 0) }
          : t,
      ),
    };
    const baseline = slipped.baselines[0]!;
    const allMap = getTaskBaselineVarianceAll(slipped, 0);
    const slippedTask = slipped.tasks.find((t) => t.id === 'a')!;
    const individual = getTaskBaselineVariance(slippedTask, baseline, standardCalendar)!;
    const fromMap = allMap.get('a')!;
    expect(fromMap.startVariance).toBe(individual.startVariance);
    expect(fromMap.finishVariance).toBe(individual.finishVariance);
    expect(fromMap.durationVariance).toBe(individual.durationVariance);
  });

  test('throws when the project default calendar is missing', () => {
    const a = task('a', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 5, 17, 0), STD_DAY);
    const p = project([a]);
    const captured = captureBaseline(p, 0);
    // Point to a calendar that doesn't exist
    const broken = { ...captured, defaultCalendarId: 'nonexistent' };
    expect(() => getTaskBaselineVarianceAll(broken, 0)).toThrow();
  });
});
