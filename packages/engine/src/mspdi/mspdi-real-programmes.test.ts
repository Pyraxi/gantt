import { describe, expect, test } from 'vitest';
import { parseMspdi } from './parse.js';

// Patterns found in five real MS Project programmes (CM's 2026-10-21 check,
// converted by MPXJ 16.10). The XML here is synthetic: no client data.

const xmlOf = (tasks: string) => `<?xml version="1.0"?>
<Project xmlns="http://schemas.microsoft.com/project"><Name>X</Name><StartDate>2026-03-02T08:00:00</StartDate>
<Tasks>${tasks}</Tasks></Project>`;
const row = (uid: number, level: number, name: string, summary = 0) =>
  `<Task><UID>${uid}</UID><ID>${uid}</ID><Name>${name}</Name><OutlineLevel>${level}</OutlineLevel><Summary>${summary}</Summary>` +
  '<Start>2026-03-02T08:00:00</Start><Finish>2026-03-02T17:00:00</Finish><Duration>PT8H0M0S</Duration></Task>';

describe('real programmes: MS Project blank rows', () => {
  test('a blank row (IsNull, no name or outline level) is skipped and keeps the outline', () => {
    const { project, droppedFields } = parseMspdi(
      xmlOf(
        row(1, 1, 'Job', 1) +
          row(2, 2, 'Stage', 1) +
          row(3, 3, 'Set out') +
          '<Task><UID>4</UID><ID>4</ID><IsNull>1</IsNull></Task>' +
          row(5, 3, 'Excavate') +
          row(6, 2, 'Next stage', 1) +
          row(7, 3, 'Frame'),
      ),
    );
    expect(project.tasks.map((t) => [t.id, t.parent])).toEqual([
      ['1', undefined],
      ['2', '1'],
      ['3', '2'],
      ['5', '2'],
      ['6', '1'],
      ['7', '6'],
    ]);
    expect(droppedFields).toContainEqual({
      path: 'Project.Tasks.Task[3]',
      value: 'blank row skipped',
      reason: 'unsupported-element',
    });
  });

  test('a link from a blank row is dropped and reported, like one from the project summary', () => {
    const { project, droppedFields } = parseMspdi(
      xmlOf(
        '<Task><UID>3</UID><ID>3</ID><IsNull>1</IsNull></Task>' +
          row(4, 1, 'Frame').replace(
            '</Task>',
            '<PredecessorLink><PredecessorUID>3</PredecessorUID><Type>1</Type></PredecessorLink></Task>',
          ),
      ),
    );
    expect(project.links).toEqual([]);
    expect(
      droppedFields.some((f) => /PredecessorLink/.test(f.path) && /skipped row/.test(f.value)),
    ).toBe(true);
  });

  test('a named IsNull task is still an unscheduled task (ADR-007)', () => {
    const { project } = parseMspdi(
      xmlOf(
        `${row(1, 1, 'Job', 1)}<Task><UID>2</UID><ID>2</ID><Name>PC sum</Name><OutlineLevel>2</OutlineLevel><IsNull>1</IsNull></Task>`,
      ),
    );
    expect(project.tasks[1]).toMatchObject({ id: '2', parent: '1', unscheduled: true });
  });
});
