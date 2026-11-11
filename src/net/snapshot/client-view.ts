/**
 * The client's path from network state to the frame's WorldView, the counterpart of
 * `buildWorldView` in `src/game` (which the host uses on its authoritative sim states):
 *
 * - the dragon this browser flies comes from the `ClientPredictor` (predicted, with the
 *   reconciliation offset still being smoothed out);
 * - every other dragon comes from the `SnapshotBuffer` sample (interpolated in the past);
 * - the clock comes from the sample; the storm wall is passed in like on the host;
 * - slow projectiles and ability zones come from the sample; fast bolts are appended afterwards
 *   by `ClientBolts.writeView` (the session does it);
 * - `view.local` (cooldowns, ultimate, respawn) comes from the predicted dragon.
 *
 * The result is the same pooled `MutableWorldView` with the same conventions (storm wall is
 * zone id 0, health is a 0..1 fraction), so nothing downstream can tell which side built it.
 *
 * Team and class are not in snapshots (they are lobby data and never change mid-match): the
 * `ClientRoster` supplies them by player id.
 *
 * Runs every rendered frame and only writes numbers into reused objects.
 */

import {
  DEFAULT_DRAGON_CLASS,
  FLIGHT_TUNING,
  MATCH_TUNING,
  PROJECTILE_KINDS,
  TEAM_EMBER,
  ZONE_KINDS,
  acquireDragonView,
  acquireProjectileView,
  acquireZoneView,
  beginWorldView,
  writeLocalCombatView,
} from '../../shared';
import type {
  DragonClassId,
  MatchPhase,
  MatchRoster,
  MutableWorldView,
  PlayerId,
  TeamId,
} from '../../shared';
import type { ClientPredictor } from '../prediction/predictor';
import type { SnapshotSample } from './snapshot-buffer';

/** Zone id of the storm wall; the same value `src/game` uses on the host. */
export const CLIENT_STORM_WALL_ZONE_ID = 0;

const ID_SLOTS = 256;

/** Who flies what, by player id: the part of a dragon the snapshots leave out. */
export class ClientRoster {
  private readonly known = new Uint8Array(ID_SLOTS);
  private readonly teams: TeamId[] = [];
  private readonly classes: DragonClassId[] = [];

  constructor() {
    for (let i = 0; i < ID_SLOTS; i++) {
      this.teams.push(TEAM_EMBER);
      this.classes.push(DEFAULT_DRAGON_CLASS);
    }
  }

  clear(): void {
    this.known.fill(0);
  }

  set(playerId: PlayerId, team: TeamId, classId: DragonClassId): void {
    if (!Number.isInteger(playerId) || playerId < 0 || playerId >= ID_SLOTS) return;
    this.known[playerId] = 1;
    this.teams[playerId] = team;
    this.classes[playerId] = classId;
  }

  remove(playerId: PlayerId): void {
    if (playerId >= 0 && playerId < ID_SLOTS) this.known[playerId] = 0;
  }

  /** Replaces the contents with the riders of a match (`buildMatchRoster(lobbyState)`). */
  setFromMatchRoster(roster: MatchRoster): void {
    this.clear();
    for (let i = 0; i < roster.riders.length; i++) {
      const rider = roster.riders[i];
      if (rider !== undefined) this.set(rider.playerId, rider.team, rider.classId);
    }
  }

  has(playerId: PlayerId): boolean {
    return this.known[playerId] === 1;
  }

  /** The rider's team; TEAM_EMBER for an id the roster does not know. */
  teamOf(playerId: PlayerId): TeamId {
    return this.known[playerId] === 1 ? (this.teams[playerId] ?? TEAM_EMBER) : TEAM_EMBER;
  }

  /** The rider's class; the default class for an id the roster does not know. */
  classOf(playerId: PlayerId): DragonClassId {
    return this.known[playerId] === 1
      ? (this.classes[playerId] ?? DEFAULT_DRAGON_CLASS)
      : DEFAULT_DRAGON_CLASS;
  }
}

/** Same shape as the host builder's storm source, so `game/` passes the same object. */
export interface ClientStormWallSource {
  readonly stormCenterX: number;
  readonly stormCenterZ: number;
  readonly stormRadius: number;
}

export interface ClientWorldViewOptions {
  /** The dragon this browser controls, or NO_PLAYER (spectator, lobby). */
  readonly localDragonId: PlayerId;
  /** Read live each frame; null on a map without a storm wall. */
  readonly stormWall: ClientStormWallSource | null;
  /**
   * Overrides the phase from the snapshots. The reliable MATCH_PHASE message is the authority
   * on phase changes; pass its phase here once the session tracks it. Default: the sample's.
   */
  readonly phase?: MatchPhase;
  /**
   * Draw dragons the roster does not know (with the default team and class)? Default true: a
   * dragon in the wrong colours is better than an invisible one.
   */
  readonly showUnknown?: boolean;
  /**
   * Seconds a dead dragon waits to respawn, for `view.local.respawnInS`. Default:
   * MATCH_TUNING.respawnDelayS. Pass Infinity while the mode has respawns off.
   */
  readonly respawnDelayS?: number;
}

/**
 * Rewrites `view` for this frame.
 *
 * @param sample This frame's `SnapshotBuffer.sample` output (may be `valid: false`).
 * @param predictor The local dragon's predictor, or null when this client flies nothing.
 * @param alpha The client fixed loop's banked fraction of a tick, for the predicted dragon.
 */
export function buildClientWorldView(
  view: MutableWorldView,
  sample: Readonly<SnapshotSample>,
  predictor: ClientPredictor | null,
  alpha: number,
  roster: ClientRoster,
  options: ClientWorldViewOptions,
): MutableWorldView {
  beginWorldView(view);
  const localId = options.localDragonId;
  const predicted = predictor !== null && predictor.active && predictor.playerId === localId;
  const showUnknown = options.showUnknown !== false;

  if (predicted && predictor !== null) {
    predictor.writeView(acquireDragonView(view), alpha);
    writeLocalCombatView(
      view.local,
      predictor.dragon,
      options.respawnDelayS ?? MATCH_TUNING.respawnDelayS,
      FLIGHT_TUNING.dodgeCooldownS,
    );
  }

  if (sample.valid) {
    for (let i = 0; i < sample.dragonCount; i++) {
      const from = sample.dragons[i];
      if (from === undefined) continue;
      // The predicted dragon is in the snapshots too (quantized, in the past): skip that copy.
      if (predicted && from.id === localId) continue;
      if (!showUnknown && !roster.has(from.id)) continue;
      const out = acquireDragonView(view);
      out.id = from.id;
      out.team = roster.teamOf(from.id);
      out.classId = roster.classOf(from.id);
      out.position.x = from.position.x;
      out.position.y = from.position.y;
      out.position.z = from.position.z;
      out.orientation.x = from.orientation.x;
      out.orientation.y = from.orientation.y;
      out.orientation.z = from.orientation.z;
      out.orientation.w = from.orientation.w;
      out.velocity.x = from.velocity.x;
      out.velocity.y = from.velocity.y;
      out.velocity.z = from.velocity.z;
      out.health = from.health;
      out.stamina = from.stamina;
      out.flags = from.flags;
      out.anim = from.anim;
    }
  }

  const storm = options.stormWall;
  if (storm !== null) {
    const zone = acquireZoneView(view);
    zone.id = CLIENT_STORM_WALL_ZONE_ID;
    zone.kind = 'stormWall';
    zone.team = null;
    zone.position.x = storm.stormCenterX;
    zone.position.y = 0;
    zone.position.z = storm.stormCenterZ;
    // A radius a mode set travels in the snapshots; the source's own is the map's.
    zone.radius = sample.valid && sample.stormRadius >= 0 ? sample.stormRadius : storm.stormRadius;
  }

  if (sample.valid) {
    for (let i = 0; i < sample.zoneCount; i++) {
      const from = sample.zones[i];
      const kind = from !== undefined ? ZONE_KINDS[from.kind] : undefined;
      if (from === undefined || kind === undefined) continue;
      const zone = acquireZoneView(view);
      zone.id = from.id;
      zone.kind = kind;
      zone.team = from.team;
      zone.position.x = from.position.x;
      zone.position.y = from.position.y;
      zone.position.z = from.position.z;
      zone.radius = from.radius;
      zone.ownerId = from.ownerId;
      zone.remainingS = from.remainingS;
    }
    for (let i = 0; i < sample.projectileCount; i++) {
      const from = sample.projectiles[i];
      const kind = from !== undefined ? PROJECTILE_KINDS[from.kind] : undefined;
      if (from === undefined || kind === undefined) continue;
      const projectile = acquireProjectileView(view);
      projectile.id = from.id;
      projectile.kind = kind;
      projectile.ownerId = from.ownerId;
      projectile.team = from.team;
      projectile.position.x = from.position.x;
      projectile.position.y = from.position.y;
      projectile.position.z = from.position.z;
      projectile.velocity.x = from.velocity.x;
      projectile.velocity.y = from.velocity.y;
      projectile.velocity.z = from.velocity.z;
    }
  }

  view.localDragonId = localId;
  const clock = view.clock;
  if (sample.valid) {
    clock.tick = Math.floor(sample.playTick);
    clock.phase = options.phase ?? sample.phase;
    clock.phaseTimeS = sample.phaseTimeS;
    clock.timeRemainingS = sample.timeRemainingS;
    clock.round = sample.round;
  } else {
    clock.tick = 0;
    clock.phase = options.phase ?? 'lobby';
    clock.phaseTimeS = 0;
    clock.timeRemainingS = Infinity;
    clock.round = 1;
  }
  return view;
}
