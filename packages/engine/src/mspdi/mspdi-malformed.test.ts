// Malformed / partial MSPDI input robustness (2026-07-08 review, chunk 03 §P1 #11).
// The happy-path round-trip is covered in mspdi.test.ts; this file pins the
// graceful-degradation contract for inputs a genuine MS Project export (or a
// third-party MSPDI writer) can emit: no hard crashes, no Invalid Date / NaN in
// the model or serialized XML, and lossy drops reported via `droppedFields`.

import { describe, expect, test } from 'vitest';
import { parseMspdi } from './parse.js';
import { serializeMspdi } from './serialize.js';

const wrap = (tasksXml: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Project xmlns="http://schemas.microsoft.com/project">
  <Name>Malformed fixture</Name>
  <Tasks>
${tasksXml}
  </Tasks>
</Project>`;

const task = (uid: string, extra: string) => `    <Task>
      <UID>${uid}</UID>
      <ID>${uid}</ID>
      <Name>Task ${uid}</Name>
      <Start>2026-01-05T08:00:00</Start>
      <Finish>2026-01-05T17:00:00</Finish>
      <Duration>PT8H0M0S</Duration>
${extra}
    </Task>`;

describe('MSPDI malformed-input robustness', () => {
  test('F-2: non-numeric OutlineLevel degrades to level 1, never RangeError-crashes', () => {
    const xml = wrap(task('1', '      <OutlineLevel>abc</OutlineLevel>'));
    expect(() => parseMspdi(xml)).not.toThrow();
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]?.parent).toBeUndefined(); // clamped to top-level
    expect(droppedFields.some((d) => /OutlineLevel/.test(d.path))).toBe(true);
  });

  test('F-2b: absurdly large finite OutlineLevel does not RangeError-crash (outlineStack.length overflow)', () => {
    // Number.isFinite(5e9) is true, so the F-2 guard passed it through to
    // `outlineStack.length = 5e9` → RangeError: Invalid array length (JS caps
    // array length at 2^32-1). Must degrade to top-level + report instead.
    const xml = wrap(task('1', '      <OutlineLevel>5000000000</OutlineLevel>'));
    expect(() => parseMspdi(xml)).not.toThrow();
    const { project, droppedFields } = parseMspdi(xml);
    expect(project.tasks).toHaveLength(1);
    expect(project.tasks[0]?.parent).toBeUndefined();
    expect(droppedFields.some((d) => /OutlineLevel/.test(d.path))).toBe(true);
  });

  test('F-11: garbage ConstraintDate is dropped, never stored as Invalid Date', () => {
    const xml = wrap(
      task(
        '1',
        '      <ConstraintType>4</ConstraintType>\n      <ConstraintDate>not-a-date</ConstraintDate>',
      ),
    );
    const { project, droppedFields } = parseMspdi(xml);
    const c = project.tasks[0]?.constraint;
    expect(c?.type).toBe('SNET'); // constraint type still recognized
    expect(c?.date).toBeUndefined(); // invalid date dropped, no Invalid Date leaks
    expect(droppedFields.some((d) => /ConstraintDate/.test(d.path))).toBe(true);
  });

  test('F-1: a <Baseline> without Start/Finish never serializes NaN dates; reports dropped', () => {
    const xml = wrap(
      task(
        '1',
        '      <Baseline>\n        <Number>0</Number>\n        <Duration>PT8H0M0S</Duration>\n      </Baseline>',
      ),
    );
    const { project, droppedFields } = parseMspdi(xml);
    // The snapshot with no dates must be skipped, not carried as Invalid Date.
    expect(project.baselines.flatMap((b) => [...b.tasks.values()])).toEqual([]);
    const out = serializeMspdi(project);
    expect(out).not.toMatch(/NaN/);
    expect(droppedFields.some((d) => /Baseline\[\d+\]\.(Start|Finish)/.test(d.path))).toBe(true);
  });
});
