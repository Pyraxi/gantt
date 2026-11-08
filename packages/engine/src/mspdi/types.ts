// MSPDI (Microsoft Project Data Interchange) XML — internal types.
//
// MSPDI is MS Project's XML export format, schema-defined as `mspdi_pj12.xsd`.
// We support a documented subset of the schema; unsupported fields surface
// in the `droppedFields` accumulator on parse rather than being silent drops.
//
// Scope of v0.2 first cut: Tasks + Links (PredecessorLink). Calendars,
// Resources, Assignments, and the rich set of cost/work fields land in
// subsequent commits.

import type { Project } from '../types.js';
import type { ExtendedAttributeMapping, IdRemapEntry } from './extended-attributes.js';
import type { OutlineCodeMapping } from './outline-codes.js';

/**
 * Result of parsing an MSPDI XML document.
 *
 * `project` is our internal SVAR-agnostic Project shape.
 * `droppedFields` enumerates MSPDI fields we encountered but did not map,
 * for consumer transparency. Each entry: the JSON-path-like location, the
 * raw value, and a short reason (`'unsupported-element'`, `'unsupported-attribute'`,
 * `'lossy-on-roundtrip'`).
 */
export interface MspdiParseResult {
  project: Project;
  droppedFields: DroppedField[];
}

export interface DroppedField {
  /** Dotted path to the location in the MSPDI document, e.g. `Project.Tasks.Task[2].Notes`. */
  path: string;
  /** The raw value we saw and chose not to map. Stringified for diagnostic only.
   * Note: this field is used on both the parse path (raw document value) and the
   * serialize path (internal representation value); the meaning is contextual. */
  value: string;
  /** Why it wasn't carried into the internal Project. */
  reason: 'unsupported-element' | 'unsupported-attribute' | 'lossy-on-roundtrip';
}

/**
 * Options accepted by `serializeMspdi`.
 */
export interface MspdiSerializeOptions {
  /**
   * Override the root project metadata. Defaults match MS Project 2016+
   * defaults where applicable. Optional fields not set here are omitted
   * from the output.
   */
  meta?: {
    /** `<Name>` — defaults to 'Untitled'. */
    name?: string;
    /** `<Author>` — defaults to omitted. */
    author?: string;
    /** `<Title>` — defaults to the same as `name`. */
    title?: string;
  };
  /**
   * If provided, fields that cannot round-trip cleanly through MSPDI are
   * pushed here instead of being silently dropped. Mirrors the droppedFields
   * accumulator on the parse side.
   *
   * Example: Task.segments[] has no direct MSPDI encoding and is pushed with
   * reason 'lossy-on-roundtrip'.
   */
  droppedFields?: DroppedField[];
  /**
   * Write host-owned `Task.extra` values into MS Project local Text custom
   * fields (Text1..Text30). Each mapping emits a project-level definition +
   * a per-task `<ExtendedAttribute>` value; parse reads them back onto
   * `Task.extra` (keyed by alias). Opt-in.
   */
  extendedAttributes?: ExtendedAttributeMapping[];
  /**
   * Write `Project.codeTypes` as MS Project task outline codes (Outline
   * Code1..10): a lookup table per code type, its paired definition (Alias =
   * the code type's name), and each task's `codes[codeTypeId]` value. Parse
   * reads them back automatically, keyed by name. Opt-in; unmapped code types
   * are reported in `droppedFields`.
   */
  outlineCodes?: OutlineCodeMapping[];
  /**
   * Emit every UID (task, resource, calendar, assignment) as a sequential
   * integer from 1, per namespace, with all cross-references rewritten
   * consistently. MS Project requires integer UIDs; pair with an
   * `extendedAttributes` mapping to carry your original id through MS Project
   * as a stable merge key. Opt-in; default emits ids as-is.
   *
   * Independently of this flag, a reference to an id that is not in the
   * project (a link source, an assignment endpoint, a calendarId) is never
   * emitted — the referencing element is dropped and reported in
   * `droppedFields` (a passed-through id could collide with a real UID).
   */
  remapIdsToIntegers?: boolean;
  /** When `remapIdsToIntegers` is on, receives one entry per (namespace, original id) → UID. */
  idRemap?: IdRemapEntry[];
}
