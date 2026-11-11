/**
 * Measurements for netcode testing, read from outside the game loop (the browser test driver,
 * the devtools console). Created only in dev builds and with `?debug` / `?perf`; normal play
 * has no probe and pays nothing.
 *
 * - `trackFrame`: the per-frame motion metric of every dragon in the WorldView. For a dragon
 *   at `p(n)` with velocity `v(n)` the "jump" of a frame is `|p(n) - (p(n-1) + v(n-1) * dt)|`:
 *   how far it is from where straight flight would have put it. Smooth playback keeps it at a
 *   few centimetres (a turn bends the path a little every frame); rubber-banding shows up as
 *   jumps of metres. A frame in which a dragon moved against its own velocity is counted too.
 * - `trackHostTick`: a ring of the host's authoritative dragon positions per tick, so a client's
 *   interpolated picture can be compared with what the host had at that same (fractional) tick.
 *
 * The tracking functions write numbers into typed arrays and allocate nothing; only `report`
 * builds objects, and it is called by the test driver, not by the game.
 */

import { DRAGON_FLAG_ALIVE, MAX_PLAYERS } from '../shared';
import type { PlayerId, WorldView } from '../shared';
import type { HostViewState } from '../net';

const ID_SLOTS = 256;
const HISTORY_TICKS = 512;
/** A dragon that moved further than this in a frame was respawned or snapped; not a jump. */
const TELEPORT_M = 40;
/** Slower than this (m/s) a "backward" frame says nothing. */
const BACKWARD_MIN_SPEED = 5;
/** Frames longer than this (s) are pauses, not motion samples. */
const MAX_FRAME_S = 0.1;

export interface MotionReport {
  readonly frames: number;
  readonly maxJumpM: number;
  readonly meanJumpM: number;
  readonly backwardFrames: number;
  /** The furthest a dragon went back along its own velocity in one frame, metres. */
  readonly maxBackwardM: number;
  readonly teleports: number;
}

export interface DebugProbe {
  /** After the frame's WorldView is built. `dtS` is the real time since the last frame. */
  trackFrame(view: WorldView, dtS: number): void;
  /** Host: after a sim step (or when its state arrives from the host worker). */
  trackHostTick(tick: number, state: Readonly<HostViewState>): void;
  /** Forget the motion statistics (not the host history). */
  resetMotion(): void;
  /** Motion of the dragons this page does not fly. */
  remoteMotion(): MotionReport;
  /** Motion of the local dragon (dodge and flap impulses are real jumps here). */
  localMotion(): MotionReport;
  /**
   * The host's position of dragon `id` at a fractional tick (lerped between the two ticks
   * around it), or null when either tick is not in the history.
   */
  hostPositionAt(id: PlayerId, tick: number): { x: number; y: number; z: number } | null;
}

interface MotionStats {
  frames: number;
  max: number;
  sum: number;
  backward: number;
  maxBackward: number;
  teleports: number;
}

function createStats(): MotionStats {
  return { frames: 0, max: 0, sum: 0, backward: 0, maxBackward: 0, teleports: 0 };
}

function reportOf(stats: MotionStats): MotionReport {
  return {
    frames: stats.frames,
    maxJumpM: stats.max,
    meanJumpM: stats.frames > 0 ? stats.sum / stats.frames : 0,
    backwardFrames: stats.backward,
    maxBackwardM: stats.maxBackward,
    teleports: stats.teleports,
  };
}

export function createDebugProbe(): DebugProbe {
  // Last frame's pose per dragon id: x, y, z, vx, vy, vz.
  const last = new Float64Array(ID_SLOTS * 6);
  // The frame counter value at which the id was last seen (0 = never).
  const seenFrame = new Uint32Array(ID_SLOTS);
  // Starts at 1 so that 'seen in the previous frame' can never match the 0 of 'never seen'.
  let frame = 1;
  const remote = createStats();
  const local = createStats();

  const historyTick = new Int32Array(HISTORY_TICKS).fill(-1);
  const historyId = new Int16Array(HISTORY_TICKS * MAX_PLAYERS).fill(-1);
  const historyPos = new Float32Array(HISTORY_TICKS * MAX_PLAYERS * 3);

  function resetStats(stats: MotionStats): void {
    stats.frames = 0;
    stats.max = 0;
    stats.sum = 0;
    stats.backward = 0;
    stats.maxBackward = 0;
    stats.teleports = 0;
  }

  /** Index into `historyPos` of dragon `id` at whole tick `tick`, or -1. */
  function historyIndex(id: PlayerId, tick: number): number {
    const row = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
    if (historyTick[row] !== tick) return -1;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (historyId[row * MAX_PLAYERS + i] === id) return (row * MAX_PLAYERS + i) * 3;
    }
    return -1;
  }

  return {
    trackFrame(view: WorldView, dtS: number): void {
      frame++;
      const usable = dtS > 0 && dtS <= MAX_FRAME_S;
      for (let i = 0; i < view.dragonCount; i++) {
        const dragon = view.dragons[i];
        if (dragon === undefined || dragon.id < 0 || dragon.id >= ID_SLOTS) continue;
        const base = dragon.id * 6;
        const x = dragon.position.x;
        const y = dragon.position.y;
        const z = dragon.position.z;
        const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
        if (usable && alive && seenFrame[dragon.id] === frame - 1) {
          const stats = dragon.id === view.localDragonId ? local : remote;
          const px = last[base] ?? 0;
          const py = last[base + 1] ?? 0;
          const pz = last[base + 2] ?? 0;
          const vx = last[base + 3] ?? 0;
          const vy = last[base + 4] ?? 0;
          const vz = last[base + 5] ?? 0;
          const mx = x - px;
          const my = y - py;
          const mz = z - pz;
          const moved = Math.sqrt(mx * mx + my * my + mz * mz);
          if (moved > TELEPORT_M) {
            stats.teleports++;
          } else {
            const ex = mx - vx * dtS;
            const ey = my - vy * dtS;
            const ez = mz - vz * dtS;
            const jump = Math.sqrt(ex * ex + ey * ey + ez * ez);
            stats.frames++;
            stats.sum += jump;
            if (jump > stats.max) stats.max = jump;
            const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
            const along = mx * vx + my * vy + mz * vz;
            if (speed > BACKWARD_MIN_SPEED && along < 0) {
              stats.backward++;
              const back = -along / speed;
              if (back > stats.maxBackward) stats.maxBackward = back;
            }
          }
        }
        last[base] = x;
        last[base + 1] = y;
        last[base + 2] = z;
        last[base + 3] = dragon.velocity.x;
        last[base + 4] = dragon.velocity.y;
        last[base + 5] = dragon.velocity.z;
        // A dead dragon breaks the chain: its fall and respawn are not playback quality.
        seenFrame[dragon.id] = alive ? frame : 0;
      }
    },

    trackHostTick(tick: number, state: Readonly<HostViewState>): void {
      const row = ((tick % HISTORY_TICKS) + HISTORY_TICKS) % HISTORY_TICKS;
      historyTick[row] = tick;
      for (let i = 0; i < MAX_PLAYERS; i++) {
        const dragon = state.dragons[i];
        const slot = row * MAX_PLAYERS + i;
        if (dragon === undefined || !dragon.active) {
          historyId[slot] = -1;
          continue;
        }
        historyId[slot] = dragon.id;
        historyPos[slot * 3] = dragon.position.x;
        historyPos[slot * 3 + 1] = dragon.position.y;
        historyPos[slot * 3 + 2] = dragon.position.z;
      }
    },

    resetMotion(): void {
      resetStats(remote);
      resetStats(local);
      seenFrame.fill(0);
    },

    remoteMotion: () => reportOf(remote),
    localMotion: () => reportOf(local),

    hostPositionAt(id: PlayerId, tick: number) {
      const whole = Math.floor(tick);
      const t = tick - whole;
      const a = historyIndex(id, whole);
      const b = t > 0 ? historyIndex(id, whole + 1) : a;
      if (a < 0 || b < 0) return null;
      const ax = historyPos[a] ?? 0;
      const ay = historyPos[a + 1] ?? 0;
      const az = historyPos[a + 2] ?? 0;
      return {
        x: ax + ((historyPos[b] ?? 0) - ax) * t,
        y: ay + ((historyPos[b + 1] ?? 0) - ay) * t,
        z: az + ((historyPos[b + 2] ?? 0) - az) * t,
      };
    },
  };
}
