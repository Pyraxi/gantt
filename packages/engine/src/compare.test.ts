import { describe, expect, test } from 'vitest';
import { getTaskBaselineVarianceAll } from './baseline';
import { baselineFrom, compareSchedules } from './compare';
import { schedule } from './schedule';
import type { Calendar, Link, Project, Task } from './types';

// Parity row 9b. Spec: docs/superpowers/specs/2026-10-16-compare-schedules-design.md

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
  type: 'task',
  scheduleMode: 'auto',
  duration: days * DAY,
  start: MON,
  end: MON,
  progress: 0,
  ...extra,
});
const link = (
  s: string,
  d: string,
  type: Link['type'] = 'FS',
  lagDays = 0,
  id = `${s}-${d}`,
): Link => ({
  id,
  source: s,
  target: d,
  type,
  lag: lagDays * DAY,
});
const project = (tasks: Task[], links: Link[]): Project => ({
  start: MON,
  defaultCalendarId: 'std',
  tasks,
  links,
  resources: [],
  calendars: [std],
  baselines: [],
  assignments: [],
});

const before = () => project([t('a', 3), t('b', 2), t('c', 1)], [link('a', 'b'), link('b', 'c')]);

describe('compareSchedules', () => {
  test('identical schedules → no changes', () => {
    const r = compareSchedules(before(), before());
    expect(r.tasks).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.summary).toMatchObject({ added: 0, removed: 0, moved: 0, logicChanged: 0 });
    expect(r.summary.finish.delta).toBe(0);
  });

  test('a longer task moves its successors; deltas are signed working minutes', () => {
    const after = project([t('a', 5), t('b', 2), t('c', 1)], before().links);
    const r = compareSchedules(before(), after);
    const a = r.tasks.find((x) => x.id === 'a');
    expect(a).toMatchObject({ kind: 'changed', changes: { duration: { delta: 2 * DAY } } });
    expect(a?.changes?.start).toBeUndefined();
    const b = r.tasks.find((x) => x.id === 'b');
    expect(b?.changes?.start?.delta).toBe(2 * DAY);
    expect(b?.changes?.finish?.delta).toBe(2 * DAY);
    expect(r.summary).toMatchObject({ moved: 3, durationChanged: 1 });
    expect(r.summary.finish.delta).toBe(2 * DAY);
  });

  test('added and removed tasks; removed listed last', () => {
    const after = project([t('a', 3), t('b', 2), t('n', 1)], [link('a', 'b')]);
    const r = compareSchedules(before(), after);
    expect(r.tasks.map((x) => [x.id, x.kind])).toEqual([
      ['n', 'added'],
      ['c', 'removed'],
    ]);
    expect(r.summary).toMatchObject({ added: 1, removed: 1 });
  });

  test('links match by predecessor → successor, not id; type and lag changes are reported', () => {
    const after = project(before().tasks, [
      link('a', 'b', 'FS', 0, 'NEW-ID'),
      link('b', 'c', 'SS', 1),
    ]);
    const r = compareSchedules(before(), after);
    expect(r.links).toEqual([
      {
        source: 'b',
        target: 'c',
        kind: 'changed',
        changes: { type: { from: 'FS', to: 'SS' }, lag: { from: 0, to: DAY } },
      },
    ]);
    expect(r.summary.logicChanged).toBe(1);
  });

  test('added and removed links', () => {
    const after = project(before().tasks, [link('a', 'b'), link('a', 'c')]);
    const r = compareSchedules(before(), after);
    expect(r.links.map((l) => [l.source, l.target, l.kind])).toEqual([
      ['a', 'c', 'added'],
      ['b', 'c', 'removed'],
    ]);
  });

  test('criticality and float changes', () => {
    // Before: c hangs off b (critical). After: c is independent → float.
    const after = project(before().tasks, [link('a', 'b')]);
    const r = compareSchedules(before(), after);
    const c = r.tasks.find((x) => x.id === 'c');
    expect(c?.changes?.critical).toEqual({ from: true, to: false });
    expect(c?.changes?.totalFloat?.delta).toBeGreaterThan(0);
    expect(r.summary.noLongerCritical).toBe(1);
  });

  test('name, progress, constraint and parent changes', () => {
    const after = project(
      [
        t('a', 3, { text: 'Excavate' }),
        t('b', 2, { progress: 50, physicalProgress: 30 }),
        t('c', 1, { constraint: { type: 'SNET', date: new Date(2026, 0, 20, 8) } }),
      ],
      before().links,
    );
    const r = compareSchedules(before(), after);
    const by = Object.fromEntries(r.tasks.map((x) => [x.id, x.changes]));
    expect(by.a?.name).toEqual({ from: 'a', to: 'Excavate' });
    expect(by.b?.progress).toEqual({ from: 0, to: 50 });
    expect(by.b?.physicalProgress).toEqual({ from: undefined, to: 30 });
    expect(by.c?.constraint?.to).toMatchObject({ type: 'SNET' });
  });

  test('planned-date mode compares start/end instead of computed dates', () => {
    const b0 = project(
      [t('m', 1, { scheduleMode: 'manual', start: MON, end: new Date(2026, 0, 5, 17) })],
      [],
    );
    const b1 = project(
      [
        t('m', 1, {
          scheduleMode: 'manual',
          start: new Date(2026, 0, 6, 8),
          end: new Date(2026, 0, 6, 17),
        }),
      ],
      [],
    );
    const r = compareSchedules(b0, b1, { dates: 'planned' });
    expect(r.tasks[0]?.changes?.start?.delta).toBe(DAY);
  });

  test('does not mutate its inputs', () => {
    const b = before();
    const snapshot = JSON.stringify(b);
    compareSchedules(b, before());
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});

describe('compareSchedules — review fixes', () => {
  test('a task that becomes unscheduled is reported as such, not as a move', () => {
    const after = project(
      [
        t('a', 3),
        t('b', 2, { unscheduled: true, start: new Date(2020, 0, 1), end: new Date(2020, 0, 1) }),
        t('c', 1),
      ],
      before().links,
    );
    const b = compareSchedules(before(), after).tasks.find((x) => x.id === 'b');
    expect(b?.changes?.unscheduled).toEqual({ from: false, to: true });
    expect(b?.changes?.start).toBeUndefined();
    expect(b?.changes?.critical).toBeUndefined();
  });

  test('duplicate links between the same pair are matched by type', () => {
    const b0 = project(before().tasks, [link('a', 'b'), link('a', 'b', 'SS', 1, 'a-b-ss')]);
    const b1 = project(before().tasks, [link('a', 'b', 'SS', 1, 'a-b-ss')]);
    const r = compareSchedules(b0, b1);
    expect(r.links).toEqual([{ source: 'a', target: 'b', kind: 'removed', type: 'FS' }]);
  });

  test("planned mode reads the inputs' own dates even when they need scheduling", () => {
    const b1 = project(
      [t('a', 3), t('b', 2, { start: new Date(2026, 0, 20, 8) }), t('c', 1)],
      before().links,
    );
    const r = compareSchedules(before(), b1, { dates: 'planned' });
    expect(r.tasks.find((x) => x.id === 'b')?.changes?.start).toBeDefined();
  });

  test('deltas use each task’s own calendar', () => {
    const seven: Calendar = {
      id: '7d',
      name: '7 day',
      workWeek: Array(7).fill([{ startMinutes: 480, endMinutes: 1020 }]),
      exceptions: [],
    };
    const mk = (startDay: number) =>
      ({
        ...project(
          [
            t('w', 1, {
              scheduleMode: 'manual',
              calendarId: '7d',
              start: new Date(2026, 0, startDay, 8),
              end: new Date(2026, 0, startDay, 17),
            }),
          ],
          [],
        ),
        calendars: [std, seven],
      }) as Project;
    // Sat 10 → Sun 11: a real day's move on a 7-day calendar.
    const r = compareSchedules(mk(10), mk(11));
    expect(r.tasks[0]?.changes?.start?.delta).toBe(DAY);
  });

  test('actuals and status changes are reported; completing a task is not "no longer critical"', () => {
    const status = { statusDate: new Date(2026, 0, 6, 8) };
    const b0 = { ...before(), ...status };
    const b1 = {
      ...project(
        [
          t('a', 3, { progress: 100, actualStart: MON, actualFinish: new Date(2026, 0, 5, 17) }),
          t('b', 2),
          t('c', 1),
        ],
        before().links,
      ),
      ...status,
    };
    const r = compareSchedules(b0, b1);
    const a = r.tasks.find((x) => x.id === 'a');
    expect(a?.changes?.actualFinish?.to).toEqual(new Date(2026, 0, 5, 17));
    expect(a?.changes?.status).toEqual({ from: 'not-started', to: 'complete' });
    expect(r.summary.noLongerCritical).toBe(0);
  });

  test('explicit ASAP vs no constraint, and undefined vs 0 lag, are not changes', () => {
    const b1 = project(
      before().tasks.map((x) => ({ ...x, constraint: { type: 'ASAP' as const } })),
      before().links.map((l) => ({ ...l, lag: undefined as unknown as number })),
    );
    const r = compareSchedules(before(), b1);
    expect(r.tasks).toEqual([]);
    expect(r.links).toEqual([]);
  });

  test('output dates are copies, not the inputs’ Date objects', () => {
    const b0 = before();
    const after = project([t('a', 5), t('b', 2), t('c', 1)], b0.links);
    const r = compareSchedules(b0, after);
    const f = r.tasks.find((x) => x.id === 'a')?.changes?.finish;
    f?.from.setFullYear(1999);
    expect(
      compareSchedules(b0, after)
        .tasks.find((x) => x.id === 'a')
        ?.changes?.finish?.from.getFullYear(),
    ).toBe(2026);
  });

  test('type changes, task names, and summaries excluded from the summary counts', () => {
    const b0 = project(
      [t('s', 0, { type: 'summary' }), t('a', 3, { parent: 's' }), t('b', 2, { parent: 's' })],
      [link('a', 'b')],
    );
    const b1 = project(
      [
        t('s', 0, { type: 'summary' }),
        t('a', 6, { parent: 's' }),
        t('b', 0, { parent: 's', type: 'milestone' }),
      ],
      [link('a', 'b')],
    );
    const r = compareSchedules(b0, b1);
    const b = r.tasks.find((x) => x.id === 'b');
    expect(b?.changes?.type).toEqual({ from: 'task', to: 'milestone' });
    expect(b?.text).toBe('b');
    expect(r.tasks.find((x) => x.id === 's')?.isSummary).toBe(true);
    expect(r.summary.moved).toBe(2); // a and b; not the summary
  });

  test('a removed task carries its name', () => {
    const r = compareSchedules(before(), project([t('a', 3), t('b', 2)], [link('a', 'b')]));
    expect(r.tasks.find((x) => x.kind === 'removed')).toMatchObject({ id: 'c', text: 'c' });
  });

  test('reschedule: true ignores stale computed values', () => {
    const s0 = schedule(before());
    const stale = {
      ...s0,
      tasks: s0.tasks.map((x) => (x.id === 'a' ? { ...x, duration: 5 * DAY } : x)),
    };
    expect(
      compareSchedules(s0, stale).tasks.find((x) => x.id === 'b')?.changes?.start,
    ).toBeUndefined();
    expect(
      compareSchedules(s0, stale, { reschedule: true }).tasks.find((x) => x.id === 'b')?.changes
        ?.start,
    ).toBeDefined();
  });
});

describe('baselineFrom (compare overlay: `before` as ghost bars)', () => {
  // Rev C: a(2) → b(3). Rev D: a slipped to 4 days.
  const before = project([t('a', 2), t('b', 3)], [link('a', 'b')]);
  const after = project([t('a', 4), t('b', 3), t('c', 1)], [link('a', 'b')]);

  test("snapshots `before`'s forecast (scheduling it), so after's variance is the revision delta", () => {
    const rev = baselineFrom(before, 3, { name: 'Rev C', capturedAt: MON });
    expect(rev).toMatchObject({ index: 3, name: 'Rev C', capturedAt: MON });
    expect(rev.tasks.get('b')).toEqual({
      start: new Date(2026, 0, 7, 8),
      end: new Date(2026, 0, 9, 17),
      duration: 3 * DAY,
    });
    const shown = schedule({ ...after, baselines: [rev] });
    const v = getTaskBaselineVarianceAll(shown, 3);
    expect(v.get('b')).toEqual({
      startVariance: 2 * DAY,
      finishVariance: 2 * DAY,
      durationVariance: 0,
    });
    expect(v.get('a')?.finishVariance).toBe(2 * DAY);
    expect(v.has('c')).toBe(false); // added in Rev D: no ghost
  });

  test('agrees with compareSchedules on every moved task', () => {
    const rev = baselineFrom(before, 0);
    const v = getTaskBaselineVarianceAll(schedule({ ...after, baselines: [rev] }), 0);
    for (const entry of compareSchedules(before, after).tasks) {
      if (entry.kind !== 'changed') continue;
      if (entry.start) expect(v.get(entry.id)?.startVariance).toBe(entry.start.delta);
      if (entry.finish) expect(v.get(entry.id)?.finishVariance).toBe(entry.finish.delta);
    }
  });

  test('pure: never mutates `before`; unscheduled tasks are left out; dates are copies', () => {
    const b = project([t('a', 2), t('u', 1, { unscheduled: true })], []);
    const snapshot = JSON.stringify(b);
    const rev = baselineFrom(b, 1);
    expect(JSON.stringify(b)).toBe(snapshot);
    expect(rev.tasks.has('u')).toBe(false);
    const scheduled = schedule(b);
    const again = baselineFrom(scheduled, 1);
    expect(again.tasks.get('a')?.start).not.toBe(scheduled.tasks[0]?.start);
    expect(again.tasks.get('a')?.start).toEqual(scheduled.tasks[0]?.start);
  });

  test('an already-scheduled project with an empty summary is snapshotted as given, not re-scheduled', () => {
    const scheduled = schedule(project([t('s', 0, { type: 'summary' }), t('a', 2)], []));
    // Hand-edit the forecast: a re-schedule would undo it.
    const edited = {
      ...scheduled,
      tasks: scheduled.tasks.map((x) =>
        x.id === 'a' ? { ...x, start: new Date(2026, 0, 6, 8) } : x,
      ),
    };
    expect(baselineFrom(edited, 0).tasks.get('a')?.start).toEqual(new Date(2026, 0, 6, 8));
  });

  test("dates: 'planned' snapshots the input's own start / end without scheduling", () => {
    const planned = project(
      [t('a', 2, { start: new Date(2026, 1, 2, 8), end: new Date(2026, 1, 3, 17) })],
      [],
    );
    expect(baselineFrom(planned, 0, { dates: 'planned' }).tasks.get('a')?.start).toEqual(
      new Date(2026, 1, 2, 8),
    );
  });
});
