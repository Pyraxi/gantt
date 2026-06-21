import { describe, expect, test } from 'vitest';
import type { Calendar, CalendarException } from '../types.js';
import { addWorkingMinutes } from '../working-time.js';
import { nzDefaultCalendar, nzPublicHolidays } from './nz-holidays.js';

function expectException(
  exceptions: CalendarException[],
  isoDate: string, // YYYY-MM-DD
  nameMatch: string,
): void {
  const [year, month, day] = isoDate.split('-').map(Number);
  const found = exceptions.find(
    (ex) =>
      ex.date.getFullYear() === year &&
      ex.date.getMonth() === month - 1 &&
      ex.date.getDate() === day,
  );
  expect(found, `expected exception on ${isoDate} (${nameMatch})`).toBeDefined();
  expect(found?.isWorking).toBe(false);
  expect(found?.name).toContain(nameMatch);
}

describe('nzPublicHolidays — national (2026)', () => {
  // 2026 verification chosen because the spec's engine-seam acceptance
  // test exercises it; all dates cross-checked against
  // https://www.employment.govt.nz/leave-and-holidays/public-holidays/public-holidays-and-anniversary-dates/
  test('returns the 11 national observed dates for 2026', () => {
    const ex = nzPublicHolidays(2026);

    // National-only set (no region argument): 11 holidays
    expect(ex).toHaveLength(11);

    // Verified observed dates for 2026:
    expectException(ex, '2026-01-01', 'New Year'); // Thu — no mondayisation
    expectException(ex, '2026-01-02', '2 January'); // Fri — no mondayisation
    expectException(ex, '2026-02-06', 'Waitangi'); // Fri — no mondayisation
    expectException(ex, '2026-04-03', 'Good Friday'); // Apr 3
    expectException(ex, '2026-04-06', 'Easter Monday'); // Apr 6
    expectException(ex, '2026-04-27', 'ANZAC'); // Sat 25th → Mon 27 (observed)
    expectException(ex, '2026-06-01', 'King'); // 1st Mon of June
    expectException(ex, '2026-07-10', 'Matariki'); // Per Act
    expectException(ex, '2026-10-26', 'Labour'); // 4th Mon of Oct
    expectException(ex, '2026-12-25', 'Christmas'); // Fri — no mondayisation
    expectException(ex, '2026-12-28', 'Boxing'); // Sat 26 → Mon 28 (observed)
  });

  test('observed-date names include "(observed)" when mondayisation moved them', () => {
    const ex = nzPublicHolidays(2026);

    const anzac = ex.find(
      (e) => e.date.getFullYear() === 2026 && e.date.getMonth() === 3 && e.date.getDate() === 27,
    );
    expect(anzac?.name).toContain('(observed)');

    const newYears = ex.find(
      (e) => e.date.getFullYear() === 2026 && e.date.getMonth() === 0 && e.date.getDate() === 1,
    );
    expect(newYears?.name).not.toContain('(observed)');
  });

  test('result is sorted ascending by date', () => {
    const ex = nzPublicHolidays(2026);
    for (let i = 1; i < ex.length; i++) {
      expect(ex[i].date.getTime()).toBeGreaterThanOrEqual(ex[i - 1].date.getTime());
    }
  });
});

describe('nzPublicHolidays — regional (2026)', () => {
  test('auckland — adds Mon 26 Jan (nearest Mon to Jan 29)', () => {
    const ex = nzPublicHolidays(2026, 'auckland');
    expect(ex).toHaveLength(12);
    expectException(ex, '2026-01-26', 'Auckland');
  });

  test('wellington — adds Mon 19 Jan (nearest Mon to Jan 22)', () => {
    const ex = nzPublicHolidays(2026, 'wellington');
    expect(ex).toHaveLength(12);
    expectException(ex, '2026-01-19', 'Wellington');
  });

  test('nelson — adds Mon 2 Feb (nearest Mon to Feb 1)', () => {
    const ex = nzPublicHolidays(2026, 'nelson');
    expectException(ex, '2026-02-02', 'Nelson');
  });

  test('otago — adds Mon 23 Mar (nearest Mon to Mar 23)', () => {
    const ex = nzPublicHolidays(2026, 'otago');
    expectException(ex, '2026-03-23', 'Otago');
  });

  test('taranaki — adds Mon 9 Mar (2nd Mon of March)', () => {
    const ex = nzPublicHolidays(2026, 'taranaki');
    expectException(ex, '2026-03-09', 'Taranaki');
  });

  test('southland — adds Tue Apr 7 (Easter Tuesday)', () => {
    // Easter Mon 2026 = Apr 6 → Southland Anniversary = Tue Apr 7
    const ex = nzPublicHolidays(2026, 'southland');
    expectException(ex, '2026-04-07', 'Southland');
  });

  test('south-canterbury — adds Mon 28 Sep (4th Mon of Sep)', () => {
    const ex = nzPublicHolidays(2026, 'south-canterbury');
    expectException(ex, '2026-09-28', 'South Canterbury');
  });

  test('hawkes-bay — adds Fri 23 Oct (Friday before Labour Day Mon 26 Oct)', () => {
    const ex = nzPublicHolidays(2026, 'hawkes-bay');
    expectException(ex, '2026-10-23', 'Hawke');
  });

  test('marlborough — adds Mon 2 Nov (1st Mon after Labour Day)', () => {
    const ex = nzPublicHolidays(2026, 'marlborough');
    expectException(ex, '2026-11-02', 'Marlborough');
  });

  test('canterbury — adds Fri 13 Nov (from static table)', () => {
    const ex = nzPublicHolidays(2026, 'canterbury');
    expectException(ex, '2026-11-13', 'Canterbury');
  });

  test('chatham-islands — adds Mon 30 Nov (nearest Mon to Nov 30)', () => {
    const ex = nzPublicHolidays(2026, 'chatham-islands');
    expectException(ex, '2026-11-30', 'Chatham');
  });

  test('westland — adds Mon 7 Dec (1st Mon of Dec)', () => {
    const ex = nzPublicHolidays(2026, 'westland');
    expectException(ex, '2026-12-07', 'Westland');
  });

  test('northland — returns national-only (Waitangi serves as anniversary per Act)', () => {
    const ex = nzPublicHolidays(2026, 'northland');
    expect(ex).toHaveLength(11);
  });
});

describe('nzPublicHolidays — multi-year input', () => {
  test('accepts a number[] and concatenates the results sorted', () => {
    const ex = nzPublicHolidays([2026, 2027]);
    expect(ex.length).toBe(22); // 11 + 11

    // First half = 2026, second half = 2027 (after sorting by date)
    expect(ex[0].date.getFullYear()).toBe(2026);
    expect(ex[ex.length - 1].date.getFullYear()).toBe(2027);
  });

  test('deduplicates a repeated year', () => {
    const ex = nzPublicHolidays([2026, 2026]);
    expect(ex).toHaveLength(11);
  });
});

describe('nzPublicHolidays — range gating', () => {
  test('throws RangeError for year < 2022', () => {
    expect(() => nzPublicHolidays(2021)).toThrow(RangeError);
    expect(() => nzPublicHolidays(2021)).toThrow(/2022.*2052/);
    expect(() => nzPublicHolidays(2021)).toThrow(/2021/);
  });

  test('throws RangeError for year > 2052', () => {
    expect(() => nzPublicHolidays(2053)).toThrow(RangeError);
    expect(() => nzPublicHolidays(2053)).toThrow(/2022.*2052/);
  });

  test('throws RangeError if any year in the array is out of range', () => {
    expect(() => nzPublicHolidays([2026, 2053])).toThrow(RangeError);
  });

  test('throws a specific error for canterbury region in a year past the static table', () => {
    // Find a year inside [2022, 2052] but past CANTERBURY_RANGE.maxYear (2028).
    // 2030 is safely beyond.
    expect(() => nzPublicHolidays(2030, 'canterbury')).toThrow(/Canterbury/);
    expect(() => nzPublicHolidays(2030, 'canterbury')).toThrow(/2030/);
    // Non-canterbury regions still work for the same year:
    expect(() => nzPublicHolidays(2030, 'auckland')).not.toThrow();
  });
});

describe('nzDefaultCalendar', () => {
  test('returns a Calendar with Mon-Fri 8-5 default work week + 2026 Auckland holidays', () => {
    const cal: Calendar = nzDefaultCalendar({ years: 2026, region: 'auckland' });

    expect(cal.id).toBe('nz-default');
    expect(cal.name).toBe('New Zealand Standard');

    // workWeek: Sun = [], Mon-Fri = [{ 8*60, 17*60 }], Sat = []
    expect(cal.workWeek).toHaveLength(7);
    expect(cal.workWeek[0]).toEqual([]); // Sun
    expect(cal.workWeek[6]).toEqual([]); // Sat
    for (let dow = 1; dow <= 5; dow++) {
      expect(cal.workWeek[dow]).toEqual([{ startMinutes: 8 * 60, endMinutes: 17 * 60 }]);
    }

    // 11 national + 1 Auckland = 12
    expect(cal.exceptions).toHaveLength(12);
  });

  test('honours overrides for id, name, workWeek', () => {
    const cal: Calendar = nzDefaultCalendar({
      years: 2026,
      id: 'site-7',
      name: 'Auckland Site Calendar',
      workWeek: [
        [],
        [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
        [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
        [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
        [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
        [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
        [],
      ],
    });

    expect(cal.id).toBe('site-7');
    expect(cal.name).toBe('Auckland Site Calendar');
    expect(cal.workWeek[1]).toEqual([{ startMinutes: 7 * 60, endMinutes: 15 * 60 }]);
    // No region → 11 national exceptions
    expect(cal.exceptions).toHaveLength(11);
  });

  test('accepts a number[] for multi-year coverage', () => {
    const cal = nzDefaultCalendar({ years: [2026, 2027], region: 'wellington' });
    expect(cal.exceptions).toHaveLength(12 * 2);
  });
});

describe('nzDefaultCalendar — engine seam', () => {
  test('addWorkingMinutes skips weekend + observed ANZAC Day 2026', () => {
    // Fri 24 Apr 2026 17:00 (end of workday).
    // + 1 working minute should skip:
    //   Sat 25 Apr (weekend)
    //   Sun 26 Apr (weekend)
    //   Mon 27 Apr (ANZAC Day observed — statutory was Sat 25)
    // Landing at Tue 28 Apr 2026 08:01.
    const cal = nzDefaultCalendar({ years: 2026, region: 'auckland' });
    const start = new Date(2026, 3, 24, 17, 0);
    const result = addWorkingMinutes(start, 1, cal);

    expect(result.getFullYear()).toBe(2026);
    expect(result.getMonth()).toBe(3); // April
    expect(result.getDate()).toBe(28);
    expect(result.getHours()).toBe(8);
    expect(result.getMinutes()).toBe(1);
  });
});
