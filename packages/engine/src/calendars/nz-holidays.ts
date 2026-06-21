// NZ public-holiday + regional-anniversary pre-seed for the working-time
// calendar engine. Hybrid generation: pure-TS rules for the holidays whose
// observed date reduces to a formula; small static tables for the ones
// that don't (Matariki — set by Act; Canterbury Show Day — set annually).
//
// Range supported: 2022 (Matariki Act adoption) through 2052 (last year
// the Act pre-announces). Calls outside that range throw RangeError.

import type { Calendar, CalendarException, CalendarId, WorkInterval } from '../types.js';
import { CANTERBURY_DATES, CANTERBURY_RANGE } from './canterbury-table.js';
import { computeEasterSunday } from './internal/computus.js';
import { mondayisePair, mondayiseSingle } from './internal/mondayisation.js';
import {
  firstMondayAfter,
  fridayBefore,
  nearestMondayTo,
  nthMondayOfMonth,
} from './internal/month-rules.js';
import { MATARIKI_DATES, MATARIKI_RANGE } from './matariki-table.js';

/**
 * The 13 statutory NZ regions with their own anniversary day, plus Northland
 * which observes Waitangi Day per Holidays Act 2003 (no extra exception
 * is added for `'northland'` — the region value is accepted, the
 * national-only set is returned).
 */
export type NZRegion =
  | 'auckland'
  | 'canterbury'
  | 'chatham-islands'
  | 'hawkes-bay'
  | 'marlborough'
  | 'nelson'
  | 'northland'
  | 'otago'
  | 'south-canterbury'
  | 'southland'
  | 'taranaki'
  | 'wellington'
  | 'westland';

export interface NZDefaultCalendarOptions {
  /** Year (single) or years (array). 2022 ≤ year ≤ 2052. Duplicates deduplicated. */
  years: number | number[];
  /** Optional regional anniversary on top of the 11 national holidays. */
  region?: NZRegion;
  /**
   * Override the default Mon–Fri 8am–5pm working week.
   * 7 entries, Sunday=0 … Saturday=6.
   */
  workWeek?: WorkInterval[][];
  /** Calendar.id. Default: 'nz-default'. */
  id?: CalendarId;
  /** Calendar.name. Default: 'New Zealand Standard'. */
  name?: string;
}

const MIN_YEAR = MATARIKI_RANGE.minYear; // 2022
const MAX_YEAR = MATARIKI_RANGE.maxYear; // 2052

const DEFAULT_INTERVAL: WorkInterval = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const DEFAULT_WORK_WEEK: WorkInterval[][] = [
  [], // Sun
  [DEFAULT_INTERVAL], // Mon
  [DEFAULT_INTERVAL], // Tue
  [DEFAULT_INTERVAL], // Wed
  [DEFAULT_INTERVAL], // Thu
  [DEFAULT_INTERVAL], // Fri
  [], // Sat
];

export function nzPublicHolidays(years: number | number[], region?: NZRegion): CalendarException[] {
  const yearList = normaliseYears(years);
  const all: CalendarException[] = [];
  for (const year of yearList) {
    all.push(...nationalHolidays(year));
    if (region) {
      const regional = regionalAnniversary(year, region);
      if (regional) all.push(regional);
    }
  }
  return all.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function normaliseYears(input: number | number[]): number[] {
  const list = Array.isArray(input) ? [...new Set(input)] : [input];
  for (const y of list) {
    if (y < MIN_YEAR || y > MAX_YEAR) {
      throw new RangeError(
        `nzPublicHolidays: year ${y} out of supported range ${MIN_YEAR}-${MAX_YEAR}. ` +
          `Range is bounded by the Te Kāhui o Matariki Public Holiday Act 2022 Schedule 1.`,
      );
    }
  }
  return list.sort((a, b) => a - b);
}

function nationalHolidays(year: number): CalendarException[] {
  const out: CalendarException[] = [];

  // New Year + 2 January (pair rule)
  const [ny, jan2] = mondayisePair(new Date(year, 0, 1), new Date(year, 0, 2));
  out.push(makeException(ny, "New Year's Day", new Date(year, 0, 1)));
  out.push(makeException(jan2, '2 January', new Date(year, 0, 2)));

  // Waitangi Day (single-day mondayisation)
  const waitangi = mondayiseSingle(new Date(year, 1, 6));
  out.push(makeException(waitangi, 'Waitangi Day', new Date(year, 1, 6)));

  // Good Friday + Easter Monday (Easter Sunday ± 2 / +1)
  const easterSun = computeEasterSunday(year);
  const goodFri = new Date(year, easterSun.getMonth(), easterSun.getDate() - 2);
  const easterMon = new Date(year, easterSun.getMonth(), easterSun.getDate() + 1);
  out.push(makeException(goodFri, 'Good Friday'));
  out.push(makeException(easterMon, 'Easter Monday'));

  // ANZAC Day (single-day mondayisation)
  const anzac = mondayiseSingle(new Date(year, 3, 25));
  out.push(makeException(anzac, 'ANZAC Day', new Date(year, 3, 25)));

  // King's Birthday (first Monday of June)
  out.push(makeException(nthMondayOfMonth(year, 5, 1), "King's Birthday"));

  // Matariki (static table — guaranteed in range by the gate above)
  // biome-ignore lint/style/noNonNullAssertion: year is range-gated 2022-2052; entry always present
  out.push(makeException(MATARIKI_DATES[year]!, 'Matariki'));

  // Labour Day (fourth Monday of October)
  out.push(makeException(nthMondayOfMonth(year, 9, 4), 'Labour Day'));

  // Christmas + Boxing Day (pair rule)
  const [christmas, boxing] = mondayisePair(new Date(year, 11, 25), new Date(year, 11, 26));
  out.push(makeException(christmas, 'Christmas Day', new Date(year, 11, 25)));
  out.push(makeException(boxing, 'Boxing Day', new Date(year, 11, 26)));

  return out;
}

function regionalAnniversary(year: number, region: NZRegion): CalendarException | null {
  switch (region) {
    case 'auckland':
      return makeException(nearestMondayTo(year, 0, 29), 'Auckland Anniversary');
    case 'wellington':
      return makeException(nearestMondayTo(year, 0, 22), 'Wellington Anniversary');
    case 'nelson':
      return makeException(nearestMondayTo(year, 1, 1), 'Nelson Anniversary');
    case 'otago':
      return makeException(nearestMondayTo(year, 2, 23), 'Otago Anniversary');
    case 'taranaki':
      return makeException(nthMondayOfMonth(year, 2, 2), 'Taranaki Anniversary');
    case 'southland': {
      const easterSun = computeEasterSunday(year);
      const easterTue = new Date(year, easterSun.getMonth(), easterSun.getDate() + 2);
      return makeException(easterTue, 'Southland Anniversary');
    }
    case 'south-canterbury':
      return makeException(nthMondayOfMonth(year, 8, 4), 'South Canterbury Anniversary');
    case 'hawkes-bay': {
      const labourDay = nthMondayOfMonth(year, 9, 4);
      return makeException(fridayBefore(labourDay), "Hawke's Bay Anniversary");
    }
    case 'marlborough': {
      const labourDay = nthMondayOfMonth(year, 9, 4);
      return makeException(firstMondayAfter(labourDay), 'Marlborough Anniversary');
    }
    case 'canterbury': {
      const date = CANTERBURY_DATES[year];
      if (!date) {
        throw new RangeError(
          `nzPublicHolidays: Canterbury Anniversary Day for ${year} is not in the verified ` +
            `static table (range ${CANTERBURY_RANGE.minYear}-${CANTERBURY_RANGE.maxYear}). ` +
            `Show Day is set annually by the Canterbury A&P Association; ` +
            `add the verified date from employment.govt.nz to canterbury-table.ts to extend coverage.`,
        );
      }
      return makeException(date, 'Canterbury Anniversary');
    }
    case 'westland':
      return makeException(nthMondayOfMonth(year, 11, 1), 'Westland Anniversary');
    case 'chatham-islands':
      return makeException(nearestMondayTo(year, 10, 30), 'Chatham Islands Anniversary');
    case 'northland':
      // Per Holidays Act 2003: Northland observes Waitangi Day as its
      // anniversary. No extra exception is added.
      return null;
  }
}

function makeException(
  observedDate: Date,
  baseName: string,
  statutoryDate?: Date,
): CalendarException {
  const moved =
    statutoryDate &&
    (observedDate.getFullYear() !== statutoryDate.getFullYear() ||
      observedDate.getMonth() !== statutoryDate.getMonth() ||
      observedDate.getDate() !== statutoryDate.getDate());
  return {
    date: new Date(observedDate.getFullYear(), observedDate.getMonth(), observedDate.getDate()),
    isWorking: false,
    name: moved ? `${baseName} (observed)` : baseName,
  };
}

export function nzDefaultCalendar(options: NZDefaultCalendarOptions): Calendar {
  const { years, region, workWeek, id, name } = options;
  return {
    id: id ?? 'nz-default',
    name: name ?? 'New Zealand Standard',
    workWeek: workWeek ?? DEFAULT_WORK_WEEK,
    exceptions: nzPublicHolidays(years, region),
  };
}
