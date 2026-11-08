// Task badges + previous-start markers (CM #672: make-ready badges, slip ghost):
// generic host indicators on bars, drawn from SVAR's own bar geometry.
import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, expect, test, vi } from 'vitest';
import { exportViewProps } from './export/export-props.js';
import { Gantt, type GanttViewState } from './Gantt.js';
import type { OverlayState } from './svar-overlay.js';
import type { PreviousStart, TaskBadge } from './task-badges.js';

type Row = { id: string; $x: number; $w: number; $y: number; $h: number };
type Api = { getState(): OverlayState & { _tasks: Row[] } };
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

const STD = { startMinutes: 480, endMinutes: 1020 };
const cal: Calendar = {
  id: 'std',
  name: 'Std',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};
const d = (day: number, h = 8) => new Date(2026, 0, day, h);
const t = (id: string, start: Date, days: number): Task => ({
  id,
  text: `Task ${id}`,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * 540,
  start,
  end: start,
  progress: 0,
  constraint: { type: 'SNET', date: start },
});
// B starts Thu 8 Jan (it was planned for Tue 6 Jan): a slip.
const project: Project = {
  start: d(5),
  defaultCalendarId: 'std',
  tasks: [t('A', d(12), 2), t('B', d(8), 2), t('C', d(13), 1)],
  links: [],
  resources: [],
  calendars: [cal],
  baselines: [],
  assignments: [],
};
const badges = (task: Task): TaskBadge[] | undefined =>
  task.id === 'A'
    ? [{ kind: 'readiness', label: '✓ Ready', tone: 'success' }]
    : task.id === 'B'
      ? [{ kind: 'readiness', label: '⚠ Not ready', tone: 'warning', title: 'Crane not booked' }]
      : undefined;
const previous = (task: Task): PreviousStart | undefined =>
  task.id === 'B' ? { date: d(6), pending: true, kind: 'slip' } : undefined;
const row = (id: string) => captured.api?.getState()._tasks.find((r) => String(r.id) === id) as Row;

test('badges sit just before each bar start, labelled, toned, with an accessible name', () => {
  const { container } = render(<Gantt project={project} taskBadges={badges} />);
  const groups = [...container.querySelectorAll<HTMLElement>('.construction-gantt-badges')];
  expect(groups.map((g) => g.dataset.taskId)).toEqual(['A', 'B']);
  const a = groups[0] as HTMLElement;
  expect(a.style.right).toBe(`calc(100% - ${row('A').$x - 4}px)`);
  // Clear of the bar's midline, where links meet it.
  expect(Number.parseFloat(a.style.top) + 14).toBeLessThanOrEqual(
    row('A').$y + row('A').$h / 2 - 5,
  );
  const badgeB = groups[1]?.querySelector('button') as HTMLButtonElement;
  expect(badgeB.textContent).toBe('⚠ Not ready');
  expect(badgeB.dataset.tone).toBe('warning');
  expect(badgeB.title).toBe('Crane not booked');
  expect(badgeB.getAttribute('aria-label')).toBe('Task B: Crane not booked');
});

test('a bar near the timeline start gets its badges after the bar instead', () => {
  const early: Project = { ...project, tasks: [t('A', d(5), 2)] };
  const { container } = render(<Gantt project={early} taskBadges={badges} />);
  const g = container.querySelector<HTMLElement>('.construction-gantt-badges') as HTMLElement;
  expect(g.style.right).toBe('');
  expect(g.style.left).toBe(`${row('A').$x + row('A').$w + 4}px`);
});

test('previous start: a marker at the old date joined to the bar; pending styled', () => {
  const { container } = render(<Gantt project={project} previousStart={previous} />);
  const line = container.querySelector<HTMLElement>('.construction-gantt-previous-start');
  const marker = container.querySelector<HTMLButtonElement>(
    '.construction-gantt-previous-start-marker',
  );
  expect(line?.dataset.taskId).toBe('B');
  expect(marker?.dataset.pending).toBe('true');
  expect(marker?.dataset.kind).toBe('slip');
  expect(marker?.textContent).toBe('?');
  expect(marker?.getAttribute('aria-label')).toContain('needs attention');
  // The line runs from the old start to the bar's start.
  const x = row('B').$x;
  const left = Number.parseFloat(line?.style.left ?? '');
  const width = Number.parseFloat(line?.style.width ?? '');
  expect(left + width).toBe(x);
  expect(width).toBeGreaterThan(0);
});

test('clicks report the task and kind', () => {
  const onClick = vi.fn();
  const { container } = render(
    <Gantt
      project={project}
      taskBadges={badges}
      previousStart={previous}
      onTaskBadgeClick={onClick}
    />,
  );
  fireEvent.click(container.querySelector('.construction-gantt-badge') as Element);
  fireEvent.click(container.querySelector('.construction-gantt-previous-start-marker') as Element);
  expect(onClick.mock.calls).toEqual([
    ['A', 'readiness'],
    ['B', 'slip'],
  ]);
});

test('off unless the props are set; displayOptions toggles hide them and report it', () => {
  expect(
    render(<Gantt project={project} displayOptions />).container.querySelector(
      '.construction-gantt-badges-layer',
    ),
  ).toBeNull();
  // No toggles for features the host doesn't use.
  expect(document.body.textContent).not.toContain('Previous starts');
  cleanup();
  const states: GanttViewState[] = [];
  const { container, getByLabelText } = render(
    <Gantt
      project={project}
      displayOptions
      taskBadges={badges}
      previousStart={previous}
      onViewStateChange={(s) => states.push(s)}
    />,
  );
  expect(container.querySelectorAll('.construction-gantt-badge')).toHaveLength(2);
  fireEvent.click(getByLabelText('Badges'));
  expect(container.querySelectorAll('.construction-gantt-badge')).toHaveLength(0);
  expect(container.querySelector('.construction-gantt-previous-start-marker')).not.toBeNull();
  expect(states.at(-1)).toMatchObject({ badges: false, previousStarts: true });
  fireEvent.click(getByLabelText('Previous starts'));
  expect(container.querySelector('.construction-gantt-badges-layer')).toBeNull();
  expect(states.at(-1)).toMatchObject({ badges: false, previousStarts: false });
});

test('exports drop badges / markers the view has hidden', () => {
  const base = {
    scheduled: project,
    props: { taskBadges: badges, previousStart: previous },
    columns: undefined,
    critical: true,
    slack: true,
    deadline: true,
    zoomLevel: undefined,
    selectedIds: [],
  };
  expect(exportViewProps({ ...base, badges: true }).ganttProps.taskBadges).toBe(badges);
  const hidden = exportViewProps({ ...base, badges: false, previousStarts: false }).ganttProps;
  expect(hidden.taskBadges).toBeUndefined();
  expect(hidden.previousStart).toBeUndefined();
});

test('an unscheduled task (SVAR lays it out but draws no bar) gets no badge or marker', () => {
  const p: Project = {
    ...project,
    tasks: [t('A', d(12), 2), { ...t('B', d(8), 2), unscheduled: true }],
  };
  const { container } = render(<Gantt project={p} taskBadges={badges} previousStart={previous} />);
  const ids = [...container.querySelectorAll<HTMLElement>('.construction-gantt-badges')].map(
    (g) => g.dataset.taskId,
  );
  expect(ids).toEqual(['A']);
  expect(container.querySelector('.construction-gantt-previous-start-marker')).toBeNull();
});

test('a milestone anchors on its diamond centre', () => {
  const m: Task = { ...t('M', d(12), 0), type: 'milestone', duration: 0 };
  const p: Project = { ...project, tasks: [m] };
  const prev = () => ({ date: d(7) });
  const { container } = render(<Gantt project={p} previousStart={prev} />);
  const r = row('M');
  const line = container.querySelector<HTMLElement>('.construction-gantt-previous-start');
  const right =
    Number.parseFloat(line?.style.left ?? '') + Number.parseFloat(line?.style.width ?? '');
  expect(right).toBe(r.$x + r.$h / 2);
});

test('a non-Date previous start (e.g. a JSON string) is skipped, not thrown', () => {
  const bad = () => ({ date: '2026-01-06' as unknown as Date });
  const { container } = render(<Gantt project={project} previousStart={bad} />);
  expect(container.querySelector('.construction-gantt-previous-start-marker')).toBeNull();
  expect(container.querySelector('.wx-bar')).not.toBeNull();
});

test('a badge click still reaches document listeners (outside-click closers)', () => {
  const onDoc = vi.fn();
  document.addEventListener('click', onDoc);
  try {
    const { container } = render(
      <Gantt project={project} taskBadges={badges} onTaskBadgeClick={() => {}} />,
    );
    fireEvent.click(container.querySelector('.construction-gantt-badge') as Element);
    expect(onDoc).toHaveBeenCalledTimes(1);
  } finally {
    document.removeEventListener('click', onDoc);
  }
});

test('only the rows SVAR renders get badges (row virtualisation)', () => {
  const many: Project = {
    ...project,
    tasks: Array.from({ length: 400 }, (_, i) => t(`T${i}`, d(12), 1)),
  };
  const all = () => [{ kind: 'k', label: 'x' }];
  const { container } = render(<Gantt project={many} height={300} taskBadges={all} />);
  const area = (captured.api?.getState() as unknown as { area: { start: number; end: number } })
    .area;
  const drawn = container.querySelectorAll('.construction-gantt-badges').length;
  expect(drawn).toBe(area.end - area.start);
  expect(drawn).toBeLessThan(400);
});
