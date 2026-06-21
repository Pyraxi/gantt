import type { Project } from '@pyraxi/cpm-engine';
import { toBlob } from 'html-to-image';
import type { GanttProps } from '../Gantt.js';
import { type OffscreenGanttProps, renderOffscreen } from './offscreen.js';
import type { PngExportOptions } from './types.js';

export async function exportPNG(args: {
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
  options: PngExportOptions;
}): Promise<Blob> {
  const { scheduled, ganttProps, options } = args;

  const pixelRatio =
    options.pixelRatio ??
    (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 2);
  const backgroundColor = options.backgroundColor ?? '#ffffff';

  const offscreen = await renderOffscreen({
    scheduled,
    ganttProps: ganttProps as OffscreenGanttProps,
  });

  try {
    const blob = await toBlob(offscreen.container, {
      backgroundColor,
      pixelRatio,
      cacheBust: true,
    });

    if (!blob) {
      throw new Error('exportPNG: html-to-image returned null');
    }
    return blob;
  } finally {
    await offscreen.dispose();
  }
}
