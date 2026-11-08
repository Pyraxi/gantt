// MSPDI outline codes ↔ activity codes (parity row 8).
// Spec: docs/superpowers/specs/2026-10-16-mspdi-outline-codes-design.md
import { describe, expect, test } from 'vitest';
import type { Calendar, Project, Task } from '../types.js';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';
import type { DroppedField } from './types.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const tk = (id: string, extra: Partial<Task> = {}): Task => ({
  id,
  text: `Task ${id}`,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
  ...extra,
});
const project: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: [tk('1', { codes: { Trade: 'ELEC', Area: 'L1' } }), tk('2', { codes: { Trade: 'PLMB' } })],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
  codeTypes: [
    {
      id: 'Trade',
      name: 'Trade',
      values: [
        { value: 'ELEC', description: 'Electrical' },
        { value: 'PLMB', description: 'Plumbing' },
      ],
    },
    { id: 'Area', name: 'Area', values: [{ value: 'L1' }, { value: 'L2' }] },
  ],
};

/** A Project 2007-style file: the Microsoft "OutlineCode Element" example, completed. */
const msExample = (taskOc: string, extraValues = '') => `<?xml version="1.0" encoding="UTF-8"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>oc</Name>
  <StartDate>2026-01-05T08:00:00</StartDate>
  <OutlineCodes>
    <OutlineCode>
      <Guid>26F0CA77-38CC-40C7-933D-15F839F7DB82</Guid>
      <Enterprise>0</Enterprise>
      <LeafOnly>0</LeafOnly>
      <Masks><Mask><Level>1</Level><Type>3</Type><Length>0</Length><Separator>.</Separator></Mask></Masks>
      <Values>
        <Value><ValueID>16</ValueID><FieldGUID>985194AB-77BA-4545-BCE8-99761B5538D9</FieldGUID><ParentValueID>0</ParentValueID><Type>21</Type><Value>Simple 1</Value></Value>
        <Value><ValueID>17</ValueID><FieldGUID>6B0CC455-EE19-416A-8FD9-6209590B3ED7</FieldGUID><ParentValueID>0</ParentValueID><Type>21</Type><Value>Simple 2</Value><Description>The second</Description></Value>
        ${extraValues}
      </Values>
    </OutlineCode>
  </OutlineCodes>
  <ExtendedAttributes>
    <ExtendedAttribute>
      <FieldID>188744106</FieldID>
      <FieldName>Outline Code6</FieldName>
      <Alias>Task Simple OC</Alias>
      <Ltuid>26F0CA77-38CC-40C7-933D-15F839F7DB82</Ltuid>
    </ExtendedAttribute>
  </ExtendedAttributes>
  <Tasks>
    <Task>
      <UID>1</UID><ID>1</ID><Name>A</Name><OutlineLevel>1</OutlineLevel>
      <Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT9H0M0S</Duration>
      ${taskOc}
    </Task>
  </Tasks>
</Project>`;

describe('parseMspdi: outline codes → codeTypes / codes', () => {
  test('the Microsoft example: definition paired by Ltuid, task value by ValueGUID', () => {
    const { project: p, droppedFields } = parseMspdi(
      msExample(
        '<OutlineCode><FieldID>188744106</FieldID><ValueID>17</ValueID><ValueGUID>6B0CC455-EE19-416A-8FD9-6209590B3ED7</ValueGUID></OutlineCode>',
      ),
    );
    expect(p.codeTypes).toEqual([
      {
        id: 'Task Simple OC',
        name: 'Task Simple OC',
        values: [{ value: 'Simple 1' }, { value: 'Simple 2', description: 'The second' }],
      },
    ]);
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 2' });
    // The outline code's paired ExtendedAttribute is not a Text field: no extra key.
    expect(p.tasks[0]?.extra).toBeUndefined();
    expect(droppedFields.filter((d) => /OutlineCode/.test(d.path))).toEqual([]);
  });

  test('ValueGUID wins over a disagreeing ValueID (Project 2007+ ignores ValueID)', () => {
    const { project: p } = parseMspdi(
      msExample(
        '<OutlineCode><FieldID>188744106</FieldID><ValueID>16</ValueID><ValueGUID>6B0CC455-EE19-416A-8FD9-6209590B3ED7</ValueGUID></OutlineCode>',
      ),
    );
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 2' });
  });

  test('MPXJ style: no GUIDs, the task value by ValueID', () => {
    const { project: p } = parseMspdi(
      msExample('<OutlineCode><FieldID>188744106</FieldID><ValueID>16</ValueID></OutlineCode>'),
    );
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 1' });
  });

  test('a value given as a task ExtendedAttribute (text or ValueGUID) lands in codes', () => {
    const byText = parseMspdi(
      msExample(
        '<ExtendedAttribute><FieldID>188744106</FieldID><Value>Simple 1</Value></ExtendedAttribute>',
      ),
    ).project;
    expect(byText.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 1' });
    expect(byText.tasks[0]?.extra).toBeUndefined();
    const byGuid = parseMspdi(
      msExample(
        '<ExtendedAttribute><FieldID>188744106</FieldID><ValueGUID>6B0CC455-EE19-416A-8FD9-6209590B3ED7</ValueGUID></ExtendedAttribute>',
      ),
    );
    expect(byGuid.project.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 2' });
    expect(byGuid.droppedFields.filter((d) => /ExtendedAttribute/.test(d.path))).toEqual([]);
  });

  test('hierarchical values flatten to their full path (as MS Project shows them)', () => {
    const { project: p } = parseMspdi(
      msExample(
        '<OutlineCode><FieldID>188744106</FieldID><ValueID>18</ValueID></OutlineCode>',
        '<Value><ValueID>18</ValueID><ParentValueID>17</ParentValueID><Type>21</Type><Value>Sub</Value></Value>',
      ),
    );
    expect(p.codeTypes?.[0]?.values.map((v) => v.value)).toEqual([
      'Simple 1',
      'Simple 2',
      'Simple 2.Sub',
    ]);
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 2.Sub' });
  });

  test('an unresolvable value is reported, never guessed', () => {
    const { project: p, droppedFields } = parseMspdi(
      msExample('<OutlineCode><FieldID>188744106</FieldID><ValueID>99</ValueID></OutlineCode>'),
    );
    expect(p.tasks[0]?.codes).toBeUndefined();
    expect(droppedFields.some((d) => /OutlineCode/.test(d.path) && /99/.test(d.value))).toBe(true);
  });
});

describe('serializeMspdi({ outlineCodes })', () => {
  const opts = {
    outlineCodes: [
      { codeTypeId: 'Trade', field: 1 as const },
      { codeTypeId: 'Area', field: 7 as const },
    ],
  };

  test('round-trips codeTypes and task codes', () => {
    const { project: back, droppedFields } = parseMspdi(serializeMspdi(project, opts));
    expect(back.codeTypes).toEqual(project.codeTypes);
    expect(back.tasks.map((t) => t.codes)).toEqual([
      { Trade: 'ELEC', Area: 'L1' },
      { Trade: 'PLMB' },
    ]);
    expect(droppedFields.filter((d) => /OutlineCode/.test(d.path))).toEqual([]);
  });

  test('writes both forms: Guid = Ltuid, task ValueID + ValueGUID = the value FieldGUID', () => {
    const xml = serializeMspdi(project, opts);
    const guid = xml.match(/<OutlineCode>\s*<Guid>([^<]+)<\/Guid>\s*<FieldID>188744096</)?.[1];
    expect(guid).toMatch(/^[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}$/);
    expect(xml).toContain(`<Ltuid>${guid}</Ltuid>`);
    const elec = xml.match(
      /<ValueID>(\d+)<\/ValueID>\s*<FieldGUID>([^<]+)<\/FieldGUID>\s*<Type>21<\/Type>\s*<ParentValueID>0<\/ParentValueID>\s*<Value>ELEC</,
    );
    expect(elec).not.toBeNull();
    expect(xml).toMatch(
      new RegExp(
        `<OutlineCode>\\s*<FieldID>188744096</FieldID>\\s*<ValueID>${elec?.[1]}</ValueID>\\s*<ValueGUID>${elec?.[2]}</ValueGUID>`,
      ),
    );
    // Outline Code7 (MPXJ FieldTypeHelper) — not the contiguous-guess trap.
    expect(xml).toContain('<FieldID>188744108</FieldID>');
  });

  test('schema order: OutlineCodes before ExtendedAttributes; task OutlineCode last', () => {
    const xml = serializeMspdi(project, {
      ...opts,
      extendedAttributes: [{ field: 'Text1', extraKey: 'cmId' }],
    });
    expect(xml.indexOf('<OutlineCodes>')).toBeLessThan(xml.indexOf('<ExtendedAttributes>'));
    const task = xml.slice(xml.indexOf('<Tasks>'));
    const first = task.slice(0, task.indexOf('</Task>'));
    expect(first.lastIndexOf('<OutlineCode>')).toBeGreaterThan(first.lastIndexOf('<Duration>'));
    expect(first.trim().endsWith('</OutlineCode>')).toBe(true);
  });

  test('deterministic: the same project writes the same GUIDs', () => {
    expect(serializeMspdi(project, opts)).toBe(serializeMspdi(project, opts));
  });

  test('a task value missing from the table is added to it (MS Project needs a table entry)', () => {
    const p = { ...project, tasks: [tk('1', { codes: { Area: 'Roof' } })] };
    const back = parseMspdi(serializeMspdi(p, opts)).project;
    expect(back.tasks[0]?.codes).toEqual({ Area: 'Roof' });
    expect(back.codeTypes?.find((c) => c.id === 'Area')?.values.map((v) => v.value)).toEqual([
      'L1',
      'L2',
      'Roof',
    ]);
  });

  test('unmapped code types and colours are reported; no mapping writes no OutlineCodes', () => {
    const dropped: DroppedField[] = [];
    const coloured = {
      ...project,
      codeTypes: [
        { ...project.codeTypes?.[0], values: [{ value: 'ELEC', color: '#f00' }] },
        project.codeTypes?.[1],
      ] as Project['codeTypes'],
    };
    serializeMspdi(coloured, {
      outlineCodes: [{ codeTypeId: 'Trade', field: 1 }],
      droppedFields: dropped,
    });
    expect(dropped.some((d) => /Area/.test(d.path + d.value))).toBe(true);
    expect(dropped.some((d) => /colou?r/i.test(d.value))).toBe(true);
    const orphan: DroppedField[] = [];
    serializeMspdi(
      { ...project, tasks: [tk('1', { codes: { Zone: 'N' } })] },
      { droppedFields: orphan },
    );
    expect(orphan.some((d) => d.path.endsWith('codes.Zone'))).toBe(true);
    const plain = serializeMspdi(project);
    expect(plain).not.toContain('<OutlineCode');
  });

  test('config errors throw: unknown field, duplicate field, unknown code type', () => {
    expect(() =>
      serializeMspdi(project, { outlineCodes: [{ codeTypeId: 'Trade', field: 11 as 1 }] }),
    ).toThrow();
    expect(() =>
      serializeMspdi(project, {
        outlineCodes: [
          { codeTypeId: 'Trade', field: 1 },
          { codeTypeId: 'Area', field: 1 },
        ],
      }),
    ).toThrow();
    expect(() =>
      serializeMspdi(project, { outlineCodes: [{ codeTypeId: 'Nope', field: 2 }] }),
    ).toThrow();
  });

  test('names must be unique custom-field aliases (MS Project needs them unique)', () => {
    const dup = {
      ...project,
      codeTypes: [
        { id: 'a', name: 'Trade', values: [] },
        { id: 'b', name: 'Trade', values: [] },
      ],
    };
    expect(() =>
      serializeMspdi(dup, {
        outlineCodes: [
          { codeTypeId: 'a', field: 1 },
          { codeTypeId: 'b', field: 2 },
        ],
      }),
    ).toThrow(/alias/);
    expect(() =>
      serializeMspdi(project, {
        outlineCodes: [{ codeTypeId: 'Trade', field: 1 }],
        extendedAttributes: [{ field: 'Text1', extraKey: 'Trade' }],
      }),
    ).toThrow(/alias/);
    // Case-insensitive, as MS Project.
    expect(() =>
      serializeMspdi(
        {
          ...project,
          codeTypes: [
            { id: 'a', name: 'Trade', values: [] },
            { id: 'b', name: 'trade', values: [] },
          ],
        },
        {
          outlineCodes: [
            { codeTypeId: 'a', field: 1 },
            { codeTypeId: 'b', field: 2 },
          ],
        },
      ),
    ).toThrow(/alias/);
    // A non-string value is written as its text, never a crash.
    const odd = {
      ...project,
      tasks: [
        tk('1', { codes: { Trade: 7 as unknown as string, Area: null as unknown as string } }),
      ],
    };
    expect(parseMspdi(serializeMspdi(odd, opts)).project.tasks[0]?.codes).toEqual({ Trade: '7' });
    // '1' and 1 are the same field.
    expect(() =>
      serializeMspdi(project, {
        outlineCodes: [
          { codeTypeId: 'Trade', field: 1 },
          { codeTypeId: 'Area', field: '1' as unknown as 1 },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test('an id that differs from the name comes back keyed by name (MS Project keeps the alias)', () => {
    const p = {
      ...project,
      tasks: [tk('1', { codes: { 'ct-1': 'ELEC' } })],
      codeTypes: [{ id: 'ct-1', name: 'Trade', values: [{ value: 'ELEC' }] }],
    };
    const back = parseMspdi(
      serializeMspdi(p, { outlineCodes: [{ codeTypeId: 'ct-1', field: 1 }] }),
    );
    expect(back.project.codeTypes).toEqual([
      { id: 'Trade', name: 'Trade', values: [{ value: 'ELEC' }] },
    ]);
    expect(back.project.tasks[0]?.codes).toEqual({ Trade: 'ELEC' });
  });

  test('padded values are trimmed; whitespace-only values are absent', () => {
    const p = { ...project, tasks: [tk('1', { codes: { Trade: ' ELEC ', Area: '  ' } })] };
    const xml = serializeMspdi(p, opts);
    const back = parseMspdi(xml).project;
    expect(back.tasks[0]?.codes).toEqual({ Trade: 'ELEC' });
    expect(back.codeTypes?.find((c) => c.id === 'Trade')?.values.map((v) => v.value)).toEqual([
      'ELEC',
      'PLMB',
    ]);
  });
});

describe('parseMspdi: outline-code edge shapes', () => {
  test('an alias definition with no lookup table still reads its text values (as on main, now into codes)', () => {
    const xml = `<?xml version="1.0"?><Project xmlns="http://schemas.microsoft.com/project"><Name>x</Name><StartDate>2026-01-05T08:00:00</StartDate>
      <ExtendedAttributes><ExtendedAttribute><FieldID>188744096</FieldID><FieldName>Outline Code1</FieldName><Alias>Trade</Alias></ExtendedAttribute></ExtendedAttributes>
      <Tasks><Task><UID>1</UID><Name>A</Name><OutlineLevel>1</OutlineLevel><Start>2026-01-05T08:00:00</Start><Finish>2026-01-05T17:00:00</Finish><Duration>PT9H0M0S</Duration>
      <ExtendedAttribute><FieldID>188744096</FieldID><Value>ELEC</Value></ExtendedAttribute></Task></Tasks></Project>`;
    const { project: p, droppedFields } = parseMspdi(xml);
    expect(p.tasks[0]?.codes).toEqual({ Trade: 'ELEC' });
    expect(p.codeTypes).toEqual([{ id: 'Trade', name: 'Trade', values: [{ value: 'ELEC' }] }]);
    expect(droppedFields.filter((d) => /ExtendedAttribute/.test(d.path))).toEqual([]);
  });

  test('a task ExtendedAttribute resolves by ValueGUID before its text (no stray table rows)', () => {
    const { project: p } = parseMspdi(
      msExample(
        '<ExtendedAttribute><FieldID>188744106</FieldID><Value>Sub</Value><ValueGUID>6B0CC455-EE19-416A-8FD9-6209590B3ED7</ValueGUID></ExtendedAttribute>',
      ),
    );
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 2' });
    expect(p.codeTypes?.[0]?.values.map((v) => v.value)).toEqual(['Simple 1', 'Simple 2']);
  });

  test('an empty <FieldID/> pairs by Guid = Ltuid', () => {
    const { project: p } = parseMspdi(
      msExample(
        '<OutlineCode><FieldID>188744106</FieldID><ValueID>16</ValueID></OutlineCode>',
      ).replace('<Guid>26F0', '<FieldID></FieldID><Guid>26F0'),
    );
    expect(p.tasks[0]?.codes).toEqual({ 'Task Simple OC': 'Simple 1' });
  });
});
