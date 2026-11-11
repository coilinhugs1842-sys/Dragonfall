/**
 * Minimal HTML flight overlay: the steering circle, the reticle dot that shows where the mouse
 * is aiming, and a "click to fly" prompt while the pointer is not locked. HTML in `#ui`, so it
 * is drawn at full resolution whatever the render scale is. A stand-in until the HUD (T-3.x)
 * draws its own reticle from `InputState.reticleX/Y`.
 *
 * `update` is allocation-free: positions are whole pixels taken from a table of ready-made
 * strings and written to CSS custom properties, and the DOM is only touched when a value changed.
 */

export interface FlightOverlayOptions {
  /** Where to mount. Defaults to `#ui`, then `document.body`. */
  parent?: HTMLElement;
  /** Radius in CSS pixels of the on-screen steering circle. Default 110. */
  radiusPx?: number;
  promptText?: string;
}

export interface FlightOverlay {
  readonly element: HTMLElement;
  /**
   * `reticleX/Y`: the normalised offset from `InputState` (x right, y up). `locked`: whether
   * the pointer is locked; the prompt shows when it is not. Call once per rendered frame.
   */
  update(reticleX: number, reticleY: number, locked: boolean): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

const DEFAULT_RADIUS_PX = 110;
const MAX_RADIUS_PX = 400;
const DOT_SIZE_PX = 8;

export function createFlightOverlay(options: FlightOverlayOptions = {}): FlightOverlay {
  const requested = Math.round(options.radiusPx ?? DEFAULT_RADIUS_PX);
  const radius = Math.min(MAX_RADIUS_PX, Math.max(8, Number.isFinite(requested) ? requested : 0));

  // PX[i] = `${i - radius}px` for every whole-pixel offset the dot can have.
  const px: string[] = [];
  for (let i = -radius; i <= radius; i++) px.push(`${i}px`);

  const root = document.createElement('div');
  root.className = 'df-flight-overlay';
  root.style.cssText =
    'position:absolute;inset:0;pointer-events:none;user-select:none;contain:strict;';

  const ring = document.createElement('div');
  ring.style.cssText =
    `position:absolute;left:50%;top:50%;width:${radius * 2}px;height:${radius * 2}px;` +
    `margin:-${radius}px 0 0 -${radius}px;border-radius:50%;` +
    'border:1px solid rgba(255,240,214,0.16);';
  root.appendChild(ring);

  const dot = document.createElement('div');
  dot.style.cssText =
    `position:absolute;left:50%;top:50%;width:${DOT_SIZE_PX}px;height:${DOT_SIZE_PX}px;` +
    `margin:-${DOT_SIZE_PX / 2}px 0 0 -${DOT_SIZE_PX / 2}px;border-radius:50%;` +
    'border:2px solid rgba(255,240,214,0.9);box-shadow:0 0 4px rgba(11,16,32,0.8);' +
    'transform:translate(var(--df-rx,0px),var(--df-ry,0px));will-change:transform;';
  root.appendChild(dot);

  const prompt = document.createElement('div');
  prompt.textContent = options.promptText ?? 'Click to fly';
  prompt.style.cssText =
    'position:absolute;left:50%;top:62%;transform:translateX(-50%);padding:8px 18px;' +
    'border-radius:999px;font-size:16px;letter-spacing:0.04em;white-space:nowrap;' +
    'color:#fff0d6;background:rgba(11,16,32,0.6);';
  root.appendChild(prompt);

  (options.parent ?? document.getElementById('ui') ?? document.body).appendChild(root);

  let lastX = 0;
  let lastY = 0;
  let lastLocked = false;
  ring.hidden = true;
  dot.hidden = true;

  return {
    element: root,

    update(reticleX: number, reticleY: number, locked: boolean): void {
      if (locked !== lastLocked) {
        lastLocked = locked;
        prompt.hidden = locked;
        ring.hidden = !locked;
        dot.hidden = !locked;
      }
      if (!locked) return;
      // NaN fails both comparisons and lands on 0.
      const fx = reticleX > -1 ? (reticleX < 1 ? reticleX : 1) : reticleX <= -1 ? -1 : 0;
      const fy = reticleY > -1 ? (reticleY < 1 ? reticleY : 1) : reticleY <= -1 ? -1 : 0;
      const x = Math.round(fx * radius);
      // Screen y points down.
      const y = Math.round(-fy * radius);
      if (x !== lastX) {
        lastX = x;
        dot.style.setProperty('--df-rx', px[x + radius] ?? '0px');
      }
      if (y !== lastY) {
        lastY = y;
        dot.style.setProperty('--df-ry', px[y + radius] ?? '0px');
      }
    },

    setVisible(visible: boolean): void {
      if (root.hidden === visible) root.hidden = !visible;
    },

    dispose(): void {
      root.remove();
    },
  };
}
