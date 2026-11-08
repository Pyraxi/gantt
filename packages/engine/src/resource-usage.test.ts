// Parity row 7 (histogram slice): resource load against capacity per period.
// Spec: docs/superpowers/specs/2026-10-16-resource-usage-design.md
import { describe, expect, test } from 'vitest';
import { generateProject } from './__bench__/generate-project';
import { overAllocations, resourceUsage } from './resource-usage';
import { schedule } from './schedule';
import type { Calendar, Project, Task } from './types';

const DAY = 540;
const STD = { startMinutes: 480, endMinutes: 1020 };
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
// A plasterer who works Mon–Thu.
const fourDay: Calendar = {
  id: 'four',
  name: '4-day',
  workWeek: [[], [STD], [STD], [STD], [STD], [], []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
// Auto tasks pinned by SNET: schedule() works out the real end on each
// task's effective calendar (a manual task keeps its entered dates).
const t = (id: string, start: Date, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: days === 0 ? 'milestone' : 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start,
  end: start,
  progress: 0,
  constraint: { type: 'SNET', date: start },
  ...extra,
});
const project = (tasks: Task[], assignments: Project['assignments']): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links: [],
  resources: [
    { id: 'sparky', name: 'Electrician' },
    { id: 'plasterer', name: 'Plasterer', calendarId: 'four' },
  ],
  calendars: [std, fourDay],
  baselines: [],
  assignments,
});

describe('resourceUsage', () => {
  test('daily load vs capacity; two overlapping full-time tasks over-allocate', () => {
    // Mon 5 – Wed 7: wiring A (3 days) and wiring B (Tue 6, 2 days) — both on the sparky.
    const p = project(
      [t('A', d(5), 3), t('B', d(6), 2), t('M', d(8), 0)],
      [
        { id: 'a1', taskId: 'A', resourceId: 'sparky' },
        { id: 'a2', taskId: 'B', resourceId: 'sparky' },
        { id: 'a3', taskId: 'M', resourceId: 'sparky' },
      ],
    );
    const sparky = resourceUsage(p, { from: d(5, 0), to: d(10, 0) }).find(
      (r) => r.resourceId === 'sparky',
    );
    expect(
      sparky?.periods.map((x) => [x.start.getDate(), x.load, x.capacity, x.overAllocated]),
    ).toEqual([
      [5, DAY, DAY, false],
      [6, 2 * DAY, DAY, true],
      [7, 2 * DAY, DAY, true],
      [8, 0, DAY, false], // the milestone carries no work
      [9, 0, DAY, false],
    ]);
  });

  test('units scale the load; a resource calendar sets the capacity', () => {
    const p = project(
      [t('P', d(5), 5)],
      [{ id: 'p1', taskId: 'P', resourceId: 'plasterer', units: 0.5 }],
    );
    const plast = resourceUsage(p, { from: d(5, 0), to: d(10, 0) }).find(
      (r) => r.resourceId === 'plasterer',
    );
    // The task's effective calendar intersects the plasterer's Mon–Thu week.
    expect(plast?.periods.map((x) => [x.start.getDate(), x.load, x.capacity])).toEqual([
      [5, DAY / 2, DAY],
      [6, DAY / 2, DAY],
      [7, DAY / 2, DAY],
      [8, DAY / 2, DAY],
      [9, 0, 0],
    ]);
  });

  test('weekly buckets start on Monday', () => {
    const p = project([t('A', d(5), 7)], [{ id: 'a1', taskId: 'A', resourceId: 'sparky' }]);
    const sparky = resourceUsage(p, { from: d(5, 0), to: d(19, 0), bucket: 'week' }).find(
      (r) => r.resourceId === 'sparky',
    );
    expect(sparky?.periods.map((x) => [x.start.getDate(), x.load, x.capacity])).toEqual([
      [5, 5 * DAY, 5 * DAY],
      [12, 2 * DAY, 5 * DAY],
    ]);
  });
});

describe('overAllocations', () => {
  test('consecutive over-allocated days merge, naming the tasks', () => {
    const p = project(
      [t('A', d(5), 3), t('B', d(6), 2)],
      [
        { id: 'a1', taskId: 'A', resourceId: 'sparky' },
        { id: 'a2', taskId: 'B', resourceId: 'sparky' },
      ],
    );
    expect(overAllocations(p)).toEqual([
      {
        resourceId: 'sparky',
        start: d(6, 0),
        end: d(8, 0),
        load: 4 * DAY,
        capacity: 2 * DAY,
        taskIds: ['A', 'B'],
      },
    ]);
  });
});

describe('resourceUsage: work spans, not bars', () => {
  const sparkyOf = (p: Project, from = d(5, 0), to = d(13, 0)) =>
    resourceUsage(p, { from, to })
      .find((r) => r.resourceId === 'sparky')
      ?.periods.map((x) => [x.start.getDate(), x.load]);

  test('an in-progress task under a status date loads what was done and what remains, not the gap', () => {
    // 2 days, started Mon 5, half done; status date Mon 12: remaining 1 day from the 12th.
    const p = {
      ...project(
        [
          t('W', d(5), 2, {
            scheduleMode: 'auto',
            progress: 50,
            actualStart: d(5),
            constraint: undefined,
          }),
        ],
        [{ id: 'w1', taskId: 'W', resourceId: 'sparky' }],
      ),
      rescheduleAfterStatusDate: true,
      statusDate: d(12),
    };
    expect(sparkyOf(p, d(5, 0), d(13, 0))).toEqual([
      [5, DAY],
      [6, 0],
      [7, 0],
      [8, 0],
      [9, 0],
      [10, 0],
      [11, 0],
      [12, DAY],
    ]);
  });

  test('work done comes from % complete, even with an Expected Finish or a long remaining duration', () => {
    const inProgress = (extra: Partial<Task>) => ({
      ...project(
        [
          t('W', d(5), 2, {
            progress: 50,
            actualStart: d(5),
            constraint: undefined,
            ...extra,
          }),
        ],
        [{ id: 'w1', taskId: 'W', resourceId: 'sparky' }],
      ),
      statusDate: d(12),
    });
    // Half of 2 days was worked on the 5th, whatever the forecast says now.
    for (const extra of [{ expectedFinish: d(16, 17) }, { remainingDuration: 3 * DAY }]) {
      expect(sparkyOf(inProgress(extra), d(5, 0), d(6, 0))).toEqual([[5, DAY]]);
    }
  });

  test('stale segments on an auto task are ignored (as schedule() and the bars do)', () => {
    const p = project(
      [
        t('A', d(5), 2, {
          segments: [
            { start: d(19), end: d(19, 17) },
            { start: d(21), end: d(21, 17) },
          ],
        }),
      ],
      [{ id: 'a1', taskId: 'A', resourceId: 'sparky' }],
    );
    expect(sparkyOf(p, d(5, 0), d(7, 0))).toEqual([
      [5, DAY],
      [6, DAY],
    ]);
  });

  test('two assignments of one resource to one task add up', () => {
    const p = project(
      [t('A', d(5), 1)],
      [
        { id: 'a1', taskId: 'A', resourceId: 'sparky', units: 0.5 },
        { id: 'a2', taskId: 'A', resourceId: 'sparky', units: 0.5 },
      ],
    );
    expect(sparkyOf(p, d(5, 0), d(6, 0))).toEqual([[5, DAY]]);
  });

  test("a split task's gap carries no load", () => {
    const p = project(
      [
        t('S', d(5), 2, {
          scheduleMode: 'manual',
          constraint: undefined,
          start: d(5),
          end: d(9, 17),
          segments: [
            { start: d(5), end: d(5, 17) },
            { start: d(9), end: d(9, 17) },
          ],
        }),
      ],
      [{ id: 's1', taskId: 'S', resourceId: 'sparky' }],
    );
    expect(sparkyOf(p, d(5, 0), d(10, 0))).toEqual([
      [5, DAY],
      [6, 0],
      [7, 0],
      [8, 0],
      [9, DAY],
    ]);
  });

  test('Task.resourceIds counts as an assignment (units 1), as for calendars', () => {
    const p = project([t('R', d(5), 1, { resourceIds: ['sparky'] })], []);
    expect(sparkyOf(p, d(5, 0), d(6, 0))).toEqual([[5, DAY]]);
  });
});

describe('overAllocations: only tasks that carry the load', () => {
  test('summaries and unscheduled tasks are never listed', () => {
    const p = project(
      [
        t('S', d(5), 0, { type: 'summary', constraint: undefined }),
        t('A', d(5), 3, { parent: 'S' }),
        t('B', d(6), 2, { parent: 'S' }),
        t('U', d(6), 1, { unscheduled: true }),
      ],
      ['S', 'A', 'B', 'U'].map((id) => ({ id: `a-${id}`, taskId: id, resourceId: 'sparky' })),
    );
    expect(overAllocations(p).map((o) => o.taskIds)).toEqual([['A', 'B']]);
  });
});

describe('resourceUsage: scale', () => {
  test('5k tasks, 50 resources, day buckets: well inside the schedule budget', () => {
    const base = generateProject({ leafCount: 5000, phases: 10 });
    const resources = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, name: `R${i}` }));
    const leaves = base.tasks.filter((x) => x.type === 'task');
    const p: Project = {
      ...base,
      resources,
      assignments: leaves.map((x, i) => ({ id: `as${i}`, taskId: x.id, resourceId: `r${i % 50}` })),
    };
    const t0 = performance.now();
    const usage = resourceUsage(p);
    const ms = performance.now() - t0;
    expect(usage).toHaveLength(50);
    // Includes schedule() (~300 ms on a Xeon E5-2650); the bucket loop itself was ~3 s.
    expect(ms).toBeLessThan(1500);
  }, 20_000);

  test('5k long (200-day) tasks: day buckets stay fast (the histogram re-queries on pan / zoom)', () => {
    const base = generateProject({ leafCount: 5000, phases: 10 });
    // Parallel (unlinked): ~1M (span, day) visits over ~200 days. Chained,
    // 5k × 200 days would be a 340-year programme.
    const p0: Project = {
      ...base,
      links: [],
      tasks: base.tasks.map((x) => (x.type === 'task' ? { ...x, duration: 200 * 480 } : x)),
      resources: Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, name: `R${i}` })),
    };
    const p = {
      ...p0,
      assignments: p0.tasks
        .filter((x) => x.type === 'task')
        .map((x, i) => ({ id: `as${i}`, taskId: x.id, resourceId: `r${i % 50}` })),
    };
    const scheduled = schedule(p);
    const t0 = performance.now();
    resourceUsage(scheduled);
    // Was ~4.4–5 s on main; ~1.1 s now. Headroom for a loaded CI box.
    expect(performance.now() - t0).toBeLessThan(3000);
  }, 60_000);
});
