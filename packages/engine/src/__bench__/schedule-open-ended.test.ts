import { describe, expect, test } from 'vitest';
import { schedule } from '../schedule';
import type { Project, Task } from '../types';

// Open-ended programme: 5,000 independent 1–10-day leaves beside one 250-day
// task. Every leaf floats to the project finish, so total and free float each
// span up to 250 working days. With a day-by-day walk per task this shape took
// ~4.1–4.6 s (total slack only) and ~8–10 s once free float to the project
// finish landed; with the memoised per-calendar counter for long spans it is
// ~0.2 s on a 2 GHz Xeon. The budget is a generous tripwire for a return to per-task
// day walks, not a micro-benchmark.
const BUDGET_MS = 4000;
const DAY = 540;
const START = new Date(2026, 0, 5, 8, 0);
const WORK = [{ startMinutes: 480, endMinutes: 1020 }];

function openEnded(): Project {
  const leaf = (id: string, days: number): Task => ({
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: days * DAY,
    start: START,
    end: START,
    progress: 0,
  });
  return {
    start: START,
    defaultCalendarId: 'std',
    tasks: [
      leaf('big', 250),
      ...Array.from({ length: 5000 }, (_, i) => leaf(`L${i}`, (i % 10) + 1)),
    ],
    links: [],
    resources: [],
    calendars: [
      { id: 'std', name: 'Std', workWeek: [[], WORK, WORK, WORK, WORK, WORK, []], exceptions: [] },
    ],
    baselines: [],
    assignments: [],
  };
}

describe('schedule() open-ended scale', () => {
  test(`5,000 open-ended leaves + one 250-day task under ${BUDGET_MS}ms`, () => {
    schedule(openEnded()); // warm-up (JIT), so the timed run measures the algorithm
    const project = openEnded();
    const t0 = performance.now();
    const out = schedule(project);
    const ms = performance.now() - t0;
    const c = (id: string) => out.tasks.find((t) => t.id === id)?.computed;
    expect(c('big')?.totalSlack).toBe(0);
    expect(c('L0')?.totalSlack).toBe(249 * DAY);
    expect(c('L0')?.freeSlack).toBe(249 * DAY);
    expect(c('L9')?.freeSlack).toBe(240 * DAY);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
