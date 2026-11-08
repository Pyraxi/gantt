// MS Project desktop import check (2026-10-21): what its XML importer needs
// beyond the schema. Results: docs/release/desktop-check/results/results.md.
import { describe, expect, test } from 'vitest';
import { progressState, schedule } from '../schedule.js';
import type { Calendar, Project, Task } from '../types.js';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';

const NINE = { startMinutes: 7 * 60 + 30, endMinutes: 16 * 60 + 30 };
const std: Calendar = {
  id: 'site',
  name: 'Site 7:30–4:30',
  workWeek: [[], [NINE], [NINE], [NINE], [NINE], [NINE], []],
  exceptions: [],
};
const other: Calendar = { ...std, id: 'other', name: 'Other' };
const MON = new Date(2026, 0, 5, 7, 30);
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const project = (tasks: Task[], extra: Partial<Project> = {}): Project => ({
  start: MON,
  // Not the first calendar: the root's CalendarUID must carry it.
  defaultCalendarId: 'site',
  tasks,
  links: [],
  resources: [],
  calendars: [other, std],
  baselines: [],
  assignments: [],
  ...extra,
});
const rootField = (xml: string, name: string) =>
  xml.match(new RegExp(`^  <${name}>([^<]*)</${name}>`, 'm'))?.[1];

describe('MS Project import needs', () => {
  test('root: schedule from start, project calendar, its day start and day / week length', () => {
    const xml = serializeMspdi(project([task('a')]), { remapIdsToIntegers: true });
    expect(rootField(xml, 'ScheduleFromStart')).toBe('1');
    expect(rootField(xml, 'CalendarUID')).toBe('2'); // 'site', the second calendar
    expect(rootField(xml, 'DefaultStartTime')).toBe('07:30:00');
    expect(rootField(xml, 'MinutesPerDay')).toBe('540');
    expect(rootField(xml, 'MinutesPerWeek')).toBe('2700');
    // Schema order: ScheduleFromStart, StartDate, CalendarUID, DefaultStartTime,
    // MinutesPerDay, MinutesPerWeek.
    const at = (n: string) => xml.indexOf(`<${n}>`);
    const seq = [
      'ScheduleFromStart',
      'StartDate',
      'CalendarUID',
      'DefaultStartTime',
      'MinutesPerDay',
      'MinutesPerWeek',
    ];
    expect(seq.map(at)).toEqual([...seq.map(at)].sort((x, y) => x - y));
    expect(at('MinutesPerWeek')).toBeLessThan(at('Calendars'));
  });

  test('parse takes the project calendar from the root CalendarUID', () => {
    const xml = serializeMspdi(project([task('a')]));
    expect(parseMspdi(xml).project.defaultCalendarId).toBe('site');
  });

  test('every task says it is not an estimate', () => {
    const xml = serializeMspdi(project([task('a'), task('b', { type: 'milestone', duration: 0 })]));
    expect(xml.match(/<Estimated>0<\/Estimated>/g)).toHaveLength(2);
  });

  test('ignore resource calendars on a task without its own calendar names the default', () => {
    const xml = serializeMspdi(project([task('a', { ignoreResourceCalendar: true }), task('b')]));
    const blocks = xml.split('<Task>').slice(1);
    expect(blocks[0]).toContain('<CalendarUID>site</CalendarUID>');
    expect(blocks[0]).toContain('<IgnoreResourceCalendar>1</IgnoreResourceCalendar>');
    expect(blocks[1]).not.toContain('<CalendarUID>');
    // Round trip: the task keeps the flag, on the calendar the engine used anyway.
    const back = parseMspdi(xml).project.tasks[0];
    expect(back?.ignoreResourceCalendar).toBe(true);
    expect(back?.calendarId).toBe('site');
  });
});

describe('RemainingDuration on every task (the 0-day import)', () => {
  const rem = (xml: string, i: number) =>
    xml.split('<Task>')[i + 1]?.match(/<RemainingDuration>([^<]*)</)?.[1];
  test('not started: the whole duration; in progress: the % share; complete: 0', () => {
    const xml = serializeMspdi(
      project([
        task('a'),
        task('b', { progress: 25, actualStart: MON }),
        task('c', { progress: 100, actualStart: MON, actualFinish: MON }),
        task('m', { type: 'milestone', duration: 0 }),
      ]),
    );
    expect(rem(xml, 0)).toBe('PT9H0M0S');
    expect(rem(xml, 1)).toBe('PT6H45M0S');
    expect(rem(xml, 2)).toBe('PT0H0M0S');
    expect(rem(xml, 3)).toBe('PT0H0M0S');
  });
  test('durations display in days (7), elapsed ones in elapsed days (8)', () => {
    const xml = serializeMspdi(
      project([task('a'), task('e', { duration: 3 * 1440, durationElapsed: true })]),
    );
    const fmt = (i: number) => xml.split('<Task>')[i + 1]?.match(/<DurationFormat>(\d+)</)?.[1];
    expect(fmt(0)).toBe('7');
    expect(fmt(1)).toBe('8');
  });
});

describe('review follow-ups', () => {
  test('a derived default calendar exports its resolved day (not the 480 fallback)', () => {
    const base: Calendar = { ...std, id: 'base', name: 'Base' };
    const derived: Calendar = {
      id: 'site',
      name: 'Site (derived)',
      baseCalendarId: 'base',
      inheritedDays: [0, 1, 2, 3, 4, 5, 6],
      workWeek: [[], [], [], [], [], [], []],
      exceptions: [],
    };
    const xml = serializeMspdi(project([task('a')], { calendars: [base, derived] }));
    expect(rootField(xml, 'MinutesPerDay')).toBe('540');
    expect(rootField(xml, 'MinutesPerWeek')).toBe('2700');
    expect(rootField(xml, 'DefaultStartTime')).toBe('07:30:00');
    expect(rootField(xml, 'DefaultFinishTime')).toBe('16:30:00');
  });

  test('DefaultFinishTime sits between DefaultStartTime and MinutesPerDay; none for a day to midnight', () => {
    const xml = serializeMspdi(project([task('a')]));
    expect(xml.indexOf('<DefaultStartTime>')).toBeLessThan(xml.indexOf('<DefaultFinishTime>'));
    expect(xml.indexOf('<DefaultFinishTime>')).toBeLessThan(xml.indexOf('<MinutesPerDay>'));
    const h24: Calendar = {
      id: 'site',
      name: '24 Hours',
      workWeek: Array.from({ length: 7 }, () => [{ startMinutes: 0, endMinutes: 1440 }]),
      exceptions: [],
    };
    const x24 = serializeMspdi(project([task('a')], { calendars: [h24] }));
    expect(rootField(x24, 'DefaultFinishTime')).toBeUndefined();
    expect(rootField(x24, 'MinutesPerDay')).toBe('1440');
  });

  test('an in-progress round trip stays identity: the % share is not pinned as remainingDuration', () => {
    const p = project([task('a', { duration: 2160, progress: 25, actualStart: MON })], {
      statusDate: new Date(2026, 0, 6, 7, 30),
    });
    const back = parseMspdi(serializeMspdi(p)).project.tasks[0];
    expect(back?.remainingDuration).toBeUndefined();
    // A real forecast (not the share) comes back as the exact share of the
    // file's Duration = actual + remaining: the same 300 minutes to go.
    const forecast = project([
      task('a', { duration: 2160, progress: 25, actualStart: MON, remainingDuration: 300 }),
    ]);
    const f = parseMspdi(serializeMspdi(forecast)).project.tasks[0] as Task;
    expect(f.duration * (1 - f.progress / 100)).toBeCloseTo(300, 6);
  });

  test('progress missing on a started task writes a valid remaining duration, not NaN', () => {
    const xml = serializeMspdi(
      project([task('a', { progress: undefined as unknown as number, actualStart: MON })]),
    );
    expect(xml).not.toContain('NaN');
    expect(xml).toContain('<RemainingDuration>PT9H0M0S</RemainingDuration>');
  });
});

const timephased = (xml: string) =>
  [...xml.matchAll(/<TimephasedData>([\s\S]*?)<\/TimephasedData>/g)].map((m) =>
    ['Type', 'Start', 'Finish', 'Value'].map((k) => m[1]?.match(new RegExp(`<${k}>([^<]*)<`))?.[1]),
  );

describe('desktop check run 2: started tasks and assignments', () => {
  const field = (xml: string, i: number, name: string) =>
    xml.split('<Task>')[i + 1]?.match(new RegExp(`<${name}>([^<]*)<`))?.[1];

  test('a started task writes ActualDuration (MS Project reads Duration = actual + remaining)', () => {
    const xml = serializeMspdi(
      project([
        task('a'),
        task('b', { duration: 2700, progress: 40, actualStart: MON }),
        task('c', { progress: 100, actualStart: MON, actualFinish: new Date(2026, 0, 5, 16, 30) }),
      ]),
    );
    expect(field(xml, 0, 'ActualDuration')).toBeUndefined();
    expect(field(xml, 1, 'ActualDuration')).toBe('PT18H0M0S');
    expect(field(xml, 1, 'RemainingDuration')).toBe('PT27H0M0S');
    expect(field(xml, 2, 'ActualDuration')).toBe('PT9H0M0S');
    const b = xml.split('<Task>')[2] ?? '';
    expect(b.indexOf('<ActualStart>')).toBeLessThan(b.indexOf('<ActualDuration>'));
    expect(b.indexOf('<ActualDuration>')).toBeLessThan(b.indexOf('<RemainingDuration>'));
  });

  test('remaining work forecast from the status date: Stop / Resume mark the split (fixture 05)', () => {
    // 5 days, 40% done from Mon; status date Thu → 2 days done, Wed idle,
    // 3 days remaining Thu, Fri, Mon.
    const p = schedule(
      project([task('a', { duration: 2700, progress: 40, actualStart: MON })], {
        rescheduleAfterStatusDate: true,
        statusDate: new Date(2026, 0, 8, 7, 30),
      }),
    );
    const xml = serializeMspdi(p);
    expect(field(xml, 0, 'Finish')).toBe('2026-01-12T16:30:00');
    expect(field(xml, 0, 'Stop')).toBe('2026-01-06T16:30:00');
    expect(field(xml, 0, 'Resume')).toBe('2026-01-08T07:30:00');
    const t = xml.split('<Task>')[1] ?? '';
    expect(t.indexOf('<DurationFormat>')).toBeLessThan(t.indexOf('<Stop>'));
    expect(t.indexOf('<Resume>')).toBeLessThan(t.indexOf('<Estimated>'));
    // MS Project ignores Resume across a gap (run 3): the split goes on the
    // placeholder assignment as timephased work, which parse skips. Per day,
    // with no entry for the gap, as MS Project saves it (runs 4-5).
    const asg = xml.split('<Assignment>')[1] ?? '';
    expect(asg).toContain('<ResourceUID>-65535</ResourceUID>');
    expect(timephased(asg)).toEqual([
      ['2', '2026-01-05T07:30:00', '2026-01-06T07:30:00', 'PT9H0M0S'],
      ['2', '2026-01-06T07:30:00', '2026-01-06T16:30:00', 'PT9H0M0S'],
      ['1', '2026-01-08T07:30:00', '2026-01-09T07:30:00', 'PT9H0M0S'],
      ['1', '2026-01-09T07:30:00', '2026-01-10T07:30:00', 'PT9H0M0S'],
      ['1', '2026-01-10T07:30:00', '2026-01-12T07:30:00', 'PT0H0M0S'],
      ['1', '2026-01-12T07:30:00', '2026-01-12T16:30:00', 'PT9H0M0S'],
    ]);
    const back = parseMspdi(xml);
    expect(back.project.assignments).toEqual([]);
    expect(back.droppedFields.map((f) => f.value)).toEqual([
      '1 unassigned-task placeholder assignment(s) (ResourceUID -65535) skipped',
    ]);
    // No gap (status date the morning after the work done): no split.
    const flush = schedule(
      project([task('a', { duration: 2700, progress: 40, actualStart: MON })], {
        statusDate: new Date(2026, 0, 7, 7, 30),
      }),
    );
    const flushXml = serializeMspdi(flush);
    expect(field(flushXml, 0, 'Finish')).toBe('2026-01-09T16:30:00');
    expect(flushXml).not.toMatch(/<Stop>|<Resume>/);
  });

  test('assignments carry Start, Finish and work, or MS Project imports a 0-day milestone (fixture 06)', () => {
    const p = project(
      [
        task('a', { duration: 1620, start: MON, end: new Date(2026, 0, 7, 16, 30) }),
        task('b', { duration: 2700, progress: 40, actualStart: MON }),
      ],
      {
        resources: [{ id: 'r', name: 'Crew' }],
        assignments: [
          { id: 'x', taskId: 'a', resourceId: 'r', units: 1 },
          { id: 'y', taskId: 'b', resourceId: 'r', units: 0.5 },
        ],
      },
    );
    const xml = serializeMspdi(p, { remapIdsToIntegers: true });
    const [x, y] = xml.split('<Assignment>').slice(1);
    expect(x).toContain('<Start>2026-01-05T07:30:00</Start>');
    expect(x).toContain('<Finish>2026-01-07T16:30:00</Finish>');
    expect(x).toContain('<Work>PT27H0M0S</Work>');
    expect(x).toContain('<RemainingWork>PT27H0M0S</RemainingWork>');
    expect(x).not.toContain('<ActualWork>');
    // Half units, 40% done: work 22.5 h, actual 9 h, remaining 13.5 h.
    expect(y).toContain('<Work>PT22H30M0S</Work>');
    expect(y).toContain('<ActualWork>PT9H0M0S</ActualWork>');
    expect(y).toContain('<RemainingWork>PT13H30M0S</RemainingWork>');
    expect(y).toContain('<ActualStart>2026-01-05T07:30:00</ActualStart>');
    // xsd order: TaskUID, ResourceUID, ActualStart, ActualWork, Finish,
    // RemainingWork, Start, Units, Work.
    const seq = [
      'ResourceUID',
      'ActualStart',
      'ActualWork',
      'Finish',
      'RemainingWork',
      'Start',
      'Units',
      'Work',
    ];
    const at = seq.map((n) => y?.indexOf(`<${n}>`) ?? -1);
    expect(at.every((v, i) => v > 0 && (i === 0 || v > (at[i - 1] as number)))).toBe(true);
    const back = parseMspdi(xml);
    expect(back.droppedFields).toEqual([]);
    expect(back.project.assignments.map((a) => a.units)).toEqual([undefined, 0.5]);
  });
});

test("MS Project's nameless UID 0 placeholder resource is not imported", () => {
  const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><StartDate>2026-01-05T08:00:00</StartDate>
    <Tasks><Task><UID>1</UID><ID>1</ID><Name>a</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT9H0M0S</Duration></Task></Tasks>
    <Resources>
      <Resource><UID>0</UID><ID>0</ID><Type>1</Type></Resource>
      <Resource><UID>1</UID><ID>1</ID><Name>Framing crew</Name><Type>1</Type></Resource>
    </Resources></Project>`;
  const { project: p, droppedFields } = parseMspdi(xml);
  expect(p.resources).toEqual([{ id: '1', name: 'Framing crew' }]);
  expect(droppedFields.some((f) => /placeholder resource/.test(f.value))).toBe(true);
});

describe('run 2 review follow-ups', () => {
  const field = (xml: string, i: number, name: string) =>
    xml.split('<Task>')[i + 1]?.match(new RegExp(`<${name}>([^<]*)<`))?.[1];
  const THU = new Date(2026, 0, 8, 7, 30);

  test('started with no actualStart: the assignment still carries ActualWork (Work = actual + remaining)', () => {
    const p = schedule(
      project([task('a', { duration: 2700, progress: 40 })], {
        statusDate: THU,
        resources: [{ id: 'r', name: 'Crew' }],
        assignments: [{ id: 'x', taskId: 'a', resourceId: 'r' }],
      }),
    );
    const asg = serializeMspdi(p).split('<Assignment>')[1] ?? '';
    expect(asg).toContain('<ActualStart>2026-01-05T07:30:00</ActualStart>');
    expect(asg).toContain('<ActualWork>PT18H0M0S</ActualWork>');
    expect(asg).toContain('<RemainingWork>PT27H0M0S</RemainingWork>');
  });

  test('an elapsed task in progress gets its split in wall-clock time', () => {
    // 2 edays, half done from Mon; status date Thu → remaining 24 h from Thu.
    const p = schedule(
      project(
        [task('a', { duration: 2880, durationElapsed: true, progress: 50, actualStart: MON })],
        { rescheduleAfterStatusDate: true, statusDate: THU },
      ),
    );
    const xml = serializeMspdi(p);
    expect(field(xml, 0, 'Stop')).toBe('2026-01-06T07:30:00');
    expect(field(xml, 0, 'Resume')).toBe('2026-01-08T07:30:00');
    expect(field(xml, 0, 'Finish')).toBe('2026-01-09T07:30:00');
    expect(timephased(xml.split('<Assignment>')[1] ?? '')).toEqual([
      ['2', '2026-01-05T07:30:00', '2026-01-06T07:30:00', 'PT24H0M0S'],
      ['1', '2026-01-08T07:30:00', '2026-01-09T07:30:00', 'PT24H0M0S'],
    ]);
  });

  test("split work follows the resource's own calendar: no work on its day off", () => {
    // The crew doesn't work Fridays. 5 days at 40% from Mon; status date Thu:
    // remaining Thu, (Fri off), Mon, Tue.
    const crew: Calendar = {
      ...std,
      id: 'crew',
      name: 'Crew',
      workWeek: std.workWeek.map((d, i) => (i === 5 ? [] : d)),
    };
    const p = schedule(
      project([task('a', { duration: 2700, progress: 40, actualStart: MON })], {
        rescheduleAfterStatusDate: true,
        statusDate: THU,
        calendars: [std, crew],
        resources: [{ id: 'r', name: 'Crew', calendarId: 'crew' }],
        assignments: [{ id: 'x', taskId: 'a', resourceId: 'r' }],
      }),
    );
    expect(p.tasks[0]?.end).toEqual(new Date(2026, 0, 13, 16, 30));
    const entries = timephased(serializeMspdi(p).split('<Assignment>')[1] ?? '');
    expect(entries.filter((e) => e[0] === '1')).toEqual([
      ['1', '2026-01-08T07:30:00', '2026-01-09T07:30:00', 'PT9H0M0S'],
      ['1', '2026-01-09T07:30:00', '2026-01-12T07:30:00', 'PT0H0M0S'],
      ['1', '2026-01-12T07:30:00', '2026-01-13T07:30:00', 'PT9H0M0S'],
      ['1', '2026-01-13T07:30:00', '2026-01-13T16:30:00', 'PT9H0M0S'],
    ]);
  });

  test('split work at part units: per-day values sum to the assignment totals', () => {
    // 1/3 units on 5 days at 40%, actual from Mon 08:00 (off the 07:30 day start).
    const p = schedule(
      project([task('a', { duration: 2700, progress: 40, actualStart: new Date(2026, 0, 5, 8) })], {
        rescheduleAfterStatusDate: true,
        statusDate: THU,
        resources: [{ id: 'r', name: 'Crew' }],
        assignments: [{ id: 'x', taskId: 'a', resourceId: 'r', units: 1 / 3 }],
      }),
    );
    const asg = serializeMspdi(p).split('<Assignment>')[1] ?? '';
    const min = (d?: string) => {
      const m = d?.match(/PT(\d+)H(\d+)M/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : Number.NaN;
    };
    const sum = (type: string) =>
      timephased(asg)
        .filter((e) => e[0] === type)
        .reduce((n, e) => n + min(e[3]), 0);
    const tag = (k: string) => asg.match(new RegExp(`<${k}>([^<]*)<`))?.[1];
    expect(sum('2')).toBe(min(tag('ActualWork')));
    expect(sum('1')).toBe(min(tag('RemainingWork')));
    expect(timephased(asg)[0]?.[1]).toBe('2026-01-05T08:00:00');
    // No entry starts inside the gap (Stop → Resume).
    expect(
      timephased(asg).some(
        (e) => (e[1] ?? '') > (tag('Stop') ?? '') && (e[1] ?? '') < (tag('Resume') ?? ''),
      ),
    ).toBe(false);
  });

  test('complete: ActualDuration is the working time between the actual dates', () => {
    const xml = serializeMspdi(
      project([
        task('a', {
          duration: 2700,
          progress: 100,
          actualStart: MON,
          actualFinish: new Date(2026, 0, 7, 16, 30),
        }),
      ]),
    );
    expect(field(xml, 0, 'ActualDuration')).toBe('PT27H0M0S');
    // What it took, not the 5 planned days: MS Project keeps Duration and
    // shows a 5-day duration with 3 days actual as 60%, running on to Fri
    // (desktop run 8, p04).
    expect(field(xml, 0, 'Duration')).toBe('PT27H0M0S');
    expect(field(xml, 0, 'PercentComplete')).toBe('100');
  });

  test('no split on summaries or manual tasks (the engine keeps their dates)', () => {
    const p = schedule(
      project(
        [
          task('m', {
            duration: 2700,
            progress: 40,
            actualStart: MON,
            scheduleMode: 'manual',
            end: new Date(2026, 0, 16, 16, 30),
          }),
        ],
        { rescheduleAfterStatusDate: true, statusDate: THU },
      ),
    );
    expect(serializeMspdi(p)).not.toMatch(/<Stop>|<Resume>/);
  });

  test('actual + remaining sum to the duration; no NaN; non-finite units dropped', () => {
    const odd = serializeMspdi(
      project([task('a', { duration: 2701, progress: 50, actualStart: MON })]),
    );
    expect(field(odd, 0, 'ActualDuration')).toBe('PT22H30M0S');
    expect(field(odd, 0, 'RemainingDuration')).toBe('PT22H31M0S');
    const nan = serializeMspdi(
      project([task('a', { progress: Number.NaN, actualStart: MON })], {
        resources: [{ id: 'r', name: 'Crew' }],
        assignments: [{ id: 'x', taskId: 'a', resourceId: 'r', units: Number.NaN }],
      }),
      { droppedFields: [] },
    );
    expect(nan).not.toMatch(/<ActualDuration>[^<]*NaN/);
    expect(nan).not.toContain('<Assignment>');
  });
});

test("a derived calendar used by one resource is named after it (MS Project's resource calendar)", () => {
  const derived = (id: string, name: string): Calendar => ({
    id,
    name,
    baseCalendarId: 'site',
    inheritedDays: [0, 1, 2, 3, 4, 5, 6],
    workWeek: [[], [], [], [], [], [], []],
    exceptions: [],
  });
  const xml = serializeMspdi(
    project([task('a')], {
      calendars: [std, derived('crew', 'Crew (7 Jan off)'), derived('shared', 'Shared')],
      resources: [
        { id: 'r1', name: 'Framing crew', calendarId: 'crew' },
        { id: 'r2', name: 'A', calendarId: 'shared' },
        { id: 'r3', name: 'B', calendarId: 'shared' },
      ],
    }),
  );
  const names = [...xml.matchAll(/<Calendar>\s*<UID>[^<]*<\/UID>\s*<Name>([^<]*)</g)].map(
    (m) => m[1],
  );
  expect(names).toEqual(['Site 7:30–4:30', 'Framing crew', 'Shared']);
});

describe('desktop run 8: MS Project keeps what the file says', () => {
  const field = (xml: string, name: string) => xml.match(new RegExp(`<${name}>([^<]*)<`))?.[1];
  const inProgress = (extra: Partial<Task> = {}, projectExtra: Partial<Project> = {}) =>
    serializeMspdi(
      schedule(
        project([task('a', { duration: 5 * 540, progress: 40, actualStart: MON, ...extra })], {
          statusDate: new Date(2026, 0, 8, 7, 30),
          ...projectExtra,
        }),
      ),
    );

  test('ProjectExternallyEdited is 0, after StatusDate and before Calendars', () => {
    const xml = inProgress();
    expect(field(xml, 'ProjectExternallyEdited')).toBe('0');
    expect(xml.indexOf('<StatusDate>')).toBeLessThan(xml.indexOf('<ProjectExternallyEdited>'));
    expect(xml.indexOf('<ProjectExternallyEdited>')).toBeLessThan(xml.indexOf('<Calendars>'));
    // Without a status date too: MS Project's own saves always write it.
    expect(field(serializeMspdi(project([task('a')])), 'ProjectExternallyEdited')).toBe('0');
  });

  test('a split task says its Resume is valid, straight after Resume; others have no ResumeValid', () => {
    const task0 = inProgress({}, { rescheduleAfterStatusDate: true }).split('<Task>')[1] ?? '';
    expect(field(task0, 'ResumeValid')).toBe('1');
    expect(task0.indexOf('<Resume>')).toBeLessThan(task0.indexOf('<ResumeValid>'));
    expect(task0.indexOf('<ResumeValid>')).toBeLessThan(task0.indexOf('<Estimated>'));
    expect(serializeMspdi(project([task('a')]))).not.toContain('<ResumeValid>');
  });

  test('a host remaining duration: Duration = actual + remaining, % complete to match', () => {
    // 2 of 5 days done (40%), 4 days to go: 6 days at 33%, as MS Project shows it.
    const xml = inProgress({ remainingDuration: 4 * 540 }, { rescheduleAfterStatusDate: true });
    expect(field(xml, 'Duration')).toBe('PT54H0M0S');
    expect(field(xml, 'ActualDuration')).toBe('PT18H0M0S');
    expect(field(xml, 'RemainingDuration')).toBe('PT36H0M0S');
    expect(field(xml, 'PercentComplete')).toBe('33');
    // The assignment's work agrees with the task.
    const asg = xml.split('<Assignment>')[1] ?? '';
    expect(field(asg, 'Work')).toBe('PT54H0M0S');
  });

  test('% complete is a whole number (xsd:integer)', () => {
    expect(field(inProgress({ progress: 100 / 3 }), 'PercentComplete')).toBe('33');
  });

  test('% complete never rounds an in-progress task to 100, or (unstarted) to 0', () => {
    expect(field(inProgress({ progress: 99.5 }), 'PercentComplete')).toBe('99');
    expect(field(inProgress({ remainingDuration: 5 }), 'PercentComplete')).toBe('99');
    const tiny = inProgress({ progress: 0.4, actualStart: undefined });
    expect(field(tiny, 'PercentComplete')).toBe('1');
    for (const xml of [inProgress({ progress: 99.5 }), tiny]) {
      expect(progressState(parseMspdi(xml).project.tasks[0] as Task)).toBe('in-progress');
    }
  });

  test('odd input stays visibly odd, not complete with no duration', () => {
    const nan = serializeMspdi(
      project([task('a', { duration: 5 * 540, progress: Number.NaN, actualStart: MON })]),
    );
    expect(field(nan, 'Duration')).toBe('PT45H0M0S');
    expect(field(nan, 'PercentComplete')).toBe('0');
    const zero = inProgress({ progress: 0, remainingDuration: 0 });
    expect(field(zero, 'Duration')).toBe('PT45H0M0S');
    expect(field(zero, 'PercentComplete')).not.toBe('100');
    expect(inProgress({ duration: -540 })).not.toMatch(/PT-/);
  });

  test('a milestone or a manual task keeps its Duration', () => {
    const done = serializeMspdi(
      project([
        task('m', {
          type: 'milestone',
          duration: 0,
          progress: 100,
          actualStart: MON,
          actualFinish: new Date(2026, 0, 5, 16, 30),
        }),
      ]),
    );
    expect(field(done, 'Duration')).toBe('PT0H0M0S');
    const manual = inProgress({
      scheduleMode: 'manual',
      remainingDuration: 4 * 540,
      end: new Date(2026, 0, 9, 16, 30),
    });
    expect(field(manual, 'Duration')).toBe('PT45H0M0S');
    // MS Project's own fields for a manual task, straight after Duration:
    // without them it opens an unstarted 5-day manual task as 1 day.
    expect(field(manual, 'ManualStart')).toBe(field(manual, 'Start'));
    expect(field(manual, 'ManualFinish')).toBe(field(manual, 'Finish'));
    expect(field(manual, 'ManualDuration')).toBe('PT45H0M0S');
    expect(manual.indexOf('<Duration>')).toBeLessThan(manual.indexOf('<ManualStart>'));
    expect(manual.indexOf('<ManualDuration>')).toBeLessThan(manual.indexOf('<DurationFormat>'));
    expect(parseMspdi(manual).droppedFields).toEqual([]);
    // Its dates are kept, so the remaining work is the share that fits them.
    expect(field(manual, 'ActualDuration')).toBe('PT18H0M0S');
    expect(field(manual, 'RemainingDuration')).toBe('PT27H0M0S');
  });

  test('export → import → export is stable for a fractional % or a host forecast', () => {
    const cases: Partial<Task>[] = [
      { progress: 87.5 },
      { progress: 100 / 3, duration: 60 * 540 },
      { progress: 87.5, duration: 60 * 540 },
      { progress: 40, remainingDuration: 4 * 540 },
      { progress: 99.5 },
      // The clamp-to-1 path, elapsed (wall-clock) time, and part-units work.
      { progress: 0.4, actualStart: undefined },
      { progress: 100 / 3, duration: 2880, durationElapsed: true },
    ];
    const crew: Partial<Project> = {
      resources: [{ id: 'r', name: 'Crew' }],
      assignments: [{ id: 'x', taskId: 'a', resourceId: 'r', units: 1 / 3 }],
    };
    for (const [extra, projectExtra] of [
      ...cases.map((c) => [c, {}] as const),
      [{ progress: 87.5 }, crew] as const,
    ]) {
      let xml = inProgress(extra, projectExtra);
      const first = xml;
      const end = schedule(parseMspdi(xml).project).tasks[0]?.end.getTime();
      for (let i = 0; i < 5; i++) xml = serializeMspdi(schedule(parseMspdi(xml).project));
      for (const f of [
        'Duration',
        'ActualDuration',
        'RemainingDuration',
        'PercentComplete',
        'Finish',
      ]) {
        expect(field(xml, f), `${JSON.stringify(extra)} ${f}`).toBe(field(first, f));
      }
      expect(schedule(parseMspdi(xml).project).tasks[0]?.end.getTime()).toBe(end);
    }
  });

  test('a finished-late task: Duration is what it took', () => {
    const xml = serializeMspdi(
      project([
        task('a', {
          duration: 2 * 540,
          progress: 100,
          actualStart: MON,
          actualFinish: new Date(2026, 0, 7, 16, 30),
        }),
      ]),
    );
    expect(field(xml, 'Duration')).toBe('PT27H0M0S');
    expect(field(xml, 'ActualDuration')).toBe('PT27H0M0S');
  });
});
