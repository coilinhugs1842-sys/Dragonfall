/**
 * The caster's side of abilities (T-3.2): cooldowns, charges, wind-ups, active timers and what
 * an ability does to the dragon that uses it (impulses, haste, shield, veil, phase). It is part
 * of the per-dragon tick (`integrateDragon` calls `stepAbilities`), so a client predicts it for
 * its own dragon with the very code the host runs, and the state it needs travels in the
 * snapshot's owner block.
 *
 * What an ability does to the WORLD (projectiles, cones, beams, zones, damage) is decided by the
 * host only, in `combat.ts`. The link between the two is two bitmasks rewritten every tick:
 * - `castStarted`: slots that fired a new cast this tick;
 * - `castPulse`: slots whose effect applies this tick (the cast, each burst shot, each trail
 *   drop, each tick of a dash).
 *
 * LIFE OF A CAST: button (a press; a hold for ABILITY_TAG_AUTO) -> if the slot is ready:
 * wind-up of `windupS` (one at a time; DRAGON_FLAG_CHARGING) -> FIRE: pay stamina and ultimate
 * charge, start the cooldown, apply the self effects, pulse -> active for `durationS`, pulsing
 * every `pulseIntervalS`.
 *
 * Everything is data from the ability table (read live), whole ticks, no randomness, and nothing
 * here allocates.
 */

import {
  ABILITY_SLOTS,
  ABILITY_TAG_ATTACK,
  ABILITY_TAG_AUTO,
  BUTTON_AIM,
  BUTTON_PRIMARY,
} from '../shared';
import type { AbilityDef, ClassAbilities, FlightTuning, MutableVec3 } from '../shared';
import type { DragonState } from './dragon-state';
import {
  cooldownTicksOf,
  durationTicksOf,
  pulseTicksOf,
  secondsToTicks,
  windupTicksOf,
} from './ticks';

export const ABILITY_SLOT_COUNT = ABILITY_SLOTS.length;

const EPSILON = 1e-6;
/** Speed multipliers from tuning are kept inside this range whatever the table says. */
const MIN_MOVE_SCALE = 0.2;
const MAX_MOVE_SCALE = 3;

/** The slot's entry of a class's abilities (index = ABILITY_SLOTS). */
export function abilityOfSlot(defs: ClassAbilities, slot: number): AbilityDef | undefined {
  const name = ABILITY_SLOTS[slot];
  return name === undefined ? undefined : defs[name];
}

function maxChargesOf(def: AbilityDef): number {
  return def.maxCharges > 1 ? Math.floor(def.maxCharges) : 1;
}

/** Could the slot start (or finish winding up) right now? Everything but the button. */
function slotReady(dragon: DragonState, slot: number, def: AbilityDef): boolean {
  if ((dragon.abilityActiveTicks[slot] ?? 0) > 0) return false;
  const cooldown = dragon.abilityCooldownTicks[slot] ?? 0;
  const max = maxChargesOf(def);
  if (max > 1 ? (dragon.abilityChargesUsed[slot] ?? 0) >= max : cooldown > 0) return false;
  if (def.staminaCost > 0 && dragon.stamina < def.staminaCost) return false;
  if (def.ultCost > 0 && dragon.ultCharge < def.ultCost - EPSILON) return false;
  // Out of phase with the world: nothing to hit, and nothing may be hit from there.
  if ((def.tags & ABILITY_TAG_ATTACK) !== 0 && dragon.phaseTicks > 0) return false;
  return true;
}

function fire(dragon: DragonState, slot: number, def: AbilityDef, flight: FlightTuning): void {
  const bit = 1 << slot;

  if (def.staminaCost > 0) {
    dragon.stamina -= def.staminaCost;
    if (dragon.stamina < 0) dragon.stamina = 0;
    dragon.staminaRegenDelayTicks = secondsToTicks(flight.staminaRegenDelayS);
  }
  if (def.ultCost > 0) {
    dragon.ultCharge -= def.ultCost;
    if (!(dragon.ultCharge > 0)) dragon.ultCharge = 0;
  }

  const cooldown = cooldownTicksOf(def);
  if (maxChargesOf(def) > 1) {
    dragon.abilityChargesUsed[slot] = (dragon.abilityChargesUsed[slot] ?? 0) + 1;
    // The recharge of an earlier charge keeps running.
    if ((dragon.abilityCooldownTicks[slot] ?? 0) <= 0) dragon.abilityCooldownTicks[slot] = cooldown;
  } else {
    dragon.abilityCooldownTicks[slot] = cooldown;
  }

  const tags = def.tags;
  const stream = (tags & ABILITY_TAG_AUTO) !== 0 && !(def.windupS > 0);
  // A held breath is one cast, not one per tick of it: only its first shot starts one. Bolts
  // are separate casts, because each `abilityCast` event is a bolt on the clients.
  if (!(stream && def.projectile === null && dragon.firingTicks > 0)) dragon.castStarted |= bit;
  if (stream) dragon.firingTicks = cooldown + 2;
  dragon.castPulse |= bit;
  dragon.abilityActiveTicks[slot] = durationTicksOf(def);
  // Only a dash reads the mask ("each target once per dash"); another ability fired during the
  // dash (a held primary) must not hand the dash its targets back.
  if (def.kind === 'dash') dragon.abilityHitMask = 0;

  if ((tags & ABILITY_TAG_ATTACK) !== 0) {
    dragon.spawnProtectTicks = 0;
    dragon.veilTicks = 0;
  }

  // --- On the caster ----------------------------------------------------------------------------
  if (def.impulseForward !== 0) {
    const cosPitch = Math.cos(dragon.pitch);
    dragon.burst.x += Math.sin(dragon.yaw) * cosPitch * def.impulseForward;
    dragon.burst.y += Math.sin(dragon.pitch) * def.impulseForward;
    dragon.burst.z += Math.cos(dragon.yaw) * cosPitch * def.impulseForward;
  }
  if (def.impulseUp !== 0) dragon.burst.y += def.impulseUp;
  if (def.speedGain !== 0) dragon.speed += def.speedGain;

  const self = def.selfStatus;
  if (self !== null) {
    const ticks = durationTicksOf(def);
    if (self === 'haste') {
      dragon.hasteTicks = ticks;
      dragon.hasteScale = def.selfStatusPower;
    } else if (self === 'shield') dragon.shieldTicks = ticks;
    else if (self === 'veil') dragon.veilTicks = ticks;
    else if (self === 'phase') dragon.phaseTicks = ticks;
    else if (self === 'regen') {
      dragon.regenTicks = ticks;
      dragon.regenPerS = def.selfStatusPower;
    }
  }
}

/**
 * One tick of a living dragon's abilities. `buttons` are the buttons held this tick and
 * `pressed` the ones that went down on it. Writes `castStarted` / `castPulse` and the caster's
 * own state; see the top of the file.
 */
export function stepAbilities(
  dragon: DragonState,
  buttons: number,
  pressed: number,
  defs: ClassAbilities,
  flight: FlightTuning,
): void {
  dragon.castStarted = 0;
  dragon.castPulse = 0;
  if (dragon.firingTicks > 0) dragon.firingTicks--;

  // --- Timers -----------------------------------------------------------------------------------
  for (let slot = 0; slot < ABILITY_SLOT_COUNT; slot++) {
    const def = abilityOfSlot(defs, slot);
    if (def === undefined) continue;

    let cooldown = dragon.abilityCooldownTicks[slot] ?? 0;
    if (cooldown > 0) {
      cooldown--;
      if (cooldown === 0 && maxChargesOf(def) > 1) {
        const used = (dragon.abilityChargesUsed[slot] ?? 0) - 1;
        dragon.abilityChargesUsed[slot] = used > 0 ? used : 0;
        if (used > 0) cooldown = cooldownTicksOf(def);
      }
      dragon.abilityCooldownTicks[slot] = cooldown;
    }

    let active = dragon.abilityActiveTicks[slot] ?? 0;
    if (active > 0) {
      active--;
      dragon.abilityActiveTicks[slot] = active;
      const interval = pulseTicksOf(def);
      if (interval > 0 && active > 0) {
        const elapsed = durationTicksOf(def) - active;
        if (elapsed > 0 && elapsed % interval === 0) dragon.castPulse |= 1 << slot;
      }
    }
  }

  // --- Wind-up in progress: nothing else can start ------------------------------------------------
  if (dragon.castSlot >= 0) {
    dragon.castTicks--;
    if (dragon.castTicks <= 0) {
      const slot = dragon.castSlot;
      const def = abilityOfSlot(defs, slot);
      dragon.castSlot = -1;
      dragon.castTicks = 0;
      // Paid when it fires, so it fizzles if the price can no longer be paid.
      if (def !== undefined && slotReady(dragon, slot, def)) fire(dragon, slot, def, flight);
    }
    return;
  }

  // --- New casts, in slot order -------------------------------------------------------------------
  for (let slot = 0; slot < ABILITY_SLOT_COUNT; slot++) {
    const def = abilityOfSlot(defs, slot);
    if (def === undefined) continue;
    const button = BUTTON_PRIMARY << slot;
    const wanted = ((def.tags & ABILITY_TAG_AUTO) !== 0 ? buttons : pressed) & button;
    if (wanted === 0 || !slotReady(dragon, slot, def)) continue;
    const windup = windupTicksOf(def);
    if (windup > 0) {
      dragon.castSlot = slot;
      dragon.castTicks = windup;
      return;
    }
    fire(dragon, slot, def, flight);
  }
}

/** Death: a wind-up is dropped and nothing stays active. Cooldowns keep their time. */
export function cancelAbilities(dragon: DragonState): void {
  dragon.castStarted = 0;
  dragon.castPulse = 0;
  dragon.castSlot = -1;
  dragon.castTicks = 0;
  dragon.firingTicks = 0;
  dragon.abilityActiveTicks.fill(0);
}

/**
 * Speed multiplier from the slow and haste statuses (1 = none). Applied to the cruise and top
 * speeds by the flight model.
 */
export function moveScaleOf(dragon: Readonly<DragonState>): number {
  let scale = 1;
  if (dragon.slowTicks > 0) scale *= dragon.slowScale;
  if (dragon.hasteTicks > 0) scale *= dragon.hasteScale;
  if (scale === 1) return 1;
  // `!(>=)` also catches NaN.
  if (!(scale >= MIN_MOVE_SCALE)) return MIN_MOVE_SCALE;
  return scale > MAX_MOVE_SCALE ? MAX_MOVE_SCALE : scale;
}

/**
 * The unit direction an ability fires along, into `out`: the dragon's aim (from its input, see
 * `InputFrame.aimYaw`) if it has one, but never further than `aimLimit` radians from the nose.
 * Without an aim, or with `aimLimit` 0, that is the nose itself. The host uses it for every
 * shot; a client calls it on its predicted dragon to draw its own shot at once.
 */
export function resolveFireDirection(
  dragon: Readonly<DragonState>,
  aimLimit: number,
  out: MutableVec3,
): MutableVec3 {
  aimScratch.aimLimit = aimLimit;
  return fireDirectionOf(dragon, aimScratch, out);
}

const aimScratch = { aimLimit: 0 };

/**
 * `resolveFireDirection` for callers in the tick: the limit is read from the ability (any
 * object with an `aimLimit`), because a float handed to a call that is not inlined is boxed.
 */
export function fireDirectionOf(
  dragon: Readonly<DragonState>,
  ability: { readonly aimLimit: number },
  out: MutableVec3,
): MutableVec3 {
  const aimLimit = ability.aimLimit;
  const cosPitch = Math.cos(dragon.pitch);
  const noseX = Math.sin(dragon.yaw) * cosPitch;
  const noseY = Math.sin(dragon.pitch);
  const noseZ = Math.cos(dragon.yaw) * cosPitch;
  out.x = noseX;
  out.y = noseY;
  out.z = noseZ;
  if ((dragon.prevButtons & BUTTON_AIM) === 0 || !(aimLimit > 0)) return out;

  const cosAim = Math.cos(dragon.aimPitch);
  const aimX = Math.sin(dragon.aimYaw) * cosAim;
  const aimY = Math.sin(dragon.aimPitch);
  const aimZ = Math.cos(dragon.aimYaw) * cosAim;
  const dot = noseX * aimX + noseY * aimY + noseZ * aimZ;
  // NaN aim: keep the nose.
  if (!(dot >= -1)) return out;
  if (dot >= Math.cos(aimLimit)) {
    out.x = aimX;
    out.y = aimY;
    out.z = aimZ;
    return out;
  }
  // Outside the window: the edge of the window on the aim's side.
  let perpX = aimX - noseX * dot;
  let perpY = aimY - noseY * dot;
  let perpZ = aimZ - noseZ * dot;
  const perp = Math.sqrt(perpX * perpX + perpY * perpY + perpZ * perpZ);
  // Aiming straight back has no side: keep the nose.
  if (!(perp > EPSILON)) return out;
  perpX /= perp;
  perpY /= perp;
  perpZ /= perp;
  const cos = Math.cos(aimLimit);
  const sin = Math.sin(aimLimit);
  out.x = noseX * cos + perpX * sin;
  out.y = noseY * cos + perpY * sin;
  out.z = noseZ * cos + perpZ * sin;
  return out;
}
