/**
 * Builds the frame's WorldView from the two latest sim states (docs/ARCHITECTURE.md, "Data
 * flow"): the host's path from authoritative state to the views. `alpha` is the fixed loop's
 * banked fraction of a tick: 0 shows `prev`, 1 shows `current`.
 *
 * Positions and velocities are lerped, orientations nlerped along the shorter arc (at most one
 * tick of rotation apart, where nlerp and slerp are indistinguishable), and everything discrete
 * (flags, anim, health, stamina) is taken from `current`.
 *
 * Runs every rendered frame: it only writes numbers into the reused view (the pool grows once
 * per dragon slot, never afterwards).
 */

import { MAX_PLAYERS, acquireDragonView, acquireZoneView, beginWorldView } from '../shared';
import type { MatchPhase, MutableQuat, MutableWorldView, PlayerId, Quat } from '../shared';
import type { SimState } from '../sim';

/** The storm wall as the views draw it; null on a map without one. */
export interface StormWallSource {
  readonly stormCenterX: number;
  readonly stormCenterZ: number;
  readonly stormRadius: number;
}

export interface WorldViewBuildOptions {
  /** The dragon this browser controls, or NO_PLAYER. */
  readonly localDragonId: PlayerId;
  /** Read live each frame (Duel shrinks the radius). */
  readonly stormWall: StormWallSource | null;
  readonly phase: MatchPhase;
}

/** Zone id of the storm wall: there is exactly one, so it never changes. */
export const STORM_WALL_ZONE_ID = 0;

function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

/**
 * Normalised lerp from `a` to `b` along the shorter arc. Falls back to `b` if the blend
 * degenerates (antipodal inputs), so the result is always a unit quaternion.
 */
export function nlerpQuat(out: MutableQuat, a: Quat, b: Quat, t: number): MutableQuat {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  // q and -q are the same rotation: flip one end so the blend does not go the long way round.
  const s = dot < 0 ? -1 : 1;
  const u = 1 - t;
  const x = a.x * u + b.x * s * t;
  const y = a.y * u + b.y * s * t;
  const z = a.z * u + b.z * s * t;
  const w = a.w * u + b.w * s * t;
  const lengthSq = x * x + y * y + z * z + w * w;
  if (!(lengthSq > 1e-12)) {
    out.x = b.x;
    out.y = b.y;
    out.z = b.z;
    out.w = b.w;
    return out;
  }
  const inverse = 1 / Math.sqrt(lengthSq);
  out.x = x * inverse;
  out.y = y * inverse;
  out.z = z * inverse;
  out.w = w * inverse;
  return out;
}

/**
 * Rewrites `view` for this frame. `prev` and `current` are `sim.prev` / `sim.current`: the same
 * slot index is the same dragon in both, unless the slot was (re)filled between them, in which
 * case the dragon is shown at its `current` pose instead of sweeping in from stale data.
 */
export function buildWorldView(
  view: MutableWorldView,
  prev: Readonly<SimState>,
  current: Readonly<SimState>,
  alpha: number,
  options: WorldViewBuildOptions,
): MutableWorldView {
  const t = clamp01(alpha);
  beginWorldView(view);

  for (let i = 0; i < MAX_PLAYERS; i++) {
    const now = current.dragons[i];
    if (now === undefined || !now.active) continue;
    const before = prev.dragons[i];
    const from = before !== undefined && before.active && before.id === now.id ? before : now;

    const out = acquireDragonView(view);
    out.id = now.id;
    out.team = now.team;
    out.classId = now.classId;
    out.position.x = from.position.x + (now.position.x - from.position.x) * t;
    out.position.y = from.position.y + (now.position.y - from.position.y) * t;
    out.position.z = from.position.z + (now.position.z - from.position.z) * t;
    out.velocity.x = from.velocity.x + (now.velocity.x - from.velocity.x) * t;
    out.velocity.y = from.velocity.y + (now.velocity.y - from.velocity.y) * t;
    out.velocity.z = from.velocity.z + (now.velocity.z - from.velocity.z) * t;
    nlerpQuat(out.orientation, from.orientation, now.orientation, t);
    out.health = now.maxHealth > 0 ? clamp01(now.health / now.maxHealth) : 0;
    out.stamina = clamp01(now.stamina);
    out.flags = now.flags;
    out.anim = now.anim;
  }

  const storm = options.stormWall;
  if (storm !== null) {
    const zone = acquireZoneView(view);
    zone.id = STORM_WALL_ZONE_ID;
    zone.kind = 'stormWall';
    zone.team = null;
    zone.position.x = storm.stormCenterX;
    zone.position.y = 0;
    zone.position.z = storm.stormCenterZ;
    zone.radius = storm.stormRadius;
  }

  view.localDragonId = options.localDragonId;
  const clock = view.clock;
  clock.tick = current.tick;
  clock.phase = options.phase;
  clock.phaseTimeS = prev.timeS + (current.timeS - prev.timeS) * t;
  clock.timeRemainingS = Infinity;
  clock.round = 1;
  return view;
}
