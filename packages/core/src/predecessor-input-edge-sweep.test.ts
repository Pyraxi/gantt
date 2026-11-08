import type { Link, Task } from '@pyraxi/cpm-engine';
import { describe, expect, it } from 'vitest';
import { parsePredecessors } from './predecessor-input.js';
import { formatPredecessors } from './predecessors.js';

// Edge-case sweep (engine edge-sweep.test.ts companion): predecessor text with
// sheet / P6 ids. The parser lives here in @pyraxi/gantt, not in the engine.

const resolverFor = (...ids: string[]) => {
  const known = new Set(ids);
  return (ref: string) => (known.has(ref) ? ref : undefined);
};

describe('edge sweep: predecessor text ids', () => {
  it('"A1000 FS+2d" reads as id + type + lag', () => {
    expect(
      parsePredecessors('A1000 FS+2d', { resolve: resolverFor('A1000'), minutesPerDay: 540 }),
    ).toEqual({ ok: true, preds: [{ source: 'A1000', type: 'FS', lag: 1080 }] });
  });

  it('an id that ends in a link type ("PROCESS") reads as the whole id', () => {
    expect(
      parsePredecessors('PROCESS', { resolve: resolverFor('PROCESS'), minutesPerDay: 540 }),
    ).toEqual({ ok: true, preds: [{ source: 'PROCESS', type: 'FS', lag: 0 }] });
  });

  // Was a DEFECT: the TOKEN regex split "EW-10" into ref "EW" + a 10-day lead
  // before the whole token was tried as an id. Hyphenated activity ids are
  // routine in P6 / sheet imports, so the whole token is now tried first.
  it('a hyphenated id ("EW-10") is tried whole before being split into id + lead', () => {
    expect(
      parsePredecessors('EW-10', { resolve: resolverFor('EW', 'EW-10'), minutesPerDay: 540 }),
    ).toEqual({ ok: true, preds: [{ source: 'EW-10', type: 'FS', lag: 0 }] });
  });

  it('"EW-10" with only task EW present still reads as EW with a 10-day lead', () => {
    expect(parsePredecessors('EW-10', { resolve: resolverFor('EW'), minutesPerDay: 540 })).toEqual({
      ok: true,
      preds: [{ source: 'EW', type: 'FS', lag: -5400 }],
    });
  });

  it('a tolerant resolver keeps the type and lag when the whole entry and its ref name the same task', () => {
    const tasks = ['a', 'b', 'c'].map((id) => ({ id }));
    // parseInt reads "3FS+2d" as 3 too: the whole entry must not swallow the lag.
    const resolve = (ref: string) => tasks[Number.parseInt(ref, 10) - 1]?.id;
    expect(parsePredecessors('3FS+2d, 1SS-1d', { resolve, minutesPerDay: 540 })).toEqual({
      ok: true,
      preds: [
        { source: 'c', type: 'FS', lag: 1080 },
        { source: 'a', type: 'SS', lag: -540 },
      ],
    });
  });

  it('an SS link from "EW-10" reads back as EW-10 + SS, not EW with a "-10SS" lag', () => {
    expect(
      parsePredecessors('EW-10SS', { resolve: resolverFor('EW', 'EW-10'), minutesPerDay: 540 }),
    ).toEqual({ ok: true, preds: [{ source: 'EW-10', type: 'SS', lag: 0 }] });
    expect(
      parsePredecessors('EW-10SS', { resolve: resolverFor('EW-10'), minutesPerDay: 540 }),
    ).toEqual({ ok: true, preds: [{ source: 'EW-10', type: 'SS', lag: 0 }] });
  });
});

describe('edge sweep: hyphen / plus ids round-trip through formatPredecessors', () => {
  const MPD = 540;
  const ids = ['EW', 'EW-10', 'EW+5', 'X'];
  const tasks = ids.map(
    (id): Task => ({
      id,
      text: id,
      type: 'task',
      scheduleMode: 'auto',
      duration: MPD,
      start: new Date(2026, 0, 5, 8),
      end: new Date(2026, 0, 5, 17),
      progress: 0,
    }),
  );
  const lags: Pick<Link, 'lag' | 'lagPercent' | 'lagElapsed'>[] = [
    { lag: 0 },
    { lag: 2 * MPD },
    { lag: -1.5 * MPD },
    { lag: 240 },
    { lag: 0, lagPercent: 50 },
    { lag: 1440, lagElapsed: true },
  ];
  const cases: Link[] = [];
  for (const source of ['EW-10', 'EW+5'])
    for (const type of ['FS', 'SS', 'FF', 'SF'] as const)
      for (const l of lags)
        cases.push({ id: `${source}-${type}-${cases.length}`, source, target: 'X', type, ...l });

  const specOf = (l: Link) => ({
    source: l.source,
    type: l.type,
    lag: l.lagPercent !== undefined ? 0 : l.lag,
    ...(l.lagPercent !== undefined ? { lagPercent: l.lagPercent } : {}),
    ...(l.lagElapsed ? { lagElapsed: true } : {}),
  });

  it.each(cases.map((l) => [l.id, l] as const))('%s by id (resolve)', (_, l) => {
    const text = formatPredecessors('X', [l], { minutesPerDay: MPD });
    expect(
      parsePredecessors(text, { resolve: resolverFor(...ids), minutesPerDay: MPD }),
      text,
    ).toEqual({ ok: true, preds: [specOf(l)] });
  });

  it.each(cases.map((l) => [l.id, l] as const))('%s by row number (tasks)', (_, l) => {
    const text = formatPredecessors('X', [l], { tasks, minutesPerDay: MPD });
    expect(parsePredecessors(text, { tasks, minutesPerDay: MPD }), text).toEqual({
      ok: true,
      preds: [specOf(l)],
    });
  });
});

describe('edge sweep: documented predecessor examples still parse', () => {
  const tasks = Array.from(
    { length: 8 },
    (_, i): Task => ({
      id: `t${i + 1}`,
      text: `t${i + 1}`,
      type: 'task',
      scheduleMode: 'auto',
      duration: 480,
      start: new Date(2026, 0, 5, 8),
      end: new Date(2026, 0, 5, 16),
      progress: 0,
    }),
  );
  const opts = { tasks, minutesPerDay: 480 };
  // README "Typing predecessors" + the TOKEN comment's examples.
  it.each([
    ['3', [{ source: 't3', type: 'FS', lag: 0 }]],
    ['3FS+2d', [{ source: 't3', type: 'FS', lag: 960 }]],
    [
      '5SS-1d, 7FF',
      [
        { source: 't5', type: 'SS', lag: -480 },
        { source: 't7', type: 'FF', lag: 0 },
      ],
    ],
    ['4FS+4 hrs', [{ source: 't4', type: 'FS', lag: 240 }]],
    ['4FS+50%', [{ source: 't4', type: 'FS', lag: 0, lagPercent: 50 }]],
    ['2FS+3ed', [{ source: 't2', type: 'FS', lag: 3 * 1440, lagElapsed: true }]],
    ['4FS+3 days', [{ source: 't4', type: 'FS', lag: 1440 }]],
    ['2SS-1.5d', [{ source: 't2', type: 'SS', lag: -720 }]],
    ['3FF+50%', [{ source: 't3', type: 'FF', lag: 0, lagPercent: 50 }]],
    ['5+2ed', [{ source: 't5', type: 'FS', lag: 2 * 1440, lagElapsed: true }]],
  ])('%s', (text, preds) => {
    expect(parsePredecessors(text, opts)).toEqual({ ok: true, preds });
  });
});
