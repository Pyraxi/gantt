// Presentational control bar for the opt-in `displayOptions` prop
// (configurable-chrome Task 6). Renders column-visibility + engine-signal
// checkboxes. Carries no state of its own — driven entirely by the `state`
// prop and the two toggle callbacks, so <Gantt> owns the reducer and this
// component stays trivially testable / swappable.

import type { FC } from 'react';
import type { DisplayOptionsState } from './display-options.js';

export interface DisplayOptionsBarProps {
  state: DisplayOptionsState;
  /** Toggleable columns present in the base set, in display order. */
  columnOptions: { id: string; label: string }[];
  showColumns: boolean;
  showSignals: boolean;
  onToggleColumn: (id: string) => void;
  onToggleSignal: (signal: 'critical' | 'slack' | 'deadline') => void;
}

export const DisplayOptionsBar: FC<DisplayOptionsBarProps> = ({
  state,
  columnOptions,
  showColumns,
  showSignals,
  onToggleColumn,
  onToggleSignal,
}) => {
  const box = (checked: boolean, label: string, on: () => void) => (
    <label
      key={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        fontSize: 12,
        marginRight: 12,
      }}
    >
      <input type="checkbox" checked={checked} onChange={on} />
      {label}
    </label>
  );
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: 4,
        padding: '6px 12px',
        borderBottom: '1px solid var(--wx-border, #e2e8f0)',
        fontSize: 12,
        flexShrink: 0,
      }}
    >
      {showColumns &&
        columnOptions.map((c) =>
          box(!state.hiddenColumns.includes(c.id), c.label, () => onToggleColumn(c.id)),
        )}
      {showColumns && showSignals && <span style={{ opacity: 0.4, marginRight: 12 }}>|</span>}
      {showSignals && box(state.critical, 'Critical', () => onToggleSignal('critical'))}
      {showSignals && box(state.slack, 'Float/Slack', () => onToggleSignal('slack'))}
      {showSignals && box(state.deadline, 'Deadline', () => onToggleSignal('deadline'))}
    </div>
  );
};
