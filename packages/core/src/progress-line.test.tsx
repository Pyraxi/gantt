// Progress line (parity row 6, core) × SVAR's real store. Separate file: vi.mock is hoisted.
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';
import { progressLinePoints } from './progress-line.js';
import type { SvarScaleState } from './svar-adapter.js';

type Row = { id: string | number; $x: number; $w: number };
type Api = { getState(): SvarScaleState & { cellHeight: number; _tasks: Row[] } };
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

describe('progressLinePoints', () => {
  const state = {
    cellWidth: 10,
    cellHeight: 40,
    _scales: {
      start: new Date(2026, 0, 1),
      lengthUnit: 'day',
      diff: (a: Date, b: Date, _u: string, ceil?: boolean) => {
        const days = (a.getTime() - b.getTime()) / 86_400_000;
        return ceil ? Math.ceil(days) : Math.floor(days);
      },
    },
    _tasks: [{ id: 's' }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
  };
  const status = new Date(2026, 0, 11); // x = 100
  test('a peak per row that is off the line; rows on the line or without a point add none', () => {
    const line = progressLinePoints(
      state,
      new Map([
        ['a', new Date(2026, 0, 6)], // behind: x 50
        ['b', status], // on the line
        ['c', new Date(2026, 0, 13, 13)], // ahead, past midday: nearest edge = end of the 13th, x 130
      ]),
      status,
    );
    expect(line).toEqual({
      statusX: 100,
      height: 160,
      points: [
        [100, 0],
        [100, 40],
        [50, 60],
        [100, 80],
        [100, 120],
        [130, 140],
        [100, 160],
        [100, 160],
      ],
    });
  });
});

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const at = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, start: Date, days: number, progress: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'manual',
  duration: days * 540,
  start,
  end: start,
  progress,
});
const project: Project = {
  start: at(5),
  defaultCalendarId: 'std',
  tasks: [t('behind', at(5), 4, 25), t('ahead', at(6), 4, 75)],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
  statusDate: at(8),
};

describe('progressLinePoints edge cases', () => {
  const base = {
    cellWidth: 10,
    cellHeight: 40,
    _scales: {
      start: new Date(2026, 0, 1),
      lengthUnit: 'day',
      width: 300,
      diff: (a: Date, b: Date, _u: string, ceil?: boolean) => {
        const days = (a.getTime() - b.getTime()) / 86_400_000;
        return ceil ? Math.ceil(days) : Math.floor(days);
      },
    },
    _tasks: [{ id: 'a' }],
  };
  test('a status date off the timeline draws nothing (no sweeps across rows)', () => {
    const pts = new Map([['a', new Date(2026, 0, 3)]]);
    expect(progressLinePoints(base, pts, new Date(2026, 5, 1))).toBeNull();
    expect(progressLinePoints(base, pts, new Date(2025, 11, 1))).toBeNull();
  });
  test('morning snaps to the day’s start, afternoon to its end (the bar grid)', () => {
    const line = (h: number) => progressLinePoints(base, new Map(), new Date(2026, 0, 11, h));
    expect(line(8)?.statusX).toBe(100);
    expect(line(17)?.statusX).toBe(110);
  });
});

describe('<Gantt progressLine>', () => {
  test('draws in SVAR’s chart area, bending left for a task behind and right for one ahead', () => {
    const { container } = render(<Gantt project={project} progressLine />);
    const svg = container.querySelector('.wx-area > svg.construction-gantt-progress-line');
    expect(svg).not.toBeNull();
    const pts = (svg?.querySelector('polyline')?.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => p.split(',').map(Number));
    const statusX = pts[0]?.[0] ?? Number.NaN;
    const peaks = pts.filter(([x]) => x !== statusX).map(([x]) => x ?? 0);
    expect(peaks).toHaveLength(2);
    expect(peaks[0]).toBeLessThan(statusX); // behind
    expect(peaks[1]).toBeGreaterThan(statusX); // ahead
    // The behind task's point (25% of 4 days = 1 day in) lies within its own bar.
    const bar = captured.api?.getState()._tasks.find((r) => r.id === 'behind');
    expect(peaks[0]).toBeGreaterThan(bar?.$x ?? Number.POSITIVE_INFINITY);
    expect(peaks[0]).toBeLessThan((bar?.$x ?? 0) + (bar?.$w ?? 0));
  });

  test("basis 'physical' moves a point by physical % complete (P6)", () => {
    const peaksOf = (opts: true | { basis: 'physical' }) => {
      const { container } = render(
        <Gantt
          project={{
            ...project,
            // 'ahead' is 75% by duration but only 10% physically in place.
            tasks: project.tasks.map((x) =>
              x.id === 'ahead' ? { ...x, physicalProgress: 10 } : x,
            ),
          }}
          progressLine={opts}
        />,
      );
      const pts = (
        container
          .querySelector('.construction-gantt-progress-line polyline')
          ?.getAttribute('points') ?? ''
      )
        .split(' ')
        .map((p) => Number(p.split(',')[0]));
      cleanup();
      return pts;
    };
    const duration = peaksOf(true);
    const physical = peaksOf({ basis: 'physical' });
    expect(Math.max(...physical)).toBeLessThan(Math.max(...duration));
  });

  test('off by default, and nothing without a status date', () => {
    expect(
      render(<Gantt project={project} />).container.querySelector(
        '.construction-gantt-progress-line',
      ),
    ).toBeNull();
    cleanup();
    expect(
      render(
        <Gantt project={{ ...project, statusDate: undefined }} progressLine />,
      ).container.querySelector('.construction-gantt-progress-line'),
    ).toBeNull();
  });
});
