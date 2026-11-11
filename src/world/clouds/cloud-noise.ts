/**
 * Generated cloud textures (no asset files): a tiling height + slope map for the cloud sea and
 * a small atlas of puff sprites with baked normals. Pure data in, bytes out: tested in node.
 * Load-time only.
 */
import { createSeededRandom } from '../../shared';
import { addBillowNoise, addValueNoise, normalizeField } from '../sky/noise-fields';

/** Byte that decodes to zero for the signed channels: shaders use `(texel - 128/255) * 2`. */
export const SIGNED_ZERO_BYTE = 128;

function encodeSigned(value: number): number {
  const byte = Math.round(SIGNED_ZERO_BYTE + value * 127);
  return byte < 1 ? 1 : byte > 255 ? 255 : byte;
}

function encodeUnit(value: number): number {
  const byte = Math.round(value * 255);
  return byte < 0 ? 0 : byte > 255 ? 255 : byte;
}

/**
 * A `size` x `size` RGBA8 map that tiles in both directions:
 * R = billow height 0..1, G / B = its slope along +u / +v (signed, see `SIGNED_ZERO_BYTE`,
 * scaled so the steepest texel is +-1), A = an independent fine billow field 0..1 (detail).
 * One fetch gives the cloud-sea shader a height and a normal, with no derivatives.
 *
 * The height is broad swells (value noise) carrying round cauliflower bumps (inverted Worley):
 * swells alone read as fog, bumps alone as pebbles.
 */
export function generateCloudSeaNoise(size: number, seed: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(size) || size < 16) throw new Error('cloud noise size must be >= 16');
  const random = createSeededRandom(seed);
  const height = new Float32Array(size * size);
  const detail = new Float32Array(size * size);

  addValueNoise(height, size, 3, 3, 0.34, random);
  addValueNoise(height, size, 7, 7, 0.14, random);
  addBillowNoise(height, size, 5, 0.3, random);
  addBillowNoise(height, size, 11, 0.16, random);
  addBillowNoise(height, size, 23, 0.06, random);
  normalizeField(height);
  addBillowNoise(detail, size, 9, 0.6, random);
  addBillowNoise(detail, size, 19, 0.4, random);
  normalizeField(detail);

  // Central differences with wrap-around, so the slopes tile like the heights do.
  const slopeU = new Float32Array(size * size);
  const slopeV = new Float32Array(size * size);
  let steepest = 1e-6;
  for (let y = 0; y < size; y++) {
    const up = ((y + 1) % size) * size;
    const down = ((y + size - 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const right = (x + 1) % size;
      const left = (x + size - 1) % size;
      const du = ((height[y * size + right] ?? 0) - (height[y * size + left] ?? 0)) * 0.5;
      const dv = ((height[up + x] ?? 0) - (height[down + x] ?? 0)) * 0.5;
      slopeU[y * size + x] = du;
      slopeV[y * size + x] = dv;
      steepest = Math.max(steepest, Math.abs(du), Math.abs(dv));
    }
  }

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < height.length; i++) {
    out[i * 4] = encodeUnit(height[i] ?? 0);
    out[i * 4 + 1] = encodeSigned((slopeU[i] ?? 0) / steepest);
    out[i * 4 + 2] = encodeSigned((slopeV[i] ?? 0) / steepest);
    out[i * 4 + 3] = encodeUnit(detail[i] ?? 0);
  }
  return out;
}

/** The puff atlas is a 2 x 2 grid of sprites. */
export const PUFF_ATLAS_GRID = 2;
export const PUFF_VARIANT_COUNT = PUFF_ATLAS_GRID * PUFF_ATLAS_GRID;
/**
 * Every sprite is empty beyond this radius of its cell (cell coordinates run -1..1), so the
 * billboard can be an octagon that trims the corners, and neighbouring cells never bleed.
 */
export const PUFF_CONTENT_RADIUS = 0.9;
/** How strongly the baked normals lean at the puff's flanks. */
const PUFF_NORMAL_STRENGTH = 1.1;
const PUFF_BLUR_PASSES = 2;
/**
 * Lower bound of where the flat base of every sprite sits in its cell (-1 bottom .. 1 top). Placement
 * uses it to rest puffs on the cloud sea.
 */
export const PUFF_BASE_Y = -0.7;
/** Shape-space height per cell-space height: below 1 stretches the puff to fill the cell. */
const PUFF_SHAPE_SQUASH = 0.42;
const PUFF_MAX_BLOBS = 7;
const PUFF_MIN_BLOBS = 5;

/**
 * One box-blur pass over the lines of a square image, edges clamped. `step` is the distance
 * between neighbours along the blur direction and `lineStep` the distance between lines.
 */
function boxBlur(
  source: Float32Array,
  target: Float32Array,
  size: number,
  radius: number,
  step: number,
  lineStep: number,
): void {
  const window = radius * 2 + 1;
  for (let line = 0; line < size; line++) {
    const base = line * lineStep;
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = Math.min(Math.max(i + k, 0), size - 1);
        sum += source[base + j * step] ?? 0;
      }
      target[base + i * step] = sum / window;
    }
  }
}

/**
 * An RGBA8 atlas, `cellSize * 2` texels square, of `PUFF_VARIANT_COUNT` cloud puffs. Each is a
 * handful of overlapping soft blobs, wider than tall with a flatter base:
 * R / G = baked normal x / y (signed, +x right, +y up in the cell; z is rebuilt in the shader),
 * B = thickness 0..1, A = soft alpha. Row 0 is the bottom of the texture (a DataTexture is not
 * flipped), so +y in a cell is +v.
 */
export function generatePuffAtlas(cellSize: number, seed: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(cellSize) || cellSize < 8) throw new Error('puff cell size must be >= 8');
  const random = createSeededRandom(seed);
  const atlasSize = cellSize * PUFF_ATLAS_GRID;
  const out = new Uint8Array(atlasSize * atlasSize * 4);
  const thickness = new Float32Array(cellSize * cellSize);
  const smooth = new Float32Array(cellSize * cellSize);
  const scratch = new Float32Array(cellSize * cellSize);
  const blurRadius = Math.max(1, Math.round(cellSize / 12));
  const blobX = new Float32Array(PUFF_MAX_BLOBS);
  const blobY = new Float32Array(PUFF_MAX_BLOBS);
  const blobR = new Float32Array(PUFF_MAX_BLOBS);
  // Slope per cell unit (a cell is 2 units wide), so the look does not depend on the resolution.
  const texel = 2 / cellSize;

  for (let variant = 0; variant < PUFF_VARIANT_COUNT; variant++) {
    const blobCount = PUFF_MIN_BLOBS + Math.floor(random() * (PUFF_MAX_BLOBS - PUFF_MIN_BLOBS + 1));
    for (let b = 0; b < blobCount; b++) {
      // Blobs are laid out in "shape space", where the puff is about twice as wide as tall;
      // the cell stretches shape y by 1 / PUFF_SHAPE_SQUASH so the sprite fills its square.
      // Spread along a flat row; the middle blobs are the big, tall ones.
      const along = b / (blobCount - 1);
      const centre = 1 - Math.abs(along * 2 - 1);
      let x = (along * 2 - 1) * 0.62 + (random() - 0.5) * 0.1;
      let r = 0.14 + centre * 0.12 + random() * 0.05;
      // Bases sit near one line (a flatter underside); the middle blobs may ride higher.
      let y = PUFF_BASE_Y * PUFF_SHAPE_SQUASH + r + centre * random() * 0.12;
      // Keep the whole blob inside the content circle (corner of its box, in cell space).
      const reach = Math.hypot(Math.abs(x) + r, (Math.abs(y) + r) / PUFF_SHAPE_SQUASH);
      if (reach > PUFF_CONTENT_RADIUS) {
        const shrink = PUFF_CONTENT_RADIUS / reach;
        x *= shrink;
        y *= shrink;
        r *= shrink;
      }
      blobX[b] = x;
      blobY[b] = y;
      blobR[b] = r;
    }

    let thickest = 1e-6;
    for (let py = 0; py < cellSize; py++) {
      const cy = (((py + 0.5) / cellSize) * 2 - 1) * PUFF_SHAPE_SQUASH;
      for (let px = 0; px < cellSize; px++) {
        const cx = ((px + 0.5) / cellSize) * 2 - 1;
        let sum = 0;
        for (let b = 0; b < blobCount; b++) {
          const r = blobR[b] ?? 1;
          const dx = cx - (blobX[b] ?? 0);
          const dy = cy - (blobY[b] ?? 0);
          const q = 1 - (dx * dx + dy * dy) / (r * r);
          // (1 - d^2/r^2)^2: zero value AND zero slope at the rim, so edges stay soft.
          if (q > 0) sum += q * q * r;
        }
        thickness[py * cellSize + px] = sum;
        if (sum > thickest) thickest = sum;
      }
    }

    // Normals come from a blurred copy: the raw sum has a ridge wherever two blobs meet, which
    // lights up as stripes. Blurred, the puff shades as a few broad domes.
    smooth.set(thickness);
    for (let pass = 0; pass < PUFF_BLUR_PASSES; pass++) {
      boxBlur(smooth, scratch, cellSize, blurRadius, 1, cellSize);
      boxBlur(scratch, smooth, cellSize, blurRadius, cellSize, 1);
    }

    const cellX = (variant % PUFF_ATLAS_GRID) * cellSize;
    const cellY = Math.floor(variant / PUFF_ATLAS_GRID) * cellSize;
    for (let py = 0; py < cellSize; py++) {
      const up = Math.min(py + 1, cellSize - 1);
      const down = Math.max(py - 1, 0);
      for (let px = 0; px < cellSize; px++) {
        const right = Math.min(px + 1, cellSize - 1);
        const left = Math.max(px - 1, 0);
        const t = (thickness[py * cellSize + px] ?? 0) / thickest;
        const slopeX =
          ((smooth[py * cellSize + right] ?? 0) - (smooth[py * cellSize + left] ?? 0)) /
          (thickest * (right - left) * texel);
        const slopeY =
          ((smooth[up * cellSize + px] ?? 0) - (smooth[down * cellSize + px] ?? 0)) /
          (thickest * (up - down) * texel);
        let nx = -slopeX * PUFF_NORMAL_STRENGTH;
        let ny = -slopeY * PUFF_NORMAL_STRENGTH;
        const invLength = 1 / Math.sqrt(nx * nx + ny * ny + 1);
        nx *= invLength;
        ny *= invLength;
        // Alpha saturates early so the body is solid and only the rim is soft.
        const a = t < 0.3 ? t / 0.3 : 1;
        const alpha = a * a * (3 - 2 * a);

        const o = ((cellY + py) * atlasSize + cellX + px) * 4;
        out[o] = encodeSigned(nx);
        out[o + 1] = encodeSigned(ny);
        out[o + 2] = encodeUnit(t);
        out[o + 3] = encodeUnit(alpha);
      }
    }
  }
  return out;
}
