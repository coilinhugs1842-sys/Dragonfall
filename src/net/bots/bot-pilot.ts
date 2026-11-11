/**
 * The pilot of a net-bot: seeded, "random but sane" flight. It weaves around a circle of its
 * own inside the arena, changes its mind every second or two (boost, dive, flap, a dodge), and
 * comes back toward the centre when it is far out or too low or high, so a room full of bots
 * keeps flying instead of ending up in the storm wall.
 *
 * Deterministic for a given seed and sequence of calls. `sample` allocates nothing.
 */

import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  GREYBOX_CEILING_Y,
  GREYBOX_FLOOR_Y,
  GREYBOX_STORM_RADIUS,
  TICK_HZ,
  createSeededRandom,
} from '../../shared';
import type { InputFrame } from '../../shared';
import type { BotArena } from '../../sim/bots';
import type { SnapshotOwner } from '../protocol';
import type { ClientInputSampler } from '../session/client-session';
import { steerToCourse } from '../session/pilot';
import type { PilotCourse } from '../session/pilot';

/** The part of the map a bot needs to know: no geometry, just the bowl. */
export type { BotArena };

/** The greybox map's bowl, from the shared map constants (no BVH is built for a bot). */
export const GREYBOX_BOT_ARENA: BotArena = {
  centerX: 0,
  centerZ: 0,
  radius: GREYBOX_STORM_RADIUS,
  floorY: GREYBOX_FLOOR_Y,
  ceilingY: GREYBOX_CEILING_Y,
};

const ACTION_CRUISE = 0;
const ACTION_BOOST = 1;
const ACTION_DIVE = 2;
const ACTION_FLAP = 3;
const ACTION_DODGE_LEFT = 4;
const ACTION_DODGE_RIGHT = 5;

/** Beyond this share of the arena radius the bot stops playing and heads home. */
const HOME_RADIUS_FRACTION = 0.72;
/** Height band it keeps to, as shares of floor..ceiling. */
const LOW_FRACTION = 0.22;
const HIGH_FRACTION = 0.88;

export class BotPilot implements ClientInputSampler {
  private readonly random: () => number;
  private readonly arena: BotArena;
  private readonly course: PilotCourse;
  private readonly weaveYaw: number;
  private readonly weavePitch: number;
  private readonly weaveYawRate: number;
  private readonly weavePitchRate: number;
  private readonly phase: number;
  private step = 0;
  private action = ACTION_CRUISE;
  private actionTicks = 0;
  private dodgePending = false;

  constructor(seed: number, arena: BotArena = GREYBOX_BOT_ARENA) {
    const random = createSeededRandom(seed);
    this.random = random;
    this.arena = arena;
    const band = arena.ceilingY - arena.floorY;
    this.course = {
      centerX: arena.centerX,
      centerZ: arena.centerZ,
      radius: arena.radius * (0.2 + random() * 0.3),
      altitude: arena.floorY + band * (0.4 + random() * 0.3),
      yawBias: 0,
      pitchBias: 0,
    };
    this.weaveYaw = 0.25 + random() * 0.35;
    this.weavePitch = 0.08 + random() * 0.12;
    this.weaveYawRate = (Math.PI * 2) / ((4 + random() * 6) * TICK_HZ);
    this.weavePitchRate = (Math.PI * 2) / ((3 + random() * 4) * TICK_HZ);
    this.phase = random() * Math.PI * 2;
  }

  sample(frame: InputFrame, own: Readonly<SnapshotOwner> | null): void {
    const step = this.step++;
    frame.steerX = 0;
    frame.steerY = 0;
    frame.buttons = 0;
    if (own === null) return;

    const arena = this.arena;
    const course = this.course;
    const dx = own.position.x - arena.centerX;
    const dz = own.position.z - arena.centerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const band = arena.ceilingY - arena.floorY;
    const height = (own.position.y - arena.floorY) / (band > 1 ? band : 1);
    const straying =
      distance > arena.radius * HOME_RADIUS_FRACTION ||
      height < LOW_FRACTION ||
      height > HIGH_FRACTION;

    if (--this.actionTicks <= 0) this.chooseAction();

    if (straying) {
      // No weave and no tricks until it is back inside its band.
      course.yawBias = 0;
      course.pitchBias = 0;
      steerToCourse(own, course, frame);
      return;
    }

    course.yawBias = this.weaveYaw * Math.sin(step * this.weaveYawRate + this.phase);
    course.pitchBias = this.weavePitch * Math.sin(step * this.weavePitchRate + this.phase * 1.7);
    steerToCourse(own, course, frame);

    switch (this.action) {
      case ACTION_BOOST:
        frame.buttons |= BUTTON_BOOST;
        break;
      case ACTION_DIVE:
        // Only from high enough to pull out again.
        if (height > 0.5) {
          frame.buttons |= BUTTON_DIVE;
          frame.steerY = 0;
        }
        break;
      case ACTION_FLAP:
        frame.buttons |= BUTTON_FLAP;
        break;
      case ACTION_DODGE_LEFT:
      case ACTION_DODGE_RIGHT:
        // A dodge is a press edge: one tick down, then released.
        if (this.dodgePending) {
          this.dodgePending = false;
          frame.buttons |=
            this.action === ACTION_DODGE_LEFT ? BUTTON_DODGE_LEFT : BUTTON_DODGE_RIGHT;
        }
        break;
      default:
        break;
    }
  }

  private chooseAction(): void {
    const random = this.random;
    const roll = random();
    this.dodgePending = false;
    if (roll < 0.45) {
      this.action = ACTION_CRUISE;
      this.actionTicks = Math.floor((1 + random() * 2.5) * TICK_HZ);
    } else if (roll < 0.7) {
      this.action = ACTION_BOOST;
      this.actionTicks = Math.floor((0.8 + random() * 1.7) * TICK_HZ);
    } else if (roll < 0.8) {
      this.action = ACTION_DIVE;
      this.actionTicks = Math.floor((0.5 + random() * 0.8) * TICK_HZ);
    } else if (roll < 0.9) {
      this.action = ACTION_FLAP;
      this.actionTicks = Math.floor((0.4 + random() * 0.8) * TICK_HZ);
    } else {
      this.action = roll < 0.95 ? ACTION_DODGE_LEFT : ACTION_DODGE_RIGHT;
      this.actionTicks = Math.floor(0.6 * TICK_HZ);
      this.dodgePending = true;
    }
  }
}
