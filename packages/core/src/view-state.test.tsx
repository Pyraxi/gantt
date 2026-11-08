// Parity row 15 (view-state persistence): onViewStateChange reports the user's
// displayOptions toggles + zoom level so a host can persist them, and the
// reported shape round-trips straight back in via `displayOptions.defaults` +
// `zoom.default`. Never fires on mount — only on user change.

import type { Calendar, Project } from '@pyraxi/cpm-engine';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt, type GanttViewState, zoomLevelAt } from './Gantt.js';

afterEach(cleanup);

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

function checkbox(label: string, root: HTMLElement): HTMLInputElement {
  const l = [...root.querySelectorAll('label')].find((x) => x.textContent === label);
  return l?.querySelector('input') as HTMLInputElement;
}

describe('onViewStateChange', () => {
  test('does not fire on mount', () => {
    const spy = vi.fn();
    render(<Gantt project={project} displayOptions onViewStateChange={spy} />);
    expect(spy).not.toHaveBeenCalled();
  });

  test('column toggle reports hiddenColumns + current signals', () => {
    const spy = vi.fn();
    const { container } = render(
      <Gantt project={project} displayOptions onViewStateChange={spy} />,
    );
    fireEvent.click(checkbox('Start', container));
    expect(spy).toHaveBeenCalledTimes(1);
    const state = spy.mock.calls[0]?.[0] as GanttViewState;
    expect(state.hiddenColumns).toEqual(['start']);
    expect(state).toMatchObject({ critical: true, slack: true, deadline: true });
  });

  test('signal toggle reports the new signal value', () => {
    const spy = vi.fn();
    const { container } = render(
      <Gantt project={project} displayOptions onViewStateChange={spy} />,
    );
    fireEvent.click(checkbox('Critical', container));
    expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ critical: false, hiddenColumns: [] });
  });

  test('a reported state restores via displayOptions.defaults (round-trip)', () => {
    const saved: GanttViewState = {
      hiddenColumns: ['start'],
      critical: false,
      slack: true,
      deadline: true,
    };
    const { container } = render(<Gantt project={project} displayOptions={{ defaults: saved }} />);
    expect(checkbox('Start', container).checked).toBe(false);
    expect(checkbox('Critical', container).checked).toBe(false);
  });
});

describe('zoomLevelAt — SVAR zoom index → our level name', () => {
  test('maps an index into the configured levels', () => {
    expect(zoomLevelAt({ levels: ['day', 'week', 'month'] }, 1)).toBe('week');
  });
  test('falls back to the default level set when none configured (SVAR order: coarse → fine)', () => {
    expect(zoomLevelAt({}, 0)).toBe('month');
    expect(zoomLevelAt({}, 2)).toBe('day');
  });
  test('out of range → undefined', () => {
    expect(zoomLevelAt({ levels: ['day'] }, 3)).toBeUndefined();
    expect(zoomLevelAt({ levels: ['day'] }, -1)).toBeUndefined();
  });
});

test('with zoom configured, a toggle reports the configured default level', () => {
  const spy = vi.fn();
  const { container } = render(
    <Gantt
      project={project}
      displayOptions
      zoom={{ levels: ['day', 'week', 'month'], default: 'week' }}
      onViewStateChange={spy}
    />,
  );
  fireEvent.click(checkbox('Critical', container));
  expect(spy.mock.calls.at(-1)?.[0]).toMatchObject({ zoom: 'week' });
});
