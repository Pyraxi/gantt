import type { Calendar, Link, Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { Gantt } from './Gantt';
import { filterLinksForDisplay } from './link-display';

// Parity row 14: links are never virtualized by SVAR (4,950 polylines at 5k
// tasks), so big schedules need a way to draw fewer. docs/parity/row14-profile.md

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const t = (id: string, days: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
});
const fs = (s: string, d: string): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type: 'FS',
  lag: 0,
});

// a(3) → c(1) is critical; b(1) → c has slack.
const project: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: [t('a', 3), t('b', 1), t('c', 1)],
  links: [fs('a', 'c'), fs('b', 'c')],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};

describe('filterLinksForDisplay', () => {
  const scheduled = schedule(project);
  const ids = (mode: Parameters<typeof filterLinksForDisplay>[2], sel?: string) =>
    filterLinksForDisplay(scheduled.links, scheduled.tasks, mode, sel ? [sel] : []).map(
      (l) => l.id,
    );

  test("'all' (and undefined) keep every link, same array", () => {
    expect(filterLinksForDisplay(scheduled.links, scheduled.tasks, 'all')).toBe(scheduled.links);
    expect(filterLinksForDisplay(scheduled.links, scheduled.tasks, undefined)).toBe(
      scheduled.links,
    );
  });

  test("'none' drops every link", () => {
    expect(ids('none')).toEqual([]);
  });

  test("'critical' keeps links whose both ends are critical", () => {
    expect(ids('critical')).toEqual(['a-c']);
  });

  test("'selected' keeps links touching the selected task; nothing selected → none", () => {
    expect(ids('selected', 'b')).toEqual(['b-c']);
    expect(ids('selected', 'c')).toEqual(['a-c', 'b-c']);
    expect(ids('selected')).toEqual([]);
  });

  test('ids compare as strings (SVAR hands numeric ids back as given)', () => {
    const numeric = schedule({
      ...project,
      tasks: [
        { ...t('1', 1), id: 1 },
        { ...t('2', 1), id: 2 },
      ],
      links: [{ id: 'x', source: 1, target: 2, type: 'FS', lag: 0 }],
    });
    expect(filterLinksForDisplay(numeric.links, numeric.tasks, 'selected', ['2'])).toHaveLength(1);
  });
});

describe('<Gantt linkDisplay>', () => {
  const count = (el: HTMLElement) => el.querySelectorAll('.wx-line').length;

  test("default draws every link; 'none' draws none; 'critical' draws the critical one", () => {
    const all = render(<Gantt project={project} />);
    expect(count(all.container)).toBe(2);
    all.unmount();
    const none = render(<Gantt project={project} linkDisplay="none" />);
    expect(count(none.container)).toBe(0);
    none.unmount();
    const crit = render(<Gantt project={project} linkDisplay="critical" />);
    expect(count(crit.container)).toBe(1);
    crit.unmount();
  });
});
