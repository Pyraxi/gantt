import type { CSSProperties, HTMLAttributes, MouseEvent } from 'react';

// minHeight: an empty value (blank custom field / text) still needs a click
// target, or its click-to-edit cell can never be opened.
const clipStyle: CSSProperties = {
  display: 'block',
  width: '100%',
  minHeight: '1em',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

// Full-width block (whole-cell click target) that leaves its content's own
// layout alone — for consumer `render` output, which may be padded pills that
// size/truncate themselves.
const noClipStyle: CSSProperties = { display: 'block', width: '100%', minHeight: '1em' };

function titleIfClipped(e: MouseEvent<HTMLSpanElement>) {
  const el = e.currentTarget;
  if (el.scrollWidth > el.clientWidth + 1) el.title = el.textContent ?? '';
  else el.removeAttribute('title');
}

/**
 * Grid-cell content wrapper. By default: single-line ellipsis, plus a hover
 * `title` with the full text — set only when the content is actually clipped.
 * SVAR's own cell ellipsis only reaches inline content; a block child (our
 * editable cells) would otherwise hard-clip mid-word (CM findings 2026-07-13/14).
 *
 * `clip={false}` keeps only the full-width block — use it around consumer
 * `render` output, which must never be clipped or reflowed by us.
 *
 * Column `align` is restored by `.construction-gantt-cell-text` rules in
 * Gantt.css — SVAR aligns body cells via flex justify, which a full-width
 * block child would otherwise defeat.
 */
export function CellText({
  clip = true,
  style,
  className,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { clip?: boolean }) {
  // Click-to-edit cells pass onClick through: keyboard editing is handled by
  // the input that renders on activate; the gridcell role lives on SVAR's parent.
  return (
    <span
      {...rest}
      className={
        className ? `construction-gantt-cell-text ${className}` : 'construction-gantt-cell-text'
      }
      style={{ ...(clip ? clipStyle : noClipStyle), ...style }}
      {...(clip ? { onMouseEnter: titleIfClipped } : {})}
    />
  );
}
