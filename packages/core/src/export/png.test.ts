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

describe('exportPNG — real-browser capture fixes (2026-10-16)', () => {
  test('the clone is moved back into view (it inherited left:-99999px → blank captures)', async () => {
    const { toBlob } = await import('html-to-image');
    (toBlob as unknown as { mockClear(): void }).mockClear();
    const { exportPNG } = await import('./png.js');
    await exportPNG({ scheduled: schedule(project([task('a')])), ganttProps: {}, options: {} });
    const [, opts] = (toBlob as unknown as { mock: { calls: unknown[][] } }).mock.calls[0] as [
      HTMLElement,
      { style?: Record<string, string> },
    ];
    expect(opts.style).toMatchObject({ position: 'static', left: '0', top: '0' });
  });

  test('the off-screen render has no toolbar, and SVG paint is inlined as attributes', async () => {
    const { toBlob } = await import('html-to-image');
    let seen: { toolbar: number; svgWithoutFill: number } | undefined;
    (
      toBlob as unknown as { mockImplementationOnce(f: (el: HTMLElement) => Promise<Blob>): void }
    ).mockImplementationOnce(async (el: HTMLElement) => {
      seen = {
        toolbar: el.querySelectorAll('.wx-toolbar').length,
        svgWithoutFill: [...el.querySelectorAll('svg *')].filter((n) => !n.hasAttribute('fill'))
          .length,
      };
      return new Blob(['x'], { type: 'image/png' });
    });
    const { exportPNG } = await import('./png.js');
    const p = schedule({
      ...project([task('a'), task('b')]),
      links: [{ id: 'l', source: 'a', target: 'b', type: 'FS', lag: 0 }],
    });
    await exportPNG({ scheduled: p, ganttProps: {}, options: {} });
    expect(seen).toEqual({ toolbar: 0, svgWithoutFill: 0 });
  });
});

describe('assertComplete', () => {
  const m = { width: 800, height: 500, headerPx: 73, rowPx: 42, rowCount: 10, lastRowBottom: 493 };
  test('passes a capture that holds every row', async () => {
    const { assertComplete } = await import('./png.js');
    expect(assertComplete(m)).toBe(m);
  });
  test('throws when the last row is clipped', async () => {
    const { assertComplete } = await import('./png.js');
    expect(() => assertComplete({ ...m, height: 400 })).toThrow(/clip rows/);
  });
  test('throws, with a remedy, past MAX_EXPORT_ROWS', async () => {
    const { assertComplete, MAX_EXPORT_ROWS } = await import('./png.js');
    expect(() => assertComplete({ ...m, rowCount: MAX_EXPORT_ROWS + 1, lastRowBottom: 0 })).toThrow(
      /visibleTaskIds/,
    );
  });
});
