/**
 * Render scale → renderer pixel ratio. PURE (no three.js, no DOM) so it is unit-testable.
 *
 * docs/PERFORMANCE.md defines the render scale as a fraction "of 1080p", not of the display's
 * native resolution: a 0.85 scale must cost the same GPU time on a 1080p panel and on a
 * 2.8K/high-DPI panel. So the target is first capped at 1080 lines, then scaled:
 *
 *   targetHeight = min(cssHeight * devicePixelRatio, 1080) * scale
 *   pixelRatio   = targetHeight / cssHeight
 *                = min(devicePixelRatio, 1080 / cssHeight) * scale
 *
 * The same ratio is used for the width, so the aspect ratio is kept and an ultrawide window
 * gets proportionally more columns. The drawing buffer is then floor(css * pixelRatio).
 */
import { RENDER_SCALE_REFERENCE_HEIGHT } from '../shared/quality';

export function computePixelRatio(
  cssHeight: number,
  devicePixelRatio: number,
  scale: number,
): number {
  if (!(cssHeight > 0) || !(devicePixelRatio > 0)) return scale;
  const cap = RENDER_SCALE_REFERENCE_HEIGHT / cssHeight;
  return (devicePixelRatio < cap ? devicePixelRatio : cap) * scale;
}
