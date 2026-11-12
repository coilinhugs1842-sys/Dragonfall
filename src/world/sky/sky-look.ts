/**
 * A map's look as one flat table of colours: what the sky dome, the lights, the sea, the cloud
 * puffs and the world material paint with. `skyLookOf` fills every colour a map leaves out
 * with the first map's golden-hour value, so Shattered Spires (which names none of them) looks
 * exactly as it was painted, and a second map only names what differs.
 *
 * Pure numbers, no three.js: tested in node. All colours are sRGB hex, the values wanted ON
 * SCREEN; the views convert them (`setPaintedColor`, or three's `setHex` for lit surfaces).
 */
import type { MapSky } from '../../shared';
import {
  CLOUD_CREST_COLOR,
  CLOUD_LIT_COLOR,
  CLOUD_SEA_DEEP_COLOR,
  CLOUD_SEA_SHADOW_COLOR,
  CLOUD_SHADOW_COLOR,
} from '../clouds/cloud-math';
import {
  HEMISPHERE_GROUND_COLOR,
  HEMISPHERE_SKY_COLOR,
  SKY_CLOUD_LIT,
  SKY_CLOUD_SHADOW,
  SKY_CREAM,
  SKY_DUSK_VIOLET,
  SKY_MAUVE,
  SKY_PEACH,
  SKY_ROSE,
} from './sky-math';

// --- World-material palette of the first map (docs/ART_DIRECTION.md) --------------------------------
/** Palette moss, for the procedural fringe on up-facing stone. */
export const WORLD_MOSS_COLOR = 0x3f8f7a;
/** Palette slate: what shows through thin moss and replaces far-away chamfer highlights. */
export const WORLD_STONE_COLOR = 0x4e6a86;
/** Lit-edge cream. */
export const WORLD_EDGE_COLOR = 0xc9b79a;
/** Aerial perspective: what far rock fades toward away from / toward the sun. */
export const WORLD_AIR_COOL = 0x6a6896;
export const WORLD_AIR_WARM = 0xbd8684;
/** The grade on painted stone: the first map's slate is pushed a little deeper and bluer. */
export const WORLD_STONE_SATURATION = 1.3;
/** Emissive gain of crystals, runes and flames on the first map. */
export const WORLD_GLOW_GAIN = 1.9;

export interface SkyLook {
  // Sky dome gradient: the horizon band and the mid sky, on the sun's side and away from it.
  readonly horizonSun: number;
  readonly midSun: number;
  readonly horizonAway: number;
  readonly midAway: number;
  readonly zenith: number;
  /** High cloud sheets and far banks painted into the sky. */
  readonly skyCloudLit: number;
  readonly skyCloudShadow: number;
  readonly hemisphereSky: number;
  readonly hemisphereGround: number;
  /** The sea (cloud or ash): trough, shaded fold, sunlit flank, crest. */
  readonly seaDeep: number;
  readonly seaShadow: number;
  readonly seaLit: number;
  readonly seaCrest: number;
  /** Light showing through the sea's troughs from below (lava). 0 = none. */
  readonly seaGlow: number;
  /** Cloud puffs: crest, sunlit flank, shade, underside. */
  readonly puffCrest: number;
  readonly puffLit: number;
  readonly puffShadow: number;
  readonly puffDeep: number;
  /** World material. `moss` is whatever fills the `_MASKS.g` slot: moss, or ash. */
  readonly stone: number;
  readonly moss: number;
  readonly edge: number;
  readonly air: number;
  readonly airWarm: number;
  /** What the glow below throws up onto rock near the sea. 0 = none. */
  readonly bounce: number;
  /** Saturation the world material gives painted stone (not a colour; 1 = as painted). */
  readonly stoneSaturation: number;
  /** Emissive gain of glowing rock parts (not a colour). Above 1 the hottest facets whiten. */
  readonly glowGain: number;
}

/** sRGB hex between `a` (t = 0) and `b` (t = 1), mixed per channel in sRGB (a painter's mix). */
export function mixHex(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const channel = (shift: number): number => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + (to - from) * k) << shift;
  };
  return channel(16) | channel(8) | channel(0);
}

/**
 * The full look of a sky. Fields the map names win; a field it leaves out is the golden-hour
 * value, or, for the colours a map never names (the side of the sky away from the sun, the
 * painted high clouds, the puffs), a mix of the ones it did name.
 */
export function skyLookOf(sky: Partial<MapSky>): SkyLook {
  const horizon = sky.horizonColor;
  const mid = sky.midSkyColor;
  const zenith = sky.zenithColor;
  const fog = sky.fogColor;
  const seaShadow = sky.seaShadowColor;
  const seaLit = sky.seaLitColor;
  return {
    horizonSun: horizon ?? SKY_CREAM,
    // Between the horizon band and the named mid sky: the sun's side stays warm higher up.
    midSun: mid !== undefined ? mixHex(mid, horizon ?? SKY_PEACH, 0.45) : SKY_PEACH,
    // Away from the sun the horizon sinks most of the way into the fog colour.
    horizonAway: horizon !== undefined ? mixHex(horizon, fog ?? horizon, 0.62) : SKY_ROSE,
    midAway: mid ?? SKY_MAUVE,
    zenith: zenith ?? SKY_DUSK_VIOLET,
    skyCloudLit: horizon !== undefined ? mixHex(horizon, 0xffe0c8, 0.35) : SKY_CLOUD_LIT,
    skyCloudShadow:
      mid !== undefined ? mixHex(mid, zenith ?? SKY_DUSK_VIOLET, 0.45) : SKY_CLOUD_SHADOW,
    hemisphereSky: sky.hemisphereSkyColor ?? HEMISPHERE_SKY_COLOR,
    hemisphereGround: sky.hemisphereGroundColor ?? HEMISPHERE_GROUND_COLOR,
    seaDeep: sky.seaDeepColor ?? CLOUD_SEA_DEEP_COLOR,
    seaShadow: seaShadow ?? CLOUD_SEA_SHADOW_COLOR,
    seaLit: seaLit ?? CLOUD_LIT_COLOR,
    seaCrest: sky.seaCrestColor ?? CLOUD_CREST_COLOR,
    seaGlow: sky.seaGlowColor ?? 0,
    puffCrest: sky.seaCrestColor ?? CLOUD_CREST_COLOR,
    puffLit: seaLit ?? CLOUD_LIT_COLOR,
    // A puff's shade is a little airier than the sea's folds.
    puffShadow:
      seaShadow !== undefined ? mixHex(seaShadow, seaLit ?? seaShadow, 0.2) : CLOUD_SHADOW_COLOR,
    puffDeep: sky.seaDeepColor ?? CLOUD_SEA_DEEP_COLOR,
    stone: sky.stoneColor ?? WORLD_STONE_COLOR,
    moss: sky.ashColor ?? WORLD_MOSS_COLOR,
    edge: sky.edgeColor ?? WORLD_EDGE_COLOR,
    air: sky.airColor ?? WORLD_AIR_COOL,
    airWarm: sky.airWarmColor ?? WORLD_AIR_WARM,
    bounce: sky.bounceColor ?? 0,
    stoneSaturation: sky.stoneSaturation ?? WORLD_STONE_SATURATION,
    glowGain: sky.glowGain ?? WORLD_GLOW_GAIN,
  };
}

/** The first map's look: what a scene without a map (title, dev viewers, tests) paints with. */
export const GOLDEN_HOUR_LOOK: SkyLook = skyLookOf({});
