import { describe, expect, test } from 'vitest';
import { computeWbs, filterProject, groupProject } from './grouping';
import type { Project, Task } from './types';

// Parity row 8 (engine slice). Spec: docs/superpowers/specs/2026-10-16-wbs-codes-grouping-design.md

const MON = new Date(2026, 0, 5, 8);
const t = (id: string, extra: Partial<Task> = {}): Task => ({
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
  defaultCalendarId: 'std',
  tasks,
  links: [{ id: 'l', source: 'a1', target: 'b1', type: 'FS', lag: 0 }],
  resources: [],
  calendars: [{ id: 'std', name: 'Std', workWeek: [[], [], [], [], [], [], []], exceptions: [] }],
  baselines: [],
  assignments: [],
  ...extra,
});

//  A (summary)        B (summary)
//   a1 trade=frame     b1 trade=plumb
//   a2 trade=plumb     B2 (summary)
//                       b21 (no trade)
const tree = () =>
  project(
    [
      t('A', { type: 'summary' }),
      t('a1', { parent: 'A', codes: { trade: 'frame' } }),
      t('a2', { parent: 'A', codes: { trade: 'plumb' } }),
      t('B', { type: 'summary' }),
      t('b1', { parent: 'B', codes: { trade: 'plumb' } }),
      t('B2', { type: 'summary', parent: 'B' }),
      t('b21', { parent: 'B2' }),
    ],
    {
      codeTypes: [
        {
          id: 'trade',
          name: 'Trade',
          values: [
            { value: 'plumb', description: 'Plumbing', color: '#1e88e5' },
            { value: 'frame', description: 'Framing' },
          ],
        },
      ],
    },
  );

describe('computeWbs', () => {
  test('outline numbers follow the hierarchy and array order', () => {
    const w = computeWbs(tree());
    expect(Object.fromEntries(w)).toEqual({
      A: '1',
      a1: '1.1',
      a2: '1.2',
      B: '2',
      b1: '2.1',
      B2: '2.2',
      b21: '2.2.1',
    });
  });
});

describe('groupProject', () => {
  test('re-parents leaves under one virtual summary per code value, in code-type order, (none) last', () => {
    const g = groupProject(tree(), 'trade');
    const groups = g.tasks.filter((x) => x.type === 'summary');
    expect(groups.map((x) => [x.id, x.text])).toEqual([
      ['group:plumb', 'Plumbing'],
      ['group:frame', 'Framing'],
      ['group:(none)', '(none)'],
    ]);
    const parentOf = Object.fromEntries(
      g.tasks.filter((x) => x.type !== 'summary').map((x) => [x.id, x.parent]),
    );
    expect(parentOf).toEqual({
      a2: 'group:plumb',
      b1: 'group:plumb',
      a1: 'group:frame',
      b21: 'group:(none)',
    });
    expect(groups[0]?.group).toEqual({ by: 'trade', value: 'plumb', color: '#1e88e5' });
  });

  test('rows are in group order, each group followed by its tasks', () => {
    expect(groupProject(tree(), 'trade').tasks.map((x) => x.id)).toEqual([
      'group:plumb',
      'a2',
      'b1',
      'group:frame',
      'a1',
      'group:(none)',
      'b21',
    ]);
  });

  test('a function key groups by any task property; links are kept', () => {
    const g = groupProject(tree(), (task) =>
      String(task.id).startsWith('a') ? 'A-side' : undefined,
    );
    expect(g.tasks.filter((x) => x.type === 'summary').map((x) => x.id)).toEqual([
      'group:A-side',
      'group:(none)',
    ]);
    expect(g.links).toEqual(tree().links);
  });

  test('does not mutate the input', () => {
    const p = tree();
    const snap = JSON.stringify(p);
    groupProject(p, 'trade');
    expect(JSON.stringify(p)).toBe(snap);
  });
});

describe('filterProject', () => {
  test('matches plus all their ancestors, in project order', () => {
    expect(filterProject(tree(), (x) => x.codes?.trade === 'plumb')).toEqual([
      'A',
      'a2',
      'B',
      'b1',
    ]);
    expect(filterProject(tree(), (x) => x.id === 'b21')).toEqual(['B', 'B2', 'b21']);
  });
});

describe('groupProject + schedule()', () => {
  test('a grouped project schedules; group rows span their members', async () => {
    const { schedule } = await import('./schedule');
    const p = tree();
    p.calendars = [
      {
        id: 'std',
        name: 'Std',
        workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
        exceptions: [],
      },
    ];
    const s = schedule(groupProject(p, 'trade'));
    const plumb = s.tasks.find((x) => x.id === 'group:plumb');
    const b1 = s.tasks.find((x) => x.id === 'b1');
    expect(plumb?.computed?.earlyFinish.getTime()).toBeGreaterThanOrEqual(
      b1?.computed?.earlyFinish.getTime() ?? 0,
    );
  });
});

describe('grouping — review fixes', () => {
  test('a task id colliding with a group row id is a clear error, not a stack overflow', () => {
    const p = tree();
    p.tasks.push(t('group:plumb', { codes: { trade: 'plumb' } }));
    expect(() => groupProject(p, 'trade')).toThrow(/collides/);
  });

  test('no duplicate group rows: a declared "(none)", duplicate declared values, numeric codes', () => {
    const p = tree();
    p.codeTypes = [
      {
        id: 'trade',
        name: 'Trade',
        values: [{ value: 'plumb' }, { value: 'plumb' }, { value: '(none)' }],
      },
    ];
    const ids = groupProject(p, 'trade').tasks.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const q = tree();
    (q.tasks[1] as Task).codes = { trade: 1 as unknown as string };
    (q.tasks[2] as Task).codes = { trade: '1' };
    const ids2 = groupProject(q, 'trade').tasks.map((x) => x.id);
    expect(new Set(ids2).size).toBe(ids2.length);
  });

  test('group rows carry a typed `group` marker (not extra) and span their members’ dates', async () => {
    const { schedule } = await import('./schedule');
    const p = tree();
    p.calendars = [
      {
        id: 'std',
        name: 'Std',
        workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
        exceptions: [],
      },
    ];
    const scheduled = schedule(p);
    const g = groupProject(scheduled, 'trade');
    const row = g.tasks.find((x) => x.id === 'group:plumb');
    expect(row?.group).toEqual({ by: 'trade', value: 'plumb', color: '#1e88e5' });
    expect(row?.extra).toBeUndefined();
    const members = scheduled.tasks.filter((x) => x.codes?.trade === 'plumb');
    const min = Math.min(...members.map((m) => m.computed?.earlyStart.getTime() ?? 0));
    const max = Math.max(...members.map((m) => m.computed?.earlyFinish.getTime() ?? 0));
    expect(row?.start.getTime()).toBe(min);
    expect(row?.end.getTime()).toBe(max);
    expect(row?.computed?.earlyFinish.getTime()).toBe(max); // renders under preScheduled
  });

  test('a function grouping can be labelled', () => {
    const g = groupProject(tree(), () => 'x', { label: 'side' });
    expect(g.tasks[0]?.group?.by).toBe('side');
  });

  test('computeWbs numbers every task, including ones in a parent cycle', () => {
    const p = project([
      t('A', { parent: 'B' }),
      t('B', { parent: 'A' }),
      t('C', { parent: 'C' }),
      t('D'),
    ]);
    expect(computeWbs(p).size).toBe(4);
  });

  test('ids match strictly, as schedule() does', () => {
    const p = project([
      t('1'),
      { ...t('x'), id: 1 as unknown as string },
      t('c', { parent: 1 as unknown as string }),
    ]);
    // The child points at numeric 1, not string '1'.
    expect(computeWbs(p).get('c')).toBe('2.1');
  });
});
