import type {
  Baseline,
  BaselineIndex as BIdx,
  Calendar,
  Link,
  Project,
  Task,
} from '@pyraxi/cpm-engine';
import { captureBaseline, filterTasksByVisibility } from '@pyraxi/cpm-engine';
import { render } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import {
  buildHighlightTime,
  buildSvarTasks,
  ConstructionBar,
  formatBaselineLabel,
  formatShortDate,
  Gantt,
  resolveBaselines,
  resolveEffectiveBaselineIndices,
} from './Gantt';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, text = `Task ${id}`, duration = 480): Task {
  return {
    id,
    text,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 17, 0),
    progress: 0,
  };
}

function projectOf(tasks: Task[], links: Link[] = []): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('resolveEffectiveBaselineIndices — precedence rule', () => {
  test('returns [] when both props are undefined', () => {
    expect(resolveEffectiveBaselineIndices(undefined, undefined)).toEqual([]);
  });

  test('wraps single baselineIndex in a one-element array', () => {
    expect(resolveEffectiveBaselineIndices(undefined, 0)).toEqual([0]);
    expect(resolveEffectiveBaselineIndices(undefined, 5)).toEqual([5]);
  });

  test('baselineIndices wins when both are set', () => {
    expect(resolveEffectiveBaselineIndices([1], 0)).toEqual([1]);
    expect(resolveEffectiveBaselineIndices([2, 3], 0)).toEqual([2, 3]);
  });

  test('empty baselineIndices array beats baselineIndex (explicit empty wins)', () => {
    expect(resolveEffectiveBaselineIndices([], 0)).toEqual([]);
  });
});

describe('resolveBaselines — index-to-record mapping', () => {
  test('returns empty array when effective indices are empty', () => {
    const proj = captureBaseline(projectOf([task('a')]), 0);
    expect(resolveBaselines(proj.baselines, [])).toEqual([]);
  });

  test('maps indices to baseline records, preserving caller order', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0, { name: 'B0' });
    proj = captureBaseline(proj, 2, { name: 'B2' });
    proj = captureBaseline(proj, 1, { name: 'B1' });

    const resolved = resolveBaselines(proj.baselines, [1, 2, 0]);
    expect(resolved.map((b) => b.index)).toEqual([1, 2, 0]);
    expect(resolved.map((b) => b.name)).toEqual(['B1', 'B2', 'B0']);
  });

  test('silently drops indices that are not present on the project', () => {
    const proj = captureBaseline(projectOf([task('a')]), 0);
    const resolved = resolveBaselines(proj.baselines, [0, 5, 9]);
    expect(resolved.map((b) => b.index)).toEqual([0]);
  });
});

describe('buildSvarTasks — single-baseline mode', () => {
  test('emits 1 live row per task when ghostBarsEnabled is false', () => {
    const proj = projectOf([task('a'), task('b')]);
    const result = buildSvarTasks(proj.tasks, [], standardCalendar, false);
    expect(result.length).toBe(2);
    expect(result.every((r) => !r.is_baseline_ghost)).toBe(true);
  });

  test('emits 1 live + 1 phantom per task in single-baseline mode', () => {
    let proj = projectOf([task('a'), task('b')]);
    proj = captureBaseline(proj, 0);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0]),
      standardCalendar,
      true,
    );
    expect(result.length).toBe(4);
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    expect(phantoms.length).toBe(2);
  });
});

describe('buildSvarTasks — multi-baseline emission', () => {
  test('`baselineIndices = [0, 1]` emits 2 phantoms per task', () => {
    let proj = projectOf([task('a'), task('b')]);
    proj = captureBaseline(proj, 0);
    proj = captureBaseline(proj, 1);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    // 2 tasks × (1 live + 2 phantoms) = 6 records
    expect(result.length).toBe(6);
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    expect(phantoms.length).toBe(4);
  });

  test('phantom row id format is task.id + __baseline_ + idx', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    proj = captureBaseline(proj, 1);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    const phantomIds = result.filter((r) => r.is_baseline_ghost).map((r) => r.id);
    expect(phantomIds).toEqual(['a__baseline_0', 'a__baseline_1']);
  });

  test('phantom row carries baseline_index field', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    proj = captureBaseline(proj, 1);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    expect(phantoms.map((p) => p.baseline_index)).toEqual([0, 1]);
  });

  test('phantom rows for tasks not in a baseline are silently skipped', () => {
    // B0 captured BEFORE task 'b' existed. So B0 has no snapshot of 'b'.
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    const withBAdded: Project = { ...proj, tasks: [...proj.tasks, task('b')] };
    const result = buildSvarTasks(
      withBAdded.tasks,
      resolveBaselines(withBAdded.baselines, [0]),
      standardCalendar,
      true,
    );
    // 2 live rows + 1 phantom (only 'a' has a B0 snapshot)
    expect(result.length).toBe(3);
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    expect(phantoms.length).toBe(1);
    expect(phantoms[0].id).toBe('a__baseline_0');
  });

  test('summary tasks do not emit phantom rows', () => {
    const summary: Task = {
      ...task('summary'),
      type: 'summary',
    };
    let proj = projectOf([summary, task('a')]);
    proj.tasks[1] = { ...proj.tasks[1], parent: 'summary' };
    proj = captureBaseline(proj, 0);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0]),
      standardCalendar,
      true,
    );
    // 2 live rows (summary + leaf), 1 phantom (leaf only)
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    expect(phantoms.length).toBe(1);
    expect(phantoms[0].id).toBe('a__baseline_0');
  });
});

describe('formatShortDate', () => {
  test('formats a date as YYYY-MM-DD using local components', () => {
    expect(formatShortDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(formatShortDate(new Date(2026, 11, 31))).toBe('2026-12-31');
    expect(formatShortDate(new Date(2027, 5, 9))).toBe('2027-06-09');
  });
});

describe('formatBaselineLabel', () => {
  test('uses baseline.name when present', () => {
    const baseline: Baseline = {
      index: 0,
      name: 'Original contract',
      capturedAt: new Date(2026, 0, 1),
      tasks: new Map(),
    };
    expect(formatBaselineLabel(baseline)).toBe('Original contract — captured 2026-01-01');
  });

  test('falls back to "Baseline N" when name is undefined', () => {
    const baseline: Baseline = {
      index: 3,
      capturedAt: new Date(2026, 1, 14),
      tasks: new Map(),
    };
    expect(formatBaselineLabel(baseline)).toBe('Baseline 3 — captured 2026-02-14');
  });
});

describe('buildSvarTasks — phantom row label', () => {
  test('phantom record text is formatted via formatBaselineLabel', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0, {
      name: 'Original contract',
      capturedAt: new Date(2026, 0, 1),
    });
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0]),
      standardCalendar,
      true,
    );
    const phantom = result.find((r) => r.is_baseline_ghost);
    expect(phantom?.text).toBe('Original contract — captured 2026-01-01');
  });
});

function phantomData(idx: BIdx, text = 'Baseline 0 — captured 2026-01-01') {
  return {
    id: `a__baseline_${idx}`,
    text,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 17, 0),
    duration: 480,
    progress: 0,
    type: 'task',
    is_baseline_ghost: true,
    baseline_index: idx,
  };
}

describe('ConstructionBar — phantom branch CSS classes', () => {
  test('phantom row carries construction-gantt-baseline-ghost + construction-gantt-baseline-{idx} classes', () => {
    const { container } = render(<ConstructionBar data={phantomData(0)} />);
    const root = container.firstElementChild;
    expect(root?.classList.contains('construction-gantt-baseline-ghost')).toBe(true);
    expect(root?.classList.contains('construction-gantt-baseline-0')).toBe(true);
  });

  test('phantom row class index reflects the baseline index', () => {
    const { container } = render(<ConstructionBar data={phantomData(3)} />);
    const root = container.firstElementChild;
    expect(root?.classList.contains('construction-gantt-baseline-3')).toBe(true);
    expect(root?.classList.contains('construction-gantt-baseline-0')).toBe(false);
  });

  test('phantom row renders the label text from data.text', () => {
    const { container } = render(
      <ConstructionBar data={phantomData(0, 'Variation 1 — captured 2026-04-15')} />,
    );
    expect(container.textContent).toContain('Variation 1 — captured 2026-04-15');
  });
});

describe('buildSvarTasks — variance fields', () => {
  test('live row has no variance fields in multi-baseline mode', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    proj = captureBaseline(proj, 1);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    const live = result.find((r) => !r.is_baseline_ghost);
    expect(live?.is_slipped).toBe(false);
    expect(live?.is_ahead).toBe(false);
    expect(live?.start_variance ?? 0).toBe(0);
  });

  test('live row carries variance fields in single-baseline mode', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    // Drift task 'a' to a manual schedule later than baseline:
    proj.tasks[0] = {
      ...proj.tasks[0],
      scheduleMode: 'manual',
      start: new Date(2026, 0, 6, 8, 0),
      end: new Date(2026, 0, 6, 17, 0),
    };
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0]),
      standardCalendar,
      true,
    );
    const live = result.find((r) => !r.is_baseline_ghost);
    expect(live?.is_slipped).toBe(true);
    expect((live?.start_variance ?? 0) > 0).toBe(true);
  });

  test('phantom row carries variance fields computed against the live position', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0);
    // Drift task 'a' (manual) later than baseline:
    proj.tasks[0] = {
      ...proj.tasks[0],
      scheduleMode: 'manual',
      start: new Date(2026, 0, 6, 8, 0),
      end: new Date(2026, 0, 6, 17, 0),
    };
    proj = captureBaseline(proj, 1);
    const result = buildSvarTasks(
      proj.tasks,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    const phantomB0 = result.find((r) => r.id === 'a__baseline_0');
    const phantomB1 = result.find((r) => r.id === 'a__baseline_1');
    // B0 snap is the original start (Jan 5) vs live (Jan 6) → slipped.
    expect(phantomB0?.is_slipped).toBe(true);
    // B1 snap matches live → variance ~0 → no slip/ahead.
    expect(phantomB1?.is_slipped).toBe(false);
    expect(phantomB1?.is_ahead).toBe(false);
  });
});

describe('ConstructionBar — phantom variance pills', () => {
  test('phantom row renders a "drifted later" pill when is_slipped', () => {
    const data = {
      ...phantomData(0),
      start_variance: 540, // one working day
      is_slipped: true,
    };
    const { container } = render(<ConstructionBar data={data} />);
    expect(container.querySelector('[title="Drifted later than the baseline"]')).not.toBeNull();
    expect(container.querySelector('[title="Ahead of the baseline"]')).toBeNull();
  });

  test('phantom row renders an "ahead" pill when is_ahead', () => {
    const data = {
      ...phantomData(0),
      start_variance: -540,
      is_ahead: true,
    };
    const { container } = render(<ConstructionBar data={data} />);
    expect(container.querySelector('[title="Ahead of the baseline"]')).not.toBeNull();
    expect(container.querySelector('[title="Drifted later than the baseline"]')).toBeNull();
  });

  test('phantom row renders no pill when start_variance is near zero', () => {
    const data = { ...phantomData(0), start_variance: 0 };
    const { container } = render(<ConstructionBar data={data} />);
    expect(container.querySelector('[title="Drifted later than the baseline"]')).toBeNull();
    expect(container.querySelector('[title="Ahead of the baseline"]')).toBeNull();
  });
});

describe('buildSvarTasks — visibility filter interaction', () => {
  test('phantoms emit only for tasks present in the (pre-filtered) input', () => {
    let proj = projectOf([task('a'), task('b')]);
    proj = captureBaseline(proj, 0);
    proj = captureBaseline(proj, 1);

    // Simulate visibility filtering: only 'a' is visible.
    const filtered = filterTasksByVisibility(proj.tasks, new Set(['a']));
    const result = buildSvarTasks(
      filtered,
      resolveBaselines(proj.baselines, [0, 1]),
      standardCalendar,
      true,
    );
    // 1 visible task × (1 live + 2 phantoms) = 3 records.
    expect(result.length).toBe(3);
    const phantoms = result.filter((r) => r.is_baseline_ghost);
    // Both phantoms belong to 'a'.
    expect(phantoms.map((p) => p.id).sort()).toEqual(['a__baseline_0', 'a__baseline_1']);
  });

  test('an empty visibility set produces an empty output', () => {
    let proj = projectOf([task('a'), task('b')]);
    proj = captureBaseline(proj, 0);
    const filtered = filterTasksByVisibility(proj.tasks, new Set());
    const result = buildSvarTasks(
      filtered,
      resolveBaselines(proj.baselines, [0]),
      standardCalendar,
      true,
    );
    expect(result).toEqual([]);
  });
});

describe('Gantt — smoke', () => {
  test('mounts without throwing when given a project with a baseline', () => {
    let proj = projectOf([task('a')]);
    proj = captureBaseline(proj, 0, { name: 'Original contract' });
    const result = render(<Gantt project={proj} baselineIndices={[0]} />);
    // Survival, not a count assertion (SVAR's row virtualization under
    // happy-dom is unreliable). We just want to verify nothing throws.
    expect(result.container).not.toBeNull();
  });

  test('mounts without baselines too', () => {
    const proj = projectOf([task('a')]);
    const result = render(<Gantt project={proj} />);
    expect(result.container).not.toBeNull();
  });
});

describe('<Gantt editMode> smoke', () => {
  test('mounts without crash with editMode=true', () => {
    const project = projectOf([task('t1')]);
    expect(() => render(<Gantt project={project} editMode />)).not.toThrow();
  });
});

describe('ConstructionBar — deadline pill', () => {
  const barBase = {
    id: 'a',
    text: 'Framing',
    type: 'task' as const,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 17, 0),
    duration: 1,
    progress: 0,
  };

  test('renders the missed pill + treatment when deadline_missed', () => {
    const data = {
      ...barBase,
      deadline: new Date(2026, 0, 5, 12, 0),
      deadline_missed: true,
      deadline_slack: -300,
    };
    const { container } = render(<ConstructionBar data={data} />);
    expect(
      container.querySelector('[title="Past deadline — sectional completion at risk"]'),
    ).not.toBeNull();
    expect(container.querySelector('.construction-gantt-deadline-missed')).not.toBeNull();
  });

  test('renders the amber met pill when a deadline is set and not missed', () => {
    const data = {
      ...barBase,
      deadline: new Date(2026, 0, 9, 17, 0),
      deadline_missed: false,
      deadline_slack: 1620,
    };
    const { container } = render(<ConstructionBar data={data} />);
    expect(
      container.querySelector('[title="Deadline — sectional completion target"]'),
    ).not.toBeNull();
    expect(container.querySelector('.construction-gantt-deadline-missed')).toBeNull();
  });

  test('renders no deadline pill when no deadline is set', () => {
    const { container } = render(<ConstructionBar data={barBase} />);
    expect(container.querySelector('[title="Deadline — sectional completion target"]')).toBeNull();
    expect(
      container.querySelector('[title="Past deadline — sectional completion at risk"]'),
    ).toBeNull();
  });
});

describe('buildHighlightTime — partial-day shading', () => {
  const shiftCal: Calendar = {
    id: 'shift',
    name: '7-3',
    workWeek: [
      [],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [],
    ],
    exceptions: [],
  };

  test('hour inside the shift → no shading class', () => {
    const fn = buildHighlightTime(shiftCal)!;
    expect(fn(new Date(2026, 0, 5, 9), 'hour')).toBe('');
  });
  test('hour outside the shift → non-working class', () => {
    const fn = buildHighlightTime(shiftCal)!;
    expect(fn(new Date(2026, 0, 5, 16), 'hour')).toBe('construction-gantt-non-working');
  });
  test('day unit still shades a non-working day', () => {
    const fn = buildHighlightTime(shiftCal)!;
    expect(fn(new Date(2026, 0, 4), 'day')).toBe('construction-gantt-non-working'); // Sunday
    expect(fn(new Date(2026, 0, 5), 'day')).toBe(''); // Monday
  });
  test('undefined calendar → undefined builder', () => {
    expect(buildHighlightTime(undefined)).toBeUndefined();
  });
});
