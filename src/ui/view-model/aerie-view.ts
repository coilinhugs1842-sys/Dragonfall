/**
 * The aerie lobby (T-5.2, T-5.3) without the DOM: which layout a state asks for, what a click
 * on a rider means for the close-up camera, and where a name card goes on screen. Pure and
 * allocation-free after module load, so the lobby can call it for every card on every frame.
 *
 * Name cards follow the 3D perches, so they move every frame. Their position is reduced to a
 * whole step first and the CSS value is looked up in a table built once: nothing is formatted
 * per frame, and a card that has not moved a visible amount writes nothing.
 */

import type { PlayerId } from '../../shared/constants';
import { MAX_PLAYERS, NO_PLAYER } from '../../shared/constants';
import type { LobbyPhase, LobbyPlayer, LobbyState } from '../../shared/lobby';
import type { LobbyPlate } from '../../shared/ui';

export type LobbyLayout = 'flat' | 'aerie';

/** The docked layout is only for a 3D aerie behind the UI; anything else is today's flat panel. */
export function lobbyLayoutFor(aerie: boolean | undefined): LobbyLayout {
  return aerie === true ? 'aerie' : 'flat';
}

/**
 * What `lobby.focusPlayer` should carry after a click on a rider: that rider, or null (back to
 * the drifting camera) when they are the one already in the close-up.
 */
export function focusTarget(focusedId: PlayerId, clickedId: PlayerId): PlayerId | null {
  if (clickedId === NO_PLAYER) return null;
  return clickedId === focusedId ? null : clickedId;
}

/**
 * The line shown instead of the controls while the room is not gathering: the take-off is
 * playing, or (for someone who arrives late) a match is already running. '' = show the controls.
 */
export function aerieNotice(phase: LobbyPhase): string {
  if (phase === 'starting') return 'Taking off';
  if (phase === 'inMatch') return 'Match under way';
  return '';
}

/** The lobby member with this id, or null. A short linear scan: a room holds 16 at most. */
export function findLobbyPlayer(lobby: LobbyState, playerId: PlayerId): LobbyPlayer | null {
  if (playerId === NO_PLAYER) return null;
  const players = lobby.players;
  for (let i = 0; i < players.length; i++) {
    const player = players[i];
    if (player !== undefined && player.id === playerId) return player;
  }
  return null;
}

// --- Name cards ---------------------------------------------------------------------------------

/** One card per perch: the pool never grows. */
export const PLATE_POOL_SIZE = MAX_PLAYERS;

/** A close-up may enlarge a card and a far perch shrink it, but never past readable. */
export const PLATE_SCALE_MIN = 0.75;
export const PLATE_SCALE_MAX = 1.5;
const PLATE_SCALE_STEP = 0.05;
export const PLATE_SCALE_STEPS = Math.round((PLATE_SCALE_MAX - PLATE_SCALE_MIN) / PLATE_SCALE_STEP);

/** Steps across the viewport: 0.025 % each, about half a pixel on a 1080p screen. */
export const PLATE_POSITION_STEPS = 4000;

function buildTable(length: number, make: (index: number) => string): readonly string[] {
  const table: string[] = [];
  for (let i = 0; i < length; i++) table.push(make(i));
  return table;
}

/** `'0%'`, `'0.025%'` … `'100%'`: a translate in percent of a viewport-sized box. */
export const PLATE_PERCENT_STRINGS = buildTable(
  PLATE_POSITION_STEPS + 1,
  (i) => `${(i * 100) / PLATE_POSITION_STEPS}%`,
);
/** `'0.75'` … `'1.5'`. */
export const PLATE_SCALE_STRINGS = buildTable(PLATE_SCALE_STEPS + 1, (i) =>
  (PLATE_SCALE_MIN + i * PLATE_SCALE_STEP).toFixed(2),
);

/** The scale a card is drawn at. NaN and nonsense give 1. */
export function clampPlateScale(scale: number): number {
  if (!(scale > 0) || !Number.isFinite(scale)) return 1;
  return scale < PLATE_SCALE_MIN ? PLATE_SCALE_MIN : scale > PLATE_SCALE_MAX ? PLATE_SCALE_MAX : scale;
}

/**
 * The part of the screen the docked panels leave free, and how big a card is at scale 1, all in
 * viewport fractions. Cards stay inside it so a name never sits under a roster.
 */
export interface PlateBand {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Half the card's width and its full height at scale 1. */
  halfWidth: number;
  height: number;
}

export function createPlateBand(): PlateBand {
  return { left: 0, right: 1, top: 0, bottom: 1, halfWidth: 0, height: 0 };
}

/**
 * Fills `out` from pixel measurements of the docked layout (taken when the window, the
 * interface size or the layout changes; never per frame). Anything unusable (a hidden lobby
 * measures 0) gives the whole screen, so cards are never lost to a bad measurement. Returns
 * whether the measurement was usable.
 */
export function measurePlateBand(
  out: PlateBand,
  viewportWidth: number,
  viewportHeight: number,
  leftEdgePx: number,
  rightEdgePx: number,
  topEdgePx: number,
  bottomEdgePx: number,
  cardWidthPx: number,
  cardHeightPx: number,
): boolean {
  const usable =
    viewportWidth > 0 &&
    viewportHeight > 0 &&
    leftEdgePx >= 0 &&
    rightEdgePx > leftEdgePx &&
    topEdgePx >= 0 &&
    bottomEdgePx > topEdgePx &&
    cardWidthPx >= 0 &&
    cardHeightPx >= 0;
  if (!usable) {
    out.left = 0;
    out.right = 1;
    out.top = 0;
    out.bottom = 1;
    out.halfWidth = 0;
    out.height = 0;
    return false;
  }
  out.left = leftEdgePx / viewportWidth;
  out.right = rightEdgePx < viewportWidth ? rightEdgePx / viewportWidth : 1;
  out.top = topEdgePx / viewportHeight;
  out.bottom = bottomEdgePx < viewportHeight ? bottomEdgePx / viewportHeight : 1;
  out.halfWidth = (cardWidthPx * 0.5) / viewportWidth;
  out.height = cardHeightPx / viewportHeight;
  return true;
}

/** Where one card goes this frame, as table steps. */
export interface PlatePlacement {
  shown: boolean;
  xStep: number;
  yStep: number;
  scaleStep: number;
}

export function createPlatePlacement(): PlatePlacement {
  return { shown: false, xStep: 0, yStep: 0, scaleStep: 0 };
}

function toStep(fraction: number): number {
  const step = Math.round(fraction * PLATE_POSITION_STEPS);
  return step < 0 ? 0 : step > PLATE_POSITION_STEPS ? PLATE_POSITION_STEPS : step;
}

/**
 * Places a card. Its anchor is the bottom centre.
 * - A perch that is off screen, behind the camera, or under a docked panel gets no card: the
 *   roster beside it already names that rider, and a card pushed away from its dragon would
 *   point at nothing.
 * - A perch near the edge of the free band keeps its card, nudged inward so the whole card
 *   stays clear of the panels.
 */
export function placePlate(
  out: PlatePlacement,
  plate: Readonly<LobbyPlate>,
  band: Readonly<PlateBand>,
): PlatePlacement {
  out.shown = false;
  const x = plate.x;
  const y = plate.y;
  if (!plate.visible || !Number.isFinite(x) || !Number.isFinite(y)) return out;
  if (x < band.left || x > band.right || y < band.top || y > band.bottom) return out;

  const scale = clampPlateScale(plate.scale);
  const half = band.halfWidth * scale;
  const height = band.height * scale;
  const minX = band.left + half;
  const maxX = band.right - half;
  // A band narrower than the card: centre it rather than pick a side.
  const placedX = minX > maxX ? (band.left + band.right) * 0.5 : x < minX ? minX : x > maxX ? maxX : x;
  const minY = band.top + height;
  const placedY = y < minY ? (minY < band.bottom ? minY : band.bottom) : y;

  out.shown = true;
  out.xStep = toStep(placedX);
  out.yStep = toStep(placedY);
  out.scaleStep = Math.round((scale - PLATE_SCALE_MIN) / PLATE_SCALE_STEP);
  return out;
}
