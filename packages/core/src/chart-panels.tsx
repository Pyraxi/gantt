// Chart panels: host-drawn strips under the chart, on SVAR's own timescale
// (ADR-012: a generic extension point; the resource histogram is one, in
// `@pyraxi/gantt-pro`). Each panel gets the scheduled project, the timeline's
// width and an `xOf(date)` that matches SVAR's bars at every zoom; the strip
// lines up under the chart (the grid's width is its label gutter) and scrolls
// with it.
import type { Project } from '@pyraxi/cpm-engine';
import type { IApi } from '@svar-ui/react-gantt';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { cellX, useSvarOverlay } from './svar-overlay.js';

/** What a {@link ChartPanel}'s `render` draws from. */
export interface ChartPanelContext {
  /** The scheduled project the chart shows. */
  project: Project;
  /** Width of the whole timeline in px (wider than the visible chart). */
  width: number;
  /** The panel's height in px. */
  height: number;
  /**
   * x of a moment on the timeline, in px from its left edge, on SVAR's cell
   * grid. `'start'` (default): the start of the moment's cell, where SVAR
   * draws a bar starting then. `'nearest'`: the nearer cell edge.
   */
  xOf: (date: Date, snap?: 'start' | 'nearest') => number;
}

/** A strip drawn under the chart, on its timescale. */
export interface ChartPanel {
  /** Stable key. */
  id: string;
  /**
   * Shown in the gutter under the grid (or over the panel when there's no
   * room). A function gets the scheduled project (e.g. to show a resource's name).
   */
  label?: string | ((project: Project) => string);
  /** Height in px. Default 96. */
  height?: number;
  /**
   * Draws the panel's content: typically an `<svg width={ctx.width}>`. Its
   * x = 0 is the timeline's start; the host scrolls it with the chart. Called
   * on SVAR re-layouts (zoom, edits), not on scroll.
   */
  render: (ctx: ChartPanelContext) => ReactNode;
}

const GUTTER_LABEL_MIN = 48;

/** Lays out every panel under the chart; shares one scroll / measure hook-up. */
export function ChartPanelsLayer({
  api,
  root,
  project,
  panels,
}: {
  api: IApi | null;
  root: { readonly current: HTMLElement | null };
  project: Project;
  panels: ChartPanel[];
}) {
  const overlay = useSvarOverlay(api, root);
  const [gutter, setGutter] = useState(0);
  const [viewWidth, setViewWidth] = useState<number | undefined>(undefined);
  // Scroll moves the content directly: no React render per scroll event.
  const scrollRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-attach once SVAR has mounted its chart (overlay.area appears)
  useEffect(() => {
    const host = root.current;
    const chart = host?.querySelector<HTMLElement>('.wx-chart');
    if (!host || !chart) return;
    const measure = () => {
      const c = chart.getBoundingClientRect();
      setGutter(Math.max(0, c.left - host.getBoundingClientRect().left));
      // The chart's own width: a vertical scrollbar sits outside it.
      setViewWidth(chart.clientWidth || undefined);
    };
    const onScroll = () => {
      scrollRef.current = chart.scrollLeft;
      for (const el of host.querySelectorAll<HTMLElement>(
        '.construction-gantt-chart-panel-content',
      ))
        el.style.transform = `translateX(${-chart.scrollLeft}px)`;
    };
    measure();
    onScroll();
    chart.addEventListener('scroll', onScroll, { passive: true });
    // The chart too: a grid-splitter drag moves it without resizing the host.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(host);
    ro?.observe(chart);
    return () => {
      chart.removeEventListener('scroll', onScroll);
      ro?.disconnect();
    };
  }, [root, overlay?.area]);

  const state = overlay?.state;
  const width = state?._scales.width ?? 0;
  const xOf = (d: Date, snap: 'start' | 'nearest' = 'start') => (state ? cellX(state, d, snap) : 0);

  return (
    <>
      {panels.map((panel) => {
        const height = panel.height ?? 96;
        const label =
          (typeof panel.label === 'function' ? panel.label(project) : panel.label) ?? '';
        return (
          <div
            key={panel.id}
            className="construction-gantt-chart-panel"
            data-panel-id={panel.id}
            style={{
              display: 'flex',
              height,
              flexShrink: 0,
              borderTop: '1px solid var(--wx-gantt-border-color, #e5e7eb)',
            }}
          >
            <div
              style={{
                width: gutter,
                flexShrink: 0,
                padding: '4px 8px',
                boxSizing: 'border-box',
                fontSize: 12,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={label || undefined}
            >
              {gutter >= GUTTER_LABEL_MIN ? label : null}
            </div>
            <div
              style={{
                ...(viewWidth !== undefined ? { width: viewWidth, flex: 'none' } : { flex: 1 }),
                minWidth: 0,
                overflow: 'hidden',
                position: 'relative',
              }}
            >
              {gutter < GUTTER_LABEL_MIN && label && (
                // No room beside the chart (grid hidden or narrow): label over it.
                <div
                  style={{
                    position: 'absolute',
                    left: 4,
                    top: 2,
                    fontSize: 12,
                    zIndex: 1,
                    pointerEvents: 'none',
                  }}
                >
                  {label}
                </div>
              )}
              {state && (
                <div
                  className="construction-gantt-chart-panel-content"
                  style={{
                    width,
                    height,
                    transform: `translateX(${-scrollRef.current}px)`,
                  }}
                >
                  {panel.render({ project, width, height, xOf })}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}
