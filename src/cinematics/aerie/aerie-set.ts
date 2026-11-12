/**
 * The aerie as a list of placed map assets: the same `MapPlacement`s a real map is made of, so
 * the map's own prop renderer (`createPropField`: instancing, LODs, the painterly world material
 * with sun, fog and shadow) draws it. Nothing here is new art: every piece ships with Shattered
 * Spires and is already downloaded behind the title screen.
 *
 * Pure data, load-time: the list is built once per quality preset.
 *
 * WHAT STANDS WHERE (local frame of ./aerie-layout.ts):
 * - THE CLIFF, on the left only: a row of rock pillars standing in the cloud sea and running
 *   away from the camera, tall enough to leave the top of the picture. Ember's terrace is a
 *   ledge at its foot. The right-hand side stays open, because that is where the sun is: a
 *   cliff there would put both terraces in its shadow. Instead the light rakes in over Frost's
 *   terrace, across the gap, and lands on Ember's cliff.
 * - Low pillars in the cloud sea on the right and two far spires in the haze, so the open side
 *   is a place too and the sky has something to be measured against.
 * - Per team (the right side is listed, the left is its mirror image): a floating terrace of
 *   mossy rock and a smaller one a step higher behind it; five standing stones sunk into them
 *   so only their heads show (the perches: a perched dragon's tail hangs lower than its feet,
 *   so a perch has to be a post); banners in the team's colour (the `TeamTint` cloth); braziers
 *   at the front edge; and on Medium / High broken columns and walls for a lived-in ruin.
 */
import { QUALITY_PRESET_IDS, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { MapPlacement, QualityPresetId, TeamId, Vec3 } from '../../shared';
import { AERIE_ALTITUDE, aerieToWorld } from './aerie-layout';
import type { AerieLayout } from './aerie-layout';

/** Asset-space height of a standing stone's top face (its bounds reach 10.5 at one corner). */
export const STONE_TOP_Y = 10.05;
/** Scale of the perch stones: the top is then about 5 m across, room for four claws. */
export const PERCH_STONE_SCALE = 1.1;
/** Floor height of the raised terrace behind the front one. */
export const BACK_TERRACE_Y = 5;

/** One piece of the set, in the local frame. */
interface SetPiece {
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
  /** Takes the side's team colour (banners). */
  readonly tint?: boolean;
  /** 0 = every preset, 1 = Medium and High, 2 = High only. */
  readonly detail: 0 | 1 | 2;
  /**
   * Standing in the cloud sea: `y` is ignored and the base goes this many metres below the
   * sea's surface (which hides it).
   */
  readonly rootDepth?: number;
  /** For tools and debugging (`MapPlacement.group`). */
  readonly group: string;
}

const DETAIL_OF: Readonly<Record<QualityPresetId, number>> = { low: 0, medium: 1, high: 2 };

/** The pieces each team has: listed for the right-hand (Frost) side, mirrored for Ember. */
const RIGHT_SIDE: readonly SetPiece[] = [
  // --- The terraces ---------------------------------------------------------------------------
  { type: 'island-large', x: 17, y: 0, z: 0, yaw: 0.6, scale: 0.29, detail: 0, group: 'terrace' },
  { type: 'island-small', x: 15, y: BACK_TERRACE_Y, z: -18, yaw: 2.1, scale: 0.42, detail: 0, group: 'terrace' },
  // --- Team colours -----------------------------------------------------------------------------
  { type: 'banner-wide', x: 14.5, y: BACK_TERRACE_Y, z: -25, yaw: 0, scale: 1.0, tint: true, detail: 0, group: 'banner' },
  { type: 'banner-tall', x: 29.5, y: 0, z: 3.5, yaw: -0.5, scale: 0.7, tint: true, detail: 0, group: 'banner' },
  { type: 'banner-tall', x: 3.2, y: 0, z: -5.5, yaw: -0.2, scale: 0.6, tint: true, detail: 1, group: 'banner' },
  // --- Fire at the front edge -------------------------------------------------------------------
  { type: 'brazier', x: 10.2, y: 0, z: 9.2, yaw: 0.4, scale: 0.5, detail: 0, group: 'brazier' },
  { type: 'brazier', x: 18.8, y: 0, z: 7.6, yaw: 1.3, scale: 0.5, detail: 1, group: 'brazier' },
  // --- Ruins ------------------------------------------------------------------------------------
  { type: 'wall-fragment', x: 24.5, y: BACK_TERRACE_Y, z: -22, yaw: -0.5, scale: 0.6, detail: 1, group: 'ruin' },
  { type: 'column-ruined', x: 28.5, y: 0, z: -5, yaw: 0.8, scale: 0.6, detail: 1, group: 'ruin' },
  { type: 'column-broken', x: 26.5, y: 0, z: 8, yaw: 2.4, scale: 0.55, detail: 2, group: 'ruin' },
  { type: 'column-ruined', x: 5.2, y: BACK_TERRACE_Y, z: -21, yaw: 2.9, scale: 0.55, detail: 2, group: 'ruin' },
];

/**
 * Pieces that are placed once, as listed. The cliff's row of pillars runs along the model's
 * own X axis; a yaw of PI / 2 lays that axis along the view (away from the camera) with the
 * model's front toward the terraces, so the pillars stand one behind another and the picture's
 * middle stays open.
 */
const ONCE: readonly SetPiece[] = [
  // --- The cliff behind and beside Ember's terrace ------------------------------------------------
  { type: 'cliff-wall', x: -60, y: 0, z: -70, yaw: Math.PI / 2, scale: 1.5, detail: 0, rootDepth: 40, group: 'cliff' },
  // --- The open side: low pillars in the sea, their mossy heads below the terraces ----------------
  { type: 'cliff-wall', x: 74, y: 0, z: -96, yaw: 0.35, scale: 1.3, detail: 0, rootDepth: 92, group: 'cliff' },
  // --- Far spires in the haze -----------------------------------------------------------------------
  { type: 'spire-tall', x: -18, y: 0, z: -340, yaw: 1.1, scale: 0.62, detail: 0, rootDepth: 40, group: 'far' },
  { type: 'spire-twin', x: 104, y: 0, z: -300, yaw: 2.6, scale: 0.5, detail: 0, rootDepth: 40, group: 'far' },
];

/**
 * Which way each perch stone is turned (radians), so five copies do not look like one. All
 * near PI: the stone's rune face (hazard magenta on the map) then looks at the cliff, not at
 * the camera.
 */
const STONE_YAWS: readonly number[] = [3.3, 2.75, 3.6, 2.9, 3.45];

function place(
  layout: AerieLayout,
  piece: SetPiece,
  mirror: 1 | -1,
  team: TeamId | undefined,
): MapPlacement {
  const y = piece.rootDepth !== undefined ? -AERIE_ALTITUDE - piece.rootDepth : piece.y;
  const position = aerieToWorld(layout, piece.x * mirror, y, piece.z, { x: 0, y: 0, z: 0 });
  const placement: MapPlacement = {
    type: piece.type,
    position,
    // A mirror image turns the other way; then the aerie's own heading on top.
    yaw: piece.yaw * mirror + layout.yaw,
    pitch: 0,
    roll: 0,
    scale: piece.scale,
    group: `aerie-${piece.group}`,
  };
  return team !== undefined && piece.tint === true ? { ...placement, team } : placement;
}

/** The set for a preset. Load-time: allocates the list. */
export function aeriePlacements(layout: AerieLayout, presetId: QualityPresetId): MapPlacement[] {
  const detail = DETAIL_OF[presetId];
  const list: MapPlacement[] = [];
  for (const piece of ONCE) {
    if (piece.detail <= detail) list.push(place(layout, piece, 1, undefined));
  }
  for (const side of [TEAM_EMBER, TEAM_FROST] as const) {
    const mirror = side === TEAM_EMBER ? -1 : 1;
    for (const piece of RIGHT_SIDE) {
      if (piece.detail <= detail) list.push(place(layout, piece, mirror, side));
    }
  }
  // The perches: one stone under every perch of the layout, sunk so its top is the perch.
  for (const perch of layout.perches) {
    list.push({
      type: 'standing-stone',
      position: {
        x: perch.position.x,
        y: perch.position.y - STONE_TOP_Y * PERCH_STONE_SCALE,
        z: perch.position.z,
      },
      yaw: (STONE_YAWS[perch.index] ?? Math.PI) * (perch.side === TEAM_EMBER ? -1 : 1) + layout.yaw,
      pitch: 0,
      roll: 0,
      scale: PERCH_STONE_SCALE,
      group: 'aerie-perch',
    });
  }
  return list;
}

/** A brazier of the set: where its bowl stands and whose colour its fire takes. */
export interface AerieBrazier {
  readonly position: Vec3;
  readonly scale: number;
  readonly team: TeamId;
}

/**
 * Every brazier the set can have (the High list), each with the detail level it needs: the
 * glow mesh hides the fire of the ones a preset leaves out.
 */
export function aerieBraziers(
  layout: AerieLayout,
): readonly (AerieBrazier & { readonly detail: number })[] {
  const list: (AerieBrazier & { readonly detail: number })[] = [];
  for (const side of [TEAM_EMBER, TEAM_FROST] as const) {
    const mirror = side === TEAM_EMBER ? -1 : 1;
    for (const piece of RIGHT_SIDE) {
      if (piece.type !== 'brazier') continue;
      list.push({
        position: aerieToWorld(layout, piece.x * mirror, piece.y, piece.z, { x: 0, y: 0, z: 0 }),
        scale: piece.scale,
        team: side,
        detail: piece.detail,
      });
    }
  }
  return list;
}

/** The detail level (0..2) a preset draws; pieces above it are left out. */
export function aerieDetailLevel(presetId: QualityPresetId): number {
  return DETAIL_OF[presetId];
}

/** True when two presets draw the same list (then a preset change needs no rebuild). */
export function sameAerieSet(a: QualityPresetId, b: QualityPresetId): boolean {
  return DETAIL_OF[a] === DETAIL_OF[b];
}

/** Presets in order, for tools that report the set's cost per preset. */
export const AERIE_PRESET_ORDER: readonly QualityPresetId[] = QUALITY_PRESET_IDS;
