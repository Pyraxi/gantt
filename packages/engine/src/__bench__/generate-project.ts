import type { Calendar, Link, Project, Task } from '../types';

export interface GenerateProjectOptions {
  /** Number of leaf `task` rows. */
  leafCount: number;
  /** Number of `summary` phases the leaves are distributed across. */
  phases: number;
  /** Deterministic ordering seed (unused beyond id stability; kept for API clarity). */
  seed?: number;
}

const STD_DAY = 540; // 9h, 8am-5pm
const PROJECT_START = new Date(2026, 0, 5, 8, 0);

const benchCalendar: Calendar = {
  id: 'bench',
  name: 'Bench M-F 8-5',
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

/**
 * Builds a deterministic synthetic Project for performance benchmarking.
 * Leaves are distributed evenly across `phases` summary tasks and chained
 * FS within each phase so the forward/backward pass has real cascade work.
 */
export function generateProject(opts: GenerateProjectOptions): Project {
  const { leafCount, phases } = opts;
  const tasks: Task[] = [];
  const links: Link[] = [];
  const perPhase = Math.ceil(leafCount / phases);

  let made = 0;
  for (let p = 0; p < phases; p++) {
    const summaryId = `S${p}`;
    tasks.push({
      id: summaryId,
      text: `Phase ${p + 1}`,
      type: 'summary',
      scheduleMode: 'auto',
      open: true,
      duration: 0,
      start: PROJECT_START,
      end: PROJECT_START,
      progress: 0,
    });

    let prevLeaf: string | undefined;
    for (let i = 0; i < perPhase && made < leafCount; i++, made++) {
      const id = `L${made}`;
      tasks.push({
        id,
        text: `Task ${made}`,
        parent: summaryId,
        type: 'task',
        scheduleMode: 'auto',
        duration: STD_DAY,
        start: PROJECT_START,
        end: PROJECT_START,
        progress: 0,
      });
      if (prevLeaf) {
        links.push({ id: `K${made}`, source: prevLeaf, target: id, type: 'FS', lag: 0 });
      }
      prevLeaf = id;
    }
  }

  return {
    start: PROJECT_START,
    defaultCalendarId: 'bench',
    tasks,
    links,
    resources: [],
    calendars: [benchCalendar],
    baselines: [],
    assignments: [],
  };
}
