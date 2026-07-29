import { describe, expect, test } from 'vitest';
import { inlineBaselineGeom } from './svar-adapter.js';

const d = (y: number, m: number, day: number) => new Date(y, m, day);

describe('inlineBaselineGeom', () => {
  test('on-plan (identical dates) → left 0, width 100', () => {
    const live = { start: d(2026, 0, 5), end: d(2026, 0, 15) };
    expect(inlineBaselineGeom(live, live)).toEqual({ leftPct: 0, widthPct: 100 });
  });
  test('baseline started earlier → negative left', () => {
    const live = { start: d(2026, 0, 11), end: d(2026, 0, 21) };
    const base = { start: d(2026, 0, 6), end: d(2026, 0, 16) };
    const g = inlineBaselineGeom(live, base)!;
    expect(g.leftPct).toBeCloseTo(-50, 5);
    expect(g.widthPct).toBeCloseTo(100, 5);
  });
  test('baseline shorter and later → positive left, width < 100', () => {
    const live = { start: d(2026, 0, 1), end: d(2026, 0, 11) };
    const base = { start: d(2026, 0, 6), end: d(2026, 0, 11) };
    const g = inlineBaselineGeom(live, base)!;
    expect(g.leftPct).toBeCloseTo(50, 5);
    expect(g.widthPct).toBeCloseTo(50, 5);
  });
  test('zero-span live (milestone) → null', () => {
    const t = d(2026, 0, 5);
    expect(inlineBaselineGeom({ start: t, end: t }, { start: t, end: t })).toBeNull();
  });
});
