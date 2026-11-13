/**
 * Decides, once per rendered frame, which dragons of the WorldView get a friend-or-foe marker
 * and where it stands in the picture, and writes that into the HUD state's pooled tags. DOM-free
 * and allocation-free after `createDragonTagWriter`; `src/game`'s HUD builder calls it with the
 * frame's camera. The arithmetic is in `tag-model.ts`.
 *
 * THE RULES
 * - Nothing outside the `playing` phase (the cinematics own the picture), nothing while the
 *   local rider is blinded, and never for the dead, the local dragon, the dragon the camera is
 *   on, or a dragon behind the camera or outside the picture.
 * - TEAM MATES: always while in the picture, at any distance and through rock. Full-size shape
 *   and the rider's name when near or aimed at, a smaller shape alone when far.
 * - ENEMIES: the shape, never a name, and only where the player can see the dragon anyway:
 *   inside TAG_TUNING.foeRangeM, never while veiled, and with a clear line from the camera (one
 *   terrain ray, re-tested every few frames). An enemy whose sight line has not been tested yet
 *   is not marked: the rule fails closed. Without a terrain query the range is short instead.
 * - A SPECTATOR is on neither side: both teams are marked by the team-mate rule.
 *
 * VEIL. The WorldView of a rider already leaves veiled enemies out (DECISIONS 27: the host's
 * snapshots and events hide them), so no marker can be made for one. The check on
 * DRAGON_FLAG_VEILED here is a second lock on the same door, not the only one.
 */

import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER } from '../../shared/constants';
import type { TerrainQuery } from '../../shared/terrain-query';
import { DRAGON_FLAG_ALIVE, DRAGON_FLAG_VEILED } from '../../shared/world-view';
import type { WorldView } from '../../shared/world-view';
import type { MutableHudDragonTag } from './hud-state';
import {
  TAG_TUNING,
  createScreenPoint,
  foeOpacity,
  foeRangeM,
  mateOpacity,
  projectPoint,
  tagLarge,
  tagLiftM,
} from './tag-model';

/** Player ids are a `u8`. */
const ID_SLOTS = 256;
const SIGHT_UNKNOWN = 0;
const SIGHT_CLEAR = 1;
const SIGHT_BLOCKED = 2;

/** Who is looking: a team's rider, a spectator (both teams are friends), or nobody known yet. */
export type TagViewer = TeamId | 'spectator' | null;

/** What changes per frame and is not in the WorldView. */
export interface DragonTagFrame {
  /** `camera.matrixWorld.elements`; fewer than 16 numbers = no camera, no markers. */
  cameraWorld: ArrayLike<number>;
  /** `camera.projectionMatrix.elements`. */
  cameraProjection: ArrayLike<number>;
  /** The map's rock, for enemy sight lines; null = unknown (enemies are marked only close by). */
  terrain: TerrainQuery | null;
  /** Null (a rider whose team is not known yet) marks nobody rather than guess. */
  viewer: TagViewer;
  /** The local rider's own dragon, or NO_PLAYER. */
  localId: PlayerId;
  /** The dragon the camera follows (the killer after a takedown, a spectator's subject). */
  watchedId: PlayerId;
  /** The local rider is blinded: the markers go with the rest of the bearings. */
  blinded: boolean;
}

export interface DragonTagWriter {
  /**
   * Fills `tags` for this frame: slot i belongs to `view.dragons[i]`, so a rider keeps its node
   * and nothing is rewritten on the page while the room stays the same. `names` is indexed by
   * player id.
   */
  write(
    tags: MutableHudDragonTag[],
    view: Readonly<WorldView>,
    frame: Readonly<DragonTagFrame>,
    names: readonly string[],
  ): void;
  /** A new match: forget sizes and sight lines. */
  reset(): void;
}

export function createDragonTagWriter(): DragonTagWriter {
  // By player id: last frame's size (for the hysteresis) and the last sight line.
  const large = new Uint8Array(ID_SLOTS);
  const sight = new Uint8Array(ID_SLOTS);
  const sightFrame = new Int32Array(ID_SLOTS);
  const point = createScreenPoint();
  let frameIndex = 0;

  function reset(): void {
    large.fill(0);
    sight.fill(SIGHT_UNKNOWN);
    sightFrame.fill(-TAG_TUNING.sightStaleFrames - 1);
    frameIndex = 0;
  }
  reset();

  function hideAll(tags: MutableHudDragonTag[]): void {
    for (let i = 0; i < tags.length; i++) {
      const tag = tags[i];
      if (tag !== undefined) tag.shown = false;
    }
  }

  /** One terrain ray from the lens to the dragon in `slot`; remembers the answer. */
  function testSight(
    view: Readonly<WorldView>,
    slot: number,
    world: ArrayLike<number>,
    terrain: TerrainQuery,
  ): void {
    const dragon = view.dragons[slot];
    if (dragon === undefined) return;
    const ox = world[12] ?? 0;
    const oy = world[13] ?? 0;
    const oz = world[14] ?? 0;
    const dx = dragon.position.x - ox;
    const dy = dragon.position.y - oy;
    const dz = dragon.position.z - oz;
    const reach = Math.sqrt(dx * dx + dy * dy + dz * dz) - TAG_TUNING.sightSlackM;
    const id = dragon.id & (ID_SLOTS - 1);
    sight[id] =
      reach > 0 && terrain.raycast(ox, oy, oz, dx, dy, dz, reach) >= 0
        ? SIGHT_BLOCKED
        : SIGHT_CLEAR;
    sightFrame[id] = frameIndex;
  }

  return {
    reset,

    write(tags, view, frame, names): void {
      frameIndex++;
      const world = frame.cameraWorld;
      const projection = frame.cameraProjection;
      const viewer = frame.viewer;
      if (
        view.clock.phase !== 'playing' ||
        viewer === null ||
        frame.blinded ||
        world.length < 16 ||
        projection.length < 16
      ) {
        hideAll(tags);
        return;
      }
      const terrain = frame.terrain;
      const range = foeRangeM(terrain !== null);
      // The enemies whose sight line is oldest are tested after the loop: up to two a frame.
      let oldestSlot = -1;
      let oldestAge = -1;
      let secondSlot = -1;
      let secondAge = -1;

      const count = view.dragonCount < tags.length ? view.dragonCount : tags.length;
      for (let i = 0; i < tags.length; i++) {
        const tag = tags[i];
        if (tag === undefined) continue;
        tag.shown = false;
        const dragon = i < count ? view.dragons[i] : undefined;
        if (dragon === undefined) continue;
        const id = dragon.id & (ID_SLOTS - 1);
        const wasLarge = large[id] === 1;
        large[id] = 0;
        if (
          (dragon.flags & DRAGON_FLAG_ALIVE) === 0 ||
          dragon.id === frame.localId ||
          dragon.id === frame.watchedId ||
          dragon.id === NO_PLAYER
        ) {
          continue;
        }
        const foe = viewer !== 'spectator' && dragon.team !== viewer;
        if (foe && (dragon.flags & DRAGON_FLAG_VEILED) !== 0) continue;
        const position = dragon.position;
        const cx = position.x - (world[12] ?? 0);
        const cy = position.y - (world[13] ?? 0);
        const cz = position.z - (world[14] ?? 0);
        const lift = tagLiftM(Math.sqrt(cx * cx + cy * cy + cz * cz));
        if (!projectPoint(point, world, projection, position.x, position.y + lift, position.z)) {
          continue;
        }
        const distance = point.distance;
        let opacity = 1;
        if (foe) {
          opacity = foeOpacity(distance, range);
          if (!(opacity > 0)) continue;
          if (terrain !== null) {
            const age = frameIndex - (sightFrame[id] ?? 0);
            if (age > oldestAge) {
              secondSlot = oldestSlot;
              secondAge = oldestAge;
              oldestSlot = i;
              oldestAge = age;
            } else if (age > secondAge) {
              secondSlot = i;
              secondAge = age;
            }
            // Not tested lately, or rock in the way: no marker.
            if (age > TAG_TUNING.sightStaleFrames || sight[id] !== SIGHT_CLEAR) continue;
          }
        }
        const big = tagLarge(distance, point.centre2, wasLarge);
        large[id] = big ? 1 : 0;
        tag.shown = true;
        tag.team = dragon.team;
        tag.foe = foe;
        tag.near = big;
        // An enemy is never named: the marker says "enemy here", not who.
        tag.name = big && !foe ? (names[id] ?? '') : '';
        tag.x = point.x;
        tag.y = point.y;
        tag.opacity = foe ? opacity : mateOpacity(big);
      }

      if (terrain !== null) {
        if (oldestSlot >= 0) testSight(view, oldestSlot, world, terrain);
        if (secondSlot >= 0 && TAG_TUNING.sightChecksPerFrame > 1) {
          testSight(view, secondSlot, world, terrain);
        }
      }
    },
  };
}
