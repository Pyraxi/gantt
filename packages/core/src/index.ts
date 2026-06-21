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
export type { GanttColumn, GanttMarker, GanttProps } from './Gantt.js';
// Public React component
export { Gantt } from './Gantt.js';
