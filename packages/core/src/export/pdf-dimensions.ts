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
export const PAGE_DIMENSIONS_MM: Record<
  'a4' | 'a3' | 'letter',
  { landscape: PageDimensions; portrait: PageDimensions }
> = {
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
