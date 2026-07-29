import type { Calendar, Link, Project, Task } from '@pyraxi/cpm-engine';
import { schedule, updateTask } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import { isSvarDragEvent, svarUpdateToPatch } from './svar-adapter.js';

// Regression guard for the edit-mode drag bug CM filed (Finding A, fix e229713).
// A bar drag must travel the full data path — SVAR delta → svarUpdateToPatch →
// updateTask command → schedule() — and the dragged task's FS successor must
// cascade off the *new* (manual-pinned) dates. Before e229713 the drag never
// reached the engine, so the successor never moved. This locks the path at the
// unit layer, independent of the browser-only init-callback wiring.

const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard M-F 8-5',
  workWeek: [
    [],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [{ startMinutes: 480, endMinutes: 1020 }],
    [],
  ],
  exceptions: [],
};

const PROJECT_START = new Date(2026, 0, 5, 8, 0); // Mon 8am

function task(id: string, duration: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: PROJECT_START,
    end: PROJECT_START,
    progress: 0,
    ...overrides,
  };
}

function fs(source: string, target: string): Link {
  return { id: `${source}-${target}`, source, target, type: 'FS', lag: 0 };
}

function project(tasks: Task[], links: Link[]): Project {
  return {
    start: PROJECT_START,
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('edit-mode drag cascade (Finding A regression)', () => {
  test('dragging a predecessor pins it manual and cascades the FS successor', () => {
    // A → B (FS). A is 1 working day, naturally Mon; B naturally Tue.
    const a = task('a', 540);
    const b = task('b', 540);
    const before = schedule(project([a, b], [fs('a', 'b')]));
    expect(before.tasks.find((t) => t.id === 'a')!.computed!.earlyStart).toEqual(
      new Date(2026, 0, 5, 8, 0),
    );
    expect(before.tasks.find((t) => t.id === 'b')!.computed!.earlyStart).toEqual(
      new Date(2026, 0, 6, 8, 0),
    );

    // User drags A forward to Wed. SVAR emits a start+end delta.
    const dragged = svarUpdateToPatch({
      start: new Date(2026, 0, 7, 8, 0),
      end: new Date(2026, 0, 7, 17, 0),
    });
    expect(dragged.scheduleMode).toBe('manual');

    const edited = updateTask('a', dragged).apply(project([a, b], [fs('a', 'b')]));
    const after = schedule(edited);

    const aAfter = after.tasks.find((t) => t.id === 'a')!.computed!;
    const bAfter = after.tasks.find((t) => t.id === 'b')!.computed!;

    // A holds the dragged Wed dates (manual is authoritative — not snapped back
    // to Mon by the engine), and B cascades to Thu off A's new finish.
    expect(aAfter.earlyStart).toEqual(new Date(2026, 0, 7, 8, 0));
    expect(bAfter.earlyStart).toEqual(new Date(2026, 0, 8, 8, 0));
  });

  // Finding-A proper: a bar drag arrives at `intercept` as a `diff` event whose
  // `task` still holds the ORIGINAL dates (SVAR shifts them only in its own store
  // reducer, which runs after intercept). Bridging it at intercept time is a
  // no-op — the classifier must route drags to the post-reducer `on` handler.
  describe('drag event classification', () => {
    test('a diff-bearing event (bar drag) is classified as a drag → deferred', () => {
      // What SVAR hands `intercept` on a move: original dates + a column diff.
      // `isSvarDragEvent` true routes it past intercept to the `on` handler; the
      // wrapper never bridges this payload (its `task` holds pre-shift dates, so
      // bridging it would be the original→original no-op that is Finding-A).
      const interceptPayload = {
        id: 'a',
        diff: 2,
        task: { start: PROJECT_START, end: PROJECT_START },
      };
      expect(isSvarDragEvent(interceptPayload)).toBe(true);
    });

    test('the post-reducer event (computed dates) bridges and cascades', () => {
      // What SVAR hands the `on` handler after its reducer shifts the dates and
      // rewrites `ev.task` to the computed task: real new Wed dates, diff intact.
      const onPayload = {
        id: 'a',
        diff: 2,
        task: {
          start: new Date(2026, 0, 7, 8, 0),
          end: new Date(2026, 0, 7, 17, 0),
        },
      };
      expect(isSvarDragEvent(onPayload)).toBe(true);

      const a = task('a', 540);
      const b = task('b', 540);
      const patch = svarUpdateToPatch(onPayload.task);
      expect(patch.scheduleMode).toBe('manual');
      const after = schedule(updateTask('a', patch).apply(project([a, b], [fs('a', 'b')])));

      expect(after.tasks.find((t) => t.id === 'a')!.computed!.earlyStart).toEqual(
        new Date(2026, 0, 7, 8, 0),
      );
      expect(after.tasks.find((t) => t.id === 'b')!.computed!.earlyStart).toEqual(
        new Date(2026, 0, 8, 8, 0), // B cascades — the fix
      );
    });

    test('a direct field/editor edit carries no diff → bridged at intercept', () => {
      // Editor-modal / programmatic edits set real values with no `diff`.
      expect(isSvarDragEvent({ id: 'a', task: { text: 'renamed' } })).toBe(false);
      expect(isSvarDragEvent({ id: 'a', task: { start: PROJECT_START } })).toBe(false);
    });
  });
});
