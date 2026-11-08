// Malformed / partial MSPDI input robustness (2026-07-08 review, chunk 03 §P1 #11).
// The happy-path round-trip is covered in mspdi.test.ts; this file pins the
// graceful-degradation contract for inputs a genuine MS Project export (or a
// third-party MSPDI writer) can emit: no hard crashes, no Invalid Date / NaN in
// the model or serialized XML, and lossy drops reported via `droppedFields`.

import { describe, expect, test } from 'vitest';
import type { Project } from '../types.js';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';
import type { DroppedField } from './types.js';

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

describe('project-summary row (UID 0, OutlineLevel 0)', () => {
  const summaryRow =
    '<Task><UID>0</UID><ID>0</ID><Name>Project Summary</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary><Duration>PT0H0M0S</Duration></Task>';

  test('is skipped from tasks and reported', () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><Tasks>
      ${summaryRow}
      <Task><UID>1</UID><ID>1</ID><Name>Real</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel></Task>
    </Tasks></Project>`;
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks.map((t) => t.id)).toEqual(['1']);
    expect(droppedFields.some((d) => /project-summary/i.test(d.value))).toBe(true);
  });

  test('a link from the skipped row is dropped + reported, not left dangling', () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><Tasks>
      ${summaryRow}
      <Task><UID>1</UID><ID>1</ID><Name>Real</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel>
        <PredecessorLink><PredecessorUID>0</PredecessorUID><Type>1</Type></PredecessorLink></Task>
    </Tasks></Project>`;
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.links).toEqual([]);
    expect(droppedFields.some((d) => /PredecessorLink/.test(d.path))).toBe(true);
  });

  test('a UID-0 row that is NOT outline level 0 is a normal task (kept)', () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><Tasks>
      <Task><UID>0</UID><ID>0</ID><Name>Zero</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel></Task>
    </Tasks></Project>`;
    expect(parseMspdi(xml).project.tasks.map((t) => t.id)).toEqual(['0']);
  });
});

describe('MS Project sentinels + dangling refs on parse (real-file round-trip has no noise)', () => {
  // Shaped like a real MS Project export (Te Horo): a UID-0 summary row with a
  // placeholder assignment, unassigned-task placeholders (ResourceUID -65535),
  // a task CalendarUID naming no calendar in the file, a resource ditto.
  const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name>
    <Calendars><Calendar><UID>1</UID><Name>Standard</Name><IsBaseCalendar>1</IsBaseCalendar></Calendar></Calendars>
    <Tasks>
      <Task><UID>0</UID><ID>0</ID><Name>Summary</Name><OutlineLevel>0</OutlineLevel><Summary>1</Summary></Task>
      <Task><UID>1</UID><ID>1</ID><Name>A</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel><CalendarUID>0</CalendarUID></Task>
      <Task><UID>2</UID><ID>2</ID><Name>B</Name><Start>2026-01-06T08:00:00</Start><Finish>2026-01-06T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel></Task>
    </Tasks>
    <Resources><Resource><UID>5</UID><ID>1</ID><Name>Plumber</Name><CalendarUID>2</CalendarUID></Resource></Resources>
    <Assignments>
      <Assignment><UID>1</UID><TaskUID>0</TaskUID><ResourceUID>-65535</ResourceUID></Assignment>
      <Assignment><UID>2</UID><TaskUID>1</TaskUID><ResourceUID>-65535</ResourceUID></Assignment>
      <Assignment><UID>3</UID><TaskUID>2</TaskUID><ResourceUID>-65535</ResourceUID></Assignment>
      <Assignment><UID>4</UID><TaskUID>2</TaskUID><ResourceUID>5</ResourceUID></Assignment>
    </Assignments></Project>`;

  test('placeholders skipped with ONE summary entry; real assignment kept', () => {
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.assignments.map((a) => a.id)).toEqual(['4']);
    expect(droppedFields.filter((d) => /-65535/.test(d.value))).toHaveLength(1);
  });

  test('calendarIds naming no calendar in the file are cleared + reported', () => {
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks.find((t) => t.id === '1')?.calendarId).toBeUndefined();
    expect(project.resources[0]?.calendarId).toBeUndefined();
    expect(droppedFields.filter((d) => /CalendarUID/.test(d.path))).toHaveLength(2);
  });

  test('parse → serialize reports no dangling refs (round-trip is clean)', () => {
    const { project } = parseMspdi(xml);
    const droppedFields: DroppedField[] = [];
    serializeMspdi(project, { droppedFields });
    expect(droppedFields.filter((d) => /not in the project/.test(d.value))).toEqual([]);
  });
});

describe('ExtendedAttribute definition edge cases (parse)', () => {
  const doc = (
    defs: string,
    value: string,
  ) => `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name>
    <ExtendedAttributes>${defs}</ExtendedAttributes><Tasks>
    <Task><UID>1</UID><ID>1</ID><Name>A</Name><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT8H0M0S</Duration><OutlineLevel>1</OutlineLevel>
      <ExtendedAttribute><FieldID>188743731</FieldID><Value>${value}</Value></ExtendedAttribute></Task></Tasks></Project>`;

  test('an empty <Alias/> falls back to FieldName (never extra[""])', () => {
    const { project } = parseMspdi(
      doc(
        '<ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName><Alias></Alias></ExtendedAttribute>',
        'v',
      ),
    );
    expect(project.tasks[0]?.extra).toEqual({ Text1: 'v' });
  });

  test('a definition discarded as a duplicate key is reported', () => {
    const { droppedFields } = parseMspdi(
      doc(
        '<ExtendedAttribute><FieldID>188743731</FieldID><FieldName>Text1</FieldName><Alias>cmTaskId</Alias></ExtendedAttribute>' +
          '<ExtendedAttribute><FieldID>188743734</FieldID><FieldName>Text2</FieldName><Alias>cmTaskId</Alias></ExtendedAttribute>',
        'v',
      ),
    );
    expect(droppedFields.some((d) => /^Project\.ExtendedAttributes/.test(d.path))).toBe(true);
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
