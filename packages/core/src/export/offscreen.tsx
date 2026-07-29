// Mounts a second <Gantt> instance in a detached, off-screen container so
// the export pipeline can snapshot the full project regardless of the
// on-screen viewport's scroll position. Positioned far off-screen rather
// than display:none because hidden containers don't compute layout, which
// breaks DOM-to-image's bounding-rect reads.

import type { Project } from '@pyraxi/cpm-engine';
import { createRoot, type Root } from 'react-dom/client';
import { Gantt, type GanttProps } from '../Gantt.js';

export type OffscreenGanttProps = Pick<
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

export interface OffscreenHandle {
  /** The host DOM element. The rendered Gantt is mounted inside this. */
  container: HTMLDivElement;
  /** Unmount + remove the container from the DOM. */
  dispose: () => Promise<void>;
}

export async function renderOffscreen(args: {
  scheduled: Project;
  ganttProps: OffscreenGanttProps;
}): Promise<OffscreenHandle> {
  const { scheduled, ganttProps } = args;

  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-99999px';
  container.style.top = '0';
  container.style.width = 'max-content';
  container.style.background = '#ffffff';
  document.body.appendChild(container);

  const root: Root = createRoot(container);
  root.render(
    <Gantt
      project={scheduled}
      preScheduled
      cellWidth={ganttProps.cellWidth}
      cellHeight={ganttProps.cellHeight}
      markers={ganttProps.markers}
      baselineIndex={ganttProps.baselineIndex}
      baselineIndices={ganttProps.baselineIndices}
      showBaselineBars={ganttProps.showBaselineBars}
      columns={ganttProps.columns}
      visibleTaskIds={ganttProps.visibleTaskIds}
      height={computeFullHeight(scheduled, ganttProps.cellHeight ?? 42)}
    />,
  );

  // Two animation frames + font load to give SVAR time to lay out and
  // any custom fonts time to be ready before snapshot.
  await waitForRender();

  return {
    container,
    async dispose() {
      root.unmount();
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    },
  };
}

function computeFullHeight(project: Project, cellHeight: number): number {
  // Header band + one row per task. Heuristic; the off-screen container's
  // width:max-content + the height being a lower bound mean an underestimate
  // is harmless — content expands rather than clipping.
  return 80 + project.tasks.length * cellHeight;
}

async function waitForRender(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const fonts = (document as { fonts?: { ready?: Promise<unknown> } }).fonts;
  if (fonts?.ready) {
    await fonts.ready;
  }
}
