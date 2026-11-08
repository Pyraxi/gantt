import { describe, expect, test } from 'vitest';
import type { Link, Project, Task } from '../types.js';
import { EditError } from './errors.js';
import {
  diffPredecessors,
  predecessorsCreateCycle,
  SetPredecessorsCommand,
  setPredecessors,
} from './predecessors.js';

const tk = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5),
  end: new Date(2026, 0, 6),
  progress: 0,
});
const links: Link[] = [
  { id: 'a->d', source: 'a', target: 'd', type: 'FS', lag: 0 },
  { id: 'b->d', source: 'b', target: 'd', type: 'SS', lag: 0, lagPercent: 50 },
  { id: 'a->c', source: 'a', target: 'c', type: 'FS', lag: 0 },
];
const project: Project = {
  start: new Date(2026, 0, 5),
  defaultCalendarId: 'std',
  tasks: ['a', 'b', 'c', 'd', 'e'].map(tk),
  links,
  resources: [],
  calendars: [],
  baselines: [],
  assignments: [],
};

describe('setPredecessors', () => {
  test('keeps, updates, removes and creates — one undo step restores the links exactly', () => {
    const cmd = new SetPredecessorsCommand('d', [
      { source: 'a', type: 'FS', lag: 0 },
      { source: 'b', type: 'SS', lag: 540 },
      { source: 'c', type: 'FF', lag: 0, lagElapsed: true },
    ]);
    const next = cmd.apply(project);
    expect(next.links).toEqual([
      { id: 'a->d', source: 'a', target: 'd', type: 'FS', lag: 0 },
      { id: 'b->d', source: 'b', target: 'd', type: 'SS', lag: 540 },
      { id: 'a->c', source: 'a', target: 'c', type: 'FS', lag: 0 },
      { id: 'c->d', source: 'c', target: 'd', type: 'FF', lag: 0, lagElapsed: true },
    ]);
    expect(cmd.inverse(next).apply(next).links).toStrictEqual(project.links);
  });

  test('an empty list removes every predecessor of that task only', () => {
    expect(setPredecessors('d', []).apply(project).links).toEqual([links[2]]);
  });

  test('refuses a cycle, a self-reference and an unknown task (EditError)', () => {
    // c already follows a (a→c); giving a the predecessor c closes a loop.
    expect(predecessorsCreateCycle('a', links, [{ source: 'c', type: 'FS', lag: 0 }])).toBe(true);
    expect(() =>
      setPredecessors('a', [{ source: 'c', type: 'FS', lag: 0 }]).apply(project),
    ).toThrow(EditError);
    expect(() =>
      setPredecessors('d', [{ source: 'd', type: 'FS', lag: 0 }]).apply(project),
    ).toThrow(EditError);
    expect(() =>
      setPredecessors('d', [{ source: 'zz', type: 'FS', lag: 0 }]).apply(project),
    ).toThrow(EditError);
    // One link per predecessor (as MS Project): the same task twice is refused.
    expect(() =>
      setPredecessors('d', [
        { source: 'a', type: 'FS', lag: 0 },
        { source: 'a', type: 'SS', lag: 0 },
      ]).apply(project),
    ).toThrow(/twice/);
    // Replacing d's own predecessors never counts its current incoming links as a loop.
    expect(predecessorsCreateCycle('d', links, [{ source: 'c', type: 'FS', lag: 0 }])).toBe(false);
  });

  test("a source given as a string gets the task's own (numeric) id", () => {
    const numeric: Project = {
      ...project,
      links: [],
      tasks: [1, 2].map((n) => ({ ...tk('x'), id: n })),
    };
    const next = setPredecessors(2, [{ source: '1', type: 'FS', lag: 0 }]).apply(numeric);
    expect(next.links).toEqual([{ id: '1->2', source: 1, target: 2, type: 'FS', lag: 0 }]);
  });

  test('a new link id that is taken gets a suffix', () => {
    const taken: Project = {
      ...project,
      links: [{ id: 'e->d', source: 'x', target: 'y', type: 'FS', lag: 0 }],
      tasks: [...project.tasks, tk('x'), tk('y')],
    };
    const next = setPredecessors('d', [{ source: 'e', type: 'FS', lag: 0 }]).apply(taken);
    expect(next.links.map((l) => l.id)).toEqual(['e->d', 'e->d#2']);
  });
});

describe('diffPredecessors', () => {
  const dlinks: Link[] = [
    { id: 'l1', source: 'a', target: 'd', type: 'FS', lag: 0 },
    { id: 'l2', source: 'b', target: 'd', type: 'SS', lag: 0 },
    { id: 'lx', source: 'a', target: 'c', type: 'FS', lag: 0 }, // another task's link: untouched
  ];
  test('matched by predecessor: unchanged kept, changed updated, missing removed, new created', () => {
    const d = diffPredecessors('d', dlinks, [
      { source: 'a', type: 'FS', lag: 0 },
      { source: 'b', type: 'SS', lag: 540 },
      { source: 'c', type: 'FF', lag: 0 },
    ]);
    expect(d).toEqual({
      create: [{ source: 'c', type: 'FF', lag: 0 }],
      remove: [],
      update: [{ id: 'l2', patch: { type: 'SS', lag: 540 } }],
    });
    expect(diffPredecessors('d', dlinks, [])).toEqual({
      create: [],
      remove: ['l1', 'l2'],
      update: [],
    });
  });

  test('a percent / elapsed change updates (and clears) the lag kind', () => {
    const withPct: Link[] = [
      { id: 'l1', source: 'a', target: 'd', type: 'FS', lag: 0, lagPercent: 50 },
    ];
    expect(diffPredecessors('d', withPct, [{ source: 'a', type: 'FS', lag: 540 }])).toEqual({
      create: [],
      remove: [],
      update: [{ id: 'l1', patch: { type: 'FS', lag: 540, lagPercent: undefined } }],
    });
  });
});
