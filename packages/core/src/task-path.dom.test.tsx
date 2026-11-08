// Parity row 5 (core): <Gantt taskPath> injects the scoped Task Path stylesheet.
import type { Link, Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Gantt } from './Gantt';

afterEach(cleanup);

const MON = new Date(2026, 0, 5, 8);
const t = (id: string, days: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * 540,
  start: MON,
  end: MON,
  progress: 0,
});
const link = (s: string, d: string): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type: 'FS',
  lag: 0,
});
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [t('a', 3), t('b', 1), t('c', 2), t('e', 1)],
  links: [link('a', 'c'), link('b', 'c'), link('c', 'e')],
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
const pathCss = (root: HTMLElement): string | undefined =>
  [...root.querySelectorAll('style')]
    .map((s) => s.textContent ?? '')
    .find((c) => c.includes('--cg-path-'));

describe('<Gantt taskPath>', () => {
  test('taskPathFor highlights that task’s drivers and driven successors', async () => {
    const { container } = render(<Gantt project={project} taskPath="both" taskPathFor="c" />);
    const css = pathCss(container) ?? '';
    expect(css).toContain('[data-id=":a"]');
    expect(css).toContain('[data-id=":e"]');
    expect(css).not.toContain('data-id=":b"');
    // Links are painted inline, including at mount (the links <svg> arrives later).
    await waitFor(() =>
      expect(
        (container.querySelector('.wx-line[data-link-id=":a-c"]') as SVGElement | null)?.style
          .stroke,
      ).toContain('--cg-path-driving-color'),
    );
    const bc = container.querySelector('.wx-line[data-link-id=":b-c"]') as SVGElement | null;
    expect(bc?.style.stroke ?? '').toBe('');
    // Scoped to this instance.
    const scope = [...(container.querySelector('[class*="cg-scope-"]')?.classList ?? [])].find(
      (c) => c.startsWith('cg-scope-'),
    );
    expect(scope).toBeDefined();
    expect(css.startsWith(`.${scope} `)).toBe(true);
  });

  test('off by default; and nothing selected → no stylesheet', () => {
    expect(pathCss(render(<Gantt project={project} taskPathFor="c" />).container)).toBeUndefined();
    cleanup();
    expect(pathCss(render(<Gantt project={project} taskPath="both" />).container)).toBeUndefined();
  });
});
