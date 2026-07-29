import type { Link, TaskId } from '@pyraxi/cpm-engine';

export type DragLinkState =
  | { status: 'idle' }
  | {
      status: 'dragging';
      sourceId: TaskId;
      startX: number;
      startY: number;
      cursorX: number;
      cursorY: number;
    }
  | { status: 'dropped'; sourceId: TaskId; targetId: TaskId };

export const DRAG_INITIAL: DragLinkState = { status: 'idle' };

export function startDrag(sourceId: TaskId, startX: number, startY: number): DragLinkState {
  return { status: 'dragging', sourceId, startX, startY, cursorX: startX, cursorY: startY };
}

export function moveDrag(state: DragLinkState, cursorX: number, cursorY: number): DragLinkState {
  if (state.status !== 'dragging') return state;
  return { ...state, cursorX, cursorY };
}

export function completeDrop(state: DragLinkState, targetId: TaskId | null): DragLinkState {
  if (state.status !== 'dragging') return DRAG_INITIAL;
  if (targetId === null) return DRAG_INITIAL;
  return { status: 'dropped', sourceId: state.sourceId, targetId };
}

export function cancelDrag(_state: DragLinkState): DragLinkState {
  return DRAG_INITIAL;
}

export function isDragInvalid(
  sourceId: TaskId,
  targetId: TaskId,
  existingLinks: Link[],
  summaryIds: Set<TaskId>,
): boolean {
  if (String(sourceId) === String(targetId)) return true;
  if ([...summaryIds].some((id) => String(id) === String(targetId))) return true;
  return existingLinks.some(
    (l) => String(l.source) === String(sourceId) && String(l.target) === String(targetId),
  );
}
