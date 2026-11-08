// Renderer check on real MS Project programmes (CM's 2026-10-21 set): each
// mounts in <Gantt> without errors, with a row per task. Client data, so NOT
// committed: point CG_MSP_PROGRAMMES_DIR at a folder of `.xml` files to run;
// it skips in CI. Messages name counts only, never task names.
// Separate file: vi.mock is hoisted.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMspdi } from '@pyraxi/cpm-engine';
import { cleanup, render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Gantt } from './Gantt.js';

type Api = { getState(): { _tasks: unknown[] } };
const captured: { api?: Api } = {};

vi.mock('@svar-ui/react-gantt', async (orig) => {
  const mod = (await orig()) as Record<string, unknown> & { Gantt: unknown };
  const Wrapped = (props: { init?: (api: Api) => void }) =>
    createElement(mod.Gantt as never, {
      ...props,
      init: (api: Api) => {
        captured.api = api;
        props.init?.(api);
      },
    });
  return { ...mod, Gantt: Wrapped };
});

afterEach(() => {
  cleanup();
  captured.api = undefined;
  vi.restoreAllMocks();
});

const dir = process.env.CG_MSP_PROGRAMMES_DIR ?? '';
const files = dir && existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.xml')) : [];

describe.skipIf(files.length === 0)('real programmes render', () => {
  test.each(files)('%s mounts with a row per task and no errors', (file) => {
    const { project } = parseMspdi(readFileSync(join(dir, file), 'utf8'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<Gantt project={project} height={600} />);
    expect(errors).not.toHaveBeenCalled();
    expect(captured.api?.getState()._tasks.length).toBe(project.tasks.length);
  });
});
