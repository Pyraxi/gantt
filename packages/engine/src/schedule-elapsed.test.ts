import { describe, expect, test } from 'vitest';
import { captureBaseline, getTaskBaselineVarianceAll } from './baseline';
import { compareSchedules } from './compare';
import { parseMspdi } from './mspdi/parse';
import { serializeMspdi } from './mspdi/serialize';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';
import { addWorkingMinutes, workingMinutesBetween } from './working-time';

// Parity row 4 remainder. Spec: docs/superpowers/specs/2026-10-16-elapsed-durations-design.md

const DAY = 540;
const ED = 1440;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, minutes: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: minutes,
  start: d(5),
  end: d(5),
  progress: 0,
  ...extra,
});
const fs = (s: string, x: string): Link => ({
  id: `${s}-${x}`,
  source: s,
  target: x,
  type: 'FS',
  lag: 0,
});
const project = (tasks: Task[], links: Link[] = []): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
});
const c = (p: Project, id: string) => schedule(p).tasks.find((x) => x.id === id)?.computed;

describe('elapsed durations', () => {
  test('3 elapsed days run through the weekend: pour Mon–Thu → cure Thu 17:00 → Sun 17:00 → strip Mon', () => {
    const p = project(
      [t('pour', 4 * DAY), t('cure', 3 * ED, { durationElapsed: true }), t('strip', DAY)],
      [fs('pour', 'cure'), fs('cure', 'strip')],
    );
    // pour Mon 5 → Thu 8 17:00; cure starts Thu 17:00 (24/7: no snap) → Sun 11 17:00.
    expect(c(p, 'cure')?.earlyStart).toEqual(d(8, 17));
    expect(c(p, 'cure')?.earlyFinish).toEqual(d(11, 17));
    // strip snaps to the next working moment in its own calendar: Mon 12 08:00.
    expect(c(p, 'strip')?.earlyStart).toEqual(d(12));
  });

  test('a working lag INTO an elapsed task is a working day of its real calendar (MS Project)', () => {
    const p = project(
      [t('pour', 4 * DAY), t('cure', 3 * ED, { durationElapsed: true }), t('strip', DAY)],
      [{ id: 'l1', source: 'pour', target: 'cure', type: 'FS', lag: DAY }, fs('cure', 'strip')],
    );
    // pour ends Thu 17:00; +1 working day → Fri 17:00 (not Fri 02:00 in 24/7).
    expect(c(p, 'cure')?.earlyStart).toEqual(d(9, 17));
    expect(c(p, 'cure')?.earlyFinish).toEqual(d(12, 17));
    expect(c(p, 'strip')?.earlyStart).toEqual(d(13));
  });

  test('…and under a status date, for an in-progress elapsed task (retained logic)', () => {
    // Status Wed 7 12:00. The pour (4d, 50%) has 2 days left → finishes Fri 9 12:00;
    // +1 working day → Mon 12 12:00 is when the cure's remaining work can resume.
    const p = {
      ...project(
        [
          t('pour', 4 * DAY, { progress: 50, actualStart: d(5) }),
          t('cure', 3 * ED, { durationElapsed: true, progress: 10, actualStart: d(6) }),
        ],
        [{ id: 'l1', source: 'pour', target: 'cure', type: 'FS', lag: DAY }],
      ),
      rescheduleAfterStatusDate: true,
      statusDate: d(7, 12),
    };
    expect(c(p, 'pour')?.earlyFinish).toEqual(d(9, 12));
    expect(c(p, 'cure')?.remainingStart).toEqual(d(12, 12));
  });

  test('a working-time duration of the same minutes is much longer (control)', () => {
    const p = project([t('cure', 3 * ED)]);
    expect(c(p, 'cure')?.earlyFinish.getTime()).toBeGreaterThan(d(12).getTime());
  });

  test('float is exact: the cure can slide overnight (15 h) without moving the strip; no negative float', () => {
    const p = project(
      [t('pour', 4 * DAY), t('cure', 3 * ED, { durationElapsed: true }), t('strip', DAY)],
      [fs('pour', 'cure'), fs('cure', 'strip')],
    );
    const s = schedule(p);
    for (const task of s.tasks) expect(task.computed?.totalSlack).toBeGreaterThanOrEqual(0);
    // Cure Thu 17:00 → Sun 17:00, but the strip can't start before Mon 08:00:
    // starting the cure at Fri 08:00 (ending Mon 08:00) moves nothing.
    expect(s.tasks.find((x) => x.id === 'cure')?.computed?.totalSlack).toBe(15 * 60);
    expect(s.tasks.find((x) => x.id === 'pour')?.computed?.totalSlack).toBe(0);
    expect(s.tasks.find((x) => x.id === 'strip')?.computed?.totalSlack).toBe(0);
  });

  test('task and resource calendars are overridden (MS Project ignores calendars for elapsed)', () => {
    const night: Calendar = {
      id: 'night',
      name: 'Night',
      workWeek: Array(7).fill([{ startMinutes: 1200, endMinutes: 1380 }]),
      exceptions: [],
    };
    const p = {
      ...project([
        t('cure', ED, {
          durationElapsed: true,
          calendarId: 'night',
          start: d(5, 10),
          constraint: { type: 'SNET' as const, date: d(5, 10) },
        }),
      ]),
      calendars: [std, night],
    };
    expect(c(p, 'cure')?.earlyStart).toEqual(d(5, 10));
    expect(c(p, 'cure')?.earlyFinish).toEqual(d(6, 10));
  });

  test('without the flag, scheduling is unchanged', () => {
    const p = project([t('a', 2 * DAY), t('b', DAY)], [fs('a', 'b')]);
    const flagged = { ...p, tasks: p.tasks.map((x) => ({ ...x, durationElapsed: false })) };
    expect(schedule(flagged).tasks.map((x) => x.computed)).toEqual(
      schedule(p).tasks.map((x) => x.computed),
    );
  });
});

describe('elapsed durations: baseline variance', () => {
  test('a weekend slip of an elapsed task reads as its wall-clock hours, as compareSchedules does', () => {
    const before = schedule(
      project([
        t('cure', 3 * ED, {
          durationElapsed: true,
          scheduleMode: 'manual',
          start: d(8, 17),
          end: d(11, 17),
        }),
      ]),
    );
    const withBase = captureBaseline(before, 0);
    // Slipped 40 h: Thu 17:00 → Sat 09:00.
    const after = schedule({
      ...withBase,
      tasks: withBase.tasks.map((x) => ({ ...x, start: d(10, 9), end: d(13, 9) })),
    });
    expect(getTaskBaselineVarianceAll(after, 0).get('cure')?.startVariance).toBe(40 * 60);
    const cmp = compareSchedules(before, after).tasks.find((x) => x.id === 'cure');
    expect(cmp?.changes?.start?.delta).toBe(40 * 60);
  });
});

describe('MSPDI DurationFormat', () => {
  const xml = (fmt: number) =>
    `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><StartDate>2026-01-05T08:00:00</StartDate><Tasks><Task><UID>1</UID><ID>1</ID><Name>Cure</Name><Start>2026-01-09T08:00:00</Start><Finish>2026-01-12T08:00:00</Finish><Duration>PT72H0M0S</Duration><DurationFormat>${fmt}</DurationFormat></Task></Tasks></Project>`;

  test('elapsed formats (4/6/8/10/12, estimated 36–44) parse to durationElapsed; minutes are wall-clock', () => {
    for (const fmt of [4, 6, 8, 10, 12, 36, 38, 40, 42, 44]) {
      expect(parseMspdi(xml(fmt)).project.tasks[0]).toMatchObject({
        duration: 3 * ED,
        durationElapsed: true,
      });
    }
    expect(parseMspdi(xml(7)).project.tasks[0]?.durationElapsed).toBeUndefined();
  });

  test('summaries never take the elapsed flag (their duration is derived)', () => {
    const summaryXml = xml(8).replace(
      '<Name>Cure</Name>',
      '<Name>Phase</Name><Summary>1</Summary>',
    );
    expect(parseMspdi(summaryXml).project.tasks[0]?.durationElapsed).toBeUndefined();
  });

  test('round-trip: elapsed tasks serialize DurationFormat 8 and survive', () => {
    const p = project([t('cure', 3 * ED, { durationElapsed: true }), t('work', DAY)]);
    const out = serializeMspdi(schedule(p));
    expect(out).toMatch(
      /<Duration>PT72H0M0S<\/Duration>[\s\S]*?<DurationFormat>8<\/DurationFormat>/,
    );
    const back = parseMspdi(out).project.tasks;
    expect(back.find((x) => x.text === 'cure')).toMatchObject({
      duration: 3 * ED,
      durationElapsed: true,
    });
    expect(back.find((x) => x.text === 'work')?.durationElapsed).toBeUndefined();
  });
});

describe('elapsed durations: fuzz', () => {
  test('mixed elapsed / working tasks, all link types, elapsed lags: never negative float', () => {
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const types: Link['type'][] = ['FS', 'SS', 'FF', 'SF'];
    for (let n = 0; n < 300; n++) {
      const tasks = Array.from({ length: 7 }, (_, i) => {
        const elapsed = rnd() < 0.4;
        return t(
          `t${i}`,
          Math.floor(rnd() * 4) * (elapsed ? 720 : 540),
          elapsed ? { durationElapsed: true } : {},
        );
      });
      const links: Link[] = [];
      for (let i = 1; i < 7; i++) {
        links.push({
          id: `l${i}`,
          source: `t${Math.floor(rnd() * i)}`,
          target: `t${i}`,
          type: types[Math.floor(rnd() * 4)] ?? 'FS',
          lag: Math.floor(rnd() * 3) * 600 - 300,
          ...(rnd() < 0.3 ? { lagElapsed: true } : {}),
        });
      }
      for (const task of schedule(project(tasks, links)).tasks) {
        expect(task.computed?.totalSlack ?? 0, `case ${n} ${task.id}`).toBeGreaterThanOrEqual(
          -1e-6,
        );
      }
    }
  });
});

describe('elapsed durations: float is exact (slip-by-float)', () => {
  test('std project with elapsed tasks: slipping any task by its float never moves the project finish; an hour more does', () => {
    let seed = 23;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const types: Link['type'][] = ['FS', 'SS', 'FF', 'SF'];
    const ownCal = (task: Task): Calendar =>
      task.durationElapsed
        ? {
            id: '24',
            name: '24',
            workWeek: Array(7).fill([{ startMinutes: 0, endMinutes: 1440 }]),
            exceptions: [],
          }
        : std;
    let checks = 0;
    for (let n = 0; n < 150; n++) {
      const tasks = Array.from({ length: 6 }, (_, i) => {
        const elapsed = rnd() < 0.4;
        return t(
          `t${i}`,
          Math.floor(rnd() * 4) * (elapsed ? 720 : 540),
          elapsed ? { durationElapsed: true } : {},
        );
      });
      const links: Link[] = [];
      for (let i = 1; i < 6; i++) {
        links.push({
          id: `l${i}`,
          source: `t${Math.floor(rnd() * i)}`,
          target: `t${i}`,
          type: types[Math.floor(rnd() * 4)] ?? 'FS',
          lag: Math.floor(rnd() * 3) * 540,
        });
      }
      const base = schedule(project(tasks, links));
      // Total float: the slack before the PROJECT finish moves. A later finish
      // counts only if working time passed in that task's own calendar.
      const projectEnd = Math.max(...base.tasks.map((x) => x.computed?.earlyFinish.getTime() ?? 0));
      const moved = (p: Project) =>
        p.tasks.some((x) => {
          const f = x.computed?.earlyFinish;
          return (
            !!f &&
            f.getTime() > projectEnd &&
            workingMinutesBetween(new Date(projectEnd), f, ownCal(x)) > 0
          );
        });
      for (const task of base.tasks) {
        const float = task.computed?.totalSlack ?? 0;
        for (const [extra, expected] of [
          [0, false],
          [60, true],
        ] as const) {
          const date = addWorkingMinutes(
            task.computed?.earlyStart ?? d(5),
            float + extra,
            ownCal(task),
          );
          const slipped = schedule(
            project(
              tasks.map((x) =>
                x.id === task.id ? { ...x, constraint: { type: 'SNET' as const, date } } : x,
              ),
              links,
            ),
          );
          checks++;
          expect(moved(slipped), `case ${n} ${task.id} +${float}+${extra}`).toBe(expected);
        }
      }
    }
    expect(checks).toBeGreaterThan(1000);
  });
});
