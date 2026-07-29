// @pyraxi/gantt — SVAR React view for the Pyraxi CPM Engine.
//
// Re-exports the full @pyraxi/cpm-engine public API (so consumers can pull the
// engine + the component from one import), then adds the React component, the
// editing hooks, and the export ref-handle types. Renderer is SVAR's free-tier
// React Gantt (MIT) per ADR-002 — "powered by SVAR".

export * from '@pyraxi/cpm-engine';
export type { EditableProject } from './editing/use-editable-project.js';
// Editing hooks (React bindings over the engine's command model)
export { useEditableProject } from './editing/use-editable-project.js';
export type { EditableField, TaskEditPatch } from './editing/useEditState.js';
// Export ref-handle types (PNG/PDF/XLSX — impl lazy-loaded via the ./export subpath)
export type {
  GanttHandle,
  PdfExportOptions,
  PngExportOptions,
  XlsxColumn,
  XlsxExportOptions,
} from './export/types.js';
export type {
  DisplayOptionsConfig,
  GanttColumn,
  GanttColumnEditor,
  GanttMarker,
  GanttProps,
} from './Gantt.js';
// Public React component
export { Gantt } from './Gantt.js';
// Column factories
export {
  formatPredecessors,
  idColumn,
  type PredecessorFormatOptions,
  predecessorsColumn,
} from './predecessors.js';
// Bolt-in structural-commit contract types (ADR-010) — the shape `onStructuralCommit`
// emits; consumers import these to type their persistence handler.
export type { StructuralChange, StructuralOp } from './structural-commit.js';
// Consumer helper: map a SVAR add-task partial (as handed to `onTaskAdd`) to a
// full engine Task with sane defaults. Shared with the internal onStructuralCommit path.
export { svarPartialToTask } from './svar-adapter.js';
// Installed package version (kept in sync with package.json via version.test.ts).
// Server components / server builds should import from the client-free
// `@pyraxi/gantt/version` subpath instead — importing VERSION from this main
// entry pulls the client bundle (@svar-ui + CSS, jspdf, xlsx) into the server
// graph. This re-export is for client-side convenience.
export { VERSION } from './version.js';
