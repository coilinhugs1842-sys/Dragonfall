/**
 * Effect colours by role (docs/ART_DIRECTION.md, "Palette by role"), as LINEAR RGB so they can go
 * straight into shader attributes. Pure numbers, no three.js.
 *
 * Team effects are tinted per team; everything else is neutral, so an effect always says whose
 * it is. Hazards are magenta.
 */

import { TEAMS, TEAM_EMBER, TEAM_FROST } from '../shared';
import type { TeamId } from '../shared';

/** sRGB hex. */
export const EMBER_GLOW_HEX = 0xffb15c;
export const FROST_GLOW_HEX = 0xa8f0ff;
export const HAZARD_HEX = 0xff3fa4;

/** Index into every palette row. Recipes store these numbers. */
export const COLOR_TEAM = 0;
/** The team's lighter glow colour. */
export const COLOR_GLOW = 1;
/** Near-white with a hint of the team: flashes and lightning cores. */
export const COLOR_HOT = 2;
/** The team colour sunk toward dark: the end of a flame's life. */
export const COLOR_DEEP = 3;
/** Wraith shade: a dark violet with a trace of the team. */
export const COLOR_SHADE = 4;
export const COLOR_SMOKE = 5;
export const COLOR_ASH = 6;
export const COLOR_HAZARD = 7;
/** Mossy highlight: healing. */
export const COLOR_HEAL = 8;
/** Pale stone dust: terrain scrapes. */
export const COLOR_DUST = 9;
export const COLOR_ROLE_COUNT = 10;

export type ColorRole = number;

function channelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Writes the linear RGB of an sRGB hex colour at `out[offset..offset + 2]`. */
export function hexToLinear(hex: number, out: Float32Array | number[], offset = 0): void {
  out[offset] = channelToLinear(((hex >> 16) & 0xff) / 255);
  out[offset + 1] = channelToLinear(((hex >> 8) & 0xff) / 255);
  out[offset + 2] = channelToLinear((hex & 0xff) / 255);
}

/** `[team][role][rgb]`, flat: `(team * COLOR_ROLE_COUNT + role) * 3`. */
export const PALETTE: Float32Array = buildPalette();

function buildPalette(): Float32Array {
  const palette = new Float32Array(2 * COLOR_ROLE_COUNT * 3);
  const team = [0, 0, 0];
  const glow = [0, 0, 0];
  const scratch = [0, 0, 0];
  const teams: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];
  for (const id of teams) {
    hexToLinear(TEAMS[id].color, team);
    hexToLinear(id === TEAM_EMBER ? EMBER_GLOW_HEX : FROST_GLOW_HEX, glow);
    const set = (role: number, r: number, g: number, b: number): void => {
      const o = (id * COLOR_ROLE_COUNT + role) * 3;
      palette[o] = r;
      palette[o + 1] = g;
      palette[o + 2] = b;
    };
    const t0 = team[0] ?? 0;
    const t1 = team[1] ?? 0;
    const t2 = team[2] ?? 0;
    set(COLOR_TEAM, t0, t1, t2);
    set(COLOR_GLOW, glow[0] ?? 0, glow[1] ?? 0, glow[2] ?? 0);
    set(COLOR_HOT, 0.6 + 0.4 * t0, 0.6 + 0.4 * t1, 0.6 + 0.4 * t2);
    set(COLOR_DEEP, t0 * 0.34 + 0.02, t1 * 0.2 + 0.01, t2 * 0.3 + 0.03);
    set(COLOR_SHADE, 0.035 + 0.05 * t0, 0.02 + 0.05 * t1, 0.075 + 0.05 * t2);
    hexToLinear(0x2a3346, scratch);
    set(COLOR_SMOKE, (scratch[0] ?? 0) * 0.8, (scratch[1] ?? 0) * 0.8, (scratch[2] ?? 0) * 0.8);
    hexToLinear(0x6f6a78, scratch);
    set(COLOR_ASH, scratch[0] ?? 0, scratch[1] ?? 0, scratch[2] ?? 0);
    hexToLinear(HAZARD_HEX, scratch);
    set(COLOR_HAZARD, scratch[0] ?? 0, scratch[1] ?? 0, scratch[2] ?? 0);
    hexToLinear(0x8cc9a1, scratch);
    set(COLOR_HEAL, scratch[0] ?? 0, scratch[1] ?? 0, scratch[2] ?? 0);
    hexToLinear(0xc9b79a, scratch);
    set(COLOR_DUST, scratch[0] ?? 0, scratch[1] ?? 0, scratch[2] ?? 0);
  }
  return palette;
}

/** Float offset of a colour in PALETTE. */
export function paletteOffset(team: TeamId, role: ColorRole): number {
  return (team * COLOR_ROLE_COUNT + role) * 3;
}
