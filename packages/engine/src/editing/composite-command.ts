import type { Project } from '../types.js';
import type { EditCommand } from './commands.js';

/**
 * Wraps N EditCommands into a single history entry. Apply runs each
 * member in order; if any throws, the whole composite throws (caller
 * sees a single error — the no-partial-output guarantee). Inverse walks
 * members in REVERSE order, collecting each member's inverse — which
 * reads from the snapshot captured during the member's apply.
 *
 * Single-use semantics: composite.apply() MUST be called before
 * composite.inverse(), because the stateful member commands
 * (Update*Command, Delete*Command) only have their snapshots after
 * apply(). Calling inverse() without apply() throws the underlying
 * member's "apply() was not called" EditError.
 *
 * **Contract caveat for members.** This implementation assumes every
 * member is either stateless (Create*Command — its inverse derives
 * from constructor args) or uses the snapshot-at-apply pattern (the
 * built-in Update*Command and Delete*Command). The `_project` arg
 * passed to each member's `inverse()` here is the composite's `_project`
 * (the post-composite-apply state), NOT the post-member-apply state
 * for that particular member. Built-in stateful commands ignore the
 * arg and read their own snapshot, so this works correctly.
 *
 * If a future EditCommand implementation needs the actual post-member-
 * apply state inside a composite, the implementation must either:
 *   (a) adopt snapshot-at-apply itself (recommended — matches built-ins),
 *   (b) extend CompositeCommand to walk the apply chain and pass each
 *       member its specific post-state to inverse().
 *
 * Produced by DraftProject.commit() when N>1 pending commands need to
 * land as one history entry. Single-pending-command commits return
 * the member directly without wrapping (per DraftProject contract).
 */
export class CompositeCommand implements EditCommand {
  readonly kind = 'composite';
  readonly label: string;
  readonly members: ReadonlyArray<EditCommand>;

  constructor(members: ReadonlyArray<EditCommand>, label: string) {
    this.members = members;
    this.label = label;
  }

  apply(project: Project): Project {
    let cur = project;
    for (const cmd of this.members) {
      cur = cmd.apply(cur);
    }
    return cur;
  }

  inverse(_project: Project): EditCommand {
    // Members store their own pre-state via snapshot-at-apply. We just
    // collect each member's inverse in reverse order.
    const inverses: EditCommand[] = [];
    const reversed = [...this.members].reverse();
    for (const cmd of reversed) {
      inverses.push(cmd.inverse(_project));
    }
    return new CompositeCommand(inverses, `Undo: ${this.label}`);
  }
}
