import { describe, expect, test } from 'vitest';
import { computeImageFit, PAGE_DIMENSIONS_MM } from './pdf-dimensions.js';

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
