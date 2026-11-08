import { describe, expect, test } from 'vitest';
import { combineProjects } from './combine';
import { parseMspdi } from './mspdi/parse';
import { serializeMspdi } from './mspdi/serialize';
import { progressPoints } from './progress-line';
import { resourceUsage } from './resource-usage';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// With a status date, schedule() schedules from the actuals as MS Project does
// (the default): the status date moves nothing. MS Project desktop's own
// answers: docs/release/desktop-check/results-run9 (q01–q05) and results-run8
// (p01, p09). P6's data-date forecast, the opt-in, is in schedule-status.test.ts.

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8, m = 0) => new Date(2026, 0, day, h, m);
const MON = d(5);
const THU = d(8);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const fs = (source: string, target: string): Link => ({
  id: `${source}-${target}`,
  source,
  target,
  type: 'FS',
  lag: 0,
});
const projectOf = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
  statusDate: THU,
  ...extra,
});
const run = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}) => {
  const s = schedule({
    start: MON,
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [std],
    baselines: [],
    assignments: [],
    statusDate: THU,
    ...extra,
  });
  return (id: string) => {
    const x = s.tasks.find((q) => q.id === id)?.computed;
    if (!x) throw new Error(`no computed for ${id}`);
    return x;
  };
};

describe('status date, MS Project scheduling (the default)', () => {
  test('unstarted work stays where its logic puts it, behind the status date (run 8 p01)', () => {
    const c = run([t('a', 5)]);
    expect(c('a').earlyStart).toEqual(MON);
    expect(c('a').earlyFinish).toEqual(d(9, 17));
    expect(c('a').status).toBe('not-started');
  });

  test('remaining work follows the work done, not the status date (run 9 q03)', () => {
    // 40% of 5d done from Mon 5: Mon–Tue; the rest Wed–Fri.
    const c = run([t('a', 5, { progress: 40, actualStart: MON })]);
    expect(c('a').earlyStart).toEqual(MON);
    expect(c('a').remainingStart).toEqual(d(7));
    expect(c('a').earlyFinish).toEqual(d(9, 17));
  });

  test('work done beyond the time elapsed stays contiguous (run 8 p09)', () => {
    // 60% by a status date of Tue 6: done Mon–Wed, the rest Thu–Fri.
    const c = run([t('a', 5, { progress: 60, actualStart: MON })], [], { statusDate: d(6) });
    expect(c('a').earlyFinish).toEqual(d(9, 17));
  });

  test('out of sequence: the rest waits for the predecessor, splitting the task (run 9 q01, q02)', () => {
    // B 20% of 3d done Mon 08:00–13:24, then resumes Mon 12 after A.
    const c = run([t('a', 5), t('b', 3, { progress: 20, actualStart: MON })], [fs('a', 'b')]);
    expect(c('a').earlyStart).toEqual(MON);
    expect(c('b').remainingStart).toEqual(d(12));
    expect(c('b').earlyFinish).toEqual(d(14, 11, 36));
    expect(c('b').outOfSequence).toBe(true);
    const c2 = run(
      [
        t('a', 5, { progress: 40, actualStart: MON }),
        t('b', 3, { progress: 20, actualStart: d(6) }),
      ],
      [fs('a', 'b')],
    );
    expect(c2('a').earlyFinish).toEqual(d(9, 17));
    expect(c2('b').earlyStart).toEqual(d(6));
    expect(c2('b').remainingStart).toEqual(d(12));
    expect(c2('b').earlyFinish).toEqual(d(14, 11, 36));
  });

  test('…and with progress override, it carries straight on', () => {
    const c = run([t('a', 5), t('b', 3, { progress: 20, actualStart: MON })], [fs('a', 'b')], {
      progressMode: 'progress-override',
    });
    expect(c('b').remainingStart).toEqual(d(5, 13, 24));
    expect(c('b').earlyFinish).toEqual(d(7, 17)); // 216 min Mon + Tue + Wed
  });

  test('successors follow the actual finish or the forecast (run 9 q04, q05)', () => {
    const late = run(
      [t('a', 2, { progress: 100, actualStart: MON, actualFinish: d(7, 17) }), t('b', 2)],
      [fs('a', 'b')],
    );
    expect(late('b').earlyStart).toEqual(THU);
    expect(late('b').earlyFinish).toEqual(d(9, 17));
    const under = run([t('a', 5, { progress: 40, actualStart: MON }), t('b', 2)], [fs('a', 'b')]);
    expect(under('b').earlyStart).toEqual(d(12));
    expect(under('b').earlyFinish).toEqual(d(13, 17));
  });

  test('a P6 expected finish still runs from the status date to it', () => {
    const c = run([t('a', 5, { progress: 20, actualStart: MON, expectedFinish: d(13, 17) })]);
    expect(c('a').remainingStart).toEqual(THU);
    expect(c('a').earlyFinish).toEqual(d(13, 17));
  });

  test('rescheduleAfterStatusDate forecasts from the status date instead (P6)', () => {
    const c = run([t('a', 5), t('b', 5, { progress: 40, actualStart: MON })], [], {
      rescheduleAfterStatusDate: true,
    });
    expect(c('a').earlyStart).toEqual(THU);
    expect(c('b').remainingStart).toEqual(THU);
    expect(c('b').earlyFinish).toEqual(d(12, 17));
  });
});

describe('status date, MS Project scheduling: everything agrees on the work done (review, 2026-11-04)', () => {
  const field = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)<`))?.[1];
  const taskXml = (xml: string, n: number) => xml.split('<Task>')[n] ?? '';

  test('a task with nothing left ends where its work done does, not the next morning', () => {
    const c = run([t('a', 5, { progress: 40, actualStart: MON, remainingDuration: 0 })]);
    expect(c('a').earlyFinish).toEqual(d(6, 17));
  });

  test('the progress line sits where the remaining work starts, with a host remaining duration', () => {
    // 40% of 5d done (Mon–Tue), 4d left: the point is Tue 17:00, as the bar.
    const p = projectOf([
      t('a', 5, { progress: 40, actualStart: MON, remainingDuration: 4 * DAY }),
    ]);
    const c = run(p.tasks);
    expect(c('a').remainingStart).toEqual(d(7));
    expect(progressPoints(p).get('a')).toEqual(d(6, 17));
  });

  test('resource usage loads no done work for a task started at 0% with a host remaining duration', () => {
    const p = projectOf(
      [t('x', 5), t('a', 5, { actualStart: MON, remainingDuration: 3 * DAY })],
      [fs('x', 'a')],
      {
        resources: [{ id: 'crew', name: 'Crew' }],
        assignments: [{ id: 'w', taskId: 'a', resourceId: 'crew' }],
      },
    );
    const loads = resourceUsage(p, { from: d(5, 0), to: d(15, 0) })
      .find((r) => r.resourceId === 'crew')
      ?.periods.map((x) => [x.start.getDate(), x.load]);
    expect(loads?.filter(([, load]) => (load ?? 0) > 0).map(([day]) => day)).toEqual([12, 13, 14]);
  });

  test('MSPDI: a task held by its predecessor writes the split; one carrying straight on writes none', () => {
    const held = serializeMspdi(
      schedule(
        projectOf([t('a', 5), t('b', 3, { progress: 20, actualStart: MON })], [fs('a', 'b')]),
      ),
    );
    const b = taskXml(held, 2);
    expect(field(b, 'Stop')).toBe('2026-01-05T13:24:00');
    expect(field(b, 'Resume')).toBe('2026-01-12T08:00:00');
    expect(field(b, 'Finish')).toBe('2026-01-14T11:36:00');
    const straight = serializeMspdi(
      schedule(projectOf([t('a', 5, { progress: 40, actualStart: MON })])),
    );
    expect(taskXml(straight, 1)).not.toMatch(/<Stop>|<Resume>/);
    // …and import gives the same schedule back.
    const back = schedule(parseMspdi(held).project).tasks.find((x) => x.text === 'b')?.computed;
    expect(back?.remainingStart).toEqual(d(12));
    expect(back?.earlyFinish).toEqual(d(14, 11, 36));
  });

  test('combineProjects takes rescheduleAfterStatusDate from the first part that sets it', () => {
    const part = (extra: Partial<Project>) => projectOf([t('a', 5)], [], extra);
    const { project } = combineProjects([
      { key: 'x', project: part({ rescheduleAfterStatusDate: false }) },
      { key: 'y', project: part({ rescheduleAfterStatusDate: true }) },
    ]);
    expect(project.rescheduleAfterStatusDate).toBe(false);
    const p6 = combineProjects([
      { key: 'x', project: part({}) },
      { key: 'y', project: part({ rescheduleAfterStatusDate: true }) },
    ]).project;
    expect(p6.rescheduleAfterStatusDate).toBe(true);
  });
});
