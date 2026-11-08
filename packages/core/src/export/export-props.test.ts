import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Link, Project, Task } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { CG_THEME_TOKENS, exportViewProps } from './export-props.js';

const tk = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5, 8),
  end: new Date(2026, 0, 5, 17),
  progress: 0,
});
const links: Link[] = [
  { id: 'a->b', source: 'a', target: 'b', type: 'FS', lag: 0 },
  { id: 'b->c', source: 'b', target: 'c', type: 'FS', lag: 0 },
];
const scheduled: Project = {
  start: new Date(2026, 0, 5, 8),
  defaultCalendarId: 'std',
  tasks: ['a', 'b', 'c'].map(tk),
  links,
  resources: [],
  calendars: [],
  baselines: [],
  assignments: [],
};
const base = {
  scheduled,
  columns: undefined,
  critical: undefined,
  slack: undefined,
  deadline: undefined,
  zoomLevel: undefined,
  selectedIds: [] as string[],
};

describe('exportViewProps: the export renders the screen', () => {
  test('effective toggles and columns, not the raw props', () => {
    const cols = [{ id: 'text', field: 'text', header: 'Name' }] as never;
    const { ganttProps } = exportViewProps({
      ...base,
      props: { showCritical: true, showSlack: true, columns: [] },
      columns: cols,
      critical: false,
      slack: true,
      deadline: false,
    });
    expect(ganttProps).toMatchObject({
      columns: cols,
      showCritical: false,
      showSlack: true,
      showDeadline: false,
    });
  });

  test('the current zoom level becomes the export default', () => {
    const { ganttProps } = exportViewProps({
      ...base,
      props: { zoom: { levels: ['day', 'week', 'month'], default: 'day' } },
      zoomLevel: 'month',
    });
    expect(ganttProps.zoom).toEqual({ levels: ['day', 'week', 'month'], default: 'month' });
  });

  test('task path follows the selection; an explicit taskPathFor wins', () => {
    const sel = { ...base, selectedIds: ['a', 'b'] };
    expect(exportViewProps({ ...sel, props: { taskPath: 'both' } }).ganttProps.taskPathFor).toBe(
      'b',
    );
    expect(
      exportViewProps({ ...sel, props: { taskPath: 'both', taskPathFor: 'c' } }).ganttProps
        .taskPathFor,
    ).toBe('c');
    expect(exportViewProps({ ...sel, props: {} }).ganttProps.taskPathFor).toBeUndefined();
  });

  test('linkDisplay "selected": the selection’s links, drawn as all', () => {
    const out = exportViewProps({
      ...base,
      props: { linkDisplay: 'selected' },
      selectedIds: ['c'],
    });
    expect(out.ganttProps.linkDisplay).toBe('all');
    expect(out.scheduled.links.map((l) => l.id)).toEqual(['b->c']);
    // Nothing selected → no links, as on screen.
    expect(
      exportViewProps({ ...base, props: { linkDisplay: 'selected' } }).scheduled.links,
    ).toEqual([]);
    // With a task path, the path needs every link (a pre-filter would cut it
    // to one hop): all links are kept and drawn.
    const withPath = exportViewProps({
      ...base,
      props: { linkDisplay: 'selected', taskPath: 'driving' },
      selectedIds: ['c'],
    });
    expect(withPath.scheduled.links.map((l) => l.id)).toEqual(['a->b', 'b->c']);
    expect(withPath.ganttProps.linkDisplay).toBe('all');
    expect(withPath.ganttProps.taskPathFor).toBe('c');
    // Other modes pass through untouched.
    const crit = exportViewProps({ ...base, props: { linkDisplay: 'critical' } });
    expect(crit.ganttProps.linkDisplay).toBe('critical');
    expect(crit.scheduled).toBe(scheduled);
  });
});

describe('CG_THEME_TOKENS covers every --cg-* token the chart reads', () => {
  test('static tokens and pill kinds in src', () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), '..');
    const files = readdirSync(src, { recursive: true })
      .map(String)
      .filter((f) => /\.(ts|tsx|css)$/.test(f) && !/\.test\./.test(f));
    const used = new Set<string>();
    for (const f of files) {
      const text = readFileSync(join(src, f), 'utf8');
      for (const m of text.matchAll(/var\((--cg-[a-z0-9-]+)[,)]/g)) used.add(m[1] as string);
      for (const m of text.matchAll(/pillStyle\('([a-z-]+)'/g)) {
        used.add(`--cg-pill-${m[1]}-bg`);
        used.add(`--cg-pill-${m[1]}-color`);
      }
    }
    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((t) => !CG_THEME_TOKENS.includes(t))).toEqual([]);
  });
});
