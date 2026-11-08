// MSPDI local Text custom-field support (ExtendedAttributes).
//
// Round-trips host-owned `Task.extra` values through MS Project's local Text
// custom fields (Text1..Text30): a project-level <ExtendedAttributes> definition
// (FieldID + FieldName + Alias) plus a per-task <ExtendedAttribute> (FieldID +
// Value). See docs/superpowers/specs/2026-07-13-mspdi-extended-attributes-design.md.

/**
 * FieldID for each MS Project local Text custom field, keyed by field name.
 *
 * ONLY verified values ship here. `Text1 = 188743731` is confirmed in two
 * Microsoft docs ("Custom Field Data in XML", "XML Schema for the
 * ExtendedAttributes Element") — it is the pjCustomTaskText1 PjCustomField value.
 *
 * WARNING: Text11–Text30 PIDs are NOT contiguous with Text1–Text10 (a later PID
 * block), so a naive `188743731 + n` formula is WRONG from Text11 on. Extend this
 * table only with FieldIDs verified empirically (round-trip a fixture through
 * MPXJ and read the emitted <FieldID>), never by extrapolation. A `field` the
 * table doesn't contain throws on serialize — a safe failure, not a wrong write.
 */
/**
 * Task-class custom-field FieldIDs live in the 0x0B40xxxx block
 * (pjCustomTaskText1 = 0x0B400000 + 51; enterprise task fields stay below
 * +0xFFFF). Resource fields are 0x0C40xxxx, so a range check separates them.
 */
export const TASK_FIELD_ID_MIN = 0x0b400000;
export const TASK_FIELD_ID_MAX = 0x0b40ffff;

export const TEXT_FIELD_IDS: Record<string, number> = {
  Text1: 188743731,
};

/**
 * Map a host-owned `Task.extra` value into an MS Project local Text custom field.
 *
 * `extraKey` (not a `from` callback) keeps the round-trip symmetric: serialize
 * writes `task.extra[extraKey]` under `alias`; parse reads it back onto
 * `task.extra[alias]`. `alias` defaults to `extraKey`.
 */
export interface ExtendedAttributeMapping {
  /** Target MS Project Text field: 'Text1'..'Text30' (validated against TEXT_FIELD_IDS). */
  field: `Text${number}`;
  /** `Task.extra` key whose value is written (as `String(...)`). */
  extraKey: string;
  /** The <Alias> in the project-level definition; also the key parse maps back onto. Defaults to `extraKey`. */
  alias?: string;
}

/**
 * When `remapIdsToIntegers` is on, one entry per (namespace, original id) → the
 * integer UID assigned. Pushed into the caller-provided `idRemap` collector for
 * debugging/correlation (mirrors the `droppedFields` pattern).
 */
export interface IdRemapEntry {
  namespace: 'task' | 'resource' | 'calendar' | 'assignment';
  originalId: string;
  uid: number;
}
