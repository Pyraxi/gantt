import { describe, expect, test } from 'vitest';
import { analyseCombined, combineProjects } from './combine';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 24. Spec: docs/superpowers/specs/2026-10-16-multi-project-master-design.md
// (scope decision 2026-10-19: combined view + cross-job critical path).

const DAY = 540;
const std: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const NEXT_MON = new Date(2026, 0, 12, 8);
const t = (id: string | number, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: String(id),
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const link = (s: string, d: string, id = `${s}-${d}`): Link => ({
  id,
  source: s,
  target: d,
  type: 'FS',
  lag: 0,
});
const job = (tasks: Task[], links: Link[] = [], extra: Partial<Project> = {}): Project => ({
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
const byId = (p: Project, id: string) => p.tasks.find((x) => String(x.id) === id) as Task;

describe('combineProjects: namespacing', () => {
  const parts = [
    { key: 'j1', name: 'Smith St', project: job([t('a', 2), t('b', 3)], [link('a', 'b')]) },
    { key: 'j2', project: job([t('a', 1)]) },
  ];

  test('each part becomes a summary row over its namespaced tasks', () => {
    const { project } = combineProjects(parts);
    expect(project.tasks.map((x) => [x.id, x.parent, x.type])).toEqual([
      ['j1', undefined, 'summary'],
      ['j1/a', 'j1', 'task'],
      ['j1/b', 'j1', 'task'],
      ['j2', undefined, 'summary'],
      ['j2/a', 'j2', 'task'],
    ]);
    expect(byId(project, 'j1').text).toBe('Smith St');
    expect(byId(project, 'j2').text).toBe('j2');
  });

  test('links, calendars and each part’s default calendar are rewritten', () => {
    const { project } = combineProjects(parts);
    expect(project.links).toEqual([
      { ...link('a', 'b'), id: 'j1/a-b', source: 'j1/a', target: 'j1/b' },
    ]);
    expect(project.calendars.map((c) => c.id)).toEqual(['j1/std', 'j2/std']);
    expect(project.defaultCalendarId).toBe('j1/std');
    expect(byId(project, 'j2/a').calendarId).toBe('j2/std');
  });

  test('nested parents, calendar bases, resources and assignments are rewritten', () => {
    const own: Calendar = { ...std, id: 'night', baseCalendarId: 'std' };
    const p = job(
      [
        t('s', 0, { type: 'summary' }),
        t('c', 1, { parent: 's', calendarId: 'night', resourceIds: ['r'] }),
      ],
      [],
      {
        calendars: [std, own],
        resources: [{ id: 'r', name: 'Crew', calendarId: 'night' }],
        assignments: [{ id: 'as', taskId: 'c', resourceId: 'r' }],
      },
    );
    const { project } = combineProjects([{ key: 'j', project: p }]);
    expect(byId(project, 'j/c')).toMatchObject({
      parent: 'j/s',
      calendarId: 'j/night',
      resourceIds: ['j/r'],
    });
    expect(byId(project, 'j/s').parent).toBe('j');
    expect(project.calendars[1]).toMatchObject({ id: 'j/night', baseCalendarId: 'j/std' });
    expect(project.resources).toEqual([{ id: 'j/r', name: 'Crew', calendarId: 'j/night' }]);
    expect(project.assignments).toEqual([{ id: 'j/as', taskId: 'j/c', resourceId: 'j/r' }]);
  });

  test('locate and idOf map between combined and part ids, keeping the id’s type', () => {
    const { locate, idOf } = combineProjects([
      {
        key: 'j',
        project: job([t(7, 1), t(8, 1)], [{ ...link('7', '8', 'l'), source: 7, target: 8 }]),
      },
    ]);
    expect(locate('j/7')).toEqual({ key: 'j', id: 7 });
    expect(locate('j/l')).toEqual({ key: 'j', id: 'l' });
    expect(locate('j/std')).toEqual({ key: 'j', id: 'std' });
    expect(locate('j')).toBeUndefined();
    expect(locate('nope/1')).toBeUndefined();
    expect(idOf('j', 7)).toBe('j/7');
  });

  test('code types are merged by id, values de-duplicated', () => {
    const trade = (vals: string[]) => ({
      id: 'trade',
      name: 'Trade',
      values: vals.map((value) => ({ value })),
    });
    const { project } = combineProjects([
      { key: 'a', project: job([t('x', 1)], [], { codeTypes: [trade(['ELEC', 'PLMB'])] }) },
      { key: 'b', project: job([t('x', 1)], [], { codeTypes: [trade(['PLMB', 'ROOF'])] }) },
    ]);
    expect(project.codeTypes).toEqual([trade(['ELEC', 'PLMB', 'ROOF'])]);
  });

  test('keys must be unique and free of "/" and ":"', () => {
    const p = job([t('a', 1)]);
    expect(() =>
      combineProjects([
        { key: 'a', project: p },
        { key: 'a', project: p },
      ]),
    ).toThrow(/duplicate/i);
    expect(() => combineProjects([{ key: 'a/b', project: p }])).toThrow(/key/i);
    expect(() => combineProjects([{ key: 'x:1', project: p }])).toThrow(/key/i);
    expect(() => combineProjects([{ key: '', project: p }])).toThrow(/key/i);
  });
});

describe('combineProjects: part start floor', () => {
  test('a later part’s tasks are floored at its start and the floors reported', () => {
    const later = job(
      [
        t('free', 1),
        t('early', 1, { constraint: { type: 'SNET', date: MON } }),
        t('late', 1, { constraint: { type: 'SNET', date: new Date(2026, 0, 14, 8) } }),
        t('pinned', 1, { constraint: { type: 'MFO', date: new Date(2026, 0, 6, 17) } }),
        t('manual', 1, { scheduleMode: 'manual' }),
      ],
      [],
      { start: NEXT_MON },
    );
    const { project, notes } = combineProjects([
      { key: 'j1', project: job([t('a', 1)]) },
      { key: 'j2', project: later },
    ]);
    expect(project.start).toEqual(MON);
    expect(byId(project, 'j1/a').constraint).toBeUndefined();
    expect(byId(project, 'j2/free').constraint).toEqual({ type: 'SNET', date: NEXT_MON });
    expect(byId(project, 'j2/early').constraint).toEqual({ type: 'SNET', date: NEXT_MON });
    expect(byId(project, 'j2/late').constraint).toEqual({
      type: 'SNET',
      date: new Date(2026, 0, 14, 8),
    });
    expect(byId(project, 'j2/pinned').constraint?.type).toBe('MFO');
    expect(byId(project, 'j2/manual').constraint).toBeUndefined();
    expect(notes).toEqual([
      { key: 'j2', id: 'free', kind: 'start-floor' },
      { key: 'j2', id: 'early', kind: 'start-floor' },
    ]);
    const s = schedule(project);
    expect(byId(s, 'j2/free').start).toEqual(NEXT_MON);
  });

  test('one part schedules exactly as it does alone', () => {
    const p = job(
      [t('a', 2), t('b', 3), t('m', 0, { type: 'milestone' })],
      [link('a', 'b'), link('b', 'm')],
    );
    const alone = schedule(p);
    const combined = schedule(combineProjects([{ key: 'j', project: p }]).project);
    for (const x of alone.tasks) {
      const y = byId(combined, `j/${x.id}`);
      expect([y.start, y.end, y.computed?.totalSlack]).toEqual([
        x.start,
        x.end,
        x.computed?.totalSlack,
      ]);
    }
  });
});

describe('combineProjects: start floor edge cases (review)', () => {
  const SAT_MIDNIGHT = new Date(2026, 0, 10, 0);
  const first = { key: 'j1', project: job([t('a', 1)]) };

  test('the floor snaps into each task’s calendar, as the part’s own start does', () => {
    const later = job([t('a', 1)], [], { start: SAT_MIDNIGHT });
    const { project } = combineProjects([first, { key: 'j2', project: later }]);
    expect(byId(project, 'j2/a').constraint).toEqual({ type: 'SNET', date: NEXT_MON });
    const alone = byId(schedule(later), 'a');
    const combined = byId(schedule(project), 'j2/a');
    expect([combined.start, combined.end]).toEqual([alone.start, alone.end]);
  });

  test('a weekend-midnight part start: elapsed and resource-calendar tasks match the part alone', () => {
    const late: Calendar = {
      ...std,
      id: 'late',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 720, endMinutes: 1020 }]), []],
    };
    const later = job(
      [
        t('plain', 1),
        t('cure', 2, { durationElapsed: true }),
        t('crew', 1, { resourceIds: ['r'] }),
      ],
      [],
      {
        start: SAT_MIDNIGHT,
        calendars: [std, late],
        resources: [{ id: 'r', name: 'Crew', calendarId: 'late' }],
      },
    );
    const alone = schedule(later);
    const combined = schedule(combineProjects([first, { key: 'j2', project: later }]).project);
    for (const x of alone.tasks) {
      const y = byId(combined, `j2/${x.id}`);
      expect([y.start, y.end, y.computed?.totalSlack]).toEqual([
        x.start,
        x.end,
        x.computed?.totalSlack,
      ]);
    }
  });

  test('an ALAP task in a later part is floored too', () => {
    const later = job([t('a', 1, { constraint: { type: 'ALAP' } })], [], { start: NEXT_MON });
    const { project, notes } = combineProjects([first, { key: 'j2', project: later }]);
    expect(byId(project, 'j2/a').constraint).toEqual({ type: 'SNET', date: NEXT_MON });
    expect(notes).toEqual([{ key: 'j2', id: 'a', kind: 'start-floor' }]);
  });

  test('under a status date, started and complete tasks are not floored', () => {
    const SD = new Date(2026, 0, 14, 8);
    const later = job(
      [
        t('ip', 3, { progress: 50, actualStart: NEXT_MON }),
        t('done', 1, { progress: 100, actualStart: NEXT_MON }),
        t('new', 1),
      ],
      [],
      { start: NEXT_MON, statusDate: SD },
    );
    const { project, notes } = combineProjects([first, { key: 'j2', project: later }]);
    expect(byId(project, 'j2/ip').constraint).toBeUndefined();
    expect(byId(project, 'j2/done').constraint).toBeUndefined();
    expect(notes.map((n) => n.id)).toEqual(['new']);
  });

  test('the floor date is a fresh Date, not the part’s own start', () => {
    const later = job([t('a', 1)], [], { start: NEXT_MON });
    const { project } = combineProjects([first, { key: 'j2', project: later }]);
    expect(byId(project, 'j2/a').constraint?.date).not.toBe(later.start);
    expect(byId(project, 'j2').start).not.toBe(later.start);
  });
});

describe('combineProjects: malformed input (review)', () => {
  test('a task with an unknown calendar falls back to its own part’s default', () => {
    const night: Calendar = {
      ...std,
      id: 'night',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 1200, endMinutes: 1440 }]), []],
    };
    const { project } = combineProjects([
      {
        key: 'n',
        project: job([t('x', 1)], [], { calendars: [night], defaultCalendarId: 'night' }),
      },
      { key: 'd', project: job([t('y', 1, { calendarId: 'missing' })]) },
    ]);
    expect(byId(project, 'd/y').calendarId).toBe('d/std');
  });

  test('a null parent is top level in its part', () => {
    const { project } = combineProjects([
      { key: 'j', project: job([t('a', 1, { parent: null as unknown as undefined })]) },
    ]);
    expect(byId(project, 'j/a').parent).toBe('j');
  });

  test('ids that collide once namespaced (1 and "1") throw', () => {
    expect(() => combineProjects([{ key: 'j', project: job([t(1, 1), t('1', 1)]) }])).toThrow(
      /j\/1/,
    );
  });

  test('no parts throws', () => {
    expect(() => combineProjects([])).toThrow(/at least one/i);
  });
});

describe('combineProjects: status date and baselines', () => {
  const SD = new Date(2026, 0, 7, 8);

  test('parts must agree on the status date unless options set one', () => {
    const a = job([t('a', 1)], [], { statusDate: SD });
    const b = job([t('b', 1)], [], { statusDate: new Date(2026, 0, 8, 8) });
    expect(
      combineProjects([
        { key: 'a', project: a },
        { key: 'c', project: a },
      ]).project.statusDate,
    ).toEqual(SD);
    expect(() =>
      combineProjects([
        { key: 'a', project: a },
        { key: 'b', project: b },
      ]),
    ).toThrow(/status date/i);
    const forced = combineProjects(
      [
        { key: 'a', project: a },
        { key: 'b', project: b },
      ],
      { statusDate: SD },
    );
    expect(forced.project.statusDate).toEqual(SD);
  });

  test('baselines are combined by index; a part without that index adds nothing', () => {
    const snap = { start: MON, end: MON, duration: DAY };
    const at = new Date(2026, 0, 1);
    const a = job([t('x', 1)], [], {
      baselines: [{ index: 0, name: 'Contract', capturedAt: at, tasks: new Map([['x', snap]]) }],
    });
    const b = job([t('y', 1)], [], {
      baselines: [{ index: 1, capturedAt: at, tasks: new Map([['y', snap]]) }],
    });
    const { project } = combineProjects([
      { key: 'a', project: a },
      { key: 'b', project: b },
    ]);
    expect(project.baselines.map((x) => [x.index, x.name, [...x.tasks.keys()]])).toEqual([
      [0, 'Contract', ['a/x']],
      [1, undefined, ['b/y']],
    ]);
  });
});

describe('combineProjects: optional cross-project links', () => {
  test('become ordinary links and drive the other job', () => {
    const { project, locate } = combineProjects(
      [
        { key: 'j1', project: job([t('slab', 3)]) },
        { key: 'j2', project: job([t('slab', 2)]) },
      ],
      {
        links: [
          {
            id: 'crew',
            from: { key: 'j1', id: 'slab' },
            to: { key: 'j2', id: 'slab' },
            type: 'FS',
            lag: 0,
          },
        ],
      },
    );
    expect(project.links).toContainEqual({
      id: 'x:crew',
      source: 'j1/slab',
      target: 'j2/slab',
      type: 'FS',
      lag: 0,
    });
    expect(locate('x:crew')).toBeUndefined();
    const s = schedule(project);
    expect(byId(s, 'j2/slab').start).toEqual(new Date(2026, 0, 8, 8));
  });

  test('an unknown end throws', () => {
    const parts = [{ key: 'j1', project: job([t('a', 1)]) }];
    const bad = {
      id: 'l',
      from: { key: 'j1', id: 'a' },
      to: { key: 'j1', id: 'zz' },
      type: 'FS' as const,
      lag: 0,
    };
    expect(() => combineProjects(parts, { links: [bad] })).toThrow(/j1\/zz/);
  });
});

describe('analyseCombined', () => {
  test('the programme finish, the critical path across jobs and each job’s float', () => {
    const combined = combineProjects([
      { key: 'short', name: 'Short job', project: job([t('a', 2)]) },
      { key: 'long', project: job([t('a', 3), t('b', 2)], [link('a', 'b')]) },
    ]);
    const scheduled = schedule(combined.project);
    const r = analyseCombined(scheduled, combined);
    expect(r.finish).toEqual(new Date(2026, 0, 9, 17));
    expect(r.criticalPath.map((c) => [c.key, c.id])).toEqual([
      ['long', 'a'],
      ['long', 'b'],
    ]);
    expect(r.criticalPath[0].task.id).toBe('long/a');
    expect(r.parts).toEqual([
      {
        key: 'short',
        name: 'Short job',
        start: MON,
        finish: new Date(2026, 0, 6, 17),
        totalSlack: 3 * DAY,
        driving: false,
      },
      {
        key: 'long',
        name: 'long',
        start: MON,
        finish: new Date(2026, 0, 9, 17),
        totalSlack: 0,
        driving: true,
      },
    ]);
  });

  test('a part with no scheduled tasks reports no dates', () => {
    const combined = combineProjects([
      { key: 'a', project: job([t('x', 1)]) },
      { key: 'empty', project: job([]) },
    ]);
    const r = analyseCombined(schedule(combined.project), combined);
    expect(r.parts[1]).toEqual({ key: 'empty', name: 'empty', driving: false });
  });

  test('complete tasks don’t count toward a job’s float', () => {
    const SD = new Date(2026, 0, 6, 8);
    const combined = combineProjects([
      {
        key: 'short',
        project: job([t('done', 1, { progress: 100, actualStart: MON }), t('next', 1)], [], {
          statusDate: SD,
        }),
      },
      { key: 'long', project: job([t('a', 5)], [], { statusDate: SD }) },
    ]);
    const r = analyseCombined(schedule(combined.project), combined);
    expect(r.parts[0]).toMatchObject({ key: 'short', driving: false });
    expect(r.parts[0].totalSlack).toBeGreaterThan(0);
  });

  test('a job’s own finish anchor is passed through', () => {
    const end = new Date(2026, 0, 7, 17);
    const combined = combineProjects([{ key: 'j', project: job([t('a', 5)], [], { end }) }]);
    const r = analyseCombined(schedule(combined.project), combined);
    expect(r.parts[0].end).toEqual(end);
    expect(r.parts[0].finish?.getTime()).toBeGreaterThan(end.getTime());
  });
});

describe('combined.toPart: a combined task back in its own job', () => {
  const PM_SNET = { type: 'SNET' as const, date: MON };
  const later = job(
    [
      t('s', 0, { type: 'summary' }),
      t('free', 1, { parent: 's', resourceIds: ['r'] }),
      t('raised', 1, { constraint: PM_SNET }),
      t('own', 1, { calendarId: 'std' }),
    ],
    [],
    { start: NEXT_MON, resources: [{ id: 'r', name: 'Crew' }] },
  );
  const combined = combineProjects([
    { key: 'j1', project: job([t('a', 1)]) },
    { key: 'j2', project: later },
  ]);
  const scheduled = schedule(combined.project);

  test('ids are un-namespaced and an injected floor is removed', () => {
    const back = combined.toPart(byId(scheduled, 'j2/free'));
    expect(back?.key).toBe('j2');
    expect(back?.task).toMatchObject({ id: 'free', parent: 's', resourceIds: ['r'] });
    expect(back?.task.constraint).toBeUndefined();
    expect(back?.task.calendarId).toBeUndefined();
    expect(back?.task.computed).toBeUndefined();
  });

  test('a raised SNET goes back to the PM’s own date; a top-level task has no parent', () => {
    const back = combined.toPart(byId(scheduled, 'j2/raised'));
    expect(back?.task.constraint).toEqual(PM_SNET);
    expect(back?.task.parent).toBeUndefined();
    expect(combined.toPart(byId(scheduled, 'j2/own'))?.task.calendarId).toBe('std');
  });

  test('a constraint the host set since is kept', () => {
    const pin = { type: 'SNET' as const, date: new Date(2026, 0, 20, 8) };
    const edited = { ...byId(scheduled, 'j2/free'), constraint: pin };
    expect(combined.toPart(edited)?.task.constraint).toEqual(pin);
    const cleared = { ...byId(scheduled, 'j2/free'), constraint: undefined };
    expect(combined.toPart(cleared)?.task.constraint).toBeUndefined();
  });

  test('dangling job-local references (a deleted parent or resource) round-trip, not throw', () => {
    const stale = job([t('a', 1, { parent: 'ghost' }), t('b', 1, { resourceIds: ['gone'] })], [], {
      start: NEXT_MON,
    });
    const c = combineProjects([
      { key: 'j1', project: job([t('x', 1)]) },
      { key: 'j2', project: stale },
    ]);
    const s = schedule(c.project);
    expect(c.toPart(byId(s, 'j2/a'))?.task.parent).toBe('ghost');
    expect(c.toPart(byId(s, 'j2/b'))?.task.resourceIds).toEqual(['gone']);
  });

  test('a summary row or unknown task gives undefined; a task moved into another job throws', () => {
    expect(combined.toPart(byId(scheduled, 'j2'))).toBeUndefined();
    expect(combined.toPart(t('new', 1))).toBeUndefined();
    const moved = { ...byId(scheduled, 'j2/free'), parent: 'j1' };
    expect(() => combined.toPart(moved)).toThrow(/j1/);
  });
});
