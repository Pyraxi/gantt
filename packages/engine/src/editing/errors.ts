/**
 * Thrown when an EditCommand's pre-conditions fail (e.g. target task
 * doesn't exist, FS-link-to-self, malformed patch). Caught at the hook
 * boundary so consumers see a typed error rather than a generic Error.
 */
export class EditError extends Error {
  readonly commandKind: string;

  constructor(message: string, commandKind: string) {
    super(message);
    this.name = 'EditError';
    this.commandKind = commandKind;
  }
}
