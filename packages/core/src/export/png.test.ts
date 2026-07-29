import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { describe, expect, test, vi } from 'vitest';

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob(['fake-png-bytes'], { type: 'image/png' })),
}));

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string): Task {
  return {
    id,
    text: `Task ${id}`,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
  };
}

function project(tasks: Task[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('exportPNG', () => {
  test('returns an image/png Blob and calls html-to-image with the off-screen container', async () => {
    const p = schedule(project([task('a'), task('b')]));

    const { exportPNG } = await import('./png.js');
    const blob = await exportPNG({
      scheduled: p,
      ganttProps: { cellWidth: 48, cellHeight: 42 },
      options: { backgroundColor: '#fafafa' },
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/png');

    const { toBlob } = await import('html-to-image');
    expect(toBlob).toHaveBeenCalledOnce();
    const [firstCallArgs] = (toBlob as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const [element, opts] = firstCallArgs as [HTMLElement, { backgroundColor?: string }];
    expect(element).toBeInstanceOf(HTMLElement);
    expect(opts.backgroundColor).toBe('#fafafa');
  });
});
