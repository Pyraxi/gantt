import { describe, expect, test } from 'vitest';
import { schedule } from '../schedule';
import { parseMspdi } from './parse';
import { serializeMspdi } from './serialize';

// Parity row 4 (MSPDI half): derived calendars carry only the weekdays that
// differ from their base. Missing weekdays are inherited, not non-working.

const WD = (day: number, working: boolean) =>
  working
    ? `<WeekDay><DayType>${day}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>08:00:00</FromTime><ToTime>17:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>`
    : `<WeekDay><DayType>${day}</DayType><DayWorking>0</DayWorking></WeekDay>`;

const STANDARD = `<Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
  <WeekDays>${WD(1, false)}${WD(2, true)}${WD(3, true)}${WD(4, true)}${WD(5, true)}${WD(6, true)}${WD(7, false)}</WeekDays></Calendar>`;

// Resource calendar as MS Project writes it: derived from Standard, only Friday listed (off).
const PLASTERER = `<Calendar><UID>2</UID><Name>Plasterer</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID>
  <WeekDays>${WD(6, false)}</WeekDays></Calendar>`;

// Derived with no WeekDays at all — the most common resource calendar shape.
const JOE = `<Calendar><UID>3</UID><Name>Joe</Name><IsBaseCalendar>0</IsBaseCalendar><BaseCalendarUID>1</BaseCalendarUID></Calendar>`;

const file = (
  taskExtra = '',
) => `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project">
  <Name>X</Name><StartDate>2026-01-05T08:00:00</StartDate><CalendarUID>1</CalendarUID>
  <Calendars>${STANDARD}${PLASTERER}${JOE}</Calendars>
  <Tasks><Task><UID>1</UID><ID>1</ID><Name>Plaster</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-09T17:00:00</Finish><Duration>PT45H0M0S</Duration>${taskExtra}</Task></Tasks>
  <Resources><Resource><UID>1</UID><ID>1</ID><Name>Plasterer</Name><CalendarUID>2</CalendarUID></Resource>
    <Resource><UID>2</UID><ID>2</ID><Name>Joe</Name><CalendarUID>3</CalendarUID></Resource></Resources>
  <Assignments><Assignment><UID>1</UID><TaskUID>1</TaskUID><ResourceUID>1</ResourceUID><Units>1</Units></Assignment></Assignments>
</Project>`;

describe('MSPDI derived calendars', () => {
  test('missing WeekDays in a derived calendar parse as inheritedDays', () => {
    const { project } = parseMspdi(file());
    const plas = project.calendars.find((c) => c.id === '2');
    expect(plas?.baseCalendarId).toBe('1');
    expect(plas?.inheritedDays).toEqual([0, 1, 2, 3, 4, 6]);
    expect(plas?.workWeek[5]).toEqual([]);
    const joe = project.calendars.find((c) => c.id === '3');
    expect(joe?.inheritedDays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('a base calendar gets no inheritedDays', () => {
    const { project } = parseMspdi(file());
    expect(project.calendars.find((c) => c.id === '1')?.inheritedDays).toBeUndefined();
  });

  test('schedule() works the imported task in Standard ∩ Plasterer (Fridays off)', () => {
    const out = schedule(parseMspdi(file()).project);
    const t = out.tasks[0];
    // 5 days, Mon-Thu + next Mon.
    expect(t?.computed?.earlyFinish).toEqual(new Date(2026, 0, 12, 17));
    expect(t?.computed?.calendarFallback).toBeUndefined();
  });

  test('serialize writes BaseCalendarUID and omits inherited WeekDays; round-trip is stable', () => {
    const { project } = parseMspdi(file());
    const xml = serializeMspdi(project);
    const plasXml = xml.slice(
      xml.indexOf('<Name>Plasterer</Name>'),
      xml.indexOf('</Calendar>', xml.indexOf('<Name>Plasterer</Name>')),
    );
    expect(plasXml).toContain('<BaseCalendarUID>1</BaseCalendarUID>');
    expect(plasXml.match(/<DayType>[1-7]<\/DayType>/g)).toEqual(['<DayType>6</DayType>']);
    const again = parseMspdi(xml).project;
    expect(again.calendars.find((c) => c.id === '2')).toEqual(
      project.calendars.find((c) => c.id === '2'),
    );
    expect(again.calendars.find((c) => c.id === '3')).toEqual(
      project.calendars.find((c) => c.id === '3'),
    );
  });

  test('BaseCalendarUID follows the integer remap', () => {
    const { project } = parseMspdi(file());
    project.calendars = project.calendars.map((c) =>
      c.id === '1'
        ? { ...c, id: 'std' }
        : c.baseCalendarId === '1'
          ? { ...c, baseCalendarId: 'std' }
          : c,
    );
    project.defaultCalendarId = 'std';
    const xml = serializeMspdi(project, { remapIdsToIntegers: true });
    expect(xml).not.toContain('<BaseCalendarUID>std</BaseCalendarUID>');
    const again = parseMspdi(xml).project;
    const plas = again.calendars.find((c) => c.name === 'Plasterer');
    const std = again.calendars.find((c) => c.name === 'Standard');
    expect(plas?.baseCalendarId).toBe(std?.id);
  });

  test('a base id with no calendar is reported and re-based onto the default calendar', () => {
    const { project } = parseMspdi(file());
    project.calendars = project.calendars.map((c) =>
      c.id === '3' ? { ...c, baseCalendarId: 'gone' } : c,
    );
    const droppedFields: import('./types.js').DroppedField[] = [];
    const xml = serializeMspdi(project, { droppedFields });
    expect(xml).not.toContain('<BaseCalendarUID>gone</BaseCalendarUID>');
    expect(droppedFields.some((d) => /gone/.test(d.value))).toBe(true);
    // Joe inherits all seven days, so re-basing onto Standard keeps him working.
    const joe = parseMspdi(xml).project.calendars.find((c) => c.name === 'Joe');
    expect(joe?.baseCalendarId).toBe('1');
  });
});

describe('MSPDI IgnoreResourceCalendar', () => {
  test('round-trips to Task.ignoreResourceCalendar and is honoured by schedule()', () => {
    const { project } = parseMspdi(file('<IgnoreResourceCalendar>1</IgnoreResourceCalendar>'));
    expect(project.tasks[0]?.ignoreResourceCalendar).toBe(true);
    expect(schedule(project).tasks[0]?.computed?.earlyFinish).toEqual(new Date(2026, 0, 9, 17));
    const again = parseMspdi(serializeMspdi(project)).project;
    expect(again.tasks[0]?.ignoreResourceCalendar).toBe(true);
  });

  test('0 / absent leaves the field unset', () => {
    expect(
      parseMspdi(file('<IgnoreResourceCalendar>0</IgnoreResourceCalendar>')).project.tasks[0]
        ?.ignoreResourceCalendar,
    ).toBeUndefined();
    expect(parseMspdi(file()).project.tasks[0]?.ignoreResourceCalendar).toBeUndefined();
  });
});

describe('MSPDI "24 Hours" calendar (ToTime 00:00:00 = end of day)', () => {
  // MS Project writes its 24 Hours base calendar as 00:00:00 → 00:00:00 every
  // day; MPXJ 16.4 reads that as 24 h, and 08:00:00 → 00:00:00 as 16 h.
  const H24 = (day: number, from = '00:00:00') =>
    `<WeekDay><DayType>${day}</DayType><DayWorking>1</DayWorking><WorkingTimes><WorkingTime><FromTime>${from}</FromTime><ToTime>00:00:00</ToTime></WorkingTime></WorkingTimes></WeekDay>`;
  const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project">
  <Name>X</Name><StartDate>2026-01-05T00:00:00</StartDate><CalendarUID>1</CalendarUID>
  <Calendars>${STANDARD}<Calendar><UID>4</UID><Name>24 Hours</Name><IsBaseCalendar>1</IsBaseCalendar><BaseCalendarUID>-1</BaseCalendarUID>
    <WeekDays>${H24(1)}${H24(2)}${H24(3)}${H24(4)}${H24(5)}${H24(6, '08:00:00')}${H24(7)}</WeekDays></Calendar></Calendars>
  <Tasks><Task><UID>1</UID><ID>1</ID><Name>Cure</Name><Start>2026-01-05T00:00:00</Start><Finish>2026-01-07T00:00:00</Finish><Duration>PT48H0M0S</Duration><CalendarUID>4</CalendarUID></Task></Tasks>
</Project>`;

  test('parses to a 0–1440 day and schedules on it (no fallback to Standard)', () => {
    const { project } = parseMspdi(xml);
    const cal = project.calendars.find((c) => c.name === '24 Hours');
    expect(cal?.workWeek[1]).toEqual([{ startMinutes: 0, endMinutes: 1440 }]);
    expect(cal?.workWeek[5]).toEqual([{ startMinutes: 480, endMinutes: 1440 }]);
    const cure = schedule(project).tasks.find((t) => t.text === 'Cure');
    expect(cure?.computed?.calendarFallback).toBeUndefined();
    expect(cure?.computed?.earlyStart).toEqual(new Date(2026, 0, 5, 0, 0));
    expect(cure?.computed?.earlyFinish).toEqual(new Date(2026, 0, 7, 0, 0));
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
