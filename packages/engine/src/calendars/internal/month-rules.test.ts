import { describe, expect, test } from 'vitest';
import {
  firstMondayAfter,
  fridayBefore,
  nearestMondayTo,
  nthMondayOfMonth,
} from './month-rules.js';

describe('nthMondayOfMonth', () => {
  test("first Monday of June 2026 = Mon Jun 1 (King's Birthday)", () => {
    const d = nthMondayOfMonth(2026, 5, 1); // month=5 (June, zero-indexed)
    expect(d.getMonth()).toBe(5);
    expect(d.getDate()).toBe(1);
    expect(d.getDay()).toBe(1);
  });

  test('fourth Monday of October 2026 = Mon Oct 26 (Labour Day)', () => {
    const d = nthMondayOfMonth(2026, 9, 4); // month=9 (October)
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(26);
    expect(d.getDay()).toBe(1);
  });

  test('fourth Monday of September 2026 = Mon Sep 28 (South Canterbury)', () => {
    const d = nthMondayOfMonth(2026, 8, 4);
    expect(d.getMonth()).toBe(8);
    expect(d.getDate()).toBe(28);
    expect(d.getDay()).toBe(1);
  });

  test('second Monday of March 2026 = Mon Mar 9 (Taranaki)', () => {
    const d = nthMondayOfMonth(2026, 2, 2);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(9);
    expect(d.getDay()).toBe(1);
  });

  test('first Monday of December 2026 = Mon Dec 7 (Westland)', () => {
    const d = nthMondayOfMonth(2026, 11, 1);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(7);
    expect(d.getDay()).toBe(1);
  });
});

describe('firstMondayAfter', () => {
  test('first Monday strictly after Labour Day Mon Oct 26 2026 = Mon Nov 2 (Marlborough)', () => {
    const labourDay = new Date(2026, 9, 26);
    const d = firstMondayAfter(labourDay);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(2);
    expect(d.getDay()).toBe(1);
  });

  test('strictly after a Sunday returns the next day', () => {
    // 2026-11-01 = Sunday
    const d = firstMondayAfter(new Date(2026, 10, 1));
    expect(d.getDate()).toBe(2);
    expect(d.getDay()).toBe(1);
  });
});

describe('fridayBefore', () => {
  test("Friday immediately before Labour Day Mon Oct 26 2026 = Fri Oct 23 (Hawke's Bay)", () => {
    const labourDay = new Date(2026, 9, 26);
    const d = fridayBefore(labourDay);
    expect(d.getMonth()).toBe(9);
    expect(d.getDate()).toBe(23);
    expect(d.getDay()).toBe(5);
  });
});

describe('nearestMondayTo', () => {
  test('Jan 29 2026 (Thu) → Mon Jan 26 (Auckland)', () => {
    const d = nearestMondayTo(2026, 0, 29);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(26);
    expect(d.getDay()).toBe(1);
  });

  test('Jan 22 2026 (Thu) → Mon Jan 19 (Wellington)', () => {
    const d = nearestMondayTo(2026, 0, 22);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(19);
    expect(d.getDay()).toBe(1);
  });

  test('Feb 1 2026 (Sun) → Mon Feb 2 (Nelson)', () => {
    // 2026-02-01 = Sunday. Prev Mon = Jan 26 (6 days back). Next Mon = Feb 2 (1 day forward).
    // Next Mon is closer.
    const d = nearestMondayTo(2026, 1, 1);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(2);
    expect(d.getDay()).toBe(1);
  });

  test('Mar 23 2026 (Mon) → Mon Mar 23 itself (Otago)', () => {
    const d = nearestMondayTo(2026, 2, 23);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(23);
    expect(d.getDay()).toBe(1);
  });

  test('Nov 30 2026 (Mon) → Mon Nov 30 itself (Chatham Islands)', () => {
    const d = nearestMondayTo(2026, 10, 30);
    expect(d.getMonth()).toBe(10);
    expect(d.getDate()).toBe(30);
    expect(d.getDay()).toBe(1);
  });
});
