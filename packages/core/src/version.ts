// Installed package version, exported so consumers don't have to fs-walk to
// read it from package.json (CM wrote 66 lines to do exactly that). Kept in
// sync with package.json by `version.test.ts`, which fails the build on drift.
//
// This is a ZERO-IMPORT leaf module, published as the `@pyraxi/gantt/version`
// subpath so it can be imported from a React Server Component / server build
// WITHOUT dragging the client-only main entry (`.` → @svar-ui + CSS, jspdf,
// exceljs) into the server graph. Import from `@pyraxi/gantt/version` server-side;
// `@pyraxi/gantt` still re-exports it for client-side convenience. Keep this
// file import-free — any import here would defeat the server-safe subpath.
export const VERSION = '1.7.4';
