/**
 * Builds `UiState.hud` (and the results table) for the match on screen, once per rendered frame,
 * from what every kind of session offers alike: the frame's WorldView, the lobby (names, teams,
 * classes), the per-rider totals and the GameEvents. Host and client HUDs are therefore the same
 * code fed from different sources.
 *
 * ALLOCATION. `frame` and the event handlers only write numbers and existing strings into the
 * pooled `MutableHudState` (`src/ui/hud`). Strings are made when the LOBBY object changes (the
 * name table) and when the match ends (the results), never per frame.
 *
 * ANGLES. Damage arcs and compass markers are screen angles (`screenAngle`): clockwise from
 * straight ahead as the camera looks, so they are computed from the camera's heading, not the
 * dragon's.
 */

import {
  ABILITY_SLOTS,
  DEFAULT_DRAGON_CLASS,
  DRAGON_FLAG_ALIVE,
  HUD_COMPASS_MARKERS,
  MATCH_TUNING,
  MAX_PLAYERS,
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  findDragonView,
} from '../shared';
import type {
  DragonClassId,
  DragonView,
  GameEventSource,
  HitEvent,
  HudCompassKind,
  LobbyState,
  MatchPlayerStats,
  MatchWinner,
  ModeId,
  ObjectiveEvent,
  PlayerId,
  ResultsState,
  ScoreboardRow,
  TakedownEvent,
  TeamId,
  Unsubscribe,
  Vec3,
  WorldView,
} from '../shared';
import {
  ageHudState,
  createHudState,
  pushDamageArc,
  pushKillfeed,
  pushShardEvent,
  resetHudState,
  screenAngle,
  writeHudClock,
  writeHudLocal,
} from '../ui/hud';
import type { MutableHudState } from '../ui/hud';

/** Player ids are a `u8`. */
const ID_SLOTS = 256;
/** HP of one hit that draws the heaviest damage arc. */
const DAMAGE_ARC_FULL_HP = 40;
const UNKNOWN_NAME = 'Rider';
/** Captions of the four ability slots under the default bindings. */
const DEFAULT_KEY_LABELS: readonly string[] = ['LMB', 'RMB', 'F', 'R'];

/**
 * What one shard brought home weighs in the MVP score. A takedown is worth 100 plus the damage
 * that went into it (a few hundred HP), so this is about two takedowns: the rider who carried
 * the shards home leads unless somebody else carried the fight alone.
 */
const MVP_CAPTURE_POINTS = 1000;

/**
 * Shards a rider brought home (Ember Relay). The stats rows of the host's director and of a
 * client's scoreboard both carry it; a row without it (another mode's table, a test) counts 0.
 */
function capturesOf(row: Readonly<MatchPlayerStats>): number {
  const captures = (row as { readonly captures?: unknown }).captures;
  return typeof captures === 'number' ? captures : 0;
}

/** The pooled HUD state plus the key captions (`HudState.keyLabels`). */
export type GameHudState = MutableHudState & { keyLabels: string[] };

/** What changes every frame and is not in the WorldView. */
export interface HudFrameInput {
  /** Heading of the camera about +Y, radians (0 = +Z, like `DragonState.yaw`). */
  cameraYaw: number;
  scoreEmber: number;
  scoreFrost: number;
  /** Who won the round or match on screen; null while playing. */
  winner: MatchWinner | null;
  /** Per-rider totals; the first `statsCount` rows are live. */
  stats: readonly Readonly<MatchPlayerStats>[];
  statsCount: number;
  /** Round trip per player in ms, indexed by PlayerId. */
  pings: readonly number[];
  /** The local rider flies (false: a spectator, or no dragon yet). */
  isRider: boolean;
  /** BUTTON_* bits held this frame. */
  buttons: number;
  /** Draw the steering reticle (false: autopilot, a menu is open). */
  showReticle: boolean;
  reticleX: number;
  reticleY: number;
  pointerLocked: boolean;
  /** Whose dragon the camera is on (`Stage.watchedId`). */
  watchedId: PlayerId;
  /**
   * This player may skip the intro that is playing: the host's `HostHandle.canSkipIntro`,
   * always false on a client (only the host can skip). Shown as the "skip" hint.
   */
  canSkipIntro: boolean;
}

export function createHudFrameInput(): HudFrameInput {
  return {
    cameraYaw: 0,
    scoreEmber: 0,
    scoreFrost: 0,
    winner: null,
    stats: [],
    statsCount: 0,
    pings: [],
    isRider: false,
    buttons: 0,
    showReticle: false,
    reticleX: 0,
    reticleY: 0,
    pointerLocked: false,
    watchedId: NO_PLAYER,
    canSkipIntro: false,
  };
}

export interface HudBuilder {
  readonly hud: GameHudState;
  /** A match is on screen: clears the feed and sets what is fixed for the match. */
  begin(mode: ModeId, scoreLimit: number, localPlayerId: PlayerId): void;
  /** Call every frame with the session's lobby; the name table is rebuilt when it changes. */
  setLobby(lobby: LobbyState | null): void;
  /** Subscribes the killfeed, hit markers and damage arcs. Returns the unsubscribe. */
  connect(source: GameEventSource): Unsubscribe;
  /** One rendered frame, after the WorldView is built. Allocation-free. */
  frame(dtS: number, input: Readonly<HudFrameInput>): void;
  /** Captions of the four ability slots (rebinding). */
  setKeyLabels(labels: readonly string[]): void;
  nameOf(playerId: PlayerId): string;
  /** The table behind the results panel, from the HUD's current rows. Allocates: once per match. */
  buildResults(winner: MatchWinner): ResultsState;
}

/** `view` is the one reused WorldView of the page: the event handlers read it as it stands. */
export function createHudBuilder(view: WorldView): HudBuilder {
  const hud: GameHudState = Object.assign(createHudState(MAX_PLAYERS * 2), {
    keyLabels: [...DEFAULT_KEY_LABELS],
  });

  // By player id, rebuilt when the lobby object is replaced.
  const names: string[] = new Array<string>(ID_SLOTS).fill(UNKNOWN_NAME);
  const teams = new Int8Array(ID_SLOTS).fill(-1);
  const classes: DragonClassId[] = new Array<DragonClassId>(ID_SLOTS).fill(DEFAULT_DRAGON_CLASS);
  const riders: PlayerId[] = [];
  let riderCount = 0;
  let lobbySeen: LobbyState | null = null;
  let cameraYaw = 0;

  function teamOf(id: PlayerId): TeamId | null {
    const team = teams[id & (ID_SLOTS - 1)];
    return team === TEAM_EMBER ? TEAM_EMBER : team === TEAM_FROST ? TEAM_FROST : null;
  }

  function nameOf(id: PlayerId): string {
    return id === NO_PLAYER ? '' : (names[id & (ID_SLOTS - 1)] ?? UNKNOWN_NAME);
  }

  function setLobby(lobby: LobbyState | null): void {
    if (lobby === lobbySeen) return;
    lobbySeen = lobby;
    if (lobby === null) return;
    // Seats freed mid-match keep their last name: a takedown line can still name them.
    riderCount = 0;
    hud.spectators.length = 0;
    for (const player of lobby.players) {
      const id = player.id & (ID_SLOTS - 1);
      names[id] = player.name;
      classes[id] = player.classId;
      if (player.side === 'spectator') {
        teams[id] = -1;
        hud.spectators.push(player.name);
      } else {
        teams[id] = player.side;
        riders[riderCount++] = player.id;
      }
    }
  }

  function onHit(event: HitEvent): void {
    const local = hud.localPlayerId;
    if (local === NO_PLAYER) return;
    if (event.attackerId === local && event.targetId !== local) hud.hitSeq++;
    if (event.targetId !== local) return;
    const me = findDragonView(view, local);
    if (me === undefined) return;
    // Where it came from: the attacker if it is in sight, else where the hit landed (terrain,
    // the storm wall, an attacker the snapshots leave out).
    const attacker =
      event.attackerId !== local ? findDragonView(view, event.attackerId) : undefined;
    const from = attacker !== undefined ? attacker.position : event.position;
    const dx = from.x - me.position.x;
    const dz = from.z - me.position.z;
    if (dx * dx + dz * dz < 1) return;
    pushDamageArc(hud, screenAngle(dx, dz, cameraYaw), event.damage / DAMAGE_ARC_FULL_HP);
  }

  function onTakedown(event: TakedownEvent): void {
    const victimTeam = teamOf(event.victimId) ?? TEAM_EMBER;
    const killer = event.killerId;
    pushKillfeed(
      hud,
      killer,
      nameOf(killer),
      killer === NO_PLAYER ? null : teamOf(killer),
      killer === NO_PLAYER ? null : (classes[killer & (ID_SLOTS - 1)] ?? null),
      event.victimId,
      nameOf(event.victimId),
      victimTeam,
      event.source,
    );
    if (killer === hud.localPlayerId && killer !== NO_PLAYER && event.victimId !== killer) {
      hud.takedownSeq++;
    }
  }

  /** Ember Relay: a line in the feed and the announcement for what happened to a shard. */
  function onObjective(event: ObjectiveEvent): void {
    if (event.kind === 'zoneTaken') return;
    // `event.team` is who it is good for: taking and capturing is done to the OTHER team's shard.
    const byEnemy = event.kind === 'pickedUp' || event.kind === 'captured';
    const shardTeam = !byEnemy ? event.team : event.team === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    const actor = event.dragonId;
    pushShardEvent(
      hud,
      event.kind,
      shardTeam,
      actor,
      nameOf(actor),
      actor === NO_PLAYER ? null : teamOf(actor),
    );
  }

  /** Both shards and the carry call-out, from the frame's WorldView. */
  function writeRelay(local: Readonly<DragonView> | undefined): void {
    const source = view.relay;
    if (!source.active) {
      hud.relay = null;
      return;
    }
    const relay = hud.relayPool;
    let carrying = false;
    for (let team = 0; team < relay.shards.length; team++) {
      const shard = source.shards[team];
      const out = relay.shards[team];
      if (shard === undefined || out === undefined) continue;
      const carried = shard.status === SHARD_CARRIED;
      out.status = shard.status;
      out.carrierName = carried ? nameOf(shard.carrierId) : '';
      out.returnInS = shard.returnInS;
      if (carried && local !== undefined && shard.carrierId === local.id) carrying = true;
    }
    relay.carrying = carrying;
    const brazier = local !== undefined ? source.braziers[local.team] : undefined;
    if (local !== undefined && brazier !== undefined) {
      const dx = brazier.x - local.position.x;
      const dy = brazier.y - local.position.y;
      const dz = brazier.z - local.position.z;
      relay.brazierDistanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    } else {
      relay.brazierDistanceM = 0;
    }
    hud.relay = relay;
  }

  function statsOf(
    stats: readonly Readonly<MatchPlayerStats>[],
    count: number,
    id: PlayerId,
  ): Readonly<MatchPlayerStats> | undefined {
    for (let i = 0; i < count; i++) {
      const row = stats[i];
      if (row !== undefined && row.playerId === id) return row;
    }
    return undefined;
  }

  function writeScoreboard(input: Readonly<HudFrameInput>): void {
    const rows = hud.scoreboard;
    let count = 0;
    for (let i = 0; i < riderCount && count < rows.length; i++) {
      const id = riders[i];
      const row = rows[count];
      if (id === undefined || row === undefined) continue;
      const team = teamOf(id);
      if (team === null) continue;
      const totals = statsOf(input.stats, input.statsCount, id);
      const dragon = findDragonView(view, id);
      row.playerId = id;
      row.name = nameOf(id);
      row.team = team;
      row.classId = dragon !== undefined ? dragon.classId : (classes[id] ?? DEFAULT_DRAGON_CLASS);
      row.takedowns = totals !== undefined ? totals.takedowns : 0;
      row.deaths = totals !== undefined ? totals.deaths : 0;
      row.assists = totals !== undefined ? totals.assists : 0;
      row.damage = totals !== undefined ? totals.damage : 0;
      row.captures = totals !== undefined ? capturesOf(totals) : 0;
      row.pingMs = input.pings[id] ?? -1;
      // A dragon the snapshots leave out (an enemy under its veil) is still alive.
      row.alive = dragon === undefined || (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
      count++;
    }
    hud.scoreboardCount = count;
  }

  /** Fills compass marker `index` to point from `me` at `target`. Returns the next free index. */
  function writeMarker(
    index: number,
    kind: HudCompassKind,
    team: TeamId,
    me: Readonly<DragonView>,
    target: Vec3,
  ): number {
    const marker = hud.compass[index];
    if (marker === undefined) return index;
    const dx = target.x - me.position.x;
    const dy = target.y - me.position.y;
    const dz = target.z - me.position.z;
    marker.kind = kind;
    marker.team = team;
    marker.angle = screenAngle(dx, dz, cameraYaw);
    marker.distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
    marker.alive = true;
    return index + 1;
  }

  /**
   * Ember Relay's markers, before the team mates so they are never the ones left out: the enemy
   * shard wherever it is (unless it is in the local rider's own claws), the own shard once it
   * is off its stand (home it sits by the brazier), and the own brazier.
   */
  function writeRelayMarkers(me: Readonly<DragonView>, localTeam: TeamId): number {
    const relay = view.relay;
    if (!relay.active) return 0;
    let count = 0;
    const enemyTeam = localTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    const theirs = relay.shards[enemyTeam];
    if (theirs !== undefined && !(theirs.status === SHARD_CARRIED && theirs.carrierId === me.id)) {
      count = writeMarker(count, 'shard', enemyTeam, me, theirs.position);
    }
    const ours = relay.shards[localTeam];
    if (ours !== undefined && ours.status !== SHARD_HOME) {
      count = writeMarker(count, 'shard', localTeam, me, ours.position);
    }
    const brazier = relay.braziers[localTeam];
    if (brazier !== undefined) count = writeMarker(count, 'brazier', localTeam, me, brazier);
    return count;
  }

  function writeCompass(localTeam: TeamId | null, localId: PlayerId): void {
    let count = 0;
    const me = findDragonView(view, localId);
    if (me !== undefined && localTeam !== null) {
      count = writeRelayMarkers(me, localTeam);
      for (let i = 0; i < view.dragonCount && count < HUD_COMPASS_MARKERS; i++) {
        const other = view.dragons[i];
        if (other === undefined || other.id === localId || other.team !== localTeam) continue;
        const marker = hud.compass[count];
        if (marker === undefined) break;
        const dx = other.position.x - me.position.x;
        const dy = other.position.y - me.position.y;
        const dz = other.position.z - me.position.z;
        marker.kind = 'ally';
        marker.team = other.team;
        marker.angle = screenAngle(dx, dz, cameraYaw);
        marker.distanceM = Math.sqrt(dx * dx + dy * dy + dz * dz);
        marker.alive = (other.flags & DRAGON_FLAG_ALIVE) !== 0;
        count++;
      }
    }
    hud.compassCount = count;
  }

  return {
    hud,

    begin(mode: ModeId, scoreLimit: number, localPlayerId: PlayerId): void {
      resetHudState(hud);
      hud.mode = mode;
      hud.scoreLimit = scoreLimit;
      hud.localPlayerId = localPlayerId;
      hud.winner = null;
      hud.spectatingName = '';
      // `resetHudState` empties the list; the next `setLobby` fills it again.
      lobbySeen = null;
    },

    setLobby,

    connect(source: GameEventSource): Unsubscribe {
      const offHit = source.on('hit', onHit);
      const offTakedown = source.on('takedown', onTakedown);
      const offObjective = source.on('objective', onObjective);
      return (): void => {
        offHit();
        offTakedown();
        offObjective();
      };
    },

    frame(dtS: number, input: Readonly<HudFrameInput>): void {
      cameraYaw = input.cameraYaw;
      ageHudState(hud, dtS);
      writeHudClock(hud, view.clock, MATCH_TUNING.countdownS);
      hud.scores[0] = input.scoreEmber;
      hud.scores[1] = input.scoreFrost;
      hud.winner = input.winner;
      hud.canSkipIntro = input.canSkipIntro && view.clock.phase === 'intro';

      const localId = view.localDragonId;
      const local = input.isRider ? findDragonView(view, localId) : undefined;
      if (local !== undefined) {
        hud.local = writeHudLocal(hud.localPool, local, view.local, input.buttons);
        if (input.showReticle) {
          const reticle = hud.reticlePool;
          reticle.x = input.reticleX;
          reticle.y = input.reticleY;
          reticle.locked = input.pointerLocked;
          hud.reticle = reticle;
        } else {
          hud.reticle = null;
        }
      } else {
        hud.local = null;
        hud.reticle = null;
      }

      // Named only while the camera is on somebody else's dragon.
      const watched = input.watchedId;
      const watchingOther =
        watched !== NO_PLAYER &&
        (local === undefined || (local.flags & DRAGON_FLAG_ALIVE) === 0) &&
        watched !== localId;
      hud.spectatingName = watchingOther ? nameOf(watched) : '';

      writeScoreboard(input);
      writeCompass(local !== undefined ? local.team : null, localId);
      writeRelay(local);
    },

    setKeyLabels(labels: readonly string[]): void {
      for (let i = 0; i < ABILITY_SLOTS.length; i++) {
        hud.keyLabels[i] = labels[i] ?? DEFAULT_KEY_LABELS[i] ?? '';
      }
    },

    nameOf,

    buildResults(winner: MatchWinner): ResultsState {
      const scoreboard: ScoreboardRow[] = [];
      for (let i = 0; i < hud.scoreboardCount; i++) {
        const row = hud.scoreboard[i];
        if (row !== undefined) scoreboard.push({ ...row });
      }
      const best = (score: (row: ScoreboardRow) => number, team: TeamId | null): PlayerId => {
        let id: PlayerId = NO_PLAYER;
        let top = 0;
        for (const row of scoreboard) {
          if (team !== null && row.team !== team) continue;
          const value = score(row);
          if (value > top) {
            top = value;
            id = row.playerId;
          }
        }
        return id;
      };
      // Simple for now (the podium and its awards are T-5.5): the MVP is the winning team's
      // best all-round rider. A shard brought home outweighs two takedowns (0 outside Ember
      // Relay, so other modes rank as before).
      const mvpTeam = winner === 'draw' ? null : winner;
      const results: ResultsState = {
        winner,
        scores: [hud.scores[0], hud.scores[1]],
        mvpId: best(
          (row) =>
            (row.captures ?? 0) * MVP_CAPTURE_POINTS +
            row.takedowns * 100 +
            (row.assists ?? 0) * 40 +
            row.damage,
          mvpTeam,
        ),
        mostTakedownsId: best((row) => row.takedowns, null),
        mostDamageId: best((row) => row.damage, null),
        scoreboard,
        mode: hud.mode,
      };
      if (hud.mode !== 'emberRelay') return results;
      return { ...results, mostCapturesId: best((row) => row.captures ?? 0, null) };
    },
  };
}
