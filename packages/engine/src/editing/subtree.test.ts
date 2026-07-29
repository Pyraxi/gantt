import { describe, expect, test } from 'vitest';
import type { Link, Project, Task } from '../types.js';
import { copySubtree, pasteSubtree } from './subtree.js';

function task(id: string, parent?: string): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: new Date(2026, 0, 5),
    end: new Date(2026, 0, 5),
    progress: 0,
    ...(parent ? { parent } : {}),
  };
}
function fs(id: string, s: string, t: string): Link {
  return { id, source: s, target: t, type: 'FS', lag: 0 };
}
function project(tasks: Task[], links: Link[]): Project {
  return {
    start: new Date(2026, 0, 5),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [],
    baselines: [],
    assignments: [],
  };
}

describe('copySubtree', () => {
  test('collects root + descendants and internal links only', () => {
    const p = project(
      [task('a'), task('a1', 'a'), task('a2', 'a'), task('b')],
      [fs('l1', 'a1', 'a2'), fs('l2', 'a2', 'b')], // l2 crosses the boundary
    );
    const clip = copySubtree(p, 'a');
    expect(clip.tasks.map((t) => t.id).sort()).toEqual(['a', 'a1', 'a2']);
    expect(clip.links.map((l) => l.id)).toEqual(['l1']); // l2 dropped
  });
});

describe('pasteSubtree', () => {
  test('clones with fresh ids, remaps parent + links, inserts under parent', () => {
    const p = project([task('a'), task('a1', 'a')], [fs('l1', 'a', 'a1')]);
    const clip = copySubtree(p, 'a');
    let n = 0;
    const idGen = (old: string | number) => `copy-${old}-${n++}`;
    const out = pasteSubtree(clip, { idGen }).apply(p);

    const cloneRoot = out.tasks.find((t) => t.id === 'copy-a-0')!;
    const cloneChild = out.tasks.find((t) => t.id === 'copy-a1-1')!;
    expect(cloneRoot).toBeDefined();
    expect(cloneChild.parent).toBe('copy-a-0'); // remapped, not the original 'a'
    const cloneLink = out.links.find((l) => l.id === 'copy-l1-2')!;
    expect(cloneLink.source).toBe('copy-a-0');
    expect(cloneLink.target).toBe('copy-a1-1');
    // originals untouched
    expect(out.tasks.find((t) => t.id === 'a')).toBeDefined();
  });

  test('root-not-first in clipboard array (moveTask-produced shape) still identifies the correct root', () => {
    // Shape mirrors what moveTask('X', 'down') produces: children precede
    // their own summary parent in project.tasks order. 'external' is an
    // unrelated top-level task used as the paste target parent, so a
    // misidentified root is observable (not masked by both landing on
    // "undefined" by coincidence).
    const p = project(
      [task('m1', 'X'), task('m2', 'X'), task('X', undefined, 'summary'), task('external')],
      [],
    );
    const clip = copySubtree(p, 'X');
    let n = 0;
    const idGen = (old: string | number) => `copy-${old}-${n++}`;
    const out = pasteSubtree(clip, { parent: 'external', idGen }).apply(p);

    const cloneX = out.tasks.find((t) => t.text === 'X' && t.id !== 'X')!;
    const cloneM1 = out.tasks.find((t) => t.text === 'm1' && t.id !== 'm1')!;
    const cloneM2 = out.tasks.find((t) => t.text === 'm2' && t.id !== 'm2')!;
    expect(cloneX).toBeDefined();
    expect(cloneM1).toBeDefined();
    expect(cloneM2).toBeDefined();
    // The CLONE of X (the real root) is the one re-parented to opts.parent.
    expect(cloneX.parent).toBe('external');
    // Child clones must point at the CLONE of X, not opts.parent and not the
    // original 'X' id. This is the assertion that catches array-order bugs:
    // if the root were misidentified as clip.tasks[0] ('m1'), cloneM1 would
    // incorrectly land on opts.parent instead of cloneX.id.
    expect(cloneM1.parent).toBe(cloneX.id);
    expect(cloneM2.parent).toBe(cloneX.id);
    expect(cloneM1.parent).not.toBe('external');
    expect(cloneM2.parent).not.toBe('X');
  });

  test('depth-3 hierarchy: grandchild parent chain remaps through clones', () => {
    const p = project(
      [
        task('root', undefined, 'summary'),
        task('child', 'root', 'summary'),
        task('grandchild', 'child'),
      ],
      [],
    );
    const clip = copySubtree(p, 'root');
    let n = 0;
    const idGen = (old: string | number) => `copy-${old}-${n++}`;
    const out = pasteSubtree(clip, { idGen }).apply(p);

    const cloneRoot = out.tasks.find((t) => t.text === 'root' && t.id !== 'root')!;
    const cloneChild = out.tasks.find((t) => t.text === 'child' && t.id !== 'child')!;
    const cloneGrandchild = out.tasks.find(
      (t) => t.text === 'grandchild' && t.id !== 'grandchild',
    )!;
    expect(cloneChild.parent).toBe(cloneRoot.id);
    expect(cloneGrandchild.parent).toBe(cloneChild.id);
  });

  test('insertAfter positions the first clone immediately after the target task', () => {
    const p = project([task('x'), task('y'), task('a'), task('a1', 'a')], [fs('l1', 'a', 'a1')]);
    const clip = copySubtree(p, 'a');
    let n = 0;
    const idGen = (old: string | number) => `copy-${old}-${n++}`;
    const out = pasteSubtree(clip, { insertAfter: 'y', idGen }).apply(p);

    const yIdx = out.tasks.findIndex((t) => t.id === 'y');
    expect(out.tasks[yIdx + 1].id).toBe('copy-a-0');
  });

  test('duplicate cloned link id throws EditError', () => {
    const p = project(
      [task('a'), task('a1', 'a')],
      [fs('l1', 'a', 'a1'), fs('existing', 'a', 'a1')],
    );
    const clip = copySubtree(p, 'a');
    let n = 0;
    // Force the generated link id to collide with an id already present on the project.
    const idGen = (old: string | number) => {
      if (old === 'l1') return 'existing';
      return `copy-${old}-${n++}`;
    };
    expect(() => pasteSubtree(clip, { idGen }).apply(p)).toThrow();
  });
});
