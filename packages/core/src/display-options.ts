export interface DisplayOptionsState {
  hiddenColumns: string[];
  critical: boolean;
  slack: boolean;
  deadline: boolean;
}

export type DisplayOptionsAction =
  | { kind: 'toggleColumn'; id: string }
  | { kind: 'toggleSignal'; signal: 'critical' | 'slack' | 'deadline' };

export const TOGGLEABLE_COLUMN_IDS = [
  'start',
  'end',
  'duration',
  'predecessors',
  'progress',
] as const;

export function initDisplayOptions(defaults?: {
  hiddenColumns?: string[];
  critical?: boolean;
  slack?: boolean;
  deadline?: boolean;
}): DisplayOptionsState {
  return {
    hiddenColumns: defaults?.hiddenColumns ?? [],
    critical: defaults?.critical ?? true,
    slack: defaults?.slack ?? true,
    deadline: defaults?.deadline ?? true,
  };
}

export function displayOptionsReducer(
  state: DisplayOptionsState,
  action: DisplayOptionsAction,
): DisplayOptionsState {
  if (action.kind === 'toggleColumn') {
    const hidden = state.hiddenColumns.includes(action.id)
      ? state.hiddenColumns.filter((id) => id !== action.id)
      : [...state.hiddenColumns, action.id];
    return { ...state, hiddenColumns: hidden };
  }
  return { ...state, [action.signal]: !state[action.signal] };
}

export function visibleColumns<T extends { id: string }>(base: T[], hidden: string[]): T[] {
  return base.filter((c) => !hidden.includes(c.id));
}
