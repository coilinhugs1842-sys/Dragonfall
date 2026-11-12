/**
 * The aerie's cast: one dragon per rider of the lobby, written every frame into a WorldView the
 * ordinary dragon renderer draws. Pure TypeScript (no three.js, no DOM), so the whole state
 * machine runs in node tests.
 *
 * A fixed pool of members, keyed by PlayerId. Each is in one state:
 *
 *   ARRIVING   flies in over the back of the terrace (`glide`, then `flap`), flares and sets
 *              down with the `land` clip. Also used for a rider who changes seat or side: the
 *              same flight, but starting from the old perch with the `takeoff` clip.
 *   PERCHED    sits in the last pose of `land` (wings folded, the clip holds it). A rider who
 *              readies up plays `roar` once and its glow comes on; then it settles again.
 *   HOPPING    the rider picked another class: the new dragon is swapped in during a short hop.
 *   LEAVING    the rider left the lobby: `takeoff`, then away over the camera; then freed.
 *   LAUNCHING  the host pressed Start: the dragons wait their turn, then `takeoff` and climb
 *              out with `boost`, one after another, all gone before MATCH_TUNING.lobbyLaunchS.
 *
 * WHO LANDS: a rider who joins a lobby we are already watching flies in. The riders who were
 * there before us are simply sitting there when we first look (a full room is not ten
 * landings), and so is everyone when the room comes back from a match. The one exception is
 * our own dragon on the first look: it lands, exactly as the others see it land.
 *
 * `update` allocates nothing: the pool, the view's dragon slots and the scratch arrays are all
 * made once (the view's pool reaches its full size the first time ten dragons are shown).
 */
import {
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
  DRAGON_ANIM_TAKEOFF,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../shared';
import type {
  DragonClassId,
  LobbyPhase,
  LobbyState,
  MutableVec3,
  MutableWorldView,
  PlayerId,
  TeamId,
} from '../../shared';
import {
  AERIE_PERCHES_PER_SIDE,
  AERIE_PERCH_COUNT,
  PERCH_SEAT_HEIGHT,
  perchSlot,
} from './aerie-layout';
import type { AerieLayout, AeriePerch } from './aerie-layout';
import {
  approach,
  clamp01,
  easeIn01,
  easeOut01,
  lerp,
  lerpAngle,
  smooth01,
  writeHermite,
  writeYawPitchRoll,
} from './aerie-math';

export const CAST_FREE = 0;
export const CAST_ARRIVING = 1;
export const CAST_PERCHED = 2;
export const CAST_HOPPING = 3;
export const CAST_LEAVING = 4;
export const CAST_LAUNCHING = 5;

/** Ten seated dragons, and at worst ten more still flying away after a whole room changed. */
export const CAST_POOL_SIZE = AERIE_PERCH_COUNT * 2;

/** Seconds a newcomer flies before it flares over its perch. */
export const ARRIVE_FLIGHT_S = 2.4;
/** The same for a dragon that only changes perch. */
export const MOVE_FLIGHT_S = 1.7;
/** Seconds from the start of the `land` clip until the claws are on the stone. */
export const LAND_TOUCH_S = 0.8;
/** Length of the `roar` clip (every class ships it at 2.2 s). */
export const ROAR_S = 2.2;
export const HOP_S = 0.75;
/** Seconds of the `takeoff` crouch and push before a dragon moves away. */
const LIFT_S = 0.4;
export const LEAVE_S = 2.5;
/** Seconds from a launching dragon's turn until it is out of the picture and freed. */
export const LAUNCH_FLIGHT_S = 1.7;
/** Longest gap between two take-offs of the launch; shorter when ten must fit. */
const LAUNCH_STEP_S = 0.2;
/** The last dragon is gone this long before the launch time is up. */
const LAUNCH_MARGIN_S = 0.1;
/** A ready dragon's glow comes on at this rate per second (about half a second). */
const GLOW_RATE = 6;

/** Metres above and behind its perch that an arriving dragon flares at. */
const FLARE_BEHIND = 4.5;
const FLARE_ABOVE = 3.6;
/** Where a newcomer comes from, relative to its perch: behind the terrace, high, toward the gap. */
const SKY_BEHIND = 92;
const SKY_ABOVE = 40;
const SKY_INWARD = 18;

export interface CastMember {
  state: number;
  playerId: PlayerId;
  team: TeamId;
  classId: DragonClassId;
  /** Perch slot (./aerie-layout.ts) the member sits on or flies to. */
  slot: number;
  ready: boolean;
  /** Eased `ready`, 0..1. */
  glow: number;
  /** Seconds in the current state. */
  timeS: number;
  /** Seconds of the ready roar still to play; 0 = not roaring. */
  roarS: number;
  /** Readied up in the air: roar once it has landed. */
  roarPending: boolean;
  /** LAUNCHING: seconds after the start at which this dragon takes off. */
  launchDelayS: number;
  /** Which sync last saw the rider (to notice who has left). */
  stamp: number;
  // --- Pose written to the view ---------------------------------------------------------------
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vy: number;
  vz: number;
  anim: number;
  flags: number;
  // --- The flight in progress (ARRIVING), or where a take-off began (LEAVING, LAUNCHING) --------
  fromX: number;
  fromY: number;
  fromZ: number;
  fromYaw: number;
  /** Tangent at the start of an arrival, metres per unit of path. */
  tanX: number;
  tanY: number;
  tanZ: number;
  flightS: number;
  /** ARRIVING from another perch: starts with the `takeoff` clip. */
  fromPerch: boolean;
}

export interface AerieCast {
  /** The perched cast for the dragon renderer. Rewritten by `update`. */
  readonly view: MutableWorldView;
  /** The pool; entries in state CAST_FREE are not in the picture. */
  readonly members: readonly Readonly<CastMember>[];
  /** Glow of each perch's shards, 0..1, by perch slot. */
  readonly perchGlow: Float32Array;
  /** 0 in the open lobby; 0..1 over the launch; 1 while the room is in the match. */
  readonly launchProgress: number;
  /** Seconds since the host pressed Start; 0 outside the launch. */
  readonly launchTimeS: number;
  update(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void;
  /** The member a rider is drawn as while it has a perch (not one that is flying away). */
  seated(playerId: PlayerId): Readonly<CastMember> | null;
  reset(): void;
}

function createMember(): CastMember {
  return {
    state: CAST_FREE,
    playerId: NO_PLAYER,
    team: TEAM_EMBER,
    classId: 'talon',
    slot: 0,
    ready: false,
    glow: 0,
    timeS: 0,
    roarS: 0,
    roarPending: false,
    launchDelayS: 0,
    stamp: 0,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    anim: DRAGON_ANIM_LAND,
    flags: DRAGON_FLAG_ALIVE,
    fromX: 0,
    fromY: 0,
    fromZ: 0,
    fromYaw: 0,
    tanX: 0,
    tanY: 0,
    tanZ: 0,
    flightS: ARRIVE_FLIGHT_S,
    fromPerch: false,
  };
}

/** True for the states in which the rider owns a perch (and gets a name card). */
export function isSeatedState(state: number): boolean {
  return (
    state === CAST_ARRIVING ||
    state === CAST_PERCHED ||
    state === CAST_HOPPING ||
    state === CAST_LAUNCHING
  );
}

/**
 * Seconds between two take-offs of a launch of `count` dragons that must all be gone within
 * `launchS`.
 */
export function launchStepS(count: number, launchS: number): number {
  if (count <= 1) return 0;
  const room = launchS - LAUNCH_FLIGHT_S - LAUNCH_MARGIN_S;
  const step = room / (count - 1);
  return step < 0 ? 0 : step > LAUNCH_STEP_S ? LAUNCH_STEP_S : step;
}

/** Load-time: allocates the pool and the view. */
export function createAerieCast(layout: AerieLayout): AerieCast {
  const view = createWorldView();
  // Grow the view's dragon pool to its largest size now, so no frame ever has to.
  for (let i = 0; i < CAST_POOL_SIZE; i++) acquireDragonView(view);
  beginWorldView(view);
  const members: CastMember[] = [];
  for (let i = 0; i < CAST_POOL_SIZE; i++) members.push(createMember());
  const perchGlow = new Float32Array(AERIE_PERCH_COUNT);
  const glowTarget = new Float32Array(AERIE_PERCH_COUNT);
  const scratch: MutableVec3 = { x: 0, y: 0, z: 0 };
  const fallbackPerch = layout.perches[0] as AeriePerch;
  const launchS = MATCH_TUNING.lobbyLaunchS;

  let lastPhase: LobbyPhase | null = null;
  /** True until the first look at a lobby after `reset`: the local dragon then lands. */
  let firstLook = true;
  let stamp = 0;
  let launchTimeS = 0;
  let launchProgress = 0;

  function perchOf(slot: number): AeriePerch {
    return layout.perches[slot] ?? fallbackPerch;
  }

  function findMember(playerId: PlayerId): CastMember | null {
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (member.state !== CAST_FREE && member.playerId === playerId) return member;
    }
    return null;
  }

  /** A free member; when the pool is full, the departing one that has been flying longest. */
  function allocate(): CastMember | null {
    let oldest: CastMember | null = null;
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (member.state === CAST_FREE) return member;
      if (member.state === CAST_LEAVING && (oldest === null || member.timeS > oldest.timeS)) {
        oldest = member;
      }
    }
    return oldest;
  }

  function seatY(member: CastMember, perch: AeriePerch): number {
    return perch.position.y + PERCH_SEAT_HEIGHT[member.classId];
  }

  function perchNow(member: CastMember): void {
    const perch = perchOf(member.slot);
    member.state = CAST_PERCHED;
    member.timeS = 0;
    member.x = perch.position.x;
    member.y = seatY(member, perch);
    member.z = perch.position.z;
    member.yaw = perch.yaw;
    member.pitch = 0;
    member.vx = 0;
    member.vy = 0;
    member.vz = 0;
    member.anim = DRAGON_ANIM_LAND;
  }

  /** Starts a flight to the member's perch: from the sky, or from where it is now. */
  function beginArrival(member: CastMember, fromSky: boolean): void {
    const perch = perchOf(member.slot);
    const fx = Math.sin(perch.yaw);
    const fz = Math.cos(perch.yaw);
    member.state = CAST_ARRIVING;
    member.timeS = 0;
    member.fromPerch = !fromSky;
    if (fromSky) {
      // "Inward" is toward the gap between the terraces: local -x on the right side, +x on the
      // left. In the world that is the perch's right-hand direction, signed by the side.
      const inward = perch.local.x > 0 ? -1 : 1;
      const rx = layout.cosYaw * inward;
      const rz = -layout.sinYaw * inward;
      member.fromX = perch.position.x - fx * SKY_BEHIND + rx * SKY_INWARD;
      member.fromY = perch.position.y + SKY_ABOVE;
      member.fromZ = perch.position.z - fz * SKY_BEHIND + rz * SKY_INWARD;
      member.tanX = fx * 70 - rx * 30;
      member.tanY = -34;
      member.tanZ = fz * 70 - rz * 30;
      member.fromYaw = Math.atan2(member.tanX, member.tanZ);
      member.flightS = ARRIVE_FLIGHT_S;
      member.x = member.fromX;
      member.y = member.fromY;
      member.z = member.fromZ;
      member.yaw = member.fromYaw;
      member.pitch = 0;
      member.vx = 0;
      member.vy = 0;
      member.vz = 0;
    } else {
      member.fromX = member.x;
      member.fromY = member.y;
      member.fromZ = member.z;
      member.fromYaw = member.yaw;
      // Up and out first, so the hop to the next perch is an arc and not a slide.
      member.tanX = fx * 6;
      member.tanY = 34;
      member.tanZ = fz * 6;
      member.flightS = MOVE_FLIGHT_S;
    }
    member.anim = fromSky ? DRAGON_ANIM_GLIDE : DRAGON_ANIM_TAKEOFF;
  }

  function beginTakeoff(member: CastMember, state: number): void {
    member.state = state;
    member.timeS = 0;
    member.fromX = member.x;
    member.fromY = member.y;
    member.fromZ = member.z;
    member.fromYaw = member.yaw;
    member.roarS = 0;
    member.roarPending = false;
  }

  function free(member: CastMember): void {
    member.state = CAST_FREE;
    member.playerId = NO_PLAYER;
    member.ready = false;
    member.glow = 0;
    member.roarS = 0;
    member.roarPending = false;
  }

  function freeAll(): void {
    for (let i = 0; i < members.length; i++) free(members[i] as CastMember);
  }

  /** Follows the lobby's rider list. `instant`: newcomers are simply sitting there. */
  function syncRoster(lobby: LobbyState, localPlayerId: PlayerId, instant: boolean): void {
    stamp++;
    const players = lobby.players;
    for (let i = 0; i < players.length; i++) {
      const player = players[i];
      if (player === undefined || player.side === 'spectator') continue;
      if (player.perch < 0 || player.perch >= AERIE_PERCHES_PER_SIDE) continue;
      const slot = perchSlot(player.side, player.perch);
      let member = findMember(player.id);
      if (member === null) {
        member = allocate();
        if (member === null) continue;
        member.playerId = player.id;
        member.team = player.side;
        member.classId = player.classId;
        member.slot = slot;
        member.ready = player.ready;
        member.roarS = 0;
        member.roarPending = false;
        member.flags = DRAGON_FLAG_ALIVE;
        // Our own dragon lands on the first look; everyone else is already there.
        if (instant && !(firstLook && player.id === localPlayerId)) {
          member.glow = player.ready ? 1 : 0;
          perchNow(member);
        } else {
          member.glow = 0;
          member.roarPending = player.ready;
          beginArrival(member, true);
        }
      } else {
        if (member.state === CAST_LEAVING) {
          // Back before it was out of sight: turn round and land again.
          member.slot = slot;
          member.team = player.side;
          beginArrival(member, false);
        } else if (member.slot !== slot) {
          member.slot = slot;
          member.team = player.side;
          beginArrival(member, false);
        }
        if (member.classId !== player.classId) {
          member.classId = player.classId;
          if (member.state === CAST_PERCHED) {
            member.state = CAST_HOPPING;
            member.timeS = 0;
            member.roarS = 0;
          }
        }
        if (player.ready && !member.ready) {
          if (member.state === CAST_PERCHED) member.roarS = ROAR_S;
          else member.roarPending = true;
        } else if (!player.ready) {
          member.roarPending = false;
        }
        member.ready = player.ready;
      }
      member.stamp = stamp;
    }
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (member.stamp === stamp || !isSeatedState(member.state)) continue;
      member.ready = false;
      beginTakeoff(member, CAST_LEAVING);
    }
  }

  /** The host pressed Start: everybody gets a turn, the seats nearest the middle first. */
  function beginLaunch(): void {
    launchTimeS = 0;
    let count = 0;
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (!isSeatedState(member.state)) continue;
      // A dragon still on its way in is put on its perch: the launch cannot wait for it.
      if (member.state !== CAST_PERCHED) perchNow(member);
      count++;
    }
    const step = launchStepS(count, launchS);
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (member.state !== CAST_PERCHED) continue;
      // Rank in the order "perch 0 Ember, perch 0 Frost, perch 1 Ember, ...".
      const key = (member.slot % AERIE_PERCHES_PER_SIDE) * 2 + member.team;
      let rank = 0;
      for (let k = 0; k < members.length; k++) {
        const other = members[k] as CastMember;
        if (other === member || !isSeatedState(other.state)) continue;
        const otherKey = (other.slot % AERIE_PERCHES_PER_SIDE) * 2 + other.team;
        if (otherKey < key || (otherKey === key && k < i)) rank++;
      }
      beginTakeoff(member, CAST_LAUNCHING);
      member.launchDelayS = rank * step;
    }
  }

  function advanceArrival(member: CastMember): void {
    const perch = perchOf(member.slot);
    const fx = Math.sin(perch.yaw);
    const fz = Math.cos(perch.yaw);
    const flareX = perch.position.x - fx * FLARE_BEHIND;
    const flareY = seatY(member, perch) + FLARE_ABOVE;
    const flareZ = perch.position.z - fz * FLARE_BEHIND;
    const t = member.timeS;
    if (t < member.flightS) {
      const u = t / member.flightS;
      // Time along the path eases out: fast in the sky, braking toward the flare.
      const along = member.fromPerch ? smooth01(u) : 1 - (1 - u) * (1 - u * 0.35);
      writeHermite(
        scratch,
        member.fromX,
        member.fromY,
        member.fromZ,
        member.tanX,
        member.tanY,
        member.tanZ,
        flareX,
        flareY,
        flareZ,
        fx * 16,
        -9,
        fz * 16,
        along,
      );
      member.x = scratch.x;
      member.y = scratch.y;
      member.z = scratch.z;
      member.yaw = lerpAngle(member.fromYaw, perch.yaw, smooth01(u * 1.15));
      // Nose down on the way in, up for the flare.
      member.pitch = member.fromPerch
        ? lerp(0.35, 0.2, u)
        : lerp(-0.2, 0.34, smooth01((u - 0.55) / 0.45));
      if (member.fromPerch) member.anim = t < LIFT_S ? DRAGON_ANIM_TAKEOFF : DRAGON_ANIM_FLAP;
      else member.anim = u < 0.5 ? DRAGON_ANIM_GLIDE : DRAGON_ANIM_FLAP;
    } else {
      // The `land` clip: the last metres down while it flares, then it holds the perched pose.
      const down = easeOut01((t - member.flightS) / LAND_TOUCH_S);
      member.x = lerp(flareX, perch.position.x, down);
      member.y = lerp(flareY, seatY(member, perch), down);
      member.z = lerp(flareZ, perch.position.z, down);
      member.yaw = perch.yaw;
      member.pitch = lerp(member.fromPerch ? 0.2 : 0.34, 0, down);
      member.anim = DRAGON_ANIM_LAND;
      if (t >= member.flightS + LAND_TOUCH_S) {
        perchNow(member);
        if (member.roarPending && member.ready) member.roarS = ROAR_S;
        member.roarPending = false;
      }
    }
  }

  /** `takeoff`, then away along (`dirX`, `dirY`, `dirZ`), accelerating. */
  function advanceDeparture(
    member: CastMember,
    t: number,
    dirX: number,
    dirY: number,
    dirZ: number,
    speed: number,
    acceleration: number,
    boost: boolean,
  ): void {
    const lift = easeIn01(t / LIFT_S) * 2.2;
    const flying = t > LIFT_S ? t - LIFT_S : 0;
    const distance = speed * flying + acceleration * flying * flying;
    member.x = member.fromX + dirX * distance;
    member.y = member.fromY + lift + dirY * distance;
    member.z = member.fromZ + dirZ * distance;
    const turn = smooth01(flying / 0.7);
    member.yaw = lerpAngle(member.fromYaw, Math.atan2(dirX, dirZ), turn);
    member.pitch = lerp(0.3, Math.asin(dirY < -1 ? -1 : dirY > 1 ? 1 : dirY) * 0.8, turn);
    member.anim =
      t < LIFT_S ? DRAGON_ANIM_TAKEOFF : boost ? DRAGON_ANIM_BOOST : DRAGON_ANIM_FLAP;
  }

  function advance(member: CastMember, dtS: number): void {
    const beforeX = member.x;
    const beforeY = member.y;
    const beforeZ = member.z;
    member.timeS += dtS;
    member.glow = approach(member.glow, member.ready ? 1 : 0, GLOW_RATE, dtS);
    let flags = DRAGON_FLAG_ALIVE;
    const perch = perchOf(member.slot);

    if (member.state === CAST_ARRIVING) {
      advanceArrival(member);
    } else if (member.state === CAST_PERCHED) {
      member.x = perch.position.x;
      member.y = seatY(member, perch);
      member.z = perch.position.z;
      member.yaw = perch.yaw;
      member.pitch = 0;
      if (member.roarS > 0) {
        member.roarS = member.roarS > dtS ? member.roarS - dtS : 0;
        member.anim = DRAGON_ANIM_ROAR;
      } else {
        member.anim = DRAGON_ANIM_LAND;
      }
    } else if (member.state === CAST_HOPPING) {
      const u = clamp01(member.timeS / HOP_S);
      member.x = perch.position.x;
      member.y = seatY(member, perch) + Math.sin(u * Math.PI) * 1.4;
      member.z = perch.position.z;
      member.yaw = perch.yaw;
      member.pitch = 0;
      // A beat of the wings, then the `land` clip again: it settles like a fresh landing.
      member.anim = u < 0.45 ? DRAGON_ANIM_FLAP : DRAGON_ANIM_LAND;
      if (u >= 1) perchNow(member);
    } else if (member.state === CAST_LEAVING) {
      // Out over the camera and to its own side of the screen.
      const outward = perch.local.x > 0 ? 1 : -1;
      const lx = 0.5 * outward;
      const lz = 0.62;
      const dirX = lx * layout.cosYaw + lz * layout.sinYaw;
      const dirZ = -lx * layout.sinYaw + lz * layout.cosYaw;
      advanceDeparture(member, member.timeS, dirX, 0.6, dirZ, 7, 13, false);
      if (member.timeS >= LEAVE_S) free(member);
    } else if (member.state === CAST_LAUNCHING) {
      const t = launchTimeS - member.launchDelayS;
      if (t <= 0) {
        member.anim = DRAGON_ANIM_LAND;
      } else {
        // Out over the camera's head, converging over the gap between the terraces: by the
        // time a dragon is freed it is behind the lens.
        const inward = perch.local.x > 0 ? -1 : 1;
        const lx = 0.2 * inward;
        const lz = 0.885;
        const dirX = lx * layout.cosYaw + lz * layout.sinYaw;
        const dirZ = -lx * layout.sinYaw + lz * layout.cosYaw;
        advanceDeparture(member, t, dirX, 0.42, dirZ, 9, 40, true);
        if (t > LIFT_S) flags |= DRAGON_FLAG_BOOSTING;
        if (t >= LAUNCH_FLIGHT_S) free(member);
      }
    }
    if (member.state === CAST_FREE) return;

    // No other flags: they mean things to the sound and effects that may listen to this view
    // (a "ready" dragon is shown by its perch's shards, not by a pretend boost).
    member.flags = flags;
    if (dtS > 1e-5) {
      const inv = 1 / dtS;
      member.vx = (member.x - beforeX) * inv;
      member.vy = (member.y - beforeY) * inv;
      member.vz = (member.z - beforeZ) * inv;
    }
  }

  function writeView(localPlayerId: PlayerId): void {
    beginWorldView(view);
    let local: PlayerId = NO_PLAYER;
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      if (member.state === CAST_FREE) continue;
      const dragon = acquireDragonView(view);
      dragon.id = member.playerId;
      dragon.team = member.team;
      dragon.classId = member.classId;
      dragon.position.x = member.x;
      dragon.position.y = member.y;
      dragon.position.z = member.z;
      writeYawPitchRoll(dragon.orientation, member.yaw, member.pitch, 0);
      dragon.velocity.x = member.vx;
      dragon.velocity.y = member.vy;
      dragon.velocity.z = member.vz;
      dragon.health = 1;
      dragon.stamina = 1;
      dragon.flags = member.flags;
      dragon.anim = member.anim;
      if (member.playerId === localPlayerId) local = localPlayerId;
    }
    view.localDragonId = local;
  }

  function updateGlow(dtS: number): void {
    glowTarget.fill(0);
    for (let i = 0; i < members.length; i++) {
      const member = members[i] as CastMember;
      // Only a dragon that is actually sitting on the stone lights it.
      const sitting =
        member.state === CAST_PERCHED ||
        member.state === CAST_HOPPING ||
        (member.state === CAST_LAUNCHING && launchTimeS <= member.launchDelayS);
      if (!sitting) continue;
      const slot = member.slot;
      if (member.glow > (glowTarget[slot] ?? 0)) glowTarget[slot] = member.glow;
    }
    for (let slot = 0; slot < AERIE_PERCH_COUNT; slot++) {
      perchGlow[slot] = approach(perchGlow[slot] ?? 0, glowTarget[slot] ?? 0, GLOW_RATE, dtS);
    }
  }

  return {
    view,
    members,
    perchGlow,
    get launchProgress(): number {
      return launchProgress;
    },
    get launchTimeS(): number {
      return launchTimeS;
    },

    update(lobby: LobbyState, localPlayerId: PlayerId, dtS: number): void {
      const dt = dtS > 0 ? dtS : 0;
      const phase = lobby.phase;
      if (phase !== lastPhase) {
        if (phase === 'lobby') {
          // First look, or back from a match: everyone is on a perch at once.
          freeAll();
          launchTimeS = 0;
          syncRoster(lobby, localPlayerId, true);
          firstLook = false;
        } else if (phase === 'starting') {
          // Normally the roster is already perched; a late look at a starting room fills it.
          if (lastPhase !== 'lobby') {
            freeAll();
            syncRoster(lobby, localPlayerId, true);
            firstLook = false;
          }
          beginLaunch();
        } else {
          freeAll();
        }
        lastPhase = phase;
      } else if (phase === 'lobby') {
        syncRoster(lobby, localPlayerId, false);
      }

      if (phase === 'starting') {
        launchTimeS += dt;
        launchProgress = clamp01(launchTimeS / launchS);
      } else {
        launchTimeS = 0;
        launchProgress = phase === 'inMatch' ? 1 : 0;
      }

      for (let i = 0; i < members.length; i++) {
        const member = members[i] as CastMember;
        if (member.state !== CAST_FREE) advance(member, dt);
      }
      updateGlow(dt);
      writeView(localPlayerId);
    },

    seated(playerId: PlayerId): Readonly<CastMember> | null {
      for (let i = 0; i < members.length; i++) {
        const member = members[i] as CastMember;
        if (member.playerId === playerId && isSeatedState(member.state)) return member;
      }
      return null;
    },

    reset(): void {
      freeAll();
      lastPhase = null;
      firstLook = true;
      launchTimeS = 0;
      launchProgress = 0;
      perchGlow.fill(0);
      beginWorldView(view);
      view.localDragonId = NO_PLAYER;
    },
  };
}
