/**
 * The sound library (T-3.8): every sound the game can play, as one data table. Each entry has
 * its mix numbers (gain, priority, instance cap, retrigger gap, audible range) and, for now, a
 * procedural generator that renders a placeholder once at init. Phase 4 puts a real `.ogg` in
 * `url`; the engine then decodes that instead and nothing else changes.
 *
 * Generators are pure and deterministic (`renderSound` seeds each from its index). They write
 * layers into a zeroed buffer; `renderSound` then trims clicks, loops and normalises.
 */

import {
  Rng,
  addCrackle,
  addNoise,
  addTail,
  addTone,
  crossfadeLoop,
  fadeEdges,
  normalise,
  removeDc,
  tremolo,
  wobble,
} from './dsp';

/**
 * Placeholders are rendered at this rate whatever the device runs at (WebAudio resamples on
 * playback): half the samples of 48 kHz to generate and keep, and nothing here needs air above
 * 12 kHz.
 */
export const RENDER_SAMPLE_RATE = 24_000;
/** Every rendered buffer peaks here: -6 dBFS. Loudness between sounds is `SoundDef.gain`. */
export const RENDER_PEAK = 0.5;
/** Extra material rendered past a loop's end and cross-faded over its start. */
export const LOOP_OVERLAP_S = 0.25;

export const SOUND_BUSES = ['sfx', 'ui', 'ambience'] as const;
export type SoundBus = (typeof SOUND_BUSES)[number];

/** Who wins a voice when the pool is full (higher wins; equal may steal the oldest). */
export const PRIORITY_DETAIL = 0;
export const PRIORITY_COMBAT = 1;
export const PRIORITY_MAJOR = 2;
export const PRIORITY_LOCAL = 3;
export const PRIORITY_CRITICAL = 4;

export type SoundGenerator = (out: Float32Array, sampleRate: number, rng: Rng) => void;

export interface SoundDef {
  /** Length of the buffer (of one loop for `loop` sounds). */
  readonly durationS: number;
  readonly loop: boolean;
  readonly bus: SoundBus;
  /** Linear gain on top of the normalised buffer. */
  gain: number;
  priority: number;
  /** Most copies playing at once; one more replaces the furthest. */
  maxInstances: number;
  /** A copy started sooner than this after the last one is dropped. */
  minRetriggerS: number;
  /** Full volume within this many metres; silent (and not started) beyond `maxDistanceM`. */
  refDistanceM: number;
  maxDistanceM: number;
  /** Each play is repitched by up to this fraction either way, so repeats do not machine-gun. */
  pitchJitter: number;
  /** Phase 4: the real asset. null = use the procedural placeholder. */
  readonly url: string | null;
  readonly generate: SoundGenerator;
}

function sound(
  durationS: number,
  generate: SoundGenerator,
  values: Partial<Omit<SoundDef, 'durationS' | 'generate'>> = {},
): SoundDef {
  return {
    durationS,
    loop: false,
    bus: 'sfx',
    gain: 0.8,
    priority: PRIORITY_COMBAT,
    maxInstances: 3,
    minRetriggerS: 0.05,
    refDistanceM: 30,
    maxDistanceM: 700,
    pitchJitter: 0.06,
    url: null,
    generate,
    ...values,
  };
}

/** A soft struck-glass note: the interface and reward sounds are built from these. */
function bell(
  out: Float32Array,
  sampleRate: number,
  startS: number,
  frequency: number,
  durS: number,
  gain = 0.6,
): void {
  addTone(out, sampleRate, startS, durS, gain, frequency, frequency, 0.004, 4, 3.5, 1.2, 0);
  const upper = frequency * 2;
  addTone(out, sampleRate, startS, durS * 0.6, gain * 0.3, upper, upper, 0.004, 5);
}

/** Past any buffer's end: "until the end" for the layers of a loop. */
const ALL = 99;

const UI_VALUES = {
  bus: 'ui',
  priority: PRIORITY_LOCAL,
  maxInstances: 2,
  pitchJitter: 0,
} as const;

/** Big, rare, far-carrying. */
const MAJOR_VALUES = {
  priority: PRIORITY_MAJOR,
  maxInstances: 2,
  refDistanceM: 60,
  maxDistanceM: 1200,
  minRetriggerS: 0.1,
} as const;

export const SOUND_DEFS = {
  // --- Talon -----------------------------------------------------------------------------------
  fireBolt: sound(
    0.24,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.22, 0.9, 'bp', 2600, 500, 1.2, 0.004, 4);
      addTone(o, sr, 0, 0.16, 0.5, 620, 170, 0.003, 4);
    },
    // Ten Talons holding fire make ~60 of these a second: a tight cap and gap keep the pool free.
    { gain: 0.55, maxInstances: 4, minRetriggerS: 0.06, pitchJitter: 0.1 },
  ),
  dashWhoosh: sound(0.5, (o, sr, r) => {
    addNoise(o, sr, r, 0, 0.25, 0.8, 'bp', 400, 2600, 1.4, 0.2, 0);
    addNoise(o, sr, r, 0.2, 0.3, 0.8, 'bp', 2600, 500, 1.4, 0.05, 2);
  }),
  afterburn: sound(0.85, (o, sr, r) => {
    addNoise(o, sr, r, 0, 0.85, 1, 'lp', 180, 1100, 0.8, 0.1, 2.5);
    addTone(o, sr, 0, 0.7, 0.6, 60, 120, 0.05, 2.5, 0.5, 1.5, 0.5);
    addCrackle(o, sr, r, 0.05, 0.6, 0.3, 40, 0.003, 4000);
  }),
  meteorDrop: sound(
    0.6,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.6, 0.7, 1500, 420, 0.03, 1.5, 0.008, 2, 4);
      addNoise(o, sr, r, 0, 0.6, 0.35, 'bp', 2500, 800, 2, 0.05, 1.5);
    },
    { priority: PRIORITY_MAJOR, minRetriggerS: 0.1, gain: 0.6 },
  ),

  // --- Bastion ---------------------------------------------------------------------------------
  flameStart: sound(0.5, (o, sr, r) => {
    addNoise(o, sr, r, 0, 0.5, 1, 'lp', 300, 1600, 0.7, 0.12, 2.5);
    addNoise(o, sr, r, 0, 0.4, 0.4, 'bp', 900, 2400, 0.8, 0.08, 3);
  }),
  flameLoop: sound(
    1.6,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, ALL, 1, 'lp', 650, 650, 0.6, 0.01, -1);
      addNoise(o, sr, r, 0, ALL, 0.5, 'bp', 1500, 1500, 0.8, 0.01, -1);
      wobble(o, sr, r, 9, 0.45);
      addCrackle(o, sr, r, 0, ALL, 0.35, 14, 0.004, 3500);
    },
    { loop: true, gain: 0.6, maxInstances: 3, minRetriggerS: 0, pitchJitter: 0.04 },
  ),
  shieldUp: sound(0.65, (o, sr, r) => {
    addTone(o, sr, 0, 0.65, 0.6, 330, 332, 0.12, 2.5, 1.41, 1.2, 0.3);
    addTone(o, sr, 0.05, 0.6, 0.45, 495, 497, 0.15, 2.5, 2, 0.8, 0.2);
    addNoise(o, sr, r, 0, 0.3, 0.25, 'bp', 1800, 3500, 2, 0.1, 2);
  }),
  healShimmer: sound(1.1, (o, sr, r) => {
    addTone(o, sr, 0, 0.7, 0.4, 880, 880, 0.04, 3, 2, 0.4, 0);
    addTone(o, sr, 0.09, 0.7, 0.4, 1108.7, 1108.7, 0.04, 3, 2, 0.4, 0);
    addTone(o, sr, 0.18, 0.7, 0.4, 1318.5, 1318.5, 0.04, 3, 2, 0.4, 0);
    addTone(o, sr, 0.27, 0.7, 0.4, 1760, 1760, 0.04, 3, 2, 0.4, 0);
    addNoise(o, sr, r, 0, 0.9, 0.12, 'bp', 5000, 7000, 2, 0.3, 1);
    addTail(o, sr, 0.3, 0.8);
  }),
  bulwarkWave: sound(
    1.2,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.9, 1, 95, 38, 0.01, 3, 0.5, 2, 0);
      addNoise(o, sr, r, 0, 1, 0.8, 'lp', 1800, 140, 0.8, 0.02, 3);
      addNoise(o, sr, r, 0, 0.5, 0.3, 'bp', 500, 1500, 1, 0.2, 1);
      addTail(o, sr, 0.25, 0.9);
    },
    { ...MAJOR_VALUES, gain: 1 },
  ),

  // --- Tempest ---------------------------------------------------------------------------------
  lightningCharge: sound(
    0.55,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.55, 0.6, 170, 880, 0.5, 0, 2.01, 0.5, 4);
      addNoise(o, sr, r, 0, 0.55, 0.5, 'hp', 2000, 5000, 0.7, 0.45, 0);
      addCrackle(o, sr, r, 0, 0.55, 0.5, 60, 0.002, 6000);
    },
    { gain: 0.5, minRetriggerS: 0.15 },
  ),
  lightningCrack: sound(
    0.55,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.09, 1, 'hp', 2500, 1500, 0.7, 0.001, 3);
      addTone(o, sr, 0, 0.3, 0.7, 2600, 140, 0.001, 5, 0.5, 6, 0);
      addNoise(o, sr, r, 0.02, 0.5, 0.6, 'lp', 1800, 200, 0.7, 0.005, 4);
      addTail(o, sr, 0.25, 0.5);
    },
    { refDistanceM: 45, maxDistanceM: 900, minRetriggerS: 0.1 },
  ),
  mineLaunch: sound(0.3, (o, sr, r) => {
    addTone(o, sr, 0, 0.25, 0.8, 320, 110, 0.004, 4);
    addNoise(o, sr, r, 0, 0.08, 0.5, 'bp', 1500, 900, 1.5, 0.002, 3);
    addTone(o, sr, 0.02, 0.25, 0.25, 900, 1300, 0.02, 3, 3, 2, 0);
  }),
  mineArm: sound(0.65, (o, sr, r) => {
    addTone(o, sr, 0, 0.6, 0.6, 210, 190, 0.01, 2, 0.25, 5, 1);
    addCrackle(o, sr, r, 0, 0.6, 0.7, 90, 0.002, 5000);
    tremolo(o, sr, 28, 0.5);
    addTone(o, sr, 0, 0.12, 0.5, 1800, 400, 0.001, 4, 0.5, 4, 0);
  }),
  updraft: sound(0.75, (o, sr, r) => {
    addNoise(o, sr, r, 0, 0.75, 1, 'bp', 260, 2400, 1.3, 0.5, 1);
    addNoise(o, sr, r, 0, 0.75, 0.5, 'lp', 200, 900, 0.7, 0.4, 1);
  }),
  thunder: sound(
    1.9,
    (o, sr, r) => {
      addNoise(o, sr, r, 0.03, 1.85, 1, 'lp', 260, 70, 0.8, 0.03, 3);
      addTone(o, sr, 0.02, 1.2, 0.5, 70, 35, 0.02, 3);
      wobble(o, sr, r, 11, 0.7);
      addNoise(o, sr, r, 0, 0.12, 0.9, 'hp', 1500, 800, 0.7, 0.002, 3);
      addTail(o, sr, 0.3, 1.2);
    },
    { ...MAJOR_VALUES, gain: 1 },
  ),

  // --- Wraith ----------------------------------------------------------------------------------
  shadeHiss: sound(0.55, (o, sr, r) => {
    addNoise(o, sr, r, 0, 0.55, 0.9, 'bp', 5200, 2600, 1.5, 0.06, 2.5);
    addTone(o, sr, 0, 0.5, 0.35, 95, 70, 0.05, 2);
  }),
  shadeLoop: sound(
    1.8,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, ALL, 1, 'bp', 3200, 3200, 1.2, 0.01, -1);
      addNoise(o, sr, r, 0, ALL, 0.5, 'lp', 300, 300, 0.7, 0.01, -1);
      addTone(o, sr, 0, ALL, 0.25, 72, 72, 0.01, -1, 1.5, 0.8, 0.8);
      wobble(o, sr, r, 5, 0.4);
    },
    { loop: true, gain: 0.5, maxInstances: 3, minRetriggerS: 0, pitchJitter: 0.04 },
  ),
  veil: sound(
    0.75,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.75, 0.4, 440, 660, 0.55, 0, 1.5, 0.3, 1.5);
      addTone(o, sr, 0, 0.75, 0.3, 662, 990, 0.6, 0);
      addNoise(o, sr, r, 0, 0.75, 0.6, 'bp', 6000, 1500, 1.2, 0.5, 0);
    },
    { gain: 0.5, maxDistanceM: 350 },
  ),
  phaseDive: sound(0.6, (o, sr, r) => {
    addTone(o, sr, 0, 0.6, 0.7, 520, 110, 0.02, 2.5, 0.07, 3, 6);
    addNoise(o, sr, r, 0, 0.6, 0.6, 'bp', 1800, 300, 4, 0.03, 2.5);
  }),
  nightTerror: sound(
    1.5,
    (o, sr, r) => {
      addTone(o, sr, 0, 1.5, 0.5, 55, 52, 0.5, 1, 1, 1, 3);
      addTone(o, sr, 0, 1.5, 0.4, 77.8, 73, 0.6, 1, 2, 0.5, 2.5);
      addNoise(o, sr, r, 0, 1.5, 0.7, 'lp', 120, 1400, 1.2, 0.9, 0);
      addNoise(o, sr, r, 0.8, 0.7, 0.4, 'bp', 3000, 600, 2, 0.2, 2);
      addTail(o, sr, 0.3, 1);
    },
    { ...MAJOR_VALUES, gain: 0.95 },
  ),

  // --- Shared combat ---------------------------------------------------------------------------
  windup: sound(
    0.25,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.25, 0.5, 300, 560, 0.15, 0);
      addNoise(o, sr, r, 0, 0.25, 0.3, 'bp', 1200, 2600, 1.5, 0.18, 0);
    },
    { gain: 0.4, maxDistanceM: 400 },
  ),
  hitFlesh: sound(
    0.2,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.18, 1, 170, 55, 0.002, 5);
      addNoise(o, sr, r, 0, 0.06, 0.6, 'lp', 1400, 400, 0.7, 0.001, 4);
    },
    { gain: 0.7, maxInstances: 4, minRetriggerS: 0.06, pitchJitter: 0.12 },
  ),
  hitShield: sound(
    0.32,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.32, 0.8, 720, 700, 0.001, 5, 2.76, 3, 0.3);
      addTone(o, sr, 0, 0.2, 0.4, 1480, 1460, 0.001, 6, 1.4, 1.5, 0);
      addNoise(o, sr, r, 0, 0.03, 0.5, 'hp', 3000, 3000, 0.7, 0.001, 2);
    },
    { gain: 0.6, minRetriggerS: 0.08, pitchJitter: 0.08 },
  ),
  hitRock: sound(
    0.32,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.12, 1, 'bp', 1100, 500, 0.9, 0.001, 4);
      addTone(o, sr, 0, 0.25, 0.7, 120, 45, 0.002, 4);
      addCrackle(o, sr, r, 0.03, 0.28, 0.5, 120, 0.004, 2500);
    },
    { minRetriggerS: 0.15, pitchJitter: 0.1 },
  ),
  stormZap: sound(
    0.28,
    (o, sr, r) => {
      addCrackle(o, sr, r, 0, 0.28, 1, 220, 0.0015, 6000);
      addTone(o, sr, 0, 0.2, 0.4, 140, 90, 0.003, 3, 3.5, 5, 1);
    },
    { gain: 0.6, minRetriggerS: 0.2, pitchJitter: 0.1 },
  ),
  slowZap: sound(
    0.42,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.42, 0.8, 640, 140, 0.005, 2.5, 0.5, 4, 0.5);
      addNoise(o, sr, r, 0, 0.2, 0.3, 'bp', 2500, 800, 2, 0.01, 3);
    },
    { gain: 0.55, minRetriggerS: 0.15 },
  ),
  burnIgnite: sound(
    0.36,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.36, 0.8, 'bp', 700, 2400, 0.9, 0.05, 3);
      addCrackle(o, sr, r, 0, 0.36, 0.6, 70, 0.003, 4500);
    },
    { gain: 0.5, minRetriggerS: 0.15 },
  ),
  blindSwell: sound(
    0.85,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.85, 0.8, 'lp', 200, 1600, 1, 0.6, 0.5);
      addTone(o, sr, 0, 0.85, 0.5, 420, 95, 0.3, 1, 1, 0, 3);
    },
    { gain: 0.6, minRetriggerS: 0.15 },
  ),
  blast: sound(
    0.95,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.7, 1, 130, 34, 0.002, 4);
      addNoise(o, sr, r, 0, 0.8, 0.9, 'lp', 2600, 180, 0.7, 0.003, 4);
      addCrackle(o, sr, r, 0.05, 0.6, 0.3, 60, 0.006, 2000);
      addTail(o, sr, 0.3, 0.8);
    },
    { ...MAJOR_VALUES, maxInstances: 3, gain: 0.95, pitchJitter: 0.1 },
  ),
  takedownBoom: sound(
    1.4,
    (o, sr, r) => {
      addTone(o, sr, 0, 1, 1, 110, 30, 0.003, 3.5, 0.5, 3, 0);
      addNoise(o, sr, r, 0, 1.1, 0.8, 'lp', 3000, 150, 0.7, 0.004, 4);
      addTone(o, sr, 0.05, 1, 0.3, 392, 196, 0.02, 3, 1.5, 1.5, 0);
      addTail(o, sr, 0.35, 1.2);
    },
    { ...MAJOR_VALUES, gain: 1 },
  ),
  spawnChime: sound(
    0.95,
    (o, sr, r) => {
      bell(o, sr, 0, 523.25, 0.6);
      bell(o, sr, 0.1, 784, 0.6);
      bell(o, sr, 0.2, 1046.5, 0.7);
      addNoise(o, sr, r, 0, 0.5, 0.15, 'bp', 3000, 6000, 2, 0.2, 1);
      addTail(o, sr, 0.3, 0.8);
    },
    // A match start spawns ten dragons in one tick.
    { gain: 0.45, maxInstances: 2, minRetriggerS: 0.12, maxDistanceM: 500, pitchJitter: 0.02 },
  ),
  flap: sound(
    0.32,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, 0.32, 1, 'bp', 320, 110, 0.8, 0.09, 2.5);
      addNoise(o, sr, r, 0.02, 0.2, 0.3, 'lp', 900, 300, 0.7, 0.06, 2);
    },
    {
      gain: 0.4,
      priority: PRIORITY_DETAIL,
      maxInstances: 3,
      minRetriggerS: 0.08,
      refDistanceM: 14,
      maxDistanceM: 160,
      pitchJitter: 0.12,
    },
  ),

  // --- Local feedback (never positional) ---------------------------------------------------------
  hitConfirm: sound(
    0.07,
    (o, sr) => {
      addTone(o, sr, 0, 0.07, 0.8, 1700, 1500, 0.002, 3);
    },
    { ...UI_VALUES, gain: 0.3, minRetriggerS: 0.07, pitchJitter: 0.03 },
  ),
  takedownConfirm: sound(
    0.55,
    (o, sr) => {
      bell(o, sr, 0, 392, 0.5);
      bell(o, sr, 0.11, 587.3, 0.44);
    },
    { ...UI_VALUES, gain: 0.55 },
  ),
  assist: sound(
    0.4,
    (o, sr) => {
      bell(o, sr, 0, 660, 0.4);
    },
    { ...UI_VALUES, gain: 0.4 },
  ),
  objective: sound(
    0.5,
    (o, sr) => {
      bell(o, sr, 0, 587.3, 0.35);
      bell(o, sr, 0.12, 880, 0.38);
    },
    { ...UI_VALUES, gain: 0.5, minRetriggerS: 0.2 },
  ),
  heartbeat: sound(
    0.45,
    (o, sr) => {
      addTone(o, sr, 0, 0.16, 1, 68, 42, 0.004, 4);
      addTone(o, sr, 0.17, 0.2, 0.75, 60, 38, 0.004, 4);
    },
    { ...UI_VALUES, gain: 0.7, maxInstances: 1, minRetriggerS: 0.3 },
  ),

  // --- Own-flight loops ------------------------------------------------------------------------
  windLoop: sound(
    3,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, ALL, 1, 'bp', 420, 420, 0.5, 0.01, -1);
      addNoise(o, sr, r, 0, ALL, 0.35, 'bp', 1300, 1300, 0.7, 0.01, -1);
      wobble(o, sr, r, 1.3, 0.45);
    },
    {
      loop: true,
      bus: 'ambience',
      gain: 0.4,
      priority: PRIORITY_CRITICAL,
      maxInstances: 1,
      minRetriggerS: 0,
      pitchJitter: 0,
    },
  ),
  boostLoop: sound(
    1.5,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, ALL, 1, 'lp', 260, 260, 0.9, 0.01, -1);
      addTone(o, sr, 0, ALL, 0.5, 58, 58, 0.01, -1, 0.5, 1.2, 1.2);
      addNoise(o, sr, r, 0, ALL, 0.25, 'bp', 1900, 1900, 0.8, 0.01, -1);
      wobble(o, sr, r, 13, 0.35);
    },
    {
      loop: true,
      gain: 0.5,
      priority: PRIORITY_LOCAL,
      maxInstances: 1,
      minRetriggerS: 0,
      pitchJitter: 0,
    },
  ),
  stormLoop: sound(
    2.6,
    (o, sr, r) => {
      addNoise(o, sr, r, 0, ALL, 1, 'lp', 150, 150, 0.8, 0.01, -1);
      wobble(o, sr, r, 3, 0.5);
      addCrackle(o, sr, r, 0, ALL, 0.9, 22, 0.004, 5000);
    },
    {
      loop: true,
      bus: 'ambience',
      gain: 0.7,
      priority: PRIORITY_LOCAL,
      maxInstances: 1,
      minRetriggerS: 0,
      pitchJitter: 0,
    },
  ),

  // --- Match flow --------------------------------------------------------------------------------
  countdownTick: sound(
    0.14,
    (o, sr) => {
      addTone(o, sr, 0, 0.14, 0.8, 660, 655, 0.003, 4, 2, 0.5, 0);
    },
    { ...UI_VALUES, gain: 0.5, priority: PRIORITY_CRITICAL, minRetriggerS: 0.3 },
  ),
  countdownGo: sound(
    0.65,
    (o, sr) => {
      bell(o, sr, 0, 440, 0.6);
      bell(o, sr, 0, 660, 0.6);
      bell(o, sr, 0, 880, 0.65);
      addTail(o, sr, 0.25, 0.6);
    },
    { ...UI_VALUES, gain: 0.6, priority: PRIORITY_CRITICAL, minRetriggerS: 0.5 },
  ),
  roundEnd: sound(
    1,
    (o, sr) => {
      bell(o, sr, 0, 392, 0.6);
      bell(o, sr, 0.18, 523.25, 0.8);
      addTail(o, sr, 0.3, 0.8);
    },
    { ...UI_VALUES, gain: 0.6, priority: PRIORITY_CRITICAL, minRetriggerS: 1 },
  ),
  victory: sound(
    2,
    (o, sr) => {
      bell(o, sr, 0, 523.25, 1.2);
      bell(o, sr, 0.16, 659.25, 1.2);
      bell(o, sr, 0.32, 784, 1.2);
      bell(o, sr, 0.5, 1046.5, 1.4, 0.7);
      addTone(o, sr, 0.5, 1.5, 0.25, 261.6, 261.6, 0.2, 2);
      addTail(o, sr, 0.35, 1.4);
    },
    { ...UI_VALUES, gain: 0.7, priority: PRIORITY_CRITICAL, minRetriggerS: 2 },
  ),
  defeat: sound(
    2,
    (o, sr) => {
      bell(o, sr, 0, 440, 1.1);
      bell(o, sr, 0.22, 349.2, 1.1);
      bell(o, sr, 0.44, 293.7, 1.1);
      bell(o, sr, 0.7, 220, 1.3, 0.7);
      addTone(o, sr, 0.7, 1.3, 0.3, 110, 104, 0.2, 2);
      addTail(o, sr, 0.35, 1.4);
    },
    { ...UI_VALUES, gain: 0.7, priority: PRIORITY_CRITICAL, minRetriggerS: 2 },
  ),

  // --- Interface -------------------------------------------------------------------------------
  uiHover: sound(
    0.05,
    (o, sr) => {
      addTone(o, sr, 0, 0.05, 0.6, 1250, 1150, 0.004, 3);
    },
    { ...UI_VALUES, gain: 0.15, minRetriggerS: 0.04 },
  ),
  uiClick: sound(
    0.09,
    (o, sr, r) => {
      addTone(o, sr, 0, 0.09, 0.8, 760, 480, 0.002, 4);
      addNoise(o, sr, r, 0, 0.012, 0.3, 'hp', 3000, 3000, 0.7, 0.001, 2);
    },
    { ...UI_VALUES, gain: 0.35, minRetriggerS: 0.03 },
  ),
  uiReady: sound(
    0.34,
    (o, sr) => {
      bell(o, sr, 0, 523.25, 0.25);
      bell(o, sr, 0.1, 784, 0.24);
    },
    { ...UI_VALUES, gain: 0.45, minRetriggerS: 0.1 },
  ),
  uiError: sound(
    0.28,
    (o, sr) => {
      addTone(o, sr, 0, 0.13, 0.7, 233, 220, 0.004, 3, 1, 1.2, 0.5);
      addTone(o, sr, 0.13, 0.15, 0.7, 196, 185, 0.004, 3, 1, 1.2, 0.5);
    },
    { ...UI_VALUES, gain: 0.4, minRetriggerS: 0.15 },
  ),
} satisfies Record<string, SoundDef>;

export type SoundId = keyof typeof SOUND_DEFS;

/** Index = the number the engine and the voice pool use for a sound. */
export const SOUND_IDS = Object.keys(SOUND_DEFS) as readonly SoundId[];
export const SOUND_COUNT = SOUND_IDS.length;

/** Same order as SOUND_IDS, for index lookups without a string key. */
export const SOUND_DEF_LIST: readonly SoundDef[] = SOUND_IDS.map((id) => SOUND_DEFS[id]);

const SOUND_INDEX: Readonly<Record<SoundId, number>> = Object.fromEntries(
  SOUND_IDS.map((id, index) => [id, index]),
) as Record<SoundId, number>;

export function soundIndexOf(id: SoundId): number {
  return SOUND_INDEX[id];
}

/** Samples in the rendered buffer of a sound at `sampleRate`. */
export function soundLength(id: SoundId, sampleRate: number = RENDER_SAMPLE_RATE): number {
  return Math.max(1, Math.round(SOUND_DEFS[id].durationS * sampleRate));
}

/**
 * Renders a sound's placeholder: mono, `soundLength` samples, peak RENDER_PEAK. Deterministic:
 * the same id and rate always give the same samples. Allocates (init time only).
 */
export function renderSound(id: SoundId, sampleRate: number = RENDER_SAMPLE_RATE): Float32Array {
  const def: SoundDef = SOUND_DEFS[id];
  const length = soundLength(id, sampleRate);
  const rng = new Rng(Math.imul(soundIndexOf(id) + 1, 0x9e3779b1));
  let out: Float32Array;
  if (def.loop) {
    const overlap = Math.min(length, Math.round(LOOP_OVERLAP_S * sampleRate));
    const rendered = new Float32Array(length + overlap);
    def.generate(rendered, sampleRate, rng);
    out = crossfadeLoop(rendered, length);
    removeDc(out);
  } else {
    out = new Float32Array(length);
    def.generate(out, sampleRate, rng);
    fadeEdges(out, sampleRate, 0.001, Math.min(0.012, def.durationS * 0.2));
  }
  normalise(out, RENDER_PEAK);
  return out;
}
