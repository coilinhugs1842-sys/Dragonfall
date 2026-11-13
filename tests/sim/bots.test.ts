/**
 * The bot riders (T-3.10): flight competence on the greybox map, fights that resolve, the rules
 * they keep (countdown, spawn protection, veil, the storm), determinism and cost.
 *
 * Everything runs the real sim with the real collision world: a bot can only act through its
 * InputFrame, so what is tested is what a match would do.
 */

import { describe, expect, it } from 'vitest';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  ABILITY_TAG_ATTACK,
  BUTTON_ABILITY_MASK,
  BUTTON_MASK,
  BUTTON_PRIMARY,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_IN_STORM,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_HZ,
  createGreyboxSpires,
  createInputFrame,
} from '../../src/shared';
import type { BotDifficulty, DragonClassId, GameEvent, InputFrame, TeamId } from '../../src/shared';
import { createMapCollisionWorld, createSim } from '../../src/sim';
import type { Sim, SimCollisionWorld } from '../../src/sim';
import {
  BOT_DIFFICULTY_TUNING,
  BOT_MODE_ENGAGE,
  BOT_MODE_PATROL,
  BOT_TUNING,
  BotBrain,
} from '../../src/sim/bots';
import type { BotArena, BotContext } from '../../src/sim/bots';

const map = createGreyboxSpires();
const terrain = createMapCollisionWorld(map);
const GREYBOX: BotArena = {
  centerX: map.colliders.stormCenter.x,
  centerZ: map.colliders.stormCenter.z,
  radius: map.colliders.stormRadius,
  floorY: map.colliders.floorY,
  ceilingY: map.colliders.ceilingY,
};
const OPEN_SKY: BotArena = { centerX: 0, centerZ: 0, radius: 1000, floorY: 0, ceilingY: 800 };
/** Gate slots in the order riders take them (centre first). */
const SLOT_ORDER = [2, 1, 3, 0, 4];

interface Tally {
  takedowns: number;
  /** Takedowns nobody was credited for: a bot flew itself into the rock or the storm. */
  selfInflicted: number;
  firstTakedownTick: number;
  terrainDamage: number;
  stormDamage: number;
  abilityDamage: number;
  casts: number[];
}

interface Room {
  sim: Sim;
  brains: BotBrain[];
  frames: InputFrame[];
  inputs: (InputFrame | undefined)[];
  ctx: BotContext;
  tally: Tally;
  tick: number;
  /** Called with every frame after the brain wrote it (before the sim reads it). */
  onFrame: ((id: number, frame: InputFrame) => void) | null;
  thinkMs: number;
  run(ticks: number): void;
}

interface RoomOptions {
  perTeam: number;
  seed: number;
  classes?: readonly DragonClassId[];
  difficulty?: BotDifficulty | readonly BotDifficulty[];
  collision?: SimCollisionWorld | null;
  profile?: boolean;
}

function createRoom(options: RoomOptions): Room {
  const collision = options.collision === undefined ? terrain : options.collision;
  const classes = options.classes ?? DRAGON_CLASS_IDS;
  const tally: Tally = {
    takedowns: 0,
    selfInflicted: 0,
    firstTakedownTick: -1,
    terrainDamage: 0,
    stormDamage: 0,
    abilityDamage: 0,
    casts: [0, 0, 0, 0],
  };
  const sim = createSim({
    ...(collision !== null ? { collisionWorld: collision } : {}),
    events: {
      emit(event: GameEvent) {
        if (event.type === 'hit') {
          if (event.source === 'terrain') tally.terrainDamage += event.damage;
          else if (event.source === 'storm') tally.stormDamage += event.damage;
          else tally.abilityDamage += event.damage;
        } else if (event.type === 'takedown') {
          tally.takedowns++;
          if (event.killerId === NO_PLAYER) tally.selfInflicted++;
          if (tally.firstTakedownTick < 0) tally.firstTakedownTick = event.tick;
        } else if (event.type === 'abilityCast') {
          const slot = ABILITY_SLOTS.indexOf(event.slot);
          tally.casts[slot] = (tally.casts[slot] ?? 0) + 1;
        }
      },
    },
  });
  const brains: BotBrain[] = [];
  const frames: InputFrame[] = [];
  let id = 0;
  const teams: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];
  for (const team of teams) {
    for (let i = 0; i < options.perTeam; i++) {
      const gate = map.spawnGates[team];
      const slot = gate?.slots[SLOT_ORDER[i] ?? 0];
      if (slot === undefined) throw new Error('no gate slot');
      const classId = classes[(id + options.seed) % classes.length] ?? 'talon';
      sim.spawnDragon(id, team, classId, slot, team === TEAM_EMBER ? 0 : Math.PI);
      const difficulty =
        typeof options.difficulty === 'string'
          ? options.difficulty
          : (options.difficulty?.[id % options.difficulty.length] ?? 'normal');
      brains.push(new BotBrain(options.seed * 1000 + id, { difficulty }));
      frames.push(createInputFrame());
      id++;
    }
  }
  const room: Room = {
    sim,
    brains,
    frames,
    inputs: [],
    ctx: {
      state: sim.current,
      collision,
      arena: collision === null ? OPEN_SKY : GREYBOX,
      playing: true,
    },
    tally,
    tick: 0,
    onFrame: null,
    thinkMs: 0,
    run(ticks) {
      for (let n = 0; n < ticks; n++) {
        const tick = room.tick++;
        room.ctx.state = sim.current;
        const t0 = options.profile === true ? performance.now() : 0;
        for (let b = 0; b < brains.length; b++) {
          const frame = frames[b];
          const brain = brains[b];
          if (frame === undefined || brain === undefined) continue;
          brain.think(room.ctx, b, frame);
          frame.tick = tick;
        }
        if (options.profile === true) room.thinkMs += performance.now() - t0;
        for (let b = 0; b < brains.length; b++) {
          const frame = frames[b];
          if (frame === undefined) continue;
          room.onFrame?.(b, frame);
          room.inputs[b] = frame;
        }
        sim.step(tick, room.inputs);
      }
    },
  };
  return room;
}

function expectSaneFrame(frame: InputFrame): void {
  expect(Math.abs(frame.steerX)).toBeLessThanOrEqual(1);
  expect(Math.abs(frame.steerY)).toBeLessThanOrEqual(1);
  expect(frame.buttons & ~BUTTON_MASK).toBe(0);
  expect(Number.isFinite(frame.aimYaw) && Number.isFinite(frame.aimPitch)).toBe(true);
}

describe('flight competence', () => {
  it(
    'flies 5 minutes alone on the greybox map without dying, in every class',
    () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const seed of [1, 2, 3, 5]) {
        const sim = createSim({ collisionWorld: terrain });
        const gate = map.spawnGates[seed % 2];
        const slot = gate?.slots[seed % 5];
        if (slot === undefined) throw new Error('no gate slot');
        sim.spawnDragon(0, TEAM_EMBER, classId, slot, seed % 2 === 0 ? 0 : Math.PI);
        const brain = new BotBrain(seed * 7919);
        const ctx: BotContext = {
          state: sim.current,
          collision: terrain,
          arena: GREYBOX,
          playing: true,
        };
        const frame = createInputFrame();
        const inputs: (InputFrame | undefined)[] = [];
        let stormTicks = 0;
        let lowest = Infinity;
        let highest = -Infinity;
        for (let tick = 0; tick < 300 * TICK_HZ; tick++) {
          ctx.state = sim.current;
          brain.think(ctx, 0, frame);
          frame.tick = tick;
          if (tick % 97 === 0) expectSaneFrame(frame);
          inputs[0] = frame;
          sim.step(tick, inputs);
          const dragon = sim.getDragon(0);
          if (dragon === undefined) throw new Error('dragon lost');
          if ((dragon.flags & DRAGON_FLAG_ALIVE) === 0) {
            throw new Error(`${classId} seed ${seed} died at tick ${tick}`);
          }
          if ((dragon.flags & DRAGON_FLAG_IN_STORM) !== 0) stormTicks++;
          if (dragon.position.y < lowest) lowest = dragon.position.y;
          if (dragon.position.y > highest) highest = dragon.position.y;
        }
        const dragon = sim.getDragon(0);
        const label = `${classId} seed ${seed}`;
        expect(stormTicks, label).toBe(0);
        // Above the cloud sea, under the ceiling, and it kept nearly all its health.
        expect(lowest, label).toBeGreaterThan(GREYBOX.floorY + 30);
        expect(highest, label).toBeLessThan(GREYBOX.ceilingY - 30);
        expect((dragon?.health ?? 0) / (dragon?.maxHealth ?? 1), label).toBeGreaterThan(0.7);
        expect(sim.current.scores[0]?.deaths).toBe(0);
        // Alone it patrols; it never found anyone to chase.
        expect(brain.mode).toBe(BOT_MODE_PATROL);
        expect(brain.targetId).toBe(NO_PLAYER);
      }
    }
  },
  120_000,
  );

  it('chasing through the spires for 5 minutes, no bot kills itself on rock or storm', () => {
    // A dogfight with the guns taken away from one side: the hardest flying there is (hard
    // turns after a target that weaves between pillars), and the unarmed side still dodges.
    let terrainDamage = 0;
    let stormDamage = 0;
    let selfInflicted = 0;
    let takedowns = 0;
    for (const seed of [11, 12, 13]) {
      const room = createRoom({ perTeam: 2, seed });
      room.onFrame = (id, frame) => {
        if (id >= 2) frame.buttons &= ~BUTTON_ABILITY_MASK;
      };
      room.run(300 * TICK_HZ);
      terrainDamage += room.tally.terrainDamage;
      stormDamage += room.tally.stormDamage;
      selfInflicted += room.tally.selfInflicted;
      takedowns += room.tally.takedowns;
    }
    expect(takedowns).toBeGreaterThan(10);
    expect(selfInflicted).toBe(0);
    expect(stormDamage).toBe(0);
    // 12 dragons for 5 minutes each: a few scrapes at most.
    expect(terrainDamage).toBeLessThan(250);
  });

  it('turns back before the storm wall, also when a mode has shrunk it', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const sim = createSim({ collisionWorld: terrain });
      // Mid-arena, heading straight out.
      sim.spawnDragon(0, TEAM_EMBER, classId, { x: 0, y: 420, z: 0 }, 0.4);
      sim.setStormRadius(260);
      const brain = new BotBrain(77);
      const ctx: BotContext = {
        state: sim.current,
        collision: terrain,
        arena: GREYBOX,
        playing: true,
      };
      const frame = createInputFrame();
      const inputs: (InputFrame | undefined)[] = [];
      let farthest = 0;
      for (let tick = 0; tick < 90 * TICK_HZ; tick++) {
        ctx.state = sim.current;
        brain.think(ctx, 0, frame);
        frame.tick = tick;
        inputs[0] = frame;
        sim.step(tick, inputs);
        const dragon = sim.getDragon(0);
        if (dragon === undefined) throw new Error('dragon lost');
        expect(dragon.flags & DRAGON_FLAG_IN_STORM, `${classId} tick ${tick}`).toBe(0);
        const radial = Math.hypot(dragon.position.x, dragon.position.z);
        if (radial > farthest) farthest = radial;
      }
      expect(farthest).toBeLessThan(260);
      expect(sim.getDragon(0)?.health).toBe(sim.getDragon(0)?.maxHealth);
    }
    // The collision world is shared by this file: give it its own wall back.
    terrain.setStormRadius(-1);
  });

  it('recovers from a stall instead of fighting it', () => {
    const sim = createSim();
    const dragon = sim.spawnDragon(0, TEAM_EMBER, 'bastion', { x: 0, y: 350, z: 0 }, 0);
    if (dragon === null) throw new Error('no dragon');
    dragon.speed = 8;
    dragon.pitch = 0.9;
    dragon.stamina = 1;
    const brain = new BotBrain(5);
    const ctx: BotContext = { state: sim.current, collision: null, arena: OPEN_SKY, playing: true };
    const frame = createInputFrame();
    const inputs: (InputFrame | undefined)[] = [];
    let lowest = Infinity;
    for (let tick = 0; tick < 8 * TICK_HZ; tick++) {
      ctx.state = sim.current;
      brain.think(ctx, 0, frame);
      frame.tick = tick;
      inputs[0] = frame;
      sim.step(tick, inputs);
      const y = sim.getDragon(0)?.position.y ?? 0;
      if (y < lowest) lowest = y;
    }
    const after = sim.getDragon(0);
    expect((after?.flags ?? 0) & 256).toBe(0);
    expect(after?.speed).toBeGreaterThan(30);
    // It gave up some height for speed, not hundreds of metres.
    expect(lowest).toBeGreaterThan(250);
  });
});

describe('fights', () => {
  it(
    'two bots 1v1 produce a takedown within two minutes, whatever the classes',
    () => {
      const firsts: string[] = [];
      for (const classId of DRAGON_CLASS_IDS) {
        for (const seed of [1, 2]) {
          const room = createRoom({ perTeam: 1, seed, classes: [classId] });
          // Siege mirrors trade slowly; give Granite / Bastion more clock.
          const seconds = classId === 'granite' || classId === 'bastion' ? 240 : 120;
          room.run(seconds * TICK_HZ);
          expect(room.tally.takedowns, `${classId} mirror, seed ${seed}`).toBeGreaterThanOrEqual(1);
          firsts.push(`${classId}/${seed}: ${(room.tally.firstTakedownTick / TICK_HZ).toFixed(0)} s`);
        }
      }
      for (const seed of [3, 4, 5, 6]) {
        const room = createRoom({ perTeam: 1, seed });
        room.run(120 * TICK_HZ);
        expect(room.tally.takedowns, `mixed, seed ${seed}`).toBeGreaterThanOrEqual(1);
        expect(room.tally.selfInflicted).toBe(0);
        firsts.push(`mixed/${seed}: ${(room.tally.firstTakedownTick / TICK_HZ).toFixed(0)} s`);
      }
      console.log(`[bots] first takedown of a 1v1: ${firsts.join(', ')}`);
    },
    180_000,
  );

  it('a 5v5 runs 3 minutes with no NaN, a plausible score and every kind of ability used', () => {
    const room = createRoom({ perTeam: 5, seed: 2, profile: true });
    let checked = 0;
    room.onFrame = (_id, frame) => {
      if (room.tick % 31 === 0) {
        expectSaneFrame(frame);
        checked++;
      }
    };
    room.run(180 * TICK_HZ);
    expect(checked).toBeGreaterThan(1000);
    const state = room.sim.current;
    for (const dragon of state.dragons) {
      expect(dragon.active).toBe(true);
      expect(
        Number.isFinite(dragon.position.x + dragon.position.y + dragon.position.z + dragon.speed),
      ).toBe(true);
      expect(Number.isFinite(dragon.health) && dragon.health >= 0).toBe(true);
    }
    const ember = state.teamTakedowns[TEAM_EMBER] ?? 0;
    const frost = state.teamTakedowns[TEAM_FROST] ?? 0;
    const micros = (room.thinkMs * 1000) / (180 * TICK_HZ) / room.brains.length;
    console.log(
      `[bots] 5v5 normal, 3 min: score ${ember}-${frost}, casts ${room.tally.casts.join('/')}, ` +
        `terrain damage ${room.tally.terrainDamage.toFixed(0)}, storm ${room.tally.stormDamage.toFixed(0)}, ` +
        `self-inflicted ${room.tally.selfInflicted}, think ${micros.toFixed(2)} us per bot per tick`,
    );
    // Plausible: both teams score, about a takedown every few seconds, not a massacre.
    expect(ember).toBeGreaterThanOrEqual(5);
    expect(frost).toBeGreaterThanOrEqual(5);
    expect(ember + frost).toBeLessThan(120);
    expect(Math.abs(ember - frost)).toBeLessThan(25);
    // Fought with everything, not just the primary.
    for (let slot = 0; slot < 4; slot++) expect(room.tally.casts[slot]).toBeGreaterThan(0);
    // The fight, not the scenery, decides it.
    expect(room.tally.selfInflicted).toBeLessThanOrEqual(1);
    expect(room.tally.stormDamage).toBeLessThan(50);
    expect(room.tally.terrainDamage).toBeLessThan(room.tally.abilityDamage * 0.05);
    // Budget: 20 us per bot per tick. Asserted loosely (a busy CI box), reported above.
    expect(micros).toBeLessThan(100);
  });

  it('hard bots beat easy bots', () => {
    let hard = 0;
    let easy = 0;
    for (const seed of [1, 2, 3]) {
      // Ember (even ids here: one per team) is hard on odd seeds and easy on even ones.
      const emberHard = seed % 2 === 1;
      const room = createRoom({
        perTeam: 3,
        seed,
        difficulty: emberHard
          ? ['hard', 'hard', 'hard', 'easy', 'easy', 'easy']
          : ['easy', 'easy', 'easy', 'hard', 'hard', 'hard'],
      });
      room.run(180 * TICK_HZ);
      const ember = room.sim.current.teamTakedowns[TEAM_EMBER] ?? 0;
      const frost = room.sim.current.teamTakedowns[TEAM_FROST] ?? 0;
      hard += emberHard ? ember : frost;
      easy += emberHard ? frost : ember;
    }
    console.log(`[bots] hard vs easy, 3v3, 3 x 3 min: ${hard}-${easy}`);
    expect(hard).toBeGreaterThan(easy * 1.3);
  });
});

describe('rules a bot keeps', () => {
  it('does nothing at all while the match is not being played', () => {
    const room = createRoom({ perTeam: 2, seed: 4, collision: null });
    room.ctx.playing = false;
    room.onFrame = (_id, frame) => {
      expect(frame.buttons).toBe(0);
      expect(frame.steerX).toBe(0);
      expect(frame.steerY).toBe(0);
    };
    room.run(5 * TICK_HZ);
    expect(room.tally.casts).toEqual([0, 0, 0, 0]);
    for (const brain of room.brains) expect(brain.targetId).toBe(NO_PLAYER);
    // Control handed over: now they go for each other.
    room.ctx.playing = true;
    room.onFrame = null;
    room.run(60 * TICK_HZ);
    expect(room.tally.casts[0]).toBeGreaterThan(0);
  });

  /** Two dragons nose to nose in open sky, 220 m apart. Returns the attack presses of bot 0. */
  function faceOff(classId: DragonClassId, protect: boolean): { attacks: number; damage: number } {
    const sim = createSim();
    sim.spawnDragon(0, TEAM_EMBER, classId, { x: 0, y: 350, z: -110 }, 0);
    sim.spawnDragon(1, TEAM_FROST, 'bastion', { x: 0, y: 350, z: 110 }, Math.PI);
    const brain = new BotBrain(9, { difficulty: 'hard' });
    const ctx: BotContext = { state: sim.current, collision: null, arena: OPEN_SKY, playing: true };
    const frame = createInputFrame();
    const inputs: (InputFrame | undefined)[] = [];
    const abilities = ABILITY_TABLE[classId];
    let attackButtons = BUTTON_PRIMARY;
    ABILITY_SLOTS.forEach((slot, index) => {
      const def = abilities[slot];
      // Afterburn is tagged an attack for its burning trail, but a bot also flies it to close
      // a long gap: that is not an attack on the protected target.
      const mobility = def.selfStatus === 'haste';
      if ((def.tags & ABILITY_TAG_ATTACK) !== 0 && !mobility)
        attackButtons |= BUTTON_PRIMARY << index;
    });
    let attacks = 0;
    for (let tick = 0; tick < 20 * TICK_HZ; tick++) {
      const victim = sim.getDragon(1);
      const self = sim.getDragon(0);
      if (victim === undefined || self === undefined) throw new Error('dragon lost');
      if (protect) victim.spawnProtectTicks = 60;
      // A full ultimate, so "it did not use it" is a decision and not an empty bar.
      self.ultCharge = 1;
      ctx.state = sim.current;
      brain.think(ctx, 0, frame);
      frame.tick = tick;
      if ((frame.buttons & attackButtons) !== 0) attacks++;
      inputs[0] = frame;
      sim.step(tick, inputs);
    }
    return { attacks, damage: sim.current.scores[0]?.damage ?? 0 };
  }

  it('holds every attack while its target is spawn protected, and opens fire once it is not', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const held = faceOff(classId, true);
      expect(held.attacks, classId).toBe(0);
      expect(held.damage, classId).toBe(0);
      const free = faceOff(classId, false);
      expect(free.attacks, classId).toBeGreaterThan(0);
      expect(free.damage, classId).toBeGreaterThan(0);
    }
  });

  it('cannot target a veiled enemy beyond a short range', () => {
    const sim = createSim();
    sim.spawnDragon(0, TEAM_EMBER, 'talon', { x: 0, y: 350, z: 0 }, 0);
    const ghost = sim.spawnDragon(1, TEAM_FROST, 'wraith', { x: 0, y: 350, z: 250 }, 0);
    if (ghost === null) throw new Error('no dragon');
    const brain = new BotBrain(3, { difficulty: 'hard' });
    const ctx: BotContext = { state: sim.current, collision: null, arena: OPEN_SKY, playing: true };
    const frame = createInputFrame();
    ghost.veilTicks = 1000;
    for (let i = 0; i < 2 * TICK_HZ; i++) {
      brain.think(ctx, 0, frame);
      expect(brain.targetId).toBe(NO_PLAYER);
      expect(frame.buttons & BUTTON_ABILITY_MASK).toBe(0);
    }
    // Right on top of it the veil no longer hides anything.
    ghost.position.z = BOT_TUNING.veilSightRange * 0.6;
    for (let i = 0; i < TICK_HZ; i++) brain.think(ctx, 0, frame);
    expect(brain.targetId).toBe(1);
    expect(brain.mode).toBe(BOT_MODE_ENGAGE);
    // And once the veil drops it is fair game at any range.
    ghost.position.z = 250;
    ghost.veilTicks = 0;
    for (let i = 0; i < TICK_HZ; i++) brain.think(ctx, 0, frame);
    expect(brain.targetId).toBe(1);
  });

  it('prefers the weaker of two enemies at a similar range and waits its reaction time', () => {
    const sim = createSim();
    sim.spawnDragon(0, TEAM_EMBER, 'talon', { x: 0, y: 350, z: 0 }, 0);
    const strong = sim.spawnDragon(1, TEAM_FROST, 'tempest', { x: -20, y: 350, z: 90 }, 0);
    const weak = sim.spawnDragon(2, TEAM_FROST, 'tempest', { x: 20, y: 350, z: 100 }, 0);
    if (strong === null || weak === null) throw new Error('no dragon');
    strong.spawnProtectTicks = 0;
    weak.spawnProtectTicks = 0;
    weak.health = weak.maxHealth * 0.2;
    const brain = new BotBrain(21, { difficulty: 'easy' });
    const ctx: BotContext = { state: sim.current, collision: null, arena: OPEN_SKY, playing: true };
    const frame = createInputFrame();
    let firstShot = -1;
    let acquired = -1;
    for (let i = 0; i < 4 * TICK_HZ && firstShot < 0; i++) {
      brain.think(ctx, 0, frame);
      if (acquired < 0 && brain.targetId !== NO_PLAYER) acquired = i;
      if ((frame.buttons & BUTTON_PRIMARY) !== 0) firstShot = i;
    }
    expect(brain.targetId).toBe(2);
    expect(acquired).toBeGreaterThanOrEqual(0);
    // Easy reacts in about 0.6 s (0.7 to 1.3 times that): never at once.
    const reaction = BOT_DIFFICULTY_TUNING.easy.reactionS * TICK_HZ;
    expect(firstShot - acquired).toBeGreaterThanOrEqual(Math.floor(reaction * 0.7) - 1);
  });
});

describe('determinism and cost', () => {
  function digestOf(seed: number, seconds: number): number {
    const room = createRoom({ perTeam: 2, seed });
    let digest = 0;
    room.onFrame = (id, frame) => {
      digest =
        (Math.imul(digest, 31) +
          Math.round(frame.steerX * 1e6) +
          Math.round(frame.steerY * 1e6) * 7 +
          frame.buttons * 13 +
          Math.round(frame.aimYaw * 1e6) * 17 +
          id) |
        0;
    };
    room.run(seconds * TICK_HZ);
    for (const dragon of room.sim.current.dragons) {
      if (dragon.active) digest = (Math.imul(digest, 31) + Math.round(dragon.position.x * 1e3)) | 0;
    }
    return digest;
  }

  it('the same seed gives the same match, a different seed a different one', () => {
    const a = digestOf(42, 60);
    expect(digestOf(42, 60)).toBe(a);
    expect(digestOf(43, 60)).not.toBe(a);
  });

  it('reset(seed) brings a used brain back to a new one', () => {
    const run = (brain: BotBrain): number => {
      const sim = createSim({ collisionWorld: terrain });
      const slot = map.spawnGates[0]?.slots[2];
      if (slot === undefined) throw new Error('no gate slot');
      sim.spawnDragon(0, TEAM_EMBER, 'wraith', slot, 0);
      const ctx: BotContext = {
        state: sim.current,
        collision: terrain,
        arena: GREYBOX,
        playing: true,
      };
      const frame = createInputFrame();
      const inputs: (InputFrame | undefined)[] = [];
      let digest = 0;
      for (let tick = 0; tick < 20 * TICK_HZ; tick++) {
        ctx.state = sim.current;
        brain.think(ctx, 0, frame);
        frame.tick = tick;
        digest = (Math.imul(digest, 31) + Math.round(frame.steerX * 1e6) + frame.buttons) | 0;
        inputs[0] = frame;
        sim.step(tick, inputs);
      }
      return digest;
    };
    const brain = new BotBrain(1234);
    const first = run(brain);
    brain.reset(1234);
    expect(run(brain)).toBe(first);
    expect(run(new BotBrain(1234))).toBe(first);
  });

  it('nine bots think inside the host tick budget (reported; asserted loosely)', () => {
    const room = createRoom({ perTeam: 5, seed: 7, profile: true });
    // Warm up, then measure a minute of fighting.
    room.run(20 * TICK_HZ);
    room.thinkMs = 0;
    const ticks = 60 * TICK_HZ;
    room.run(ticks);
    const micros = (room.thinkMs * 1000) / ticks / room.brains.length;
    console.log(
      `[bots] think: ${micros.toFixed(2)} us per bot per tick ` +
        `(${(micros * 9).toFixed(1)} us for nine bots; budget 20 us per bot)`,
    );
    expect(micros).toBeLessThan(100);
  });
});
