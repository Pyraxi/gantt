import type { ITask } from '@svar-ui/react-gantt';
import { describe, expect, it } from 'vitest';
import { svarUpdateToPatch } from './svar-adapter.js';

// svarUpdateToPatch bridges SVAR's native `update-task` payload (bar drag/resize,
// editor-modal edits) into our TaskEditPatch. Timing changes (start/end) pin the
// task to manual per MS Project semantics; non-timing changes pass through.
describe('svarUpdateToPatch', () => {
  const start = new Date('2026-02-08T08:00:00');
  const end = new Date('2026-02-10T17:00:00');

  it('maps a bar move (start+end) and pins the task to manual', () => {
    expect(svarUpdateToPatch({ start, end } as Partial<ITask>)).toEqual({
      start,
      end,
      scheduleMode: 'manual',
    });
  });

  it('pins to manual when only start changed', () => {
    expect(svarUpdateToPatch({ start } as Partial<ITask>)).toEqual({
      start,
      scheduleMode: 'manual',
    });
  });

  it('pins to manual when only end changed (resize)', () => {
    expect(svarUpdateToPatch({ end } as Partial<ITask>)).toEqual({
      end,
      scheduleMode: 'manual',
    });
  });

  it('drops SVAR duration (working-days unit) and relies on dates', () => {
    expect(svarUpdateToPatch({ start, end, duration: 2 } as Partial<ITask>)).toEqual({
      start,
      end,
      scheduleMode: 'manual',
    });
  });

  it('passes progress through without touching scheduleMode', () => {
    expect(svarUpdateToPatch({ progress: 50 } as Partial<ITask>)).toEqual({ progress: 50 });
  });

  it('passes text through without touching scheduleMode', () => {
    expect(svarUpdateToPatch({ text: 'Renamed' } as Partial<ITask>)).toEqual({ text: 'Renamed' });
  });

  it('combines a timing change with a passthrough field', () => {
    expect(svarUpdateToPatch({ start, progress: 80 } as Partial<ITask>)).toEqual({
      start,
      progress: 80,
      scheduleMode: 'manual',
    });
  });

  it('drops a bare duration-only change (no dates → no manual pin)', () => {
    expect(svarUpdateToPatch({ duration: 5 } as Partial<ITask>)).toEqual({});
  });

  it('returns an empty patch for an empty delta', () => {
    expect(svarUpdateToPatch({} as Partial<ITask>)).toEqual({});
  });
});
