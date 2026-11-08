// Task Path highlight (parity row 5, core): MS Project's Task Path — the
// selected task's driving predecessors and the successors it drives. Rendered
// as a scoped stylesheet keyed on SVAR's own `data-id` (bars) and
// `data-link-id` (link polylines), so selecting a task never re-maps rows.
// Spec: docs/superpowers/specs/2026-10-16-task-path-highlight-design.md
import type { DrivingAnalysis, TaskId, TaskPath } from '@pyraxi/cpm-engine';
import { decodeSvarId } from './grid-keyboard.js';
import { svarDataId as attr } from './svar-adapter.js';

export type TaskPathMode = 'driving' | 'driven' | 'both';

const COLOUR = {
  driving: 'var(--cg-path-driving-color,#ea580c)',
  driven: 'var(--cg-path-driven-color,#7c3aed)',
} as const;

function barRules(path: TaskPath, focusId: TaskId, role: PathRole, scope: string): string | null {
  const ids = path.taskIds.filter((id) => String(id) !== String(focusId)).map(attr);
  if (ids.length === 0) return null;
  // `.wx-bar.wx-bar` outranks SVAR's hover / selected bar styling, so the ring
  // stays. A milestone's visible diamond is its rotated inner `.wx-content`.
  const bars = ids.map((id) => `.${scope} .wx-bar.wx-bar:not(.wx-milestone)[data-id="${id}"]`);
  const diamonds = ids.map((id) => `.${scope} .wx-milestone[data-id="${id}"] .wx-content`);
  return `${[...bars, ...diamonds].join(',')}{box-shadow:0 0 0 2px ${COLOUR[role]};}`;
}

export type PathRole = keyof typeof COLOUR;

export interface TaskPathView {
  /** Scoped CSS ringing the path's bars (bars are virtualised: few elements). */
  css: string | null;
  /** Path links by `String(link id)` → role; painted inline by {@link paintPathLinks}. */
  linkRoles: Map<string, PathRole>;
}

/**
 * `focusId`'s Task Path within `.scope`, or null when there's nothing to show
 * (no focus, an isolated task, a summary / unknown id).
 *
 * Links are NOT styled by CSS: SVAR renders every link polyline (~5k on a
 * 5k-task schedule), and thousands of `[data-link-id]` selectors make each
 * style recalc O(path links × polylines) — 250 ms a click on a long path.
 */
export function buildTaskPath(
  analysis: DrivingAnalysis,
  focusId: TaskId | undefined,
  mode: TaskPathMode,
  scope: string,
): TaskPathView | null {
  if (focusId === undefined) return null;
  const rules: string[] = [];
  const linkRoles = new Map<string, PathRole>();
  const add = (path: TaskPath, role: PathRole) => {
    const rule = barRules(path, focusId, role, scope);
    if (rule) rules.push(rule);
    for (const id of path.linkIds) linkRoles.set(String(id), role);
  };
  if (mode !== 'driven') add(analysis.drivingPath(focusId), 'driving');
  if (mode !== 'driving') add(analysis.drivenPath(focusId), 'driven');
  if (rules.length === 0 && linkRoles.size === 0) return null;
  return { css: rules.length > 0 ? rules.join('\n') : null, linkRoles };
}

const PAINTED = 'cgPath';

/**
 * Stroke the path's link polylines inline (one O(polylines) pass), clearing
 * any painted earlier that are no longer on it. SVAR never sets a polyline's
 * `style`, so this survives its re-renders of the same element; re-run it when
 * SVAR adds polylines. The delete-selected link is a separate SVAR polyline
 * drawn on top, so its danger colour still shows.
 */
export function paintPathLinks(root: ParentNode, roles: Map<string, PathRole> | undefined): void {
  for (const line of root.querySelectorAll<SVGElement>('.wx-links .wx-line[data-link-id]')) {
    const id = decodeSvarId(line.getAttribute('data-link-id') ?? '');
    const role = roles?.get(String(id));
    if (role) {
      if (line.dataset[PAINTED] === role) continue;
      line.style.setProperty('stroke', COLOUR[role]);
      line.style.setProperty('stroke-width', '2.5px');
      line.dataset[PAINTED] = role;
    } else if (line.dataset[PAINTED]) {
      line.style.removeProperty('stroke');
      line.style.removeProperty('stroke-width');
      delete line.dataset[PAINTED];
    }
  }
}
