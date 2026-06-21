// biome-ignore lint/correctness/noUnusedImports: ScheduleMode is implicitly used in TaskEditPatch return type
import type { ScheduleMode, Task, TaskId } from '@pyraxi/cpm-engine';
import { parseDuration } from '@pyraxi/cpm-engine';
import { useCallback, useRef, useState } from 'react';

export type EditableField = 'text' | 'start' | 'end' | 'duration' | 'progress' | 'scheduleMode';

export interface ActiveCell {
  taskId: TaskId;
  field: EditableField;
}

export type TaskEditPatch = Partial<
  Pick<Task, 'text' | 'start' | 'end' | 'duration' | 'progress' | 'scheduleMode'>
>;

export interface EditState {
  activeCell: ActiveCell | null;
  dirtyValue: string;
  activateCell(taskId: TaskId, field: EditableField, initialValue: string): void;
  setValue(value: string): void;
  commitCell(onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void): void;
  cancelCell(): void;
}

export function parseFieldValue(field: EditableField, value: string): TaskEditPatch {
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
      const minutes = parseDuration(value);
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
}

export function useEditState(): EditState {
  const [state, setState] = useState<EditStateInternal>({
    activeCell: null,
    dirtyValue: '',
  });
  // stateRef lets commitCell read the latest state without stale closures.
  const stateRef = useRef(state);
  stateRef.current = state;

  const activateCell = useCallback((taskId: TaskId, field: EditableField, initialValue: string) => {
    setState({ activeCell: { taskId, field }, dirtyValue: initialValue });
  }, []);

  const setValue = useCallback((value: string) => {
    setState((prev) => ({ ...prev, dirtyValue: value }));
  }, []);

  const commitCell = useCallback((onTaskEdit?: (id: TaskId, patch: TaskEditPatch) => void) => {
    const { activeCell, dirtyValue } = stateRef.current;
    if (activeCell === null) return;
    const patch = parseFieldValue(activeCell.field, dirtyValue);
    onTaskEdit?.(activeCell.taskId, patch);
    setState({ activeCell: null, dirtyValue: '' });
  }, []);

  const cancelCell = useCallback(() => {
    setState({ activeCell: null, dirtyValue: '' });
  }, []);

  return {
    activeCell: state.activeCell,
    dirtyValue: state.dirtyValue,
    activateCell,
    setValue,
    commitCell,
    cancelCell,
  };
}
