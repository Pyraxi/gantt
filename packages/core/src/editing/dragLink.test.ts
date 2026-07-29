import type { Link } from '@pyraxi/cpm-engine';
import { describe, expect, test } from 'vitest';
import {
  cancelDrag,
  completeDrop,
  DRAG_INITIAL,
  isDragInvalid,
  moveDrag,
  startDrag,
} from './dragLink.js';

describe('dragLink state machine', () => {
  test('DRAG_INITIAL is idle', () => {
    expect(DRAG_INITIAL.status).toBe('idle');
  });

  test('startDrag transitions to dragging with sourceId and start coords', () => {
    const state = startDrag('task-1', 100, 50);
    expect(state.status).toBe('dragging');
    if (state.status === 'dragging') {
      expect(state.sourceId).toBe('task-1');
      expect(state.startX).toBe(100);
      expect(state.startY).toBe(50);
      expect(state.cursorX).toBe(100);
      expect(state.cursorY).toBe(50);
    }
  });

  test('moveDrag updates cursor position', () => {
    const dragging = startDrag('task-1', 100, 50);
    const moved = moveDrag(dragging, 120, 55);
    expect(moved.status).toBe('dragging');
    if (moved.status === 'dragging') {
      expect(moved.cursorX).toBe(120);
      expect(moved.cursorY).toBe(55);
      expect(moved.startX).toBe(100); // startX unchanged
    }
  });

  test('moveDrag is no-op when not dragging', () => {
    const result = moveDrag(DRAG_INITIAL, 100, 100);
    expect(result.status).toBe('idle');
  });

  test('completeDrop with valid target → dropped state', () => {
    const dragging = startDrag('task-1', 0, 0);
    const dropped = completeDrop(dragging, 'task-2');
    expect(dropped.status).toBe('dropped');
    if (dropped.status === 'dropped') {
      expect(dropped.sourceId).toBe('task-1');
      expect(dropped.targetId).toBe('task-2');
    }
  });

  test('completeDrop with null target → idle', () => {
    const dragging = startDrag('task-1', 0, 0);
    const result = completeDrop(dragging, null);
    expect(result.status).toBe('idle');
  });

  test('completeDrop when not dragging → idle', () => {
    const result = completeDrop(DRAG_INITIAL, 'task-2');
    expect(result.status).toBe('idle');
  });

  test('cancelDrag → idle', () => {
    const dragging = startDrag('task-1', 0, 0);
    expect(cancelDrag(dragging).status).toBe('idle');
  });
});

describe('isDragInvalid', () => {
  const noLinks: Link[] = [];
  const summaryIds = new Set<string | number>(['summary-1']);

  test('source === target is invalid', () => {
    expect(isDragInvalid('task-1', 'task-1', noLinks, summaryIds)).toBe(true);
  });

  test('target is a summary task → invalid', () => {
    expect(isDragInvalid('task-1', 'summary-1', noLinks, summaryIds)).toBe(true);
  });

  test('duplicate link (same source+target) → invalid', () => {
    const links: Link[] = [{ id: 'L1', source: 'task-1', target: 'task-2', type: 'FS', lag: 0 }];
    expect(isDragInvalid('task-1', 'task-2', links, summaryIds)).toBe(true);
  });

  test('valid new link → not invalid', () => {
    expect(isDragInvalid('task-1', 'task-2', noLinks, summaryIds)).toBe(false);
  });

  test('detects summary target when summaryIds uses different id type', () => {
    const numericSummaryIds = new Set<string | number>([1]); // numeric id
    // targetId as string '1' should still be caught
    expect(isDragInvalid('task-a', '1', noLinks, numericSummaryIds)).toBe(true);
  });
});
