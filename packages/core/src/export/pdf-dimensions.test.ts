import { describe, expect, test } from 'vitest';
import { computeImageFit, PAGE_DIMENSIONS_MM, paginateRows } from './pdf-dimensions.js';

describe('computeImageFit', () => {
  test('fits a wide PNG into a landscape A3 page centered with margin', () => {
    const page = PAGE_DIMENSIONS_MM.a3.landscape;
    const fit = computeImageFit({
      pageWidth: page.width,
      pageHeight: page.height,
      margin: 10,
      pngPxWidth: 2000,
      pngPxHeight: 500,
    });

    expect(fit.width).toBeCloseTo(400, 1);
    expect(fit.height).toBeCloseTo(100, 1);
    expect(fit.x).toBeCloseTo(10, 1);
    expect(fit.y).toBeCloseTo(98.5, 1);
  });

  test('fits a tall PNG into a portrait A4 page height-bound', () => {
    const page = PAGE_DIMENSIONS_MM.a4.portrait;
    const fit = computeImageFit({
      pageWidth: page.width,
      pageHeight: page.height,
      margin: 10,
      pngPxWidth: 500,
      pngPxHeight: 2000,
    });

    expect(fit.height).toBeCloseTo(277, 1);
    expect(fit.width).toBeCloseTo(69.25, 1);
    expect(fit.x).toBeCloseTo(70.375, 1);
    expect(fit.y).toBeCloseTo(10, 1);
  });

  test('exposes letter format dimensions', () => {
    expect(PAGE_DIMENSIONS_MM.letter.landscape).toEqual({ width: 279.4, height: 215.9 });
    expect(PAGE_DIMENSIONS_MM.letter.portrait).toEqual({ width: 215.9, height: 279.4 });
  });
});

describe('paginateRows (parity row 13)', () => {
  // A 1000×1100 px capture: 100 px header, then 20 rows of 50 px.
  const base = { imgW: 1000, imgH: 1100, headerPx: 100, rowPx: 50, rowCount: 20 };

  test('scales to content width and never cuts a row', () => {
    // 500 mm wide → 0.5 mm/px. 300 mm tall: the header takes 50 mm, leaving
    // 250 mm = 500 px = 10 rows per page.
    const r = paginateRows({ ...base, contentW: 500, contentH: 300 });
    expect(r.scale).toBeCloseTo(0.5);
    expect(r.pages).toEqual([
      { startPx: 100, endPx: 600 },
      { startPx: 600, endPx: 1100 },
    ]);
  });

  test('a partial last page holds the remainder', () => {
    const r = paginateRows({ ...base, contentW: 500, contentH: 280 }); // 9 rows/page
    expect(r.pages.map((p) => (p.endPx - p.startPx) / 50)).toEqual([9, 9, 2]);
  });

  test('page breaks land on row boundaries', () => {
    const r = paginateRows({ ...base, contentW: 500, contentH: 287 });
    for (const p of r.pages) expect((p.startPx - 100) % 50).toBe(0);
  });

  test('a page too short for even one row still advances one row per page', () => {
    const r = paginateRows({ ...base, contentW: 500, contentH: 60 });
    expect(r.pages).toHaveLength(20);
  });

  test('a capture taller than header + rows (trailing whitespace) ends at the last row', () => {
    const r = paginateRows({ ...base, imgH: 1180, contentW: 500, contentH: 300 });
    expect(r.pages.at(-1)?.endPx).toBe(1100);
  });

  test('no rows → a single header-only page', () => {
    const r = paginateRows({ ...base, imgH: 100, rowCount: 0, contentW: 500, contentH: 300 });
    expect(r.pages).toEqual([{ startPx: 100, endPx: 100 }]);
  });
});

describe('PAGE_DIMENSIONS_MM construction sizes', () => {
  test('A1 and A2 are ISO 216', () => {
    expect(PAGE_DIMENSIONS_MM.a1.portrait).toEqual({ width: 594, height: 841 });
    expect(PAGE_DIMENSIONS_MM.a2.landscape).toEqual({ width: 594, height: 420 });
  });
});

describe('paginateRows maxScale', () => {
  test('a narrow chart is not enlarged past maxScale', () => {
    const r = paginateRows({
      imgW: 600,
      imgH: 1100,
      headerPx: 100,
      rowPx: 50,
      rowCount: 20,
      contentW: 400,
      contentH: 300,
      maxScale: 0.25,
    });
    expect(r.scale).toBe(0.25);
    // 300 mm − 25 mm header = 275 mm = 1100 px → 22 rows fit → one page.
    expect(r.pages).toHaveLength(1);
  });
});
