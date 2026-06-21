import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { usePreviewEngine } from './usePreviewEngine.js';

const STANDARD_CALENDAR: Calendar = {
  id: 'std',
  name: 'Standard M-F 8-5',
  workWeek: [
    [],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [],
  ],
  exceptions: [],
};

function makeProject(tasks: Task[]): Project {
  return {
    name: 'Test',
    start: new Date('2026-01-05T08:00:00'),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    baselines: [],
    calendars: [STANDARD_CALENDAR],
    resources: [],
    assignments: [],
  };
}

function makeTask(id: string, start: Date, end: Date): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    start,
    end,
    duration: 480,
    progress: 0,
  };
}

describe('usePreviewEngine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('returns null when activeCell is null', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    const { result } = renderHook(() => usePreviewEngine(project, null, '', 80));
    expect(result.current).toBeNull();
  });

  test('returns null for text field (no CPM impact)', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    const { result } = renderHook(() =>
      usePreviewEngine(project, { taskId: 't1', field: 'text' }, 'new name', 80),
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(result.current).toBeNull();
  });

  test('fires after debounce delay for duration field', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    const { result } = renderHook(() =>
      usePreviewEngine(project, { taskId: 't1', field: 'duration' }, '3', 80),
    );
    expect(result.current).toBeNull();
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current).not.toBeNull();
  });

  test('returned ghost project has task with patched duration', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    const { result } = renderHook(() =>
      usePreviewEngine(project, { taskId: 't1', field: 'duration' }, '3', 80),
    );
    act(() => {
      vi.advanceTimersByTime(80);
    });
    const ghostTask = result.current?.tasks.find((t) => t.id === 't1');
    // 3 working days = 3 × 8 × 60 = 1440 minutes
    expect(ghostTask?.duration).toBe(1440);
  });

  test('clears ghost when activeCell becomes null', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    let activeCell: { taskId: string; field: 'duration' } | null = {
      taskId: 't1',
      field: 'duration',
    };
    const { result, rerender } = renderHook(() => usePreviewEngine(project, activeCell, '3', 80));
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current).not.toBeNull();
    activeCell = null;
    rerender();
    expect(result.current).toBeNull();
  });

  test('returns null when dirtyValue produces empty patch (invalid input)', () => {
    const project = makeProject([
      makeTask('t1', new Date('2026-01-05T08:00:00'), new Date('2026-01-05T17:00:00')),
    ]);
    const { result } = renderHook(() =>
      usePreviewEngine(project, { taskId: 't1', field: 'duration' }, 'abc', 80),
    );
    act(() => {
      vi.advanceTimersByTime(80);
    });
    expect(result.current).toBeNull();
  });
});
