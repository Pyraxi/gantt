import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { renderOffscreen } from './offscreen.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, duration: number): Task {
  return {
    id,
    text: `Task ${id}`,
    type: 'task',
    scheduleMode: 'auto',
    duration,
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

describe('renderOffscreen', () => {
  test('mounts a container, returns the host element, and dispose detaches it', async () => {
    const p = schedule(project([task('a', 540), task('b', 1080)]));

    const { container, dispose } = await renderOffscreen({
      scheduled: p,
      ganttProps: {
        cellWidth: 48,
        cellHeight: 42,
        height: 500,
      },
    });

    expect(container.isConnected).toBe(true);
    expect(container.style.position).toBe('absolute');
    expect(container.style.left).toContain('-');

    await dispose();

    expect(container.isConnected).toBe(false);
  });
});
