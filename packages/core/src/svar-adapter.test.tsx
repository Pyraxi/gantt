// Data-layer unit tests for svar-adapter.ts.
//
// Strategy: test the pure toSvarTask() adapter function in isolation.
// No full-DOM render — per test-strategy memory (reference_test_strategy_svar_happy_dom):
// SVAR canvas + row-virtualization is unreliable under happy-dom.
// The mount-survival smoke test at the bottom confirms <Gantt> mounts without
// throwing; it asserts nothing about rendered bar geometry.

import type { Calendar, Project, Task, TaskSegment } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import {
  buildRowStyleCss,
  buildSignalCss,
  buildSvarTasks,
  projectHasSplitTasks,
  projectHasUnscheduledTasks,
  toSvarTask,
  toSvarZoom,
} from './svar-adapter.js';

const computed = (over: Partial<NonNullable<Task['computed']>> = {}) => ({
  earlyStart: START,
  earlyFinish: new Date(2026, 0, 5, 17, 0),
  lateStart: START,
  lateFinish: new Date(2026, 0, 5, 17, 0),
  totalSlack: 0,
  freeSlack: 0,
  isCritical: false,
  ...over,
});

// ---------------------------------------------------------------------------
// toSvarZoom — named zoom level conversion (Task 3.2)
// ---------------------------------------------------------------------------

describe('toSvarZoom', () => {
  test('single named level produces IZoomConfig with one levels entry', () => {
    const result = toSvarZoom({ levels: ['week'] });
    expect(result.levels).toHaveLength(1);
    expect(result.levels![0].scales.some((s) => s.unit === 'week')).toBe(true);
  });

  test('default level index points to the default name', () => {
    const result = toSvarZoom({ levels: ['day', 'week', 'month'], default: 'month' });
    expect(result.level).toBe(2);
  });

  test('default level index is 0 when default is omitted', () => {
    const result = toSvarZoom({ levels: ['day', 'week'] });
    expect(result.level).toBe(0);
  });

  test('default not in levels clamps to 0 instead of -1 (indexOf guard)', () => {
    const result = toSvarZoom({ levels: ['day', 'week'], default: 'month' });
    expect(result.level).toBe(0);
  });

  test('omitting levels falls back to [day, week, month]', () => {
    const result = toSvarZoom({});
    expect(result.levels).toHaveLength(3);
    expect(result.level).toBe(0);
  });

  test('each level has minCellWidth, maxCellWidth, and at least one scale', () => {
    const result = toSvarZoom({ levels: ['hour', 'day', 'week', 'month', 'quarter'] });
    expect(result.levels).toHaveLength(5);
    for (const level of result.levels!) {
      expect(level.minCellWidth).toBeGreaterThan(0);
      expect(level.maxCellWidth).toBeGreaterThan(level.minCellWidth);
      expect(level.scales.length).toBeGreaterThanOrEqual(1);
    }
  });

  test('every generated scale has a non-empty format (CM zoom-crash regression)', () => {
    // Bug: scales were emitted as { unit, step } with no `format`, so SVAR's
    // scale formatter did `.replace()` on undefined and crashed the renderer.
    // Repro from CM was the documented example { levels: ['day','week','month'] }.
    for (const levels of [
      ['day', 'week', 'month'],
      ['hour', 'day', 'week', 'month', 'quarter'],
    ] as const) {
      const z = toSvarZoom({ levels: [...levels] });
      for (const level of z.levels ?? []) {
        for (const scale of level.scales) {
          expect(typeof (scale as { format?: unknown }).format).toBe('string');
          expect((scale as { format: string }).format.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

const START = new Date(2026, 0, 5, 8, 0);

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: START,
    end: new Date(2026, 0, 5, 17, 0),
    progress: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Unscheduled tasks
// ---------------------------------------------------------------------------

describe('toSvarTask — unscheduled', () => {
  test('unscheduled task maps to ITask with unscheduled: true', () => {
    const t = makeTask('u', { unscheduled: true });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.unscheduled).toBe(true);
  });

  test('scheduled task has no unscheduled flag', () => {
    const t = makeTask('a');
    const result = toSvarTask(t, undefined, undefined);
    expect(result.unscheduled).toBeUndefined();
  });
});

describe('projectHasUnscheduledTasks', () => {
  test('returns true when at least one task is unscheduled', () => {
    const tasks: Task[] = [makeTask('a'), makeTask('u', { unscheduled: true })];
    expect(projectHasUnscheduledTasks(tasks)).toBe(true);
  });

  test('returns false when no task is unscheduled', () => {
    const tasks: Task[] = [makeTask('a'), makeTask('b')];
    expect(projectHasUnscheduledTasks(tasks)).toBe(false);
  });

  test('returns false for empty task list', () => {
    expect(projectHasUnscheduledTasks([])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Split tasks
// ---------------------------------------------------------------------------

const SEG1: TaskSegment = { start: new Date(2026, 0, 5, 8, 0), end: new Date(2026, 0, 5, 17, 0) };
const SEG2: TaskSegment = { start: new Date(2026, 0, 8, 8, 0), end: new Date(2026, 0, 8, 17, 0) };

describe('toSvarTask — split segments', () => {
  test('split task carries segments through to SVAR ITask.segments', () => {
    const t = makeTask('s', {
      scheduleMode: 'manual',
      segments: [SEG1, SEG2],
    });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.segments).toBeDefined();
    expect(result.segments).toHaveLength(2);
    expect(result.segments?.[0]).toEqual({ start: SEG1.start, end: SEG1.end });
    expect(result.segments?.[1]).toEqual({ start: SEG2.start, end: SEG2.end });
  });

  test('unsplit task has no segments property', () => {
    const t = makeTask('a');
    const result = toSvarTask(t, undefined, undefined);
    expect(result.segments).toBeUndefined();
  });

  test('task with empty segments array has no segments on the ITask', () => {
    const t = makeTask('a', { segments: [] });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.segments).toBeUndefined();
  });
});

describe('projectHasSplitTasks', () => {
  test('returns true when at least one manual-mode task has segments', () => {
    // Per ADR-007 + F6 fix: only manual-mode segments trigger split mode.
    const tasks: Task[] = [
      makeTask('a'),
      makeTask('s', { scheduleMode: 'manual', segments: [SEG1, SEG2] }),
    ];
    expect(projectHasSplitTasks(tasks)).toBe(true);
  });

  test('returns false when no task has segments', () => {
    const tasks: Task[] = [makeTask('a'), makeTask('b')];
    expect(projectHasSplitTasks(tasks)).toBe(false);
  });

  test('returns false when tasks have empty segments arrays', () => {
    const tasks: Task[] = [makeTask('a', { segments: [] })];
    expect(projectHasSplitTasks(tasks)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Existing conversion behavior (regression guard)
// ---------------------------------------------------------------------------

describe('toSvarTask — existing behavior', () => {
  test('maps id, text, start, end, duration, progress, type', () => {
    const t = makeTask('task-1', { text: 'Foundation', progress: 50 });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.id).toBe('task-1');
    expect(result.text).toBe('Foundation');
    expect(result.start).toBe(t.start);
    expect(result.end).toBe(t.end);
    // No calendar → raw working-minutes preserved (test-only path).
    expect(result.duration).toBe(540);
    expect(result.progress).toBe(50);
    expect(result.type).toBe('task');
  });

  test('with a calendar, duration is converted to working days (not minutes)', () => {
    // standardCalendar is a 9h (540-min) working day. 1620 min = 3 days.
    const t = makeTask('d', { duration: 1620 });
    const result = toSvarTask(t, undefined, standardCalendar);
    expect(result.duration).toBe(3);
  });

  test('summary task gets open: true by default', () => {
    const t = makeTask('s1', { type: 'summary', scheduleMode: 'auto' });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.open).toBe(true);
  });

  test('leaf task does not get open property', () => {
    const t = makeTask('l1');
    const result = toSvarTask(t, undefined, undefined);
    expect(result.open).toBeUndefined();
  });

  test('computed isCritical maps to is_critical', () => {
    const t = makeTask('c1', {
      computed: {
        earlyStart: START,
        earlyFinish: new Date(2026, 0, 5, 17, 0),
        lateStart: START,
        lateFinish: new Date(2026, 0, 5, 17, 0),
        totalSlack: 0,
        freeSlack: 0,
        isCritical: true,
      },
    });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.is_critical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildSignalCss — engine-signal stylesheet for the native bar path
// ---------------------------------------------------------------------------

describe('buildSignalCss', () => {
  test('returns null when no task carries a signal', () => {
    const tasks = [makeTask('a', { computed: computed() }), makeTask('b')];
    expect(buildSignalCss(tasks, 'cg-scope-x')).toBeNull();
  });

  test('critical leaf task overrides SVAR task fill token, scoped + data-id keyed', () => {
    const tasks = [makeTask('found', { computed: computed({ isCritical: true }) })];
    const css = buildSignalCss(tasks, 'cg-scope-x');
    // SVAR tags bars data-id=":<id>"; selector must be scoped to this instance
    expect(css).toContain('.cg-scope-x .wx-bar[data-id=":found"]');
    expect(css).toContain('--wx-gantt-task-fill-color:#de3a3a');
    expect(css).not.toContain('summary');
  });

  test('targets both colon-prefixed (string id) and bare (numeric id) data-id forms', () => {
    // SVAR setID: string ids → ":site", numeric ids → "5". Cover both.
    const stringId = buildSignalCss(
      [makeTask('site', { computed: computed({ isCritical: true }) })],
      'cg-scope-x',
    );
    expect(stringId).toContain('[data-id=":site"]');
    expect(stringId).toContain('[data-id="site"]');

    const numericId = buildSignalCss(
      [makeTask('5' as unknown as string, { computed: computed({ isCritical: true }) })],
      'cg-scope-x',
    );
    expect(numericId).toContain('[data-id="5"]');
  });

  test('critical summary task overrides the summary tokens, not the task token', () => {
    const tasks = [
      makeTask('phase1', { type: 'summary', computed: computed({ isCritical: true }) }),
    ];
    const css = buildSignalCss(tasks, 'cg-scope-x') ?? '';
    expect(css).toContain('--wx-gantt-summary-fill-color:#c32b64');
    expect(css).not.toContain('--wx-gantt-task-fill-color');
  });

  test('deadline overrun adds an outline rule', () => {
    const tasks = [makeTask('roof', { computed: computed({ deadlineMissed: true }) })];
    const css = buildSignalCss(tasks, 'cg-scope-x') ?? '';
    expect(css).toContain('.cg-scope-x .wx-bar[data-id=":roof"]');
    expect(css).toContain('outline:2px solid #dc2626');
  });

  test('only critical/deadline tasks emit rules; clean tasks are skipped', () => {
    const tasks = [
      makeTask('crit', { computed: computed({ isCritical: true }) }),
      makeTask('clean', { computed: computed() }),
    ];
    const css = buildSignalCss(tasks, 'cg-scope-x') ?? '';
    expect(css).toContain(':crit"');
    expect(css).not.toContain(':clean"');
  });

  describe('buildRowStyleCss — bold summary rows', () => {
    test('bolds summary rows only, scoped + both data-id forms, leaf rows untouched', () => {
      const tasks = [makeTask('phase', { type: 'summary' }), makeTask('leaf')];
      const css = buildRowStyleCss(tasks, 'cg-scope-x') ?? '';
      expect(css).toContain('.cg-scope-x .wx-row[data-id=":phase"]');
      expect(css).toContain('.cg-scope-x .wx-row[data-id="phase"]');
      expect(css).toContain('font-weight:600');
      expect(css).not.toContain(':leaf"');
    });
    test('no summary rows → null', () => {
      expect(buildRowStyleCss([makeTask('a'), makeTask('b')], 'cg-scope-x')).toBeNull();
    });
    test('boldSummary:false → null even with summaries', () => {
      const tasks = [makeTask('phase', { type: 'summary' })];
      expect(buildRowStyleCss(tasks, 'cg-scope-x', { boldSummary: false })).toBeNull();
    });
    test('escapes CSS/HTML-dangerous chars in ids (no </style> breakout, selector stays valid)', () => {
      const evil = makeTask('a"><' as unknown as string, { type: 'summary' });
      const css = buildRowStyleCss([evil], 'cg-scope-x') ?? '';
      // The literal dangerous chars must not survive into the injected stylesheet.
      expect(css).not.toContain('"><');
      expect(css).not.toContain('</style');
      // Still emits a rule (escaped), not dropped.
      expect(css).toContain('font-weight:600');
    });
    test('batches multiple summaries into one rule (compact)', () => {
      const tasks = [
        makeTask('p1', { type: 'summary' }),
        makeTask('p2', { type: 'summary' }),
        makeTask('leaf'),
      ];
      const css = buildRowStyleCss(tasks, 'cg-scope-x') ?? '';
      expect(css).toContain(':p1"');
      expect(css).toContain(':p2"');
      // single declaration block, not one per summary
      expect(css.match(/font-weight:600/g)?.length).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Task 3: signal-visibility gating via opts
  // -------------------------------------------------------------------------

  describe('visibility gating via opts', () => {
    test('omitted opts is unchanged: emits both critical fill token and deadline outline', () => {
      const tasks = [
        makeTask('found', { computed: computed({ isCritical: true, deadlineMissed: true }) }),
      ];
      const css = buildSignalCss(tasks, 'cg-scope-x') ?? '';
      expect(css).toContain('--wx-gantt-task-fill-color:#de3a3a');
      expect(css).toContain('outline:2px solid #dc2626');
    });

    test('critical:false suppresses the critical fill-token rule but keeps the deadline outline', () => {
      const tasks = [
        makeTask('found', { computed: computed({ isCritical: true, deadlineMissed: true }) }),
      ];
      const css = buildSignalCss(tasks, 'cg-scope-x', { critical: false }) ?? '';
      expect(css).not.toContain('--wx-gantt-task-fill-color');
      expect(css).not.toContain('--wx-gantt-summary-fill-color');
      expect(css).toContain('outline:2px solid #dc2626');
    });

    test('critical:false also suppresses the summary-token rule for a critical summary task', () => {
      const tasks = [
        makeTask('phase1', { type: 'summary', computed: computed({ isCritical: true }) }),
      ];
      expect(buildSignalCss(tasks, 'cg-scope-x', { critical: false })).toBeNull();
    });

    test('deadline:false suppresses the outline rule but keeps the critical fill-token rule', () => {
      const tasks = [
        makeTask('found', { computed: computed({ isCritical: true, deadlineMissed: true }) }),
      ];
      const css = buildSignalCss(tasks, 'cg-scope-x', { deadline: false }) ?? '';
      expect(css).toContain('--wx-gantt-task-fill-color:#de3a3a');
      expect(css).not.toContain('outline:2px solid #dc2626');
    });

    test('critical:false and deadline:false together return null when nothing remains', () => {
      const tasks = [
        makeTask('found', { computed: computed({ isCritical: true, deadlineMissed: true }) }),
      ];
      expect(buildSignalCss(tasks, 'cg-scope-x', { critical: false, deadline: false })).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// buildSvarTasks — feature flag propagation
// ---------------------------------------------------------------------------

describe('buildSvarTasks — feature flags via toSvarTask', () => {
  test('includes unscheduled flag on result task', () => {
    const tasks: Task[] = [makeTask('a'), makeTask('u', { unscheduled: true })];
    const result = buildSvarTasks(tasks, [], standardCalendar, false);
    const uTask = result.find((t) => t.id === 'u');
    expect(uTask?.unscheduled).toBe(true);
  });

  test('includes segments on manual-mode split task result', () => {
    // Per ADR-007 + F6 fix: segments only emitted for manual-mode tasks.
    const tasks: Task[] = [
      makeTask('a'),
      makeTask('s', { scheduleMode: 'manual', segments: [SEG1, SEG2] }),
    ];
    const result = buildSvarTasks(tasks, [], standardCalendar, false);
    const sTask = result.find((t) => t.id === 's');
    expect(sTask?.segments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// buildSvarTasks — childless summary must NOT be `open` (CM crash 2026-07-28)
// ---------------------------------------------------------------------------
//
// SVAR's tree-walker recurses into a node's children whenever `open === true`:
//   function Ct(t,e){t.forEach(n=>{e.push(n),n.open===true&&Ct(n.data,e)})}
// A summary with no children never has its `data` array initialised (SVAR's
// `parse` only creates `data` on a node when some other node names it parent),
// so `data` stays null. `open:true` on such a node makes SVAR call
// `Ct(null,…)` → `null.forEach` → the whole schedule page dies into the error
// boundary. This is the exact state of a freshly-templated BC job (all-summary
// phase spine, no child tasks yet). Guard: only mark a summary `open` when it
// actually has children in the rendered set.
describe('buildSvarTasks — childless summary is not `open` (crash guard)', () => {
  test('a summary with no children does not get open:true', () => {
    const summaryOnly = makeTask('phase-100', { type: 'summary' });
    const result = buildSvarTasks([summaryOnly], [], standardCalendar, false);
    const node = result.find((t) => t.id === 'phase-100');
    // `open` must be falsy so SVAR's Ct never recurses into the null child array.
    expect(node?.open).not.toBe(true);
  });

  test('all-summary childless spine (BC template state) yields no open nodes', () => {
    const spine: Task[] = ['100', '200', '300', '900', '1000'].map((id) =>
      makeTask(`phase-${id}`, { type: 'summary', parent: null }),
    );
    const result = buildSvarTasks(spine, [], standardCalendar, false);
    expect(result.every((t) => t.open !== true)).toBe(true);
  });

  test('a summary WITH a child keeps open:true (expand behaviour preserved)', () => {
    const tasks: Task[] = [
      makeTask('phase-100', { type: 'summary' }),
      makeTask('task-a', { parent: 'phase-100' }),
    ];
    const result = buildSvarTasks(tasks, [], standardCalendar, false);
    const summary = result.find((t) => t.id === 'phase-100');
    expect(summary?.open).toBe(true);
  });

  test('guard also holds on the ghost branch (ghostBarsEnabled + a baseline)', () => {
    // buildSvarTasks has two arms; the ghost/baseline arm converts the live row
    // through a second toSvarTask call site. Pin that it carries the same guard.
    const baseline: Baseline = {
      index: 0,
      capturedAt: new Date(2026, 0, 1),
      tasks: new Map(),
    };
    const summaryOnly = makeTask('phase-100', { type: 'summary' });
    const result = buildSvarTasks([summaryOnly], [baseline], standardCalendar, true);
    const node = result.find((t) => t.id === 'phase-100');
    expect(node?.open).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toSvarToolbar (Task 3.6)
// ---------------------------------------------------------------------------

import { toSvarToolbar } from './svar-adapter.js';

describe('toSvarToolbar', () => {
  test('undefined items returns undefined (use SVAR defaults)', () => {
    const result = toSvarToolbar({});
    expect(result).toBeUndefined();
  });

  test('item array is converted: onClick → handler, text, icon, id pass through', () => {
    const clicked: string[] = [];
    const result = toSvarToolbar({
      items: [
        {
          id: 'my-btn',
          text: 'Do it',
          icon: 'mdi-check',
          onClick: (item) => clicked.push(item.id ?? ''),
        },
      ],
    });
    expect(result).toHaveLength(1);
    const btn = result![0];
    expect(btn.id).toBe('my-btn');
    expect(btn.text).toBe('Do it');
    expect(btn.icon).toBe('mdi-check');
    expect(typeof btn.handler).toBe('function');
  });

  test('item without onClick produces no handler property', () => {
    const result = toSvarToolbar({ items: [{ id: 'x', text: 'X' }] });
    expect(result![0].handler).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toSvarContextMenu (Task 3.5)
// ---------------------------------------------------------------------------

import { toSvarContextMenu } from './svar-adapter.js';

describe('toSvarContextMenu', () => {
  test('undefined items returns undefined (use SVAR defaults)', () => {
    expect(toSvarContextMenu({})).toBeUndefined();
  });

  test('item array converts: onClick → handler, text, icon, id', () => {
    const result = toSvarContextMenu({
      items: [{ id: 'edit', text: 'Edit task', icon: 'mdi-pencil' }],
    });
    expect(result).toHaveLength(1);
    expect(result![0].text).toBe('Edit task');
    expect(result![0].icon).toBe('mdi-pencil');
  });

  test('nested items (submenus) are converted recursively', () => {
    const result = toSvarContextMenu({
      items: [{ id: 'add', text: 'Add', items: [{ id: 'add-child', text: 'Child task' }] }],
    });
    expect(result![0].data).toHaveLength(1);
    expect(result![0].data![0].text).toBe('Child task');
  });

  test('separator item passes through', () => {
    const result = toSvarContextMenu({ items: [{ separator: true }] });
    const item = result![0] as Record<string, unknown>;
    expect(item.separator ?? item.type).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// toSvarEditorItems (Task 3.4)
// ---------------------------------------------------------------------------

import { toSvarEditorItems } from './svar-adapter.js';

describe('toSvarEditorItems', () => {
  test('undefined fields returns undefined (use SVAR defaults)', () => {
    expect(toSvarEditorItems({})).toBeUndefined();
  });

  test('fields array converts key, label, comp, required', () => {
    const result = toSvarEditorItems({
      fields: [{ key: 'text', label: 'Task name', comp: 'text', required: true }],
    });
    expect(result).toHaveLength(1);
    expect(result![0].key).toBe('text');
    expect(result![0].label).toBe('Task name');
    expect(result![0].comp).toBe('text');
    expect(result![0].required).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mount-survival smoke test
// ---------------------------------------------------------------------------
// Per test-strategy memory: only assert that <Gantt> mounts without throwing.
// Do NOT assert on rendered bar geometry — SVAR canvas + happy-dom = unreliable.

import { render } from '@testing-library/react';
import { Gantt } from './Gantt.js';

function projectWithSplitAndUnscheduled(): Project {
  return {
    start: START,
    defaultCalendarId: 'std',
    tasks: [
      makeTask('a', { scheduleMode: 'manual' }),
      makeTask('split1', {
        scheduleMode: 'manual',
        segments: [SEG1, SEG2],
      }),
      makeTask('unscheduled1', { unscheduled: true }),
    ],
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('Gantt mount-survival — split + unscheduled', () => {
  test('mounts without throwing when project contains a split task and an unscheduled task', () => {
    expect(() => {
      render(<Gantt project={projectWithSplitAndUnscheduled()} height={400} />);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mount-survival smoke tests — chrome props (Tasks 3.2–3.7)
// ---------------------------------------------------------------------------

const simpleProject: Project = {
  start: START,
  defaultCalendarId: 'std',
  tasks: [makeTask('a'), makeTask('b')],
  links: [{ id: 'l1', source: 'a', target: 'b', type: 'FS', lag: 0 }],
  resources: [],
  calendars: [standardCalendar],
  baselines: [],
  assignments: [],
};

// Chrome prop smoke tests — per test-strategy memory (reference_test_strategy_svar_happy_dom):
// SVAR's zoom scale formatter calls string.replace() internally which errors under
// happy-dom, so the `zoom` prop has no mount smoke (covered by the pure toSvarZoom
// unit tests + Chrome.stories.tsx). Editor/Tooltip/Toolbar/ContextMenu DO mount-smoke
// cleanly now that the wrapper gates them on `svarApi` (they previously threw
// "getState of undefined" when rendered before SVAR's init delivered the api).

describe('Gantt mount-survival — chrome props (happy-dom compatible subset)', () => {
  test('mounts with contextMenu: true', () => {
    expect(() => {
      render(<Gantt project={simpleProject} contextMenu={true} />);
    }).not.toThrow();
  });

  test('mounts with toolbar: true', () => {
    expect(() => {
      render(<Gantt project={simpleProject} toolbar={true} />);
    }).not.toThrow();
  });

  test('mounts with locale override (no zoom/api internals triggered)', () => {
    expect(() => {
      render(
        <Gantt project={simpleProject} locale={{ gantt: { 'Add task': 'Aufgabe hinzufügen' } }} />,
      );
    }).not.toThrow();
  });

  test('mounts with custom toolbar items', () => {
    expect(() => {
      render(
        <Gantt
          project={simpleProject}
          toolbar={{ items: [{ id: 'my-btn', text: 'Custom', icon: 'mdi-check' }] }}
        />,
      );
    }).not.toThrow();
  });

  test('mounts with custom context menu items', () => {
    expect(() => {
      render(
        <Gantt
          project={simpleProject}
          contextMenu={{ items: [{ id: 'edit', text: 'Edit task' }] }}
        />,
      );
    }).not.toThrow();
  });

  // Regression for the chrome IApi-delivery bug: SVAR's Editor/Tooltip call an
  // UNGUARDED useStore(api).getState() that throws if rendered with api=undefined.
  // The wrapper gates these siblings on `svarApi` so they mount only after SVAR's
  // init delivers the api. Before the gate, `render(<Gantt editor />)` threw
  // "Cannot read properties of undefined (reading 'getState')". Verified working
  // in a real browser (editor opens populated on double-click); these guard the
  // no-crash-on-mount invariant.
  test('mounts with editor: true (does not throw — gated on svarApi)', () => {
    expect(() => {
      render(<Gantt project={simpleProject} editor={true} />);
    }).not.toThrow();
  });

  test('mounts with a tooltip render function (does not throw — gated on svarApi)', () => {
    expect(() => {
      render(<Gantt project={simpleProject} tooltip={(task) => task.text} />);
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F4 — hour and day zoom levels must have distinct cell-width bands
// ---------------------------------------------------------------------------

describe('toSvarZoom — F4: hour vs day have distinct bands', () => {
  test('hour and day level bands differ when both present', () => {
    const result = toSvarZoom({ levels: ['hour', 'day', 'week'] });
    const [hourLevel, dayLevel] = result.levels!;
    expect(hourLevel).toBeDefined();
    expect(dayLevel).toBeDefined();
    // At minimum their minCellWidth must differ so scroll-wheel doesn't oscillate.
    expect(hourLevel!.minCellWidth).not.toBe(dayLevel!.minCellWidth);
  });
});

// ---------------------------------------------------------------------------
// F6 — auto-mode task with segments: toSvarTask must NOT emit segments
// ---------------------------------------------------------------------------

describe('toSvarTask — F6: segments gated on manual mode', () => {
  test('auto-mode task with segments does NOT emit segments (stale splits suppressed)', () => {
    const t = makeTask('auto-split', {
      scheduleMode: 'auto',
      segments: [SEG1, SEG2],
    });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.segments).toBeUndefined();
  });

  test('manual-mode task with segments DOES emit segments', () => {
    const t = makeTask('manual-split', {
      scheduleMode: 'manual',
      segments: [SEG1, SEG2],
    });
    const result = toSvarTask(t, undefined, undefined);
    expect(result.segments).toBeDefined();
    expect(result.segments).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// F6 — projectHasSplitTasks: must only count manual-mode split tasks
// ---------------------------------------------------------------------------

describe('projectHasSplitTasks — F6: auto-mode segments do not trigger split mode', () => {
  test('auto-mode task with segments does NOT count as a split task', () => {
    const tasks: Task[] = [
      makeTask('auto-split', { scheduleMode: 'auto', segments: [SEG1, SEG2] }),
    ];
    expect(projectHasSplitTasks(tasks)).toBe(false);
  });

  test('manual-mode task with segments counts as a split task', () => {
    const tasks: Task[] = [
      makeTask('manual-split', { scheduleMode: 'manual', segments: [SEG1, SEG2] }),
    ];
    expect(projectHasSplitTasks(tasks)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F8 — edit-preview phantom must NOT be emitted for unscheduled tasks
// ---------------------------------------------------------------------------

describe('buildSvarTasks — F8: no edit-preview phantom for unscheduled tasks', () => {
  test('unscheduled task with differing ghost dates emits no edit-preview phantom', () => {
    const uTask = makeTask('u', { unscheduled: true });
    const ghostStart = new Date(2026, 0, 12, 8, 0);
    const ghostEnd = new Date(2026, 0, 12, 17, 0);
    const ghostTask = makeTask('u', {
      unscheduled: true,
      start: ghostStart,
      end: ghostEnd,
    });
    const ghostProject = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [ghostTask],
      links: [],
      resources: [],
      calendars: [standardCalendar],
      baselines: [],
      assignments: [],
    };
    const result = buildSvarTasks([uTask], [], standardCalendar, false, ghostProject);
    const editPreviews = result.filter((r) => r.is_edit_preview);
    expect(editPreviews).toHaveLength(0);
  });
});

describe('toSvarTask — deadline', () => {
  const cal: Calendar = {
    id: 'std',
    name: 'std',
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
  const base: Task = {
    id: 'a',
    text: 'A',
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 17, 0),
    progress: 0,
  };

  test('maps deadline + computed annotation to snake_case fields', () => {
    const t: Task = {
      ...base,
      deadline: new Date(2026, 0, 6, 17, 0),
      computed: {
        earlyStart: base.start,
        earlyFinish: base.end,
        lateStart: base.start,
        lateFinish: base.end,
        totalSlack: 0,
        freeSlack: 0,
        isCritical: true,
        deadlineMissed: false,
        deadlineSlackMinutes: 540,
      },
    };
    const svar = toSvarTask(t, cal);
    expect(svar.deadline).toEqual(t.deadline);
    expect(svar.deadline_missed).toBe(false);
    expect(svar.deadline_slack).toBe(540);
  });

  test('task without a deadline has deadline_missed false and deadline_slack 0', () => {
    const svar = toSvarTask(base, cal);
    expect(svar.deadline).toBeUndefined();
    expect(svar.deadline_missed).toBe(false);
    expect(svar.deadline_slack).toBe(0);
  });
});

import type { Baseline } from '@pyraxi/cpm-engine';
import { makeBaselinePhantom } from './svar-adapter.js';

describe('makeBaselinePhantom duration unit — axis-latch fix (CM 2026-07-04)', () => {
  test('converts baseline snapshot duration from working-minutes to SVAR working-days', () => {
    // standardCalendar = 540 working minutes/day. A 30-working-day baseline snapshot
    // stores duration in MINUTES (30 * 540 = 16200), per the engine's minute model.
    const t = makeTask('a');
    const baseline: Baseline = {
      index: 0,
      capturedAt: new Date(2026, 0, 1),
      tasks: new Map([
        ['a', { start: START, end: new Date(2026, 1, 16, 17, 0), duration: 30 * 540 }],
      ]),
    };
    const phantom = makeBaselinePhantom(t, baseline, standardCalendar);
    expect(phantom).not.toBeNull();
    // MUST be 30 (days) — NOT the raw 16200 minutes. If SVAR receives 16200 it reads it
    // as day-units and its auto-scale computes an end ~40 years out (Jan 2066), which its
    // expand-only `_end` bound then latches until reload.
    expect(phantom?.duration).toBe(30);
  });
});

describe('edit-preview phantom duration unit — axis-latch fix (CM vetoed-add blow-out)', () => {
  test('edit-preview phantom converts ghost duration from working-minutes to SVAR working-days', () => {
    // Same defect class as the baseline-ghost axis-latch, on the live inline-edit
    // preview path. A user edits a task's (or a freshly-added task's) duration/start;
    // usePreviewEngine emits a recomputed ghost. Its duration is in engine MINUTES
    // (30 working days = 30 * 540 = 16200). If the phantom forwards raw minutes, SVAR
    // reads 16200 as day-units → auto-scales ~40 years out → expand-only `_end` latches.
    const live = makeTask('a');
    const ghost = makeTask('a', {
      start: new Date(2026, 0, 12, 8, 0),
      end: new Date(2026, 1, 16, 17, 0),
      duration: 30 * 540,
    });
    const ghostProject: Project = {
      start: START,
      defaultCalendarId: 'std',
      tasks: [ghost],
      links: [],
      resources: [],
      calendars: [standardCalendar],
      baselines: [],
      assignments: [],
    };
    const result = buildSvarTasks([live], [], standardCalendar, false, ghostProject);
    const preview = result.find((r) => r.is_edit_preview);
    expect(preview).toBeDefined();
    // MUST be 30 (days) — NOT the raw 16200 minutes.
    expect(preview?.duration).toBe(30);
  });
});

import { isPhantomRowId } from './svar-adapter.js';

describe('isPhantomRowId — phantom-row id guard for the event bridges', () => {
  test('baseline ghost ids match', () => {
    expect(isPhantomRowId('t1__baseline_0')).toBe(true);
    expect(isPhantomRowId('some-uuid__baseline_12')).toBe(true);
  });
  test('edit-preview ids match', () => {
    expect(isPhantomRowId('t1__edit_preview')).toBe(true);
  });
  test('real task ids do not match', () => {
    expect(isPhantomRowId('t1')).toBe(false);
    expect(isPhantomRowId('task__baseline_')).toBe(false); // no index
    expect(isPhantomRowId('a__edit_previewX')).toBe(false); // not a suffix
    expect(isPhantomRowId(42)).toBe(false);
  });
  test('null/undefined are safe', () => {
    expect(isPhantomRowId(null)).toBe(false);
    expect(isPhantomRowId(undefined)).toBe(false);
  });
});
