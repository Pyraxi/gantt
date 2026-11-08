// Task highlights (parity row 11, core): ring bars and tint grid rows for host-
// supplied task sets — e.g. checkSchedule()'s offending ids. The report itself
// is the host's (ADR-003); the chart highlight is ours. A scoped stylesheet keyed
// on SVAR's own ids (no per-task class hook in SVAR), like the Task Path.
// Spec: docs/superpowers/specs/2026-10-16-task-highlights-design.md
import type { TaskId } from '@pyraxi/cpm-engine';
import { svarDataId } from './svar-adapter.js';

export interface TaskHighlight {
  taskIds: readonly TaskId[];
  /** CSS colour. Default `var(--cg-highlight-color, #f59e0b)` (amber). */
  color?: string;
}

/** One rule per set, in order (later sets win); null when there's nothing to highlight. */
export function buildHighlightCss(
  highlights: readonly TaskHighlight[] | undefined,
  scope: string,
): string | null {
  const rules: string[] = [];
  for (const h of highlights ?? []) {
    if (h.taskIds.length === 0) continue;
    const colour = h.color ?? 'var(--cg-highlight-color,#f59e0b)';
    const ids = h.taskIds.map(svarDataId);
    const bars = ids.map((id) => `.${scope} .wx-bar.wx-bar[data-id="${id}"]`).join(',');
    const rows = ids.map((id) => `.${scope} .wx-row[data-id="${id}"]`).join(',');
    rules.push(
      `${bars}{box-shadow:0 0 0 2px ${colour};}` +
        `${rows}{background:color-mix(in srgb,${colour} 16%,transparent);}`,
    );
  }
  return rules.length > 0 ? rules.join('\n') : null;
}
