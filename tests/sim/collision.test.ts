/**
 * Terrain bounces and the storm wall (T-1.7), driven through the real sim. The hand-made maps
 * use axis-aligned boxes so "inside the rock" can be checked analytically, the greybox map
 * checks the same invariant against the BVH itself.
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_FLAP,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  FLIGHT_TUNING,
  GREYBOX_GATE_ARCH_CLEARANCE,
  GREYBOX_GATE_ARCH_DISTANCE,
  MATCH_TUNING,
  MAX_PLAYERS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
  TICK_HZ,
  COLLISION_TUNING,
  createGreyboxSpires,
  createInputFrame,
  createSeededRandom,
} from '../../src/shared';
import type {
  BoxSolid,
  CollisionTuning,
  DragonClassId,
  FlightTuning,
  InputFrame,
  MapSolid,
  MatchTuning,
  TerrainQuery,
  Vec3,
} from '../../src/shared';
import { createSim, secondsToTicks } from '../../src/sim';
import type { DragonState, Sim } from '../../src/sim';
import { createMapCollisionWorld } from '../../src/sim/collision';
import type { CollisionMapSource, MapCollisionWorld } from '../../src/sim/collision';

// --- Rig -------------------------------------------------------------------------------------------

function box(x: number, y: number, z: number, sx: number, sy: number, sz: number): BoxSolid {
  return {
    kind: 'box',
    role: 'stone',
    position: { x, y, z },
    yaw: 0,
    pitch: 0,
    roll: 0,
    size: { x: sx, y: sy, z: sz },
  };
}

function makeMap(solids: readonly MapSolid[]): CollisionMapSource {
  return {
    size: 2000,
    solids,
    chunkSize: 250,
    colliders: {
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: 1000,
      ceilingY: 700,
      floorY: -40,
    },
  };
}

/** A 40 x 400 x 40 m pillar on the origin: faces at x, z = +-20, top at y = 400. */
const PILLAR = box(0, 200, 0, 40, 400, 40);

/** Distance from a point to an axis-aligned box solid; 0 inside it. */
function distanceToBox(solid: BoxSolid, p: Vec3): number {
  const dx = Math.max(Math.abs(p.x - solid.position.x) - solid.size.x * 0.5, 0);
  const dy = Math.max(Math.abs(p.y - solid.position.y) - solid.size.y * 0.5, 0);
  const dz = Math.max(Math.abs(p.z - solid.position.z) - solid.size.z * 0.5, 0);
  return Math.hypot(dx, dy, dz);
}

interface Hit {
  tick: number;
  impactSpeed: number;
  damage: number;
  normal: Vec3;
}

interface Rig {
  readonly sim: Sim;
  readonly world: MapCollisionWorld;
  readonly flight: FlightTuning;
  readonly tuning: CollisionTuning;
  readonly input: InputFrame;
  readonly hits: Hit[];
  dragon(): DragonState;
  step(ticks?: number): void;
  readonly tick: number;
}

interface RigOptions {
  classId?: DragonClassId;
  position?: Vec3;
  yaw?: number;
  spawnProtectionS?: number;
  match?: Partial<MatchTuning>;
}

/** One dragon (player 0) on private copies of every tuning table. */
function makeRig(map: CollisionMapSource, options: RigOptions = {}): Rig {
  const flight: FlightTuning = { ...FLIGHT_TUNING };
  const tuning: CollisionTuning = { ...COLLISION_TUNING };
  const match: MatchTuning = {
    ...MATCH_TUNING,
    spawnProtectionS: options.spawnProtectionS ?? 0,
    ...options.match,
  };
  const hits: Hit[] = [];
  let tick = 0;
  const world = createMapCollisionWorld(map, {
    collisionTuning: tuning,
    matchTuning: match,
    onTerrainHit(_dragon, impactSpeed, damage, _px, _py, _pz, nx, ny, nz) {
      hits.push({ tick, impactSpeed, damage, normal: { x: nx, y: ny, z: nz } });
    },
  });
  const sim = createSim({ flightTuning: flight, matchTuning: match, collisionWorld: world });
  sim.spawnDragon(
    0,
    TEAM_EMBER,
    options.classId ?? 'tempest',
    options.position ?? { x: 0, y: 200, z: -150 },
    options.yaw ?? 0,
  );
  const input = createInputFrame();
  const inputs = [input];
  return {
    sim,
    world,
    flight,
    tuning,
    input,
    hits,
    dragon() {
      const dragon = sim.getDragon(0);
      if (dragon === undefined) throw new Error('player 0 has no dragon');
      return dragon;
    },
    step(ticks = 1) {
      for (let i = 0; i < ticks; i++) {
        input.tick = tick;
        sim.step(tick, inputs);
        tick++;
      }
    },
    get tick() {
      return tick;
    },
  };
}

function isAlive(dragon: DragonState): boolean {
  return (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
}

function collectNumbers(node: unknown, path: string, out: [string, number][]): [string, number][] {
  if (typeof node === 'number') out.push([path, node]);
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) collectNumbers(value, `${path}.${key}`, out);
  }
  return out;
}

function expectFinite(dragon: DragonState, label: string): void {
  for (const [path, value] of collectNumbers(dragon, 'dragon', [])) {
    if (!Number.isFinite(value)) throw new Error(`${label}: ${path} is ${value}`);
  }
}

/** Slack for float32 vertices and the push-out skin. */
const CLEAR_SLACK = 1e-3;

function radiusOf(dragon: DragonState): number {
  return CLASS_TUNING[dragon.classId].hitRadius;
}

/** The dragon's sphere does not overlap any of the boxes. */
function expectClearOfBoxes(dragon: DragonState, solids: readonly BoxSolid[], label: string): void {
  for (const solid of solids) {
    const distance = distanceToBox(solid, dragon.position);
    if (distance < radiusOf(dragon) - CLEAR_SLACK) {
      const p = dragon.position;
      throw new Error(
        `${label}: sphere overlaps a box (distance ${distance}) at ${p.x}, ${p.y}, ${p.z}`,
      );
    }
  }
}

/**
 * Distance from the point to the terrain, negative when the point is inside a solid: straight
 * behind its nearest face. (Next to a sharp edge an outside point can be behind the PLANE of one
 * of the edge's faces, but never straight behind the face itself.)
 */
function signedTerrainDistance(world: MapCollisionWorld, p: Vec3): number {
  const terrain = world.terrain;
  if (terrain === null) throw new Error('map has no terrain');
  const distance = terrain.closestPoint(p.x, p.y, p.z, Infinity);
  const t = terrain.closestTriangle;
  const facing =
    (p.x - terrain.closestX) * terrain.faceNormalX(t) +
    (p.y - terrain.closestY) * terrain.faceNormalY(t) +
    (p.z - terrain.closestZ) * terrain.faceNormalZ(t);
  return facing < -0.99 * distance ? -distance : distance;
}

/** The dragon's sphere does not overlap the BVH terrain and its centre is not inside a solid. */
function expectClearOfTerrain(dragon: DragonState, world: MapCollisionWorld, label: string): void {
  const distance = signedTerrainDistance(world, dragon.position);
  if (distance < radiusOf(dragon) - CLEAR_SLACK) {
    throw new Error(`${label}: sphere overlaps terrain (signed distance ${distance})`);
  }
}

// --- Terrain: head-on ----------------------------------------------------------------------------

describe('terrain: flying straight at a pillar', () => {
  it('bounces away at cruise speed, takes damage once and never enters the rock', () => {
    const rig = makeRig(makeMap([PILLAR]));
    const startHealth = rig.dragon().health;
    let minZAfterHit = Infinity;
    for (let i = 0; i < 240; i++) {
      rig.step();
      const dragon = rig.dragon();
      expectFinite(dragon, `tick ${i}`);
      expectClearOfBoxes(dragon, [PILLAR], `tick ${i}`);
      if (rig.hits.length > 0) minZAfterHit = Math.min(minZAfterHit, dragon.position.z);
    }
    const first = rig.hits[0];
    if (first === undefined) throw new Error('never hit the pillar');
    // Head-on: the normal faces the dragon (-Z) and the impact is the whole cruise speed.
    expect(first.normal.z).toBeLessThan(-0.99);
    expect(first.impactSpeed).toBeGreaterThan(rig.flight.cruiseSpeed - 2);
    expect(first.impactSpeed).toBeLessThan(rig.flight.cruiseSpeed + 2);
    expect(first.damage).toBeCloseTo(
      (first.impactSpeed - rig.tuning.terrainDamageMinSpeed) * rig.tuning.terrainDamagePerSpeed,
      6,
    );
    expect(rig.dragon().health).toBeLessThan(startHealth);
    expect(isAlive(rig.dragon())).toBe(true);
    // It went back the way it came, well clear of the face at z = -20.
    expect(minZAfterHit).toBeLessThan(-40);
  });

  it('reverses the velocity on the tick of the bounce', () => {
    const rig = makeRig(makeMap([PILLAR]));
    while (rig.hits.length === 0 && rig.tick < 200) rig.step();
    const dragon = rig.dragon();
    expect(rig.hits).toHaveLength(1);
    expect(dragon.velocity.z).toBeLessThan(0);
    // The burst was folded into the bounce.
    expect(dragon.burst).toEqual({ x: 0, y: 0, z: 0 });
    // Restitution: about half the impact speed, but never below the minimum flight speed.
    const impact = rig.hits[0]?.impactSpeed ?? 0;
    expect(Math.abs(dragon.velocity.z)).toBeCloseTo(
      Math.max(impact * rig.flight.terrainBounceRestitution, 15),
      1,
    );
  });

  it('is lethal at max speed, and the body does not fall into the rock either', () => {
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 200, z: -60 } });
    rig.dragon().speed = rig.flight.maxSpeed;
    rig.input.buttons = BUTTON_BOOST;
    for (let i = 0; i < 300; i++) {
      rig.step();
      expectFinite(rig.dragon(), `tick ${i}`);
      expectClearOfBoxes(rig.dragon(), [PILLAR], `tick ${i}`);
    }
    expect(rig.hits[0]?.impactSpeed).toBeGreaterThanOrEqual(rig.flight.terrainLethalSpeed);
    expect(isAlive(rig.dragon())).toBe(false);
    expect(rig.dragon().health).toBe(0);
  });

  it.each(['talon', 'bastion', 'tempest', 'wraith'] as const)(
    'uses the %s hit radius',
    (classId) => {
      const rig = makeRig(makeMap([PILLAR]), { classId, position: { x: 0, y: 200, z: -60 } });
      let closest = Infinity;
      for (let i = 0; i < 90; i++) {
        rig.step();
        closest = Math.min(closest, distanceToBox(PILLAR, rig.dragon().position));
      }
      expect(rig.hits.length).toBeGreaterThan(0);
      const radius = CLASS_TUNING[classId].hitRadius;
      expect(closest).toBeGreaterThanOrEqual(radius - CLEAR_SLACK);
      expect(closest).toBeLessThan(radius + 0.1);
    },
  );
});

// --- Terrain: damage curve -----------------------------------------------------------------------

describe('terrain: damage', () => {
  /** One head-on hit at about `speed` m/s, from just in front of the pillar. */
  function crash(speed: number): { hit: Hit; alive: boolean; healthLost: number; rig: Rig } {
    const radius = CLASS_TUNING.tempest.hitRadius;
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 200, z: -20 - radius - 0.3 } });
    const dragon = rig.dragon();
    const before = dragon.health;
    dragon.speed = speed;
    rig.step();
    const hit = rig.hits[0];
    if (hit === undefined) throw new Error(`no hit at ${speed} m/s`);
    return { hit, alive: isAlive(rig.dragon()), healthLost: before - rig.dragon().health, rig };
  }

  it('grows with the impact speed and is lethal only above the lethal speed', () => {
    let previousImpact = 0;
    let previousDamage = 0;
    let lethalSeen = 0;
    let damagingSeen = 0;
    for (let speed = 16; speed <= 95; speed += 1) {
      const { hit, alive, healthLost, rig } = crash(speed);
      expect(hit.impactSpeed).toBeGreaterThan(previousImpact);
      previousImpact = hit.impactSpeed;
      expect(healthLost).toBeCloseTo(hit.damage, 9);
      expect(alive).toBe(hit.impactSpeed < rig.flight.terrainLethalSpeed);
      if (alive) {
        const expected = Math.max(
          0,
          (hit.impactSpeed - rig.tuning.terrainDamageMinSpeed) * rig.tuning.terrainDamagePerSpeed,
        );
        expect(hit.damage).toBeCloseTo(expected, 6);
        expect(hit.damage).toBeGreaterThanOrEqual(previousDamage);
        if (hit.damage > 0) {
          expect(hit.damage).toBeGreaterThan(previousDamage);
          damagingSeen++;
        }
        previousDamage = hit.damage;
        // A survivable crash never takes a whole health bar on its own.
        expect(hit.damage).toBeLessThan(CLASS_TUNING.talon.maxHp);
      } else {
        expect(hit.damage).toBe(CLASS_TUNING.tempest.maxHp);
        lethalSeen++;
      }
    }
    expect(damagingSeen).toBeGreaterThan(40);
    expect(lethalSeen).toBeGreaterThan(3);
  });

  it('does no damage under the damage speed', () => {
    const rig = makeRig(makeMap([PILLAR]));
    rig.tuning.terrainDamageMinSpeed = 60;
    const before = rig.dragon().health;
    rig.step(150);
    expect(rig.hits.length).toBeGreaterThan(0);
    expect(rig.dragon().health).toBe(before);
  });

  it('spawn protection and dodge immunity block a bounce but not a lethal crash', () => {
    const radius = CLASS_TUNING.tempest.hitRadius;
    const near = { x: 0, y: 200, z: -20 - radius - 0.3 };

    const shielded = makeRig(makeMap([PILLAR]), { position: near, spawnProtectionS: 2 });
    shielded.dragon().speed = 60;
    const before = shielded.dragon().health;
    shielded.step();
    expect(shielded.hits).toHaveLength(1);
    expect(shielded.hits[0]?.damage).toBe(0);
    expect(shielded.dragon().health).toBe(before);

    const dodging = makeRig(makeMap([PILLAR]), { position: near });
    dodging.dragon().speed = 60;
    dodging.input.buttons = BUTTON_DODGE_LEFT;
    dodging.step();
    expect(dodging.hits).toHaveLength(1);
    expect(dodging.hits[0]?.damage).toBe(0);

    const doomed = makeRig(makeMap([PILLAR]), { position: near, spawnProtectionS: 2 });
    doomed.dragon().speed = 94;
    doomed.step();
    expect(isAlive(doomed.dragon())).toBe(false);
  });

  it('gives a grace period after a damaging hit, so grinding does not hurt every tick', () => {
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 200, z: -40 } });
    const graceTicks = secondsToTicks(rig.tuning.terrainRehitGraceS);
    const damagingTicks: number[] = [];
    let seen = 0;
    for (let i = 0; i < 300; i++) {
      // Keep ramming: face the wall at 40 m/s every tick, whatever the bounce did.
      const dragon = rig.dragon();
      dragon.yaw = 0;
      dragon.pitch = 0;
      dragon.speed = 40;
      dragon.health = dragon.maxHealth;
      rig.step();
      expectClearOfBoxes(rig.dragon(), [PILLAR], `tick ${i}`);
      for (; seen < rig.hits.length; seen++) {
        const hit = rig.hits[seen];
        if (hit !== undefined && hit.damage > 0) damagingTicks.push(hit.tick);
      }
    }
    // It hit far more often than it was hurt.
    expect(rig.hits.length).toBeGreaterThan(damagingTicks.length * 3);
    expect(damagingTicks.length).toBeGreaterThan(3);
    for (let i = 1; i < damagingTicks.length; i++) {
      expect((damagingTicks[i] ?? 0) - (damagingTicks[i - 1] ?? 0)).toBeGreaterThanOrEqual(
        graceTicks,
      );
    }
  });
});

// --- Terrain: grazing, corners, thin walls -----------------------------------------------------------

describe('terrain: grazing and awkward geometry', () => {
  it('slides past at grazing angles without entering, sticking or losing much speed', () => {
    // A long wall: its x = +20 face runs from z = -200 to z = +200.
    const wall = box(0, 200, 0, 40, 400, 400);
    for (const angleDeg of [1, 4, 8, 14]) {
      for (const classId of ['talon', 'bastion'] as const) {
        // From outside the face, `angleDeg` off parallel, aimed at the face at z = 0.
        const angle = (angleDeg * Math.PI) / 180;
        const start = { x: 20 + 150 * Math.tan(angle), y: 200, z: -150 };
        // +X is the dragon's left, so heading toward -X while flying +Z is a negative yaw.
        const rig = makeRig(makeMap([wall]), { classId, position: start, yaw: -angle });
        const label = `${classId}, ${angleDeg} deg`;
        const before = rig.dragon().health;
        const cruise = rig.flight.cruiseSpeed * CLASS_TUNING[classId].speedScale;
        for (let i = 0; i < 320; i++) {
          rig.step();
          expectFinite(rig.dragon(), `${label}, tick ${i}`);
          expectClearOfBoxes(rig.dragon(), [wall], `${label}, tick ${i}`);
        }
        const dragon = rig.dragon();
        expect(rig.hits.length, label).toBeGreaterThan(0);
        // Past the wall, not parked against it, and deflected away from it.
        expect(dragon.position.z, label).toBeGreaterThan(200);
        expect(dragon.position.x, label).toBeGreaterThan(20);
        // A graze is under the damage speed and keeps most of the airspeed.
        expect(dragon.health, label).toBe(before);
        for (const hit of rig.hits) {
          expect(hit.normal.x, label).toBeGreaterThan(0.99);
          expect(hit.impactSpeed, label).toBeLessThan(rig.tuning.terrainDamageMinSpeed);
        }
        expect(dragon.speed, label).toBeGreaterThan(cruise * 0.9);
      }
    }
  });

  it('keeps most of its speed on the tick of a graze', () => {
    const wall = box(0, 200, 0, 40, 400, 400);
    const angle = (8 * Math.PI) / 180;
    const rig = makeRig(makeMap([wall]), {
      position: { x: 20 + 150 * Math.tan(angle), y: 200, z: -150 },
      yaw: -angle,
    });
    while (rig.hits.length === 0 && rig.tick < 200) rig.step();
    const dragon = rig.dragon();
    expect(rig.hits).toHaveLength(1);
    expect(dragon.speed).toBeGreaterThan(rig.flight.cruiseSpeed * 0.85);
    // Now heading away from the wall (+X) and still forward (+Z).
    expect(dragon.velocity.x).toBeGreaterThan(0);
    expect(dragon.velocity.z).toBeGreaterThan(30);
  });

  it('clips a corner edge without entering', () => {
    const radius = CLASS_TUNING.tempest.hitRadius;
    for (const overlap of [0.2, 1, 2, radius - 0.05]) {
      const label = `overlap ${overlap}`;
      // Flying +Z past the x = +20 face with the sphere overlapping the corner by `overlap`.
      const rig = makeRig(makeMap([PILLAR]), {
        position: { x: 20 + radius - overlap, y: 200, z: -100 },
      });
      for (let i = 0; i < 150; i++) {
        rig.step();
        expectClearOfBoxes(rig.dragon(), [PILLAR], `${label}, tick ${i}`);
      }
      expect(rig.hits.length, label).toBeGreaterThan(0);
      // The edge normal points away from both faces, and is horizontal.
      const normal = rig.hits[0]?.normal ?? { x: 0, y: 0, z: 0 };
      expect(normal.x, label).toBeGreaterThan(0);
      expect(normal.z, label).toBeLessThan(0);
      expect(Math.abs(normal.y), label).toBeLessThan(1e-6);
      expect(Math.hypot(normal.x, normal.z), label).toBeCloseTo(1, 6);
      // A light clip carries on past the pillar; a heavy one is thrown back or aside.
      if (overlap <= 0.2) expect(rig.dragon().position.z, label).toBeGreaterThan(20);
    }
  });

  it('never tunnels through a thin wall, at any speed', () => {
    const wall = box(0, 200, 0, 400, 400, 0.2);
    for (const speed of [45, 95, 150, 400, 2000]) {
      const rig = makeRig(makeMap([wall]), { position: { x: 0, y: 200, z: -80 } });
      // Out-of-range speed limits, so the test really moves tens of metres per tick.
      rig.flight.maxSpeed = 5000;
      rig.flight.terrainLethalSpeed = 1e9;
      rig.flight.maxBurstSpeed = 5000;
      for (let i = 0; i < 120; i++) {
        const dragon = rig.dragon();
        dragon.yaw = 0;
        dragon.pitch = 0;
        dragon.speed = speed;
        dragon.burst.z = speed * 0.5;
        dragon.health = dragon.maxHealth;
        rig.step();
        expectFinite(rig.dragon(), `speed ${speed}, tick ${i}`);
        expectClearOfBoxes(rig.dragon(), [wall], `speed ${speed}, tick ${i}`);
        expect(rig.dragon().position.z).toBeLessThan(0);
      }
      expect(rig.hits.length).toBeGreaterThan(0);
    }
  });

  it('stays out of an inner corner and a narrow slot', () => {
    // Two walls meeting at a right angle, and a slot narrower than the dragon.
    const solids = [
      box(0, 200, 30, 200, 400, 20),
      box(30, 200, 0, 20, 400, 200),
      box(-60, 200, -40, 20, 400, 80),
      box(-64.5 - 20, 200, -40, 20, 400, 80),
    ];
    const targets = [
      { x: 19, z: 19 },
      { x: 10, z: 19 },
      { x: -77, z: -20 },
    ];
    for (const target of targets) {
      const rig = makeRig(makeMap(solids), { position: { x: -20, y: 200, z: -120 } });
      for (let i = 0; i < 400; i++) {
        // Keep steering at the awkward spot.
        const dragon = rig.dragon();
        dragon.yaw = Math.atan2(target.x - dragon.position.x, target.z - dragon.position.z);
        dragon.pitch = 0;
        dragon.health = dragon.maxHealth;
        rig.step();
        expectFinite(rig.dragon(), `tick ${i}`);
        expectClearOfBoxes(rig.dragon(), solids, `target ${target.x},${target.z}, tick ${i}`);
      }
      expect(rig.hits.length).toBeGreaterThan(0);
    }
  });

  it('lands on top of a pillar from a steep dive and bounces up', () => {
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 470, z: -40 } });
    rig.dragon().pitch = -1.0;
    rig.input.buttons = BUTTON_DIVE;
    for (let i = 0; i < 90 && rig.hits.length === 0; i++) {
      rig.step();
      expectClearOfBoxes(rig.dragon(), [PILLAR], `tick ${i}`);
    }
    const hit = rig.hits[0];
    if (hit === undefined) throw new Error('never hit the top');
    expect(hit.normal.y).toBeGreaterThan(0.99);
    expect(rig.dragon().velocity.y).toBeGreaterThan(0);
    rig.input.buttons = 0;
    for (let i = 0; i < 60; i++) {
      rig.step();
      expectClearOfBoxes(rig.dragon(), [PILLAR], `after ${i}`);
    }
  });

  it('a dead dragon comes to rest on the terrain', () => {
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 430, z: -10 } });
    rig.dragon().health = 0;
    rig.step(300);
    const dragon = rig.dragon();
    expect(isAlive(dragon)).toBe(false);
    expectClearOfBoxes(dragon, [PILLAR], 'at rest');
    expect(dragon.position.y).toBeGreaterThan(400);
    expect(dragon.position.y).toBeLessThan(400 + radiusOf(dragon) + 0.2);
    expect(rig.hits).toHaveLength(0);
  });

  it('skips terrain for a phasing dragon', () => {
    const rig = makeRig(makeMap([PILLAR]));
    for (let i = 0; i < 150; i++) {
      rig.dragon().flags |= DRAGON_FLAG_PHASING;
      rig.step();
    }
    expect(rig.hits).toHaveLength(0);
    expect(rig.dragon().position.z).toBeGreaterThan(20);
  });
});

// --- Terrain: robustness ---------------------------------------------------------------------------

describe('terrain: robustness', () => {
  it('pushes a dragon that starts inside the rock out to the surface', () => {
    // Near a face it is out at once; from the very middle it is out once it reaches a face.
    for (const start of [
      { x: 0, y: 200, z: -18, ticks: 1 },
      { x: 19, y: 399, z: 19, ticks: 1 },
      { x: 5, y: 200, z: -22, ticks: 1 },
      { x: 0, y: 200, z: 0, ticks: 20 },
    ]) {
      const rig = makeRig(makeMap([PILLAR]), { position: start });
      rig.step(start.ticks);
      expectFinite(rig.dragon(), 'inside start');
      expectClearOfBoxes(rig.dragon(), [PILLAR], `start ${start.x},${start.y},${start.z}`);
    }
  });

  it('survives zero-length moves, NaN previous positions and broken tuning', () => {
    const radius = CLASS_TUNING.tempest.hitRadius;
    const rig = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 200, z: -20 - radius } });
    const world = rig.world;
    const flight = rig.flight;

    // Zero-length move while touching the wall.
    const dragon = rig.dragon();
    world.resolveDragon(dragon, dragon.position, TICK_DT_S, flight);
    expectFinite(dragon, 'zero move');
    expectClearOfBoxes(dragon, [PILLAR], 'zero move');

    // Zero-length move from inside the wall.
    dragon.position.z = -20;
    world.resolveDragon(dragon, dragon.position, TICK_DT_S, flight);
    expectFinite(dragon, 'on the surface');
    expectClearOfBoxes(dragon, [PILLAR], 'on the surface');

    // Garbage previous position, zero and NaN dt.
    dragon.position.z = -21;
    world.resolveDragon(dragon, { x: NaN, y: Infinity, z: 0 }, TICK_DT_S, flight);
    expectFinite(dragon, 'NaN prev');
    expectClearOfBoxes(dragon, [PILLAR], 'NaN prev');
    dragon.position.z = -21;
    world.resolveDragon(dragon, { x: 0, y: 200, z: -30 }, 0, flight);
    world.resolveDragon(dragon, { x: 0, y: 200, z: -30 }, NaN, flight);
    expectFinite(dragon, 'bad dt');

    // A NaN position is left for finalizeDragon.
    dragon.position.x = NaN;
    world.resolveDragon(dragon, { x: 0, y: 200, z: -30 }, TICK_DT_S, flight);
    dragon.position.x = 0;

    // Broken tuning values.
    for (const key of Object.keys(rig.tuning) as (keyof CollisionTuning)[]) {
      for (const bad of [NaN, -1, Infinity, 0]) {
        const broken = makeRig(makeMap([PILLAR]), { position: { x: 0, y: 200, z: -40 } });
        broken.tuning[key] = bad;
        broken.flight.terrainBounceRestitution = bad;
        broken.step(60);
        expectFinite(broken.dragon(), `${key} = ${bad}`);
        expectClearOfBoxes(broken.dragon(), [PILLAR], `${key} = ${bad}`);
      }
    }
  });

  it('works on a map without solids (storm wall only) and on open-sky queries', () => {
    const rig = makeRig(makeMap([]));
    expect(rig.world.terrain).toBeNull();
    rig.step(30);
    expect(rig.world.raycast(0, 0, 0, 0, 0, 1, 100)).toBe(-1);
    expect(rig.world.clearance(0, 0, 0, 100)).toBe(-1);
    const noSolids: CollisionMapSource = { ...makeMap([]), solids: undefined };
    expect(createMapCollisionWorld(noSolids).terrain).toBeNull();
  });
});

// --- Terrain query -----------------------------------------------------------------------------------

describe('TerrainQuery (camera rig)', () => {
  it('reports ray distances and clearance against the map', () => {
    const query: TerrainQuery = createMapCollisionWorld(makeMap([PILLAR]));
    expect(query.raycast(0, 200, -100, 0, 0, 1, 500)).toBeCloseTo(80, 4);
    expect(query.raycast(0, 200, -100, 0, 0, 5, 500)).toBeCloseTo(80, 4);
    expect(query.raycast(0, 200, -100, 0, 0, 1, 79)).toBe(-1);
    expect(query.raycast(0, 200, -100, 0, 0, -1, 500)).toBe(-1);
    expect(query.raycast(0, 600, 0, 0, -1, 0, 500)).toBeCloseTo(200, 4);
    // From inside the rock the way out is reported (both sides count).
    expect(query.raycast(0, 200, 0, 1, 0, 0, 500)).toBeCloseTo(20, 4);
    expect(query.clearance(50, 200, 0, 100)).toBeCloseTo(30, 4);
    expect(query.clearance(50, 200, 0, 30)).toBe(-1);
  });

  it('can use low-detail prisms for collision', () => {
    const map = createGreyboxSpires();
    const full = createMapCollisionWorld(map);
    const coarse = createMapCollisionWorld(map, { maxPrismSides: 4 });
    expect(full.terrain?.triangleCount ?? 0).toBeGreaterThan(coarse.terrain?.triangleCount ?? 0);
    expect(coarse.terrain?.triangleCount ?? 0).toBeGreaterThan(1000);
  });
});

// --- Storm wall ----------------------------------------------------------------------------------

describe('storm wall', () => {
  function horizontal(dragon: DragonState): number {
    return Math.hypot(dragon.position.x, dragon.position.z);
  }

  function inStorm(dragon: DragonState): boolean {
    return (dragon.flags & DRAGON_FLAG_IN_STORM) !== 0;
  }

  it('flags, damages and turns back a dragon that flies out through the wall', () => {
    // Heading +X (yaw = +PI/2), 100 m short of the wall.
    const rig = makeRig(makeMap([]), { position: { x: 900, y: 300, z: 0 }, yaw: Math.PI / 2 });
    const startHealth = rig.dragon().health;
    let maxDistance = 0;
    let stormTicks = 0;
    let returnedAt = -1;
    for (let i = 0; i < 600; i++) {
      rig.step();
      const dragon = rig.dragon();
      expectFinite(dragon, `tick ${i}`);
      const distance = horizontal(dragon);
      maxDistance = Math.max(maxDistance, distance);
      expect(inStorm(dragon)).toBe(distance > 1000);
      if (inStorm(dragon)) stormTicks++;
      else if (stormTicks > 0 && returnedAt < 0) returnedAt = i;
    }
    expect(stormTicks).toBeGreaterThan(10);
    expect(maxDistance).toBeGreaterThan(1000);
    // Pushed back in without any input, within a few seconds and not far past the wall.
    expect(returnedAt).toBeGreaterThan(0);
    expect(returnedAt).toBeLessThan(10 * TICK_HZ);
    expect(maxDistance).toBeLessThan(1150);
    // Damage over time, exactly the tuned rate while outside.
    const lost = startHealth - rig.dragon().health;
    expect(lost).toBeCloseTo(stormTicks * MATCH_TUNING.stormDamagePerS * TICK_DT_S, 6);
    expect(isAlive(rig.dragon())).toBe(true);
  });

  it('cannot be out-flown: full boost straight out is turned around', () => {
    const rig = makeRig(makeMap([]), { position: { x: 0, y: 300, z: 950 }, yaw: 0 });
    let maxDistance = 0;
    for (let i = 0; i < 900; i++) {
      // The pilot keeps boosting and steering away from the centre.
      const dragon = rig.dragon();
      const outward = Math.atan2(dragon.position.x, dragon.position.z);
      const error = Math.atan2(Math.sin(outward - dragon.yaw), Math.cos(outward - dragon.yaw));
      // Positive yaw error = turn left = negative steerX.
      rig.input.steerX = Math.max(-1, Math.min(1, -error * 4));
      rig.input.buttons = BUTTON_BOOST;
      dragon.stamina = 1;
      dragon.health = dragon.maxHealth;
      rig.step();
      expectFinite(rig.dragon(), `tick ${i}`);
      maxDistance = Math.max(maxDistance, horizontal(rig.dragon()));
    }
    expect(maxDistance).toBeGreaterThan(1000);
    expect(maxDistance).toBeLessThan(1000 + 250);
  });

  it('kills a dragon that stays out', () => {
    const rig = makeRig(makeMap([]), { position: { x: 0, y: 300, z: 1500 } });
    let ticks = 0;
    while (isAlive(rig.dragon()) && ticks < 3000) {
      // Pinned outside.
      const dragon = rig.dragon();
      dragon.position.z = 1500;
      rig.step();
      ticks++;
    }
    expect(isAlive(rig.dragon())).toBe(false);
    const expected = CLASS_TUNING.tempest.maxHp / (MATCH_TUNING.stormDamagePerS * TICK_DT_S);
    expect(Math.abs(ticks - expected)).toBeLessThanOrEqual(2);
    // The dead do not carry the storm flag.
    rig.step();
    expect(inStorm(rig.dragon())).toBe(false);
  });

  it('holds the ceiling and the cloud-sea floor', () => {
    const up = makeRig(makeMap([]), { position: { x: 0, y: 650, z: 0 } });
    up.input.steerY = 1;
    up.input.buttons = BUTTON_BOOST | BUTTON_FLAP;
    let maxY = 0;
    let flagged = 0;
    for (let i = 0; i < 900; i++) {
      up.dragon().stamina = 1;
      up.dragon().health = up.dragon().maxHealth;
      up.step();
      maxY = Math.max(maxY, up.dragon().position.y);
      expect(inStorm(up.dragon())).toBe(up.dragon().position.y > 700);
      expect(up.dragon().health < up.dragon().maxHealth).toBe(inStorm(up.dragon()));
      if (inStorm(up.dragon())) flagged++;
    }
    expect(flagged).toBeGreaterThan(0);
    expect(maxY).toBeGreaterThan(700);
    expect(maxY).toBeLessThanOrEqual(700 + COLLISION_TUNING.stormVerticalMaxDepth);

    const down = makeRig(makeMap([]), { position: { x: 0, y: 60, z: 0 } });
    down.input.steerY = -1;
    down.input.buttons = BUTTON_DIVE;
    let minY = Infinity;
    for (let i = 0; i < 900; i++) {
      down.dragon().health = down.dragon().maxHealth;
      down.step();
      minY = Math.min(minY, down.dragon().position.y);
      expect(inStorm(down.dragon())).toBe(down.dragon().position.y < -40);
    }
    expect(minY).toBeLessThan(-40);
    expect(minY).toBeGreaterThanOrEqual(-40 - COLLISION_TUNING.stormVerticalMaxDepth);
  });

  it('is a hard limit a little past the floor and the ceiling, and lets go with the stick', () => {
    const maxDepth = COLLISION_TUNING.stormVerticalMaxDepth;
    const cases = [
      // A full-speed folded dive into the sea, and a boosted flapping climb through the ceiling.
      { y: 100, steerY: -1, buttons: BUTTON_DIVE, limit: -40 - maxDepth, sign: -1 },
      { y: 640, steerY: 1, buttons: BUTTON_BOOST | BUTTON_FLAP, limit: 700 + maxDepth, sign: 1 },
    ];
    for (const classId of CLASSES) {
      for (const { y, steerY, buttons, limit, sign } of cases) {
        const rig = makeRig(makeMap([]), { classId, position: { x: 0, y, z: 0 } });
        rig.input.steerY = steerY;
        rig.input.buttons = buttons;
        let reached = false;
        for (let i = 0; i < 20 * TICK_HZ; i++) {
          rig.dragon().stamina = 1;
          rig.dragon().health = rig.dragon().maxHealth;
          rig.step();
          const dragon = rig.dragon();
          expectFinite(dragon, `${classId} tick ${i}`);
          // Never past the limit, and at the limit nothing of its motion points further out.
          expect((dragon.position.y - limit) * sign).toBeLessThanOrEqual(0);
          if (dragon.position.y === limit) {
            reached = true;
            expect(dragon.pitch * sign).toBeLessThanOrEqual(0);
            expect(dragon.burst.y * sign).toBeLessThanOrEqual(0);
            expect(dragon.velocity.y * sign).toBeLessThanOrEqual(0);
          }
        }
        if (sign < 0) expect(reached).toBe(true);

        // Stick released: the push alone brings the dragon back inside within a few seconds.
        rig.input.steerY = 0;
        rig.input.buttons = 0;
        let ticks = 0;
        while (inStorm(rig.dragon()) && ticks < 5 * TICK_HZ) {
          rig.dragon().health = rig.dragon().maxHealth;
          rig.step();
          ticks++;
        }
        expect(inStorm(rig.dragon())).toBe(false);
      }
    }

    // A dead body falls through the floor, and 0 (or a broken value) turns the limit off.
    const body = makeRig(makeMap([]), { position: { x: 0, y: -70, z: 0 } });
    body.dragon().health = 0;
    body.step(90);
    expect(isAlive(body.dragon())).toBe(false);
    expect(body.dragon().position.y).toBeLessThan(-40 - maxDepth);
    const off = makeRig(makeMap([]), { position: { x: 0, y: -40 - maxDepth - 50, z: 0 } });
    off.tuning.stormVerticalMaxDepth = 0;
    off.step();
    expect(off.dragon().position.y).toBeLessThan(-40 - maxDepth);
  });

  it('pushes harder the deeper the dragon is', () => {
    const pushAt = (depth: number): number => {
      const rig = makeRig(makeMap([]), { position: { x: 1000 + depth, y: 300, z: 0 } });
      rig.step();
      return -rig.dragon().burst.x;
    };
    const shallow = pushAt(5);
    const deep = pushAt(200);
    expect(shallow).toBeGreaterThan(0);
    expect(deep).toBeGreaterThan(shallow * 2);
  });

  it('spares spawn-protected dragons and follows a shrinking radius', () => {
    const rig = makeRig(makeMap([]), {
      position: { x: 0, y: 300, z: 600 },
      yaw: Math.PI,
      spawnProtectionS: 1,
    });
    const before = rig.dragon().health;
    rig.step();
    expect(inStorm(rig.dragon())).toBe(false);
    rig.world.stormRadius = 400;
    rig.step();
    expect(inStorm(rig.dragon())).toBe(true);
    expect(rig.dragon().health).toBe(before);
    rig.step(40);
    expect(rig.dragon().health).toBeLessThan(before);
  });

  it('ignores broken storm tuning without producing NaN', () => {
    for (const bad of [NaN, -1, Infinity, 0]) {
      const rig = makeRig(makeMap([]), {
        position: { x: 1100, y: 800, z: 0 },
        match: { stormDamagePerS: bad, stormPushAccel: bad },
      });
      rig.tuning.stormPushDepthScale = bad;
      rig.tuning.stormSteerRate = bad;
      rig.tuning.stormSteerFullDepth = bad;
      rig.step(60);
      expectFinite(rig.dragon(), `storm tuning ${bad}`);
    }
  });
});

// --- The greybox map: fuzz, determinism, cost ------------------------------------------------------

interface Flock {
  readonly sim: Sim;
  readonly world: MapCollisionWorld;
  readonly inputs: InputFrame[];
  hits: number;
  step(tick: number): void;
}

const GREYBOX = createGreyboxSpires();
const CLASSES: readonly DragonClassId[] = ['talon', 'bastion', 'tempest', 'wraith'];

/**
 * MAX_PLAYERS dragons flown by seeded random pilots through the greybox map, with respawns.
 * Everything is driven by the seed, so two flocks with the same seed must stay identical.
 */
function makeFlock(seed: number): Flock {
  const random = createSeededRandom(seed);
  const flight: FlightTuning = { ...FLIGHT_TUNING };
  const match: MatchTuning = { ...MATCH_TUNING, spawnProtectionS: 0 };
  const flock: Flock = {
    sim: undefined as unknown as Sim,
    world: createMapCollisionWorld(GREYBOX, {
      collisionTuning: { ...COLLISION_TUNING },
      matchTuning: match,
      onTerrainHit() {
        flock.hits++;
      },
    }),
    inputs: [],
    hits: 0,
    step(tick) {
      for (let id = 0; id < MAX_PLAYERS; id++) {
        const input = flock.inputs[id];
        if (input === undefined) continue;
        input.tick = tick;
        // New stick and buttons every half second or so; biased down into the pillars.
        if (random() < 0.07) {
          input.steerX = random() * 2 - 1;
          input.steerY = random() * 2 - 1.3;
          input.buttons = Math.floor(random() * 2048);
        }
        const dragon = flock.sim.getDragon(id);
        if (dragon === undefined) continue;
        if (!isAlive(dragon)) {
          if (random() < 0.02) spawn(id);
        } else if (id % 2 === 1 && random() < 0.03) {
          // The map is mostly open sky, so the odd pilots are rammers: every second or so they
          // point themselves at the nearest rock, from whatever angle they happen to be at.
          const terrain = flock.world.terrain;
          const p = dragon.position;
          if (terrain !== null && terrain.closestPoint(p.x, p.y, p.z, Infinity) > 0) {
            const dx = terrain.closestX - p.x;
            const dy = terrain.closestY - p.y;
            const dz = terrain.closestZ - p.z;
            dragon.yaw = Math.atan2(dx, dz);
            dragon.pitch = Math.atan2(dy, Math.hypot(dx, dz));
          }
        }
      }
      flock.sim.step(tick, flock.inputs);
    },
  };
  const sim = createSim({ flightTuning: flight, matchTuning: match, collisionWorld: flock.world });
  (flock as { sim: Sim }).sim = sim;

  /**
   * Even ids start at their team gate; odd ids are dropped at a random clear spot among the
   * pillars with a random heading, so the run is dense with collisions from the first second.
   */
  function spawn(id: number): void {
    const team = id % 4 < 2 ? TEAM_EMBER : TEAM_FROST;
    const classId = CLASSES[id % CLASSES.length] ?? 'tempest';
    if (id % 2 === 0) {
      const slot = GREYBOX.spawnGates[team]?.slots[Math.floor(id / 2)];
      if (slot === undefined) throw new Error('no spawn slot');
      sim.spawnDragon(id, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
      return;
    }
    const spot = { x: 0, y: 0, z: 0 };
    do {
      spot.x = (random() - 0.5) * 1200;
      spot.y = 60 + random() * 200;
      spot.z = (random() - 0.5) * 1200;
    } while (signedTerrainDistance(flock.world, spot) < 8);
    sim.spawnDragon(id, team, classId, spot, (random() - 0.5) * 2 * Math.PI);
  }

  for (let id = 0; id < MAX_PLAYERS; id++) {
    flock.inputs.push(createInputFrame());
    spawn(id);
  }
  return flock;
}

describe('greybox map', () => {
  it('launches every spawn slot of both teams through the team arch without a touch', () => {
    // With no input at all: the outer slots used to fly straight into the legs of the arch.
    const past = GREYBOX_GATE_ARCH_DISTANCE + 20;
    let hits = 0;
    const world = createMapCollisionWorld(GREYBOX, {
      onTerrainHit() {
        hits++;
      },
    });
    for (const classId of CLASSES) {
      for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
        const gate = GREYBOX.spawnGates[team];
        if (gate === undefined) throw new Error('missing gate');
        for (const slot of gate.slots) {
          const sim = createSim({ collisionWorld: world });
          sim.spawnDragon(0, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
          const inputs = [createInputFrame()];
          let tick = 0;
          let minClearance = Infinity;
          for (; tick < 20 * TICK_HZ; tick++) {
            sim.step(tick, inputs);
            const dragon = sim.getDragon(0);
            if (dragon === undefined) throw new Error('missing dragon');
            const p = dragon.position;
            const clearance = world.clearance(p.x, p.y, p.z, 100);
            if (clearance >= 0 && clearance < minClearance) minClearance = clearance;
            if (Math.abs(p.z - slot.z) >= past) break;
          }
          expect(tick).toBeLessThan(20 * TICK_HZ);
          expect(hits).toBe(0);
          // It did pass between the legs, with air to spare on either side.
          expect(minClearance).toBeLessThan(60);
          expect(minClearance).toBeGreaterThanOrEqual(GREYBOX_GATE_ARCH_CLEARANCE - 1);
        }
      }
    }
  });

  it('10 random pilots x 1000 ticks: nobody ends a tick inside the terrain, nothing is NaN', () => {
    let hits = 0;
    let stormTicks = 0;
    let deaths = 0;
    for (const seed of [1, 2, 3]) {
      const flock = makeFlock(seed);
      const wasAlive: boolean[] = [];
      for (let tick = 0; tick < 1000; tick++) {
        flock.step(tick);
        for (let id = 0; id < MAX_PLAYERS; id++) {
          const dragon = flock.sim.getDragon(id);
          if (dragon === undefined) throw new Error('missing dragon');
          expectFinite(dragon, `seed ${seed}, tick ${tick}, dragon ${id}`);
          expectClearOfTerrain(dragon, flock.world, `seed ${seed}, tick ${tick}, dragon ${id}`);
          if ((dragon.flags & DRAGON_FLAG_IN_STORM) !== 0) stormTicks++;
          if (wasAlive[id] === true && !isAlive(dragon)) deaths++;
          wasAlive[id] = isAlive(dragon);
        }
      }
      hits += flock.hits;
    }
    // The run really exercised the collision code.
    expect(hits).toBeGreaterThan(150);
    expect(stormTicks).toBeGreaterThan(0);
    expect(deaths).toBeGreaterThan(0);
  });

  it('is deterministic: the same inputs give the same states', () => {
    const run = (): string => {
      const flock = makeFlock(7);
      const trace: string[] = [];
      for (let tick = 0; tick < 600; tick++) {
        flock.step(tick);
        if (tick % 50 === 49) trace.push(JSON.stringify(flock.sim.current));
      }
      trace.push(String(flock.hits));
      return trace.join('\n');
    };
    expect(run()).toBe(run());
  });

  it('10 dragons x 1000 ticks with collision stays far below 1 ms per tick', () => {
    let best = Infinity;
    let hits = 0;
    for (let round = 0; round < 5; round++) {
      const flock = makeFlock(40 + round);
      const start = performance.now();
      for (let tick = 0; tick < 1000; tick++) flock.step(tick);
      best = Math.min(best, (performance.now() - start) / 1000);
      hits += flock.hits;
    }
    const microseconds = best * 1000;
    console.info(
      `sim + map collision: ${microseconds.toFixed(1)} us per tick for ${MAX_PLAYERS} dragons ` +
        `(best of 5 x 1000 ticks, ${hits} terrain hits in all)`,
    );
    expect(hits).toBeGreaterThan(0);
    expect(microseconds).toBeLessThan(300);
  });
});
