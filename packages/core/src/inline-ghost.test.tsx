// Inline baseline ghosts × SVAR's real store (fix for the ~2.7× misplacement CM's
// inline draft shadow had). The ghost must land exactly where SVAR draws the same
// baseline as a phantom row — checked against the store's own `$x` / `$w`, at
// every zoom, so no browser is needed. Separate file: vi.mock is hoisted per file.
import { type Calendar, captureBaseline, type Project, type Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';
import { type SvarScaleState, svarBarEnd, svarGhostBox } from './svar-adapter.js';

type Row = { id: string | number; $x: number; $w: number };
type Api = { getState(): SvarScaleState & { _tasks: Row[] } };
const captured: { api?: Api } = {};

vi.mock('@svar-ui/react-gantt', async (orig) => {
  const mod = (await orig()) as Record<string, unknown> & { Gantt: unknown };
  const Wrapped = (props: { init?: (api: Api) => void }) =>
    createElement(mod.Gantt as never, {
      ...props,
      init: (api: Api) => {
        captured.api = api;
        props.init?.(api);
      },
    });
  return { ...mod, Gantt: Wrapped };
});

afterEach(() => {
  cleanup();
  captured.api = undefined;
});

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const task = (id: string, start: Date, days: number, extra: Partial<Task> = {}): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'manual',
  duration: days * 540,
  start,
  end: new Date(start.getTime() + days * 9 * 3_600_000),
  progress: 0,
  ...extra,
});
const at = (m: number, d: number, h = 8) => new Date(2026, m, d, h);

/** Baseline = the tasks at `before` dates; live = moved to `after`. */
function scenario(before: Task[], after: Task[]): Project {
  const base: Project = {
    start: at(0, 5),
    defaultCalendarId: 'std',
    tasks: before,
    links: [],
    resources: [],
    calendars: [cal],
    baselines: [],
    assignments: [],
  };
  return { ...captureBaseline(base, 0), tasks: after };
}

const zoomFor = (level: 'hour' | 'day' | 'week' | 'month') => ({
  levels: ['hour', 'day', 'week', 'month'] as const,
  default: level,
});

describe('svarGhostBox = where SVAR draws the baseline phantom row', () => {
  const cases: [string, 'hour' | 'day' | 'week' | 'month', Task[], Task[]][] = [
    [
      '1-day task, 30 days later, week zoom',
      'week',
      [task('a', at(0, 6), 1)],
      [task('a', at(1, 5), 1)],
    ],
    [
      'across a month boundary, month zoom',
      'month',
      [task('a', at(0, 20), 3)],
      [task('a', at(1, 16), 3)],
    ],
    [
      '3-day task, 2 days later, day zoom',
      'day',
      [task('a', at(0, 6), 3)],
      [task('a', at(0, 8), 3)],
    ],
    [
      'sub-day task, hour zoom',
      'hour',
      [task('a', at(0, 6, 9), 0.4)],
      [task('a', at(0, 6, 13), 0.4)],
    ],
  ];
  for (const [name, level, before, after] of cases) {
    test(name, () => {
      const p = scenario(before, after);
      render(<Gantt project={p} baselineIndices={[0]} zoom={zoomFor(level)} />);
      const state = captured.api?.getState();
      expect(state).toBeDefined();
      if (!state) return;
      const live = state._tasks.find((r) => r.id === 'a');
      const phantom = state._tasks.find((r) => r.id === 'a__baseline_0');
      expect(live && phantom).toBeTruthy();
      if (!live || !phantom) return;
      const snap = p.baselines[0]?.tasks.get('a');
      if (!snap) throw new Error('no snapshot');
      const box = svarGhostBox(
        state,
        { start: snap.start, end: svarBarEnd(snap.start, snap.end, snap.duration, cal) },
        live.$x,
      );
      expect(box).toEqual({ left: phantom.$x - live.$x, width: phantom.$w });
    });
  }
});

describe('<Gantt baselineRender="inline">', () => {
  test('a milestone with a baseline renders (no crash) and gets no ghost; a task gets one', () => {
    const p = scenario(
      [task('a', at(0, 6), 2), task('m', at(0, 9), 0, { type: 'milestone' })],
      [task('a', at(0, 7), 2), task('m', at(0, 12), 0, { type: 'milestone' })],
    );
    const { container } = render(
      <Gantt project={p} baselineIndices={[0]} baselineRender="inline" />,
    );
    const ghostOf = (id: string) =>
      container.querySelector(`.wx-bar[data-id=":${id}"] .construction-gantt-baseline-inline`);
    expect(container.querySelector('.wx-bar[data-id=":m"]')).not.toBeNull();
    expect(ghostOf('m')).toBeNull();
    const ghost = ghostOf('a') as HTMLElement | null;
    expect(ghost).not.toBeNull();
    // One day earlier at the default day zoom: one cell left (minus the 1 px border).
    const state = captured.api?.getState();
    const cell = state?.cellWidth ?? 0;
    expect(ghost?.style.left).toBe(`${-cell - 1}px`);
  });
});

describe('inline baselines widen the timeline (they are not task rows)', () => {
  test('a baseline earlier than the project start, or later than its end, stays on the chart', () => {
    // Rev C ran 6–8 Jan and 2–4 Mar; the live programme is all in February.
    const p = {
      ...scenario(
        [task('a', at(0, 6), 2), task('b', at(2, 2), 2)],
        [task('a', at(1, 9), 2), task('b', at(1, 11), 2)],
      ),
      start: at(1, 9),
    };
    render(<Gantt project={p} baselineIndices={[0]} baselineRender="inline" />);
    const s = captured.api?.getState()._scales as unknown as { start: Date; end: Date };
    expect(s.start.getTime()).toBeLessThanOrEqual(at(0, 6, 0).getTime());
    expect(s.end.getTime()).toBeGreaterThanOrEqual(at(2, 4, 0).getTime());
  });
});
