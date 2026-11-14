/**
 * The match intro (T-5.4): what the camera does during the `intro` match phase.
 *
 * MULTI-BEAT (~12 s), as fractions of MATCH_TUNING.matchIntroS (MATCH_INTRO_TIMELINE):
 * 1. Establish — high wide hold on the storm rim (letterbox in, title card up).
 * 2. Dive-in — steep push along the map intro spline toward the sky-well.
 * 3. Hero skim — lower altitude, tighter FOV, look-ahead bias.
 * 4. Far gate — low angle on the opposing team with a slow push-in.
 * 5. Local gate — swing over the local riders into the chase camera pose (no cut into countdown).
 *
 * ONE CLOCK. Every number comes from `view.clock.phaseTimeS` and the frame's dragons; nothing is
 * integrated over `dtS` and nothing is remembered between frames. Every browser therefore shows
 * the same moment (each from its own team's side), a late joiner drops into the right frame, and
 * a hitch cannot make the intro run long.
 *
 * WHERE THE GATES ARE. Read from the dragons, not from the map: during the intro they hover at
 * the gate their mode launches from (Duel uses a closer set), so a team's centroid and mean
 * heading are the gate. A team with nobody in the view falls back to the map's gate.
 *
 * REDUCE MOTION: the flyby becomes a slow straight push-in from the opening viewpoint, the gate
 * shots hold still, and the swing round the local team is replaced by a cut. No roll anywhere.
 *
 * Nothing in `direct` allocates: the scratch vectors are created with the director.
 */
import type { PerspectiveCamera } from 'three';
import { CAMERA_RIG_TUNING, DEFAULT_BASE_FOV } from '../render';
import {
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  createVec3,
  findDragonView,
  otherTeam,
} from '../shared';
import type {
  ArenaMap,
  DragonView,
  MutableVec3,
  SpawnGate,
  TeamId,
  TerrainQuery,
  Vec3,
  WorldView,
} from '../shared';
import {
  aimCamera,
  catmullRomPoint,
  catmullRomTangent,
  clamp,
  clamp01,
  createSplineLengthTable,
  easeCoast,
  easeRamp,
  forwardOfQuat,
  lerp,
  measureSpline,
  pullInFromTerrain,
  setVec3,
  smoothstep,
  splineParamAtFraction,
  wrapAngle,
  yawOfDirection,
} from './camera-math';
import type { MatchIntro } from './types';

// --- Timeline --------------------------------------------------------------------------------------

/**
 * Where each beat starts and ends, as fractions of MATCH_TUNING.matchIntroS (~12 s).
 * Multi-beat “establish → dive → skim → gates” language; one shared clock, no per-client dt.
 */
export const MATCH_INTRO_TIMELINE = {
  /** Title card fully up (~0.6 s). */
  cardInEnd: 0.05,
  /** Card holds through the establish + dive, fades before the far gate. */
  cardOutStart: 0.38,
  cardOutEnd: 0.48,
  /** High wide establish hold ends here. */
  establishEnd: 0.14,
  /** Steep dive-in along the spline ends here. */
  diveInEnd: 0.32,
  /** Low hero skim ends here; then far gate. (Alias: whole flyby arc ends at `flybyEnd`.) */
  heroSkimEnd: 0.52,
  /** Flyby (establish+dive+skim) until here, then the cut to the far team's gate. */
  flybyEnd: 0.52,
  /** Far gate until here, then the cut to the local team's gate, which runs to the end. */
  farGateEnd: 0.72,
} as const;

export type MatchIntroShot = 'establish' | 'diveIn' | 'heroSkim' | 'farGate' | 'localGate';

/** Which shot is on screen at `fraction` (0..1) of the intro. */
export function matchIntroShot(fraction: number): MatchIntroShot {
  const t = MATCH_INTRO_TIMELINE;
  if (fraction < t.establishEnd) return 'establish';
  if (fraction < t.diveInEnd) return 'diveIn';
  if (fraction < t.flybyEnd) return 'heroSkim';
  return fraction < t.farGateEnd ? 'farGate' : 'localGate';
}

/**
 * Title-card opacity at `fraction` (0..1) of the intro: 0 at the start, up within `cardInEnd`,
 * held through the flyby, down to 0 by `cardOutEnd`. Continuous; 0 outside 0..1.
 */
export function matchIntroCardOpacity(fraction: number): number {
  if (!(fraction > 0) || !(fraction < 1)) return 0;
  const timeline = MATCH_INTRO_TIMELINE;
  return (
    smoothstep(0, timeline.cardInEnd, fraction) *
    (1 - smoothstep(timeline.cardOutStart, timeline.cardOutEnd, fraction))
  );
}

// --- Flyby tuning ----------------------------------------------------------------------------------

/** A spline needs this many points; a map with fewer gets the derived default. */
const MIN_SPLINE_POINTS = 4;
/** The camera looks at a point this far ahead on its own path (fraction of the path length). */
const FLYBY_LOOK_AHEAD = 0.16;
/**
 * How much of the view goes to the sky-well rather than to the road ahead, at the start and at
 * the end. High at first (the establishing shot is about the centre), lower as the camera
 * arrives beside it, where staring at it would whip the view round.
 */
const FLYBY_WELL_WEIGHT_START = 0.85;
const FLYBY_WELL_WEIGHT_END = 0.5;
/**
 * Metres above the sky-well the camera aims, at the start and at the end. Aiming high at first
 * keeps the view near level, which puts the low sun and the horizon in frame.
 */
const FLYBY_WELL_LIFT_START = 150;
const FLYBY_WELL_LIFT_END = 12;
const FLYBY_FOV_START = 58;
const FLYBY_FOV_END = 48;
/** Establish hold: wider FOV, then dive kicks in. */
const ESTABLISH_FOV = 64;
const DIVE_FOV = 52;
const SKIM_FOV_START = 50;
const SKIM_FOV_END = 46;
/** Speed is 1.3x the mean on the first frame and 0.4x on the last (see `easeCoast`). */
const FLYBY_BRAKE = 0.28;
/** Bank into the path's turns: radians of roll per radian the heading turns over `BANK_SPAN`. */
const FLYBY_BANK_GAIN = 0.28;
const FLYBY_BANK_SPAN = 0.05;
/** About 3 degrees: readable bank without tipping the horizon. */
const FLYBY_MAX_BANK = 0.055;
/** Reduce motion: metres per second of the straight push-in, and its fixed FOV. */
const REDUCED_DOLLY_SPEED = 20;
const REDUCED_DOLLY_FOV = 56;
/** Reduce motion: the push-in heads for the point this far along the path. */
const REDUCED_DOLLY_AIM = 0.3;

// --- Gate shot tuning ------------------------------------------------------------------------------

const GATE_FOV = 38;
/** Half a wingspan plus air: added to the team's half-width before framing it. */
const GATE_WING_MARGIN = 10;
/** The team spans this much of the frame's width. */
const GATE_FILL = 0.8;
const GATE_MIN_DISTANCE = 26;
const GATE_MAX_DISTANCE = 120;
/** Radians the camera sits below the riders, as seen from them: it looks up at them. */
const GATE_LOW_ANGLE = 0.14;
/** Radians off the team's nose line, toward the sun side: a face-on shot would be flat. */
const GATE_SIDE_ANGLE = 0.24;
/** The push-in: the shot starts this much further out than it ends. */
const GATE_PUSH = 1.13;
/** The camera aims this far above the team's centroid (riders sit above the dragons' origins). */
const GATE_LOOK_LIFT = 1.5;
/** Metres kept between a gate camera and rock. */
const GATE_ROCK_MARGIN = 3;
/**
 * Local gate: radians off the nose line where the swing starts. Further round than this and the
 * riders on the far end of the row hide behind each other.
 */
const LOCAL_START_ANGLE = 0.35;
/**
 * Local gate: metres the swing rises over the row on its way round. The riders hover a wingspan
 * apart, so a level swing would brush past the hero's neighbour; this one passes over it.
 */
const LOCAL_OVER_HEIGHT = 16;
/** Local gate: the swing speeds up over this much of the shot and slows over as much. */
const LOCAL_SWING_RAMP = 0.25;
/** Local gate: starts a little closer than the far gate's shot ends. */
const LOCAL_START_SCALE = 0.92;
/** A local dragon further than this from its team's middle picks the side of the swing. */
const LOCAL_SIDE_DEADZONE = 2;
/** Reduce motion: the local gate shot holds until this fraction of it, then cuts to the end pose. */
const REDUCED_LOCAL_CUT = 0.6;

// --- Default path ----------------------------------------------------------------------------------

/** Rock closer than this to a derived path lifts the path (metres). */
const DEFAULT_PATH_CLEARANCE = 30;
const DEFAULT_PATH_LIFT_STEP = 25;
const DEFAULT_PATH_SAMPLES = 48;
/** An authored spline must keep this far from rock, or the derived path is used instead. */
const AUTHORED_PATH_CLEARANCE = 4;

/**
 * A flyby for a map that has none authored, into `out` (five points, load-time): in from the
 * rim on the side away from the sun, so the sun is in frame, high at first and down toward the
 * sky-well, ending outside its ring. With `terrain` the path is lifted until it is clear of rock.
 */
export function writeDefaultIntroSpline(
  out: MutableVec3[],
  map: ArenaMap,
  terrain: TerrainQuery | null,
): MutableVec3[] {
  const colliders = map.colliders;
  const centre = colliders.stormCenter;
  const radius = colliders.stormRadius;
  const sea = colliders.cloudSeaY;
  const height = Math.max(colliders.ceilingY - sea, 1);
  const well = map.skyWell.position;
  const ring = Math.max(map.skyWell.ringRadius, radius * 0.1);

  // Horizontal unit vector toward the sun, and the one square to it.
  let sx = map.sky.sunDirection.x;
  let sz = map.sky.sunDirection.z;
  const sunLength = Math.sqrt(sx * sx + sz * sz);
  if (sunLength > 1e-3) {
    sx /= sunLength;
    sz /= sunLength;
  } else {
    sx = 1;
    sz = 0;
  }
  const px = sz;
  const pz = -sx;

  while (out.length < 5) out.push(createVec3());
  out.length = 5;
  const wellY = clamp(well.y, sea + height * 0.2, sea + height * 0.8);
  const set = (index: number, back: number, side: number, y: number): void => {
    const point = out[index];
    if (point === undefined) return;
    // The far points hang off the arena centre, the near ones off the sky-well.
    const anchor = index < 3 ? centre : well;
    setVec3(point, anchor.x - sx * back + px * side, y, anchor.z - sz * back + pz * side);
  };
  set(0, radius * 0.92, radius * 0.14, sea + height * 0.66);
  set(1, radius * 0.72, radius * 0.07, sea + height * 0.62);
  set(2, radius * 0.46, 0, sea + height * 0.55);
  set(3, ring * 2.1, -ring * 0.12, wellY + height * 0.14);
  set(4, ring * 1.25, -ring * 0.3, wellY + height * 0.08);

  if (terrain !== null) liftClearOfRock(out, terrain, colliders.ceilingY);
  return out;
}

const liftScratch = createVec3();

/** Raises the whole path, a step at a time, until no sample of it is near rock. Load-time. */
function liftClearOfRock(points: MutableVec3[], terrain: TerrainQuery, ceilingY: number): void {
  for (let pass = 0; pass < 24; pass++) {
    let blocked = false;
    for (let i = 0; i <= DEFAULT_PATH_SAMPLES && !blocked; i++) {
      catmullRomPoint(liftScratch, points, i / DEFAULT_PATH_SAMPLES);
      blocked =
        terrain.clearance(liftScratch.x, liftScratch.y, liftScratch.z, DEFAULT_PATH_CLEARANCE) >= 0;
    }
    if (!blocked) return;
    let moved = false;
    for (const point of points) {
      if (point.y < ceilingY) {
        point.y = Math.min(point.y + DEFAULT_PATH_LIFT_STEP, ceilingY);
        moved = true;
      }
    }
    // Already at the ceiling everywhere: nothing more to try.
    if (!moved) return;
  }
}

/** True when no sample of the path through `points` is within `margin` metres of rock. */
function pathIsClear(points: readonly Vec3[], terrain: TerrainQuery, margin: number): boolean {
  for (let i = 0; i <= DEFAULT_PATH_SAMPLES * 2; i++) {
    catmullRomPoint(liftScratch, points, i / (DEFAULT_PATH_SAMPLES * 2));
    if (terrain.clearance(liftScratch.x, liftScratch.y, liftScratch.z, margin) >= 0) return false;
  }
  return true;
}

// --- Gates -----------------------------------------------------------------------------------------

/** Where a team stands and which way it faces. */
interface GateFrame {
  /** Dragons counted; 0 = the frame came from the map's gate. */
  count: number;
  x: number;
  y: number;
  z: number;
  /** Unit horizontal direction the team faces. */
  fx: number;
  fz: number;
  /** Largest sideways distance of a rider from the middle, metres. */
  halfWidth: number;
}

function createGateFrame(): GateFrame {
  return { count: 0, x: 0, y: 0, z: 0, fx: 0, fz: 1, halfWidth: 0 };
}

const forwardScratch = createVec3();

/** Load-time: the map's own gate as a frame, for a team with nobody in the view. */
function gateFrameOfMap(out: GateFrame, gate: SpawnGate | undefined, centre: Vec3): void {
  out.count = 0;
  if (gate === undefined) {
    out.x = centre.x;
    out.y = centre.y;
    out.z = centre.z;
    out.fx = 0;
    out.fz = 1;
    out.halfWidth = 0;
    return;
  }
  out.x = gate.position.x;
  out.y = gate.position.y;
  out.z = gate.position.z;
  forwardOfQuat(forwardScratch, gate.orientation);
  const length = Math.sqrt(forwardScratch.x * forwardScratch.x + forwardScratch.z * forwardScratch.z);
  out.fx = length > 1e-3 ? forwardScratch.x / length : 0;
  out.fz = length > 1e-3 ? forwardScratch.z / length : 1;
  let half = 0;
  for (const slot of gate.slots) {
    const side = Math.abs((slot.x - out.x) * out.fz - (slot.z - out.z) * out.fx);
    if (side > half) half = side;
  }
  out.halfWidth = half;
}

/**
 * The gate of `team` from this frame's dragons: their centroid, mean heading and half-width.
 * Falls back to `fallback` (the map's gate) when the team has nobody in the view.
 */
function readGateFrame(
  out: GateFrame,
  view: WorldView,
  team: TeamId,
  fallback: GateFrame,
  centre: Vec3,
): void {
  let count = 0;
  let x = 0;
  let y = 0;
  let z = 0;
  let fx = 0;
  let fz = 0;
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon === undefined || dragon.team !== team) continue;
    const position = dragon.position;
    if (!Number.isFinite(position.x + position.y + position.z)) continue;
    count++;
    x += position.x;
    y += position.y;
    z += position.z;
    forwardOfQuat(forwardScratch, dragon.orientation);
    fx += forwardScratch.x;
    fz += forwardScratch.z;
  }
  if (count === 0) {
    out.count = 0;
    out.x = fallback.x;
    out.y = fallback.y;
    out.z = fallback.z;
    out.fx = fallback.fx;
    out.fz = fallback.fz;
    out.halfWidth = fallback.halfWidth;
    return;
  }
  x /= count;
  y /= count;
  z /= count;
  let length = Math.sqrt(fx * fx + fz * fz);
  if (!(length > 0.2 * count)) {
    // The riders do not agree on a heading (or look straight up): face the arena centre.
    fx = centre.x - x;
    fz = centre.z - z;
    length = Math.sqrt(fx * fx + fz * fz);
  }
  if (length > 1e-3) {
    fx /= length;
    fz /= length;
  } else {
    fx = fallback.fx;
    fz = fallback.fz;
  }
  let half = 0;
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon === undefined || dragon.team !== team) continue;
    const side = Math.abs((dragon.position.x - x) * fz - (dragon.position.z - z) * fx);
    if (side > half) half = side;
  }
  out.count = count;
  out.x = x;
  out.y = y;
  out.z = z;
  out.fx = fx;
  out.fz = fz;
  out.halfWidth = Number.isFinite(half) ? half : 0;
}

/** Metres from which a team `halfWidth` wide fills GATE_FILL of the frame at GATE_FOV. */
function gateFramingDistance(halfWidth: number, aspect: number): number {
  const ratio = aspect > 0 && Number.isFinite(aspect) ? aspect : 16 / 9;
  const tanHalfWidth = Math.tan((GATE_FOV * Math.PI) / 360) * ratio;
  return clamp(
    (halfWidth + GATE_WING_MARGIN) / (tanHalfWidth * GATE_FILL),
    GATE_MIN_DISTANCE,
    GATE_MAX_DISTANCE,
  );
}

// --- The director ----------------------------------------------------------------------------------

export function createMatchIntro(): MatchIntro {
  let reduceMotion = false;
  let cardOpacity = 0;

  // Set by `begin`.
  let ready = false;
  let terrain: TerrainQuery | null = null;
  let points: readonly Vec3[] = [];
  const derivedPoints: MutableVec3[] = [];
  const lengths = createSplineLengthTable(96);
  const well = createVec3();
  const centre = createVec3();
  /** Horizontal unit vector toward the sun; (0, 0) when the sun is overhead. */
  let sunX = 0;
  let sunZ = 0;
  const mapGates: readonly [GateFrame, GateFrame] = [createGateFrame(), createGateFrame()];

  // Per-frame scratch.
  const gate = createGateFrame();
  const position = createVec3();
  const target = createVec3();
  const ahead = createVec3();
  const tangent = createVec3();
  const pivot = createVec3();

  /**
   * Flyby beat at path fraction `s` (0..1 of the whole flyby arc) with a per-shot FOV.
   * `e` is 0..1 of the current sub-shot (establish / dive / skim) for ease within the beat.
   */
  function placeFlybyAt(
    camera: PerspectiveCamera,
    s: number,
    e: number,
    fovStart: number,
    fovEnd: number,
    hold: boolean,
  ): void {
    if (reduceMotion) {
      const from = catmullRomPoint(position, points, 0);
      const aim = catmullRomPoint(ahead, points, splineParamAtFraction(lengths, REDUCED_DOLLY_AIM));
      const dx = aim.x - from.x;
      const dy = aim.y - from.y;
      const dz = aim.z - from.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const flybyS = MATCH_TUNING.matchIntroS * MATCH_INTRO_TIMELINE.flybyEnd;
      const travel = length > 1e-3 ? Math.min(REDUCED_DOLLY_SPEED * flybyS * s, length) / length : 0;
      writeFlybyTarget(0);
      position.x += dx * travel;
      position.y += dy * travel;
      position.z += dz * travel;
      aimCamera(camera, position, target, 0, REDUCED_DOLLY_FOV);
      return;
    }
    // Same coast curve for every flyby beat so establish → dive → skim never jumps on the path.
    const coast = easeCoast(s, FLYBY_BRAKE);
    const u = splineParamAtFraction(lengths, coast);
    writeFlybyTarget(coast);
    catmullRomPoint(position, points, u);
    // Establish: lift a little higher so the storm rim reads as a wide plate.
    if (hold) position.y += 18 * (1 - e);

    catmullRomTangent(tangent, points, u);
    const yawNow = yawOfDirection(tangent.x, tangent.z);
    catmullRomTangent(tangent, points, splineParamAtFraction(lengths, coast + FLYBY_BANK_SPAN));
    const turn = wrapAngle(yawOfDirection(tangent.x, tangent.z) - yawNow);
    const roll = hold
      ? 0
      : clamp(-turn * FLYBY_BANK_GAIN, -FLYBY_MAX_BANK, FLYBY_MAX_BANK);
    aimCamera(camera, position, target, roll, lerp(fovStart, fovEnd, e));
  }

  /** Map a sub-shot's local 0..1 onto the flyby arc's 0..1 path fraction. */
  function flybyPathS(shotStart: number, shotEnd: number, e: number): number {
    const flybyEnd = MATCH_INTRO_TIMELINE.flybyEnd;
    if (!(flybyEnd > 0)) return 0;
    return clamp01(lerp(shotStart, shotEnd, e) / flybyEnd);
  }

  /** The flyby's look point at `s` (0..1 of the path's length) into `target`. */
  function writeFlybyTarget(s: number): void {
    const lead = s + FLYBY_LOOK_AHEAD;
    catmullRomPoint(ahead, points, splineParamAtFraction(lengths, lead));
    if (lead > 1) {
      // Past the end of the path: carry on along its last direction.
      catmullRomTangent(tangent, points, 1);
      const beyond = (lead - 1) * lengths.total;
      ahead.x += tangent.x * beyond;
      ahead.y += tangent.y * beyond;
      ahead.z += tangent.z * beyond;
    }
    const weight = lerp(FLYBY_WELL_WEIGHT_START, FLYBY_WELL_WEIGHT_END, s);
    const lift = lerp(FLYBY_WELL_LIFT_START, FLYBY_WELL_LIFT_END, s);
    target.x = lerp(ahead.x, well.x, weight);
    target.y = lerp(ahead.y, well.y + lift, weight);
    target.z = lerp(ahead.z, well.z, weight);
  }

  /** +1 or -1: the side of a team (along its right-hand axis (fz, -fx)) the sun is on. */
  function sunSide(frame: GateFrame): number {
    const dot = frame.fz * sunX - frame.fx * sunZ;
    return dot < -0.05 ? -1 : 1;
  }

  /**
   * A camera `distance` metres (level) from `pivot`, `angle` radians off the team's nose line
   * toward `side`, and `height` metres above it (negative = below), into `position`.
   */
  function writeGatePosition(
    frame: GateFrame,
    distance: number,
    angle: number,
    side: number,
    height: number,
  ): void {
    const along = Math.cos(angle) * distance;
    const across = Math.sin(angle) * distance * side;
    position.x = pivot.x + frame.fx * along + frame.fz * across;
    position.y = pivot.y + height;
    position.z = pivot.z + frame.fz * along - frame.fx * across;
  }

  /** The far team: from in front and below, a slow push-in. `e` is 0..1 of the shot. */
  function placeFarGate(camera: PerspectiveCamera, view: WorldView, team: TeamId, e: number): void {
    readGateFrame(gate, view, team, mapGates[team], centre);
    const reach = gateFramingDistance(gate.halfWidth, camera.aspect);
    const distance = reach * (reduceMotion ? 1 : lerp(GATE_PUSH, 1, e));
    setVec3(pivot, gate.x, gate.y, gate.z);
    writeGatePosition(
      gate,
      distance * Math.cos(GATE_LOW_ANGLE),
      GATE_SIDE_ANGLE,
      sunSide(gate),
      -distance * Math.sin(GATE_LOW_ANGLE),
    );
    setVec3(target, gate.x, gate.y + GATE_LOOK_LIFT, gate.z);
    pullInFromTerrain(position, target, terrain, GATE_ROCK_MARGIN);
    aimCamera(camera, position, target, 0, GATE_FOV);
  }

  /**
   * The local team: the gate view, then round the riders to the chase camera's pose behind
   * `hero` (the local dragon; a spectator gets the team's first rider). `e` is 0..1 of the shot.
   */
  function placeLocalGate(
    camera: PerspectiveCamera,
    view: WorldView,
    team: TeamId,
    hero: DragonView | undefined,
    e: number,
  ): void {
    readGateFrame(gate, view, team, mapGates[team], centre);
    // 0 = the gate view, 1 = the chase pose. Rest to rest, so the riders get a held beat first.
    const w = reduceMotion ? (e < REDUCED_LOCAL_CUT ? 0 : 1) : easeRamp(e, LOCAL_SWING_RAMP);

    // The hero and its nose; with no dragon to follow, the middle of the gate stands in.
    let heroX = gate.x;
    let heroY = gate.y;
    let heroZ = gate.z;
    let noseX = gate.fx;
    let noseY = 0;
    let noseZ = gate.fz;
    if (hero !== undefined && Number.isFinite(hero.position.x + hero.position.y + hero.position.z)) {
      heroX = hero.position.x;
      heroY = hero.position.y;
      heroZ = hero.position.z;
      forwardOfQuat(forwardScratch, hero.orientation);
      noseX = forwardScratch.x;
      noseY = forwardScratch.y;
      noseZ = forwardScratch.z;
    }
    // Swing round the outside of the row when the hero stands off-centre, else on the sun side.
    const offset = (heroX - gate.x) * gate.fz - (heroZ - gate.z) * gate.fx;
    const side = Math.abs(offset) > LOCAL_SIDE_DEADZONE ? (offset > 0 ? 1 : -1) : sunSide(gate);

    // Start: the gate view, three-quarters from the front. Read from the far-gate recipe.
    const startDistance = gateFramingDistance(gate.halfWidth, camera.aspect) * LOCAL_START_SCALE;
    const startRadius = startDistance * Math.cos(GATE_LOW_ANGLE);
    const startHeight = -startDistance * Math.sin(GATE_LOW_ANGLE);
    // End: where the chase camera sits for a hovering dragon (render/camera-rig.ts).
    const rig = CAMERA_RIG_TUNING;
    const endX = heroX - noseX * rig.distance;
    const endY = heroY - noseY * rig.distance + rig.height;
    const endZ = heroZ - noseZ * rig.distance;

    // The swing: round a pivot that slides from the middle of the team to the hero.
    setVec3(pivot, lerp(gate.x, heroX, w), lerp(gate.y, heroY, w), lerp(gate.z, heroZ, w));
    const endRadius = Math.sqrt((endX - heroX) * (endX - heroX) + (endZ - heroZ) * (endZ - heroZ));
    // The circle tightens ahead of the turn: by the time the camera is behind the row it is at
    // chase distance already, so it never swings out past its end pose into the gate's arch.
    const tighten = 1 - (1 - w) * (1 - w);
    writeGatePosition(
      gate,
      lerp(startRadius, endRadius, tighten),
      lerp(LOCAL_START_ANGLE, Math.PI, w),
      side,
      lerp(startHeight, endY - heroY, w) + LOCAL_OVER_HEIGHT * Math.sin(Math.PI * w),
    );
    // The swing ends behind the hero along the TEAM's heading. A hero whose nose points
    // elsewhere gets the difference added over the second half, so the last frame is the chase
    // pose exactly; for a hero in line with its team (the usual case) this adds nothing, and
    // the swing stays one clean arc.
    const land = smoothstep(0.5, 1, w);
    position.x += (endX - (heroX - gate.fx * endRadius)) * land;
    position.z += (endZ - (heroZ - gate.fz * endRadius)) * land;

    // The aim goes from the team to the hero with the swing, and only runs out ahead of the hero
    // (where the chase camera looks) once the camera is behind it: sliding the aim forward while
    // the camera passes the side would add to the turn and make it a whip.
    const leadOut = rig.lookAhead * w * w * w;
    target.x = lerp(gate.x, heroX, w) + noseX * leadOut;
    target.y = lerp(gate.y + GATE_LOOK_LIFT, heroY + rig.lookHeight, w) + noseY * leadOut;
    target.z = lerp(gate.z, heroZ, w) + noseZ * leadOut;

    // Rock: the generous margin of a gate shot shrinks to the chase camera's own by the end.
    pullInFromTerrain(position, pivot, terrain, lerp(GATE_ROCK_MARGIN, rig.collisionMargin, w));
    aimCamera(camera, position, target, 0, lerp(GATE_FOV, DEFAULT_BASE_FOV, w));
  }

  /** The first rider of `team` in the view: who a spectator's intro ends behind. */
  function firstOfTeam(view: WorldView, team: TeamId): DragonView | undefined {
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon !== undefined && dragon.team === team) return dragon;
    }
    return undefined;
  }

  return {
    begin(map: ArenaMap, mapTerrain: TerrainQuery | null): void {
      terrain = mapTerrain;
      setVec3(well, map.skyWell.position.x, map.skyWell.position.y, map.skyWell.position.z);
      const storm = map.colliders.stormCenter;
      setVec3(centre, storm.x, well.y, storm.z);

      const sun = map.sky.sunDirection;
      const sunLength = Math.sqrt(sun.x * sun.x + sun.z * sun.z);
      sunX = sunLength > 1e-3 ? sun.x / sunLength : 0;
      sunZ = sunLength > 1e-3 ? sun.z / sunLength : 0;

      // The authored path, unless the map has none or this layout put rock on it (a map built
      // from another seed moves its filler rocks; the spline was drawn for the default one).
      const authored = map.introSpline;
      if (
        authored !== undefined &&
        authored.length >= MIN_SPLINE_POINTS &&
        (mapTerrain === null || pathIsClear(authored, mapTerrain, AUTHORED_PATH_CLEARANCE))
      ) {
        points = authored;
      } else {
        points = writeDefaultIntroSpline(derivedPoints, map, mapTerrain);
      }
      measureSpline(lengths, points);

      gateFrameOfMap(mapGates[TEAM_EMBER], map.spawnGates[TEAM_EMBER], centre);
      gateFrameOfMap(mapGates[TEAM_FROST], map.spawnGates[TEAM_FROST], centre);
      ready = true;
    },

    direct(camera: PerspectiveCamera, view: WorldView | null, _dtS: number): boolean {
      if (view === null || view.clock.phase !== 'intro') {
        cardOpacity = 0;
        return false;
      }
      const total = MATCH_TUNING.matchIntroS;
      const timeS = view.clock.phaseTimeS;
      // A clock that is not a number yet shows the first frame; one past the end, the last.
      const fraction = total > 0 && timeS > 0 ? clamp01(timeS / total) : 0;
      cardOpacity = matchIntroCardOpacity(fraction);
      if (!ready) return false;

      const timeline = MATCH_INTRO_TIMELINE;
      if (fraction < timeline.establishEnd) {
        const e = fraction / timeline.establishEnd;
        placeFlybyAt(
          camera,
          flybyPathS(0, timeline.establishEnd, e),
          e,
          ESTABLISH_FOV,
          FLYBY_FOV_START,
          true,
        );
        return true;
      }
      if (fraction < timeline.diveInEnd) {
        const e = (fraction - timeline.establishEnd) / (timeline.diveInEnd - timeline.establishEnd);
        placeFlybyAt(
          camera,
          flybyPathS(timeline.establishEnd, timeline.diveInEnd, e),
          e,
          FLYBY_FOV_START,
          DIVE_FOV,
          false,
        );
        return true;
      }
      if (fraction < timeline.flybyEnd) {
        const e = (fraction - timeline.diveInEnd) / (timeline.flybyEnd - timeline.diveInEnd);
        placeFlybyAt(
          camera,
          flybyPathS(timeline.diveInEnd, timeline.flybyEnd, e),
          e,
          SKIM_FOV_START,
          SKIM_FOV_END,
          false,
        );
        return true;
      }
      // A spectator watches from Ember's side.
      const local =
        view.localDragonId !== NO_PLAYER ? findDragonView(view, view.localDragonId) : undefined;
      const localTeam: TeamId = local !== undefined ? local.team : TEAM_EMBER;
      if (fraction < timeline.farGateEnd) {
        const farTeam = otherTeam(localTeam);
        const e = (fraction - timeline.flybyEnd) / (timeline.farGateEnd - timeline.flybyEnd);
        placeFarGate(camera, view, farTeam, e);
        return true;
      }
      const e = (fraction - timeline.farGateEnd) / (1 - timeline.farGateEnd);
      placeLocalGate(camera, view, localTeam, local ?? firstOfTeam(view, localTeam), clamp01(e));
      return true;
    },

    get cardOpacity() {
      return cardOpacity;
    },

    setReduceMotion(on: boolean): void {
      reduceMotion = on;
    },
  };
}
