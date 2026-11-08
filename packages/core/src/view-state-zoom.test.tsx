// onViewStateChange × SVAR's real zoom store (review of 0112925). The SVAR api is
// captured by wrapping @svar-ui/react-gantt's Gantt `init` — the store and the
// `zoom-scale` action are the real ones, so this covers the zoom path without a
// browser. Separate file because vi.mock is hoisted per file.

import type { Calendar, Project } from '@pyraxi/cpm-engine';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement, StrictMode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt, type GanttViewState } from './Gantt.js';

type Api = {
  exec(action: string, ev: unknown): unknown;
  getState(): { zoom?: { level?: number } };
};
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

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const cal: Calendar = {
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
  calendars: [cal],
  baselines: [],
  assignments: [],
};
const LEVELS = ['day', 'week', 'month'] as const;
/** SVAR's level index runs coarse → fine (zoom-in = index + 1). */
const SVAR_ORDER = ['month', 'week', 'day'] as const;

function api(): Api {
  if (!captured.api) throw new Error('SVAR api not captured (init did not run)');
  return captured.api;
}
const level = () => api().getState().zoom?.level ?? -1;
/** Wheel-zoom (SVAR's zoom-scale) until the named level changes. */
function zoomUntilLevelChanges(dir: 1 | -1) {
  const start = level();
  for (let i = 0; i < 40 && level() === start; i++) api().exec('zoom-scale', { dir });
  expect(level()).not.toBe(start);
}
function checkbox(label: string, root: HTMLElement): HTMLInputElement {
  const l = [...root.querySelectorAll('label')].find((x) => x.textContent === label);
  return l?.querySelector('input') as HTMLInputElement;
}
const view = (spy: ReturnType<typeof vi.fn>) =>
  (spy.mock.calls.at(-1)?.[0] ?? {}) as Partial<GanttViewState>;

describe('zoom reporting against the live SVAR store', () => {
  const props = (spy: ReturnType<typeof vi.fn>) => ({
    project,
    displayOptions: true,
    onViewStateChange: spy,
    // inline literal each render — exactly how CM passes it
    zoom: { levels: [...LEVELS], default: 'week' as const },
  });

  test('a level-changing wheel zoom reports the new live level', () => {
    const spy = vi.fn();
    render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(1);
    expect(view(spy).zoom).toBe(SVAR_ORDER[level()]);
  });

  test('a host re-render with identical props does not reset SVAR zoom', () => {
    const spy = vi.fn();
    const { rerender } = render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(1);
    const zoomed = level();
    rerender(<Gantt {...props(spy)} />);
    expect(level()).toBe(zoomed);
  });

  test('after a re-render, a toggle reports the live zoom (not a cached one)', () => {
    const spy = vi.fn();
    const { rerender, container } = render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(1);
    rerender(<Gantt {...props(spy)} />);
    fireEvent.click(checkbox('Critical', container));
    expect(view(spy).zoom).toBe(SVAR_ORDER[level()]);
  });

  test('zooming back to a previously-reported level still emits', () => {
    const spy = vi.fn();
    render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(1);
    zoomUntilLevelChanges(-1);
    zoomUntilLevelChanges(1);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(view(spy).zoom).toBe(SVAR_ORDER[level()]);
  });

  test('a host-applied zoom.default (async saved-view restore) is what the next toggle reports', () => {
    const spy = vi.fn();
    const { rerender, container } = render(<Gantt {...props(spy)} />);
    rerender(<Gantt {...props(spy)} zoom={{ levels: [...LEVELS], default: 'month' }} />);
    expect(SVAR_ORDER[level()]).toBe('month');
    fireEvent.click(checkbox('Critical', container));
    expect(view(spy).zoom).toBe('month');
  });
});

describe('zoom direction (2026-10-16 browser check)', () => {
  // SVAR's wheel-up / zoom-in widens cells (dir +1) and steps to level + 1, so
  // its levels must run coarse → fine. Config order ['day','week','month'] was
  // passed through as-is, which made ctrl+wheel-up jump week → month.
  const props = (spy: ReturnType<typeof vi.fn>) => ({
    project,
    onViewStateChange: spy,
    zoom: { levels: [...LEVELS], default: 'week' as const },
  });

  test('zoom in (dir +1) moves to a finer level', () => {
    const spy = vi.fn();
    render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(1);
    expect(view(spy).zoom).toBe('day');
  });

  test('zoom out (dir -1) moves to a coarser level', () => {
    const spy = vi.fn();
    render(<Gantt {...props(spy)} />);
    zoomUntilLevelChanges(-1);
    expect(view(spy).zoom).toBe('month');
  });

  test('config order does not matter', () => {
    const spy = vi.fn();
    render(<Gantt {...props(spy)} zoom={{ levels: ['month', 'day', 'week'], default: 'week' }} />);
    zoomUntilLevelChanges(1);
    expect(view(spy).zoom).toBe('day');
  });
});

describe('StrictMode', () => {
  test('does not fire on mount under StrictMode (double effects)', () => {
    const spy = vi.fn();
    render(
      <StrictMode>
        <Gantt project={project} displayOptions onViewStateChange={spy} />
      </StrictMode>,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  test('a toggle under StrictMode fires exactly once', () => {
    const spy = vi.fn();
    const { container } = render(
      <StrictMode>
        <Gantt project={project} displayOptions onViewStateChange={spy} />
      </StrictMode>,
    );
    fireEvent.click(checkbox('Critical', container));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
