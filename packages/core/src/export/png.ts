import type { Project } from '@pyraxi/cpm-engine';
import { toBlob, toSvg } from 'html-to-image';
import { type OffscreenGanttProps, type OffscreenMetrics, renderOffscreen } from './offscreen.js';
import type { PngExportOptions } from './types.js';

type CaptureArgs = Parameters<typeof exportPNG>[0];

export async function exportPNG(args: {
  scheduled: Project;
  ganttProps: OffscreenGanttProps;
  /** `--cg-*` theme tokens resolved on screen. */
  themeVars?: Record<string, string>;
  options: PngExportOptions;
}): Promise<Blob> {
  return (await capturePNG(args)).blob;
}

// The clone inherits the off-screen container's inline `left: -99999px`,
// which drew it outside the SVG viewport: every capture came out blank.
const CLONE_IN_VIEW = { position: 'static', left: '0', top: '0' };

/** exportPNG plus the off-screen layout, for paginated PDF. @internal */
export async function capturePNG(
  args: CaptureArgs,
): Promise<{ blob: Blob; metrics: OffscreenMetrics }> {
  const { scheduled, ganttProps, themeVars, options } = args;
  assertTaskCount(scheduled);

  const pixelRatio =
    options.pixelRatio ??
    (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 2);
  const backgroundColor = options.backgroundColor ?? '#ffffff';

  const offscreen = await renderOffscreen({
    scheduled,
    ganttProps,
    themeVars,
    backgroundColor,
  });

  try {
    // Measure before cloning, and refuse a capture that wouldn't hold every row.
    const metrics = assertComplete(offscreen.measure());
    const blob = await toBlob(offscreen.container, {
      backgroundColor,
      pixelRatio,
      cacheBust: true,
      style: CLONE_IN_VIEW,
    });

    if (!blob) {
      throw new Error('exportPNG: html-to-image returned null');
    }
    return { blob, metrics };
  } finally {
    await offscreen.dispose();
  }
}

/**
 * Rows one export will clone. The DOM-to-image clone grows superlinearly
 * (665 rows ≈ 30 s on a 2 GHz Xeon; 5,000 never finished), so past this we
 * fail fast with a remedy instead of freezing the page.
 */
export const MAX_EXPORT_ROWS = 2500;

/** @internal Throws when the off-screen layout clips rows (never ship a partial programme) or is too big to clone. */
export function assertComplete(metrics: OffscreenMetrics): OffscreenMetrics {
  if (metrics.rowCount > MAX_EXPORT_ROWS) throw tooManyRows(metrics.rowCount);
  if (metrics.lastRowBottom > metrics.height + 0.5) {
    throw new Error(
      `export: the capture would clip rows (last row ends at ${Math.round(metrics.lastRowBottom)} px, image is ${Math.round(metrics.height)} px)`,
    );
  }
  return metrics;
}

/**
 * The off-screen Gantt as one SVG data URL (CSS-px sized) plus its layout,
 * for per-page rasterising in paginated PDF. @internal
 */
export async function captureSVG(args: {
  scheduled: Project;
  ganttProps: CaptureArgs['ganttProps'];
  themeVars?: Record<string, string>;
  backgroundColor: string;
}): Promise<{ svgUrl: string; metrics: OffscreenMetrics }> {
  assertTaskCount(args.scheduled);
  const offscreen = await renderOffscreen({
    scheduled: args.scheduled,
    ganttProps: args.ganttProps,
    themeVars: args.themeVars,
    backgroundColor: args.backgroundColor,
  });
  try {
    const metrics = assertComplete(offscreen.measure());
    const svgUrl = await toSvg(offscreen.container, {
      backgroundColor: args.backgroundColor,
      cacheBust: true,
      style: CLONE_IN_VIEW,
    });
    return { svgUrl, metrics };
  } finally {
    await offscreen.dispose();
  }
}

function tooManyRows(rows: number): RangeError {
  return new RangeError(
    `export: ${rows} rows (including baseline rows) is more than one export can capture (max ${MAX_EXPORT_ROWS}); pass visibleTaskIds to export a section, or show fewer baselines`,
  );
}

/** Cheap pre-check before mounting anything: tasks alone already exceed the limit. */
function assertTaskCount(scheduled: Project): void {
  if (scheduled.tasks.length > MAX_EXPORT_ROWS) throw tooManyRows(scheduled.tasks.length);
}
