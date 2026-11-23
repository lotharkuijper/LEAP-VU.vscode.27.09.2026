// Rekenwerk voor in- en uitzoomen op een foto (speelbord van de beeldoefeningen).
// De foto past eerst precies in het venster (scale 1); daarna zoomt de student in
// tot hooguit MAX_ZOOM keer, of tot twee keer de echte pixels als dat meer is.
// x en y zijn de plek van de linkerbovenhoek van de foto in het venster.

export type ZoomView = { scale: number; x: number; y: number };
export type Size = { w: number; h: number };

export const MAX_ZOOM = 16;

/** Grootte van de foto als die precies in het venster past (scale 1). */
export function fitSize(natural: Size, box: Size): Size {
  if (!natural.w || !natural.h || !box.w || !box.h) return { w: 0, h: 0 };
  const f = Math.min(box.w / natural.w, box.h / natural.h);
  return { w: natural.w * f, h: natural.h * f };
}

/** Hoe ver mag je inzoomen: minstens MAX_ZOOM, of tot twee keer de echte pixels. */
export function maxScale(natural: Size, fit: Size): number {
  if (!fit.w) return MAX_ZOOM;
  return Math.max(MAX_ZOOM, (natural.w / fit.w) * 2);
}

/** Houd de foto in beeld: kleiner dan het venster = in het midden, groter = geen lege rand. */
export function constrain(v: ZoomView, fit: Size, box: Size): ZoomView {
  const w = fit.w * v.scale;
  const h = fit.h * v.scale;
  const x = w <= box.w ? (box.w - w) / 2 : Math.min(0, Math.max(box.w - w, v.x));
  const y = h <= box.h ? (box.h - h) / 2 : Math.min(0, Math.max(box.h - h, v.y));
  return { scale: v.scale, x, y };
}

/** Zoom met factor rond punt (px, py) in het venster; dat punt blijft op zijn plek. */
export function zoomAt(v: ZoomView, factor: number, px: number, py: number, fit: Size, box: Size, max: number): ZoomView {
  const scale = Math.min(max, Math.max(1, v.scale * factor));
  const k = scale / v.scale;
  return constrain({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, fit, box);
}

/** Verschuif de foto. */
export function panBy(v: ZoomView, dx: number, dy: number, fit: Size, box: Size): ZoomView {
  return constrain({ scale: v.scale, x: v.x + dx, y: v.y + dy }, fit, box);
}

/** Beginstand: passend en in het midden. */
export function initialView(fit: Size, box: Size): ZoomView {
  return constrain({ scale: 1, x: 0, y: 0 }, fit, box);
}
