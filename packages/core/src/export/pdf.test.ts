import type { Calendar, Project, Task } from '@pyraxi/cpm-engine';
import { schedule } from '@pyraxi/cpm-engine';
import { describe, expect, test, vi } from 'vitest';

// A 1x1 red-pixel PNG (valid jsPDF input). Base64-decoded at mock-eval time.
const VALID_1x1_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

vi.mock('html-to-image', () => ({
  toBlob: vi.fn(async () => new Blob([base64ToBytes(VALID_1x1_PNG_B64)], { type: 'image/png' })),
}));

class StubImage {
  width = 2000;
  height = 500;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}
vi.stubGlobal('Image', StubImage);

const STD = { startMinutes: 8 * 60, endMinutes: 17 * 60 };
const standardCalendar: Calendar = {
  id: 'std',
  name: 'Standard',
  workWeek: [[], [STD], [STD], [STD], [STD], [STD], []],
  exceptions: [],
};

function task(id: string): Task {
  return {
    id,
    text: `Task ${id}`,
    type: 'task',
    scheduleMode: 'auto',
    duration: 540,
    start: new Date(2026, 0, 5, 8, 0),
    end: new Date(2026, 0, 5, 8, 0),
    progress: 0,
  };
}

function project(tasks: Task[]): Project {
  return {
    start: new Date(2026, 0, 5, 8, 0),
    defaultCalendarId: 'std',
    tasks,
    links: [],
    resources: [],
    calendars: [standardCalendar],
    baselines: [],
    assignments: [],
  };
}

describe('exportPDF', () => {
  test('returns an application/pdf Blob', async () => {
    const p = schedule(project([task('a')]));

    const { exportPDF } = await import('./pdf.js');
    const blob = await exportPDF({
      scheduled: p,
      ganttProps: { cellWidth: 48, cellHeight: 42 },
      options: { format: 'a3', orientation: 'landscape' },
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/pdf');
    expect(blob.size).toBeGreaterThan(500);
  });
});
