import { describe, expect, test } from 'vitest';
import { computeEasterSunday } from './computus.js';

describe('computeEasterSunday', () => {
  // Reference dates: Anonymous Gregorian algorithm output, cross-checked
  // against published ecclesiastical Easter dates.
  const KNOWN: ReadonlyArray<readonly [year: number, month: number, day: number]> = [
    [2020, 4, 12], // Apr 12 2020
    [2021, 4, 4], // Apr 4  2021
    [2022, 4, 17], // Apr 17 2022
    [2023, 4, 9], // Apr 9  2023
    [2024, 3, 31], // Mar 31 2024
    [2025, 4, 20], // Apr 20 2025
    [2026, 4, 5], // Apr 5  2026  ← spec acceptance criterion
    [2027, 3, 28], // Mar 28 2027
    [2028, 4, 16], // Apr 16 2028
    [2029, 4, 1], // Apr 1  2029
    [2030, 4, 21], // Apr 21 2030
  ];

  for (const [year, month, day] of KNOWN) {
    test(`returns ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, () => {
      const result = computeEasterSunday(year);
      expect(result.getFullYear()).toBe(year);
      expect(result.getMonth()).toBe(month - 1); // JS months are 0-indexed
      expect(result.getDate()).toBe(day);
    });
  }
});
