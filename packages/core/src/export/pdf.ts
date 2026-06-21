import type { Project } from '@pyraxi/cpm-engine';
import { jsPDF } from 'jspdf';
import type { GanttProps } from '../Gantt.js';
import { computeImageFit, PAGE_DIMENSIONS_MM } from './pdf-dimensions.js';
import { exportPNG } from './png.js';
import type { PdfExportOptions } from './types.js';

export async function exportPDF(args: {
  scheduled: Project;
  ganttProps: Pick<
    GanttProps,
    | 'cellWidth'
    | 'cellHeight'
    | 'markers'
    | 'baselineIndex'
    | 'baselineIndices'
    | 'showBaselineBars'
    | 'columns'
    | 'height'
    | 'visibleTaskIds'
  >;
  options: PdfExportOptions;
}): Promise<Blob> {
  const { scheduled, ganttProps, options } = args;
  const orientation = options.orientation ?? 'landscape';
  const format = options.format ?? 'a3';
  const margin = options.margin ?? 10;
  const backgroundColor = options.backgroundColor ?? '#ffffff';

  const pngBlob = await exportPNG({
    scheduled,
    ganttProps,
    options: { backgroundColor },
  });

  const dataUrl = await blobToDataUrl(pngBlob);
  const { width: pngPxWidth, height: pngPxHeight } = await probeImageDimensions(dataUrl);

  const page = PAGE_DIMENSIONS_MM[format][orientation];
  const fit = computeImageFit({
    pageWidth: page.width,
    pageHeight: page.height,
    margin,
    pngPxWidth,
    pngPxHeight,
  });

  const pdf = new jsPDF({ orientation, unit: 'mm', format });
  pdf.addImage(dataUrl, 'PNG', fit.x, fit.y, fit.width, fit.height);
  return pdf.output('blob');
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function probeImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = () => reject(new Error('Failed to probe PNG dimensions'));
    img.src = dataUrl;
  });
}
