import { describe, expect, test } from 'vitest';
import { classifyStructuralEvent, resolveDirectEdit, resolveEditRequest } from './svar-adapter.js';

describe('classifyStructuralEvent', () => {
  test('delete-task', () => {
    expect(classifyStructuralEvent('delete-task', { id: 'a' })).toEqual({
      kind: 'delete',
      id: 'a',
    });
  });
  test('move-task up/down', () => {
    expect(classifyStructuralEvent('move-task', { id: 'a', mode: 'up' })).toEqual({
      kind: 'move',
      id: 'a',
      direction: 'up',
    });
    expect(classifyStructuralEvent('move-task', { id: 'a', mode: 'down' })).toEqual({
      kind: 'move',
      id: 'a',
      direction: 'down',
    });
  });
  test('move-task drag mid-flight (inProgress) → null, not bridged per frame', () => {
    expect(
      classifyStructuralEvent('move-task', {
        id: 'a',
        mode: 'before',
        target: 'b',
        inProgress: true,
      }),
    ).toBeNull();
    // No inProgress flag at all → not a recognized drag-end; stay null.
    expect(
      classifyStructuralEvent('move-task', { id: 'a', mode: 'after', target: 'b' }),
    ).toBeNull();
  });
  test('move-task drag-END (inProgress:false) → reorder with raw target + mode', () => {
    expect(
      classifyStructuralEvent('move-task', {
        id: 'a',
        mode: 'before',
        target: 'b',
        inProgress: false,
      }),
    ).toEqual({ kind: 'reorder', id: 'a', target: 'b', mode: 'before' });
    expect(
      classifyStructuralEvent('move-task', {
        id: 'a',
        mode: 'child',
        target: 'b',
        inProgress: false,
      }),
    ).toEqual({ kind: 'reorder', id: 'a', target: 'b', mode: 'child' });
  });
  test('indent-task true → indent, false → outdent', () => {
    expect(classifyStructuralEvent('indent-task', { id: 'a', mode: true })).toEqual({
      kind: 'indent',
      id: 'a',
      direction: 'indent',
    });
    expect(classifyStructuralEvent('indent-task', { id: 'a', mode: false })).toEqual({
      kind: 'indent',
      id: 'a',
      direction: 'outdent',
    });
  });
  test('add-task carries task + raw target/mode', () => {
    const t = { id: 'x', text: 'X' };
    expect(classifyStructuralEvent('add-task', { task: t, target: 'a', mode: 'after' })).toEqual({
      kind: 'add',
      task: t,
      target: 'a',
      mode: 'after',
    });
  });
  test('add-task with no mode defaults to child (SVAR grid `+`)', () => {
    const t = { id: 'x', text: 'X' };
    expect(classifyStructuralEvent('add-task', { task: t, target: 'a' })).toEqual({
      kind: 'add',
      task: t,
      target: 'a',
      mode: 'child',
    });
  });
  test('unknown event → null', () => {
    expect(classifyStructuralEvent('zoom-scale', {})).toBeNull();
  });
});

describe('resolveEditRequest', () => {
  test('handler wired + real id → returns id (route to consumer, veto SVAR editor)', () => {
    expect(resolveEditRequest({ id: 'task-3' }, true)).toBe('task-3');
  });
  test('no handler → null (let SVAR handle natively)', () => {
    expect(resolveEditRequest({ id: 'task-3' }, false)).toBeNull();
  });
  test('close-editor path (id null) → null even with handler', () => {
    expect(resolveEditRequest({ id: null }, true)).toBeNull();
  });
  test('missing id → null', () => {
    expect(resolveEditRequest({}, true)).toBeNull();
  });
});

describe('resolveDirectEdit (F3 — update-task fall-through when onTaskEdit unwired)', () => {
  const start = new Date('2026-07-10T00:00:00Z');

  test('handler wired + mappable delta → returns patch (bridge + veto SVAR)', () => {
    expect(resolveDirectEdit({ start }, true)).toEqual({ start, scheduleMode: 'manual' });
  });
  test('NO handler wired → null even for a mappable delta (fall through to SVAR, do NOT veto)', () => {
    // Regression: previously the intercept vetoed SVAR's mutation and no-op-called
    // the (undefined) handler → the edit gesture did nothing. Must pass through now.
    expect(resolveDirectEdit({ start }, false)).toBeNull();
  });
  test('handler wired but empty/non-mappable delta → null (let SVAR handle, e.g. duration-only)', () => {
    expect(resolveDirectEdit({}, true)).toBeNull();
    expect(resolveDirectEdit({ duration: 3 }, true)).toBeNull();
  });
});
