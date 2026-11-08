// Vertical markers (the today line, milestone dates). SVAR's free store forces
// its own `markers` off (`init()` sets `markers = []`), so the `markers` prop
// never drew anything; they're drawn here as an overlay in SVAR's chart area,
// on its cell grid (see svar-overlay).
import type { IApi } from '@svar-ui/react-gantt';
import { createPortal } from 'react-dom';
import { cellX, useSvarOverlay } from './svar-overlay.js';

export interface ResolvedMarker {
  start: Date;
  text?: string;
  /** Class carrying the colour (`construction-gantt-marker-today` / `-milestone` / the consumer's). */
  css?: string;
}

export function MarkersLayer({
  api,
  root,
  markers,
}: {
  api: IApi | null;
  root: { readonly current: HTMLElement | null };
  markers: readonly ResolvedMarker[];
}) {
  const overlay = useSvarOverlay(api, root);
  if (!overlay || markers.length === 0) return null;
  const width = overlay.state._scales.width;
  return createPortal(
    <div className="construction-gantt-markers" aria-hidden="true">
      {markers.map((m, i) => {
        const x = cellX(overlay.state, m.start, 'start');
        if (x < 0 || (width !== undefined && x > width)) return null;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: markers have no id; order is the consumer's
            key={i}
            className={`construction-gantt-marker${m.css ? ` ${m.css}` : ''}`}
            style={{ left: x }}
          >
            {m.text && <span className="construction-gantt-marker-label">{m.text}</span>}
          </div>
        );
      })}
    </div>,
    overlay.area,
  );
}
