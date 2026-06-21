import { act, renderHook } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { useEditState } from './useEditState.js';

describe('useEditState', () => {
  test('starts with no active cell', () => {
    const { result } = renderHook(() => useEditState());
    expect(result.current.activeCell).toBeNull();
    expect(result.current.dirtyValue).toBe('');
  });

  test('activateCell sets activeCell and dirtyValue', () => {
    const { result } = renderHook(() => useEditState());
    act(() => {
      result.current.activateCell('task-1', 'text', 'Foundation pour');
    });
    expect(result.current.activeCell).toEqual({ taskId: 'task-1', field: 'text' });
    expect(result.current.dirtyValue).toBe('Foundation pour');
  });

  test('setValue updates dirtyValue only', () => {
    const { result } = renderHook(() => useEditState());
    act(() => {
      result.current.activateCell('task-1', 'text', 'old');
    });
    act(() => {
      result.current.setValue('new value');
    });
    expect(result.current.dirtyValue).toBe('new value');
    expect(result.current.activeCell?.taskId).toBe('task-1');
  });

  test('cancelCell clears state without firing callback', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'text', 'foo');
    });
    act(() => {
      result.current.cancelCell();
    });
    expect(result.current.activeCell).toBeNull();
    expect(onTaskEdit).not.toHaveBeenCalled();
  });

  test('commitCell fires onTaskEdit with text patch and clears state', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'text', '');
    });
    act(() => {
      result.current.setValue('Framing');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', { text: 'Framing' });
    expect(result.current.activeCell).toBeNull();
  });

  test('commitCell parses duration field: "5" → 2400 minutes (5×8×60)', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'duration', '');
    });
    act(() => {
      result.current.setValue('5');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', { duration: 2400 });
  });

  test.each([
    ['1d', 480],
    ['4h', 240],
    ['30m', 30],
    ['1.5d', 720],
  ])('commitCell parses MS Project-style duration %s → %i minutes', (input, expected) => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'duration', '');
    });
    act(() => {
      result.current.setValue(input);
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', { duration: expected });
  });

  test('commitCell parses start field: "2026-01-05" → Date at 08:00', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'start', '');
    });
    act(() => {
      result.current.setValue('2026-01-05');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    const patch = onTaskEdit.mock.calls[0][1] as { start: Date };
    expect(patch.start).toEqual(new Date('2026-01-05T08:00:00'));
  });

  test('commitCell clamps progress to 0-100', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'progress', '');
    });
    act(() => {
      result.current.setValue('150');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', { progress: 100 });
  });

  test('commitCell when no activeCell does nothing', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).not.toHaveBeenCalled();
  });

  test('commitCell with invalid duration string emits empty patch', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'duration', '');
    });
    act(() => {
      result.current.setValue('abc');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', {});
  });

  test('commitCell with invalid scheduleMode emits empty patch', () => {
    const { result } = renderHook(() => useEditState());
    const onTaskEdit = vi.fn();
    act(() => {
      result.current.activateCell('task-1', 'scheduleMode', '');
    });
    act(() => {
      result.current.setValue('invalid-mode');
    });
    act(() => {
      result.current.commitCell(onTaskEdit);
    });
    expect(onTaskEdit).toHaveBeenCalledWith('task-1', {});
  });
});
