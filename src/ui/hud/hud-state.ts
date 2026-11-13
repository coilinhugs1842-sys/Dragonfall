/**
 * The writable side of HudState, for `src/game`'s UiState builder: one object made at match
 * start, rewritten in place every frame, handed to `ui.update` as `state.hud`. Everything here
 * is DOM-free and allocation-free after `createHudState`, and reads the world only through the
 * `src/shared` contracts (WorldView, events).
 *
 * Typical frame, on the page that draws the HUD:
 *   ageHudState(hud, frameDtS);
 *   writeHudLocal(hud.local, localDragonView, view.local, input.buttons);   // or hud.local = null
 *   writeHudClock(hud, view.clock) + scores / scoreboard rows from the lobby and sim scores
 * and from GameEvents subscriptions (never per frame):
 *   hit on the local dragon   -> pushDamageArc(hud, screenAngle(dx, dz, cameraYaw), strength)
 *   hit by the local dragon   -> hud.hitSeq++
 *   takedown                  -> pushKillfeed(hud, ...), and hud.takedownSeq++ when it is ours
 */

import { ABILITY_SLOTS, DEFAULT_DRAGON_CLASS } from '../../shared/classes';
import type { AbilitySlot, DragonClassId } from '../../shared/classes';
import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER, TEAM_EMBER } from '../../shared/constants';
import type { DamageSource, ObjectiveKind } from '../../shared/events';
import type { MatchPhase, MatchWinner, ModeId } from '../../shared/match';
import { CLASS_TUNING } from '../../shared/tuning';
import {
  HUD_COMPASS_MARKERS,
  HUD_DAMAGE_ARCS,
  HUD_DRAGON_TAGS,
  HUD_KILLFEED_ROWS,
} from '../../shared/ui';
import type { HudCompassKind } from '../../shared/ui';
import { DRAGON_FLAG_ALIVE, SHARD_HOME } from '../../shared/world-view';
import type { DragonView, LocalCombatView, MatchClockView } from '../../shared/world-view';
import {
  DAMAGE_ARC_LIFE_S,
  KILLFEED_LIFE_S,
  RELAY_NOTICE_LIFE_S,
  damageArcSlot,
  shardLine,
} from './hud-model';

export interface MutableKillfeedEntry {
  killerId: PlayerId;
  killerName: string;
  killerTeam: TeamId | null;
  victimId: PlayerId;
  victimName: string;
  victimTeam: TeamId;
  ageS: number;
  source: DamageSource;
  killerClassId: DragonClassId | null;
  /** Not null: an Ember Relay line (see `KillfeedEntry.objective`). */
  objective: ObjectiveKind | null;
}

export interface MutableHudShardState {
  status: number;
  carrierName: string;
  returnInS: number;
}

/** Structurally assignable to HudRelayState. */
export interface MutableHudRelayState {
  shards: [ember: MutableHudShardState, frost: MutableHudShardState];
  carrying: boolean;
  brazierDistanceM: number;
  noticeKind: ObjectiveKind | null;
  noticeTeam: TeamId;
  noticeAgeS: number;
}

export interface MutableScoreboardRow {
  playerId: PlayerId;
  name: string;
  team: TeamId;
  classId: DragonClassId;
  takedowns: number;
  deaths: number;
  damage: number;
  pingMs: number;
  alive: boolean;
  assists: number;
  captures: number;
}

export interface MutableHudLocalState {
  classId: DragonClassId;
  alive: boolean;
  health: number;
  stamina: number;
  speed: number;
  ultimateCharge: number;
  cooldowns: Record<AbilitySlot, number>;
  dodgeCooldown: number;
  respawnInS: number;
  killerId: PlayerId;
  healthMax: number;
  flags: number;
  cooldownS: number[];
  charges: number[];
  maxCharges: number[];
  ready: boolean[];
  active: boolean[];
  castSlot: number;
  castProgress: number;
  buttons: number;
  blindS: number;
}

export interface MutableHudReticleState {
  x: number;
  y: number;
  locked: boolean;
}

export interface MutableHudDamageArc {
  angle: number;
  strength: number;
  ageS: number;
}

export interface MutableHudCompassMarker {
  kind: HudCompassKind;
  team: TeamId | null;
  angle: number;
  distanceM: number;
  alive: boolean;
}

/** Structurally assignable to HudDragonTag. */
export interface MutableHudDragonTag {
  shown: boolean;
  team: TeamId;
  foe: boolean;
  near: boolean;
  name: string;
  x: number;
  y: number;
  opacity: number;
}

/** The match intro's title card; `opacity` is rewritten every intro frame (T-5.4). */
export interface MutableIntroCardState {
  mapName: string;
  modeName: string;
  opacity: number;
}

/** Structurally assignable to HudState. */
export interface MutableHudState {
  mode: ModeId;
  phase: MatchPhase;
  round: number;
  scores: [ember: number, frost: number];
  scoreLimit: number;
  timeRemainingS: number;
  countdown: number;
  /** Point this at `localPool` for a rider, null for a spectator. */
  local: MutableHudLocalState | null;
  /** The one local-state object to reuse. */
  readonly localPool: MutableHudLocalState;
  killfeed: MutableKillfeedEntry[];
  killfeedCount: number;
  scoreboard: MutableScoreboardRow[];
  scoreboardCount: number;
  canSkipIntro: boolean;
  localPlayerId: PlayerId;
  reticle: MutableHudReticleState | null;
  /** The one reticle object to reuse. */
  readonly reticlePool: MutableHudReticleState;
  hitSeq: number;
  takedownSeq: number;
  damageArcs: MutableHudDamageArc[];
  compass: MutableHudCompassMarker[];
  compassCount: number;
  winner: MatchWinner | null;
  spectatingName: string;
  spectators: string[];
  scoreboardOpen: boolean;
  /** Point this at `introCardPool` while the intro's title card is up, null otherwise. */
  introCard: MutableIntroCardState | null;
  /** The one title-card object to reuse. */
  readonly introCardPool: MutableIntroCardState;
  /** Point this at `relayPool` in an Ember Relay match, null otherwise. */
  relay: MutableHudRelayState | null;
  /** The one relay object to reuse. */
  readonly relayPool: MutableHudRelayState;
  /** Markers over the dragons: HUD_DRAGON_TAGS entries, `shown` false = unused. */
  dragonTags: MutableHudDragonTag[];
}

function createKillfeedEntry(): MutableKillfeedEntry {
  return {
    killerId: NO_PLAYER,
    killerName: '',
    killerTeam: null,
    victimId: NO_PLAYER,
    victimName: '',
    victimTeam: TEAM_EMBER,
    ageS: Infinity,
    source: 'primary',
    killerClassId: null,
    objective: null,
  };
}

function createHudRelayState(): MutableHudRelayState {
  return {
    shards: [
      { status: SHARD_HOME, carrierName: '', returnInS: 0 },
      { status: SHARD_HOME, carrierName: '', returnInS: 0 },
    ],
    carrying: false,
    brazierDistanceM: 0,
    noticeKind: null,
    noticeTeam: TEAM_EMBER,
    noticeAgeS: Infinity,
  };
}

function resetHudRelayState(relay: MutableHudRelayState): void {
  for (const shard of relay.shards) {
    shard.status = SHARD_HOME;
    shard.carrierName = '';
    shard.returnInS = 0;
  }
  relay.carrying = false;
  relay.brazierDistanceM = 0;
  relay.noticeKind = null;
  relay.noticeTeam = TEAM_EMBER;
  relay.noticeAgeS = Infinity;
}

function createScoreboardRow(): MutableScoreboardRow {
  return {
    playerId: NO_PLAYER,
    name: '',
    team: TEAM_EMBER,
    classId: DEFAULT_DRAGON_CLASS,
    takedowns: 0,
    deaths: 0,
    damage: 0,
    pingMs: -1,
    alive: true,
    assists: 0,
    captures: 0,
  };
}

function createHudLocalState(): MutableHudLocalState {
  return {
    classId: DEFAULT_DRAGON_CLASS,
    alive: true,
    health: 1,
    stamina: 1,
    speed: 0,
    ultimateCharge: 0,
    cooldowns: { primary: 0, secondary: 0, utility: 0, ultimate: 0 },
    dodgeCooldown: 0,
    respawnInS: 0,
    killerId: NO_PLAYER,
    healthMax: CLASS_TUNING[DEFAULT_DRAGON_CLASS].maxHp,
    flags: DRAGON_FLAG_ALIVE,
    cooldownS: [0, 0, 0, 0],
    charges: [1, 1, 1, 1],
    maxCharges: [1, 1, 1, 1],
    ready: [true, true, true, false],
    active: [false, false, false, false],
    castSlot: -1,
    castProgress: 0,
    buttons: 0,
    blindS: 0,
  };
}

/** `scoreboardRows`: MAX_PLAYERS is enough; rows beyond `scoreboardCount` are ignored. */
export function createHudState(scoreboardRows = 10): MutableHudState {
  const killfeed: MutableKillfeedEntry[] = [];
  for (let i = 0; i < HUD_KILLFEED_ROWS; i++) killfeed.push(createKillfeedEntry());
  const scoreboard: MutableScoreboardRow[] = [];
  for (let i = 0; i < scoreboardRows; i++) scoreboard.push(createScoreboardRow());
  const damageArcs: MutableHudDamageArc[] = [];
  for (let i = 0; i < HUD_DAMAGE_ARCS; i++) {
    damageArcs.push({ angle: 0, strength: 0, ageS: Infinity });
  }
  const compass: MutableHudCompassMarker[] = [];
  for (let i = 0; i < HUD_COMPASS_MARKERS; i++) {
    compass.push({ kind: 'ally', team: null, angle: 0, distanceM: 0, alive: true });
  }
  const dragonTags: MutableHudDragonTag[] = [];
  for (let i = 0; i < HUD_DRAGON_TAGS; i++) {
    dragonTags.push({
      shown: false,
      team: TEAM_EMBER,
      foe: false,
      near: false,
      name: '',
      x: 0,
      y: 0,
      opacity: 0,
    });
  }
  return {
    mode: 'skirmish',
    phase: 'playing',
    round: 1,
    scores: [0, 0],
    scoreLimit: 0,
    timeRemainingS: Infinity,
    countdown: 0,
    local: null,
    localPool: createHudLocalState(),
    killfeed,
    killfeedCount: 0,
    scoreboard,
    scoreboardCount: 0,
    canSkipIntro: false,
    localPlayerId: NO_PLAYER,
    reticle: null,
    reticlePool: { x: 0, y: 0, locked: false },
    hitSeq: 0,
    takedownSeq: 0,
    damageArcs,
    compass,
    compassCount: 0,
    winner: null,
    spectatingName: '',
    spectators: [],
    scoreboardOpen: false,
    introCard: null,
    introCardPool: { mapName: '', modeName: '', opacity: 0 },
    relay: null,
    relayPool: createHudRelayState(),
    dragonTags,
  };
}

/** Back to an empty HUD for a new match (keeps the pools). */
export function resetHudState(hud: MutableHudState): void {
  hud.phase = 'playing';
  hud.round = 1;
  hud.scores[0] = 0;
  hud.scores[1] = 0;
  hud.countdown = 0;
  hud.timeRemainingS = Infinity;
  hud.local = null;
  hud.killfeedCount = 0;
  for (const entry of hud.killfeed) entry.ageS = Infinity;
  hud.scoreboardCount = 0;
  hud.reticle = null;
  hud.hitSeq = 0;
  hud.takedownSeq = 0;
  for (const arc of hud.damageArcs) arc.ageS = Infinity;
  hud.compassCount = 0;
  hud.winner = null;
  hud.spectatingName = '';
  hud.spectators.length = 0;
  hud.scoreboardOpen = false;
  hud.introCard = null;
  hud.introCardPool.opacity = 0;
  hud.relay = null;
  resetHudRelayState(hud.relayPool);
  for (const tag of hud.dragonTags) tag.shown = false;
}

/**
 * Once per rendered frame: ages the damage arcs and killfeed entries by `dtS` and drops killfeed
 * entries that have expired from the count.
 */
export function ageHudState(hud: MutableHudState, dtS: number): void {
  if (!(dtS > 0)) return;
  for (let i = 0; i < hud.damageArcs.length; i++) {
    const arc = hud.damageArcs[i];
    if (arc !== undefined && arc.ageS < DAMAGE_ARC_LIFE_S) arc.ageS += dtS;
  }
  let live = 0;
  for (let i = 0; i < hud.killfeedCount; i++) {
    const entry = hud.killfeed[i];
    if (entry === undefined) break;
    entry.ageS += dtS;
    // Newest first, so the live entries are a prefix.
    if (entry.ageS < KILLFEED_LIFE_S) live = i + 1;
  }
  hud.killfeedCount = live;
  const relay = hud.relayPool;
  if (relay.noticeAgeS < RELAY_NOTICE_LIFE_S) relay.noticeAgeS += dtS;
}

/**
 * The local rider was hurt from `angle` (a screen angle: see `screenAngle` in hud-model.ts).
 * `strength` 0..1 is the hit's weight, e.g. damage / 40. Returns the pool index used.
 */
export function pushDamageArc(hud: MutableHudState, angle: number, strength: number): number {
  const index = damageArcSlot(hud.damageArcs, angle);
  const arc = hud.damageArcs[index];
  if (arc === undefined) return -1;
  const clamped = strength > 0 ? (strength < 1 ? strength : 1) : 0;
  // A refreshed arc keeps the harder of the two hits.
  arc.strength = arc.ageS < DAMAGE_ARC_LIFE_S && arc.strength > clamped ? arc.strength : clamped;
  arc.angle = angle;
  arc.ageS = 0;
  return index;
}

/**
 * Adds a takedown at the top of the killfeed (newest first); the oldest falls off the end.
 * Entries are shifted by rotating the pooled objects, so nothing is allocated. Returns the
 * entry to fill in.
 */
export function pushKillfeed(
  hud: MutableHudState,
  killerId: PlayerId,
  killerName: string,
  killerTeam: TeamId | null,
  killerClassId: DragonClassId | null,
  victimId: PlayerId,
  victimName: string,
  victimTeam: TeamId,
  source: DamageSource,
): MutableKillfeedEntry | null {
  const feed = hud.killfeed;
  const size = feed.length;
  const recycled = feed[size - 1];
  if (recycled === undefined) return null;
  for (let i = size - 1; i > 0; i--) {
    const above = feed[i - 1];
    if (above !== undefined) feed[i] = above;
  }
  feed[0] = recycled;
  recycled.killerId = killerId;
  recycled.killerName = killerName;
  recycled.killerTeam = killerTeam;
  recycled.killerClassId = killerClassId;
  recycled.victimId = victimId;
  recycled.victimName = victimName;
  recycled.victimTeam = victimTeam;
  recycled.source = source;
  recycled.objective = null;
  recycled.ageS = 0;
  if (hud.killfeedCount < size) hud.killfeedCount++;
  return recycled;
}

/**
 * Ember Relay: a shard was picked up, dropped, returned or captured. Adds the line to the feed
 * (the actor in the killer's place, the shard's owner in the victim's) and makes it the
 * announcement. `actorId` is NO_PLAYER when nobody did it (a shard that went home by itself).
 */
export function pushShardEvent(
  hud: MutableHudState,
  kind: ObjectiveKind,
  shardTeam: TeamId,
  actorId: PlayerId,
  actorName: string,
  actorTeam: TeamId | null,
): MutableKillfeedEntry | null {
  const entry = pushKillfeed(
    hud,
    actorId,
    actorName,
    actorTeam,
    null,
    NO_PLAYER,
    // The line itself in the victim's place (a constant from a table: nothing is built), so
    // whatever reads the feed as plain text gets the whole sentence.
    shardLine(kind, shardTeam),
    shardTeam,
    'primary',
  );
  if (entry !== null) entry.objective = kind;
  const relay = hud.relayPool;
  relay.noticeKind = kind;
  relay.noticeTeam = shardTeam;
  relay.noticeAgeS = 0;
  return entry;
}

/**
 * Fills the local rider's gauges from this frame's WorldView. `dragon` is the local DragonView
 * (`findDragonView(view, view.localDragonId)`), `combat` is `view.local`. `active` is not known
 * to the view contract yet: it is derived from the flags the caller passes in `activeMask`
 * (bit i = slot i's effect is running), 0 when unknown.
 */
export function writeHudLocal(
  out: MutableHudLocalState,
  dragon: Readonly<DragonView>,
  combat: Readonly<LocalCombatView>,
  buttons: number,
  activeMask = 0,
): MutableHudLocalState {
  const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
  out.classId = dragon.classId;
  out.alive = alive;
  out.health = alive ? dragon.health : 0;
  out.stamina = dragon.stamina;
  const v = dragon.velocity;
  out.speed = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  out.healthMax = CLASS_TUNING[dragon.classId].maxHp;
  out.flags = dragon.flags;
  out.buttons = buttons;
  if (!combat.valid) return out;
  out.ultimateCharge = combat.ultimateCharge;
  out.dodgeCooldown = combat.dodgeCooldown;
  out.respawnInS = combat.respawnInS;
  out.killerId = combat.killerId;
  out.castSlot = combat.castSlot;
  out.castProgress = combat.castProgress;
  out.blindS = combat.blindS;
  for (let i = 0; i < ABILITY_SLOTS.length; i++) {
    const slot = ABILITY_SLOTS[i];
    if (slot === undefined) continue;
    out.cooldowns[slot] = combat.cooldowns[i] ?? 0;
    out.cooldownS[i] = combat.cooldownS[i] ?? 0;
    out.charges[i] = combat.charges[i] ?? 0;
    out.maxCharges[i] = combat.maxCharges[i] ?? 1;
    out.ready[i] = combat.ready[i] ?? false;
    out.active[i] = combat.active[i] === true || (activeMask & (1 << i)) !== 0;
  }
  return out;
}

/** Phase, round, time and the whole-second 3-2-1 from the match clock. */
export function writeHudClock(
  hud: MutableHudState,
  clock: Readonly<MatchClockView>,
  countdownS: number,
): void {
  hud.phase = clock.phase;
  hud.round = clock.round;
  hud.timeRemainingS = clock.timeRemainingS;
  const left = countdownS - clock.phaseTimeS;
  hud.countdown = clock.phase === 'countdown' && left > 0 ? Math.ceil(left) : 0;
}
