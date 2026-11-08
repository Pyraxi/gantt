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

  test('exports keep the progress line, highlights and inline baselines (not just the bars)', async () => {
    const base = schedule(project([task('a', 540), task('b', 1080)]));
    const p = {
      ...base,
      statusDate: new Date(2026, 0, 6, 12),
      baselines: [
        {
          index: 0 as const,
          capturedAt: new Date(0),
          tasks: new Map(
            base.tasks.map((t) => [
              t.id,
              { start: new Date(2026, 0, 2, 8), end: new Date(2026, 0, 2, 17), duration: 540 },
            ]),
          ),
        },
      ],
    } as Project;
    const { container, dispose } = await renderOffscreen({
      scheduled: p,
      ganttProps: {
        cellWidth: 48,
        cellHeight: 42,
        height: 500,
        progressLine: true,
        highlights: [{ taskIds: ['a'], color: '#ff0000' }],
        baselineIndices: [0],
        baselineRender: 'inline',
      },
    });
    try {
      expect(container.querySelector('.construction-gantt-progress-line')).not.toBeNull();
      expect(container.querySelector('.construction-gantt-baseline-inline')).not.toBeNull();
      // The off-screen instance's own scoped rule, not another instance's.
      const scope = [...(container.querySelector('[class*="cg-scope-"]')?.classList ?? [])].find(
        (c) => c.startsWith('cg-scope-'),
      );
      expect(scope).toBeDefined();
      const css = [...container.querySelectorAll('style')].map((s) => s.textContent).join('');
      expect(css).toContain(`.${scope}`);
      expect(css).toContain('#ff0000');
    } finally {
      await dispose();
    }
  });

  test('host theme tokens reach the off-screen container (it lives on <body>)', async () => {
    const p = schedule(project([task('a', 540)]));
    const { container, dispose } = await renderOffscreen({
      scheduled: p,
      ganttProps: { cellWidth: 48, cellHeight: 42 },
      themeVars: { '--cg-progress-line-color': 'rgb(0, 255, 0)' },
    });
    try {
      expect(container.style.getPropertyValue('--cg-progress-line-color')).toBe('rgb(0, 255, 0)');
    } finally {
      await dispose();
    }
  });

  test('the container takes the export backgroundColor (not a hardcoded white)', async () => {
    const p = schedule(project([task('a', 540)]));
    const { container, dispose } = await renderOffscreen({
      scheduled: p,
      ganttProps: { cellWidth: 48, cellHeight: 42 },
      backgroundColor: '#0b1020',
    });
    try {
      expect(container.style.background).toMatch(/#0b1020|rgb\(11, 16, 32\)/);
    } finally {
      await dispose();
    }
  });
  test('exports draw a badge on every bar SVAR draws (badges follow its row window)', async () => {
    // happy-dom has no layout, so SVAR's window here is a few rows; in a
    // browser the export's pass 1 sizes it to every row, bars and badges alike.
    const p = schedule(project(Array.from({ length: 120 }, (_, i) => task(`t${i}`, 540))));
    const { container, dispose } = await renderOffscreen({
      scheduled: p,
      ganttProps: {
        cellWidth: 48,
        cellHeight: 42,
        height: 500,
        taskBadges: () => [{ kind: 'k', label: 'x' }],
      },
    });
    const bars = container.querySelectorAll('.wx-bar').length;
    expect(bars).toBeGreaterThan(0);
    expect(container.querySelectorAll('.construction-gantt-badges')).toHaveLength(bars);
    await dispose();
  });
});
