import { describe, it, expect } from 'vitest';
import { constrain, fitSize, initialView, maxScale, panBy, zoomAt } from '../imageZoom';

const box = { w: 1000, h: 500 };
const natural = { w: 4000, h: 3000 };
const fit = fitSize(natural, box); // 666.67 x 500

describe('in- en uitzoomen op een foto', () => {
  it('past de foto eerst precies in het venster, in het midden', () => {
    expect(fit.h).toBe(500);
    expect(fit.w).toBeCloseTo(666.67, 1);
    const v = initialView(fit, box);
    expect(v.scale).toBe(1);
    expect(v.x).toBeCloseTo((1000 - fit.w) / 2, 5);
    expect(v.y).toBe(0);
  });

  it('het punt onder de muis blijft op zijn plek bij inzoomen', () => {
    const v0 = initialView(fit, box);
    const px = 500, py = 250;
    const before = { x: (px - v0.x) / v0.scale, y: (py - v0.y) / v0.scale };
    const v1 = zoomAt(v0, 2, px, py, fit, box, 16);
    expect(v1.scale).toBe(2);
    expect((px - v1.x) / v1.scale).toBeCloseTo(before.x, 5);
    expect((py - v1.y) / v1.scale).toBeCloseTo(before.y, 5);
  });

  it('niet kleiner dan passend en niet groter dan het maximum', () => {
    const v0 = initialView(fit, box);
    expect(zoomAt(v0, 0.2, 500, 250, fit, box, 16).scale).toBe(1);
    expect(zoomAt(v0, 100, 500, 250, fit, box, 16).scale).toBe(16);
  });

  it('mag tot twee keer de echte pixels als dat verder is dan 16 keer', () => {
    expect(maxScale(natural, fit)).toBe(16);
    const huge = { w: 40000, h: 30000 };
    expect(maxScale(huge, fitSize(huge, box))).toBeCloseTo(120, 5);
  });

  it('verschuiven houdt de foto in beeld, zonder lege rand', () => {
    const v = zoomAt(initialView(fit, box), 4, 500, 250, fit, box, 16);
    const far = panBy(v, 100000, 100000, fit, box);
    expect([far.x, far.y]).toEqual([0, 0]);
    const other = panBy(v, -100000, -100000, fit, box);
    expect(other.x).toBeCloseTo(1000 - fit.w * 4, 5);
    expect(other.y).toBeCloseTo(500 - fit.h * 4, 5);
  });

  it('zonder bekende maten gebeurt er niets geks', () => {
    const f = fitSize({ w: 0, h: 0 }, box);
    expect(f).toEqual({ w: 0, h: 0 });
    expect(constrain({ scale: 1, x: 5, y: 5 }, f, box)).toEqual({ scale: 1, x: 500, y: 250 });
  });
});
