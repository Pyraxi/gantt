import { describe, expect, test } from 'vitest';
import { CANTERBURY_DATES, CANTERBURY_RANGE } from './canterbury-table.js';

describe('CANTERBURY_DATES', () => {
  test('exposes the supported year range', () => {
    expect(CANTERBURY_RANGE.minYear).toBe(2022);
    expect(CANTERBURY_RANGE.maxYear).toBeGreaterThanOrEqual(2026);
  });

  test('every entry is a Friday', () => {
    for (const year of Object.keys(CANTERBURY_DATES)) {
      const date = CANTERBURY_DATES[Number(year)];
      expect(date.getDay(), `${year}: should be Friday`).toBe(5);
    }
  });

  test('every entry falls in November', () => {
    for (const year of Object.keys(CANTERBURY_DATES)) {
      const date = CANTERBURY_DATES[Number(year)];
      expect(date.getMonth(), `${year}: should be November`).toBe(10);
    }
  });

  // Spot-check verified employment.govt.nz dates. Implementer must verify
  // each entry against the official listing before merging.
  const VERIFIED: ReadonlyArray<readonly [year: number, month: number, day: number]> = [
    [2022, 11, 11], // Fri 11 Nov 2022 — rule-verified
    [2023, 11, 17], // Fri 17 Nov 2023 — rule-verified
    [2024, 11, 15], // Fri 15 Nov 2024 — rule-verified
    [2025, 11, 14], // Fri 14 Nov 2025 — rule-verified
    [2026, 11, 13], // Fri 13 Nov 2026 — rule-verified + employment.govt.nz confirmed
    [2027, 11, 12], // Fri 12 Nov 2027 — rule-derived
    [2028, 11, 17], // Fri 17 Nov 2028 — rule-derived
  ];

  for (const [year, month, day] of VERIFIED) {
    test(`${year} = ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, () => {
      const date = CANTERBURY_DATES[year];
      expect(date, `year ${year} present`).toBeDefined();
      expect(date.getFullYear()).toBe(year);
      expect(date.getMonth() + 1).toBe(month);
      expect(date.getDate()).toBe(day);
    });
  }
});
