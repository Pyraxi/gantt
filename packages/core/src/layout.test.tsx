// Layout structure tests: flex-column chrome container + `footer` slot
// (configurable-chrome Task 4). Full-DOM SVAR mount emits benign
// `wx-icons.css` fetch noise under happy-dom (known, per test-strategy
// memory) — assertions here only touch our own footer node, which renders
// outside SVAR's canvas regardless of that noise.

import type { Calendar, Project } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Gantt } from './Gantt.js';

// This suite's own repo has no global `afterEach`/cleanup wiring (vitest.config.ts
// doesn't set `globals: true`, so @testing-library/react's auto-cleanup-on-afterEach
// never registers). Without explicit cleanup, `render()`'s bound queries search
// `document.body`, which accumulates DOM across tests in this file and makes the
// "footer absent" test see the previous test's footer. Reset the DOM between tests.
afterEach(cleanup);

// Same shape as Gantt.test.tsx's `standardCalendar` fixture — a real
// calendar is required or `schedule()` throws ("default calendar not found")
// before the component ever gets to render the chrome/footer.
const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

const project: Project = {
  start: new Date(2026, 0, 5, 8, 0),
  defaultCalendarId: 'std',
  tasks: [
    {
      id: 'a',
      text: 'A',
      type: 'task',
      scheduleMode: 'auto',
      duration: 540,
      start: new Date(2026, 0, 5, 8, 0),
      end: new Date(2026, 0, 5, 17, 0),
      progress: 0,
    },
  ],
  links: [],
  resources: [],
  calendars: [standardCalendar],
  baselines: [],
  assignments: [],
};

describe('Gantt layout', () => {
  test('renders footer content when footer prop is passed', () => {
    const { getByText } = render(<Gantt project={project} footer={<span>PYRAXI_FOOTER</span>} />);
    expect(getByText('PYRAXI_FOOTER')).toBeTruthy();
  });

  test('no footer prop → footer text absent', () => {
    const { queryByText } = render(<Gantt project={project} />);
    expect(queryByText('PYRAXI_FOOTER')).toBeNull();
  });
});

// `project`'s single task has no predecessors/successors, so it is trivially
// critical (totalSlack = 0 against the project's own end) — no extra fixture
// wiring needed to exercise the critical-signal CSS path.
describe('Gantt signal-visibility props', () => {
  test('default (showCritical unset): critical signal CSS token is present', () => {
    const { container } = render(<Gantt project={project} />);
    const styles = [...container.querySelectorAll('style')]
      .map((s) => s.textContent ?? '')
      .join('');
    // Real token emitted by buildSignalCss (svar-adapter.ts) for a critical task —
    // asserting the exact string keeps this discriminating against a no-op wiring.
    expect(styles).toContain('--wx-gantt-task-fill-color:#de3a3a');
  });

  test('showCritical=false removes the critical signal CSS token', () => {
    const { container } = render(<Gantt project={project} showCritical={false} />);
    const styles = [...container.querySelectorAll('style')]
      .map((s) => s.textContent ?? '')
      .join('');
    expect(styles).not.toContain('--wx-gantt-task-fill-color:#de3a3a');
  });
});

describe('Gantt displayOptions bar', () => {
  test('displayOptions renders the control bar with column + signal checkboxes', () => {
    const { getByText, getAllByRole } = render(<Gantt project={project} displayOptions editMode />);
    expect(getByText('Critical')).toBeTruthy();
    expect(getByText('Float/Slack')).toBeTruthy();
    expect(getAllByRole('checkbox').length).toBeGreaterThan(0);
  });
});
