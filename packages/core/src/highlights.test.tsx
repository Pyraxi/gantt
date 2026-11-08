import type { Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Gantt } from './Gantt';
import { buildHighlightCss } from './highlights';

// Parity row 11 (core). Spec: docs/superpowers/specs/2026-10-16-task-highlights-design.md

afterEach(cleanup);

describe('buildHighlightCss', () => {
  test('rings bars and tints grid rows, per set, in order; only the id form SVAR renders', () => {
    const css =
      buildHighlightCss([{ taskIds: ['a', 7] }, { taskIds: ['b'], color: '#dc2626' }], 'scope') ??
      '';
    const [first, second] = css.split('\n');
    expect(first).toContain('.scope .wx-bar.wx-bar[data-id=":a"]');
    expect(first).toContain('.scope .wx-bar.wx-bar[data-id="7"]');
    expect(first).toContain('.scope .wx-row[data-id=":a"]');
    expect(first).toContain('var(--cg-highlight-color,#f59e0b)');
    expect(first).not.toContain('data-id=":7"');
    expect(css).toContain('#dc2626');
    // Later sets come later in the sheet, so they win where a task is in both.
    expect(css.indexOf('#dc2626')).toBeGreaterThan(css.indexOf('--cg-highlight-color'));
    expect(second).toContain('data-id=":b"');
  });

  test('empty or absent → null', () => {
    expect(buildHighlightCss(undefined, 's')).toBeNull();
    expect(buildHighlightCss([], 's')).toBeNull();
    expect(buildHighlightCss([{ taskIds: [] }], 's')).toBeNull();
  });
});

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

describe('<Gantt highlights>', () => {
  test('injects the scoped sheet; none without highlights', () => {
    const sheet = (root: HTMLElement) =>
      [...root.querySelectorAll('style')]
        .map((s) => s.textContent ?? '')
        .find((c) => c.includes('--cg-highlight-color'));
    const { container } = render(<Gantt project={project} highlights={[{ taskIds: ['a'] }]} />);
    expect(sheet(container)).toContain('data-id=":a"');
    cleanup();
    expect(sheet(render(<Gantt project={project} />).container)).toBeUndefined();
  });
});
