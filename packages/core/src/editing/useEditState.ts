// biome-ignore lint/correctness/noUnusedImports: ScheduleMode is implicitly used in TaskEditPatch return type
import type { ScheduleMode, Task, TaskId } from '@pyraxi/cpm-engine';
import {
  DEFAULT_DURATION_UNITS,
  type DurationUnitMinutes,
  parseDuration,
  parseElapsedDuration,
} from '@pyraxi/cpm-engine';
import { useCallback, useRef, useState } from 'react';

export type EditableField = 'text' | 'start' | 'end' | 'duration' | 'progress' | 'scheduleMode';

export interface ActiveCell {
  taskId: TaskId;
  field: EditableField;
}

export type TaskEditPatch = Partial<
  Pick<Task, 'text' | 'start' | 'end' | 'duration' | 'progress' | 'scheduleMode'>
>;

/** What a commit did: sent a patch, had nothing to send, or couldn't parse the value. */
export type CommitStatus = 'committed' | 'unchanged' | 'invalid';

export interface EditState {
  activeCell: ActiveCell | null;
  dirtyValue: string;
  /** The last commit attempt couldn't parse the value (editor kept open). */
  invalid: boolean;
  activateCell(taskId: TaskId, field: EditableField, initialValue: string): void;
  setValue(value: string): void;
  /**
   * Commit the active cell. An unparseable value never sends a patch: with
   * `keepOpenIfInvalid` (Enter/Tab) the editor stays open marked invalid so the
   * user can fix it; otherwise (blur) the edit reverts.
   */
  commitCell(
    onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void,
    opts?: { keepOpenIfInvalid?: boolean },
  ): CommitStatus;
  cancelCell(): void;
}

/**
 * Duration units for a calendar's working day: "1d" is one of ITS days (a
 * 9 h site day is 540 min, not the 8 h default); weeks are 5 days, months 20.
 */
export function durationUnitsFor(minutesPerDay?: number): DurationUnitMinutes {
  if (!minutesPerDay || minutesPerDay <= 0) return DEFAULT_DURATION_UNITS;
  return {
    ...DEFAULT_DURATION_UNITS,
    day: minutesPerDay,
    week: 5 * minutesPerDay,
    month: 20 * minutesPerDay,
  };
}

export function parseFieldValue(
  field: EditableField,
  value: string,
  units: DurationUnitMinutes = DEFAULT_DURATION_UNITS,
  /** The task's duration is elapsed (`3ed`): days are 24 h, whatever `units` says. */
  elapsed = false,
): TaskEditPatch {
  switch (field) {
    case 'text':
      return { text: value };
    case 'start': {
      const d = new Date(`${value}T08:00:00`);
      if (Number.isNaN(d.getTime())) return {};
      return { start: d };
    }
    case 'end': {
      const d = new Date(`${value}T08:00:00`);
      if (Number.isNaN(d.getTime())) return {};
      return { end: d };
    }
    case 'duration': {
      const minutes = elapsed ? parseElapsedDuration(value) : parseDuration(value, units);
      if (minutes === null) return {};
      return { duration: minutes };
    }
    case 'progress': {
      const n = Number(value);
      if (!Number.isFinite(n)) return {};
      return { progress: Math.min(100, Math.max(0, n)) };
    }
    case 'scheduleMode': {
      if (value !== 'auto' && value !== 'manual') return {};
      return { scheduleMode: value };
    }
  }
}

interface EditStateInternal {
  activeCell: ActiveCell | null;
  dirtyValue: string;
  // The seed value the cell opened with — commitCell compares against it so a
  // click-in/click-out with no typing never fires onTaskEdit (which would, e.g.,
  // re-commit a duration and risk a lossy re-parse round-trip).
  initialValue: string;
  invalid: boolean;
}

const CLOSED: EditStateInternal = {
  activeCell: null,
  dirtyValue: '',
  initialValue: '',
  invalid: false,
};

export function useEditState(
  units?: DurationUnitMinutes,
  /** Whether a task's duration is elapsed (`Task.durationElapsed`): typed days are 24 h. */
  isElapsed?: (id: TaskId) => boolean,
): EditState {
  // Read at commit time, so a calendar change applies without re-creating callbacks.
  const unitsRef = useRef(units);
  unitsRef.current = units;
  const isElapsedRef = useRef(isElapsed);
  isElapsedRef.current = isElapsed;
  const [state, setState] = useState<EditStateInternal>(CLOSED);
  // stateRef lets commitCell read the latest state without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  const activateCell = useCallback((taskId: TaskId, field: EditableField, initialValue: string) => {
    const next = {
      activeCell: { taskId, field },
      dirtyValue: initialValue,
      initialValue,
      invalid: false,
    };
    stateRef.current = next;
    setState(next);
  }, []);

  const setValue = useCallback((value: string) => {
    stateRef.current = { ...stateRef.current, dirtyValue: value, invalid: false };
    setState((prev) => ({ ...prev, dirtyValue: value, invalid: false }));
  }, []);

  const commitCell = useCallback(
    (
      onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void,
      opts?: { keepOpenIfInvalid?: boolean },
    ): CommitStatus => {
      const { activeCell, dirtyValue, initialValue } = stateRef.current;
      if (activeCell === null) return 'unchanged';
      // Unchanged-value guard: an untouched cell (blur/Enter with no edit) is a
      // no-op, not an edit — don't fire onTaskEdit.
      if (dirtyValue === initialValue) {
        stateRef.current = CLOSED;
        setState(CLOSED);
        return 'unchanged';
      }
      const patch = parseFieldValue(
        activeCell.field,
        dirtyValue,
        unitsRef.current,
        isElapsedRef.current?.(activeCell.taskId) ?? false,
      );
      // Unparseable ("soon" as a duration) parses to {} — never send that.
      if (Object.keys(patch).length === 0) {
        const next = opts?.keepOpenIfInvalid ? { ...stateRef.current, invalid: true } : CLOSED;
        stateRef.current = next;
        setState(next);
        return 'invalid';
      }
      onTaskEdit?.(activeCell.taskId, patch);
      stateRef.current = CLOSED;
      setState(CLOSED);
      return 'committed';
    },
    [],
  );

  const cancelCell = useCallback(() => {
    stateRef.current = CLOSED;
    setState(CLOSED);
  }, []);

  return {
    activeCell: state.activeCell,
    dirtyValue: state.dirtyValue,
    invalid: state.invalid,
    activateCell,
    setValue,
    commitCell,
    cancelCell,
  };
}
