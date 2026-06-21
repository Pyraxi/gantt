/**
 * MS Project-style duration entry/display for the grid's duration column.
 *
 * `Task.duration` is stored in working minutes. MS Project lets a user type a
 * value with a unit suffix (`1d`, `4h`, `30m`, `2w`, `1mo`) into the single
 * Duration column; these are unit conveniences over the same underlying
 * working-time quantity. We mirror that here.
 *
 * Unit lengths are FIXED entry constants (MS Project defaults: 1d = 8h,
 * 1w = 5d, 1mo = 20d), independent of any task's working calendar — the
 * calendar governs *scheduling*, not how a duration literal is interpreted.
 * Override via `DurationUnitMinutes` if a consumer's project options differ.
 */

export interface DurationUnitMinutes {
  minute: number;
  hour: number;
  day: number;
  week: number;
  month: number;
}

export const DEFAULT_DURATION_UNITS: DurationUnitMinutes = {
  minute: 1,
  hour: 60,
  day: 480, // 8h
  week: 2400, // 5d
  month: 9600, // 20d
};

// Longest aliases first so `mo`/`month` win over `m`, `hr` over `h`, etc.
const UNIT_ALIASES: ReadonlyArray<[RegExp, keyof DurationUnitMinutes]> = [
  [/^(months?|mo)$/, 'month'],
  [/^(weeks?|wks?|w)$/, 'week'],
  [/^(days?|d)$/, 'day'],
  [/^(hours?|hrs?|hr?|h)$/, 'hour'],
  [/^(minutes?|mins?|min|m)$/, 'minute'],
];

/**
 * Parse a duration literal into working minutes.
 *
 * Accepts a value plus optional unit suffix (`1d`, `1.5d`, `4h`, `30m`, `2w`,
 * `1mo`); whitespace-tolerant and case-insensitive. A bare number is treated
 * as days, preserving prior column behaviour. Returns null for anything
 * unparseable or negative.
 */
export function parseDuration(
  input: string,
  units: DurationUnitMinutes = DEFAULT_DURATION_UNITS,
): number | null {
  const trimmed = input.trim().toLowerCase();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]*)$/);
  if (match === null) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value < 0) return null;

  const suffix = match[2] ?? '';
  if (suffix === '') return Math.round(value * units.day);

  for (const [pattern, unit] of UNIT_ALIASES) {
    if (pattern.test(suffix)) return Math.round(value * units[unit]);
  }
  return null;
}

/**
 * Format working minutes back to the most natural single-unit literal.
 *
 * Picks the largest of day → hour → minute that divides evenly, so round
 * durations read cleanly (`480` → `1d`, `720` → `12h`, `30` → `30m`) without
 * ever losing precision. Weeks/months are entry conveniences only; display
 * stays in days for them (a week reads as `5d`).
 */
export function formatDuration(
  minutes: number,
  units: DurationUnitMinutes = DEFAULT_DURATION_UNITS,
): string {
  if (minutes === 0) return '0d';
  if (minutes % units.day === 0) return `${minutes / units.day}d`;
  if (minutes % units.hour === 0) return `${minutes / units.hour}h`;
  return `${minutes / units.minute}m`;
}
