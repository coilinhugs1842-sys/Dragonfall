/**
 * Tiling noise fields for the generated sky and cloud textures (no asset files). Pure data,
 * load-time only: no three.js, no DOM, tested in node. Every field wraps in both directions.
 */

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Adds `weight` x smooth value noise with `periodX` x `periodY` lattice cells across the
 * square field `out` (`size` x `size`, row-major). Values of one octave span 0..1.
 */
export function addValueNoise(
  out: Float32Array,
  size: number,
  periodX: number,
  periodY: number,
  weight: number,
  random: () => number,
): void {
  const lattice = new Float32Array(periodX * periodY);
  for (let i = 0; i < lattice.length; i++) lattice[i] = random();
  for (let y = 0; y < size; y++) {
    const fy = (y * periodY) / size;
    const y0 = Math.floor(fy);
    const y1 = (y0 + 1) % periodY;
    const ty = fade(fy - y0);
    for (let x = 0; x < size; x++) {
      const fx = (x * periodX) / size;
      const x0 = Math.floor(fx);
      const x1 = (x0 + 1) % periodX;
      const tx = fade(fx - x0);
      const a = lattice[y0 * periodX + x0] ?? 0;
      const b = lattice[y0 * periodX + x1] ?? 0;
      const c = lattice[y1 * periodX + x0] ?? 0;
      const d = lattice[y1 * periodX + x1] ?? 0;
      const top = a + (b - a) * tx;
      const bottom = c + (d - c) * tx;
      out[y * size + x] = (out[y * size + x] ?? 0) + weight * (top + (bottom - top) * ty);
    }
  }
}

/**
 * Adds `weight` x billow noise: 1 at the feature points of a jittered `cells` x `cells` grid,
 * falling to 0 one cell away as `1 - d^2` (inverted Worley F1). Overlapping round domes: the
 * cauliflower shape of cumulus.
 */
export function addBillowNoise(
  out: Float32Array,
  size: number,
  cells: number,
  weight: number,
  random: () => number,
): void {
  const px = new Float32Array(cells * cells);
  const py = new Float32Array(cells * cells);
  for (let i = 0; i < px.length; i++) {
    px[i] = random();
    py[i] = random();
  }
  for (let y = 0; y < size; y++) {
    const fy = (y * cells) / size;
    const cy = Math.floor(fy);
    for (let x = 0; x < size; x++) {
      const fx = (x * cells) / size;
      const cx = Math.floor(fx);
      let nearest = 4;
      for (let oy = -1; oy <= 1; oy++) {
        const gy = (cy + oy + cells) % cells;
        for (let ox = -1; ox <= 1; ox++) {
          const gx = (cx + ox + cells) % cells;
          const i = gy * cells + gx;
          const dx = cx + ox + (px[i] ?? 0) - fx;
          const dy = cy + oy + (py[i] ?? 0) - fy;
          const d2 = dx * dx + dy * dy;
          if (d2 < nearest) nearest = d2;
        }
      }
      // 1 - d^2: a round dome on every feature point, creased where two domes meet.
      const v = nearest < 1 ? 1 - nearest : 0;
      out[y * size + x] = (out[y * size + x] ?? 0) + weight * v;
    }
  }
}

/** Rescales `field` in place so its smallest value is 0 and its largest 1. */
export function normalizeField(field: Float32Array): void {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i] ?? 0;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max > min ? max - min : 1;
  for (let i = 0; i < field.length; i++) field[i] = ((field[i] ?? 0) - min) / range;
}

/** 0..1 -> byte. */
export function unitToByte(value: number): number {
  const byte = Math.round(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}
