// Public types for the construction-gantt/export subpath.
// Imported by the core <Gantt> for its ref handle, and re-exported
// from the subpath entry for direct consumer use.

import type { Task } from '@pyraxi/cpm-engine';
import type { PageFormat } from './pdf-dimensions.js';

export interface PngExportOptions {
  /**
   * Background colour for the captured canvas. Defaults to '#ffffff'. The
   * chart itself keeps its theme's surfaces (SVAR's Willow paints the grid and
   * timeline white), so this shows only where the chart doesn't paint: it
   * doesn't make a dark export on its own.
   */
  backgroundColor?: string;
  /** Pixel ratio. Defaults to window.devicePixelRatio || 2. */
  pixelRatio?: number;
}

export interface PdfExportOptions {
  /** Page orientation. Defaults to 'landscape' (Gantt charts are wide). */
  orientation?: 'landscape' | 'portrait';
  /** Page size. Defaults to 'a3'. */
  format?: PageFormat;
  /** Margin in mm. Defaults to 10. */
  margin?: number;
  /** Background colour for the underlying PNG. Defaults to '#ffffff'; see `PngExportOptions.backgroundColor`. */
  backgroundColor?: string;
  /**
   * `'none'` (default): the whole chart scaled onto one page.
   * `'vertical'`: fit the page width and run rows over as many pages as
   * needed, never splitting a row, with the column header / timescale
   * repeated on every page, a title band and a `Page N of M` footer.
   */
  pagination?: 'none' | 'vertical';
  /** Title band text (paginated output). */
  title?: string;
  /** Second title-band line, e.g. site address or revision (paginated output). */
  subtitle?: string;
  /** Date printed in the title band. Defaults to today; `false` hides it (paginated output). */
  date?: Date | false;
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
  /**
   * `'all'` (default): the whole programme, whatever the screen filter. A
   * filtered .xlsx opened later reads as "the programme", so it's never
   * truncated silently (coord decision 2026-10-16). `'visible'`: only the
   * tasks in `<Gantt visibleTaskIds>`, as PNG / PDF show. (The chart draws a
   * filtered-in task whose parent is filtered out under its nearest visible
   * ancestor; the sheet lists the filtered tasks.)
   */
  scope?: 'visible' | 'all';
}

export interface GanttHandle {
  exportPNG(options?: PngExportOptions): Promise<Blob>;
  exportPDF(options?: PdfExportOptions): Promise<Blob>;
  exportXLSX(options?: XlsxExportOptions): Promise<Blob>;
}
