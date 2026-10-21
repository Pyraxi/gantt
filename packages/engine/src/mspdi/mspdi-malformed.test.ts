// Malformed / partial MSPDI input robustness (2026-07-08 review, chunk 03 §P1 #11).
// The happy-path round-trip is covered in mspdi.test.ts; this file pins the
// graceful-degradation contract for inputs a genuine MS Project export (or a
// third-party MSPDI writer) can emit: no hard crashes, no Invalid Date / NaN in
// the model or serialized XML, and lossy drops reported via `droppedFields`.

import { describe, expect, test } from 'vitest';
import type { Project } from '../types.js';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';

const wrap = (tasksXml: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Malformed fixture</Name>
  <Tasks>
${tasksXml}
  </Tasks>
</Project>`;

const task = (uid: string, extra: string) => `    <Task>
      <UID>${uid}</UID>
      <ID>${uid}</ID>
      <Name>Task ${uid}</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-05T17:00:00</Finish>
      <Duration>PT8H0M0S</Duration>
${extra}
    </Task>`;

describe('MSPDI malformed-input robustness', () => {
  test('F-2: non-numeric OutlineLevel degrades to level 1, never RangeError-crashes', () => {
    const xml = wrap(task('1', '      <OutlineLevel>abc</OutlineLevel>'));
    expect(() => parseMspdi(xml)).not.toThrow();
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]?.parent).toBeUndefined(); // clamped to top-level
    expect(droppedFields.some((d) => /OutlineLevel/.test(d.path))).toBe(true);
  });

  test('F-2b: absurdly large finite OutlineLevel does not RangeError-crash (outlineStack.length overflow)', () => {
    // Number.isFinite(5e9) is true, so the F-2 guard passed it through to
    // `outlineStack.length = 5e9` → RangeError: Invalid array length (JS caps
    // array length at 2^32-1). Must degrade to top-level + report instead.
    const xml = wrap(task('1', '      <OutlineLevel>5000000000</OutlineLevel>'));
    expect(() => parseMspdi(xml)).not.toThrow();
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]?.parent).toBeUndefined();
    expect(droppedFields.some((d) => /OutlineLevel/.test(d.path))).toBe(true);
  });

  test('F-11: garbage ConstraintDate is dropped, never stored as Invalid Date', () => {
    const xml = wrap(
      task(
        '1',
        '      <ConstraintType>4</ConstraintType>\n      <ConstraintDate>not-a-date</ConstraintDate>',
      ),
    );
    const { project, droppedFields } = parseMspdi(xml);
    const c = project.tasks[0]?.constraint;
    expect(c?.type).toBe('SNET'); // constraint type still recognized
    expect(c?.date).toBeUndefined(); // invalid date dropped, no Invalid Date leaks
    expect(droppedFields.some((d) => /ConstraintDate/.test(d.path))).toBe(true);
  });

  test('F-1: a <Baseline> without Start/Finish never serializes NaN dates; reports dropped', () => {
    const xml = wrap(
      task(
        '1',
        '      <Baseline>\n        <Number>0</Number>\n        <Duration>PT8H0M0S</Duration>\n      </Baseline>',
      ),
    );
    const { project, droppedFields } = parseMspdi(xml);
    // The snapshot with no dates must be skipped, not carried as Invalid Date.
    expect(project.baselines.flatMap((b) => [...b.tasks.values()])).toEqual([]);
    const out = serializeMspdi(project);
    expect(out).not.toMatch(/NaN/);
    expect(droppedFields.some((d) => /Baseline\[\d+\]\.(Start|Finish)/.test(d.path))).toBe(true);
  });
});

describe('inverted / zero-length calendar intervals (serialize)', () => {
  // The engine ignores an interval whose end is at or before its start; the
  // file must not carry it, and a day of only such intervals is non-working.
  const W = [{ startMinutes: 480, endMinutes: 1020 }];
  const BAD = [
    { startMinutes: 1020, endMinutes: 480 },
    { startMinutes: 600, endMinutes: 600 },
  ];
  const project: Project = {
    start: new Date(2026, 0, 5, 8),
    defaultCalendarId: 'c',
    tasks: [],
    links: [],
    resources: [],
    baselines: [],
    assignments: [],
    calendars: [
      {
        id: 'c',
        name: 'Odd',
        workWeek: [[], [...W, ...BAD], W, W, W, BAD, []],
        exceptions: [
          { date: new Date(2026, 0, 7), isWorking: true, intervals: BAD },
          {
            date: new Date(2026, 0, 8),
            isWorking: true,
            intervals: [BAD[0], { startMinutes: 480, endMinutes: 720 }],
          },
        ],
      },
    ],
  };

  test('only intervals with working time are written; an inverted-only day is non-working', () => {
    const xml = serializeMspdi(project);
    expect(xml).not.toContain('<FromTime>17:00:00</FromTime>');
    expect(xml).not.toContain('<FromTime>10:00:00</FromTime>');
    const cal = parseMspdi(xml).project.calendars.find((c) => c.name === 'Odd');
    expect(cal?.workWeek[1]).toEqual(W); // Monday keeps only its real shift
    expect(cal?.workWeek[5]).toEqual([]); // Friday: only inverted → non-working
    expect(cal?.exceptions[0]).toMatchObject({ isWorking: false });
    expect(cal?.exceptions[0]?.intervals).toBeUndefined();
    expect(cal?.exceptions[1]).toMatchObject({
      isWorking: true,
      intervals: [{ startMinutes: 480, endMinutes: 720 }],
    });
  });
});

describe('MSPDI "24 Hours" calendar (ToTime 00:00:00 = end of day)', () => {
  // MS Project writes its 24 Hours base calendar as 00:00:00 → 00:00:00 every
  // day; MPXJ 16.4 reads that as 24 h, and 08:00:00 → 00:00:00 as 16 h.
  const H24 = (day: number, from = '00:00:00') =>
    `<WeekDay><DayType>${day}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>${from}</FromTime><ToTime>00:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>`;
  const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project">
  <Name>X</Name><StartDate>2026-01-05T00:00:00</StartDate><CalendarUID>4</CalendarUID>
  <Calendars><Calendar><UID>4</UID><Name>24 Hours</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
    <WeekDays>${H24(1)}${H24(2)}${H24(3)}${H24(4)}${H24(5)}${H24(6, '08:00:00')}${H24(7)}</WeekDays></Calendar></Calendars>
  <Tasks><Task><UID>1</UID><ID>1</ID><Name>Cure</Name><Start>2026-01-05T00:00:00</Start><Finish>2026-01-07T00:00:00</Finish><Duration>PT48H0M0S</Duration></Task></Tasks>
</Project>`;

  test('parses to a 0–1440 day', () => {
    const { project } = parseMspdi(xml);
    const cal = project.calendars.find((c) => c.name === '24 Hours');
    expect(cal?.workWeek[1]).toEqual([{ startMinutes: 0, endMinutes: 1440 }]);
    expect(cal?.workWeek[5]).toEqual([{ startMinutes: 480, endMinutes: 1440 }]);
  });

  test('serialises end of day back as 00:00:00 and round-trips', () => {
    const { project } = parseMspdi(xml);
    const out = serializeMspdi(project);
    expect(out).not.toContain('24:00:00');
    const again = parseMspdi(out).project.calendars.find((c) => c.name === '24 Hours');
    const before = project.calendars.find((c) => c.name === '24 Hours');
    expect(again?.workWeek).toEqual(before?.workWeek);
  });

  test('a missing ToTime is not read as end of day', () => {
    const { project } = parseMspdi(
      xml.replace(
        `${H24(2)}`,
        '<WeekDay><DayType>2</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime></WorkingTime></WorkingTimes></WeekDay>',
      ),
    );
    const cal = project.calendars.find((c) => c.name === '24 Hours');
    expect(cal?.workWeek[1]).toEqual([{ startMinutes: 480, endMinutes: 0 }]);
  });
});
