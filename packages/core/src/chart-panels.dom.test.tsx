// chartPanels: host-drawn strips under the chart on SVAR's timescale (ADR-012).
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChartPanelContext } from './chart-panels.js';
import { Gantt } from './Gantt.js';
import { cellX, type OverlayState } from './svar-overlay.js';

type Api = { getState(): OverlayState };
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
  name: 'Std',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const MON = new Date(2026, 0, 5, 8);
const task: Task = {
  id: 'A',
  text: 'A',
  type: 'task',
  scheduleMode: 'auto',
  duration: 3 * 540,
  start: MON,
  end: MON,
  progress: 0,
};
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [task],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};

test('each panel renders under the chart with the scheduled project, timeline width and SVAR x', () => {
  const seen: ChartPanelContext[] = [];
  const { container } = render(
    <Gantt
      project={project}
      chartPanels={[
        {
          id: 'one',
          label: 'Weather',
          height: 40,
          render: (ctx) => {
            seen.push(ctx);
            return <svg className="probe" width={ctx.width} height={ctx.height} />;
          },
        },
        { id: 'two', label: (p) => `${p.tasks.length} tasks`, render: () => null },
      ]}
    />,
  );
  const panels = [...container.querySelectorAll('.construction-gantt-chart-panel')];
  expect(panels.map((p) => p.getAttribute('data-panel-id'))).toEqual(['one', 'two']);
  expect(panels[0]?.textContent).toContain('Weather');
  expect(panels[1]?.textContent).toContain('1 tasks');
  expect((panels[0] as HTMLElement).style.height).toBe('40px');
  const ctx = seen.at(-1) as ChartPanelContext;
  // The scheduled project (computed filled in), not the raw input.
  expect(ctx.project.tasks[0]?.computed?.earlyStart).toEqual(MON);
  const state = captured.api?.getState() as OverlayState;
  expect(ctx.width).toBe(state._scales.width);
  const tue = new Date(2026, 0, 6);
  expect(ctx.xOf(tue)).toBe(cellX(state, tue, 'start'));
  expect(ctx.xOf(tue, 'nearest')).toBe(cellX(state, tue, 'nearest'));
  expect(container.querySelector('.probe')?.getAttribute('width')).toBe(
    String(state._scales.width),
  );
});

test('none by default', () => {
  const { container } = render(<Gantt project={project} />);
  expect(container.querySelector('.construction-gantt-chart-panel')).toBeNull();
});
