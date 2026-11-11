/**
 * The sky's generated noise texture: four independent tiling fields in one RGBA8 map.
 * Pure data, load-time only: tested in node.
 *
 *   R  cloud sheets: 5-octave fractal noise (broad shapes with soft detail)
 *   G  billows: fractal inverted-Worley (puffy edges that break the sheets up)
 *   B  slow variation: 2 octaves, used as the skyline of the far cloud banks
 *   A  brush streaks: noise stretched 6:1 along u (long horizontal strokes)
 */
import { createSeededRandom } from '../../shared';
import { addBillowNoise, addValueNoise, normalizeField, unitToByte } from './noise-fields';

export const SKY_NOISE_SIZE = 256;
export const SKY_NOISE_SEED = 0x51c7;

export function generateSkyNoise(
  size: number = SKY_NOISE_SIZE,
  seed: number = SKY_NOISE_SEED,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(size) || size < 16) throw new Error('sky noise size must be >= 16');
  const random = createSeededRandom(seed);
  const sheets = new Float32Array(size * size);
  const billows = new Float32Array(size * size);
  const slow = new Float32Array(size * size);
  const streaks = new Float32Array(size * size);

  let weight = 0.5;
  for (let period = 4; period <= 64 && period * 2 <= size; period *= 2) {
    addValueNoise(sheets, size, period, period, weight, random);
    weight *= 0.52;
  }
  addBillowNoise(billows, size, 5, 0.55, random);
  addBillowNoise(billows, size, 11, 0.3, random);
  addBillowNoise(billows, size, 23, 0.15, random);
  addValueNoise(slow, size, 3, 3, 0.65, random);
  addValueNoise(slow, size, 7, 7, 0.35, random);
  addValueNoise(streaks, size, 3, 18, 0.6, random);
  addValueNoise(streaks, size, 7, 42, 0.4, random);

  normalizeField(sheets);
  normalizeField(billows);
  normalizeField(slow);
  normalizeField(streaks);

  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    out[i * 4] = unitToByte(sheets[i] ?? 0);
    out[i * 4 + 1] = unitToByte(billows[i] ?? 0);
    out[i * 4 + 2] = unitToByte(slow[i] ?? 0);
    out[i * 4 + 3] = unitToByte(streaks[i] ?? 0);
  }
  return out;
}
