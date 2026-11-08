// Markers × SVAR's real store: SVAR's free store forces its own `markers` off, so
// the `markers` prop never drew; MarkersLayer draws them. Separate file: vi.mock is hoisted.
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';

type Row = { id: string | number; $x: number };
type Api = { getState(): { _tasks: Row[]; _markers?: unknown[] } };
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

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const at = (m: number, day: number, h = 8) => new Date(2026, m, day, h);
const t = (id: string, start: Date, days: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'manual',
  duration: days * 540,
  start,
  end: start,
  progress: 0,
});
const project: Project = {
  start: at(0, 5),
  defaultCalendarId: 'std',
  tasks: [t('a', at(0, 5), 2), t('b', at(0, 12), 3)],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};

describe('<Gantt markers>', () => {
  test('draws each marker in the chart area, at its date’s cell — where a bar starting then is', () => {
    const { container } = render(
      <Gantt
        project={project}
        markers={[
          { start: at(0, 12, 0), text: 'Inspection', variant: 'milestone' },
          { start: at(0, 5, 0), text: 'Today', variant: 'today' },
          { start: at(5, 1), text: 'Off the chart' },
        ]}
      />,
    );
    // SVAR's free store draws none itself.
    expect(captured.api?.getState()._markers ?? []).toHaveLength(0);
    const drawn = [
      ...container.querySelectorAll('.wx-area .construction-gantt-marker'),
    ] as HTMLElement[];
    expect(drawn.map((m) => m.textContent)).toEqual(['Inspection', 'Today']);
    expect(drawn[0]?.classList.contains('construction-gantt-marker-milestone')).toBe(true);
    expect(drawn[1]?.classList.contains('construction-gantt-marker-today')).toBe(true);
    const barX = (id: string) => captured.api?.getState()._tasks.find((r) => r.id === id)?.$x;
    expect(drawn[0]?.style.left).toBe(`${barX('b')}px`);
    expect(drawn[1]?.style.left).toBe(`${barX('a')}px`);
  });

  test('an empty markers list draws nothing', () => {
    const { container } = render(<Gantt project={project} markers={[]} />);
    expect(container.querySelector('.construction-gantt-marker')).toBeNull();
  });
});
