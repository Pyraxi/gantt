import { describe, expect, test } from 'vitest';
import {
  displayOptionsReducer,
  initDisplayOptions,
  TOGGLEABLE_COLUMN_IDS,
  visibleColumns,
} from './display-options.js';

describe('displayOptions state', () => {
  test('init defaults: nothing hidden, all signals on', () => {
    expect(initDisplayOptions()).toEqual({
      hiddenColumns: [],
      critical: true,
      slack: true,
      deadline: true,
    });
  });
  test('init honors provided defaults', () => {
    expect(initDisplayOptions({ hiddenColumns: ['duration'], slack: false })).toEqual({
      hiddenColumns: ['duration'],
      critical: true,
      slack: false,
      deadline: true,
    });
  });
  test('toggleColumn adds then removes an id', () => {
    let s = initDisplayOptions();
    s = displayOptionsReducer(s, { kind: 'toggleColumn', id: 'start' });
    expect(s.hiddenColumns).toEqual(['start']);
    s = displayOptionsReducer(s, { kind: 'toggleColumn', id: 'start' });
    expect(s.hiddenColumns).toEqual([]);
  });
  test('toggleSignal flips the flag', () => {
    const s = displayOptionsReducer(initDisplayOptions(), {
      kind: 'toggleSignal',
      signal: 'critical',
    });
    expect(s.critical).toBe(false);
  });
  test('visibleColumns drops hidden by id, preserves order', () => {
    const base = [{ id: 'text' }, { id: 'start' }, { id: 'duration' }];
    expect(visibleColumns(base, ['start']).map((c) => c.id)).toEqual(['text', 'duration']);
  });
  test('TOGGLEABLE_COLUMN_IDS is the recognized display set', () => {
    expect([...TOGGLEABLE_COLUMN_IDS]).toEqual([
      'start',
      'end',
      'duration',
      'predecessors',
      'progress',
    ]);
  });
});
