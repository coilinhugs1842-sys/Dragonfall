/**
 * `?viewer=cine:deathcam`: the death cam (src/cinematics/death-cam.ts) on its own, looping. The
 * local dragon flies straight, goes down, and falls; the dragon that got it circles nearby. The
 * death cam runs for its 3 s, then the stage's chase camera follows the killer until the loop
 * respawns the victim.
 *   &t=<seconds>   start time; the death cam is played up to there first, so with &speed=0 the
 *                  scene is frozen on the right frame of the orbit (the fall is at 1.5 s)
 *   &veil=1        the killer is a veiled enemy: the death cam must not show it
 *   &friendly=1    the killer is a veiled team mate: it may be shown
 *   &swap=1        a second enemy becomes the killer 1.5 s into the orbit
 *   &die=1         the killer dies 1.5 s into the orbit
 *   &reduce=1      the reduce-motion version
 */
import { PerspectiveCamera } from 'three';
import { createDeathCam } from '../../cinematics/death-cam';
import {
  DRAGON_ANIM_BANK_L,
  DRAGON_ANIM_DEATH_FALL,
  DRAGON_ANIM_GLIDE,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_VEILED,
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createWorldView,
} from '../../shared';
import type { DragonClassId, MutableDragonView, MutableWorldView, TeamId } from '../../shared';
import type { CineFrame, CineHarness } from '../cine-viewer';

const PERIOD_S = 7;
/** The local dragon goes down here; before it, it flies straight. */
const DOWN_AT_S = 1.5;
/** `&swap` / `&die`: seconds after the fall at which the killer changes or dies. */
const TWIST_AFTER_S = 1.5;
const VICTIM_SPEED = 45;
const FALL_GRAVITY = 16;
const KILLER_CIRCLE_RADIUS = 70;
const KILLER_SPEED = 52;
const KILLER_BANK = 0.55;
const LOCAL_ID = 0;
const KILLER_ID = 1;
const SECOND_ID = 2;

/** Yaw about +Y (0 = +Z), then roll about the nose (positive = right wing down). */
function writeYawRoll(dragon: MutableDragonView, yaw: number, roll: number): void {
  const sy = Math.sin(yaw * 0.5);
  const cy = Math.cos(yaw * 0.5);
  const sr = Math.sin(roll * 0.5);
  const cr = Math.cos(roll * 0.5);
  dragon.orientation.x = sy * sr;
  dragon.orientation.y = sy * cr;
  dragon.orientation.z = cy * sr;
  dragon.orientation.w = cy * cr;
}

function writeBasics(
  dragon: MutableDragonView,
  id: number,
  team: TeamId,
  classId: DragonClassId,
): void {
  dragon.id = id;
  dragon.team = team;
  dragon.classId = classId;
  dragon.health = 1;
  dragon.stamina = 1;
  dragon.flags = DRAGON_FLAG_ALIVE;
  dragon.anim = DRAGON_ANIM_GLIDE;
}

export function start(harness: CineHarness): void {
  const params = harness.params;
  const assets = harness.loadMatch();
  const map = assets.map;
  const veil = params.get('veil') === '1';
  const friendly = params.get('friendly') === '1';
  const swap = params.get('swap') === '1';
  const die = params.get('die') === '1';

  // Open sky south of the crown, with the claws as a backdrop.
  const well = map.skyWell.position;
  const spotX = well.x;
  const spotY = well.y + 80;
  const spotZ = well.z - 330;

  const deathCam = createDeathCam();
  deathCam.setReduceMotion(params.get('reduce') === '1');
  deathCam.begin(assets.collision);
  harness.setDirector(deathCam);

  const view = createWorldView();
  view.clock.phase = 'playing';
  view.localDragonId = LOCAL_ID;
  const frame: CineFrame = { kind: 'match', view };

  /** A dragon on the killer's circle, `phase` radians round it. */
  function writeCircling(dragon: MutableDragonView, loopS: number, phase: number, lift: number): void {
    const angle = phase + (loopS * KILLER_SPEED) / KILLER_CIRCLE_RADIUS;
    dragon.position.x = spotX + 40 + Math.sin(angle) * KILLER_CIRCLE_RADIUS;
    dragon.position.y = spotY + lift + Math.sin(loopS * 0.9 + phase) * 4;
    dragon.position.z = spotZ + Math.cos(angle) * KILLER_CIRCLE_RADIUS;
    // The heading is the circle's tangent; the yaw grows, which is a left turn: left wing down.
    const yaw = angle + Math.PI / 2;
    dragon.velocity.x = Math.sin(yaw) * KILLER_SPEED;
    dragon.velocity.y = 0;
    dragon.velocity.z = Math.cos(yaw) * KILLER_SPEED;
    writeYawRoll(dragon, yaw, -KILLER_BANK);
    dragon.anim = DRAGON_ANIM_BANK_L;
  }

  /** The whole scene at `loopS` seconds into the loop. */
  function writeScene(out: MutableWorldView, loopS: number): void {
    const downS = loopS - DOWN_AT_S;
    const isDown = downS >= 0;
    const twisted = isDown && downS >= TWIST_AFTER_S;
    beginWorldView(out);

    // The victim: straight and level along +X, then a ballistic, tumbling fall.
    const victim = acquireDragonView(out);
    writeBasics(victim, LOCAL_ID, TEAM_EMBER, 'talon');
    const flown = isDown ? DOWN_AT_S : loopS;
    victim.position.x = spotX - 60 + flown * VICTIM_SPEED;
    victim.position.y = spotY;
    victim.position.z = spotZ;
    victim.velocity.x = VICTIM_SPEED;
    victim.velocity.y = 0;
    victim.velocity.z = 0;
    writeYawRoll(victim, Math.PI / 2, 0);
    if (isDown) {
      // Drag takes the forward speed away over about a second.
      const drift = VICTIM_SPEED * (1 - Math.exp(-downS));
      victim.position.x += drift;
      victim.position.y -= 0.5 * FALL_GRAVITY * downS * downS;
      victim.velocity.x = VICTIM_SPEED * Math.exp(-downS);
      victim.velocity.y = -FALL_GRAVITY * downS;
      writeYawRoll(victim, Math.PI / 2 + downS * 0.8, downS * 2.2);
      victim.health = 0;
      victim.flags = 0;
      victim.anim = DRAGON_ANIM_DEATH_FALL;
    }

    const killer = acquireDragonView(out);
    writeBasics(killer, KILLER_ID, friendly ? TEAM_EMBER : TEAM_FROST, 'tempest');
    writeCircling(killer, loopS, 0.6, 6);
    if (veil || friendly) killer.flags |= DRAGON_FLAG_VEILED;
    if (die && twisted) {
      killer.flags = 0;
      killer.anim = DRAGON_ANIM_DEATH_FALL;
    }

    const second = acquireDragonView(out);
    writeBasics(second, SECOND_ID, TEAM_FROST, 'bastion');
    writeCircling(second, loopS, 0.6 + Math.PI, -10);

    const wall = acquireZoneView(out);
    wall.id = 0;
    wall.kind = 'stormWall';
    wall.team = null;
    wall.position.x = map.colliders.stormCenter.x;
    wall.position.y = 0;
    wall.position.z = map.colliders.stormCenter.z;
    wall.radius = map.colliders.stormRadius;

    out.local.valid = true;
    out.local.killerId = isDown ? (swap && twisted ? SECOND_ID : KILLER_ID) : NO_PLAYER;
    out.local.respawnInS = isDown ? PERIOD_S - loopS : 0;
    out.clock.phaseTimeS = loopS;
  }

  // Play the death cam up to `&t=`: it keeps state from frame to frame (the orbit's angle, the
  // terrain pull-in), so a frozen screenshot needs the frames before it.
  const startParam = Number(params.get('t') ?? '0');
  if (Number.isFinite(startParam) && startParam > 0) {
    const scratch = new PerspectiveCamera();
    const step = 1 / 60;
    for (let s = Math.floor(startParam / PERIOD_S) * PERIOD_S; s < startParam; s += step) {
      writeScene(view, s % PERIOD_S);
      deathCam.direct(scratch, view, step);
    }
  }

  let shown = -1;
  harness.run((_dtS, timeS) => {
    const loopS = timeS % PERIOD_S;
    writeScene(view, loopS);
    // 0 = flying, 1 = the death cam's window, 2 = the chase camera on the killer.
    const state = loopS < DOWN_AT_S ? 0 : loopS < DOWN_AT_S + MATCH_TUNING.deathCamS ? 1 : 2;
    if (state !== shown) {
      shown = state;
      harness.setInfo(state === 0 ? 'flying' : state === 1 ? 'death cam' : 'chase on the killer');
    }
    return frame;
  });
}
