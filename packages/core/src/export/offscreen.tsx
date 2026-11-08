// Mounts a second <Gantt> instance in a detached, off-screen container so
// the export pipeline can snapshot the full project regardless of the
// on-screen viewport's scroll position. Positioned far off-screen rather
// than display:none because hidden containers don't compute layout, which
// breaks DOM-to-image's bounding-rect reads.

import type { Project } from '@pyraxi/cpm-engine';
import { createRoot, type Root } from 'react-dom/client';
import { Gantt, type GanttProps, resolveEffectiveBaselineIndices } from '../Gantt.js';

/**
 * GanttProps an export never forwards: the data (passed as `scheduled`), the
 * height (measured here), and interaction / editing / chrome. Everything else
 * is the view, and is exported — so a new view prop reaches exports by
 * default instead of silently going missing (2026-07-08 review).
 */
type NotExported =
  | 'project'
  | 'height'
  | 'preScheduled'
  | 'preset'
  | 'editMode'
  | 'onTaskEdit'
  | 'onTasksEdit'
  | 'gridClipboard'
  | 'dateOrder'
  | 'onLinkCreate'
  | 'onLinkDelete'
  | 'onTaskAdd'
  | 'onTaskDelete'
  | 'onTaskReorder'
  | 'onTaskIndent'
  | 'onStructuralCommit'
  | 'onTaskSelect'
  | 'onTaskEditRequest'
  | 'onCellEdit'
  | 'tooltip'
  | 'editor'
  | 'contextMenu'
  | 'toolbar'
  | 'footer'
  | 'displayOptions'
  | 'onViewStateChange'
  | 'onTaskBadgeClick'
  // Not in exports yet: the capture measures rows, and these panels sit below them.
  | 'chartPanels';

/** The view props the off-screen export render takes (see {@link NotExported}). */
export type OffscreenGanttProps = Omit<GanttProps, NotExported>;

/** Layout of the off-screen render, in CSS px from the container's top-left. */
export interface OffscreenMetrics {
  /** Container width (the captured image's CSS width). */
  width: number;
  /** Container height (the captured image's CSS height). */
  height: number;
  /** Bottom of the column header / timescale band = top of the first row. */
  headerPx: number;
  /** Height of one grid row. */
  rowPx: number;
  /** Number of grid rows rendered. */
  rowCount: number;
  /** Bottom of the last grid row (= `height` when the capture holds every row). */
  lastRowBottom: number;
}

export interface OffscreenHandle {
  /** The host DOM element. The rendered Gantt is mounted inside this. */
  container: HTMLDivElement;
  /** Header and row geometry, for paginating the capture (parity row 13). */
  measure: () => OffscreenMetrics;
  /** Unmount + remove the container from the DOM. */
  dispose: () => Promise<void>;
}

export async function renderOffscreen(args: {
  scheduled: Project;
  ganttProps: OffscreenGanttProps;
  /** `--cg-*` theme tokens resolved on screen (this container is on <body>). */
  themeVars?: Record<string, string>;
  /** The capture's background (`PngExportOptions.backgroundColor`); default white. */
  backgroundColor?: string;
}): Promise<OffscreenHandle> {
  const { scheduled, ganttProps } = args;

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.width = 'max-content';
  container.style.background = args.backgroundColor ?? '#ffffff';
  for (const [token, value] of Object.entries(args.themeVars ?? {})) {
    container.style.setProperty(token, value);
  }
  document.body.appendChild(container);

  const root: Root = createRoot(container);
  const renderAt = (height: number) =>
    root.render(
      <Gantt {...ganttProps} project={scheduled} preScheduled toolbar={false} height={height} />,
    );
  // Hide SVAR's scrollbars: its chart area is a few px wider than the
  // viewport even when everything fits, and Chrome rasterises a classic
  // scrollbar into the DOM-to-image clone. In <head>, scoped to this
  // container (React clears the container itself on mount).
  const scope = `cg-export-${++exportSeq}`;
  container.classList.add(scope);
  const style = document.createElement('style');
  style.textContent = [
    '.wx-gantt',
    '.wx-layout',
    '.wx-chart',
    '.wx-area',
    '.wx-table-container',
    '.wx-bars',
  ]
    .map((sel) => `.${scope} ${sel}{overflow:hidden!important;scrollbar-width:none!important}`)
    .join('');
  document.head.appendChild(style);

  // Pass 1: an upper bound (every task plus baseline phantom rows), so SVAR
  // renders every row unvirtualised. Pass 2: shrink to exactly header +
  // rows, so filtered / collapsed exports carry no white tail. Each pass waits
  // until SVAR has actually applied the height — its resize path (React
  // commit → ResizeObserver → store) can lag the render by seconds, and a
  // clone taken before then silently loses rows.
  const dispose = async () => {
    root.unmount();
    style.remove();
    container.remove();
  };
  try {
    const cellHeight = ganttProps.cellHeight ?? 42;
    // One phantom row per leaf per shown baseline (singular `baselineIndex`
    // included — the same resolution the Gantt itself uses).
    const phantomPerTask =
      resolveEffectiveBaselineIndices(ganttProps.baselineIndices, ganttProps.baselineIndex).length +
      1;
    let height = HEADER_ALLOWANCE + scheduled.tasks.length * phantomPerTask * cellHeight;
    renderAt(height);
    await settle(container, false);
    // Self-correcting: if the estimate was short, SVAR's chart scrolls —
    // grow by the overflow and settle again, rather than depending on
    // predicting SVAR's row count.
    for (let i = 0; i < MAX_GROW_PASSES; i++) {
      const chart = container.querySelector<HTMLElement>('.wx-chart');
      const overflow = chart ? chart.scrollHeight - chart.clientHeight - CHART_SCROLL_SLACK : 0;
      if (overflow <= 0) break;
      height += overflow;
      renderAt(height);
      await settle(container, false);
    }
    const first = measureLayout(container);
    const exact = Math.ceil(first.headerPx + first.rowCount * first.rowPx) + 1;
    renderAt(exact);
    await settle(container, true);
    await waitForFonts();
    inlineSvgPaint(container);
  } catch (err) {
    await dispose();
    throw err;
  }

  return {
    container,
    measure: () => measureLayout(container),
    dispose,
  };
}

/**
 * Copy computed SVG paint onto attributes. The DOM-to-image clone loses
 * stylesheet-only paint on SVG shapes (SVAR's links are `fill: transparent`
 * via CSS), so they rasterise with the SVG default black fill.
 */
function inlineSvgPaint(root: HTMLElement): void {
  for (const el of root.querySelectorAll<SVGElement>('svg *')) {
    const cs = getComputedStyle(el);
    el.setAttribute('fill', cs.fill);
    el.setAttribute('stroke', cs.stroke);
    el.setAttribute('stroke-width', cs.strokeWidth);
  }
}

let exportSeq = 0;

/** Generous allowance for SVAR's header + timescale band (73 px by default). */
const HEADER_ALLOWANCE = 160;
const SETTLE_TIMEOUT_MS = 15_000;
const STABLE_FRAMES = 3;

/** Next frame, or 50 ms if rAF is suspended (background tab) so the timeout still fires. */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
    setTimeout(resolve, 50);
  });
const MAX_GROW_PASSES = 3;
/** SVAR's chart body is `min-height: 100%` under its scale, so scrollHeight always exceeds clientHeight by about the header. */
const CHART_SCROLL_SLACK = 80;

/**
 * Wait until SVAR's layout has caught up with the requested height (its chart
 * viewport fills the container) and, with `requireCovers`, the chart and grid
 * viewports reach the last row — holding still for a few frames. Throws on
 * timeout rather than capturing a partial programme.
 */
async function settle(container: HTMLElement, requireCovers: boolean): Promise<void> {
  const t0 = performance.now();
  let prev = '';
  let stable = 0;
  while (performance.now() - t0 < SETTLE_TIMEOUT_MS) {
    await nextFrame();
    const rows = container.querySelectorAll('.wx-body .wx-row');
    const last = rows[rows.length - 1]?.getBoundingClientRect().bottom ?? 0;
    const chart = container.querySelector('.wx-chart')?.getBoundingClientRect();
    const grid = container.querySelector('.wx-table-container')?.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    // SVAR has applied the requested height once its chart viewport reaches
    // the container's bottom (a stale `.wx-stuck` height stops short of it).
    const applied = !!chart && chart.bottom >= box.bottom - 2;
    const covers = !!chart && chart.bottom >= last - 0.5 && (!grid || grid.bottom >= last - 0.5);
    const sig = `${rows.length}|${chart?.height}|${grid?.height}|${box.height}`;
    stable = applied && (covers || !requireCovers) && sig === prev ? stable + 1 : 0;
    prev = sig;
    if (stable >= STABLE_FRAMES) return;
  }
  throw new Error('export: the Gantt did not finish laying out in time; nothing was captured');
}

async function waitForFonts(): Promise<void> {
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) await fonts.ready;
}

function measureLayout(container: HTMLElement): OffscreenMetrics {
  const top = container.getBoundingClientRect().top;
  const rows = [...container.querySelectorAll<HTMLElement>('.wx-body .wx-row')];
  const first = rows[0]?.getBoundingClientRect();
  // No rows: the header band is the grid header / timescale, whichever is taller.
  const headerBottom = Math.max(
    0,
    ...[...container.querySelectorAll('.wx-header, .wx-scale')].map(
      (e) => e.getBoundingClientRect().bottom - top,
    ),
  );
  const last = rows[rows.length - 1]?.getBoundingClientRect();
  return {
    width: container.getBoundingClientRect().width,
    height: container.getBoundingClientRect().height,
    lastRowBottom: last ? last.bottom - top : headerBottom,
    headerPx: first ? first.top - top : headerBottom,
    rowPx: first?.height || 42,
    rowCount: rows.length,
  };
}
