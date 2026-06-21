import type { EditCommand, Project } from '@pyraxi/cpm-engine';
import {
  type CommandHistory,
  type DraftProject,
  cancel as draftCancel,
  commit as draftCommit,
  enqueue as draftEnqueue,
  redo as historyRedo,
  undo as historyUndo,
  newDraft,
  newHistory,
  pushCommand,
  schedule,
} from '@pyraxi/cpm-engine';
import { useMemo, useReducer, useRef } from 'react';

/**
 * Consumer-facing return shape. The renderer reads `project`
 * unconditionally — it's always the scheduled, effective state.
 */
export interface EditableProject {
  readonly project: Project;
  readonly isDirty: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  enqueue(command: EditCommand): void;
  commit(label?: string): void;
  cancel(): void;
  undo(): void;
  redo(): void;
}

interface EditingState {
  draft: DraftProject;
  history: CommandHistory;
}

type EditingAction =
  | { type: 'enqueue'; command: EditCommand }
  | { type: 'commit'; label: string }
  | { type: 'cancel' }
  | { type: 'undo' }
  | { type: 'redo' };

function reducer(state: EditingState, action: EditingAction): EditingState {
  switch (action.type) {
    case 'enqueue':
      return { ...state, draft: draftEnqueue(state.draft, action.command) };

    case 'commit': {
      if (state.draft.pending.length === 0) return state;
      const { newBase, compound } = draftCommit(state.draft, action.label);
      return {
        draft: newDraft(newBase),
        history: pushCommand(state.history, compound),
      };
    }

    case 'cancel':
      return { ...state, draft: draftCancel(state.draft) };

    case 'undo': {
      // If dirty, cancel pending first (matches VS Code / Figma).
      const cleaned = state.draft.isDirty ? draftCancel(state.draft) : state.draft;
      const result = historyUndo(state.history, cleaned.base);
      if (!result) return { ...state, draft: cleaned };
      return {
        draft: newDraft(result.nextProject),
        history: result.nextHistory,
      };
    }

    case 'redo': {
      const cleaned = state.draft.isDirty ? draftCancel(state.draft) : state.draft;
      const result = historyRedo(state.history, cleaned.base);
      if (!result) return { ...state, draft: cleaned };
      return {
        draft: newDraft(result.nextProject),
        history: result.nextHistory,
      };
    }
  }
}

/**
 * The single hook entry point for v0.4 editing. Captures `initial` once
 * on first mount (subsequent renders with a different `initial` are
 * ignored — consumers reset by remounting via `key={projectId}`).
 *
 * Every effective state change is run through `schedule()` so the
 * returned `project` always has fresh CPM data. Per ADR-005 (engine-first).
 */
export function useEditableProject(initial: Project): EditableProject {
  // Capture initial once. useRef freezes the value across re-renders.
  const initialRef = useRef(initial);

  const [state, dispatch] = useReducer(
    reducer,
    undefined,
    (): EditingState => ({
      draft: newDraft(initialRef.current),
      history: newHistory(),
    }),
  );

  const scheduled = useMemo(() => schedule(state.draft.effective), [state.draft.effective]);

  return {
    project: scheduled,
    isDirty: state.draft.isDirty,
    canUndo: state.history.canUndo,
    canRedo: state.history.canRedo,
    enqueue: (command) => dispatch({ type: 'enqueue', command }),
    commit: (label = 'Edit') => dispatch({ type: 'commit', label }),
    cancel: () => dispatch({ type: 'cancel' }),
    undo: () => dispatch({ type: 'undo' }),
    redo: () => dispatch({ type: 'redo' }),
  };
}
