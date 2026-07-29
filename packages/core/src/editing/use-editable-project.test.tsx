import type { Calendar, Link, Project, Task } from '@pyraxi/cpm-engine';
import { renameTask, updateLink, updateTask } from '@pyraxi/cpm-engine';
import { act, renderHook } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import { useEditableProject } from './use-editable-project.js';

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string, text = `Task ${id}`, duration = 480): Task {
  return {
    id,
    text,
    type: 'task',
    scheduleMode: 'auto',
    duration,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
  };
}

function projectOf(tasks: Task[], links: Link[] = []): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links,
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('useEditableProject — initial state', () => {
  test('returns scheduled project with computed CPM data', () => {
    const initial = projectOf([task('a')]);
    const { result } = renderHook(() => useEditableProject(initial));
    expect(result.current.project.tasks[0].computed).toBeDefined();
    expect(result.current.isDirty).toBe(false);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});

describe('useEditableProject — enqueue + commit + undo', () => {
  test('basic edit/commit produces updated project and canUndo=true', () => {
    const initial = projectOf([task('a', 'Old')]);
    const { result } = renderHook(() => useEditableProject(initial));

    act(() => {
      result.current.enqueue(renameTask('a', 'Foundation pour'));
    });
    expect(result.current.project.tasks[0].text).toBe('Foundation pour');
    expect(result.current.isDirty).toBe(true);

    act(() => {
      result.current.commit();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.canUndo).toBe(true);
  });

  test('undo restores prior state and sets canRedo=true', () => {
    const initial = projectOf([task('a', 'Old')]);
    const { result } = renderHook(() => useEditableProject(initial));

    act(() => {
      result.current.enqueue(renameTask('a', 'New'));
      result.current.commit();
    });
    act(() => {
      result.current.undo();
    });

    expect(result.current.project.tasks[0].text).toBe('Old');
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
  });

  test('new edit after undo clears redo stack', () => {
    const initial = projectOf([task('a', 'V0')]);
    const { result } = renderHook(() => useEditableProject(initial));

    act(() => {
      result.current.enqueue(renameTask('a', 'V1'));
      result.current.commit();
      result.current.undo();
    });
    expect(result.current.canRedo).toBe(true);

    act(() => {
      result.current.enqueue(renameTask('a', 'V2'));
      result.current.commit();
    });
    expect(result.current.canRedo).toBe(false);
  });
});

describe('useEditableProject — compound undo', () => {
  test('three enqueues committed as one history entry; single undo reverts all three', () => {
    const initial = projectOf([task('a', 'V0')]);
    const { result } = renderHook(() => useEditableProject(initial));

    act(() => {
      result.current.enqueue(renameTask('a', 'V1'));
      result.current.enqueue(renameTask('a', 'V2'));
      result.current.enqueue(renameTask('a', 'V3'));
      result.current.commit();
    });
    expect(result.current.project.tasks[0].text).toBe('V3');

    act(() => {
      result.current.undo();
    });
    expect(result.current.project.tasks[0].text).toBe('V0');

    act(() => {
      result.current.redo();
    });
    expect(result.current.project.tasks[0].text).toBe('V3');
  });
});

describe('useEditableProject — cancel', () => {
  test('cancel discards pending and reverts to base', () => {
    const initial = projectOf([task('a', 'Old')]);
    const { result } = renderHook(() => useEditableProject(initial));

    act(() => {
      result.current.enqueue(renameTask('a', 'New'));
    });
    expect(result.current.project.tasks[0].text).toBe('New');

    act(() => {
      result.current.cancel();
    });
    expect(result.current.project.tasks[0].text).toBe('Old');
    expect(result.current.isDirty).toBe(false);
  });
});

describe('useEditableProject — undo while dirty', () => {
  test('cancels pending then walks history', () => {
    const initial = projectOf([task('a', 'V0')]);
    const { result } = renderHook(() => useEditableProject(initial));

    // First commit
    act(() => {
      result.current.enqueue(renameTask('a', 'V1'));
      result.current.commit();
    });
    // Now enqueue without committing (dirty state)
    act(() => {
      result.current.enqueue(renameTask('a', 'Vdraft'));
    });
    expect(result.current.isDirty).toBe(true);
    expect(result.current.project.tasks[0].text).toBe('Vdraft');

    // Undo while dirty: cancels pending first, then undoes the committed V1
    act(() => {
      result.current.undo();
    });
    expect(result.current.isDirty).toBe(false);
    expect(result.current.project.tasks[0].text).toBe('V0');
  });
});

describe('useEditableProject — engine seam', () => {
  test('editing a manual predecessor task shifts the successor via schedule cascade', () => {
    // Manual-scheduled predecessor so user-set start is authoritative (not
    // overwritten by the auto-scheduling forward pass). FS successor depends
    // on the predecessor's finish — so moving the predecessor cascades.
    const predecessor: Task = {
      ...task('a', 'Predecessor', 480),
      scheduleMode: 'manual',
      start: new Date(2026, 0, 5, 8, 0),
      end: new Date(2026, 0, 5, 17, 0), // Mon 5pm
    };
    const successor = task('b', 'Successor', 480);
    const fsLink: Link = {
      id: 'a->b',
      source: 'a',
      target: 'b',
      type: 'FS',
      lag: 0,
    };
    const initial = projectOf([predecessor, successor], [fsLink]);
    const { result } = renderHook(() => useEditableProject(initial));

    const earlyStartBefore = result.current.project.tasks.find((t) => t.id === 'b')?.computed
      ?.earlyStart;
    expect(earlyStartBefore).toBeDefined();

    // Move predecessor's manual start+end to Wed Jan 7 — 2 working days later.
    // Manual task: user-set dates are authoritative; engine uses them as-is.
    act(() => {
      result.current.enqueue(
        updateTask('a', {
          start: new Date(2026, 0, 7, 8, 0),
          end: new Date(2026, 0, 7, 17, 0), // Wed 5pm
        }),
      );
      result.current.commit();
    });

    const earlyStartAfter = result.current.project.tasks.find((t) => t.id === 'b')?.computed
      ?.earlyStart;
    expect(earlyStartAfter).toBeDefined();
    expect(earlyStartAfter!.getTime()).toBeGreaterThan(earlyStartBefore!.getTime());
  });

  test('updating a link lag shifts the successor via schedule cascade', () => {
    const initial = projectOf(
      [task('a'), task('b')],
      [{ id: 'a->b', source: 'a', target: 'b', type: 'FS', lag: 0 }],
    );
    const { result } = renderHook(() => useEditableProject(initial));

    const before = result.current.project.tasks.find((t) => t.id === 'b')?.computed?.earlyStart;

    // Bump lag to 1 working day = 540 minutes (Mon-Fri 8-5)
    act(() => {
      result.current.enqueue(updateLink('a->b', { lag: 540 }));
      result.current.commit();
    });

    const after = result.current.project.tasks.find((t) => t.id === 'b')?.computed?.earlyStart;
    expect(after).toBeDefined();
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });
});

describe('useEditableProject — initial-prop stability', () => {
  test('initial argument is captured once; subsequent renders with new value are ignored', () => {
    const initial1 = projectOf([task('a', 'V1')]);
    const initial2 = projectOf([task('a', 'V2')]);
    const { result, rerender } = renderHook(({ p }) => useEditableProject(p), {
      initialProps: { p: initial1 },
    });
    expect(result.current.project.tasks[0].text).toBe('V1');

    rerender({ p: initial2 });
    expect(result.current.project.tasks[0].text).toBe('V1'); // unchanged
  });
});
