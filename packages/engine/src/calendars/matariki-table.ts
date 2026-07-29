/**
 * Matariki observance dates per the Te Kāhui o Matariki Public Holiday Act
 * 2022, Schedule 1. Pre-announced for 30 years (2022–2052); the Act sets
 * each date explicitly rather than via formula.
 *
 * Primary source: Te Kāhui o Matariki Public Holiday Act 2022, Schedule 1
 *   https://www.legislation.govt.nz/act/public/2022/0014/latest/whole.html
 *   (legislation.govt.nz returned HTTP 403 to WebFetch; cross-referenced via:)
 *
 * Verified sources used during implementation:
 *   1. https://raw.githubusercontent.com/commenthol/date-holidays/master/data/countries/NZ.yaml
 *      (date-holidays library, tracks official NZ public holiday data)
 *   2. https://github.com/commenthol/date-holidays/blob/master/data/countries/NZ.yaml
 *      (same data, HTML view — identical 31-entry list)
 *   3. Wikipedia "Matariki" article (2022–2035 confirmed matching)
 *   4. Local JS Date validation: all 31 entries confirmed as Friday, June/July
 *
 * Every entry was verified to be a Friday falling in June or July. A typo
 * here is invisible to typecheck and rule-tests — it produces a silent
 * wrong-date bug for every consumer in the affected year.
 */

export const MATARIKI_RANGE = { minYear: 2022, maxYear: 2052 } as const;

// month is 1-indexed for readability against the Act text; converted to
// JS's 0-indexed month when constructing the Date.
const RAW: ReadonlyArray<readonly [year: number, month: number, day: number]> = [
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

export const MATARIKI_DATES: Readonly<Record<number, Date>> = Object.freeze(
  Object.fromEntries(RAW.map(([y, m, d]) => [y, new Date(y, m - 1, d)])),
);
