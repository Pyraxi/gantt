import { describe, expect, test } from 'vitest';
import { topologicalSort } from './topological-sort';
import type { Link, Task } from './types';

// Helper builders to keep tests readable
function task(id: string): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 480,
    start: new Date(2026, 0, 1),
    end: new Date(2026, 0, 1),
    progress: 0,
  };
}

function fs(source: string, target: string): Link {
  return { id: `${source}-${target}`, source, target, type: 'FS', lag: 0 };
}

describe('topologicalSort', () => {
  test('empty input returns empty order', () => {
    expect(topologicalSort([], [])).toEqual([]);
  });

  test('single task with no links returns just that task', () => {
    const a = task('a');
    expect(topologicalSort([a], [])).toEqual([a]);
  });

  test('A → B (FS link) puts A before B', () => {
    const a = task('a');
    const b = task('b');
    const result = topologicalSort([b, a], [fs('a', 'b')]);
    expect(result.map((t) => t.id)).toEqual(['a', 'b']);
  });

  test('linear chain A → B → C → D sorts in order', () => {
    const tasks = ['d', 'a', 'c', 'b'].map(task);
    const links = [fs('a', 'b'), fs('b', 'c'), fs('c', 'd')];
    expect(topologicalSort(tasks, links).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('diamond A → B, A → C, B → D, C → D puts A first and D last', () => {
    const tasks = ['a', 'b', 'c', 'd'].map(task);
    const links = [fs('a', 'b'), fs('a', 'c'), fs('b', 'd'), fs('c', 'd')];
    const sorted = topologicalSort(tasks, links).map((t) => t.id);
    expect(sorted[0]).toBe('a');
    expect(sorted[sorted.length - 1]).toBe('d');
    expect(sorted.indexOf('b')).toBeLessThan(sorted.indexOf('d'));
    expect(sorted.indexOf('c')).toBeLessThan(sorted.indexOf('d'));
  });

  test('throws on a cycle A → B → A', () => {
    const tasks = ['a', 'b'].map(task);
    const links = [fs('a', 'b'), fs('b', 'a')];
    expect(() => topologicalSort(tasks, links)).toThrow(/cycle/i);
  });

  test('SS/FF/SF links also establish ordering (predecessor before successor)', () => {
    const a = task('a');
    const b = task('b');
    const ss: Link = { id: 'ss', source: 'a', target: 'b', type: 'SS', lag: 0 };
    expect(topologicalSort([b, a], [ss]).map((t) => t.id)).toEqual(['a', 'b']);
  });
});
