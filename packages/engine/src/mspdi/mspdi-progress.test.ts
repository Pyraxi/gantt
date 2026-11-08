import { describe, expect, test } from 'vitest';
import type { Project, Task } from '../types';
import { parseMspdi } from './parse';
import { serializeMspdi } from './serialize';

// Parity row 6 (MSPDI half): status date + actuals round-trip.

const STD = { startMinutes: 480, endMinutes: 1020 };
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 5 * 540,
  start: d(5),
  end: d(9, 17),
  progress: 0,
  ...extra,
});
const project = (tasks: Task[], extra: Partial<Project> = {}): Project => ({
  start: d(5),
  defaultCalendarId: 'std',
  tasks,
  links: [],
  resources: [],
  calendars: [
    {
      id: 'std',
      name: 'Std',
      workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
      exceptions: [],
    },
  ],
  baselines: [],
  assignments: [],
  ...extra,
});

describe('MSPDI status date + actuals', () => {
  test('StatusDate, ActualStart, ActualFinish and RemainingDuration round-trip', () => {
    const p = project(
      [
        task('ip', { progress: 40, actualStart: d(5), remainingDuration: 2 * 540 }),
        task('done', { progress: 100, actualStart: d(5), actualFinish: d(8, 17) }),
        task('todo'),
      ],
      { statusDate: d(14) },
    );
    const xml = serializeMspdi(p);
    expect(xml).toMatch(/<StatusDate>2026-01-14T08:00:00<\/StatusDate>/);
    const back = parseMspdi(xml).project;
    expect(back.statusDate).toEqual(d(14));
    const by = new Map(back.tasks.map((t) => [t.text, t]));
    // 2 days done (40% of 5) and 2 to go: MS Project's Duration = actual +
    // remaining, so the file says 4 days at 50%, and the 2 remaining days
    // come back as that share.
    expect(by.get('ip')).toMatchObject({ actualStart: d(5), duration: 4 * 540, progress: 50 });
    expect(by.get('done')).toMatchObject({ actualStart: d(5), actualFinish: d(8, 17) });
    expect(by.get('todo')?.actualStart).toBeUndefined();
    expect(by.get('todo')?.remainingDuration).toBeUndefined();
  });

  test('Task elements stay in schema order (actuals after PercentComplete, before ConstraintType)', () => {
    const xml = serializeMspdi(
      project([
        task('ip', {
          progress: 40,
          actualStart: d(5),
          remainingDuration: 540,
          constraint: { type: 'SNET', date: d(5) },
        }),
      ]),
    );
    const i = (tag: string) => xml.indexOf(`<${tag}>`);
    expect(i('PercentComplete')).toBeLessThan(i('ActualStart'));
    expect(i('ActualStart')).toBeLessThan(i('RemainingDuration'));
    expect(i('RemainingDuration')).toBeLessThan(i('ConstraintType'));
    expect(xml.indexOf('<StartDate>')).toBeLessThan(xml.indexOf('<Tasks>'));
  });

  test('RemainingDuration is only kept for in-progress tasks (MS Project writes it on every task)', () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><StartDate>2026-01-05T08:00:00</StartDate>
      <Tasks>
        <Task><UID>1</UID><ID>1</ID><Name>todo</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT45H0M0S</Duration><PercentComplete>0</PercentComplete><RemainingDuration>PT45H0M0S</RemainingDuration></Task>
        <Task><UID>2</UID><ID>2</ID><Name>ip</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT45H0M0S</Duration><PercentComplete>40</PercentComplete><ActualStart>2026-01-05T08:00:00</ActualStart><RemainingDuration>PT18H0M0S</RemainingDuration></Task>
        <Task><UID>3</UID><ID>3</ID><Name>share</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT45H0M0S</Duration><PercentComplete>40</PercentComplete><ActualStart>2026-01-05T08:00:00</ActualStart><RemainingDuration>PT27H0M0S</RemainingDuration></Task>
      </Tasks></Project>`;
    const { project: p, droppedFields } = parseMspdi(xml);
    const by = new Map(p.tasks.map((t) => [t.text, t]));
    expect(by.get('todo')?.remainingDuration).toBeUndefined();
    expect(by.get('ip')).toMatchObject({ actualStart: d(5), remainingDuration: 18 * 60 });
    // Exactly the % share (60% of 45 h): no information, not pinned.
    expect(by.get('share')?.remainingDuration).toBeUndefined();
    expect(droppedFields.some((f) => /ActualStart|RemainingDuration|StatusDate/.test(f.path))).toBe(
      false,
    );
  });

  test('no status date / actuals → none written; RemainingDuration is the whole duration', () => {
    const xml = serializeMspdi(project([task('a')]));
    expect(xml).not.toMatch(/StatusDate|ActualStart|ActualFinish/);
    // MS Project's importer needs it on every task (desktop check 2026-10-21).
    const duration = xml.match(/<Duration>([^<]*)<\/Duration>/)?.[1];
    expect(xml).toContain(`<RemainingDuration>${duration}</RemainingDuration>`);
    // A not-started task's remaining work isn't kept on parse.
    expect(parseMspdi(xml).project.tasks[0]?.remainingDuration).toBeUndefined();
  });

  test("physical % complete round-trips, in schema order; MS Project's 0 on every task is not kept", () => {
    const p = project([
      task('a', { progress: 40, physicalProgress: 25, actualStart: d(5) }),
      task('b', { progress: 0 }),
    ]);
    const xml = serializeMspdi(p);
    const first = xml.slice(xml.indexOf('<Task>'), xml.indexOf('</Task>'));
    expect(first).toContain('<PhysicalPercentComplete>25</PhysicalPercentComplete>');
    // xsd / MPXJ order: IgnoreResourceCalendar → PhysicalPercentComplete → PredecessorLink.
    expect(first.indexOf('<ActualStart>')).toBeGreaterThan(0);
    expect(first.indexOf('<PhysicalPercentComplete>')).toBeGreaterThan(
      first.indexOf('<ActualStart>'),
    );
    const back = parseMspdi(xml).project;
    expect(back.tasks.map((x) => x.physicalProgress)).toEqual([25, undefined]);
    const zero = parseMspdi(xml.replace('>25<', '>0<')).project;
    expect(zero.tasks[0]?.physicalProgress).toBeUndefined();
    // Whole percent both ways; over 100 is clamped and reported.
    expect(parseMspdi(xml.replace('>25<', '>37.5<')).project.tasks[0]?.physicalProgress).toBe(38);
    const over = parseMspdi(xml.replace('>25<', '>150<'));
    expect(over.project.tasks[0]?.physicalProgress).toBe(100);
    expect(over.droppedFields.some((x) => /PhysicalPercentComplete/.test(x.path))).toBe(true);
    // NaN never reaches the file.
    const dropped: { path: string }[] = [];
    const nan = serializeMspdi(project([task('a', { physicalProgress: Number.NaN })]), {
      droppedFields: dropped as never,
    });
    expect(nan).not.toContain('PhysicalPercentComplete');
    expect(dropped.some((x) => x.path.endsWith('physicalProgress'))).toBe(true);
  });
});
