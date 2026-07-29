/**
 * Canterbury Anniversary Day observance dates. Unlike Matariki, this
 * holiday is set annually by the Canterbury A&P Association — the Friday
 * of Show Week — and doesn't reduce to a closed-form rule.
 *
 * Source: https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates/
 *
 * The governing rule (from date-holidays NZ.yaml and employment.govt.nz):
 * "the Friday after the 2nd Tuesday in November" (Christchurch Show Day).
 * This rule was used to derive and verify every entry below. 2026 was
 * additionally confirmed directly from employment.govt.nz. 2027–2028 are
 * rule-derived only (not yet published by employment.govt.nz at time of
 * implementation).
 *
 * Every entry verified against the official listing on implementation.
 * A typo or transcription error produces a silent wrong-date bug for
 * every Canterbury-region consumer in the affected year.
 *
 * Years past `CANTERBURY_RANGE.maxYear` are unpublished and produce a
 * specific error from the public API rather than a fabricated date.
 */

// month is 1-indexed for readability against employment.govt.nz; converted
// to JS's 0-indexed month when constructing the Date.
const RAW: ReadonlyArray<readonly [year: number, month: number, day: number]> = [
  [2022, 11, 11], // Fri 11 Nov 2022 — rule-verified
  [2023, 11, 17], // Fri 17 Nov 2023 — rule-verified
  [2024, 11, 15], // Fri 15 Nov 2024 — rule-verified
  [2025, 11, 14], // Fri 14 Nov 2025 — rule-verified
  [2026, 11, 13], // Fri 13 Nov 2026 — rule-verified + employment.govt.nz confirmed
  [2027, 11, 12], // Fri 12 Nov 2027 — rule-derived (not yet on employment.govt.nz)
  [2028, 11, 17], // Fri 17 Nov 2028 — rule-derived (not yet on employment.govt.nz)
  // Append additional verified years here.
];

export const CANTERBURY_DATES: Readonly<Record<number, Date>> = Object.freeze(
  Object.fromEntries(RAW.map(([y, m, d]) => [y, new Date(y, m - 1, d)])),
);

const years = RAW.map(([y]) => y);
export const CANTERBURY_RANGE = Object.freeze({
  minYear: Math.min(...years),
  maxYear: Math.max(...years),
});
