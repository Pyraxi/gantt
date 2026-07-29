import { describe, expect, it } from 'vitest';
import pkg from '../package.json' with { type: 'json' };
import { VERSION } from './version.js';
// Raw source of the leaf — used to guard it stays import-free (see below).
import versionSource from './version.ts?raw';

describe('VERSION', () => {
  it('matches package.json version (sync guard — bump both together)', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('is a client-free leaf — no imports (guards the @pyraxi/gantt/version server subpath)', () => {
    // CM resolves VERSION in a React Server Component; importing from the main
    // entry drags the client bundle (@svar-ui + CSS, jspdf, xlsx) into the
    // server graph and breaks `next build`. The `./version` subpath only stays
    // server-safe while this module imports NOTHING. Any import/require here
    // silently re-breaks that — fail loudly instead.
    const codeOnly = versionSource
      .replace(/\/\*[\s\S]*?\*\//g, '') // strip block comments
      .replace(/^\s*\/\/.*$/gm, ''); // strip line comments (they mention imports as prose)
    expect(codeOnly).not.toMatch(/^\s*import\b/m);
    expect(codeOnly).not.toMatch(/\brequire\s*\(/);
  });

  it('is exported as the `./version` subpath in package.json exports', () => {
    expect(pkg.exports['./version']).toBeDefined();
  });
});
