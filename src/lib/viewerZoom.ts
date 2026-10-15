// Zoomstappen van de documentviewer; 1 = passend op de breedte van het paneel.
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];

/** Volgende zoomstap omhoog (dir 1) of omlaag (dir -1), begrensd op de uitersten. */
export function nextZoom(current: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? ZOOM_STEPS[0];
}
