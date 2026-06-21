// Public types for the @pyraxi/gantt/export subpath.
// Imported by the core <Gantt> for its ref handle, and re-exported
// from the subpath entry for direct consumer use.

import type { Task } from '@pyraxi/cpm-engine';

export interface PngExportOptions {
  /** Background colour for the captured canvas. Defaults to '#ffffff'. */
  backgroundColor?: string;
  /** Pixel ratio. Defaults to window.devicePixelRatio || 2. */
  pixelRatio?: number;
}

export interface PdfExportOptions {
  /** Page orientation. Defaults to 'landscape' (Gantt charts are wide). */
  orientation?: 'landscape' | 'portrait';
  /** Page size. Defaults to 'a3'. */
  format?: 'a4' | 'a3' | 'letter';
  /** Margin in mm. Defaults to 10. */
  margin?: number;
  /** Background colour for the underlying PNG. Defaults to '#ffffff'. */
  backgroundColor?: string;
}

export interface XlsxColumn {
  header: string;
  /** A key on Task, or a function returning the cell value. */
  value: keyof Task | ((task: Task) => string | number | Date | undefined);
}

export interface XlsxExportOptions {
  /** Sheet name. Defaults to 'Programme'. */
  sheetName?: string;
  /** Override the default column set. */
  columns?: XlsxColumn[];
}

export interface GanttHandle {
  exportPNG(options?: PngExportOptions): Promise<Blob>;
  exportPDF(options?: PdfExportOptions): Promise<Blob>;
  exportXLSX(options?: XlsxExportOptions): Promise<Blob>;
}
