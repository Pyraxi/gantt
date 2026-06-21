import { describe, expect, test } from 'vitest';
import { mondayisePair, mondayiseSingle } from './mondayisation.js';

describe('mondayiseSingle', () => {
  test('Mon-Fri statutory date returns the same date', () => {
    // 2025-04-25 = Friday (ANZAC Day on a weekday)
    const observed = mondayiseSingle(new Date(2025, 3, 25));
    expect(observed.getFullYear()).toBe(2025);
    expect(observed.getMonth()).toBe(3);
    expect(observed.getDate()).toBe(25);
  });

  test('Saturday statutory date shifts to the following Monday', () => {
    // 2026-04-25 = Saturday (ANZAC Day on Sat → Mon Apr 27)
    const observed = mondayiseSingle(new Date(2026, 3, 25));
    expect(observed.getMonth()).toBe(3);
    expect(observed.getDate()).toBe(27);
    expect(observed.getDay()).toBe(1); // Monday
  });

  test('Sunday statutory date shifts to the following Monday', () => {
    // 2027-02-06 = Saturday (Waitangi 2027 — checking the date math here:
    // 2027 Jan 1 = Friday → Feb 6 = Saturday). Use 2027-04-25 = Sunday.
    // ANZAC Day 2027 = Sun → observed Mon Apr 26.
    const observed = mondayiseSingle(new Date(2027, 3, 25));
    expect(observed.getMonth()).toBe(3);
    expect(observed.getDate()).toBe(26);
    expect(observed.getDay()).toBe(1);
  });
});

describe('mondayisePair', () => {
  // Pair-rule for [Dec 25, Dec 26] or [Jan 1, Jan 2]. The result is
  // [observedFirst, observedSecond] where:
  // - If first is Sat: first observed Mon, second observed Tue
  // - If first is Sun: first observed Mon, second observed Tue (second is
  //   originally Mon but gets bumped because first takes the Mon)
  // - If first is Mon: first stays Mon, second stays Tue (no shift)
  // - If first is Tue–Fri: both stay where they are (no shift)
  // - If second is Sat (only possible when first = Fri): second observed Mon
  //   (Christmas/NY are not shifted; only Boxing/2-Jan shifts)

  test('Jan 1 Sat / 2 Jan Sun → both shift forward (2022)', () => {
    // 2022-01-01 = Saturday
    const [first, second] = mondayisePair(new Date(2022, 0, 1), new Date(2022, 0, 2));
    expect(first.getDate()).toBe(3); // Mon Jan 3
    expect(first.getDay()).toBe(1);
    expect(second.getDate()).toBe(4); // Tue Jan 4
    expect(second.getDay()).toBe(2);
  });

  test('Dec 25 Sun / Dec 26 Mon → Christmas Mon, Boxing bumped to Tue (2022)', () => {
    // 2022-12-25 = Sunday, 2022-12-26 = Monday
    const [christmas, boxing] = mondayisePair(new Date(2022, 11, 25), new Date(2022, 11, 26));
    expect(christmas.getDate()).toBe(26); // Mon Dec 26
    expect(christmas.getDay()).toBe(1);
    expect(boxing.getDate()).toBe(27); // Tue Dec 27 (bumped)
    expect(boxing.getDay()).toBe(2);
  });

  test('Dec 25 Sat / Dec 26 Sun → both shift forward (2027)', () => {
    // 2027-12-25 = Saturday, 2027-12-26 = Sunday
    const [christmas, boxing] = mondayisePair(new Date(2027, 11, 25), new Date(2027, 11, 26));
    expect(christmas.getDate()).toBe(27); // Mon Dec 27
    expect(christmas.getDay()).toBe(1);
    expect(boxing.getDate()).toBe(28); // Tue Dec 28
    expect(boxing.getDay()).toBe(2);
  });

  test('Dec 25 Mon / Dec 26 Tue → no shift (2023)', () => {
    // 2023-12-25 = Monday, 2023-12-26 = Tuesday
    const [christmas, boxing] = mondayisePair(new Date(2023, 11, 25), new Date(2023, 11, 26));
    expect(christmas.getDate()).toBe(25);
    expect(christmas.getDay()).toBe(1);
    expect(boxing.getDate()).toBe(26);
    expect(boxing.getDay()).toBe(2);
  });

  test('Dec 25 Fri / Dec 26 Sat → Boxing shifts to Mon, Christmas stays Fri (2026)', () => {
    // 2026-12-25 = Friday, 2026-12-26 = Saturday
    const [christmas, boxing] = mondayisePair(new Date(2026, 11, 25), new Date(2026, 11, 26));
    expect(christmas.getDate()).toBe(25); // Fri Dec 25 unchanged
    expect(christmas.getDay()).toBe(5);
    expect(boxing.getDate()).toBe(28); // Mon Dec 28 (skip Sun)
    expect(boxing.getDay()).toBe(1);
  });

  test('Dec 25 Thu / Dec 26 Fri → no shift (2025)', () => {
    // 2025-12-25 = Thursday, 2025-12-26 = Friday
    const [christmas, boxing] = mondayisePair(new Date(2025, 11, 25), new Date(2025, 11, 26));
    expect(christmas.getDate()).toBe(25);
    expect(boxing.getDate()).toBe(26);
  });
});
