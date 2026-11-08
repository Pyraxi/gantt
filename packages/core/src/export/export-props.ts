// What the PNG / PDF export renders: the screen's view, not the raw props.
// The off-screen <Gantt> can't select, zoom or toggle, so the on-screen
// instance hands it the *effective* state (2026-07-08 review, "stale prop
// subset"; parity row 6 follow-up).
import type { GanttZoomLevel, Project, TaskId } from '@pyraxi/cpm-engine';
import type { GanttColumn } from '../Gantt.js';
import { filterLinksForDisplay } from '../link-display.js';
import type { OffscreenGanttProps } from './offscreen.js';

/**
 * Every `--cg-*` theme token the chart reads. The off-screen render is
 * appended to `<body>`, outside any host wrapper that sets them, so the
 * export copies their computed values onto its container.
 * `export-props.test.ts` fails if a token used in `src` is missing here.
 */
export const CG_THEME_TOKENS: readonly string[] = [
  '--cg-progress-line-color',
  '--cg-highlight-color',
  '--cg-path-driving-color',
  '--cg-path-driven-color',
  '--cg-previous-start-color',
  '--cg-previous-start-pending-color',
  ...['neutral', 'info', 'success', 'warning', 'danger'].flatMap((tone) => [
    `--cg-badge-${tone}-bg`,
    `--cg-badge-${tone}-fg`,
  ]),
  ...['ahead', 'deadline', 'deadline-missed', 'float', 'late', 'slip'].flatMap((kind) => [
    `--cg-pill-${kind}-bg`,
    `--cg-pill-${kind}-color`,
  ]),
];

/** The computed value of each theme token set on (or inherited by) `el`. */
export function readThemeTokens(el: Element | null): Record<string, string> {
  if (!el || typeof getComputedStyle !== 'function') return {};
  const style = getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const token of CG_THEME_TOKENS) {
    const v = style.getPropertyValue(token).trim();
    if (v !== '') out[token] = v;
  }
  return out;
}

/**
 * The export's project and props from the on-screen state:
 * - `columns` / `showCritical` / `showSlack` / `showDeadline`: the effective
 *   values (after `displayOptions` toggles and hidden columns);
 * - `zoom`: the current level becomes `zoom.default`;
 * - `taskPath`: the selection becomes `taskPathFor`;
 * - `linkDisplay="selected"`: the links are pre-filtered to the selection and
 *   drawn as `'all'` (the off-screen instance has no selection). With a
 *   `taskPath`, every link is kept (the path needs them) and drawn.
 */
export function exportViewProps(args: {
  scheduled: Project;
  props: OffscreenGanttProps;
  columns: GanttColumn[] | undefined;
  critical: boolean | undefined;
  slack: boolean | undefined;
  deadline: boolean | undefined;
  /** `displayOptions` toggles: false drops `taskBadges` / `previousStart` from the export. */
  badges?: boolean;
  previousStarts?: boolean;
  zoomLevel: GanttZoomLevel | undefined;
  selectedIds: readonly TaskId[];
}): { scheduled: Project; ganttProps: OffscreenGanttProps } {
  const { props, selectedIds } = args;
  let scheduled = args.scheduled;
  const ganttProps: OffscreenGanttProps = {
    ...props,
    columns: args.columns,
    showCritical: args.critical,
    showSlack: args.slack,
    showDeadline: args.deadline,
  };
  if (args.badges === false) delete ganttProps.taskBadges;
  if (args.previousStarts === false) delete ganttProps.previousStart;
  if (props.zoom && args.zoomLevel) ganttProps.zoom = { ...props.zoom, default: args.zoomLevel };
  if (props.taskPath && props.taskPathFor === undefined) {
    ganttProps.taskPathFor = selectedIds[selectedIds.length - 1];
  }
  if (props.linkDisplay === 'selected' && props.taskPath) {
    // The path needs every link (pre-filtering would cut it to one hop), and
    // the off-screen instance has no selection: keep and draw all links; the
    // path's links are still painted.
    ganttProps.linkDisplay = 'all';
  } else if (props.linkDisplay === 'selected') {
    scheduled = {
      ...scheduled,
      links: filterLinksForDisplay(scheduled.links, scheduled.tasks, 'selected', selectedIds),
    };
    ganttProps.linkDisplay = 'all';
  }
  return { scheduled, ganttProps };
}
