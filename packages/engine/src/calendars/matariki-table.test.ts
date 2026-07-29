import { describe, expect, test } from 'vitest';
import { MATARIKI_DATES, MATARIKI_RANGE } from './matariki-table.js';

describe('MATARIKI_DATES', () => {
  test('covers 2022 through 2052 inclusive', () => {
    expect(MATARIKI_RANGE).toEqual({ minYear: 2022, maxYear: 2052 });
    for (let y = 2022; y <= 2052; y++) {
      expect(MATARIKI_DATES[y], `year ${y} present`).toBeInstanceOf(Date);
    }
  });

  test('every date is a Friday', () => {
    // Matariki is always observed on a Friday per the Act.
    for (let y = 2022; y <= 2052; y++) {
      const date = MATARIKI_DATES[y];
      expect(date.getDay(), `${y}: ${date.toISOString()} should be Friday`).toBe(5);
    }
  });

  test('every date falls in June or July', () => {
    for (let y = 2022; y <= 2052; y++) {
      const month = MATARIKI_DATES[y].getMonth();
      expect([5, 6], `${y} month should be Jun(5) or Jul(6); was ${month}`).toContain(month);
    }
  });

  // Per-year explicit assertions. Verified against:
  //   Te Kāhui o Matariki Public Holiday Act 2022, Schedule 1
  //   Source (raw YAML): https://raw.githubusercontent.com/commenthol/date-holidays/master/data/countries/NZ.yaml
  //   Cross-checked: Wikipedia "Matariki" article + date-holidays GitHub HTML view
  //   All 31 dates independently confirmed as Friday, June or July, via local JS Date validation.
  const VERIFIED: ReadonlyArray<readonly [year: number, month: number, day: number]> = [
    [2022, 6, 24], // Fri 24 Jun 2022
    [2023, 7, 14], // Fri 14 Jul 2023
    [2024, 6, 28], // Fri 28 Jun 2024
    [2025, 6, 20], // Fri 20 Jun 2025
    [2026, 7, 10], // Fri 10 Jul 2026
    [2027, 6, 25], // Fri 25 Jun 2027
    [2028, 7, 14], // Fri 14 Jul 2028
    [2029, 7, 6], // Fri  6 Jul 2029
    [2030, 6, 21], // Fri 21 Jun 2030
    [2031, 7, 11], // Fri 11 Jul 2031
    [2032, 7, 2], // Fri  2 Jul 2032
    [2033, 6, 24], // Fri 24 Jun 2033
    [2034, 7, 7], // Fri  7 Jul 2034
    [2035, 6, 29], // Fri 29 Jun 2035
    [2036, 7, 18], // Fri 18 Jul 2036
    [2037, 7, 10], // Fri 10 Jul 2037
    [2038, 6, 25], // Fri 25 Jun 2038
    [2039, 7, 15], // Fri 15 Jul 2039
    [2040, 7, 6], // Fri  6 Jul 2040
    [2041, 7, 19], // Fri 19 Jul 2041
    [2042, 7, 11], // Fri 11 Jul 2042
    [2043, 7, 3], // Fri  3 Jul 2043
    [2044, 6, 24], // Fri 24 Jun 2044
    [2045, 7, 7], // Fri  7 Jul 2045
    [2046, 6, 29], // Fri 29 Jun 2046
    [2047, 7, 19], // Fri 19 Jul 2047
    [2048, 7, 3], // Fri  3 Jul 2048
    [2049, 6, 25], // Fri 25 Jun 2049
    [2050, 7, 15], // Fri 15 Jul 2050
    [2051, 6, 30], // Fri 30 Jun 2051
    [2052, 6, 21], // Fri 21 Jun 2052
  ];

  for (const [year, month, day] of VERIFIED) {
    test(`${year} = ${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`, () => {
      const date = MATARIKI_DATES[year];
      expect(date.getFullYear()).toBe(year);
      expect(date.getMonth() + 1).toBe(month);
      expect(date.getDate()).toBe(day);
    });
  }
});
