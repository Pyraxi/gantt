import { describe, expect, test } from 'vitest';
import { correctedToolbarButtons } from './svar-adapter.js';

describe('correctedToolbarButtons', () => {
  test('copy-task tooltip is Ctrl+C, paste stays Ctrl+V', () => {
    const items = correctedToolbarButtons() as Array<{ id?: string; text?: string }>;
    const copy = items.find((i) => i.id === 'copy-task');
    const paste = items.find((i) => i.id === 'paste-task');
    expect(copy?.text).toBe('Ctrl+C');
    expect(paste?.text).toBe('Ctrl+V');
  });
});
