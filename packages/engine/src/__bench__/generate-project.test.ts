import { describe, expect, test } from 'vitest';
import { generateProject } from './generate-project';

describe('generateProject', () => {
  test('produces the requested leaf-task count', () => {
    const p = generateProject({ leafCount: 100, phases: 5 });
    const leaves = p.tasks.filter((t) => t.type === 'task');
    expect(leaves).toHaveLength(100);
  });

  test('every leaf sits under a summary phase', () => {
    const p = generateProject({ leafCount: 60, phases: 6 });
    const summaryIds = new Set(p.tasks.filter((t) => t.type === 'summary').map((t) => t.id));
    const leaves = p.tasks.filter((t) => t.type === 'task');
    expect(leaves.every((t) => t.parent !== undefined && summaryIds.has(t.parent))).toBe(true);
  });

  test('chains leaves with FS links so the engine has real cascade work', () => {
    const p = generateProject({ leafCount: 50, phases: 5 });
    // one fewer link than leaves per phase (intra-phase chain), no cross-phase
    expect(p.links.length).toBeGreaterThanOrEqual(
      p.tasks.filter((t) => t.type === 'task').length - 5,
    );
    expect(p.links.every((l) => l.type === 'FS')).toBe(true);
  });

  test('is deterministic for a fixed seed', () => {
    const a = generateProject({ leafCount: 30, phases: 3, seed: 7 });
    const b = generateProject({ leafCount: 30, phases: 3, seed: 7 });
    expect(JSON.stringify(a.tasks.map((t) => t.id))).toBe(JSON.stringify(b.tasks.map((t) => t.id)));
  });
});
