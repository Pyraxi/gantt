// Minimal HTMLCanvasElement.prototype.getContext stub so SVAR's React Gantt
// can mount under happy-dom. happy-dom does not implement Canvas 2D — its
// HTMLCanvasElement.getContext() returns null, which breaks any consumer
// that calls context methods.
//
// SVAR's grid renderer calls ctx.translate(), ctx.save(), ctx.fillRect(),
// ctx.fillText(), etc. during its initial layout pass. Returning a Proxy
// that no-ops every method (and returns a stub `width: 0` for measureText)
// lets SVAR complete its mount; the bars/rows render as DOM elements
// (independent of the canvas grid) and our tests can assert against the
// real DOM tree.
//
// This is test-only infrastructure. Real Canvas 2D is needed in the browser
// and in any Playwright/Vitest-browser project; this stub is for the
// happy-dom unit project only.

const ctxHandler: ProxyHandler<object> = {
  get(_target, prop) {
    if (prop === 'measureText') return () => ({ width: 0 });
    if (prop === 'getImageData') {
      return () => ({ data: new Uint8ClampedArray(0), width: 0, height: 0 });
    }
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') {
      return () => ({ addColorStop: () => undefined });
    }
    if (prop === 'createPattern') return () => null;
    // Every other property access returns a no-op function. SVAR assigns
    // to fillStyle/strokeStyle/lineWidth/etc — the `set` handler below
    // accepts those silently.
    return () => undefined;
  },
  set: () => true,
};

if (typeof globalThis.HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function getContextStub() {
    return new Proxy({}, ctxHandler) as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
}
