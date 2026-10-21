import { describe, expect, it } from 'vitest';
import { schedule } from './schedule';
import { topologicalSort } from './topological-sort';
import type { Calendar, Link, Project, Task } from './types';

// Edge-case sweep, part 2: loop reporting. Same conventions
// as edge-sweep.test.ts (PASS / BY-DESIGN / DEFECT via `it.fails`).

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std M-F 8-5',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const link = (s: string, x: string, type: Link['type'] = 'FS'): Link => ({
  id: `${s}-${x}`,
  source: s,
  target: x,
  type,
  lag: 0,
});
const project = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
  ...extra,
});
describe('edge sweep: loops', () => {
  // Was a DEFECT: topologicalSort threw one generic "Link graph contains a
  // cycle" with no task ids. Now (P6 "circular relationships") every loop's
  // tasks are named.
  it('two separate loops are both reported, naming their tasks', () => {
    const tasks = [t('loopA1', 1), t('loopA2', 1), t('loopB1', 1), t('loopB2', 1), t('ok', 1)];
    const links = [
      link('loopA1', 'loopA2'),
      link('loopA2', 'loopA1'),
      link('loopB1', 'loopB2'),
      link('loopB2', 'loopB1'),
    ];
    let message = '';
    try {
      topologicalSort(tasks, links);
    } catch (e) {
      message = String(e);
    }
    for (const id of ['loopA1', 'loopA2', 'loopB1', 'loopB2']) expect(message).toContain(id);
    expect(message).not.toContain('ok');
    expect(message).toContain('Link graph contains a cycle');
    expect(message).toContain('[loopA1 → loopA2 → loopA1], [loopB1 → loopB2 → loopB1]');
  });

  it('a self-link and a task downstream of a loop: only the loop is named', () => {
    const tasks = [t('s', 1), t('a', 1), t('b', 1), t('c', 1), t('after', 1)];
    const links = [
      link('s', 's'),
      link('a', 'b'),
      link('b', 'c'),
      link('c', 'a'),
      link('c', 'after'),
    ];
    let message = '';
    try {
      topologicalSort(tasks, links);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('[s → s], [a → b → c → a]');
    expect(message).not.toContain('after');
  });

  it('a tangle with no single loop through every task still names them all', () => {
    // a ⇄ b ⇄ c: strongly connected, but no simple cycle covers all three.
    const tasks = [t('a', 1), t('b', 1), t('c', 1)];
    const links = [link('a', 'b'), link('b', 'a'), link('b', 'c'), link('c', 'b')];
    let message = '';
    try {
      topologicalSort(tasks, links);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('[a → b → a (+ c)]');
  });

  it("a tangle's other tasks are listed in task order, whatever the link order", () => {
    // b's links reach d before c, so the search meets them out of task order.
    const tasks = [t('a', 1), t('b', 1), t('c', 1), t('d', 1), t('x', 1)];
    const links = [
      link('a', 'b'),
      link('b', 'a'),
      link('b', 'd'),
      link('d', 'b'),
      link('b', 'c'),
      link('c', 'b'),
      link('x', 'x'),
    ];
    let message = '';
    try {
      topologicalSort(tasks, links);
    } catch (e) {
      message = String(e);
    }
    expect(message).toContain('loops: [a → b → a (+ c, d)], [x → x]');
  });

  it('a loop is refused by schedule() rather than silently scheduled', () => {
    const p = project([t('a', 1), t('b', 1)], [link('a', 'b'), link('b', 'a')]);
    expect(() => schedule(p)).toThrow(/cycle/);
  });
});
