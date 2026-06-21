import type { Project } from '../types.js';
import type { EditCommand } from './commands.js';
import { CompositeCommand } from './composite-command.js';
import { EditError } from './errors.js';

/**
 * Overlay over a committed Project. Pending commands are applied
 * left-to-right to produce the `effective` Project that the renderer
 * reads. Commit promotes pending into a single history entry; cancel
 * discards them.
 *
 * Immutable value type — all operations return new instances.
 */
export interface DraftProject {
  readonly base: Project;
  readonly pending: ReadonlyArray<EditCommand>;
  readonly effective: Project;
  readonly isDirty: boolean;
}

export function newDraft(base: Project): DraftProject {
  return { base, pending: [], effective: base, isDirty: false };
}

export function enqueue(draft: DraftProject, command: EditCommand): DraftProject {
  const effective = command.apply(draft.effective);
  return {
    base: draft.base,
    pending: [...draft.pending, command],
    effective,
    isDirty: true,
  };
}

export interface CommitResult {
  /** The new committed Project (becomes the next base). */
  readonly newBase: Project;
  /** Single command (if pending was 1) or CompositeCommand wrapping the pending list. */
  readonly compound: EditCommand;
}

export function commit(draft: DraftProject, label: string = 'Edit'): CommitResult {
  if (draft.pending.length === 0) {
    throw new EditError('cannot commit an empty draft', 'commit');
  }

  const compound =
    draft.pending.length === 1 ? draft.pending[0] : new CompositeCommand(draft.pending, label);

  if (!compound) {
    throw new EditError('unreachable: empty pending', 'commit');
  }

  return { newBase: draft.effective, compound };
}

export function cancel(draft: DraftProject): DraftProject {
  return newDraft(draft.base);
}
