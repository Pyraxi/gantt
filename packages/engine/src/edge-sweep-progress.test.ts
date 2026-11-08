import { describe, expect, it } from 'vitest';
import { schedule } from './schedule';
import { topologicalSort } from './topological-sort';
import type { Calendar, Link, Project, Task, TaskComputed } from './types';

// Edge-case sweep, part 2: progress modes and loop reporting. Same conventions
// as edge-sweep.test.ts (PASS / BY-DESIGN / DEFECT via `it.fails`).

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std M-F 8-5',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const d = (day: number, h = 8, m = 0) => new Date(2026, 0, day, h, m);
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
  // Forecast from the status date (the P6 opt-in): the modes differ only there.
  rescheduleAfterStatusDate: true,
  ...extra,
});
const MODES = [undefined, 'retained-logic', 'progress-override'] as const;
/** The scheduling-relevant part of computed (status fields only appear with a status date). */
const dates = (c: TaskComputed | undefined) => ({
  earlyStart: c?.earlyStart,
  earlyFinish: c?.earlyFinish,
  lateStart: c?.lateStart,
  lateFinish: c?.lateFinish,
  totalSlack: c?.totalSlack,
  freeSlack: c?.freeSlack,
  isCritical: c?.isCritical,
});
const datesById = (p: Project) =>
  Object.fromEntries(schedule(p).tasks.map((x) => [x.id, dates(x.computed)]));

// A chain with an unfinished SS / FF mix, so logic matters.
const chain = () => [t('a', 2), t('b', 3), t('c', 2), t('e', 4)];
const chainLinks = [link('a', 'b'), link('b', 'c'), link('a', 'e', 'SS'), link('e', 'c', 'FF')];

describe('edge sweep: progress modes', () => {
  it('with no status date, every progress mode equals the plain pass (progress is cosmetic)', () => {
    const tasks = chain().map((x) => (x.id === 'b' ? { ...x, progress: 40 } : x));
    const plain = datesById(project(tasks, chainLinks));
    for (const mode of MODES) {
      expect(datesById(project(tasks, chainLinks, { progressMode: mode }))).toEqual(plain);
    }
  });

  it('with a status date but no actuals, every progress mode equals the plain pass', () => {
    const plain = datesById(project(chain(), chainLinks));
    for (const mode of MODES) {
      const p = project(chain(), chainLinks, { progressMode: mode, statusDate: MON });
      expect(datesById(p)).toEqual(plain);
    }
  });

  it('finished work pins to its actual dates in every mode', () => {
    // Planned 2 days; it actually ran Mon 08:00 → Thu 12:00.
    const done = t('a', 2, { progress: 100, actualStart: d(5), actualFinish: d(8, 12) });
    for (const mode of MODES) {
      const p = project([done, t('b', 1)], [link('a', 'b')], {
        progressMode: mode,
        statusDate: d(12),
      });
      const a = schedule(p).tasks.find((x) => x.id === 'a')?.computed;
      expect(a?.status).toBe('complete');
      expect(a?.earlyStart).toEqual(d(5));
      expect(a?.earlyFinish).toEqual(d(8, 12));
      expect(a?.isCritical).toBe(false);
    }
  });

  it('successors of in-sequence progress get identical logic-driven dates in every mode', () => {
    // a done, b under way after a finished (in sequence), c / e not started.
    const tasks = [
      t('a', 2, { progress: 100, actualStart: d(5), actualFinish: d(6, 17) }),
      t('b', 3, { progress: 50, actualStart: d(7) }),
      t('c', 2),
      t('e', 4),
    ];
    const results = MODES.map((mode) =>
      datesById(project(tasks, chainLinks, { progressMode: mode, statusDate: d(9) })),
    );
    for (const r of results) {
      expect(r.c).toEqual(results[0]?.c);
      expect(r.e).toEqual(results[0]?.e);
    }
    // And they are logic-driven: e is floored at the status date, c finishes
    // with e (FF) and starts no earlier than b's remaining work allows (FS).
    const r = results[0];
    expect(r?.e?.earlyStart).toEqual(d(9));
    expect(r?.c?.earlyFinish).toEqual(r?.e?.earlyFinish);
    expect(r?.c?.earlyStart?.getTime()).toBeGreaterThanOrEqual(r?.b?.earlyFinish?.getTime() ?? 0);
  });
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
