/**
 * The voice pool's bookkeeping and its stealing policy (T-3.8), with no WebAudio in it: the
 * engine owns the nodes, this decides which slot a sound gets. Fixed typed arrays, no
 * allocation after construction.
 *
 * Policy, in order, when a sound asks for a voice:
 * 1. Retrigger: the same sound started less than its `minRetriggerS` ago -> refused.
 * 2. Instance cap: the sound already plays `maxInstances` times -> it replaces its own furthest
 *    instance (oldest on a tie), unless the new one would be further away than all of them.
 * 3. A free voice inside the current capacity -> taken.
 * 4. Steal: the victim is the playing voice with the lowest priority, then the oldest (ages
 *    compared in AGE_BUCKET_S steps, so "about as old" counts as a tie), then the furthest. It
 *    is taken only if its priority is not higher than the new sound's.
 */

/** Hard ceiling of the pool: the High preset's voice count. */
export const MAX_VOICES = 32;
/** Voices started within this long of each other count as the same age when stealing. */
export const AGE_BUCKET_S = 0.25;
/** `request` result: no voice. */
export const NO_VOICE = -1;

export class VoiceAllocator {
  /** Voices in use are indices `< capacity`; lowering it leaves higher ones to be released. */
  capacity: number;
  /** Sounds that took a playing voice from another sound (or from themselves at their cap). */
  stolen = 0;
  /** Requests turned down (retrigger, cap, or nothing stealable). */
  refused = 0;
  /** True when the last successful `request` took a voice that was still playing. */
  wasStolen = false;

  readonly active: Uint8Array;
  /** Sound index playing on each voice. */
  readonly sound: Int16Array;
  readonly priority: Int16Array;
  readonly startS: Float64Array;
  /** Metres from the listener; the engine keeps it fresh for positional voices. */
  readonly distance: Float32Array;
  /** Bumped whenever a voice changes hands, so a stale handle can be recognised. */
  readonly generation: Uint32Array;

  private readonly lastStartS: Float64Array;
  private readonly instances: Uint8Array;
  private activeCount = 0;

  constructor(soundCount: number, capacity: number = MAX_VOICES) {
    this.capacity = clampCapacity(capacity);
    this.active = new Uint8Array(MAX_VOICES);
    this.sound = new Int16Array(MAX_VOICES).fill(-1);
    this.priority = new Int16Array(MAX_VOICES);
    this.startS = new Float64Array(MAX_VOICES);
    this.distance = new Float32Array(MAX_VOICES);
    this.generation = new Uint32Array(MAX_VOICES);
    this.lastStartS = new Float64Array(soundCount).fill(-Infinity);
    this.instances = new Uint8Array(soundCount);
  }

  get activeVoices(): number {
    return this.activeCount;
  }

  instancesOf(soundIndex: number): number {
    return this.instances[soundIndex] ?? 0;
  }

  setCapacity(capacity: number): void {
    this.capacity = clampCapacity(capacity);
  }

  /**
   * Picks a voice for the sound, or NO_VOICE. When `wasStolen` is set afterwards the voice was
   * playing something else, which the caller must stop.
   */
  request(
    soundIndex: number,
    priority: number,
    distance: number,
    nowS: number,
    maxInstances: number,
    minRetriggerS: number,
  ): number {
    this.wasStolen = false;
    if (nowS - (this.lastStartS[soundIndex] ?? -Infinity) < minRetriggerS) {
      this.refused++;
      return NO_VOICE;
    }
    let voice = NO_VOICE;
    if ((this.instances[soundIndex] ?? 0) >= maxInstances) {
      voice = this.weakestInstance(soundIndex);
      if (voice === NO_VOICE || distance > (this.distance[voice] ?? 0)) {
        this.refused++;
        return NO_VOICE;
      }
    } else {
      for (let i = 0; i < this.capacity; i++) {
        if (this.active[i] === 0) {
          voice = i;
          break;
        }
      }
      if (voice === NO_VOICE) {
        voice = this.victim();
        if (voice === NO_VOICE || (this.priority[voice] ?? 0) > priority) {
          this.refused++;
          return NO_VOICE;
        }
      }
    }
    if (this.active[voice] === 1) {
      this.wasStolen = true;
      this.stolen++;
      this.release(voice);
    }
    this.active[voice] = 1;
    this.sound[voice] = soundIndex;
    this.priority[voice] = priority;
    this.startS[voice] = nowS;
    this.distance[voice] = distance;
    this.generation[voice] = ((this.generation[voice] ?? 0) + 1) >>> 0;
    this.instances[soundIndex] = (this.instances[soundIndex] ?? 0) + 1;
    this.lastStartS[soundIndex] = nowS;
    this.activeCount++;
    return voice;
  }

  /** Frees a voice (its sound ended or was stopped). Safe to call on a free voice. */
  release(voice: number): void {
    if (this.active[voice] !== 1) return;
    this.active[voice] = 0;
    const soundIndex = this.sound[voice] ?? -1;
    if (soundIndex >= 0) {
      const count = this.instances[soundIndex] ?? 0;
      this.instances[soundIndex] = count > 0 ? count - 1 : 0;
    }
    this.sound[voice] = -1;
    this.generation[voice] = ((this.generation[voice] ?? 0) + 1) >>> 0;
    this.activeCount--;
  }

  /** Forgets everything that is playing and every retrigger timer (scene change, new context). */
  reset(): void {
    for (let i = 0; i < MAX_VOICES; i++) this.release(i);
    this.lastStartS.fill(-Infinity);
  }

  /** The instance of a sound to replace at its cap: furthest, then oldest. */
  private weakestInstance(soundIndex: number): number {
    let best = NO_VOICE;
    let bestDistance = -1;
    let bestStart = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i] !== 1 || this.sound[i] !== soundIndex) continue;
      const distance = this.distance[i] ?? 0;
      const start = this.startS[i] ?? 0;
      if (distance > bestDistance || (distance === bestDistance && start < bestStart)) {
        best = i;
        bestDistance = distance;
        bestStart = start;
      }
    }
    return best;
  }

  /** The voice to steal: lowest priority, then oldest (bucketed), then furthest, then oldest. */
  private victim(): number {
    let best = NO_VOICE;
    let bestPriority = Infinity;
    let bestBucket = Infinity;
    let bestDistance = -1;
    let bestStart = Infinity;
    for (let i = 0; i < this.capacity; i++) {
      if (this.active[i] !== 1) continue;
      const priority = this.priority[i] ?? 0;
      const start = this.startS[i] ?? 0;
      const bucket = Math.floor(start / AGE_BUCKET_S);
      const distance = this.distance[i] ?? 0;
      let better = false;
      if (priority !== bestPriority) better = priority < bestPriority;
      else if (bucket !== bestBucket) better = bucket < bestBucket;
      else if (distance !== bestDistance) better = distance > bestDistance;
      else better = start < bestStart;
      if (better) {
        best = i;
        bestPriority = priority;
        bestBucket = bucket;
        bestDistance = distance;
        bestStart = start;
      }
    }
    return best;
  }
}

function clampCapacity(capacity: number): number {
  const whole = Math.floor(capacity);
  return whole < 1 ? 1 : whole > MAX_VOICES ? MAX_VOICES : whole;
}
