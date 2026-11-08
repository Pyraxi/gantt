// MSPDI outline codes ↔ activity codes (parity row 8): MS Project's Outline
// Code1..10 lookup tables ↔ Project.codeTypes, task values ↔ Task.codes.
// Spec: docs/superpowers/specs/2026-10-16-mspdi-outline-codes-design.md
//
// Microsoft's Project 2007 schema: a project <OutlineCodes><OutlineCode> (Guid,
// FieldID, Values, Masks) is paired with a project <ExtendedAttribute> (same
// FieldID, Alias, Ltuid = Guid); a task <OutlineCode> carries FieldID, ValueID
// and ValueGUID (= the value's FieldGUID). "Project 2007 ignores ValueID and
// uses ValueGUID"; MPXJ writes ValueID only. We read either and write both.

/**
 * Task Outline Code1..10 FieldIDs (pjCustomTaskOutlineCodeN). Verified
 * against MPXJ 16.4 `FieldTypeHelper.getFieldID(TaskField.OUTLINE_CODEn)` and
 * Microsoft's Outline Code6 example (188744106). A literal table, not
 * arithmetic, so one typo can't shift every slot.
 */
export const OUTLINE_CODE_FIELD_IDS = {
  1: 188744096,
  2: 188744098,
  3: 188744100,
  4: 188744102,
  5: 188744104,
  6: 188744106,
  7: 188744108,
  8: 188744110,
  9: 188744112,
  10: 188744114,
} as const;

export type OutlineCodeField = keyof typeof OUTLINE_CODE_FIELD_IDS;

/** FieldID → field number, for the task outline-code FieldIDs. */
export const OUTLINE_CODE_FIELD_BY_ID: ReadonlyMap<number, OutlineCodeField> = new Map(
  Object.entries(OUTLINE_CODE_FIELD_IDS).map(([n, id]) => [id, Number(n) as OutlineCodeField]),
);

/** Write a `Project.codeTypes` entry as an MS Project task outline code. */
export interface OutlineCodeMapping {
  /** `CodeType.id` whose values (and every task's `codes[codeTypeId]`) are written. */
  codeTypeId: string;
  /** Target MS Project field: Outline Code1..10. */
  field: OutlineCodeField;
}

/**
 * A deterministic GUID (uppercase 8-4-4-4-12) from a string: the same project
 * writes the same GUIDs on every export, so a re-export doesn't look like new
 * fields / values to MS Project. Not cryptographic; four 32-bit FNV-1a lanes,
 * with the RFC 4122 version (5) and variant bits set.
 */
export function stableGuid(seed: string): string {
  const lanes = [0x811c9dc5, 0x01000193, 0x9e3779b9, 0x85ebca6b];
  const out = lanes.map((basis, lane) => {
    let h = basis >>> 0;
    const s = `${lane}:${seed}`;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  });
  // RFC 4122 shape: version nibble 5, variant 10xx (8–B) — name-based-looking.
  const raw = out.join('').toUpperCase();
  const variant = ((Number.parseInt(raw[16] as string, 16) & 0x3) | 0x8).toString(16).toUpperCase();
  const hex = `${raw.slice(0, 12)}5${raw.slice(13, 16)}${variant}${raw.slice(17)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
