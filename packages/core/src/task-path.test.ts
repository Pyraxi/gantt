import { analyseDriving, type Link, type Project, type Task } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { buildTaskPath, paintPathLinks } from './task-path.js';

// Parity row 5 (core). Spec: docs/superpowers/specs/2026-10-16-task-path-highlight-design.md

const MON = new Date(2026, 0, 5, 8);
const t = (id: string, days: number): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: days * 540,
  start: MON,
  end: MON,
  progress: 0,
});
const link = (s: string, d: string): Link => ({
  id: `${s}-${d}`,
  source: s,
  target: d,
  type: 'FS',
  lag: 0,
});
// a(3) → c(2) → e(1); b(1) → c has float, so only a drives c.
const project: Project = {
  start: MON,
  defaultCalendarId: 'std',
  tasks: [t('a', 3), t('b', 1), t('c', 2), t('e', 1)],
  links: [link('a', 'c'), link('b', 'c'), link('c', 'e')],
  resources: [],
  calendars: [
    {
      id: 'std',
      name: 'Std',
      workWeek: [[], ...Array(5).fill([{ startMinutes: 480, endMinutes: 1020 }]), []],
      exceptions: [],
    },
  ],
  baselines: [],
  assignments: [],
};
const an = analyseDriving(project);

const view = (focus: string | number | undefined, mode: 'driving' | 'driven' | 'both', a = an) =>
  buildTaskPath(a, focus, mode, 'scope');

describe('buildTaskPath', () => {
  test('driving: rings the drivers (not the focus task); driving links get the driving role', () => {
    const v = view('c', 'driving');
    const css = v?.css ?? '';
    expect(css).toContain('.scope .wx-bar.wx-bar:not(.wx-milestone)[data-id=":a"]');
    expect(css).toContain('.scope .wx-milestone[data-id=":a"] .wx-content');
    expect(css).not.toContain('data-id=":b"'); // b has float into c
    expect(css).not.toContain('data-id=":c"'); // focus unchanged
    expect(css).not.toContain('data-id=":e"');
    expect(css).toContain('var(--cg-path-driving-color,#ea580c)');
    expect(css).not.toContain('data-link-id'); // links are painted, not styled
    expect([...(v?.linkRoles ?? [])]).toEqual([['a-c', 'driving']]);
  });

  test('driven: the successors it drives; both: the two roles', () => {
    const driven = view('a', 'driven');
    expect(driven?.css).toContain('data-id=":c"');
    expect(driven?.css).toContain('data-id=":e"');
    expect(driven?.css).toContain('var(--cg-path-driven-color,#7c3aed)');
    expect(driven?.css).not.toContain('--cg-path-driving-color');
    expect([...(driven?.linkRoles ?? [])]).toEqual([
      ['a-c', 'driven'],
      ['c-e', 'driven'],
    ]);
    const both = view('c', 'both');
    expect(both?.css).toContain('--cg-path-driving-color');
    expect(both?.css).toContain('--cg-path-driven-color');
    expect(both?.linkRoles.get('c-e')).toBe('driven');
    expect(both?.linkRoles.get('a-c')).toBe('driving');
  });

  test('only the id form SVAR renders: numbers bare, strings prefixed; quotes escaped', () => {
    const p: Project = {
      ...project,
      tasks: [t('x"y', 1), { ...t('q', 1), id: 7 }],
      links: [{ id: 9, source: 'x"y', target: 7, type: 'FS', lag: 0 }],
    };
    const v = view(7, 'driving', analyseDriving(p));
    expect(v?.css).toContain('data-id=":x\\22 y"');
    expect(v?.css).not.toContain('data-id="x\\22 y"');
    expect(v?.linkRoles.get('9')).toBe('driving');
    const back = view('x"y', 'driven', analyseDriving(p));
    expect(back?.css).toContain('data-id="7"');
    expect(back?.css).not.toContain('data-id=":7"');
  });

  test('nothing to highlight → null (no focus, isolated task, unknown id)', () => {
    expect(view(undefined, 'both')).toBeNull();
    expect(view('b', 'driving')).toBeNull();
    expect(view('nope', 'both')).toBeNull();
  });
});

describe('paintPathLinks', () => {
  const svg = () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<svg class="wx-links"><polyline class="wx-line" data-link-id=":a-c"></polyline>' +
      '<polyline class="wx-line" data-link-id="9"></polyline>' +
      '<polyline class="wx-line" data-link-id=":c-e"></polyline></svg>';
    return root;
  };
  const stroke = (root: HTMLElement, i: number) =>
    (root.querySelectorAll('.wx-line')[i] as SVGElement).style.getPropertyValue('stroke');

  test('strokes path links by role (string and numeric ids), and clears them when off the path', () => {
    const root = svg();
    paintPathLinks(
      root,
      new Map([
        ['a-c', 'driving'],
        ['9', 'driven'],
      ]),
    );
    expect(stroke(root, 0)).toContain('--cg-path-driving-color');
    expect(stroke(root, 1)).toContain('--cg-path-driven-color');
    expect(stroke(root, 2)).toBe('');
    paintPathLinks(root, new Map([['c-e', 'driven']]));
    expect(stroke(root, 0)).toBe('');
    expect(stroke(root, 1)).toBe('');
    expect(stroke(root, 2)).toContain('--cg-path-driven-color');
    paintPathLinks(root, undefined);
    expect(stroke(root, 2)).toBe('');
  });
});
