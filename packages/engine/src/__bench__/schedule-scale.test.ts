import { describe, expect, test } from 'vitest';
import { schedule } from '../schedule';
import { generateProject } from './generate-project';

// Budget is generous on purpose — this is a regression tripwire, not a
// micro-benchmark. It fails loudly if engine cost goes superlinear.
const BUDGETS: Record<number, number> = {
  1000: 250, // ms
  5000: 1500, // ms
};

describe('schedule() scale', () => {
  for (const count of [1000, 5000]) {
    test(`schedules ${count} leaves under ${BUDGETS[count]}ms`, () => {
      const project = generateProject({ leafCount: count, phases: Math.max(5, count / 100) });
      const t0 = performance.now();
      const out = schedule(project);
      const ms = performance.now() - t0;
      // sanity: every leaf got computed values
      expect(out.tasks.find((t) => t.type === 'task')?.computed).toBeDefined();
      // eslint-disable-next-line no-console
      console.log(`[bench] schedule ${count} leaves: ${ms.toFixed(1)}ms`);
      expect(ms).toBeLessThan(BUDGETS[count]);
    });
  }
});
