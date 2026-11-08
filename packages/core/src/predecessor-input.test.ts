import type { Link, Task } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { parsePredecessors } from './predecessor-input.js';
import { formatPredecessors } from './predecessors.js';

// Parity row 1 gap: typed predecessor input (MS Project / P6 "4FS+2d").

const tk = (id: string): Task => ({
  id,
  text: id,
  type: 'task',
  scheduleMode: 'auto',
  duration: 540,
  start: new Date(2026, 0, 5),
  end: new Date(2026, 0, 6),
  progress: 0,
});
const tasks = ['a', 'b', 'c', 'd'].map(tk); // rows 1..4
const opts = { tasks, minutesPerDay: 540, targetId: 'd' };

describe('parsePredecessors', () => {
  test('row numbers, types (FS default), working / percent / elapsed lags', () => {
    expect(parsePredecessors('1, 2SS+2d, 3FF-4h', opts)).toEqual({
      ok: true,
      preds: [
        { source: 'a', type: 'FS', lag: 0 },
        { source: 'b', type: 'SS', lag: 1080 },
        { source: 'c', type: 'FF', lag: -240 },
      ],
    });
    expect(parsePredecessors('1FS+50%, 2+3ed, 3SF+2 edays', opts)).toEqual({
      ok: true,
      preds: [
        { source: 'a', type: 'FS', lag: 0, lagPercent: 50 },
        { source: 'b', type: 'FS', lag: 4320, lagElapsed: true },
        { source: 'c', type: 'SF', lag: 2880, lagElapsed: true },
      ],
    });
    expect(parsePredecessors('2FS+1.5 days', opts)).toMatchObject({
      ok: true,
      preds: [{ lag: 810 }],
    });
    expect(parsePredecessors('', opts)).toEqual({ ok: true, preds: [] });
  });

  test('errors: unknown row, self, duplicates, bad lag', () => {
    expect(parsePredecessors('9', opts)).toMatchObject({ ok: false });
    expect(parsePredecessors('4', opts)).toMatchObject({ ok: false }); // d is row 4: itself
    expect(parsePredecessors('1, 1SS', opts)).toMatchObject({ ok: false });
    expect(parsePredecessors('1FS+soon', opts)).toMatchObject({ ok: false });
    expect(parsePredecessors('1XX', opts)).toMatchObject({ ok: false });
  });

  test('round-trips what formatPredecessors writes', () => {
    const links: Link[] = [
      { id: 'l1', source: 'a', target: 'd', type: 'FS', lag: 0 },
      { id: 'l2', source: 'b', target: 'd', type: 'SS', lag: 1080 },
      { id: 'l3', source: 'c', target: 'd', type: 'FF', lag: 0, lagPercent: -25, lagElapsed: true },
    ];
    const text = formatPredecessors('d', links, { tasks, minutesPerDay: 540 });
    const parsed = parsePredecessors(text, opts);
    expect(parsed).toEqual({
      ok: true,
      preds: [
        { source: 'a', type: 'FS', lag: 0 },
        { source: 'b', type: 'SS', lag: 1080 },
        { source: 'c', type: 'FF', lag: 0, lagPercent: -25, lagElapsed: true },
      ],
    });
  });

  test('refs are row numbers only: ids, hex and decimals are refused, not truncated', () => {
    // "boss" once parsed as task "bo" + SS; an id ending in "ff" lost it as a type.
    for (const text of ['boss', 'a', '3f2a9c1e-ff', '1.0', '0x2', '01x', '1+-2d']) {
      expect(parsePredecessors(text, opts)).toMatchObject({ ok: false });
    }
    expect(parsePredecessors('1+-2d', opts)).toMatchObject({ error: 'can\'t read "1+-2d"' });
  });

  test("a row resolves to the task's own id (numeric ids stay numbers)", () => {
    const numeric = [1, 2, 3].map((n) => ({ ...tk('x'), id: n }));
    expect(parsePredecessors('1, 2SS', { tasks: numeric, targetId: 3 })).toEqual({
      ok: true,
      preds: [
        { source: 1, type: 'FS', lag: 0 },
        { source: 2, type: 'SS', lag: 0 },
      ],
    });
  });

  test('every lag reads back exactly from its formatted text (untouched links never drift)', () => {
    // Lags that aren't whole days used to format as "+0.44 days" and come back 238.
    const lags: Link[] = [240, 60, 7, 100, 810, 540, -30, 1].map((lag, i) => ({
      id: `w${i}`,
      source: 'a',
      target: 'd',
      type: 'FS',
      lag,
    }));
    const elapsed: Link[] = [90, 720, 1440, 61].map((lag, i) => ({
      id: `e${i}`,
      source: 'a',
      target: 'd',
      type: 'FS',
      lag,
      lagElapsed: true,
    }));
    for (const link of [...lags, ...elapsed]) {
      const text = formatPredecessors('d', [link], { tasks, minutesPerDay: 540 });
      const parsed = parsePredecessors(text, opts);
      expect({ text, parsed }).toMatchObject({
        parsed: { ok: true, preds: [{ lag: link.lag }] },
      });
    }
    const show = (lag: number, lagElapsed?: boolean) =>
      formatPredecessors(
        'd',
        [{ id: 'l', source: 'a', target: 'd', type: 'FS', lag, lagElapsed }],
        {
          tasks,
          minutesPerDay: 540,
        },
      );
    expect([show(240), show(7), show(810), show(90, true)]).toEqual([
      '1FS+4 hrs',
      '1FS+7 mins',
      '1FS+1.5 days',
      '1FS+1.5 ehrs',
    ]);
  });
});
