import type { Project } from '../types.js';
import type { EditCommand } from './commands.js';

/**
 * Past/future command stacks for undo/redo. Immutable value type;
 * every operation returns a new CommandHistory.
 *
 * Per ADR-006: a new pushCommand after undo clears the future stack
 * (standard editor behaviour — new edit branches off).
 */
export interface CommandHistory {
  readonly past: ReadonlyArray<EditCommand>;
  readonly future: ReadonlyArray<EditCommand>;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export function newHistory(): CommandHistory {
  return { past: [], future: [], canUndo: false, canRedo: false };
}

export function pushCommand(h: CommandHistory, command: EditCommand): CommandHistory {
  return {
    past: [...h.past, command],
    future: [],
    canUndo: true,
    canRedo: false,
  };
}

export interface UndoResult {
  readonly nextHistory: CommandHistory;
  readonly nextProject: Project;
  readonly undoneCommand: EditCommand;
}

export function undo(h: CommandHistory, project: Project): UndoResult | null {
  if (h.past.length === 0) return null;
  const cmd = h.past[h.past.length - 1];
  if (!cmd) return null; // unreachable under noUncheckedIndexedAccess; preserves type narrowing
  const inverse = cmd.inverse(project);
  const nextProject = inverse.apply(project);
  const nextPast = h.past.slice(0, -1);
  return {
    nextHistory: {
      past: nextPast,
      future: [...h.future, cmd],
      canUndo: nextPast.length > 0,
      canRedo: true,
    },
    nextProject,
    undoneCommand: cmd,
  };
}

export interface RedoResult {
  readonly nextHistory: CommandHistory;
  readonly nextProject: Project;
  readonly redoneCommand: EditCommand;
}

export function redo(h: CommandHistory, project: Project): RedoResult | null {
  if (h.future.length === 0) return null;
  const cmd = h.future[h.future.length - 1];
  if (!cmd) return null; // unreachable under noUncheckedIndexedAccess; preserves type narrowing
  const nextProject = cmd.apply(project);
  const nextFuture = h.future.slice(0, -1);
  return {
    nextHistory: {
      past: [...h.past, cmd],
      future: nextFuture,
      canUndo: true,
      canRedo: nextFuture.length > 0,
    },
    nextProject,
    redoneCommand: cmd,
  };
}
