/**
 * The placeholder silhouettes (docs/ART_DIRECTION.md, "Dragons"), as numbers for
 * `buildDragonGeometry`. Greybox only: these go away when the real GLBs arrive (Phase 4).
 *
 * Hides are jewel tones, never red/orange; the team colour is added at runtime as an emissive
 * accent on the wing membranes.
 */

import type { DragonClassId } from '../shared';

export interface DragonShape {
  /** sRGB hex: back and flanks, underside, wing membrane. */
  readonly hideColor: number;
  readonly bellyColor: number;
  readonly membraneColor: number;
  /** Multiplier on the body cross-sections (1 = medium build). */
  readonly girth: number;
  /** Metres. */
  readonly neckLength: number;
  readonly headLength: number;
  readonly tailLength: number;
  readonly hornLength: number;
  /** Metres from the shoulder hinge to the wing tip, wings spread. */
  readonly wingSpan: number;
  /** Metres, front to back at the wing root. */
  readonly wingChord: number;
  /** Metres the tip sits behind the hinge: larger = more swept. */
  readonly wingSweep: number;
  /** Membrane panels along the trailing edge (>= 2). */
  readonly wingFingers: number;
  /** 0..1: how deep the trailing edge is cut between fingers (tattered look). */
  readonly wingNotch: number;
  /** Metres: height of the neck crest fin, 0 = none. */
  readonly crestHeight: number;
  /** Dorsal plates along the back, 0 = none. */
  readonly backPlates: number;
}

export const DRAGON_SHAPES: Readonly<Record<DragonClassId, DragonShape>> = {
  // Slim, long tail, narrow swept wings. Emerald.
  talon: {
    hideColor: 0x12996b,
    bellyColor: 0x7fd6a8,
    membraneColor: 0x0b5c48,
    girth: 0.85,
    neckLength: 1.9,
    headLength: 1.3,
    tailLength: 4.8,
    hornLength: 0.9,
    wingSpan: 6.6,
    wingChord: 2.3,
    wingSweep: 2.6,
    wingFingers: 3,
    wingNotch: 0.18,
    crestHeight: 0,
    backPlates: 0,
  },
  // Bulky, plated back, broad wings. Bronze (a brown-gold, kept well away from Ember orange).
  bastion: {
    hideColor: 0x8a7a3a,
    bellyColor: 0xd2c08a,
    membraneColor: 0x4f4426,
    girth: 1.35,
    neckLength: 1.4,
    headLength: 1.5,
    tailLength: 3.2,
    hornLength: 0.6,
    wingSpan: 6.2,
    wingChord: 4.4,
    wingSweep: 0.8,
    wingFingers: 3,
    wingNotch: 0.12,
    crestHeight: 0,
    backPlates: 4,
  },
  // Long neck, crest fin, ribbed wings. Sapphire.
  tempest: {
    hideColor: 0x1f4fbf,
    bellyColor: 0x8fb4f0,
    membraneColor: 0x16307a,
    girth: 1.0,
    neckLength: 3.1,
    headLength: 1.2,
    tailLength: 3.8,
    hornLength: 0.5,
    wingSpan: 6.8,
    wingChord: 3.2,
    wingSweep: 1.4,
    wingFingers: 5,
    wingNotch: 0.2,
    crestHeight: 0.9,
    backPlates: 0,
  },
  // Lean, tattered wing edges, long thin tail. Obsidian with a violet sheen.
  wraith: {
    hideColor: 0x3a3350,
    bellyColor: 0x7a6aa8,
    membraneColor: 0x2a2340,
    girth: 0.8,
    neckLength: 2.0,
    headLength: 1.2,
    tailLength: 5.2,
    hornLength: 1.1,
    wingSpan: 6.4,
    wingChord: 3.0,
    wingSweep: 1.9,
    wingFingers: 5,
    wingNotch: 0.5,
    crestHeight: 0,
    backPlates: 0,
  },
  // Lean support: jade hide, leafy silhouette.
  verdant: {
    hideColor: 0x1a8a55,
    bellyColor: 0xa8e0b8,
    membraneColor: 0x5a3a8a,
    girth: 1.0,
    neckLength: 2.6,
    headLength: 1.25,
    tailLength: 4.2,
    hornLength: 0.55,
    wingSpan: 6.7,
    wingChord: 3.1,
    wingSweep: 1.5,
    wingFingers: 5,
    wingNotch: 0.22,
    crestHeight: 0.75,
    backPlates: 0,
  },
  // Slim disruptor: citrine / antique gold.
  aureate: {
    hideColor: 0xb8a028,
    bellyColor: 0xf0e6a0,
    membraneColor: 0x7a6820,
    girth: 0.9,
    neckLength: 2.0,
    headLength: 1.3,
    tailLength: 4.6,
    hornLength: 0.85,
    wingSpan: 6.5,
    wingChord: 2.4,
    wingSweep: 2.4,
    wingFingers: 3,
    wingNotch: 0.16,
    crestHeight: 0,
    backPlates: 0,
  },
  // Scout: pearl body, pale aquamarine membranes.
  zephyr: {
    hideColor: 0xd8e4ea,
    bellyColor: 0xf4f8fa,
    membraneColor: 0x4aa8ac,
    girth: 0.75,
    neckLength: 2.1,
    headLength: 1.15,
    tailLength: 5.0,
    hornLength: 1.0,
    wingSpan: 7.0,
    wingChord: 2.8,
    wingSweep: 2.0,
    wingFingers: 4,
    wingNotch: 0.28,
    crestHeight: 0.35,
    backPlates: 0,
  },
  // Siege: slate-silver plates.
  granite: {
    hideColor: 0x5a6068,
    bellyColor: 0xb0b4b8,
    membraneColor: 0x3a4048,
    girth: 1.4,
    neckLength: 1.35,
    headLength: 1.55,
    tailLength: 3.0,
    hornLength: 0.55,
    wingSpan: 6.3,
    wingChord: 4.5,
    wingSweep: 0.7,
    wingFingers: 3,
    wingNotch: 0.1,
    crestHeight: 0,
    backPlates: 5,
  },
  // Trickster: opal / rose-iridescent.
  mirage: {
    hideColor: 0x7a4a6a,
    bellyColor: 0xe8d0dc,
    membraneColor: 0xb85a88,
    girth: 0.82,
    neckLength: 2.05,
    headLength: 1.2,
    tailLength: 5.1,
    hornLength: 1.05,
    wingSpan: 6.5,
    wingChord: 3.0,
    wingSweep: 1.85,
    wingFingers: 5,
    wingNotch: 0.42,
    crestHeight: 0,
    backPlates: 0,
  },
};
