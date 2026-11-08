import { describe, expect, test } from 'vitest';
import {
  analyseDriving,
  getDrivenPath,
  getDrivingPath,
  getFloatPaths,
  getLinkDriving,
  getLongestPath,
} from './driving';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 5. Spec: docs/superpowers/specs/2026-10-16-driving-path-design.md

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const t = (id: string, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: days === 0 ? 'milestone' : 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const link = (s: string, d: string, type: Link['type'] = 'FS', lagDays = 0): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type,
  lag: lagDays * DAY,
});
const project = (tasks: Task[], links: Link[], extra: Partial<Project> = {}): Project => ({
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

//   a(3) ──► c(2) ──► e(1)
//   b(1) ──┘          ▲
//   d(1) ─────────────┘
// c is driven by a (b has 2 days of relationship float); e is driven by c (d has 4).
const net = () =>
  project(
    [t('a', 3), t('b', 1), t('c', 2), t('d', 1), t('e', 1)],
    [link('a', 'c'), link('b', 'c'), link('c', 'e'), link('d', 'e')],
  );

describe('getLinkDriving', () => {
  test('relationship free float and driving flag per link', () => {
    const r = getLinkDriving(net());
    expect(r.get('a-c')).toEqual({ driving: true, relationshipFreeFloat: 0 });
    expect(r.get('b-c')).toEqual({ driving: false, relationshipFreeFloat: 2 * DAY });
    expect(r.get('c-e')).toEqual({ driving: true, relationshipFreeFloat: 0 });
    expect(r.get('d-e')).toEqual({ driving: false, relationshipFreeFloat: 4 * DAY });
  });

  test('a successor held later by a constraint has no driving predecessor link', () => {
    const p = project(
      [t('a', 1), t('b', 1, { constraint: { type: 'SNET', date: new Date(2026, 0, 8, 8) } })],
      [link('a', 'b')],
    );
    expect(getLinkDriving(p).get('a-b')).toEqual({
      driving: false,
      relationshipFreeFloat: 2 * DAY,
    });
  });

  test('SS and FF links with lag are measured in the successor calendar', () => {
    const p = project(
      [t('a', 4), t('b', 2), t('c', 2)],
      [link('a', 'b', 'SS', 1), link('a', 'c', 'FF')],
    );
    const r = getLinkDriving(p);
    expect(r.get('a-b')?.driving).toBe(true);
    expect(r.get('a-c')?.driving).toBe(true);
  });

  test('links touching summaries or unscheduled tasks are left out', () => {
    const p = project(
      [
        t('s', 0, { type: 'summary' }),
        t('a', 1, { parent: 's' }),
        t('b', 1),
        t('u', 1, { unscheduled: true }),
      ],
      [link('s', 'b'), link('a', 'u')],
    );
    expect([...getLinkDriving(p).keys()]).toEqual([]);
  });
});

describe('getDrivingPath', () => {
  test('walks driving links back from the task, ordered by early start', () => {
    expect(getDrivingPath(net(), 'e')).toEqual({
      taskIds: ['a', 'c', 'e'],
      linkIds: ['a-c', 'c-e'],
    });
    expect(getDrivingPath(net(), 'b')).toEqual({ taskIds: ['b'], linkIds: [] });
  });

  test('two equal drivers both drive', () => {
    const p = project([t('a', 2), t('b', 2), t('c', 1)], [link('a', 'c'), link('b', 'c')]);
    expect(getDrivingPath(p, 'c').taskIds.sort()).toEqual(['a', 'b', 'c']);
  });

  test('unknown task → empty path', () => {
    expect(getDrivingPath(net(), 'zzz')).toEqual({ taskIds: [], linkIds: [] });
  });
});

describe('getDrivenPath (MSP Task Path: driven successors)', () => {
  test('a drives c drives e; b drives nothing (it has float into c)', () => {
    expect(getDrivenPath(net(), 'a')).toEqual({
      taskIds: ['a', 'c', 'e'],
      linkIds: ['a-c', 'c-e'],
    });
    expect(getDrivenPath(net(), 'b')).toEqual({ taskIds: ['b'], linkIds: [] });
    expect(getDrivenPath(net(), 'e')).toEqual({ taskIds: ['e'], linkIds: [] });
  });

  test('mirrors drivingPath: x is in drivenPath(a) iff a is in drivingPath(x)', () => {
    const p = net();
    const an = analyseDriving(p);
    for (const a of p.tasks) {
      for (const x of p.tasks) {
        expect(an.drivenPath(a.id).taskIds.includes(x.id)).toBe(
          an.drivingPath(x.id).taskIds.includes(a.id),
        );
      }
    }
  });

  test('unknown, summary and unscheduled ids give an empty path', () => {
    const p = project(
      [
        t('s', 1, { type: 'summary' }),
        t('a', 1, { parent: 's' }),
        t('u', 1, { unscheduled: true }),
      ],
      [],
    );
    for (const id of ['nope', 's', 'u']) {
      expect(getDrivenPath(p, id)).toEqual({ taskIds: [], linkIds: [] });
    }
  });
});

describe('getLongestPath', () => {
  test('is the driving path back from the latest early finish', () => {
    expect(getLongestPath(net())).toEqual({ taskIds: ['a', 'c', 'e'], linkIds: ['a-c', 'c-e'] });
  });

  test('ignores a far-out project end that removes all total-float criticality', () => {
    const p = { ...net(), end: new Date(2026, 5, 1, 17) };
    expect(getLongestPath(p).taskIds).toEqual(['a', 'c', 'e']);
  });
});

describe('getFloatPaths', () => {
  test('path 1 is the longest path; later paths follow the next-lowest total float', () => {
    const paths = getFloatPaths(net());
    expect(paths[0]).toEqual({ path: 1, taskIds: ['a', 'c', 'e'] });
    expect(paths[1]).toEqual({ path: 2, taskIds: ['b'] }); // TF 2 days
    expect(paths[2]).toEqual({ path: 3, taskIds: ['d'] }); // TF 4 days
    expect(paths).toHaveLength(3);
  });

  test('maxPaths caps the result; endTaskId picks the target', () => {
    expect(getFloatPaths(net(), { maxPaths: 1 })).toHaveLength(1);
    expect(getFloatPaths(net(), { endTaskId: 'c' })[0]).toEqual({ path: 1, taskIds: ['a', 'c'] });
  });

  test('every scheduled leaf upstream of the end appears in exactly one path', () => {
    const paths = getFloatPaths(net(), { maxPaths: 99 });
    const all = paths.flatMap((p) => p.taskIds).sort();
    expect(all).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});

describe('driving analysis — review fixes', () => {
  test('analyseDriving: one analysis answers every query (no re-analysis per task)', () => {
    const a = analyseDriving(net());
    expect(a.links.get('a-c')?.driving).toBe(true);
    expect(a.drivingPath('e')).toEqual(getDrivingPath(net(), 'e'));
    expect(a.longestPath()).toEqual(getLongestPath(net()));
    expect(a.floatPaths()).toEqual(getFloatPaths(net()));
  });

  test('a dangling constrained end milestone (no logic) does not hijack the longest path', () => {
    const p = project(
      [
        ...net().tasks,
        t('pc', 0, { constraint: { type: 'MFO', date: new Date(2026, 11, 18, 17) } }),
      ],
      net().links,
    );
    expect(getLongestPath(p).taskIds).toEqual(['a', 'c', 'e']);
    expect(getFloatPaths(p)[0]?.taskIds).toEqual(['a', 'c', 'e']);
    // An explicit end still wins.
    expect(getFloatPaths(p, { endTaskId: 'pc' })[0]?.taskIds).toEqual(['pc']);
  });

  test('tied latest finishers: float path 1 is one chain, the other is path 2', () => {
    // a(3)→c(2) and an unrelated d(5) with logic both finish Fri 9 Jan 17:00.
    const p = project(
      [t('s0', 0), t('a', 3), t('c', 2), t('d', 5)],
      [link('s0', 'a'), link('a', 'c'), link('s0', 'd')],
    );
    const paths = getFloatPaths(p);
    expect(paths[0]?.taskIds).toEqual(['s0', 'a', 'c']);
    expect(paths[1]?.taskIds).toEqual(['d']);
    // Longest Path keeps both chains: both drive the finish.
    expect(getLongestPath(p).taskIds.sort()).toEqual(['a', 'c', 'd', 's0']);
  });

  test('maxPaths <= 0 returns no paths', () => {
    expect(getFloatPaths(net(), { maxPaths: 0 })).toEqual([]);
    expect(getFloatPaths(net(), { maxPaths: -1 })).toEqual([]);
  });

  test('relationship free float is never -0', () => {
    const p = project(
      [t('a', 1), t('b', 1, { constraint: { type: 'MSO', date: new Date(2026, 0, 10, 0) } })],
      [link('a', 'b')],
    );
    const rff = getLinkDriving(p).get('a-b')?.relationshipFreeFloat;
    expect(Object.is(rff, -0)).toBe(false);
  });
});

describe('driving analysis with a status date', () => {
  const sp = (mode?: 'progress-override') =>
    project(
      [t('a', 1), t('cc', 10), t('b', 4, { progress: 50, actualStart: new Date(2026, 0, 6, 8) })],
      [link('a', 'b'), link('cc', 'b')],
      { statusDate: new Date(2026, 0, 7, 8), ...(mode ? { progressMode: mode } : {}) },
    );
  test('into an in-progress task, only the link setting its remaining start drives', () => {
    const r = getLinkDriving(sp());
    expect(r.get('cc-b')?.driving).toBe(true);
    expect(r.get('a-b')?.driving).toBe(false);
  });
  test('under progress override nothing drives an in-progress task', () => {
    const r = getLinkDriving(sp('progress-override'));
    expect(r.get('cc-b')?.driving).toBe(false);
    expect(r.get('a-b')?.driving).toBe(false);
  });
});
