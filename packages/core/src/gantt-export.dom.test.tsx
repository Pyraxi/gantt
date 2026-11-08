// The export path CM calls: <Gantt ref>.exportPNG() hands the off-screen
// render the screen's view (effective toggles, zoom level, selection-based
// links). The PNG module is mocked to capture what it receives.
import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { Gantt, type GanttHandle } from './Gantt.js';

const exportPNG = vi.fn(async () => new Blob());
vi.mock('./export/png.js', () => ({ exportPNG }));

afterEach(cleanup);

const MON = new Date(2026, 0, 5, 8);
const t = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: MON,
  end: MON,
  progress: 0,
});
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [t('a'), t('b')],
  links: [{ id: 'a->b', source: 'a', target: 'b', type: 'FS', lag: 0 }],
  resources: [],
  calendars: [
    {
      id: 'std',
      name: 'Std',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
      exceptions: [],
    },
  ],
  baselines: [],
  assignments: [],
};

test('<Gantt ref>.exportPNG() renders the screen’s view', async () => {
  const ref = createRef<GanttHandle>();
  render(
    <Gantt
      ref={ref}
      project={project}
      zoom={{ levels: ['day', 'week'], default: 'week' }}
      showSlack={false}
      linkDisplay="selected"
      progressLine
    />,
  );
  await ref.current?.exportPNG();
  expect(exportPNG).toHaveBeenCalledTimes(1);
  const args = exportPNG.mock.calls[0]?.[0] as unknown as {
    scheduled: Project;
    ganttProps: Record<string, unknown>;
    themeVars: Record<string, string>;
  };
  expect(args.ganttProps).toMatchObject({
    zoom: { levels: ['day', 'week'], default: 'week' },
    showSlack: false,
    showCritical: true,
    linkDisplay: 'all',
    progressLine: true,
  });
  // Nothing selected on screen → no links, as on screen.
  expect(args.scheduled.links).toEqual([]);
  expect(typeof args.ganttProps.cellWidth).toBe('number');
  expect(args.themeVars).toBeTypeOf('object');
});
