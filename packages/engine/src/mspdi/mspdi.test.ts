// MSPDI round-trip + parity tests.
//
// The contract under test (v0.2 first cut):
// - parse(mspdi) → { project, droppedFields }
// - serialize(project) → mspdi
// - parse(serialize(project)).project === structurally-equivalent(project) on the supported subset
//
// Supported subset, v0.2 first commit:
// - Project root: Name, Title, Author, StartDate
// - Tasks: UID, ID, Name, Start, Finish, Duration (PT*H*M format),
//   ConstraintType + ConstraintDate, Milestone, Summary, OutlineLevel,
//   PercentComplete
// - Predecessor Links via <PredecessorLink> nested inside <Task>:
//   PredecessorUID, Type (0=FF, 1=FS, 2=SF, 3=SS), LinkLag (in tenths of a minute)
//
// NOT supported in this commit (carried in `droppedFields` if encountered):
// - Calendars, Resources, Assignments
// - Cost / Work / EarnedValue fields
// - Notes, CustomFields, Hyperlink
// - View state, OLE objects, baselines (placeholder for later commit)

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import type { Calendar, DependencyType, Link, Project, Task } from '../types.js';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, name: string, start: Date, end: Date, durationMinutes: number): Task {
  return {
    id,
    text: name,
    type: 'task',
    scheduleMode: 'auto',
    duration: durationMinutes,
    start,
    end,
    progress: 0,
  };
}

function link(id: string, source: string, target: string, type: DependencyType = 'FS'): Link {
  return { id, source, target, type, lag: 0 };
}

function projectOf(tasks: Task[], links: Link[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

const SAMPLE_MSPDI = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Test Schedule</Name>
  <Title>Test</Title>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <Tasks>
    <Task>
      <UID>1</UID>
      <ID>1</ID>
      <Name>Site preparation</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-07T17:00:00</Finish>
      <Duration>PT24H0M0S</Duration>
      <ConstraintType>0</ConstraintType>
      <Milestone>0</Milestone>
      <Summary>0</Summary>
      <OutlineLevel>1</OutlineLevel>
    </Task>
    <Task>
      <UID>2</UID>
      <ID>2</ID>
      <Name>Foundation pour</Name>
      <Start>2026-01-08T08:00:00</Start>
      <Finish>2026-01-13T17:00:00</Finish>
      <Duration>PT32H0M0S</Duration>
      <ConstraintType>0</ConstraintType>
      <Milestone>0</Milestone>
      <Summary>0</Summary>
      <OutlineLevel>1</OutlineLevel>
      <PredecessorLink>
        <PredecessorUID>1</PredecessorUID>
        <Type>1</Type>
        <LinkLag>0</LinkLag>
      </PredecessorLink>
    </Task>
  </Tasks>
</Project>`;

describe('parseMspdi — supported subset', () => {
  test('parses a 2-task FS-linked sample into our Project shape', () => {
    const { project, droppedFields } = parseMspdi(SAMPLE_MSPDI);

    expect(droppedFields).toEqual([]);
    expect(project.tasks).toHaveLength(2);

    expect(project.tasks[0].id).toBe('1');
    expect(project.tasks[0].text).toBe('Site preparation');
    expect(project.tasks[0].start).toEqual(new Date('2026-01-05T08:00:00'));
    expect(project.tasks[0].end).toEqual(new Date('2026-01-07T17:00:00'));
    expect(project.tasks[0].duration).toBe(24 * 60);

    expect(project.tasks[1].id).toBe('2');
    expect(project.tasks[1].text).toBe('Foundation pour');

    expect(project.links).toHaveLength(1);
    expect(project.links[0].source).toBe('1');
    expect(project.links[0].target).toBe('2');
    expect(project.links[0].type).toBe('FS');
    expect(project.links[0].lag).toBe(0);
  });

  test('parses constraint type/date, hierarchy parent, and percent complete', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Constraint and hierarchy sample</Name>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <Tasks>
    <Task>
      <UID>10</UID>
      <ID>1</ID>
      <Name>Foundation phase</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-09T17:00:00</Finish>
      <Duration>PT40H0M0S</Duration>
      <Summary>1</Summary>
      <OutlineLevel>1</OutlineLevel>
      <PercentComplete>25</PercentComplete>
      <ConstraintType>0</ConstraintType>
    </Task>
    <Task>
      <UID>11</UID>
      <ID>2</ID>
      <Name>Pour slab</Name>
      <Start>2026-01-07T08:00:00</Start>
      <Finish>2026-01-07T17:00:00</Finish>
      <Duration>PT8H0M0S</Duration>
      <Summary>0</Summary>
      <OutlineLevel>2</OutlineLevel>
      <PercentComplete>60</PercentComplete>
      <ConstraintType>4</ConstraintType>
      <ConstraintDate>2026-01-07T08:00:00</ConstraintDate>
    </Task>
  </Tasks>
</Project>`;

    const { project, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(project.tasks[0]).toMatchObject({
      id: '10',
      text: 'Foundation phase',
      type: 'summary',
      progress: 25,
    });
    expect(project.tasks[1]).toMatchObject({
      id: '11',
      text: 'Pour slab',
      parent: '10',
      progress: 60,
      constraint: {
        type: 'SNET',
        date: new Date('2026-01-07T08:00:00'),
      },
    });
  });

  test('maps all MSPDI constraint type codes to internal constraint types', () => {
    const cases = [
      [0, undefined],
      [1, 'ALAP'],
      [2, 'MSO'],
      [3, 'MFO'],
      [4, 'SNET'],
      [5, 'SNLT'],
      [6, 'FNET'],
      [7, 'FNLT'],
    ] as const;

    for (const [code, expected] of cases) {
      const dateXml =
        code === 0 || code === 1 ? '' : '<ConstraintDate>2026-01-07T08:00:00</ConstraintDate>';
      const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Constraint ${code}</Name>
  <Tasks>
    <Task>
      <UID>1</UID>
      <ID>1</ID>
      <Name>X</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-05T17:00:00</Finish>
      <Duration>PT8H0M0S</Duration>
      <ConstraintType>${code}</ConstraintType>
      ${dateXml}
    </Task>
  </Tasks>
</Project>`;

      const { project } = parseMspdi(xml);

      expect(project.tasks[0].constraint?.type).toBe(expected);
    }
  });

  test('captures unknown MSPDI elements in droppedFields', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Test</Name>
  <Tasks>
    <Task>
      <UID>1</UID>
      <ID>1</ID>
      <Name>X</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-05T17:00:00</Finish>
      <Duration>PT8H0M0S</Duration>
      <Notes>Some notes we don't support yet</Notes>
      <Hyperlink>https://example.com</Hyperlink>
    </Task>
  </Tasks>
</Project>`;

    const { droppedFields } = parseMspdi(xml);

    const droppedPaths = droppedFields.map((d) => d.path);
    expect(droppedPaths).toContain('Project.Tasks.Task[0].Notes');
    expect(droppedPaths).toContain('Project.Tasks.Task[0].Hyperlink');
    expect(droppedFields.every((d) => d.reason === 'unsupported-element')).toBe(true);
  });
});

describe('serializeMspdi — produces well-formed MSPDI', () => {
  test('serializes a 2-task FS-linked project to MSPDI XML', () => {
    const p = projectOf(
      [
        task('1', 'Site preparation', new Date(2026, 0, 5, 8), new Date(2026, 0, 7, 17), 24 * 60),
        task('2', 'Foundation pour', new Date(2026, 0, 8, 8), new Date(2026, 0, 13, 17), 32 * 60),
      ],
      [link('l1', '1', '2', 'FS')],
    );

    const xml = serializeMspdi(p);

    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<Project xmlns="http://schemas.microsoft.com/project">');
    expect(xml).toContain('<Name>Untitled</Name>');
    expect(xml).toContain('<UID>1</UID>');
    expect(xml).toContain('<Name>Site preparation</Name>');
    expect(xml).toContain('<UID>2</UID>');
    expect(xml).toContain('<PredecessorUID>1</PredecessorUID>');
    expect(xml).toContain('<Type>1</Type>'); // FS = 1
  });

  test('respects the meta override', () => {
    const p = projectOf([], []);

    const xml = serializeMspdi(p, {
      meta: { name: 'My Build', author: 'Rips', title: 'My Build v1' },
    });

    expect(xml).toContain('<Name>My Build</Name>');
    expect(xml).toContain('<Author>Rips</Author>');
    expect(xml).toContain('<Title>My Build v1</Title>');
  });

  test('serializes constraint type/date, outline level, and percent complete', () => {
    const p = projectOf(
      [
        {
          ...task(
            '10',
            'Foundation phase',
            new Date(2026, 0, 5, 8),
            new Date(2026, 0, 9, 17),
            40 * 60,
          ),
          type: 'summary',
          progress: 25,
        },
        {
          ...task('11', 'Pour slab', new Date(2026, 0, 7, 8), new Date(2026, 0, 7, 17), 8 * 60),
          parent: '10',
          progress: 60,
          constraint: { type: 'SNET', date: new Date(2026, 0, 7, 8) },
        },
      ],
      [],
    );

    const xml = serializeMspdi(p);

    expect(xml).toContain('<UID>10</UID>');
    expect(xml).toContain('<Summary>1</Summary>');
    expect(xml).toContain('<OutlineLevel>1</OutlineLevel>');
    expect(xml).toContain('<PercentComplete>25</PercentComplete>');
    expect(xml).toContain('<UID>11</UID>');
    expect(xml).toContain('<ConstraintType>4</ConstraintType>');
    expect(xml).toContain('<ConstraintDate>2026-01-07T08:00:00</ConstraintDate>');
    expect(xml).toContain('<OutlineLevel>2</OutlineLevel>');
    expect(xml).toContain('<PercentComplete>60</PercentComplete>');
  });
});

describe('round-trip parity — parse(serialize(project)) preserves the supported subset', () => {
  test('2 tasks + 1 FS link round-trips without drift', () => {
    const original = projectOf(
      [
        task('1', 'Site preparation', new Date(2026, 0, 5, 8), new Date(2026, 0, 7, 17), 24 * 60),
        task('2', 'Foundation pour', new Date(2026, 0, 8, 8), new Date(2026, 0, 13, 17), 32 * 60),
      ],
      [link('l1', '1', '2', 'FS')],
    );

    const xml = serializeMspdi(original);
    const { project: parsed, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(parsed.tasks).toHaveLength(2);
    expect(parsed.links).toHaveLength(1);

    for (let i = 0; i < parsed.tasks.length; i++) {
      expect(parsed.tasks[i].id).toBe(original.tasks[i].id);
      expect(parsed.tasks[i].text).toBe(original.tasks[i].text);
      expect(parsed.tasks[i].start.getTime()).toBe(original.tasks[i].start.getTime());
      expect(parsed.tasks[i].end.getTime()).toBe(original.tasks[i].end.getTime());
      expect(parsed.tasks[i].duration).toBe(original.tasks[i].duration);
    }

    expect(parsed.links[0].source).toBe(original.links[0].source);
    expect(parsed.links[0].target).toBe(original.links[0].target);
    expect(parsed.links[0].type).toBe(original.links[0].type);
    expect(parsed.links[0].lag).toBe(original.links[0].lag);
  });

  test('all 4 link types survive round-trip', () => {
    const types: DependencyType[] = ['FS', 'SS', 'FF', 'SF'];
    for (const t of types) {
      const original = projectOf(
        [
          task('1', 'A', new Date(2026, 0, 5, 8), new Date(2026, 0, 7, 17), 24 * 60),
          task('2', 'B', new Date(2026, 0, 8, 8), new Date(2026, 0, 13, 17), 32 * 60),
        ],
        [link('l1', '1', '2', t)],
      );

      const xml = serializeMspdi(original);
      const { project: parsed } = parseMspdi(xml);

      expect(parsed.links[0].type).toBe(t);
    }
  });

  test('constraint, hierarchy, and progress survive round-trip', () => {
    const original = projectOf(
      [
        {
          ...task(
            '10',
            'Foundation phase',
            new Date(2026, 0, 5, 8),
            new Date(2026, 0, 9, 17),
            40 * 60,
          ),
          type: 'summary',
          progress: 25,
        },
        {
          ...task('11', 'Pour slab', new Date(2026, 0, 7, 8), new Date(2026, 0, 7, 17), 8 * 60),
          parent: '10',
          progress: 60,
          constraint: { type: 'SNET', date: new Date(2026, 0, 7, 8) },
        },
      ],
      [],
    );

    const xml = serializeMspdi(original);
    const { project: parsed, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(parsed.tasks[0].progress).toBe(25);
    expect(parsed.tasks[1].parent).toBe('10');
    expect(parsed.tasks[1].progress).toBe(60);
    expect(parsed.tasks[1].constraint).toEqual({
      type: 'SNET',
      date: new Date('2026-01-07T08:00:00'),
    });
  });
});

describe('calendars round-trip', () => {
  test('serializes the standard M-F 8-5 calendar with proper WeekDay structure', () => {
    const p = projectOf([], []);

    const xml = serializeMspdi(p);

    expect(xml).toContain('<Calendars>');
    expect(xml).toContain('<Name>Standard</Name>');
    expect(xml).toContain('<IsBaseCalendar>1</IsBaseCalendar>');
    // Monday (DayType=2) is working with one interval
    expect(xml).toContain('<DayType>2</DayType>');
    expect(xml).toContain('<DayWorking>1</DayWorking>');
    expect(xml).toContain('<FromTime>08:00:00</FromTime>');
    expect(xml).toContain('<ToTime>17:00:00</ToTime>');
    // Sunday (DayType=1) is non-working
    expect(xml).toContain('<DayType>1</DayType>');
  });

  test('round-trips a calendar with split shift (lunch break)', () => {
    const splitShiftCalendar: Calendar = {
      id: 'concreting',
      name: 'Concreting',
      workWeek: [
        [],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [],
      ],
      exceptions: [],
    };
    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'concreting',
      tasks: [],
      links: [],
      resources: [],
      calendars: [splitShiftCalendar],
      baselines: [],
      assignments: [],
    };

    const xml = serializeMspdi(original);
    const { project: parsed } = parseMspdi(xml);

    expect(parsed.calendars).toHaveLength(1);
    const cal = parsed.calendars[0];
    expect(cal.name).toBe('Concreting');
    // Monday should have two intervals
    expect(cal.workWeek[1]).toHaveLength(2);
    expect(cal.workWeek[1][0]).toEqual({ startMinutes: 7 * 60, endMinutes: 12 * 60 });
    expect(cal.workWeek[1][1]).toEqual({ startMinutes: 13 * 60, endMinutes: 15 * 60 });
    // Sunday and Saturday non-working
    expect(cal.workWeek[0]).toEqual([]);
    expect(cal.workWeek[6]).toEqual([]);
  });

  test('parses the realistic-shape MS-Project-style fixture without noisy droppedFields', () => {
    // Fixture mimics a real MS Project export (~50 fields per Task, full
    // Project-level metadata, Calendar with weekday + exception WeekDays).
    // Structurally authentic; content clean-room (not derived from any
    // copyrighted MS Project file). See __fixtures__/residential-build-realistic.xml.
    const xml = readFileSync(
      join(__dirname, '__fixtures__', 'residential-build-realistic.xml'),
      'utf8',
    );

    const { project, droppedFields } = parseMspdi(xml);

    // Tasks + links structure
    expect(project.tasks).toHaveLength(5);
    expect(project.tasks[0].text).toBe('Site preparation');
    expect(project.tasks[4].text).toBe('Practical completion');
    expect(project.tasks[4].type).toBe('milestone'); // <Milestone>1</Milestone>
    expect(project.links).toHaveLength(4); // a linear chain through 5 tasks
    expect(project.links.every((l) => l.type === 'FS')).toBe(true);

    // Calendar
    expect(project.calendars).toHaveLength(1);
    expect(project.calendars[0].name).toBe('NZ Standard');
    // Monday has split shift (08-12 + 13-17)
    expect(project.calendars[0].workWeek[1]).toHaveLength(2);
    // Has the Waitangi Day exception (2026-02-06)
    expect(project.calendars[0].exceptions).toHaveLength(1);

    // droppedFields should be empty or near-empty — every common
    // MS-Project-emitted field is now in our known-fields allowlist.
    if (droppedFields.length > 0) {
      // Diagnostic — if this fails, the dropped fields list shows what's new.
      // eslint-disable-next-line no-console
      console.warn('Unexpected dropped fields:', droppedFields);
    }
    expect(droppedFields).toHaveLength(0);
  });

  test('round-trips Assignments (taskId, resourceId, units)', () => {
    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'std',
      tasks: [
        {
          id: 't1',
          text: 'Foundation pour',
          type: 'task',
          scheduleMode: 'auto',
          duration: 540,
          start: new Date(2026, 0, 5, 8),
          end: new Date(2026, 0, 5, 17),
          progress: 0,
        },
      ],
      links: [],
      resources: [
        { id: 'r1', name: 'Concreting crew' },
        { id: 'r2', name: 'Foreman' },
      ],
      calendars: [standardCalendar],
      baselines: [],
      assignments: [
        { id: 'a1', taskId: 't1', resourceId: 'r1', units: 1 },
        { id: 'a2', taskId: 't1', resourceId: 'r2', units: 0.5 },
      ],
    };

    const xml = serializeMspdi(original);

    expect(xml).toContain('<Assignments>');
    expect(xml).toContain('<TaskUID>t1</TaskUID>');
    expect(xml).toContain('<ResourceUID>r1</ResourceUID>');
    expect(xml).toContain('<ResourceUID>r2</ResourceUID>');
    expect(xml).toContain('<Units>0.5</Units>');

    const { project: parsed, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(parsed.assignments).toHaveLength(2);
    expect(parsed.assignments[0].id).toBe('a1');
    expect(parsed.assignments[0].taskId).toBe('t1');
    expect(parsed.assignments[0].resourceId).toBe('r1');
    expect(parsed.assignments[0].units).toBeUndefined(); // 1.0 is the default; omitted
    expect(parsed.assignments[1].units).toBe(0.5);
  });

  test('round-trips Resources with name + calendarId', () => {
    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'std',
      tasks: [],
      links: [],
      resources: [
        { id: 'r1', name: 'John Smith' },
        { id: 'r2', name: 'Concreting Crew', calendarId: 'concreting' },
      ],
      calendars: [
        standardCalendar,
        {
          id: 'concreting',
          name: 'Concreting',
          workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
          exceptions: [],
        },
      ],
      baselines: [],
      assignments: [],
    };

    const xml = serializeMspdi(original);

    expect(xml).toContain('<Resources>');
    expect(xml).toContain('<Name>John Smith</Name>');
    expect(xml).toContain('<Name>Concreting Crew</Name>');
    expect(xml).toContain('<CalendarUID>concreting</CalendarUID>');

    const { project: parsed, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(parsed.resources).toHaveLength(2);
    expect(parsed.resources[0].id).toBe('r1');
    expect(parsed.resources[0].name).toBe('John Smith');
    expect(parsed.resources[0].calendarId).toBeUndefined();
    expect(parsed.resources[1].id).toBe('r2');
    expect(parsed.resources[1].name).toBe('Concreting Crew');
    expect(parsed.resources[1].calendarId).toBe('concreting');
  });

  test('round-trips a calendar with a non-working-day exception (holiday)', () => {
    const xmas: Date = new Date(2026, 11, 25); // 25 Dec 2026
    const calendarWithHoliday: Calendar = {
      id: 'std',
      name: 'NZ Standard',
      workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
      exceptions: [{ date: xmas, isWorking: false, name: 'Christmas Day' }],
    };
    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'std',
      tasks: [],
      links: [],
      resources: [],
      calendars: [calendarWithHoliday],
      baselines: [],
      assignments: [],
    };

    const xml = serializeMspdi(original);
    const { project: parsed } = parseMspdi(xml);

    expect(parsed.calendars).toHaveLength(1);
    expect(parsed.calendars[0].exceptions).toHaveLength(1);
    const ex = parsed.calendars[0].exceptions[0];
    expect(ex.isWorking).toBe(false);
    expect(ex.date.getTime()).toBe(xmas.getTime());
  });
});

describe('parseMspdiCalendar — F-4: multi-day exceptions + modern <Exceptions>', () => {
  const calProject = (
    calendarInner: string,
  ) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Cal F-4</Name>
  <Calendars>
    <Calendar>
      <UID>1</UID>
      <Name>Site</Name>
      <IsBaseCalendar>1</IsBaseCalendar>
${calendarInner}
    </Calendar>
  </Calendars>
</Project>`;
  const dstr = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  test('legacy DayType=0 FromDate..ToDate expands to every day in the range (Christmas shutdown)', () => {
    const xml = calProject(`      <WeekDays>
        <WeekDay>
          <DayType>0</DayType>
          <DayWorking>0</DayWorking>
          <TimePeriod>
            <FromDate>2026-12-24T00:00:00</FromDate>
            <ToDate>2027-01-05T00:00:00</ToDate>
          </TimePeriod>
        </WeekDay>
      </WeekDays>`);
    const cal = parseMspdi(xml).project.calendars[0]!;
    const holidays = cal.exceptions.filter((e) => !e.isWorking).map((e) => dstr(e.date));
    expect(holidays).toContain('2026-12-24');
    expect(holidays).toContain('2026-12-31');
    expect(holidays).toContain('2027-01-05');
    expect(holidays).toHaveLength(13); // 24 Dec .. 5 Jan inclusive
  });

  test('modern <Exceptions><Exception> holidays parse (was dropped → zero holidays)', () => {
    const xml = calProject(`      <Exceptions>
        <Exception>
          <DayWorking>0</DayWorking>
          <Name>Christmas shutdown</Name>
          <TimePeriod>
            <FromDate>2026-12-24T00:00:00</FromDate>
            <ToDate>2026-12-28T00:00:00</ToDate>
          </TimePeriod>
        </Exception>
      </Exceptions>`);
    const { project, droppedFields } = parseMspdi(xml);
    const cal = project.calendars[0]!;
    const holidays = cal.exceptions.filter((e) => !e.isWorking);
    expect(holidays.map((e) => dstr(e.date))).toEqual([
      '2026-12-24',
      '2026-12-25',
      '2026-12-26',
      '2026-12-27',
      '2026-12-28',
    ]);
    expect(holidays[0]?.name).toBe('Christmas shutdown');
    expect(droppedFields.some((d) => /Exceptions/.test(d.path))).toBe(false); // no longer dropped
  });

  test('F-4b: a recurring <Exception> (Occurrences>1) is NOT literal-expanded across its whole span', () => {
    // MS Project writes a recurring exception with a TimePeriod spanning
    // first→last occurrence + an <Occurrences> count. Literal-expanding that
    // range would mark ~400 consecutive days non-working (a yearly holiday over
    // 5 years). Recurrence isn't supported yet — skip + report, don't darken.
    const xml = calProject(`      <Exceptions>
        <Exception>
          <DayWorking>0</DayWorking>
          <Name>Christmas Day (recurring)</Name>
          <Occurrences>5</Occurrences>
          <Type>7</Type>
          <TimePeriod>
            <FromDate>2026-12-25T00:00:00</FromDate>
            <ToDate>2030-12-25T00:00:00</ToDate>
          </TimePeriod>
        </Exception>
      </Exceptions>`);
    const { project, droppedFields } = parseMspdi(xml);
    const cal = project.calendars[0]!;
    expect(cal.exceptions.length).toBeLessThan(10); // NOT ~400 days of the span
    expect(droppedFields.some((d) => /Exception/.test(d.path))).toBe(true); // reported
  });

  test('F-4c: a ONE-OFF <Exception> carrying default pattern fields (Occurrences=1, Type/Period=1) still expands', () => {
    // Codex review 2026-07-12: MS Project writes default recurrence-shape fields
    // (Type=1, Period=1) on a NON-recurring exception too. A guard keying on the
    // mere presence of Period/DaysOfWeek/… wrongly skips a legitimate one-off
    // shutdown — dropping a real holiday. Only Occurrences>1 signals recurrence.
    const xml = calProject(`      <Exceptions>
        <Exception>
          <DayWorking>0</DayWorking>
          <Name>Christmas shutdown</Name>
          <Occurrences>1</Occurrences>
          <Type>1</Type>
          <Period>1</Period>
          <TimePeriod>
            <FromDate>2026-12-24T00:00:00</FromDate>
            <ToDate>2027-01-05T00:00:00</ToDate>
          </TimePeriod>
        </Exception>
      </Exceptions>`);
    const { project } = parseMspdi(xml);
    const cal = project.calendars[0]!;
    const holidays = cal.exceptions.filter((e) => !e.isWorking);
    expect(holidays.length).toBe(13); // 24 Dec .. 5 Jan inclusive — NOT skipped
  });
});

describe('baselines round-trip', () => {
  test('round-trips one baseline with per-task snapshots', () => {
    const capturedAt = new Date(2026, 0, 1, 9, 0);
    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'std',
      tasks: [
        {
          id: 't1',
          text: 'Foundation pour',
          type: 'task',
          scheduleMode: 'auto',
          duration: 540,
          start: new Date(2026, 0, 5, 8),
          end: new Date(2026, 0, 5, 17),
          progress: 0,
        },
        {
          id: 't2',
          text: 'Framing',
          type: 'task',
          scheduleMode: 'auto',
          duration: 1080,
          start: new Date(2026, 0, 6, 8),
          end: new Date(2026, 0, 7, 17),
          progress: 0,
        },
      ],
      links: [],
      resources: [],
      calendars: [standardCalendar],
      baselines: [
        {
          index: 0,
          name: 'Original contract programme',
          capturedAt,
          tasks: new Map([
            [
              't1',
              {
                start: new Date(2026, 0, 5, 8),
                end: new Date(2026, 0, 5, 17),
                duration: 540,
              },
            ],
            [
              't2',
              {
                start: new Date(2026, 0, 6, 8),
                end: new Date(2026, 0, 7, 17),
                duration: 1080,
              },
            ],
          ]),
        },
      ],
      assignments: [],
    };

    const xml = serializeMspdi(original);

    // Per-task <Baseline> elements should appear inside each <Task>
    expect(xml).toContain('<Baseline>');
    expect(xml).toContain('<Number>0</Number>');

    const { project: parsed, droppedFields } = parseMspdi(xml);

    expect(droppedFields).toEqual([]);
    expect(parsed.baselines).toHaveLength(1);
    expect(parsed.baselines[0].index).toBe(0);
    expect(parsed.baselines[0].tasks.size).toBe(2);

    const snap1 = parsed.baselines[0].tasks.get('t1');
    expect(snap1).toBeDefined();
    expect(snap1?.start.getTime()).toBe(new Date(2026, 0, 5, 8).getTime());
    expect(snap1?.end.getTime()).toBe(new Date(2026, 0, 5, 17).getTime());
    expect(snap1?.duration).toBe(540);
  });

  test('round-trips multiple baselines (indices 0, 1, 2)', () => {
    const cap = new Date(2026, 0, 1, 9, 0);
    const snapAt = (start: Date, end: Date, duration: number) => ({ start, end, duration });

    const original: Project = {
      start: new Date(2026, 0, 5, 8, 0),
      defaultCalendarId: 'std',
      tasks: [
        {
          id: 't1',
          text: 'A',
          type: 'task',
          scheduleMode: 'auto',
          duration: 540,
          start: new Date(2026, 0, 5, 8),
          end: new Date(2026, 0, 5, 17),
          progress: 0,
        },
      ],
      links: [],
      resources: [],
      calendars: [standardCalendar],
      baselines: [
        {
          index: 0,
          capturedAt: cap,
          tasks: new Map([['t1', snapAt(new Date(2026, 0, 5, 8), new Date(2026, 0, 5, 17), 540)]]),
        },
        {
          index: 1,
          capturedAt: cap,
          tasks: new Map([['t1', snapAt(new Date(2026, 0, 6, 8), new Date(2026, 0, 6, 17), 540)]]),
        },
        {
          index: 2,
          capturedAt: cap,
          tasks: new Map([['t1', snapAt(new Date(2026, 0, 7, 8), new Date(2026, 0, 7, 17), 540)]]),
        },
      ],
      assignments: [],
    };

    const xml = serializeMspdi(original);
    const { project: parsed } = parseMspdi(xml);

    expect(parsed.baselines).toHaveLength(3);
    expect(parsed.baselines.map((b) => b.index).sort()).toEqual([0, 1, 2]);

    const baseline1 = parsed.baselines.find((b) => b.index === 1);
    expect(baseline1?.tasks.get('t1')?.start.getTime()).toBe(new Date(2026, 0, 6, 8).getTime());
  });
});

// ---------------------------------------------------------------------------
// ADR-007: split tasks + unscheduled tasks — MSPDI round-trip (Task 2.7)
// ---------------------------------------------------------------------------

describe('serializeMspdi / parseMspdi — ADR-007 split + unscheduled tasks', () => {
  test('unscheduled task: serialize emits IsNull=1, parse recovers unscheduled:true', () => {
    const original = projectOf(
      [
        task('1', 'Normal task', new Date(2026, 0, 5, 8), new Date(2026, 0, 5, 17), 540),
        {
          ...task(
            '2',
            'Unscheduled PC item',
            new Date(2026, 0, 5, 8),
            new Date(2026, 0, 5, 17),
            540,
          ),
          unscheduled: true as const,
        },
      ],
      [],
    );

    const xml = serializeMspdi(original);

    // Emitted MSPDI should contain IsNull=1 for the unscheduled task.
    expect(xml).toContain('<IsNull>1</IsNull>');

    // Parse should recover unscheduled:true on the task.
    const { project: parsed, droppedFields } = parseMspdi(xml);
    expect(droppedFields).toEqual([]);

    const normalTask = parsed.tasks.find((t) => t.id === '1');
    expect(normalTask?.unscheduled).toBeFalsy();

    const unscheduledTask = parsed.tasks.find((t) => t.id === '2');
    expect(unscheduledTask?.unscheduled).toBe(true);
  });

  test('unscheduled flag is preserved on full serialize→parse round-trip', () => {
    const original = projectOf(
      [
        {
          ...task(
            '1',
            'PC provisional item',
            new Date(2026, 0, 5, 8),
            new Date(2026, 0, 5, 17),
            540,
          ),
          unscheduled: true as const,
        },
      ],
      [],
    );

    const xml = serializeMspdi(original);
    const { project: parsed } = parseMspdi(xml);

    expect(parsed.tasks[0].unscheduled).toBe(true);
  });

  test('split task segments are dropped to droppedFields on serialize (no clean MSPDI encoding)', () => {
    const splitTaskData: Task = {
      ...task('1', 'Weather-split pour', new Date(2026, 0, 5, 8), new Date(2026, 0, 8, 17), 1080),
      scheduleMode: 'manual',
      segments: [
        { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) },
        { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) },
      ],
    };
    const original = projectOf([splitTaskData], []);

    const droppedFields: import('../mspdi/types.js').DroppedField[] = [];
    serializeMspdi(original, { droppedFields });

    // Should report one droppedField for the segments (lossy-on-roundtrip).
    const segmentDrop = droppedFields.find(
      (f) => f.path.includes('segments') && f.reason === 'lossy-on-roundtrip',
    );
    expect(segmentDrop).toBeDefined();
  });

  test('split task outer start/end are preserved on round-trip (segments lost but bounds kept)', () => {
    const splitTaskData: Task = {
      ...task('1', 'Weather-split pour', new Date(2026, 0, 5, 8), new Date(2026, 0, 8, 17), 1080),
      scheduleMode: 'manual',
      segments: [
        { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) },
        { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) },
      ],
    };
    const original = projectOf([splitTaskData], []);

    const xml = serializeMspdi(original);
    const { project: parsed } = parseMspdi(xml);

    // Outer bounds preserve; segments are lost (no MSPDI encoding).
    expect(parsed.tasks[0].start).toEqual(new Date(2026, 0, 5, 8));
    expect(parsed.tasks[0].end).toEqual(new Date(2026, 0, 8, 17));
    expect(parsed.tasks[0].segments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// F7 — IsNull task with absent Start/Finish must never yield Invalid Date
// ---------------------------------------------------------------------------

describe('parseMspdi — F7: IsNull task with absent Start/Finish', () => {
  const ISNULL_MSPDI = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Null Task Test</Name>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <Tasks>
    <Task>
      <UID>1</UID>
      <ID>1</ID>
      <Name>Provisional Sum</Name>
      <IsNull>1</IsNull>
      <Duration>PT0H0M0S</Duration>
      <OutlineLevel>1</OutlineLevel>
      <Milestone>0</Milestone>
      <Summary>0</Summary>
    </Task>
  </Tasks>
</Project>`;

  test('F7: IsNull task with no Start/Finish parses to valid Date on start and end (not NaN)', () => {
    const { project } = parseMspdi(ISNULL_MSPDI);
    expect(project.tasks).toHaveLength(1);
    const t = project.tasks[0]!;
    expect(t.unscheduled).toBe(true);
    expect(Number.isNaN(t.start.getTime())).toBe(false);
    expect(Number.isNaN(t.end.getTime())).toBe(false);
  });

  test('F7: IsNull task round-trips without NaN in serialized XML', () => {
    const { project } = parseMspdi(ISNULL_MSPDI);
    const xml = serializeMspdi(project);
    // The serialized Start/Finish must not contain NaN
    expect(xml).not.toContain('NaN');
    // Must contain valid date string (year 2026)
    expect(xml).toContain('2026');
  });
});

// ---------------------------------------------------------------------------
// F-3 — manual scheduleMode + per-task calendarId must survive round-trip
// ---------------------------------------------------------------------------

describe('parseMspdi/serializeMspdi — F-3: manual scheduleMode + calendarId round-trip', () => {
  test('manual scheduleMode survives round-trip (was silently flipped to auto)', () => {
    const manual: Task = {
      ...task('1', 'Manual pour', new Date(2026, 0, 5, 8), new Date(2026, 0, 5, 17), 540),
      scheduleMode: 'manual',
    };
    const xml = serializeMspdi(projectOf([manual], []));
    expect(xml).toContain('<Manual>1</Manual>');
    const { project } = parseMspdi(xml);
    expect(project.tasks[0]!.scheduleMode).toBe('manual');
  });

  test('auto tasks emit no <Manual> and parse back as auto', () => {
    const auto = task('1', 'Auto', new Date(2026, 0, 5, 8), new Date(2026, 0, 5, 17), 540);
    const xml = serializeMspdi(projectOf([auto], []));
    expect(xml).not.toContain('<Manual>');
    expect(parseMspdi(xml).project.tasks[0]!.scheduleMode).toBe('auto');
  });

  test('task.calendarId survives round-trip via per-task <CalendarUID>', () => {
    const withCal: Task = {
      ...task('1', 'On concreting cal', new Date(2026, 0, 5, 8), new Date(2026, 0, 5, 17), 540),
      calendarId: 'concreting',
    };
    const xml = serializeMspdi(projectOf([withCal], []));
    expect(xml).toContain('<CalendarUID>concreting</CalendarUID>');
    expect(parseMspdi(xml).project.tasks[0]!.calendarId).toBe('concreting');
  });
});

describe('deadline — MSPDI <Deadline> round-trip', () => {
  test('a task deadline survives serialize → parse', () => {
    const deadline = new Date(2026, 0, 9, 17, 0);
    const t = {
      ...task('1', 'Framing', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 7, 17, 0), 1440),
      deadline,
    };
    const xml = serializeMspdi(projectOf([t], []));
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks[0]!.deadline).toEqual(deadline);
    expect(droppedFields.some((d) => d.path.includes('Deadline'))).toBe(false);
  });

  test('a task without a deadline emits no <Deadline> and parses with deadline undefined', () => {
    const t = task('1', 'Framing', new Date(2026, 0, 5, 8, 0), new Date(2026, 0, 7, 17, 0), 1440);
    const xml = serializeMspdi(projectOf([t], []));
    expect(xml.includes('<Deadline>')).toBe(false);
    const { project } = parseMspdi(xml);
    expect(project.tasks[0]!.deadline).toBeUndefined();
  });
});
