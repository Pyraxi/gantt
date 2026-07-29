import { describe, expect, test } from 'vitest';
import type { Calendar } from './types';
import {
  addWorkingMinutes,
  getDayWorkingMinutes,
  isWorkingDay,
  isWorkingTime,
  subtractWorkingMinutes,
} from './working-time';

const standardCalendar: Calendar = {
  id: 'standard',
  name: 'Standard 8-5 Mon-Fri',
  workWeek: [
    [], // Sun
    [{ startMinutes: 8 * 60, endMinutes: 17 * 60 }], // Mon
    [{ startMinutes: 8 * 60, endMinutes: 17 * 60 }], // Tue
    [{ startMinutes: 8 * 60, endMinutes: 17 * 60 }], // Wed
    [{ startMinutes: 8 * 60, endMinutes: 17 * 60 }], // Thu
    [{ startMinutes: 8 * 60, endMinutes: 17 * 60 }], // Fri
    [], // Sat
  ],
  exceptions: [],
};

describe('isWorkingDay', () => {
  test('returns true for Monday on a standard M-F calendar', () => {
    // 2026-01-05 is a Monday
    expect(isWorkingDay(new Date(2026, 0, 5), standardCalendar)).toBe(true);
  });

  test('returns false for Saturday on a standard M-F calendar', () => {
    // 2026-01-10 is a Saturday
    expect(isWorkingDay(new Date(2026, 0, 10), standardCalendar)).toBe(false);
  });

  test('non-working exception overrides a normally-working weekday (Christmas on a Friday)', () => {
    const withChristmas: Calendar = {
      ...standardCalendar,
      exceptions: [{ date: new Date(2026, 11, 25), isWorking: false, name: 'Christmas Day' }],
    };
    // 2026-12-25 is a Friday
    expect(isWorkingDay(new Date(2026, 11, 25), withChristmas)).toBe(false);
  });

  test('working exception overrides a normally-non-working weekend (Saturday makeup day)', () => {
    const withWorkingSaturday: Calendar = {
      ...standardCalendar,
      exceptions: [
        {
          date: new Date(2026, 0, 10),
          isWorking: true,
          intervals: [{ startMinutes: 8 * 60, endMinutes: 12 * 60 }],
          name: 'Saturday makeup',
        },
      ],
    };
    expect(isWorkingDay(new Date(2026, 0, 10), withWorkingSaturday)).toBe(true);
  });
});

describe('getDayWorkingMinutes', () => {
  test('returns 540 (9h) for a standard 8-5 weekday', () => {
    expect(getDayWorkingMinutes(new Date(2026, 0, 5), standardCalendar)).toBe(540);
  });

  test('returns 0 for a non-working weekend day on a standard calendar', () => {
    expect(getDayWorkingMinutes(new Date(2026, 0, 10), standardCalendar)).toBe(0);
  });

  test('returns 0 when a non-working exception applies (Christmas on a Friday)', () => {
    const withChristmas: Calendar = {
      ...standardCalendar,
      exceptions: [{ date: new Date(2026, 11, 25), isWorking: false, name: 'Christmas Day' }],
    };
    expect(getDayWorkingMinutes(new Date(2026, 11, 25), withChristmas)).toBe(0);
  });

  test('returns exception intervals sum when a working exception applies', () => {
    const withWorkingSaturday: Calendar = {
      ...standardCalendar,
      exceptions: [
        {
          date: new Date(2026, 0, 10),
          isWorking: true,
          intervals: [{ startMinutes: 8 * 60, endMinutes: 12 * 60 }],
          name: 'Saturday makeup',
        },
      ],
    };
    expect(getDayWorkingMinutes(new Date(2026, 0, 10), withWorkingSaturday)).toBe(240);
  });

  test('sums multiple intervals for a split-shift day (7-12 + 13-15 = 7h)', () => {
    const splitShiftCalendar: Calendar = {
      ...standardCalendar,
      workWeek: [
        [],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 },
          { startMinutes: 13 * 60, endMinutes: 15 * 60 },
        ],
        [],
        [],
        [],
        [],
        [],
      ],
    };
    // 2026-01-05 is a Monday
    expect(getDayWorkingMinutes(new Date(2026, 0, 5), splitShiftCalendar)).toBe(420);
  });
});

describe('addWorkingMinutes', () => {
  // 2026-01-05 = Mon, 2026-01-06 = Tue, ..., 2026-01-09 = Fri,
  // 2026-01-10 = Sat, 2026-01-11 = Sun, 2026-01-12 = Mon
  const mon8am = () => new Date(2026, 0, 5, 8, 0);

  test('adding 0 minutes returns the same instant', () => {
    expect(addWorkingMinutes(mon8am(), 0, standardCalendar).getTime()).toBe(mon8am().getTime());
  });

  test('adding 60 minutes mid-interval stays in the same day', () => {
    // Mon 10:00am + 60 min = Mon 11:00am
    const start = new Date(2026, 0, 5, 10, 0);
    expect(addWorkingMinutes(start, 60, standardCalendar)).toEqual(new Date(2026, 0, 5, 11, 0));
  });

  test('adding a full working day reaches the end of the working interval', () => {
    // Mon 8am + 540 min (9h) = Mon 5pm (end of working day)
    expect(addWorkingMinutes(mon8am(), 540, standardCalendar)).toEqual(new Date(2026, 0, 5, 17, 0));
  });

  test('rolls to the next working day when overflowing the current interval', () => {
    // Mon 4:30pm + 60 min: 30 min finishes Mon at 5pm, remaining 30 min picks up Tue 8am → Tue 8:30am
    const start = new Date(2026, 0, 5, 16, 30);
    expect(addWorkingMinutes(start, 60, standardCalendar)).toEqual(new Date(2026, 0, 6, 8, 30));
  });

  test('skips the weekend when crossing Friday end-of-day', () => {
    // Fri 4:30pm + 60 min: 30 min finishes Fri at 5pm; remaining 30 picks up Mon 8am → Mon 8:30am
    const start = new Date(2026, 0, 9, 16, 30);
    expect(addWorkingMinutes(start, 60, standardCalendar)).toEqual(new Date(2026, 0, 12, 8, 30));
  });

  test('adding 5 working days (2700 min) from Mon 8am lands on Fri 5pm', () => {
    expect(addWorkingMinutes(mon8am(), 5 * 540, standardCalendar)).toEqual(
      new Date(2026, 0, 9, 17, 0),
    );
  });

  test('skips a holiday exception when crossing it', () => {
    const withTuesHoliday: Calendar = {
      ...standardCalendar,
      exceptions: [{ date: new Date(2026, 0, 6), isWorking: false, name: 'Holiday' }],
    };
    // Mon 8am + 9h = Mon 5pm; +1 more minute should jump to Wed 8:01am (skip Tue holiday)
    expect(addWorkingMinutes(mon8am(), 540 + 1, withTuesHoliday)).toEqual(
      new Date(2026, 0, 7, 8, 1),
    );
  });

  test('skips a split-shift gap (lunch break)', () => {
    const splitShiftCalendar: Calendar = {
      ...standardCalendar,
      workWeek: [
        [],
        [
          { startMinutes: 7 * 60, endMinutes: 12 * 60 }, // 7am-12pm
          { startMinutes: 13 * 60, endMinutes: 17 * 60 }, // 1pm-5pm
        ],
        [],
        [],
        [],
        [],
        [],
      ],
    };
    // Mon 11:30am + 60 min: 30 min finishes morning at 12pm; remaining 30 picks up at 1pm → 1:30pm
    const start = new Date(2026, 0, 5, 11, 30);
    expect(addWorkingMinutes(start, 60, splitShiftCalendar)).toEqual(new Date(2026, 0, 5, 13, 30));
  });
});

describe('subtractWorkingMinutes', () => {
  test('subtracting 0 minutes returns the same instant', () => {
    const t = new Date(2026, 0, 5, 14, 0);
    expect(subtractWorkingMinutes(t, 0, standardCalendar).getTime()).toBe(t.getTime());
  });

  test('subtracting 60 mid-interval stays in the same day', () => {
    // Mon 11am - 60 min = Mon 10am
    const end = new Date(2026, 0, 5, 11, 0);
    expect(subtractWorkingMinutes(end, 60, standardCalendar)).toEqual(new Date(2026, 0, 5, 10, 0));
  });

  test('subtracting a full working day reaches the start of the working interval', () => {
    // Mon 5pm - 540 min = Mon 8am
    const end = new Date(2026, 0, 5, 17, 0);
    expect(subtractWorkingMinutes(end, 540, standardCalendar)).toEqual(new Date(2026, 0, 5, 8, 0));
  });

  test('rolls to the previous working day when underflowing the current interval', () => {
    // Tue 8:30am - 60 min: 30 min consumes Tue 8am→8:30am, remaining 30 picks up at Mon 5pm → Mon 4:30pm
    const end = new Date(2026, 0, 6, 8, 30);
    expect(subtractWorkingMinutes(end, 60, standardCalendar)).toEqual(new Date(2026, 0, 5, 16, 30));
  });

  test('skips the weekend when crossing Monday start-of-day', () => {
    // Mon 8:30am - 60 min: 30 min Mon 8am→8:30am, remaining 30 jumps to Fri 5pm → Fri 4:30pm
    const end = new Date(2026, 0, 12, 8, 30); // 2026-01-12 = Monday
    expect(subtractWorkingMinutes(end, 60, standardCalendar)).toEqual(
      new Date(2026, 0, 9, 16, 30), // 2026-01-09 = Friday
    );
  });

  test('subtracting 5 working days (2700 min) from Fri 5pm lands on Mon 8am', () => {
    const end = new Date(2026, 0, 9, 17, 0); // Fri 5pm
    expect(subtractWorkingMinutes(end, 5 * 540, standardCalendar)).toEqual(
      new Date(2026, 0, 5, 8, 0), // Mon 8am
    );
  });

  test('skips a holiday exception when crossing it backward', () => {
    const withTuesHoliday: Calendar = {
      ...standardCalendar,
      exceptions: [{ date: new Date(2026, 0, 6), isWorking: false, name: 'Holiday' }],
    };
    // Wed 8:01am - 541 min: 1 min consumes Wed 8am→8:01am, remaining 540 needs to skip Tue (holiday)
    // and consume all of Mon 8am-5pm → Mon 8am
    const end = new Date(2026, 0, 7, 8, 1);
    expect(subtractWorkingMinutes(end, 541, withTuesHoliday)).toEqual(new Date(2026, 0, 5, 8, 0));
  });
});

describe('isWorkingTime', () => {
  // 7am–3pm single shift, Mon–Fri.
  const shiftCal: Calendar = {
    id: 'shift',
    name: '7-3 concreting',
    workWeek: [
      [],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [{ startMinutes: 7 * 60, endMinutes: 15 * 60 }],
      [],
    ],
    exceptions: [],
  };
  // Split shift 7–12, 13–15 (lunch 12–13), Mon–Fri.
  const splitCal: Calendar = {
    ...shiftCal,
    id: 'split',
    workWeek: [
      [],
      [
        { startMinutes: 7 * 60, endMinutes: 12 * 60 },
        { startMinutes: 13 * 60, endMinutes: 15 * 60 },
      ],
      [
        { startMinutes: 7 * 60, endMinutes: 12 * 60 },
        { startMinutes: 13 * 60, endMinutes: 15 * 60 },
      ],
      [
        { startMinutes: 7 * 60, endMinutes: 12 * 60 },
        { startMinutes: 13 * 60, endMinutes: 15 * 60 },
      ],
      [
        { startMinutes: 7 * 60, endMinutes: 12 * 60 },
        { startMinutes: 13 * 60, endMinutes: 15 * 60 },
      ],
      [
        { startMinutes: 7 * 60, endMinutes: 12 * 60 },
        { startMinutes: 13 * 60, endMinutes: 15 * 60 },
      ],
      [],
    ],
  };
  const MON = (h: number, m = 0) => new Date(2026, 0, 5, h, m); // 2026-01-05 is a Monday
  const SUN = (h: number) => new Date(2026, 0, 4, h); // Sunday

  test('inside the shift → true', () => {
    expect(isWorkingTime(MON(9), shiftCal)).toBe(true);
  });
  test('before the shift start → false', () => {
    expect(isWorkingTime(MON(6), shiftCal)).toBe(false);
  });
  test('at the shift end is end-exclusive → false', () => {
    expect(isWorkingTime(MON(15), shiftCal)).toBe(false);
  });
  test('split shift: both halves working, lunch gap not', () => {
    expect(isWorkingTime(MON(8), splitCal)).toBe(true);
    expect(isWorkingTime(MON(14), splitCal)).toBe(true);
    expect(isWorkingTime(MON(12, 30), splitCal)).toBe(false);
  });
  test('non-working weekday → false at any hour', () => {
    expect(isWorkingTime(SUN(9), shiftCal)).toBe(false);
  });
  test('working exception with intervals is respected', () => {
    const withWorkingSat: Calendar = {
      ...shiftCal,
      exceptions: [
        {
          date: new Date(2026, 0, 10),
          isWorking: true,
          intervals: [{ startMinutes: 8 * 60, endMinutes: 10 * 60 }],
        },
      ],
    };
    expect(isWorkingTime(new Date(2026, 0, 10, 9), withWorkingSat)).toBe(true);
    expect(isWorkingTime(new Date(2026, 0, 10, 11), withWorkingSat)).toBe(false);
  });
  test('non-working exception (holiday) → false at any hour', () => {
    const withHoliday: Calendar = {
      ...shiftCal,
      exceptions: [{ date: new Date(2026, 0, 5), isWorking: false, name: 'Site shutdown' }],
    };
    expect(isWorkingTime(MON(9), withHoliday)).toBe(false);
  });
});
