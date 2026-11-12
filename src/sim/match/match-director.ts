/**
 * The match rules the host runs (T-3.4): the phase timeline, Skirmish and Duel, the score and
 * the per-rider stats. Pure sim-layer code (no clock, no DOM, no network), so it runs inside the
 * host worker and in node tests; the host session drives it and turns what it decides into
 * MATCH_PHASE messages, `matchPhase` events and the snapshot clock.
 *
 * DRIVING IT, per host tick:
 *
 *     director.beforeStep(tick, sim);       // timed transitions, forfeits
 *     if (director.finished) -> back to the lobby
 *     if (director.simRuns) {               // not during intro / countdown: dragons are held
 *       sim.step(tick, inputs);
 *       director.afterStep(tick, sim);      // stats, score, storm, who won
 *     }
 *
 * and, when they happen: `addRider` / `removeRider` / `setRiderConnected`, and `onEvent` for
 * every GameEvent of the sim.
 *
 * TIMELINE (T-5.1: the cinematic intro and the podium are views of these phases, nothing more):
 *
 *     intro (round 1 only, `introTicks` of `begin`; the host may cut it short with `skipIntro`)
 *       |
 *       v
 *     countdown (controls locked, sim paused) -> playing -> roundEnd (MODE_TUNING.roundEndS)
 *        ^                                                     |
 *        +---- next round: everyone back at the gates <--------+--> results (resultsS) -> lobby
 *
 * A phase's first tick is its `phaseStartTick`. `intro` holds the sim exactly like a countdown
 * (dragons at the gates, nothing moves, nobody can be hurt): it only exists so every browser can
 * play the same fly-in for the same ticks. `roundEnd` always follows `playing`, also on the
 * last round (it is the beat on the final takedown); `results` then names the match winner.
 * Only a forfeit that ends the match skips straight to `results`.
 *
 * CEASEFIRE. `sim.rules.ceasefire` is on in every phase but `playing`: no ability damage and no
 * hostile effect gets through the sim's damage gate. While the dragons are held that is a
 * second lock on a sim that is not stepped anyway; in `roundEnd` and `results` the sim still
 * runs, so dragons keep flying under the camera, and nobody is taken down on the podium.
 *
 * SKIRMISH. One round with respawns. Score = takedowns of an enemy while the round is live.
 * First team to the score limit wins; when the time limit runs out the higher score wins; level
 * at that point = sudden death (next takedown wins) for `skirmish.overtimeS`, then a draw.
 *
 * DUEL. Best of MATCH_TUNING.duelRounds, no respawns inside a round. A round ends when a team
 * has nobody left alive (both at once = a draw), or at `duel.roundTimeS` on the higher health
 * fraction (level = a draw). A drawn round gives no point and is replayed; after
 * `duel.maxRounds` rounds the match ends on the rounds won. Between rounds everyone respawns at
 * the gates with full health, effects are cleared and ultimate charge is kept. The storm wall
 * follows `storm-schedule.ts`.
 *
 * EMBER RELAY (T-6.3). One round with respawns, like Skirmish, but the score is captures: carry
 * the enemy's sky-shard into your own brazier (`relay.ts` has the rules). First team to the
 * score limit wins; at the time limit the team with more captures wins; level at that point =
 * sudden death (next capture wins) for `emberRelay.overtimeS`, then a draw. Takedowns do not
 * score. Each rider's captures are counted in its stats row.
 *
 * DISCONNECTS. A team with no riders left (seats freed) ends the match for the other team at
 * once. A team whose riders are all disconnected (seats held) for `forfeitGraceS` gives up: the
 * round in Duel, the match in Skirmish. A solo sandbox has none of this and never ends by itself.
 *
 * STATS. Per rider: takedowns, deaths, assists, damage (from the sim's score sheet) and healing
 * (health a rider's regen effects gave back). Counted only while a round is live, so nothing
 * after the deciding takedown changes the scoreboard.
 *
 * Deterministic and allocation-free after construction (`begin` aside: once per match).
 */

import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_FLAG_ALIVE,
  MATCH_TUNING,
  MAX_PLAYERS,
  MODE_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_DT_S,
} from '../../shared';
import type {
  GameEvent,
  MatchPhase,
  MatchPlayerStats,
  MatchTuning,
  MatchWinner,
  ModeTuning,
  PlayerId,
  TeamId,
} from '../../shared';
import type { Sim } from '../sim';
import { findDragonSlot, resetRelayState } from '../sim-state';
import type { SimState } from '../sim-state';
import { secondsToTicks } from '../ticks';
import { createModeConfig } from './mode-config';
import type { ModeConfig } from './mode-config';
import { RelayRules } from './relay';
import type { RelayArena } from './relay-sites';
import { createStormRadii, writeDuelStorm } from './storm-schedule';
import type { MatchArena, StormRadii } from './storm-schedule';

/**
 * A rider's stats row as the director keeps it: the shared row plus what only an objective mode
 * counts. Rows are handed out as `MatchPlayerStats` wherever the extra is not needed.
 */
export interface MatchRiderStats extends MatchPlayerStats {
  /** Ember Relay: shards this rider carried into its team's brazier. */
  captures: number;
}

/** `captures` of a stats row, 0 for a row that does not carry it (another build, a test). */
export function capturesOf(stats: Readonly<MatchPlayerStats>): number {
  const captures = (stats as Partial<MatchRiderStats>).captures;
  return typeof captures === 'number' ? captures : 0;
}

export interface MatchDirectorListener {
  /**
   * A phase began; `tick` is its first tick. `winner` is the round's winner on `roundEnd`, the
   * match's on `results`, otherwise null. Not called for the first phase (`begin`).
   */
  onPhase(phase: MatchPhase, tick: number, round: number, winner: MatchWinner | null): void;
  /** Everyone was put back at the gates for `round` (lag-compensation history is void). */
  onRoundReset?(round: number, tick: number): void;
}

export interface MatchDirectorOptions {
  /** Read live. Default: the shared tables the dev GUI edits. */
  readonly modeTuning?: ModeTuning;
  readonly matchTuning?: MatchTuning;
  readonly listener?: MatchDirectorListener;
}

/** Why the last round or the match ended, for the UI wording and the tests. */
export type MatchEndReason =
  | 'none'
  | 'scoreLimit'
  | 'timeLimit'
  | 'suddenDeath'
  | 'elimination'
  | 'roundsWon'
  | 'maxRounds'
  | 'forfeit';

interface Rider {
  playerId: PlayerId;
  team: TeamId;
  connected: boolean;
  stats: MatchRiderStats;
  // The sim's score sheet as last seen, so only what changed while a round was live is counted.
  seenTakedowns: number;
  seenDeaths: number;
  seenAssists: number;
  seenDamage: number;
  lastHealth: number;
  lastAlive: boolean;
  /** Who gave this rider its current regen effect (healing is credited to them). */
  regenSourceId: PlayerId;
}

function createRider(): Rider {
  return {
    playerId: NO_PLAYER,
    team: TEAM_EMBER,
    connected: false,
    stats: {
      playerId: NO_PLAYER,
      team: TEAM_EMBER,
      present: false,
      takedowns: 0,
      deaths: 0,
      assists: 0,
      damage: 0,
      healing: 0,
      captures: 0,
    },
    seenTakedowns: 0,
    seenDeaths: 0,
    seenAssists: 0,
    seenDamage: 0,
    lastHealth: 0,
    lastAlive: false,
    regenSourceId: NO_PLAYER,
  };
}

const ID_SLOTS = 256;
const NO_ARENA: MatchArena = { stormRadius: -1, gateRadius: 0 };

export class MatchDirector {
  /** `lobby` before `begin` and once the results are over (`finished`). */
  phase: MatchPhase = 'lobby';
  /** First tick of the current phase. */
  phaseStartTick = 0;
  /** 1-based. */
  round = 1;
  /** The round's winner during `roundEnd`, the match's during `results`, otherwise null. */
  winner: MatchWinner | null = null;
  /** Set once the match is decided (from the deciding `roundEnd` on). */
  matchWinner: MatchWinner | null = null;
  matchOver = false;
  /** The results are over: take everyone back to the lobby. */
  finished = false;
  endReason: MatchEndReason = 'none';
  /** Index = TeamId. Takedowns in Skirmish, rounds won in Duel, captures in Ember Relay. */
  readonly scores: number[] = [0, 0];
  /** Seconds left of the round (or of sudden death); Infinity with no limit. */
  timeRemainingS = Infinity;
  /** Sudden death (Skirmish, Ember Relay) is running. */
  overtime = false;
  /** The storm radius the mode set, or -1 while the map's own applies. */
  stormRadius = -1;
  /**
   * One row per rider that started the match, in the order they were added; the first
   * `statsCount` are live. A rider that left keeps its row (`present` false).
   */
  readonly stats: MatchRiderStats[] = [];
  statsCount = 0;

  private modeConfig: ModeConfig = createModeConfig(DEFAULT_HOST_SETTINGS);
  private readonly relay: RelayRules;
  private readonly tuning: ModeTuning;
  private readonly matchTuning: MatchTuning;
  private readonly listener: MatchDirectorListener | null;
  private readonly arena: MatchArena = { stormRadius: -1, gateRadius: 0 };
  private readonly storm: StormRadii = createStormRadii();

  private readonly riders: Rider[] = [];
  private readonly riderIndex = new Int8Array(ID_SLOTS).fill(-1);
  private countdownTicks = 0;
  private introTicks = 0;
  /** Last tick of a timed phase + 1; -1 = the phase has no timer. */
  private phaseEndTick = -1;
  /** Ticks of play in the current round. */
  private liveTicks = 0;
  private readonly seenTeamTakedowns: number[] = [0, 0];
  /** Ticks a team has had riders but none connected. */
  private readonly absentTicks: number[] = [0, 0];
  // Scratch for the per-tick team census.
  private readonly present: number[] = [0, 0];
  private readonly connected: number[] = [0, 0];
  private readonly alive: number[] = [0, 0];
  private readonly health: number[] = [0, 0];

  constructor(options: MatchDirectorOptions = {}) {
    this.tuning = options.modeTuning ?? MODE_TUNING;
    this.relay = new RelayRules(this.tuning);
    this.matchTuning = options.matchTuning ?? MATCH_TUNING;
    this.listener = options.listener ?? null;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const rider = createRider();
      this.riders.push(rider);
      this.stats.push(rider.stats);
    }
  }

  get config(): ModeConfig {
    return this.modeConfig;
  }

  /**
   * Should the sim step this tick? False while dragons are held (intro, countdown) and outside a
   * match.
   */
  get simRuns(): boolean {
    const phase = this.phase;
    return phase === 'playing' || phase === 'roundEnd' || phase === 'results';
  }

  /** Ticks of play in the current round so far. */
  get roundTicks(): number {
    return this.liveTicks;
  }

  /**
   * First tick of `playing` while the dragons are held (where the sim resumes): the end of the
   * countdown, or during `intro` the end of the countdown that follows it. Else -1.
   */
  get liveTick(): number {
    if (this.phase === 'countdown') return this.phaseEndTick;
    if (this.phase === 'intro') return this.phaseEndTick + this.countdownTicks;
    return -1;
  }

  /** Ticks of the intro this match began with (0 = it had none). */
  get introLength(): number {
    return this.introTicks;
  }

  // --- Setup ---------------------------------------------------------------------------------------

  /**
   * Starts a match on `tick`. With `introTicks` > 0 it opens with `intro` for that long, then
   * the first countdown; with 0 (the default: a solo sandbox, "no cinematics") the countdown
   * begins on `tick`. Play starts `countdownTicks` after the countdown began. Sets the sim's
   * rules (friendly fire, respawns, the storm). Add the riders after this. The same
   * `countdownTicks` are used before every later round; the intro is for round 1 only.
   * `relayArena` is what Ember Relay places its stands and braziers from (the gates, the map
   * bounds, the terrain); null = open sky. Other modes ignore it.
   */
  begin(
    sim: Sim,
    config: ModeConfig,
    arena: Readonly<MatchArena> | null,
    tick: number,
    countdownTicks: number,
    introTicks = 0,
    relayArena: Readonly<RelayArena> | null = null,
  ): void {
    this.modeConfig = config;
    this.arena.stormRadius = (arena ?? NO_ARENA).stormRadius;
    this.arena.gateRadius = (arena ?? NO_ARENA).gateRadius;
    this.countdownTicks = countdownTicks > 0 ? Math.floor(countdownTicks) : 0;
    this.introTicks = introTicks > 0 ? Math.floor(introTicks) : 0;

    if (this.introTicks > 0) {
      this.phase = 'intro';
      this.phaseEndTick = tick + this.introTicks;
    } else {
      this.phase = 'countdown';
      this.phaseEndTick = tick + this.countdownTicks;
    }
    this.phaseStartTick = tick;
    this.round = 1;
    this.winner = null;
    this.matchWinner = null;
    this.matchOver = false;
    this.finished = false;
    this.endReason = 'none';
    this.scores[0] = 0;
    this.scores[1] = 0;
    this.overtime = false;
    this.liveTicks = 0;
    this.seenTeamTakedowns[0] = 0;
    this.seenTeamTakedowns[1] = 0;
    this.absentTicks[0] = 0;
    this.absentTicks[1] = 0;
    this.riderIndex.fill(-1);
    this.statsCount = 0;
    for (let i = 0; i < this.riders.length; i++) {
      const rider = this.riders[i];
      if (rider !== undefined) this.clearRider(rider);
    }

    sim.rules.friendlyFire = config.friendlyFire;
    // Until the first tick of `playing`.
    sim.rules.ceasefire = true;
    sim.respawnPolicy.enabled = config.respawns;
    this.stormRadius = -1;
    this.applyStorm(sim, true);
    this.writeTimeRemaining();
    // The shards are on their stands from the first frame of the intro; any other mode has none.
    if (config.mode === 'emberRelay') this.relay.begin(sim, relayArena);
    else resetRelayState(sim.relay);
  }

  /** A rider of the match. False when the table is full or the id is already in it. */
  addRider(playerId: PlayerId, team: TeamId, connected = true): boolean {
    if (!(playerId >= 0 && playerId < ID_SLOTS) || playerId === NO_PLAYER) return false;
    if ((this.riderIndex[playerId] ?? -1) >= 0) return false;
    const index = this.statsCount;
    const rider = this.riders[index];
    if (rider === undefined) return false;
    this.clearRider(rider);
    rider.playerId = playerId;
    rider.team = team;
    rider.connected = connected;
    rider.stats.playerId = playerId;
    rider.stats.team = team;
    rider.stats.present = true;
    this.riderIndex[playerId] = index;
    this.statsCount = index + 1;
    return true;
  }

  /** The rider left for good (seat freed, kicked). Its stats row stays for the results. */
  removeRider(playerId: PlayerId): boolean {
    const rider = this.riderOf(playerId);
    if (rider === null || !rider.stats.present) return false;
    rider.stats.present = false;
    rider.connected = false;
    return true;
  }

  /** The rider's link dropped (seat held) or came back. */
  setRiderConnected(playerId: PlayerId, connected: boolean): void {
    const rider = this.riderOf(playerId);
    if (rider !== null && rider.stats.present) rider.connected = connected;
  }

  /** The rider's stats row, or null. */
  statsOf(playerId: PlayerId): MatchRiderStats | null {
    const rider = this.riderOf(playerId);
    return rider === null ? null : rider.stats;
  }

  /** Every GameEvent of the sim passes through here (the director keeps what it needs). */
  onEvent(event: Readonly<GameEvent>): void {
    if (event.type !== 'statusApplied' || event.status !== 'regen') return;
    const rider = this.riderOf(event.targetId);
    if (rider !== null) rider.regenSourceId = event.sourceId;
  }

  /**
   * Cuts the intro short: the countdown starts on `tick` (the next tick the host will step).
   * False, and nothing happens, in any other phase. Who may ask is the host session's business.
   */
  skipIntro(tick: number): boolean {
    if (this.finished || this.phase !== 'intro') return false;
    this.beginCountdown(tick);
    return true;
  }

  // --- The tick ------------------------------------------------------------------------------------

  /** Timed transitions and forfeits. Call first on every host tick of a match. */
  beforeStep(tick: number, sim: Sim): void {
    if (this.finished || this.phase === 'lobby') return;
    if (!this.modeConfig.sandbox && this.phase !== 'results') this.checkForfeit(tick);

    // An intro that ends on a zero-length countdown goes on to `playing` in the same tick.
    if (this.phase === 'intro' && tick >= this.phaseEndTick) this.beginCountdown(tick);

    switch (this.phase) {
      case 'countdown':
        if (tick >= this.phaseEndTick) {
          this.liveTicks = 0;
          this.phaseEndTick = -1;
          this.enter('playing', tick, null);
        }
        break;
      case 'roundEnd':
        if (tick >= this.phaseEndTick) {
          if (this.matchOver) this.enterResults(tick);
          else this.startRound(tick, sim);
        }
        break;
      case 'results':
        if (tick >= this.phaseEndTick) {
          this.finished = true;
          this.phase = 'lobby';
          this.phaseStartTick = tick;
          this.phaseEndTick = -1;
        }
        break;
      default:
        break;
    }
    // Read by the step that follows: only a round in play can hurt anyone.
    sim.rules.ceasefire = this.phase !== 'playing';
  }

  /** Stats, score, the storm and the win conditions. Call after every `sim.step` of a match. */
  afterStep(tick: number, sim: Sim): void {
    if (this.finished || this.phase === 'lobby') return;
    const state = sim.current;
    const live = this.phase === 'playing';
    this.trackStats(state, live);
    if (!live) return;
    this.liveTicks++;
    const config = this.modeConfig;
    // Also in a solo sandbox: the lone rider can still carry a shard home, it just never ends.
    if (config.mode === 'emberRelay') this.stepRelay(tick, sim);
    if (config.sandbox) {
      this.timeRemainingS = Infinity;
      return;
    }
    if (config.mode === 'duel') {
      this.applyStorm(sim, false);
      this.judgeDuel(tick, state);
    } else {
      this.judgeScore(tick);
    }
  }

  // --- Ember Relay -----------------------------------------------------------------------------------

  /** The shard rules for this tick; a capture is a point for the team and for the rider. */
  private stepRelay(tick: number, sim: Sim): void {
    const relay = this.relay;
    relay.step(sim, tick);
    for (let team = 0; team < 2; team++) {
      const scorerId = relay.capturer[team] ?? NO_PLAYER;
      if (scorerId === NO_PLAYER) continue;
      this.scores[team] = (this.scores[team] ?? 0) + 1;
      const rider = this.riderOf(scorerId);
      if (rider !== null) rider.stats.captures++;
    }
  }

  // --- Skirmish and Ember Relay: first to the score limit, or ahead when time runs out ------------

  private judgeScore(tick: number): void {
    const config = this.modeConfig;
    const ember = this.scores[TEAM_EMBER] ?? 0;
    const frost = this.scores[TEAM_FROST] ?? 0;
    const leader: TeamId = ember > frost ? TEAM_EMBER : TEAM_FROST;
    const level = ember === frost;
    const limit = config.scoreLimit;
    // Both over the limit and level (two takedowns on one tick): play on until one leads.
    if ((ember >= limit || frost >= limit) && !level) {
      this.endRound(leader, this.overtime ? 'suddenDeath' : 'scoreLimit', tick);
      return;
    }
    if (!(config.timeLimitS > 0)) {
      this.timeRemainingS = Infinity;
      return;
    }
    const limitTicks = secondsToTicks(config.timeLimitS);
    if (this.liveTicks < limitTicks) {
      this.timeRemainingS = (limitTicks - this.liveTicks) * TICK_DT_S;
      return;
    }
    if (!level) {
      this.endRound(leader, this.overtime ? 'suddenDeath' : 'timeLimit', tick);
      return;
    }
    // Read here, not passed in: a float argument to a call the JIT did not inline is boxed.
    const overtimeS =
      config.mode === 'emberRelay' ? this.tuning.emberRelay.overtimeS : this.tuning.skirmish.overtimeS;
    const overtimeTicks = secondsToTicks(overtimeS);
    if (this.liveTicks >= limitTicks + overtimeTicks) {
      this.endRound('draw', 'timeLimit', tick);
      return;
    }
    this.overtime = true;
    this.timeRemainingS = (limitTicks + overtimeTicks - this.liveTicks) * TICK_DT_S;
  }

  // --- Duel ----------------------------------------------------------------------------------------

  private judgeDuel(tick: number, state: Readonly<SimState>): void {
    const present = this.present;
    const alive = this.alive;
    const health = this.health;
    present[0] = 0;
    present[1] = 0;
    alive[0] = 0;
    alive[1] = 0;
    health[0] = 0;
    health[1] = 0;
    for (let i = 0; i < this.statsCount; i++) {
      const rider = this.riders[i];
      if (rider === undefined || !rider.stats.present) continue;
      const team = rider.team;
      present[team] = (present[team] ?? 0) + 1;
      const slot = findDragonSlot(state, rider.playerId);
      const dragon = slot < 0 ? undefined : state.dragons[slot];
      if (dragon === undefined || (dragon.flags & DRAGON_FLAG_ALIVE) === 0) continue;
      alive[team] = (alive[team] ?? 0) + 1;
      if (dragon.maxHealth > 0) {
        health[team] = (health[team] ?? 0) + dragon.health / dragon.maxHealth;
      }
    }
    const emberOut = (present[0] ?? 0) > 0 && (alive[0] ?? 0) === 0;
    const frostOut = (present[1] ?? 0) > 0 && (alive[1] ?? 0) === 0;
    if (emberOut || frostOut) {
      const winner: MatchWinner =
        emberOut && frostOut ? 'draw' : emberOut ? TEAM_FROST : TEAM_EMBER;
      this.endRound(winner, 'elimination', tick);
      return;
    }

    const roundTimeS = this.tuning.duel.roundTimeS;
    if (!(roundTimeS > 0)) {
      this.timeRemainingS = Infinity;
      return;
    }
    const limitTicks = secondsToTicks(roundTimeS);
    if (this.liveTicks < limitTicks) {
      this.timeRemainingS = (limitTicks - this.liveTicks) * TICK_DT_S;
      return;
    }
    // Time: the healthier team takes the round (average health fraction, the dead count 0).
    const emberHealth = (present[0] ?? 0) > 0 ? (health[0] ?? 0) / (present[0] ?? 1) : 0;
    const frostHealth = (present[1] ?? 0) > 0 ? (health[1] ?? 0) / (present[1] ?? 1) : 0;
    const lead = emberHealth - frostHealth;
    const epsilon = this.tuning.duel.healthTieEpsilon;
    const winner: MatchWinner = lead > epsilon ? TEAM_EMBER : lead < -epsilon ? TEAM_FROST : 'draw';
    this.endRound(winner, 'timeLimit', tick);
  }

  /** Moves the wall to where the schedule puts it now. `force`: also when it did not move. */
  private applyStorm(sim: Sim, force: boolean): void {
    if (!this.modeConfig.stormShrinks) {
      if (force) {
        this.stormRadius = -1;
        sim.setStormRadius(-1);
      }
      return;
    }
    const storm = this.storm;
    if (!writeDuelStorm(storm, this.tuning.duel, this.arena, this.round, this.liveTicks)) {
      if (force) {
        this.stormRadius = -1;
        sim.setStormRadius(-1);
      }
      return;
    }
    if (!force && storm.radius === this.stormRadius) return;
    this.stormRadius = storm.radius;
    sim.setStormRadius(storm.radius);
  }

  // --- Rounds --------------------------------------------------------------------------------------

  /** The round is decided on `tick`; `roundEnd` starts on the next one. */
  private endRound(winner: MatchWinner, reason: MatchEndReason, tick: number): void {
    const config = this.modeConfig;
    this.endReason = reason;
    this.overtime = false;
    if (config.mode === 'duel') {
      if (winner !== 'draw') this.scores[winner] = (this.scores[winner] ?? 0) + 1;
      const ember = this.scores[TEAM_EMBER] ?? 0;
      const frost = this.scores[TEAM_FROST] ?? 0;
      if (winner !== 'draw' && (this.scores[winner] ?? 0) >= config.scoreLimit) {
        this.matchOver = true;
        this.matchWinner = winner;
        this.endReason = reason === 'forfeit' ? 'forfeit' : 'roundsWon';
      } else if (this.round >= config.maxRounds) {
        this.matchOver = true;
        this.matchWinner = ember === frost ? 'draw' : ember > frost ? TEAM_EMBER : TEAM_FROST;
        this.endReason = 'maxRounds';
      }
    } else {
      this.matchOver = true;
      this.matchWinner = winner;
    }
    this.phaseEndTick = tick + 1 + secondsToTicks(this.tuning.roundEndS);
    this.enter('roundEnd', tick + 1, winner);
  }

  private enterResults(tick: number): void {
    this.phaseEndTick = tick + secondsToTicks(this.tuning.resultsS);
    this.enter('results', tick, this.matchWinner);
  }

  /** Next round: effects cleared, everyone alive at the gates, the wall on its new radius. */
  private startRound(tick: number, sim: Sim): void {
    if (this.round < 255) this.round++;
    this.liveTicks = 0;
    this.overtime = false;
    this.endReason = 'none';
    sim.clearEffects();
    for (let i = 0; i < this.statsCount; i++) {
      const rider = this.riders[i];
      if (rider === undefined || !rider.stats.present) continue;
      sim.respawnDragon(rider.playerId);
      // Full health from the respawn is not healing.
      rider.lastAlive = false;
      rider.regenSourceId = NO_PLAYER;
    }
    this.applyStorm(sim, true);
    this.writeTimeRemaining();
    this.listener?.onRoundReset?.(this.round, tick);
    this.beginCountdown(tick);
  }

  private beginCountdown(tick: number): void {
    this.phaseEndTick = tick + this.countdownTicks;
    this.enter('countdown', tick, null);
  }

  private enter(phase: MatchPhase, tick: number, winner: MatchWinner | null): void {
    this.phase = phase;
    this.phaseStartTick = tick;
    this.winner = winner;
    this.listener?.onPhase(phase, tick, this.round, winner);
  }

  /** The clock as it stands before a round starts: the whole round. */
  private writeTimeRemaining(): void {
    const config = this.modeConfig;
    const limitS = config.mode === 'duel' ? this.tuning.duel.roundTimeS : config.timeLimitS;
    this.timeRemainingS = !config.sandbox && limitS > 0 ? limitS : Infinity;
  }

  // --- Forfeits ------------------------------------------------------------------------------------

  private checkForfeit(tick: number): void {
    const present = this.present;
    const connected = this.connected;
    present[0] = 0;
    present[1] = 0;
    connected[0] = 0;
    connected[1] = 0;
    for (let i = 0; i < this.statsCount; i++) {
      const rider = this.riders[i];
      if (rider === undefined || !rider.stats.present) continue;
      present[rider.team] = (present[rider.team] ?? 0) + 1;
      if (rider.connected) connected[rider.team] = (connected[rider.team] ?? 0) + 1;
    }
    const emberGone = (present[0] ?? 0) === 0;
    const frostGone = (present[1] ?? 0) === 0;
    if (emberGone || frostGone) {
      // A side has nobody left: the match is over now, whatever the phase.
      if (!this.matchOver) {
        this.matchOver = true;
        this.matchWinner = emberGone && frostGone ? 'draw' : emberGone ? TEAM_FROST : TEAM_EMBER;
        this.endReason = 'forfeit';
      }
      this.overtime = false;
      this.enterResults(tick);
      return;
    }

    const graceTicks = secondsToTicks(this.tuning.forfeitGraceS);
    let emberForfeits = false;
    let frostForfeits = false;
    if ((connected[0] ?? 0) === 0) {
      this.absentTicks[0] = (this.absentTicks[0] ?? 0) + 1;
      emberForfeits = (this.absentTicks[0] ?? 0) >= graceTicks;
    } else this.absentTicks[0] = 0;
    if ((connected[1] ?? 0) === 0) {
      this.absentTicks[1] = (this.absentTicks[1] ?? 0) + 1;
      frostForfeits = (this.absentTicks[1] ?? 0) >= graceTicks;
    } else this.absentTicks[1] = 0;
    // Only a round in play can be given up; the counters keep running through the other phases.
    if ((!emberForfeits && !frostForfeits) || this.phase !== 'playing') return;
    const winner: MatchWinner =
      emberForfeits && frostForfeits ? 'draw' : emberForfeits ? TEAM_FROST : TEAM_EMBER;
    if (emberForfeits) this.absentTicks[0] = 0;
    if (frostForfeits) this.absentTicks[1] = 0;
    // Decided "on the previous tick": `roundEnd` then starts on this one.
    this.endRound(winner, 'forfeit', tick - 1);
  }

  // --- Stats ---------------------------------------------------------------------------------------

  private trackStats(state: Readonly<SimState>, live: boolean): void {
    for (let i = 0; i < this.statsCount; i++) {
      const rider = this.riders[i];
      if (rider === undefined || !rider.stats.present) continue;
      const slot = findDragonSlot(state, rider.playerId);
      const dragon = slot < 0 ? undefined : state.dragons[slot];
      const score = slot < 0 ? undefined : state.scores[slot];
      if (dragon === undefined || score === undefined) {
        rider.lastAlive = false;
        continue;
      }
      const stats = rider.stats;
      // A sheet that went down was reset (the slot was freed and taken again).
      if (score.takedowns < rider.seenTakedowns) rider.seenTakedowns = 0;
      if (score.deaths < rider.seenDeaths) rider.seenDeaths = 0;
      if (score.assists < rider.seenAssists) rider.seenAssists = 0;
      if (score.damage < rider.seenDamage) rider.seenDamage = 0;
      if (live) {
        stats.takedowns += score.takedowns - rider.seenTakedowns;
        stats.deaths += score.deaths - rider.seenDeaths;
        stats.assists += score.assists - rider.seenAssists;
        stats.damage += score.damage - rider.seenDamage;
      }
      rider.seenTakedowns = score.takedowns;
      rider.seenDeaths = score.deaths;
      rider.seenAssists = score.assists;
      rider.seenDamage = score.damage;

      const alive = (dragon.flags & DRAGON_FLAG_ALIVE) !== 0;
      if (live && alive && rider.lastAlive && dragon.regenTicks > 0) {
        const gained = dragon.health - rider.lastHealth;
        if (gained > 0) {
          const healer = this.riderOf(rider.regenSourceId) ?? rider;
          healer.stats.healing += gained;
        }
      }
      rider.lastHealth = dragon.health;
      rider.lastAlive = alive;
    }

    const takedowns = state.teamTakedowns;
    const seen = this.seenTeamTakedowns;
    const counts = live && this.modeConfig.mode === 'skirmish';
    for (let team = 0; team < 2; team++) {
      const now = takedowns[team] ?? 0;
      let before = seen[team] ?? 0;
      if (now < before) before = 0;
      if (counts) this.scores[team] = (this.scores[team] ?? 0) + (now - before);
      seen[team] = now;
    }
  }

  // --- Helpers -------------------------------------------------------------------------------------

  private riderOf(playerId: PlayerId): Rider | null {
    const index = this.riderIndex[playerId] ?? -1;
    return index < 0 ? null : (this.riders[index] ?? null);
  }

  private clearRider(rider: Rider): void {
    rider.playerId = NO_PLAYER;
    rider.team = TEAM_EMBER;
    rider.connected = false;
    const stats = rider.stats;
    stats.playerId = NO_PLAYER;
    stats.team = TEAM_EMBER;
    stats.present = false;
    stats.takedowns = 0;
    stats.deaths = 0;
    stats.assists = 0;
    stats.damage = 0;
    stats.healing = 0;
    stats.captures = 0;
    rider.seenTakedowns = 0;
    rider.seenDeaths = 0;
    rider.seenAssists = 0;
    rider.seenDamage = 0;
    rider.lastHealth = 0;
    rider.lastAlive = false;
    rider.regenSourceId = NO_PLAYER;
  }
}

export function createMatchDirector(options: MatchDirectorOptions = {}): MatchDirector {
  return new MatchDirector(options);
}
