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

describe('createWorkingMinutesCounter', () => {
  test('agrees with workingMinutesBetween on random pairs (weekends, split shifts, exceptions)', async () => {
    const { createWorkingMinutesCounter, workingMinutesBetween } = await import('./working-time');
    const cal: Calendar = {
      id: 'c',
      name: 'C',
      workWeek: [
        [],
        [
          { startMinutes: 420, endMinutes: 720 },
          { startMinutes: 780, endMinutes: 990 },
        ],
        [{ startMinutes: 480, endMinutes: 1020 }],
        [{ startMinutes: 480, endMinutes: 1020 }],
        [{ startMinutes: 480, endMinutes: 1020 }],
        [{ startMinutes: 480, endMinutes: 900 }],
        [{ startMinutes: 480, endMinutes: 720 }],
      ],
      exceptions: [
        { date: new Date(2026, 0, 7), isWorking: false },
        {
          date: new Date(2026, 1, 3),
          isWorking: true,
          intervals: [{ startMinutes: 600, endMinutes: 660 }],
        },
        {
          date: new Date(2026, 0, 11),
          isWorking: true,
          intervals: [{ startMinutes: 540, endMinutes: 600 }],
        },
      ],
    };
    const count = createWorkingMinutesCounter(cal);
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const base = new Date(2026, 0, 1).getTime();
    for (let i = 0; i < 2000; i++) {
      const a = new Date(base + Math.floor(rnd() * 90 * 24 * 60) * 60_000);
      const b = new Date(base + Math.floor(rnd() * 90 * 24 * 60) * 60_000);
      expect(count(a, b)).toBeCloseTo(workingMinutesBetween(a, b, cal), 6);
    }
  });
});

describe('createWorkingMinutesCounter matches workingMinutesBetween exactly', () => {
  // schedule() measures slack with the counter: it must give the identical
  // number (sign and zero included), not just a close one.
  const WK = [{ startMinutes: 480, endMinutes: 1020 }];
  const calendars: Calendar[] = [
    standardCalendar,
    {
      id: 'holidays',
      name: 'Std + holidays + a Saturday shift',
      workWeek: [[], WK, WK, WK, WK, WK, []],
      exceptions: [
        { date: new Date(2026, 0, 1), isWorking: false },
        { date: new Date(2026, 0, 2), isWorking: false },
        { date: new Date(2026, 3, 3), isWorking: false },
        { date: new Date(2026, 3, 6), isWorking: false },
        { date: new Date(2026, 3, 25), isWorking: false },
        {
          date: new Date(2026, 8, 26),
          isWorking: true,
          intervals: [{ startMinutes: 480, endMinutes: 720 }],
        },
        { date: new Date(2026, 11, 25), isWorking: false },
      ],
    },
    {
      id: 'split',
      name: 'Split shift, six days',
      workWeek: [
        [],
        [
          { startMinutes: 420, endMinutes: 720 },
          { startMinutes: 780, endMinutes: 1050 },
        ],
        WK,
        WK,
        WK,
        WK,
        [{ startMinutes: 480, endMinutes: 720 }],
      ],
      exceptions: [],
    },
    {
      id: 'nights',
      name: 'Late shift (across local DST changes)',
      workWeek: Array.from({ length: 7 }, () => [{ startMinutes: 60, endMinutes: 1439 }]),
      exceptions: [],
    },
  ];
  const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m, d, h, min);
  // Includes reverse (negative) spans, spans inside non-working time, and
  // spans across the NZ / EU / US DST changes of 2026.
  const pairs: [Date, Date][] = [
    [at(2026, 0, 5, 8), at(2026, 0, 5, 8)],
    [at(2026, 0, 5, 8), at(2026, 0, 9, 17)],
    [at(2026, 0, 9, 17), at(2026, 0, 5, 8)],
    [at(2026, 0, 9, 17), at(2026, 0, 12, 8)], // weekend only
    [at(2026, 0, 12, 8), at(2026, 0, 9, 17)], // reverse, weekend only
    [at(2025, 11, 24, 12), at(2026, 0, 6, 9, 30)],
    [at(2026, 0, 6, 9, 30), at(2025, 11, 24, 12)],
    [at(2026, 2, 27, 10), at(2026, 3, 9, 15)], // EU spring forward, NZ Easter
    [at(2026, 3, 9, 15), at(2026, 2, 27, 10)],
    [at(2026, 8, 24, 13), at(2026, 9, 2, 11)], // NZ spring forward
    [at(2026, 9, 23, 7), at(2026, 10, 3, 16)], // EU / US fall back
    [at(2026, 0, 5, 8), at(2026, 11, 31, 17)], // a year
    [at(2026, 11, 31, 17), at(2026, 0, 5, 8)],
  ];
  for (const cal of calendars) {
    test(cal.name, async () => {
      const { createWorkingMinutesCounter, workingMinutesBetween } = await import('./working-time');
      const count = createWorkingMinutesCounter(cal);
      for (const [a, b] of pairs) {
        const want = workingMinutesBetween(a, b, cal);
        const got = count(a, b);
        expect(
          Object.is(got, want),
          `${a.toISOString()} → ${b.toISOString()}: ${got} vs ${want}`,
        ).toBe(true);
      }
    });
  }

  test('a reverse span with no working time is 0, not -0', async () => {
    const { createWorkingMinutesCounter, workingMinutesBetween } = await import('./working-time');
    const fri17 = at(2026, 0, 9, 17);
    const mon8 = at(2026, 0, 12, 8);
    expect(Object.is(workingMinutesBetween(mon8, fri17, standardCalendar), 0)).toBe(true);
    expect(Object.is(createWorkingMinutesCounter(standardCalendar)(mon8, fri17), 0)).toBe(true);
  });
});
