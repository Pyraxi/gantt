// SVAR's grid focuses its table box on mousedown. Without preventScroll the
// browser scrolls the page when the box runs past the viewport, so the second
// click of a double-click lands on another row and opens that task's editor
// (CM, to-gantt 2026-11-09).
import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MON = new Date(2026, 0, 5, 8);
const t = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 480,
  start: MON,
  end: MON,
  progress: 0,
});
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [t('a'), t('b')],
  links: [],
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

test('a mousedown in the grid focuses its table box without scrolling the page', () => {
  const { container } = render(<Gantt project={project} editMode />);
  const focus = vi.spyOn(HTMLElement.prototype, 'focus');
  const body = container.querySelector('.wx-table-box .wx-body');
  expect(body).not.toBeNull();
  body?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  const boxCalls = focus.mock.contexts
    .map((el, i) => [el, focus.mock.calls[i]?.[0]] as const)
    .filter(([el]) => (el as Element).classList?.contains('wx-table-box'));
  expect(boxCalls.length).toBeGreaterThan(0);
  for (const [, options] of boxCalls) expect(options).toMatchObject({ preventScroll: true });
});
