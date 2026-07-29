import { describe, expect, test } from 'vitest';
import { resolvePreset } from './svar-adapter.js';

describe('resolvePreset', () => {
  test('no preset → passthrough (all off/undefined)', () => {
    const r = resolvePreset({});
    expect(r.editMode).toBe(false);
    expect(r.toolbar).toBe(false);
    expect(r.contextMenu).toBe(false);
    expect(r.editor).toBe(false);
  });
  test('msproject preset turns everything on', () => {
    const r = resolvePreset({ preset: 'msproject' });
    expect(r.editMode).toBe(true);
    expect(r.editor).toBe(true);
    expect(r.contextMenu).toBe(true);
    expect(r.toolbar).toBe(true);
  });
  test('explicit prop overrides the preset', () => {
    const r = resolvePreset({ preset: 'msproject', contextMenu: false, editMode: false });
    expect(r.contextMenu).toBe(false);
    expect(r.editMode).toBe(false);
    expect(r.editor).toBe(true); // still preset default
  });
});
