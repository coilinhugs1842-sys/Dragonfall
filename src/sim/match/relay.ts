/**
 * Ember Relay's rules (T-6.3): capture the flag with sky-shards.
 *
 * Each team owns a shard that rests on a stand at its base, and a brazier beside it. Per tick of
 * play, for each shard:
 *
 *   HOME     a living enemy that touches it takes it                              -> `pickedUp`
 *   CARRIED  it rides with the carrier. The carrier is slowed
 *            (`carrierSpeedScale`) and cannot stay veiled, so everybody sees it.
 *            Carrier reaches its own brazier                                      -> `captured`
 *            Carrier is down or gone: the shard stays where that happened         -> `dropped`
 *   DROPPED  a living dragon of the owning team touches it: it goes home          -> `returned`
 *            a living enemy touches it: carried again                             -> `pickedUp`
 *            nobody for `dropReturnS`: it goes home by itself                     -> `returned`
 *
 * Touching is being within `pickupRadiusM` of the shard, scoring within `captureRadiusM` of the
 * brazier. When an owner and an enemy touch a dropped shard on the same tick the owner wins.
 * A capture counts whether or not the scoring team's own shard is home, unless
 * `captureNeedsShardHome` says otherwise.
 *
 * A dropped shard is put into open air first (`settleInOpenAir`): above the cloud sea, under
 * the ceiling, inside the storm wall and out of the rock. If no open spot is near (it fell deep
 * inside a spire) it goes straight home.
 *
 * THE CARRIER'S PRICE uses the dragon's own slow status (`slowTicks`, `slowScale`), topped up
 * every tick: those two numbers already travel to the carrier's browser in the snapshot's owner
 * block, so its prediction flies at the same speed as the host and nothing new is on the wire.
 * A stronger slow from an enemy still applies on top.
 *
 * The state lives in `SimState.relay`; this class only keeps the map. Every change bumps
 * `relay.revision`. Deterministic, and allocation-free per tick.
 */

import {
  DRAGON_FLAG_ALIVE,
  MODE_TUNING,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../shared';
import type { EmberRelayTuning, ModeTuning, MutableVec3, PlayerId, TeamId, Vec3 } from '../../shared';
import type { DragonState } from '../dragon-state';
import { writeStatusFlags } from '../flight';
import type { Sim } from '../sim';
import type { RelayShardState, RelayState, SimState } from '../sim-state';
import { secondsToTicks } from '../ticks';
import { settleInOpenAir, writeRelaySites } from './relay-sites';
import type { RelayArena } from './relay-sites';

/**
 * Ticks of slow the carrier always has left. Long enough that the carrier's own browser, which
 * counts the timer down between snapshots, never sees it run out while it still carries.
 */
const CARRIER_SLOW_HOLD_TICKS = 15;

/** Two gates facing each other in open sky: what a match without a map (a test) plays on. */
const OPEN_SKY_ARENA: RelayArena = {
  gates: [
    { x: 0, y: 320, z: -300 },
    { x: 0, y: 320, z: 300 },
  ],
  centerX: 0,
  centerZ: 0,
  radius: 0,
  floorY: 0,
  ceilingY: 800,
  terrain: null,
};

function isAlive(dragon: Readonly<DragonState>): boolean {
  return dragon.active && (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
}

function distanceSq(a: Readonly<Vec3>, b: Readonly<Vec3>): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function copyInto(out: MutableVec3, from: Readonly<Vec3>): void {
  out.x = from.x;
  out.y = from.y;
  out.z = from.z;
}

export class RelayRules {
  /**
   * Who scored on the last `step`, per scoring team (index = TeamId); NO_PLAYER = that team did
   * not score. The director reads it right after the step.
   */
  readonly capturer: PlayerId[] = [NO_PLAYER, NO_PLAYER];

  private readonly modeTuning: ModeTuning;
  private arena: RelayArena = OPEN_SKY_ARENA;
  /** Scratch: where a shard is about to be dropped. */
  private readonly spot: MutableVec3 = { x: 0, y: 0, z: 0 };

  constructor(modeTuning: ModeTuning = MODE_TUNING) {
    this.modeTuning = modeTuning;
  }

  /**
   * A new match: places the stands and braziers for the map and puts both shards home.
   * `arena` null = open sky with two gates facing each other.
   */
  begin(sim: Sim, arena: Readonly<RelayArena> | null): void {
    this.arena = arena ?? OPEN_SKY_ARENA;
    this.capturer[0] = NO_PLAYER;
    this.capturer[1] = NO_PLAYER;
    const relay = sim.relay;
    writeRelaySites(relay.stands, relay.braziers, this.arena, this.modeTuning.emberRelay);
    relay.active = true;
    for (let team = 0; team < 2; team++) {
      const shard = relay.shards[team];
      const stand = relay.stands[team];
      if (shard === undefined || stand === undefined) continue;
      shard.status = SHARD_HOME;
      shard.carrierId = NO_PLAYER;
      shard.returnTick = -1;
      copyInto(shard.position, stand);
    }
    relay.revision++;
  }

  /** One tick of play, after `sim.step`. */
  step(sim: Sim, tick: number): void {
    this.capturer[0] = NO_PLAYER;
    this.capturer[1] = NO_PLAYER;
    const relay = sim.relay;
    if (!relay.active) return;
    const tuning = this.modeTuning.emberRelay;
    const state = sim.current;
    this.stepShard(sim, state, relay, TEAM_EMBER, tick, tuning);
    this.stepShard(sim, state, relay, TEAM_FROST, tick, tuning);
  }

  private stepShard(
    sim: Sim,
    state: Readonly<SimState>,
    relay: RelayState,
    owner: TeamId,
    tick: number,
    tuning: EmberRelayTuning,
  ): void {
    const shard = relay.shards[owner];
    const stand = relay.stands[owner];
    if (shard === undefined || stand === undefined) return;

    if (shard.status === SHARD_CARRIED) {
      const carrier = sim.getDragon(shard.carrierId);
      if (carrier === undefined || !isAlive(carrier) || carrier.team === owner) {
        // Down (the dragon is still there, falling) or gone (the rider left): where it was.
        if (carrier !== undefined) copyInto(shard.position, carrier.position);
        this.drop(sim, relay, shard, owner, stand, tick, tuning);
        return;
      }
      copyInto(shard.position, carrier.position);
      this.burden(carrier, tuning);
      const brazier = relay.braziers[carrier.team];
      const own = relay.shards[carrier.team];
      if (brazier === undefined || own === undefined) return;
      if (tuning.captureNeedsShardHome && own.status !== SHARD_HOME) return;
      const reach = tuning.captureRadiusM;
      if (distanceSq(carrier.position, brazier) > reach * reach) return;
      this.capturer[carrier.team] = carrier.id;
      this.unburden(carrier, tuning);
      this.sendHome(relay, shard, stand);
      sim.emitObjective('captured', carrier.team, carrier.id, brazier);
      return;
    }

    if (shard.status === SHARD_DROPPED && tick >= shard.returnTick) {
      sim.emitObjective('returned', owner, NO_PLAYER, shard.position);
      this.sendHome(relay, shard, stand);
      return;
    }

    // Home or dropped: who touches it? The nearest of each side, so the result does not depend
    // on the order of the slots.
    const reach = tuning.pickupRadiusM;
    let friend: DragonState | undefined;
    let friendSq = reach * reach;
    let enemy: DragonState | undefined;
    let enemySq = reach * reach;
    const dragons = state.dragons;
    for (let i = 0; i < dragons.length; i++) {
      const dragon = dragons[i];
      if (dragon === undefined || !isAlive(dragon)) continue;
      const gap = distanceSq(dragon.position, shard.position);
      if (dragon.team === owner) {
        if (gap <= friendSq && (friend === undefined || gap < friendSq)) {
          friend = dragon;
          friendSq = gap;
        }
      } else if (gap <= enemySq && (enemy === undefined || gap < enemySq)) {
        enemy = dragon;
        enemySq = gap;
      }
    }

    if (shard.status === SHARD_DROPPED && friend !== undefined) {
      sim.emitObjective('returned', owner, friend.id, shard.position);
      this.sendHome(relay, shard, stand);
      return;
    }
    if (enemy !== undefined) {
      shard.status = SHARD_CARRIED;
      shard.carrierId = enemy.id;
      shard.returnTick = -1;
      sim.emitObjective('pickedUp', enemy.team, enemy.id, shard.position);
      copyInto(shard.position, enemy.position);
      this.burden(enemy, tuning);
      relay.revision++;
    }
  }

  /** The carrier lost the shard at `shard.position`: it lies in the nearest open air, or goes home. */
  private drop(
    sim: Sim,
    relay: RelayState,
    shard: RelayShardState,
    owner: TeamId,
    stand: Readonly<Vec3>,
    tick: number,
    tuning: EmberRelayTuning,
  ): void {
    const dropperId = shard.carrierId;
    const spot = this.spot;
    copyInto(spot, shard.position);
    const open =
      Number.isFinite(spot.x + spot.y + spot.z) &&
      settleInOpenAir(spot, this.arena, tuning, tuning.dropClearanceM);
    if (!open) {
      // Nowhere for it to lie: straight home.
      sim.emitObjective('dropped', owner, dropperId, stand);
      sim.emitObjective('returned', owner, NO_PLAYER, stand);
      this.sendHome(relay, shard, stand);
      return;
    }
    shard.status = SHARD_DROPPED;
    shard.carrierId = NO_PLAYER;
    copyInto(shard.position, spot);
    const wait = secondsToTicks(tuning.dropReturnS);
    shard.returnTick = tick + (wait > 1 ? wait : 1);
    relay.revision++;
    sim.emitObjective('dropped', owner, dropperId, spot);
  }

  private sendHome(relay: RelayState, shard: RelayShardState, stand: Readonly<Vec3>): void {
    shard.status = SHARD_HOME;
    shard.carrierId = NO_PLAYER;
    shard.returnTick = -1;
    copyInto(shard.position, stand);
    relay.revision++;
  }

  /** The carrier's price for this tick: slowed, and seen by everybody. */
  private burden(carrier: DragonState, tuning: EmberRelayTuning): void {
    const scale = tuning.carrierSpeedScale;
    let changed = false;
    if (scale > 0 && scale < 1) {
      if (carrier.slowTicks <= CARRIER_SLOW_HOLD_TICKS) {
        changed = carrier.slowTicks <= 0;
        carrier.slowTicks = CARRIER_SLOW_HOLD_TICKS;
        carrier.slowScale = scale;
      } else if (!(carrier.slowScale <= scale)) {
        // An enemy's weaker slow is running: the burden is the floor.
        carrier.slowScale = scale;
      }
    }
    if (carrier.veilTicks > 0) {
      carrier.veilTicks = 0;
      changed = true;
    }
    // The flag bits were written before this ran (end of the dragon's step).
    if (changed) writeStatusFlags(carrier);
  }

  /** Scored: the burden's own slow ends now instead of trailing on for half a second. */
  private unburden(carrier: DragonState, tuning: EmberRelayTuning): void {
    if (
      carrier.slowTicks > 0 &&
      carrier.slowTicks <= CARRIER_SLOW_HOLD_TICKS &&
      carrier.slowScale === tuning.carrierSpeedScale
    ) {
      carrier.slowTicks = 0;
      writeStatusFlags(carrier);
    }
  }
}
