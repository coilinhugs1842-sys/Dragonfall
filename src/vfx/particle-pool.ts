/**
 * The particle store: one fixed Float32Array used as a ring buffer. A particle is written ONCE,
 * when it spawns; the vertex shader moves, grows, fades and finally hides it from
 * `time - birth`, so the CPU never touches it again. The view uploads only the slots written
 * since the last frame (`dirtyRange*`).
 *
 * Pure (no three.js): the view wraps `data` in an InstancedInterleavedBuffer.
 *
 * At the cap the ring overwrites the OLDEST slot, which is the particle closest to its end.
 * Before it comes to that, emitters thin themselves out from `pressure` (see spawn-scale.ts).
 */

/** Floats per particle: seven vec4 instance attributes. */
export const PARTICLE_STRIDE = 28;

// aPosBirth
export const P_X = 0;
export const P_Y = 1;
export const P_Z = 2;
export const P_BIRTH = 3;
// aVelLife
export const P_VX = 4;
export const P_VY = 5;
export const P_VZ = 6;
export const P_LIFE = 7;
// aSize
export const P_SIZE_START = 8;
export const P_SIZE_END = 9;
export const P_ROTATION = 10;
export const P_SPIN = 11;
// aPhys
export const P_DRAG = 12;
export const P_GRAVITY = 13;
export const P_TURBULENCE = 14;
export const P_STRETCH = 15;
// aColorA
export const P_R0 = 16;
export const P_G0 = 17;
export const P_B0 = 18;
/**
 * Blend: `round(opacity * 100) + additive * 0.99`. The integer part is the opacity in percent,
 * the fraction how additive the sprite is (see `packBlend`).
 */
export const P_BLEND = 19;
// aColorB
export const P_R1 = 20;
export const P_G1 = 21;
export const P_B1 = 22;
/** Integer part: atlas sprite. Fraction: a per-particle random seed. */
export const P_SPRITE_SEED = 23;
// aFade
export const P_FADE_IN = 24;
export const P_FADE_OUT = 25;
export const P_ANCHOR = 26;
export const P_ASPECT = 27;

export class ParticlePool {
  /** `maxCapacity * PARTICLE_STRIDE` floats. Slots at or beyond `capacity` are never drawn. */
  readonly data: Float32Array;
  readonly maxCapacity: number;
  private readonly deathTime: Float32Array;
  private cap: number;
  private cursor = 0;
  private dirtyFirst = 0;
  private dirtyCount = 0;
  private aliveCount = 0;
  private now = 0;

  constructor(maxCapacity: number, capacity: number = maxCapacity) {
    this.maxCapacity = Math.max(1, Math.floor(maxCapacity));
    this.data = new Float32Array(this.maxCapacity * PARTICLE_STRIDE);
    this.deathTime = new Float32Array(this.maxCapacity);
    this.cap = Math.max(1, Math.min(this.maxCapacity, Math.floor(capacity)));
  }

  /** The hard cap: never more particles than this exist. */
  get capacity(): number {
    return this.cap;
  }

  /** Particles alive as of the last `beginFrame`, plus those spawned since. */
  get alive(): number {
    return this.aliveCount;
  }

  /** 0..1: how full the pool is. Emitters spawn less as it rises. */
  get pressure(): number {
    return this.aliveCount / this.cap;
  }

  /**
   * Changes the cap (quality preset). Every particle is dropped: effects are short, and a
   * preset change is a menu action, not a gameplay moment.
   */
  setCapacity(capacity: number): void {
    this.cap = Math.max(1, Math.min(this.maxCapacity, Math.floor(capacity)));
    this.clear();
  }

  /** Kills every particle and marks the whole buffer for upload. */
  clear(): void {
    const data = this.data;
    for (let i = 0; i < this.maxCapacity; i++) {
      data[i * PARTICLE_STRIDE + P_LIFE] = 0;
      this.deathTime[i] = -Infinity;
    }
    this.cursor = 0;
    this.aliveCount = 0;
    this.dirtyFirst = 0;
    this.dirtyCount = this.cap;
  }

  /** Once per frame, before spawning: recounts the living for `alive` and `pressure`. */
  beginFrame(time: number): void {
    this.now = time;
    const deaths = this.deathTime;
    let alive = 0;
    for (let i = 0; i < this.cap; i++) {
      if ((deaths[i] ?? 0) > time) alive++;
    }
    this.aliveCount = alive;
  }

  /**
   * Takes the next slot of the ring and returns its float offset into `data`. The caller must
   * write all PARTICLE_STRIDE floats. `birth + life` is when the particle ends.
   */
  allocate(birth: number, life: number): number {
    const index = this.cursor;
    this.cursor = index + 1 >= this.cap ? 0 : index + 1;
    if (this.dirtyCount === 0) this.dirtyFirst = index;
    if (this.dirtyCount < this.cap) this.dirtyCount++;
    if (!((this.deathTime[index] ?? 0) > this.now)) this.aliveCount++;
    this.deathTime[index] = birth + life;
    return index * PARTICLE_STRIDE;
  }

  /** 0, 1 or 2 runs of slots were written since `clearDirty` (2 when the ring wrapped). */
  get dirtyRangeCount(): number {
    if (this.dirtyCount === 0) return 0;
    if (this.dirtyCount >= this.cap) return 1;
    return this.dirtyFirst + this.dirtyCount > this.cap ? 2 : 1;
  }

  /** First slot of run `i`. */
  dirtyRangeStart(i: number): number {
    if (this.dirtyCount >= this.cap) return 0;
    return i === 0 ? this.dirtyFirst : 0;
  }

  /** Slots in run `i`. */
  dirtyRangeLength(i: number): number {
    if (this.dirtyCount >= this.cap) return i === 0 ? this.cap : 0;
    const toEnd = this.cap - this.dirtyFirst;
    if (this.dirtyCount <= toEnd) return i === 0 ? this.dirtyCount : 0;
    return i === 0 ? toEnd : this.dirtyCount - toEnd;
  }

  clearDirty(): void {
    this.dirtyCount = 0;
  }
}

/** Packs a particle's opacity (0..1) and additive factor (0..1) into the P_BLEND float. */
export function packBlend(opacity: number, additive: number): number {
  const o = opacity < 0 ? 0 : opacity > 1 ? 1 : opacity;
  const a = additive < 0 ? 0 : additive > 1 ? 1 : additive;
  return Math.round(o * 100) + a * 0.99;
}
