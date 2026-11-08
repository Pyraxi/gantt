// Pure-function image-fit math. Used by the PDF exporter to scale the
// captured PNG onto a chosen page format with a uniform margin while
// preserving aspect ratio. Kept separate from pdf.ts so it can be
// Vitest-covered without instantiating jsPDF.

export interface PageDimensions {
  /** Width in millimetres. */
  width: number;
  /** Height in millimetres. */
  height: number;
}

export interface ImageFit {
  /** Image render width in millimetres. */
  width: number;
  /** Image render height in millimetres. */
  height: number;
  /** Image origin X (from top-left) in millimetres. */
  x: number;
  /** Image origin Y (from top-left) in millimetres. */
  y: number;
}

// Standard print dimensions (ISO 216 + ANSI Letter), in millimetres.
export type PageFormat = 'a1' | 'a2' | 'a3' | 'a4' | 'letter';

export const PAGE_DIMENSIONS_MM: Record<
  PageFormat,
  { landscape: PageDimensions; portrait: PageDimensions }
> = {
  a1: {
    portrait: { width: 594, height: 841 },
    landscape: { width: 841, height: 594 },
  },
  a2: {
    portrait: { width: 420, height: 594 },
    landscape: { width: 594, height: 420 },
  },
  a4: {
    portrait: { width: 210, height: 297 },
    landscape: { width: 297, height: 210 },
  },
  a3: {
    portrait: { width: 297, height: 420 },
    landscape: { width: 420, height: 297 },
  },
  letter: {
    portrait: { width: 215.9, height: 279.4 },
    landscape: { width: 279.4, height: 215.9 },
  },
};

export function computeImageFit(args: {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  pngPxWidth: number;
  pngPxHeight: number;
}): ImageFit {
  const { pageWidth, pageHeight, margin, pngPxWidth, pngPxHeight } = args;
  const availableWidth = pageWidth - 2 * margin;
  const availableHeight = pageHeight - 2 * margin;

  const widthScale = availableWidth / pngPxWidth;
  const heightScale = availableHeight / pngPxHeight;
  const scale = Math.min(widthScale, heightScale);

  const width = pngPxWidth * scale;
  const height = pngPxHeight * scale;
  const x = (pageWidth - width) / 2;
  const y = (pageHeight - height) / 2;

  return { width, height, x, y };
}

export interface RowPagination {
  /** Millimetres per image pixel (content width / image width, capped by `maxScale`). */
  scale: number;
  /** Body slices in image px, `[startPx, endPx)`, each a whole number of rows. */
  pages: { startPx: number; endPx: number }[];
}

/**
 * Vertical pagination of a captured Gantt image (parity row 13): scale to the
 * content width, repeat the `headerPx` strip on every page, and break the body
 * only on row boundaries. All inputs are image px except `contentW`/`contentH`
 * (mm, the area left for header + body). A page too short for one row still
 * gets one, so pagination always terminates.
 */
export function paginateRows(args: {
  imgW: number;
  imgH: number;
  headerPx: number;
  rowPx: number;
  rowCount: number;
  contentW: number;
  contentH: number;
  /** Upper bound on mm per image px (e.g. actual size). Default: unbounded. */
  maxScale?: number;
}): RowPagination {
  const { imgW, imgH, headerPx, rowPx, rowCount, contentW, contentH } = args;
  // Fit the width, but never enlarge past actual size: a narrow chart fitted to
  // A1 would otherwise print a handful of giant rows per page.
  const scale = Math.min(contentW / imgW, args.maxScale ?? Number.POSITIVE_INFINITY);
  const bodyEnd = Math.min(imgH, headerPx + Math.max(0, rowCount) * rowPx);
  const bodyMmPerPage = contentH - headerPx * scale;
  const rowsPerPage = Math.max(1, Math.floor(bodyMmPerPage / (rowPx * scale)));
  const pages: RowPagination['pages'] = [];
  for (let start = headerPx; start < bodyEnd; start += rowsPerPage * rowPx) {
    pages.push({ startPx: start, endPx: Math.min(bodyEnd, start + rowsPerPage * rowPx) });
  }
  if (pages.length === 0) pages.push({ startPx: headerPx, endPx: headerPx });
  return { scale, pages };
}
