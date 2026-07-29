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
}
