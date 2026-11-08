import { describe, expect, test } from 'vitest';
import { nzPublicHolidays } from '../calendars/nz-holidays';
import { schedule } from '../schedule';
import type { Calendar, Project } from '../types';
import { parseMspdi } from './parse';
import { serializeMspdi } from './serialize';

// docs/msproject-import.md: the "add the public holidays the file is missing"
// recipe, verbatim, so the doc can't drift from what works.
function withNzHolidays(project: Project, years: number[], region?: 'wellington'): Project {
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const holidays = nzPublicHolidays(years, region);
  return {
    ...project,
    calendars: project.calendars.map((calendar) => {
      if (calendar.id !== project.defaultCalendarId) return calendar;
      const listed = new Set(calendar.exceptions.map((e) => key(e.date)));
      return {
        ...calendar,
        exceptions: [...calendar.exceptions, ...holidays.filter((h) => !listed.has(key(h.date)))],
      };
    }),
  };
}

const AM = { startMinutes: 480, endMinutes: 720 };
const PM = { startMinutes: 780, endMinutes: 1020 };
// An MS Project-style calendar that lists a shutdown day but no 2026 holidays.
const msp: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [AM, PM], [AM, PM], [AM, PM], [AM, PM], [AM, PM], []],
  exceptions: [{ date: new Date(2026, 11, 24), isWorking: false, name: 'Shutdown' }],
};
const FRI_24_APR = new Date(2026, 3, 24, 8);
const xml = serializeMspdi({
  start: FRI_24_APR,
  defaultCalendarId: 'std',
  tasks: [
    {
      id: '1',
      text: 'Frame',
      type: 'task',
      scheduleMode: 'auto',
      duration: 3 * 480,
      start: FRI_24_APR,
      end: FRI_24_APR,
      progress: 0,
      constraint: { type: 'SNET', date: FRI_24_APR },
    },
  ],
  links: [],
  resources: [],
  calendars: [msp],
  baselines: [],
  assignments: [],
});

describe('docs/msproject-import.md recipe', () => {
  test('the file calendar alone works Anzac Day (observed Mon 27 Apr); with NZ holidays added it skips it', () => {
    const { project } = parseMspdi(xml);
    expect(schedule(project).tasks[0]?.end).toEqual(new Date(2026, 3, 28, 17));
    const fixed = withNzHolidays(project, [2026], 'wellington');
    expect(schedule(fixed).tasks[0]?.end).toEqual(new Date(2026, 3, 29, 17));
  });

  test("the file's own exceptions stay, and a day it already lists isn't added twice", () => {
    const { project } = parseMspdi(xml);
    const withXmas = {
      ...project,
      calendars: project.calendars.map((c) => ({
        ...c,
        exceptions: [
          ...c.exceptions,
          { date: new Date(2026, 11, 25), isWorking: false, name: 'Own' },
        ],
      })),
    };
    const cal = withNzHolidays(withXmas, [2026]).calendars.find(
      (c) => c.id === project.defaultCalendarId,
    );
    const on = (m: number, d: number) =>
      cal?.exceptions.filter((e) => e.date.getMonth() === m && e.date.getDate() === d) ?? [];
    expect(on(11, 24)).toHaveLength(1); // the file's shutdown day
    expect(on(11, 25).map((e) => e.name)).toEqual(['Own']);
    expect(on(3, 27)).toHaveLength(1);
  });
});
