/**
 * The ability table (docs/GAME_DESIGN.md, "Dragons"): every number of the 16 abilities, the
 * projectile and zone kinds they create, and the combat rules around them. Pure data: the sim's
 * generic executors (`src/sim/abilities.ts` for the caster's own state, `src/sim/combat.ts` for
 * what the host decides) read these tables every tick, so the dev GUI can edit them live and a
 * balance change is a data edit. Host and clients must run the same values or prediction drifts.
 *
 * Units: seconds, metres, radians, HP. Durations become whole sim ticks (rounded up) when used.
 */

import type { AbilitySlot, DragonClassId } from './classes';
import type { ProjectileKind, ZoneKind } from './world-view';

// --- Kinds ---------------------------------------------------------------------------------------

/**
 * The generic executors. An ability is one of these plus numbers:
 * - `projectile`: launches `projectile` along the aim (one per pulse: see `pulseIntervalS`).
 * - `cone`: everything inside `coneHalfAngle` and `range` with a clear line to it takes `damage`
 *   and `status`.
 * - `beam`: a ray of thickness `radius` along the aim up to `range`; the first dragon it meets
 *   takes `damage`. Terrain stops it.
 * - `dash`: `impulseForward` / `impulseUp` / `speedGain` on the caster; while active, enemies
 *   within `radius` take `damage` once each.
 * - `buff`: `selfStatus` on the caster for `durationS`.
 * - `zone`: places `zone` at `zoneOffset` metres along the aim (0 = on the caster); with
 *   `pulseIntervalS` another one each pulse while active (a trail).
 * - `wave`: everything within `range` (and `coneHalfAngle` of the aim) takes `damage`, `status`
 *   and a `knockback` push away from the caster.
 */
export const ABILITY_KINDS = [
  'projectile',
  'cone',
  'beam',
  'dash',
  'buff',
  'zone',
  'wave',
] as const;

export type AbilityKind = (typeof ABILITY_KINDS)[number];

/**
 * The fixed set of timed effects a dragon can carry (not a generic buff system). Index = `u8`
 * wire value. Append only.
 * - `slow` / `haste`: speed multiplier (`power`).       - `burn`: `power` HP per second.
 * - `regen`: `power` HP healed per second.              - `blind`: a flag for the HUD/post.
 * - `veil`: invisible to enemies until it attacks.      - `phase`: passes through terrain,
 * - `shield`: blocks damage from the front.               cannot be hit.
 */
export const STATUS_KINDS = [
  'slow',
  'burn',
  'blind',
  'veil',
  'phase',
  'shield',
  'haste',
  'regen',
] as const;

export type StatusKind = (typeof STATUS_KINDS)[number];

/** Breaks the caster's veil and spawn protection when it fires. */
export const ABILITY_TAG_ATTACK = 1 << 0;
/** A held button fires again whenever the ability is ready (primaries). */
export const ABILITY_TAG_AUTO = 1 << 1;
/** Affects the caster's team (itself included) instead of its enemies. */
export const ABILITY_TAG_ALLIES = 1 << 2;
/**
 * A big effect the host confirms (docs/NETWORKING.md): it starts after `windupS`, during which
 * the caster shows DRAGON_FLAG_CHARGING, so the wind-up covers the round trip. Informational:
 * the timing itself is `windupS`.
 */
export const ABILITY_TAG_CONFIRMED = 1 << 3;

// --- Table shapes --------------------------------------------------------------------------------

/** One ability. Every field is always present (0 / null = unused), so entries are tunable flat. */
export interface AbilityDef {
  kind: AbilityKind;
  /** Bitmask of ABILITY_TAG_*. */
  tags: number;

  // Casting
  /** From firing until ready again (per charge when `maxCharges` > 1). */
  cooldownS: number;
  /** Charge time between the press and the effect. */
  windupS: number;
  /** Stored uses; 1 = plain cooldown. */
  maxCharges: number;
  /** Boost stamina (0..1) spent when it fires. */
  staminaCost: number;
  /** Ultimate charge (0..1) needed and spent. 1 for ultimates. */
  ultCost: number;

  // Effect on targets
  damage: number;
  /** Reach of a cone, beam or wave. */
  range: number;
  /** Half opening angle of a cone or wave. PI = all around. */
  coneHalfAngle: number;
  /** Beam thickness, dash contact radius. */
  radius: number;
  /** How far (radians) the shot may leave the nose toward the reticle. 0 = straight ahead. */
  aimLimit: number;
  status: StatusKind | null;
  statusS: number;
  /** Meaning depends on the status: speed scale, HP per second. */
  statusPower: number;
  /** m/s pushed away from the caster (wave). */
  knockback: number;

  // Over time
  /** How long the ability stays active after it fires (buff length, dash window, burst). */
  durationS: number;
  /** While active the effect repeats every this many seconds. 0 = once, when it fires. */
  pulseIntervalS: number;

  // What it creates
  projectile: ProjectileKind | null;
  zone: ZoneKind | null;
  /** Metres along the aim at which the zone is placed (terrain stops it). 0 = on the caster. */
  zoneOffset: number;

  // On the caster
  selfStatus: StatusKind | null;
  selfStatusPower: number;
  /** m/s added to the burst velocity along the nose / straight up. */
  impulseForward: number;
  impulseUp: number;
  /** m/s added to the airspeed. */
  speedGain: number;
  /** Metres the caster is moved along the nose when the ability fires (blink). */
  teleportForward: number;
}

export type ClassAbilities = Record<AbilitySlot, AbilityDef>;
export type AbilityTable = Record<DragonClassId, ClassAbilities>;

export interface ProjectileDef {
  /** m/s along the aim. */
  speed: number;
  /** m/s² downward. */
  gravity: number;
  /** Fraction of the caster's velocity the projectile keeps. */
  inheritVelocity: number;
  /** Metres, added to the target's hit radius. */
  radius: number;
  lifeS: number;
  /** > 0: it explodes where it ends and hurts everything within this many metres. */
  blastRadius: number;
  /** Fraction of the damage dealt at the edge of the blast (1 at the centre). */
  blastEdgeScale: number;
  /** Zone left where it ends. */
  zoneOnEnd: ZoneKind | null;
  /** Status applied to enemies in the blast (or the direct hit when there is no blast). */
  status: StatusKind | null;
  statusS: number;
  statusPower: number;
  /** Passes through dragons and terrain (decoy dragons). */
  passThrough: boolean;
  /**
   * How clients learn about it. `event`: the `abilityCast` event is the launch and every
   * client flies the projectile itself from the event (fast, short-lived bolts: no per-snapshot
   * bytes). `snapshot`: a record in every snapshot (slow or curved ones).
   */
  replication: 'event' | 'snapshot';
}

export interface ZoneDef {
  radius: number;
  durationS: number;
  /** Everything inside is affected every this many seconds. 0 = the zone does nothing. */
  pulseIntervalS: number;
  /** HP per pulse to enemies inside. */
  damage: number;
  /** Status given to enemies inside. */
  status: StatusKind | null;
  statusS: number;
  statusPower: number;
  /** Status given to allies inside (heal / buff bubbles). */
  allyStatus: StatusKind | null;
  allyStatusS: number;
  allyStatusPower: number;
  /**
   * Random sideways / vertical burst (m/s) applied to enemies each pulse. Makes steering feel
   * mushy when stacked with a slow.
   */
  driftPower: number;
  /** The zone stays on its owner and ends when the owner dies. */
  follow: boolean;
}

function ability(kind: AbilityKind, values: Partial<AbilityDef>): AbilityDef {
  return {
    kind,
    tags: 0,
    cooldownS: 1,
    windupS: 0,
    maxCharges: 1,
    staminaCost: 0,
    ultCost: 0,
    damage: 0,
    range: 0,
    coneHalfAngle: 0,
    radius: 0,
    aimLimit: 0,
    status: null,
    statusS: 0,
    statusPower: 0,
    knockback: 0,
    durationS: 0,
    pulseIntervalS: 0,
    projectile: null,
    zone: null,
    zoneOffset: 0,
    selfStatus: null,
    selfStatusPower: 0,
    impulseForward: 0,
    impulseUp: 0,
    speedGain: 0,
    teleportForward: 0,
    ...values,
  };
}

// --- The class kits (4 slots × 9 classes) ---------------------------------------------------------

/** First-pass balance, tuned by playtest. Ultimates cost a full charge and have no cooldown. */
export const ABILITY_TABLE: AbilityTable = {
  talon: {
    // Fire bolts: rapid projectiles.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.17,
      damage: 9,
      aimLimit: 0.3,
      projectile: 'fireBolt',
    }),
    // Searing dash: damaging lunge.
    secondary: ability('dash', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 6,
      damage: 36,
      radius: 8,
      durationS: 0.45,
      pulseIntervalS: 1 / 30,
      impulseForward: 62,
      speedGain: 18,
    }),
    // Afterburn: speed, and a trail that burns pursuers. The trail hurts, so it is an attack:
    // firing it gives up spawn protection.
    utility: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 12,
      durationS: 3,
      pulseIntervalS: 0.75,
      zone: 'burnTrail',
      selfStatus: 'haste',
      selfStatusPower: 1.3,
      speedGain: 10,
    }),
    // Meteor strafe: a line of fire bombs dropped along the flight path.
    ultimate: ability('projectile', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      damage: 55,
      durationS: 0.9,
      pulseIntervalS: 0.15,
      projectile: 'meteorBomb',
    }),
  },
  bastion: {
    // Flame cone: short range, sustained.
    primary: ability('cone', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.2,
      damage: 9,
      range: 42,
      coneHalfAngle: 0.38,
      aimLimit: 0.25,
    }),
    // Wing shield: blocks frontal damage.
    secondary: ability('buff', {
      tags: ABILITY_TAG_CONFIRMED,
      cooldownS: 11,
      windupS: 0.2,
      durationS: 2.6,
      selfStatus: 'shield',
    }),
    // Rally roar: allies near you heal over time.
    utility: ability('zone', {
      tags: ABILITY_TAG_ALLIES,
      cooldownS: 18,
      zone: 'rallyAura',
    }),
    // Bulwark charge: a surge forward and a knock-back wave.
    ultimate: ability('wave', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      damage: 40,
      range: 55,
      coneHalfAngle: Math.PI,
      knockback: 55,
      impulseForward: 30,
      selfStatus: 'shield',
      durationS: 1.5,
    }),
  },
  tempest: {
    // Lightning lance: charge-up beam, long range.
    primary: ability('beam', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.9,
      windupS: 0.5,
      damage: 42,
      range: 420,
      radius: 1.2,
      aimLimit: 0.35,
    }),
    // Static mine: area slow.
    secondary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 9,
      maxCharges: 2,
      damage: 12,
      aimLimit: 0.35,
      projectile: 'staticMine',
    }),
    // Updraft: vertical burst.
    utility: ability('dash', {
      cooldownS: 8,
      impulseUp: 42,
      speedGain: 8,
    }),
    // Thunderhead: a storm cloud that zaps an area.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      aimLimit: 0.35,
      zone: 'thunderhead',
      zoneOffset: 130,
    }),
  },
  wraith: {
    // Shade breath: damage over time.
    primary: ability('cone', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.25,
      damage: 4,
      range: 60,
      coneHalfAngle: 0.3,
      aimLimit: 0.25,
      status: 'burn',
      statusS: 2.5,
      statusPower: 9,
    }),
    // Veil: invisible until you attack.
    secondary: ability('buff', {
      tags: ABILITY_TAG_CONFIRMED,
      cooldownS: 14,
      windupS: 0.25,
      durationS: 5,
      selfStatus: 'veil',
    }),
    // Phase dive: pass through terrain for 1 s.
    utility: ability('buff', {
      tags: ABILITY_TAG_CONFIRMED,
      cooldownS: 10,
      windupS: 0.15,
      durationS: 1, // doc
      selfStatus: 'phase',
      speedGain: 8,
    }),
    // Night terror: blinds enemies in a cone.
    ultimate: ability('wave', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      damage: 12,
      range: 110,
      coneHalfAngle: 0.6,
      aimLimit: 0.3,
      status: 'blind',
      statusS: 3.5,
    }),
  },
  verdant: {
    // Bloom bolts: soft thorn projectiles.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.2,
      damage: 8,
      aimLimit: 0.3,
      projectile: 'bloomBolt',
    }),
    // Mending pod: bursts into a lingering heal bubble (allies regen; enemies take a tick).
    secondary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 9,
      maxCharges: 2,
      damage: 0,
      aimLimit: 0.35,
      projectile: 'rootSeed',
    }),
    // Spur bubble: ally haste field to fly through.
    utility: ability('zone', {
      tags: ABILITY_TAG_ALLIES,
      cooldownS: 12,
      aimLimit: 0.3,
      zone: 'updraftGarden',
      zoneOffset: 35,
    }),
    // Canopy: large team regen field.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ALLIES,
      cooldownS: 1,
      ultCost: 1,
      zone: 'canopy',
    }),
  },
  aureate: {
    // Prism shards: crystal bolts.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.22,
      damage: 11,
      aimLimit: 0.32,
      projectile: 'prismShard',
    }),
    // Flash orb: travels then pops a quick enemy-only whiteout.
    secondary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 10,
      damage: 4,
      aimLimit: 0.32,
      projectile: 'flashOrb',
    }),
    // Drift haze: larger bubble that slows and nudges enemies off their line.
    utility: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 11,
      aimLimit: 0.3,
      zone: 'solarLattice',
      zoneOffset: 45,
    }),
    // Solar lattice ultimate: lingering deny field ahead.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      aimLimit: 0.35,
      zone: 'galeWall',
      zoneOffset: 90,
    }),
  },
  zephyr: {
    // Gale bolts: faster fire, lighter hits.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.11,
      damage: 5,
      aimLimit: 0.3,
      projectile: 'galeBolt',
    }),
    // Blink: short teleport forward (no phase — avoids burying the rider in rock).
    secondary: ability('dash', {
      cooldownS: 7.5,
      durationS: 0.15,
      teleportForward: 42,
      impulseForward: 14,
      speedGain: 8,
    }),
    // Slipstream: forward + up speed burst.
    utility: ability('dash', {
      cooldownS: 7,
      impulseForward: 35,
      impulseUp: 18,
      speedGain: 18,
      selfStatus: 'haste',
      selfStatusPower: 1.25,
      durationS: 2,
    }),
    // Gale wall: deny a lane with wind.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      aimLimit: 0.3,
      zone: 'galeWall',
      zoneOffset: 70,
    }),
  },
  granite: {
    // Magma spit: heavy arcing bombs that cook off earlier.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.45,
      damage: 22,
      aimLimit: 0.22,
      projectile: 'magmaSpit',
    }),
    // Magma burst: proximity explosion around the body (closer = harder).
    secondary: ability('wave', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 9,
      damage: 34,
      range: 38,
      coneHalfAngle: Math.PI,
      knockback: 18,
    }),
    // Stone mend: self regen.
    utility: ability('buff', {
      tags: ABILITY_TAG_CONFIRMED,
      cooldownS: 14,
      windupS: 0.25,
      durationS: 4,
      selfStatus: 'regen',
      selfStatusPower: 14,
    }),
    // Crater smash: impact crater ahead.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      aimLimit: 0.25,
      zone: 'crater',
      zoneOffset: 35,
      impulseForward: 22,
    }),
  },
  mirage: {
    // Decoy bolts: soft phantom projectiles.
    primary: ability('projectile', {
      tags: ABILITY_TAG_ATTACK | ABILITY_TAG_AUTO,
      cooldownS: 0.18,
      damage: 7,
      aimLimit: 0.3,
      projectile: 'decoyBolt',
    }),
    // Phantom double: fake dragon that flies straight for 3 seconds.
    secondary: ability('projectile', {
      cooldownS: 11,
      damage: 0,
      aimLimit: 0.2,
      projectile: 'mirageDecoy',
    }),
    // Mirror step: short blink dash.
    utility: ability('dash', {
      cooldownS: 8,
      durationS: 0.28,
      impulseForward: 58,
      speedGain: 16,
    }),
    // Phantasm: blinding mirage field ahead.
    ultimate: ability('zone', {
      tags: ABILITY_TAG_ATTACK,
      cooldownS: 1,
      ultCost: 1,
      aimLimit: 0.3,
      zone: 'phantasm',
      zoneOffset: 55,
    }),
  },
};

function projectile(values: Partial<ProjectileDef>): ProjectileDef {
  return {
    speed: 0,
    gravity: 0,
    inheritVelocity: 0,
    radius: 0.8,
    lifeS: 1,
    blastRadius: 0,
    blastEdgeScale: 1,
    zoneOnEnd: null,
    status: null,
    statusS: 0,
    statusPower: 0,
    passThrough: false,
    replication: 'event',
    ...values,
  };
}

export const PROJECTILE_DEFS: Record<ProjectileKind, ProjectileDef> = {
  fireBolt: projectile({
    speed: 240,
    radius: 0.8,
    lifeS: 1.1,
    replication: 'event',
  }),
  meteorBomb: projectile({
    speed: 20,
    gravity: 30,
    inheritVelocity: 1,
    radius: 1.5,
    lifeS: 4,
    blastRadius: 18,
    blastEdgeScale: 0.4,
    replication: 'snapshot',
  }),
  staticMine: projectile({
    speed: 90,
    radius: 1.5,
    lifeS: 0.9,
    zoneOnEnd: 'staticField',
    replication: 'snapshot',
  }),
  bloomBolt: projectile({
    speed: 210,
    gravity: 4,
    radius: 0.9,
    lifeS: 1.15,
    replication: 'event',
  }),
  rootSeed: projectile({
    speed: 95,
    gravity: 4,
    radius: 1.4,
    lifeS: 1.05,
    zoneOnEnd: 'rootSnare',
    replication: 'snapshot',
  }),
  prismShard: projectile({
    speed: 280,
    radius: 0.65,
    lifeS: 0.95,
    replication: 'event',
  }),
  galeBolt: projectile({
    speed: 310,
    radius: 0.55,
    lifeS: 0.85,
    replication: 'event',
  }),
  magmaSpit: projectile({
    speed: 105,
    gravity: 26,
    inheritVelocity: 0.3,
    radius: 1.6,
    lifeS: 1.35,
    blastRadius: 14,
    blastEdgeScale: 0.45,
    replication: 'snapshot',
  }),
  decoyBolt: projectile({
    speed: 220,
    radius: 0.75,
    lifeS: 1.05,
    replication: 'event',
  }),
  flashOrb: projectile({
    speed: 130,
    gravity: 2,
    radius: 1.2,
    lifeS: 0.55,
    blastRadius: 32,
    blastEdgeScale: 0.2,
    status: 'blind',
    statusS: 1.35,
    statusPower: 1,
    replication: 'snapshot',
  }),
  mirageDecoy: projectile({
    speed: 78,
    radius: 2.8,
    lifeS: 3,
    passThrough: true,
    replication: 'snapshot',
  }),
};

function zone(values: Partial<ZoneDef>): ZoneDef {
  return {
    radius: 0,
    durationS: 0,
    pulseIntervalS: 0,
    damage: 0,
    status: null,
    statusS: 0,
    statusPower: 0,
    allyStatus: null,
    allyStatusS: 0,
    allyStatusPower: 0,
    driftPower: 0,
    follow: false,
    ...values,
  };
}

/** `stormWall` and `controlZone` are not ability zones: the map and the modes own them. */
export const ZONE_DEFS: Record<ZoneKind, ZoneDef> = {
  stormWall: zone({}),
  thunderhead: zone({ radius: 42, durationS: 7, pulseIntervalS: 0.5, damage: 13 }),
  staticField: zone({
    radius: 26,
    durationS: 7,
    pulseIntervalS: 0.25,
    status: 'slow',
    statusS: 1,
    statusPower: 0.55,
  }),
  controlZone: zone({}),
  burnTrail: zone({
    radius: 15,
    durationS: 3,
    pulseIntervalS: 0.25,
    status: 'burn',
    statusS: 1.5,
    statusPower: 10,
  }),
  rallyAura: zone({
    radius: 48,
    durationS: 5,
    pulseIntervalS: 0.5,
    allyStatus: 'regen',
    allyStatusS: 1,
    allyStatusPower: 9,
    follow: true,
  }),
  updraftGarden: zone({
    radius: 34,
    durationS: 5,
    pulseIntervalS: 0.35,
    allyStatus: 'haste',
    allyStatusS: 1.1,
    allyStatusPower: 1.18,
  }),
  canopy: zone({
    radius: 55,
    durationS: 8,
    pulseIntervalS: 0.45,
    allyStatus: 'regen',
    allyStatusS: 1.2,
    allyStatusPower: 12,
  }),
  solarLattice: zone({
    radius: 48,
    durationS: 5.5,
    pulseIntervalS: 0.25,
    status: 'slow',
    statusS: 0.7,
    statusPower: 0.72,
    driftPower: 14,
  }),
  galeWall: zone({
    radius: 28,
    durationS: 5,
    pulseIntervalS: 0.3,
    damage: 6,
    status: 'slow',
    statusS: 0.6,
    statusPower: 0.5,
  }),
  rootSnare: zone({
    radius: 28,
    durationS: 5.5,
    pulseIntervalS: 0.4,
    damage: 3,
    allyStatus: 'regen',
    allyStatusS: 1.1,
    allyStatusPower: 11,
  }),
  quakeField: zone({
    radius: 32,
    durationS: 2.5,
    pulseIntervalS: 0.35,
    damage: 16,
    status: 'slow',
    statusS: 0.9,
    statusPower: 0.55,
  }),
  crater: zone({
    radius: 38,
    durationS: 4,
    pulseIntervalS: 0.4,
    damage: 28,
    status: 'slow',
    statusS: 1,
    statusPower: 0.5,
  }),
  afterimage: zone({
    radius: 22,
    durationS: 2.5,
    pulseIntervalS: 0.5,
    damage: 4,
    status: 'blind',
    statusS: 1.2,
    statusPower: 1,
    follow: true,
  }),
  phantasm: zone({
    radius: 40,
    durationS: 5,
    pulseIntervalS: 0.4,
    damage: 6,
    status: 'blind',
    statusS: 2.5,
    statusPower: 1,
  }),
};

// --- Combat rules --------------------------------------------------------------------------------

export interface CombatTuning {
  /** A dragon's hit sphere for abilities is its `ClassTuning.hitRadius` times this. */
  hitRadiusScale: number;
  /** Wing shield: damage from within this angle of the nose is blocked... */
  shieldHalfAngle: number;
  /** ...by this fraction (1 = all of it). */
  shieldBlock: number;
  /** Damage and hostile effects on teammates are multiplied by this when friendly fire is on. */
  friendlyFireScale: number;
  /** Everyone who hurt the victim within this long before a takedown gets an assist. */
  assistWindowS: number;
  /** Terrain or the storm finishing a dragon is credited to whoever hurt it within this long. */
  creditWindowS: number;
  /** Ultimate charge (0..1) per HP of damage dealt and per takedown. */
  ultChargePerDamage: number;
  ultChargePerTakedown: number;
  /**
   * Ultimate charge per second alive. 0 (the doc: it charges by dealing damage and capturing
   * objectives). The host adds it, so with a value here a client's predicted charge trails by a
   * hair and is corrected a couple of times a second: harmless, but not free.
   */
  ultChargePerS: number;
  /** Burn and regen are applied in steps this far apart. */
  statusPulseS: number;
}

export const COMBAT_TUNING: CombatTuning = {
  hitRadiusScale: 1.8,
  shieldHalfAngle: 1.2,
  shieldBlock: 1,
  friendlyFireScale: 0.5,
  assistWindowS: 8,
  creditWindowS: 8,
  ultChargePerDamage: 1 / 450,
  ultChargePerTakedown: 0.08,
  ultChargePerS: 0,
  statusPulseS: 0.5,
};

// --- Pool sizes (fixed: the sim never allocates for these) ----------------------------------------

/** 10 dragons holding fire: about 65 bolts in the air at once. */
export const MAX_PROJECTILES = 128;
export const MAX_ZONES = 32;
/** Most projectile and zone records one snapshot carries (the nearest-to-expiry are dropped last). */
export const SNAPSHOT_MAX_PROJECTILES = 24;
export const SNAPSHOT_MAX_ZONES = 32;
/** Damagers remembered per dragon for assists. */
export const MAX_ASSISTS = 4;
