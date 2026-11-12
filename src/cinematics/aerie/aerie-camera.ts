/**
 * The lobby camera. Four shots, and an ease between them:
 *
 *   WIDE    both terraces, drifting slowly round a small closed loop. The distance is fitted to
 *           the picture's shape so the ten perches stay inside the middle band of the screen
 *           (the lobby panels dock left and right) from 4:3 to 21:9.
 *   FOCUS   a close three-quarter-front look at one rider's dragon, from a little below its
 *           eye line: for the class picker.
 *   LAUNCH  the host pressed Start: push in, then tilt up after the dragons as they leave over
 *           the camera's head.
 *   (reduce motion) one fixed wide shot; changes of shot are cuts.
 *
 * A shot is a pose: where the camera is, what it looks at, its field of view. Changing shot
 * remembers the pose on screen and blends from it, so a change in the middle of an ease does
 * not jump. Allocation-free after creation.
 */
import type { PerspectiveCamera } from 'three';
import { NO_PLAYER } from '../../shared';
import type { MutableVec3, PlayerId, Vec3 } from '../../shared';
import { aerieToWorld } from './aerie-layout';
import type { AerieLayout, AeriePerch } from './aerie-layout';
import { clamp01, lerp, smooth01, writeClosedSpline } from './aerie-math';

/** Vertical field of view of the wide shot, degrees: long-ish, so the cliff stacks up behind. */
export const WIDE_FOV = 34;
/** Seconds to ease from one shot to another. */
export const SHOT_EASE_S = 0.8;
/** Seconds for one lap of the drift. */
const DRIFT_PERIOD_S = 80;

/** Half the width (metres) the wide shot must hold: the outer perches plus a folded wing. */
const FRAME_HALF_WIDTH = 25.5;
/** Half the height it must hold: terrace lip to the heads of the back row. */
const FRAME_HALF_HEIGHT = 9;
/** Share of the screen's width the perches may take (the rest is for the docked panels). */
const BAND_WIDTH = 0.74;
/** Share of the screen's height they may take. */
const BAND_HEIGHT = 0.62;
/** The wide shot looks at this local point (between the two rows, at chest height). */
const WIDE_TARGET: Vec3 = { x: 0, y: 7, z: -3 };
/**
 * Camera height of the wide shot, local: about the front row's eye line, looking very slightly
 * up, so the dragons stand against the horizon and the sky and not against the terrace floor.
 */
const WIDE_EYE_Y = 5.5;

/** The drift loop: offsets from the wide camera position, local metres (x, y, z per point). */
const DRIFT_LOOP: readonly number[] = [
  -5, 0, 0,
  -2.5, 1.4, -3,
  3.5, 1.8, -2.5,
  5.5, 0.3, 1,
  1.5, -0.9, 3,
  -3.5, -0.6, 2.5,
];

/** Close-up: metres from the dragon, how far round to its side, and the lens. */
const FOCUS_DISTANCE = 12;
const FOCUS_SIDE_ANGLE = 0.5;
/** A longer lens than the wide shot's: the neighbours on the row stay out of the picture. */
const FOCUS_FOV = 30;
/** What the close-up looks at, above the perch stone and forward of it (the chest and head). */
const FOCUS_TARGET_UP = 2.9;
const FOCUS_TARGET_FORWARD = 1.0;
/** Camera height above the perch stone: below the head, looking up at it a little. */
const FOCUS_EYE_UP = 1.9;

interface Pose {
  px: number;
  py: number;
  pz: number;
  tx: number;
  ty: number;
  tz: number;
  fov: number;
}

function createPose(): Pose {
  return { px: 0, py: 0, pz: 1, tx: 0, ty: 0, tz: 0, fov: WIDE_FOV };
}

function copyPose(out: Pose, from: Pose): void {
  out.px = from.px;
  out.py = from.py;
  out.pz = from.pz;
  out.tx = from.tx;
  out.ty = from.ty;
  out.tz = from.tz;
  out.fov = from.fov;
}

/**
 * Distance (metres) from which a frame `halfWidth` x `halfHeight` fills the given shares of a
 * picture of this shape, at vertical field of view `fovDeg`.
 */
export function fitDistance(
  aspect: number,
  fovDeg: number,
  halfWidth: number,
  halfHeight: number,
  bandWidth: number,
  bandHeight: number,
): number {
  const tanV = Math.tan((fovDeg * Math.PI) / 360);
  const tanH = tanV * (aspect > 0.1 ? aspect : 0.1);
  const byWidth = halfWidth / (bandWidth * tanH);
  const byHeight = halfHeight / (bandHeight * tanV);
  return byWidth > byHeight ? byWidth : byHeight;
}

/** The distance of the wide shot for a picture of this shape. */
export function wideDistance(aspect: number): number {
  return fitDistance(aspect, WIDE_FOV, FRAME_HALF_WIDTH, FRAME_HALF_HEIGHT, BAND_WIDTH, BAND_HEIGHT);
}

export interface AerieCamera {
  /** NO_PLAYER when the wide shot is on. */
  readonly focusId: PlayerId;
  /**
   * Where the wide shot's camera stands for the last picture shape seen (the middle of the
   * drift): name cards are sized against the distance from here.
   */
  readonly wideEye: Vec3;
  /** `perch` null = back to the wide shot. */
  focus(playerId: PlayerId, perch: AeriePerch | null): void;
  /** The focused dragon moved to another perch: follow it there. */
  retarget(perch: AeriePerch): void;
  setReduceMotion(on: boolean): void;
  /** Forget everything: the next frame is the wide shot, uneased. */
  reset(): void;
  /**
   * Per frame: places `camera`. `launchProgress` above 0 plays the launch shot. Sets the field
   * of view (and refreshes the projection when it or the picture's shape changed).
   */
  direct(camera: PerspectiveCamera, launchProgress: number, dtS: number): void;
}

export function createAerieCamera(layout: AerieLayout): AerieCamera {
  const wanted = createPose();
  const from = createPose();
  const shown = createPose();
  const scratch: MutableVec3 = { x: 0, y: 0, z: 0 };
  const wideEye: MutableVec3 = { x: 0, y: 0, z: 0 };

  let focusId: PlayerId = NO_PLAYER;
  let focusPerch: AeriePerch | null = null;
  let reduceMotion = false;
  /** 0..1 through the ease from `from` to the wanted shot; 1 = on the shot. */
  let ease = 1;
  /** False until the first frame: there is nothing on screen to ease from. */
  let started = false;
  let launching = false;
  let driftS = 0;
  let lastAspect = -1;
  // Until the first frame tells the picture's shape, assume 16:9.
  aerieToWorld(layout, 0, WIDE_EYE_Y, WIDE_TARGET.z + wideDistance(16 / 9), wideEye);

  /** Start an ease from what is on screen now (or cut, under reduce motion). */
  function changeShot(): void {
    if (!started || reduceMotion) {
      ease = 1;
      return;
    }
    copyPose(from, shown);
    ease = 0;
  }

  function writeWide(out: Pose, aspect: number, drift: boolean): void {
    const distance = wideDistance(aspect);
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (drift) {
      writeClosedSpline(scratch, DRIFT_LOOP, driftS / DRIFT_PERIOD_S);
      ox = scratch.x;
      oy = scratch.y;
      oz = scratch.z;
    }
    aerieToWorld(layout, ox, WIDE_EYE_Y + oy, WIDE_TARGET.z + distance + oz, scratch);
    out.px = scratch.x;
    out.py = scratch.y;
    out.pz = scratch.z;
    // The target moves a little with the camera: the two rows slide against each other.
    aerieToWorld(layout, ox * 0.2, WIDE_TARGET.y + oy * 0.3, WIDE_TARGET.z, scratch);
    out.tx = scratch.x;
    out.ty = scratch.y;
    out.tz = scratch.z;
    out.fov = WIDE_FOV;
  }

  function writeFocus(out: Pose, perch: AeriePerch): void {
    const fx = Math.sin(perch.yaw);
    const fz = Math.cos(perch.yaw);
    out.tx = perch.position.x + fx * FOCUS_TARGET_FORWARD;
    out.ty = perch.position.y + FOCUS_TARGET_UP;
    out.tz = perch.position.z + fz * FOCUS_TARGET_FORWARD;
    // From the front of the aerie and a little to the dragon's own side of it. The dragons are
    // toed in toward the gap, so this is a three-quarter view of every one of them, and the
    // neighbours on its row fall outside the picture instead of lining up behind its head.
    const heading = layout.yaw + (perch.local.x > 0 ? FOCUS_SIDE_ANGLE : -FOCUS_SIDE_ANGLE);
    out.px = out.tx + Math.sin(heading) * FOCUS_DISTANCE;
    out.py = perch.position.y + FOCUS_EYE_UP;
    out.pz = out.tz + Math.cos(heading) * FOCUS_DISTANCE;
    out.fov = FOCUS_FOV;
  }

  function writeLaunch(out: Pose, aspect: number, progress: number): void {
    writeWide(out, aspect, !reduceMotion);
    if (reduceMotion) return;
    // Push in over the first half...
    const push = smooth01(progress * 1.8);
    out.px = lerp(out.px, out.tx, push * 0.34);
    out.py = lerp(out.py, out.ty - 3, push * 0.34);
    out.pz = lerp(out.pz, out.tz, push * 0.34);
    // ...then look up after the dragons as they pass overhead.
    const tilt = smooth01((progress - 0.22) / 0.78);
    out.ty += tilt * tilt * 58 + tilt * 10;
    out.fov = lerp(WIDE_FOV, 46, push);
  }

  return {
    get focusId(): PlayerId {
      return focusId;
    },
    wideEye,

    focus(playerId: PlayerId, perch: AeriePerch | null): void {
      const nextId = perch === null ? NO_PLAYER : playerId;
      if (nextId === focusId && perch === focusPerch) return;
      focusId = nextId;
      focusPerch = perch;
      changeShot();
    },

    retarget(perch: AeriePerch): void {
      if (focusId === NO_PLAYER || perch === focusPerch) return;
      focusPerch = perch;
      changeShot();
    },

    setReduceMotion(on: boolean): void {
      if (on === reduceMotion) return;
      reduceMotion = on;
      ease = 1;
    },

    reset(): void {
      focusId = NO_PLAYER;
      focusPerch = null;
      ease = 1;
      started = false;
      launching = false;
      driftS = 0;
    },

    direct(camera: PerspectiveCamera, launchProgress: number, dtS: number): void {
      const dt = dtS > 0 ? dtS : 0;
      const aspect = camera.aspect;
      const nowLaunching = launchProgress > 0;
      if (nowLaunching !== launching) {
        launching = nowLaunching;
        // The launch takes the camera from wherever it is; a close-up does not survive it.
        focusId = NO_PLAYER;
        focusPerch = null;
        // Into the launch: an ease. Out of it (back from the match): the lobby simply opens
        // on its wide shot.
        if (nowLaunching) changeShot();
        else ease = 1;
      }

      if (launching) {
        writeLaunch(wanted, aspect, launchProgress);
      } else if (focusPerch !== null) {
        writeFocus(wanted, focusPerch);
      } else {
        // The drift only runs while it is the shot on screen: coming back from a close-up
        // lands where the camera left.
        if (!reduceMotion) driftS += dt;
        writeWide(wanted, aspect, !reduceMotion);
      }

      if (ease < 1) ease = clamp01(ease + dt / SHOT_EASE_S);
      if (ease >= 1) {
        copyPose(shown, wanted);
      } else {
        const k = smooth01(ease);
        shown.px = lerp(from.px, wanted.px, k);
        shown.py = lerp(from.py, wanted.py, k);
        shown.pz = lerp(from.pz, wanted.pz, k);
        shown.tx = lerp(from.tx, wanted.tx, k);
        shown.ty = lerp(from.ty, wanted.ty, k);
        shown.tz = lerp(from.tz, wanted.tz, k);
        shown.fov = lerp(from.fov, wanted.fov, k);
      }
      started = true;

      camera.position.set(shown.px, shown.py, shown.pz);
      camera.up.set(0, 1, 0);
      camera.lookAt(shown.tx, shown.ty, shown.tz);
      // The camera is shared with the match's shots, so its own values are what is compared.
      if (camera.fov !== shown.fov || aspect !== lastAspect) {
        camera.fov = shown.fov;
        camera.updateProjectionMatrix();
      }
      if (aspect !== lastAspect) {
        lastAspect = aspect;
        aerieToWorld(layout, 0, WIDE_EYE_Y, WIDE_TARGET.z + wideDistance(aspect), wideEye);
      }
    },
  };
}
