// Which links the chart draws (parity row 14). SVAR draws every link as a
// polyline whether or not it's on screen, so a 5,000-task schedule paints
// ~5,000 of them; `linkDisplay` lets a host draw only the ones that matter.
// See docs/parity/row14-profile.md.
import type { Link, Task, TaskId } from '@pyraxi/cpm-engine';

export type LinkDisplay = 'all' | 'critical' | 'selected' | 'none';

/**
 * Links to draw for `mode`. `'all'` (the default) returns `links` itself.
 * `'critical'`: both ends critical (`computed.isCritical`). `'selected'`: links
 * into or out of any of `selectedIds` (none when nothing is selected).
 */
export function filterLinksForDisplay(
  links: Link[],
  tasks: Task[],
  mode: LinkDisplay | undefined,
  selectedIds: readonly TaskId[] = [],
): Link[] {
  switch (mode ?? 'all') {
    case 'all':
      return links;
    case 'none':
      return [];
    case 'critical': {
      const critical = new Set(
        tasks.filter((t) => t.computed?.isCritical).map((t) => String(t.id)),
      );
      return links.filter((l) => critical.has(String(l.source)) && critical.has(String(l.target)));
    }
    case 'selected': {
      if (selectedIds.length === 0) return [];
      const sel = new Set(selectedIds.map(String));
      return links.filter((l) => sel.has(String(l.source)) || sel.has(String(l.target)));
    }
  }
}
