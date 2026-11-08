import type { Project } from '@pyraxi/cpm-engine';
import { jsPDF } from 'jspdf';
import type { OffscreenGanttProps } from './offscreen.js';
import { computeImageFit, PAGE_DIMENSIONS_MM, paginateRows } from './pdf-dimensions.js';
import { captureSVG, exportPNG } from './png.js';
import type { PdfExportOptions } from './types.js';

export async function exportPDF(args: {
  scheduled: Project;
  ganttProps: OffscreenGanttProps;
  /** `--cg-*` theme tokens resolved on screen. */
  themeVars?: Record<string, string>;
  options: PdfExportOptions;
}): Promise<Blob> {
  const { scheduled, ganttProps, themeVars, options } = args;
  const orientation = options.orientation ?? 'landscape';
  const format = options.format ?? 'a3';
  const margin = options.margin ?? 10;
  const backgroundColor = options.backgroundColor ?? '#ffffff';
  const page = PAGE_DIMENSIONS_MM[format]?.[orientation];
  if (!page) throw new RangeError(`exportPDF: unknown format "${format}"`);
  if (!(margin >= 0) || 2 * margin >= Math.min(page.width, page.height)) {
    throw new RangeError(
      `exportPDF: margin ${margin} mm leaves no room on ${format} ${orientation}`,
    );
  }

  if (options.pagination === 'vertical') {
    return exportPaginatedPDF({ scheduled, ganttProps, themeVars, options, backgroundColor });
  }

  const pngBlob = await exportPNG({
    scheduled,
    ganttProps,
    themeVars,
    options: { backgroundColor },
  });

  const dataUrl = await blobToDataUrl(pngBlob);
  const { width: pngPxWidth, height: pngPxHeight } = await loadImage(dataUrl);

  const fit = computeImageFit({
    pageWidth: page.width,
    pageHeight: page.height,
    margin,
    pngPxWidth,
    pngPxHeight,
  });

  const pdf = new jsPDF({ orientation, unit: 'mm', format });
  // Flate-compress the image: jsPDF's default stores raw pixels (a tall
  // programme capture was ~80 MB).
  pdf.addImage(dataUrl, 'PNG', fit.x, fit.y, fit.width, fit.height, undefined, 'FAST');
  return pdf.output('blob');
}

// Title band + footer heights (mm) for paginated output.
const TITLE_BAND_MM = 12;
const SUBTITLE_EXTRA_MM = 5;
const FOOTER_BAND_MM = 8;
/** Page raster resolution: device px per CSS px (≈190 dpi across A3 for a typical chart). */
const PAGE_PIXEL_RATIO = 2;
const JPEG_QUALITY = 0.92;
const MAX_CANVAS_SIDE = 16_384;
/** One CSS px at 96 dpi: paginated output never prints the chart larger than on screen. */
const ACTUAL_SIZE_MM_PER_PX = 25.4 / 96;

async function exportPaginatedPDF(args: {
  scheduled: Project;
  ganttProps: Parameters<typeof exportPDF>[0]['ganttProps'];
  themeVars?: Record<string, string>;
  options: PdfExportOptions;
  backgroundColor: string;
}): Promise<Blob> {
  const { scheduled, ganttProps, themeVars, options, backgroundColor } = args;
  const orientation = options.orientation ?? 'landscape';
  const format = options.format ?? 'a3';
  const margin = options.margin ?? 10;
  // Validate cheap inputs before the (slow) capture.
  const dateText = formatBandDate(options.date);
  const page = PAGE_DIMENSIONS_MM[format][orientation];
  const titleBand = TITLE_BAND_MM + (options.subtitle ? SUBTITLE_EXTRA_MM : 0);
  const contentW = page.width - 2 * margin;
  const contentH = page.height - 2 * margin - titleBand - FOOTER_BAND_MM;
  if (contentH <= 0) {
    throw new RangeError(
      `exportPDF: margin ${margin} mm leaves no room for the chart on ${format}`,
    );
  }

  // One SVG clone, rasterised per page: no single canvas holds the whole
  // programme, so the 16,384 px canvas limit never downsamples a tall one.
  const { svgUrl, metrics } = await captureSVG({
    scheduled,
    ganttProps,
    themeVars,
    backgroundColor,
  });
  const img = await loadImage(svgUrl);
  const { scale, pages } = paginateRows({
    imgW: metrics.width,
    imgH: metrics.height,
    headerPx: metrics.headerPx,
    rowPx: metrics.rowPx,
    rowCount: metrics.rowCount,
    contentW,
    contentH,
    maxScale: ACTUAL_SIZE_MM_PER_PX,
  });

  const pdf = new jsPDF({ orientation, unit: 'mm', format });
  // Chrome caps a canvas side at 65,535 px and html-to-image at 16,384; keep
  // a very wide (long day-zoom) chart within the latter rather than throw.
  const pr = Math.min(PAGE_PIXEL_RATIO, MAX_CANVAS_SIDE / metrics.width);
  const band = titleBandImage(options, dateText, contentW, titleBand, pr);
  pages.forEach((slice, i) => {
    if (i > 0) pdf.addPage(format, orientation);
    drawTitleBand(pdf, options, dateText, band, margin, page.width, titleBand);

    // Header strip + this page's rows, rasterised from the SVG at `pr`.
    const bodyCss = slice.endPx - slice.startPx;
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(metrics.width * pr);
    canvas.height = Math.ceil((metrics.headerPx + bodyCss) * pr);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('exportPDF: 2D canvas unavailable');
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const w = metrics.width;
    ctx.drawImage(img, 0, 0, w, metrics.headerPx, 0, 0, w * pr, metrics.headerPx * pr);
    if (bodyCss > 0) {
      ctx.drawImage(
        img,
        0,
        slice.startPx,
        w,
        bodyCss,
        0,
        metrics.headerPx * pr,
        w * pr,
        bodyCss * pr,
      );
    }
    // JPEG: jsPDF embeds it as-is (DCTDecode). A PNG page is decoded and
    // re-deflated in JS — ~6 s per A3 page at 2× — for a barely visible gain.
    pdf.addImage(
      canvas.toDataURL('image/jpeg', JPEG_QUALITY),
      'JPEG',
      margin,
      margin + titleBand,
      metrics.width * scale,
      (metrics.headerPx + bodyCss) * scale,
    );
    pdf.setFontSize(9);
    pdf.text(`Page ${i + 1} of ${pages.length}`, page.width / 2, page.height - margin, {
      align: 'center',
    });
  });
  return pdf.output('blob');
}

function formatBandDate(date: PdfExportOptions['date']): string {
  if (date === false) return '';
  const d = date === undefined ? new Date() : new Date(date as Date | string | number);
  if (Number.isNaN(d.getTime())) throw new TypeError(`exportPDF: invalid date ${String(date)}`);
  return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** jsPDF's built-in fonts are WinAnsi only: macrons (Ōtaki, Whangārei) would print as garbage. */
const isLatin1 = (s: string) => [...s].every((c) => (c.codePointAt(0) ?? 0) <= 0xff);

/**
 * The title band as an image, drawn with the browser's fonts, when any band
 * text needs characters jsPDF's standard fonts can't encode. `undefined` when
 * vector text will do.
 */
function titleBandImage(
  options: PdfExportOptions,
  dateText: string,
  widthMm: number,
  heightMm: number,
  pr: number,
): string | undefined {
  if (isLatin1(`${options.title ?? ''}${options.subtitle ?? ''}${dateText}`)) return undefined;
  const pxPerMm = (96 / 25.4) * pr;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(widthMm * pxPerMm);
  canvas.height = Math.ceil(heightMm * pxPerMm);
  const ctx = canvas.getContext('2d');
  if (!ctx) return undefined;
  const pt = (n: number) => `${((n * 25.4) / 72) * pxPerMm}px sans-serif`; // pt → canvas px
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.font = pt(10);
  const dateW = dateText ? ctx.measureText(dateText).width : 0;
  if (dateText) ctx.fillText(dateText, canvas.width - dateW, 7 * pxPerMm);
  ctx.font = pt(14);
  if (options.title)
    ctx.fillText(options.title, 0, 7 * pxPerMm, canvas.width - dateW - 4 * pxPerMm);
  ctx.font = pt(10);
  if (options.subtitle)
    ctx.fillText(options.subtitle, 0, (7 + SUBTITLE_EXTRA_MM) * pxPerMm, canvas.width);
  return canvas.toDataURL('image/png');
}

function drawTitleBand(
  pdf: jsPDF,
  options: PdfExportOptions,
  dateText: string,
  bandImage: string | undefined,
  margin: number,
  pageWidth: number,
  titleBand: number,
): void {
  const contentW = pageWidth - 2 * margin;
  if (bandImage) {
    pdf.addImage(bandImage, 'PNG', margin, margin, contentW, titleBand, 'title-band', 'FAST');
  } else {
    pdf.setFontSize(10);
    const dateW = dateText ? pdf.getTextWidth(dateText) : 0;
    if (dateText) pdf.text(dateText, pageWidth - margin, margin + 7, { align: 'right' });
    pdf.setFontSize(14);
    if (options.title)
      pdf.text(fitText(pdf, options.title, contentW - dateW - 4), margin, margin + 7);
    pdf.setFontSize(10);
    if (options.subtitle) {
      pdf.text(fitText(pdf, options.subtitle, contentW), margin, margin + 7 + SUBTITLE_EXTRA_MM);
    }
  }
  pdf.setDrawColor(180);
  pdf.line(margin, margin + titleBand - 2, pageWidth - margin, margin + titleBand - 2);
}

/** Truncate with an ellipsis to fit `maxMm` at the current font size. */
function fitText(pdf: jsPDF, text: string, maxMm: number): string {
  if (pdf.getTextWidth(text) <= maxMm) return text;
  let s = text;
  while (s.length > 1 && pdf.getTextWidth(`${s}…`) > maxMm) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load the captured PNG'));
    img.src = dataUrl;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}
