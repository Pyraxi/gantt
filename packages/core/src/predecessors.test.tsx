import type { Link, Task } from '@pyraxi/cpm-engine';
import { render } from '@testing-library/react';
import type { FC } from 'react';
import { describe, expect, test } from 'vitest';
import { formatPredecessors, idColumn } from './predecessors.js';

function link(id: string, source: string, target: string, type = 'FS', lag = 0): Link {
  return { id, source, target, type: type as Link['type'], lag };
}
function tk(id: string): Task {
  return {
    id,
    text: id,
    type: 'task',
    scheduleMode: 'auto',
    duration: 480,
    start: new Date(2026, 0, 5),
    end: new Date(2026, 0, 6),
    progress: 0,
  };
}

describe('formatPredecessors', () => {
  const links: Link[] = [
    link('l1', 'a', 'c'),
    link('l2', 'b', 'c', 'SS', 120),
    link('l3', 'a', 'd'),
  ];
  test('no incoming links → empty string', () => {
    expect(formatPredecessors('a', links)).toBe('');
  });
  test('single FS zero-lag → bare source id', () => {
    expect(formatPredecessors('d', links)).toBe('a');
  });
  test('multiple, with type + lag annotations, in array order', () => {
    expect(formatPredecessors('c', links)).toBe('a, bSS+120m');
  });
  test('numeric ids coerce to string', () => {
    expect(formatPredecessors(2, [link('l', '1', '2')])).toBe('1');
  });
});

describe('formatPredecessors — MS-Project row-number + day-lag form', () => {
  // Row order: piles(1), subframe(2), lvl(3), walls(4)
  const tasks = [tk('piles'), tk('subframe'), tk('lvl'), tk('walls')];
  const mpd = 480; // working minutes per day

  test('references predecessors by 1-based row number, not id', () => {
    // walls (row 4) depends on lvl (row 3), FS zero lag → "3"
    expect(formatPredecessors('walls', [link('l', 'lvl', 'walls')], { tasks })).toBe('3');
  });
  test('FS with lag shows FS + lag in days (MS Project: "1FS+3 days")', () => {
    expect(
      formatPredecessors('walls', [link('l', 'piles', 'walls', 'FS', 3 * mpd)], {
        tasks,
        minutesPerDay: mpd,
      }),
    ).toBe('1FS+3 days');
  });
  test('singular day + negative lag', () => {
    expect(
      formatPredecessors('walls', [link('l', 'subframe', 'walls', 'FS', -mpd)], {
        tasks,
        minutesPerDay: mpd,
      }),
    ).toBe('2FS-1 day');
  });
  test('non-FS type always shown; lag in days', () => {
    expect(
      formatPredecessors('walls', [link('l', 'piles', 'walls', 'SS', mpd)], {
        tasks,
        minutesPerDay: mpd,
      }),
    ).toBe('1SS+1 day');
  });
  test('unknown source id falls back to the id (not a phantom row number)', () => {
    expect(formatPredecessors('walls', [link('l', 'ghost', 'walls')], { tasks })).toBe('ghost');
  });
});

describe('idColumn', () => {
  const tasks = [tk('a'), tk('b'), tk('c')];
  test('renders the 1-based row number for each task', () => {
    const col = idColumn(tasks);
    const Cell = col.render as FC<{ task: Task }>;
    expect(render(<Cell task={tasks[0]} />).container.textContent).toBe('1');
    expect(render(<Cell task={tasks[2]} />).container.textContent).toBe('3');
  });
  test('right-aligned, header "ID", id "_id"', () => {
    const col = idColumn(tasks);
    expect(col.align).toBe('right');
    expect(col.header).toBe('ID');
    expect(col.id).toBe('_id');
  });
});
