/**
 * HUD view-model: the pure arithmetic between a HudState and what the HUD writes to the page.
 * No DOM, no allocation after module load (the string tables are built once), so `update` can
 * call any of it every frame. Unit-tested in node (tests/ui/hud-model.test.ts).
 *
 * The pattern throughout: turn a continuous value into a small integer step, compare the step
 * with the one last written, and only then look its string up in a table. Nothing is formatted
 * per frame.
 */

import type { PlayerId, TeamId } from '../../shared/constants';
import { NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { ObjectiveKind } from '../../shared/events';
import type { MatchPhase, MatchWinner, ModeId } from '../../shared/match';
import type { HudCompassKind, HudDamageArc, ScoreboardRow } from '../../shared/ui';

// --- Timings and thresholds (display only; gameplay numbers live in src/shared) ------------------

/** Numbers on the HUD are rewritten at most this often. */
export const TEXT_INTERVAL_MS = 100;
/** The scoreboard re-sorts at most this often while it is open. */
export const SCOREBOARD_INTERVAL_MS = 250;
/** Health fraction under which the red vignette starts. */
export const LOW_HEALTH_THRESHOLD = 0.35;
export const DAMAGE_ARC_LIFE_S = 1.1;
/** A new hit within this angle of a live arc refreshes that arc instead of taking another. */
export const DAMAGE_ARC_MERGE_RAD = Math.PI / 7;
export const KILLFEED_LIFE_S = 6;
export const KILLFEED_FADE_S = 1;
/** The blind / flashbang veil lifts over this many seconds at the end of the effect. */
export const BLIND_FADE_OUT_S = 0.35;
/** Flashbang / blind ramp-up so the screen does not slam to full white. */
export const BLIND_FADE_IN_S = 0.12;
/** @deprecated use BLIND_FADE_OUT_S */
export const BLIND_FADE_S = BLIND_FADE_OUT_S;
/** Half the angle the compass strip spans; markers further round sit on its edge. */
export const COMPASS_HALF_SPAN_RAD = (Math.PI * 100) / 180;
/** Duel pips drawn per side at most. */
export const MAX_ROUND_PIPS = 5;

// --- Steps and string tables ------------------------------------------------------------------------

/** Steps for bars (scaleX) and other 0..1 CSS variables: 0.5 % each. */
export const UNIT_STEPS = 200;
/** Steps for opacities. */
export const OPACITY_STEPS = 20;
/** Steps for cooldown sweeps and the ultimate ring (percent of a turn). */
export const SWEEP_STEPS = 100;

function buildTable(length: number, make: (index: number) => string): readonly string[] {
  const table: string[] = [];
  for (let i = 0; i < length; i++) table.push(make(i));
  return table;
}

/** `'0'`, `'0.005'` … `'1'` for `transform: scaleX(var(--v))`. */
export const UNIT_STRINGS = buildTable(UNIT_STEPS + 1, (i) => String(i / UNIT_STEPS));
/** `'0'`, `'0.05'` … `'1'`. */
export const OPACITY_STRINGS = buildTable(OPACITY_STEPS + 1, (i) => String(i / OPACITY_STEPS));
/** `'0%'` … `'100%'` for conic-gradient stops. */
export const PERCENT_STRINGS = buildTable(SWEEP_STEPS + 1, (i) => `${i}%`);
/** `'00'` … `'99'`. */
export const TWO_DIGITS = buildTable(100, (i) => (i < 10 ? `0${i}` : String(i)));
/** `'0'` … `'999'`: every whole number the HUD prints (HP, scores, seconds, ping). */
export const INT_STRINGS = buildTable(1000, (i) => String(i));
/** `'0deg'` … `'359deg'`. */
export const DEGREE_STRINGS = buildTable(360, (i) => `${i}deg`);

/** 0..steps for a 0..1 value. NaN and negatives give 0. */
export function quantize(value: number, steps: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return steps;
  return Math.round(value * steps);
}

/**
 * Like `quantize`, but a value above zero never shows as empty and one below 1 never as full:
 * a sliver of health stays visible and a cooldown is only "done" when it is.
 */
export function quantizeVisible(value: number, steps: number): number {
  if (!(value > 0)) return 0;
  if (value >= 1) return steps;
  const step = Math.round(value * steps);
  return step < 1 ? 1 : step > steps - 1 ? steps - 1 : step;
}

/**
 * A whole number as text. 0..999 come from the table; anything larger (damage totals) is
 * formatted, which is fine because callers only ask when the shown value changed.
 */
export function intString(value: number): string {
  if (!(value > 0)) return '0';
  const whole = Math.round(value);
  return INT_STRINGS[whole] ?? String(whole);
}

// --- Clock ------------------------------------------------------------------------------------------

/**
 * Whole seconds the clock shows for `timeRemainingS`: rounded up, so the last second reads 0:01
 * and 0:00 means over. -1 = no time limit (Infinity / NaN). Capped at 99:59.
 */
export function clockTotalSeconds(timeRemainingS: number): number {
  if (!Number.isFinite(timeRemainingS)) return -1;
  if (timeRemainingS <= 0) return 0;
  const whole = Math.ceil(timeRemainingS);
  return whole > 5999 ? 5999 : whole;
}

/** The two halves of mm:ss as table strings (no formatting per call). */
export function clockMinutesString(totalSeconds: number): string {
  return TWO_DIGITS[totalSeconds > 0 ? Math.floor(totalSeconds / 60) : 0] ?? '00';
}

export function clockSecondsString(totalSeconds: number): string {
  return TWO_DIGITS[totalSeconds > 0 ? totalSeconds % 60 : 0] ?? '00';
}

/** `mm:ss`, or `--:--` without a limit. Allocates a string: for tests and one-off labels. */
export function formatClock(timeRemainingS: number): string {
  const total = clockTotalSeconds(timeRemainingS);
  if (total < 0) return '--:--';
  return `${clockMinutesString(total)}:${clockSecondsString(total)}`;
}

/** Seconds printed on a countdown (respawn): rounded up, 0 when done, -1 when there is none. */
export function countdownSeconds(seconds: number): number {
  if (seconds === Infinity) return -1;
  if (!(seconds > 0)) return 0;
  const whole = Math.ceil(seconds);
  return whole > 99 ? 99 : whole;
}

// --- Ability slots ------------------------------------------------------------------------------------

export const SLOT_READY = 0;
export const SLOT_COOLING = 1;
export const SLOT_ACTIVE = 2;
export const SLOT_CHARGING = 3;
/** The ultimate before it is charged. */
export const SLOT_LOCKED = 4;
export type SlotStateId = 0 | 1 | 2 | 3 | 4;

/** `data-state` values, indexed by SlotStateId. */
export const SLOT_STATE_NAMES = ['ready', 'cooling', 'active', 'charging', 'locked'] as const;

/**
 * What one ability slot shows. Winding up beats active beats everything else; an ultimate that
 * is not charged is `locked` whatever its cooldown says; a slot with a charge in store is ready
 * even while the next charge refills.
 */
export function slotState(
  isUltimate: boolean,
  cooldown: number,
  ultimateCharge: number,
  charges: number,
  ready: boolean | undefined,
  active: boolean,
  charging: boolean,
): SlotStateId {
  if (charging) return SLOT_CHARGING;
  if (active) return SLOT_ACTIVE;
  if (isUltimate && ultimateCharge < 1) return SLOT_LOCKED;
  if (ready === true) return SLOT_READY;
  if (charges > 0) return SLOT_READY;
  if (cooldown > 0) return SLOT_COOLING;
  return ready === false ? SLOT_COOLING : SLOT_READY;
}

/** A cooldown shorter than this in full is a fire rate, not something to wait for. */
export const RAPID_COOLDOWN_S = 0.6;

/**
 * The cooldown fraction a slot draws. Rapid-fire abilities (Talon's bolts re-arm in a fraction
 * of a second) would make the slot strobe between ready and cooling several times a second, so
 * a cooldown whose full length (`cooldownS / cooldown`) is under RAPID_COOLDOWN_S draws as
 * ready. Without `cooldownS` the length is unknown and the fraction is drawn as it is.
 */
export function shownCooldown(cooldown: number, cooldownS: number | undefined): number {
  if (!(cooldown > 0)) return 0;
  if (cooldownS !== undefined && cooldownS > 0 && cooldownS / cooldown < RAPID_COOLDOWN_S) {
    return 0;
  }
  return cooldown < 1 ? cooldown : 1;
}

/** 0..SWEEP_STEPS of the cooldown still to run; never 0 while any is left. */
export function cooldownSweepStep(cooldown: number): number {
  return quantizeVisible(cooldown, SWEEP_STEPS);
}

/**
 * The number printed over a cooling slot: whole seconds, rounded up. 0 = print nothing, which
 * covers a finished cooldown and the sub-second ones of rapid primaries (a flickering "1" on
 * every shot would be noise).
 */
export function cooldownSecondsShown(cooldownS: number): number {
  if (!(cooldownS >= 1)) return 0;
  const whole = Math.ceil(cooldownS);
  return whole > 99 ? 99 : whole;
}

/** Whole percent of ultimate charge; 100 only when it is really full. */
export function ultimatePercent(charge: number): number {
  if (!(charge > 0)) return 0;
  if (charge >= 1) return 100;
  const percent = Math.floor(charge * 100);
  return percent > 99 ? 99 : percent;
}

/**
 * True on the frame a slot's button goes down while the slot cannot fire: the "not ready" flash.
 * `buttons` / `previousButtons` are InputFrame bitmasks and `bit` the slot's button.
 */
export function deniedPress(
  buttons: number,
  previousButtons: number,
  bit: number,
  state: SlotStateId,
): boolean {
  if ((buttons & bit) === 0 || (previousButtons & bit) !== 0) return false;
  return state === SLOT_COOLING || state === SLOT_LOCKED;
}

// --- Vitals -------------------------------------------------------------------------------------------

/** HP printed next to the bar: rounded up so 0 only shows when the dragon is down. */
export function healthPoints(health: number, healthMax: number): number {
  if (!(health > 0) || !(healthMax > 0)) return 0;
  const points = Math.ceil(health * healthMax - 1e-6);
  return points > 999 ? 999 : points < 1 ? 1 : points;
}

/** 0 at or above the threshold, rising to 1 at no health. Dead or NaN = 0. */
export function lowHealthLevel(health: number, alive: boolean): number {
  if (!alive || !(health >= 0) || health >= LOW_HEALTH_THRESHOLD) return 0;
  return 1 - health / LOW_HEALTH_THRESHOLD;
}

/**
 * Veil opacity 0..1 for blindness left. `fadeIn` is 0..1 progress since the latest application
 * (the HUD tracks when `blindS` jumps up). Fade-out uses the remaining time.
 */
export function blindLevel(blindS: number, fadeIn: number = 1): number {
  if (!(blindS > 0)) return 0;
  const out = blindS >= BLIND_FADE_OUT_S ? 1 : blindS / BLIND_FADE_OUT_S;
  const inn = fadeIn > 0 ? (fadeIn < 1 ? fadeIn : 1) : 0;
  return out * inn;
}

// --- Angles: damage arcs and the compass ---------------------------------------------------------

const TWO_PI = Math.PI * 2;

/** Into (-PI, PI]. NaN / Infinity give 0. */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return 0;
  let wrapped = angle % TWO_PI;
  if (wrapped > Math.PI) wrapped -= TWO_PI;
  else if (wrapped <= -Math.PI) wrapped += TWO_PI;
  return wrapped;
}

/**
 * Screen angle (clockwise from straight ahead, the unit of HudDamageArc.angle and
 * HudCompassMarker.angle) of a point `dx, dz` metres away on the ground plane, seen by a camera
 * looking along `cameraYaw`.
 *
 * Yaw follows the sim (`DragonState.yaw`): 0 looks along +Z and a growing yaw swings toward +X.
 * With Y up that is a turn to the LEFT (right-handed axes: looking along +Z, +X is on the
 * left), so a bearing larger than the camera's lies to the left and the screen angle is
 * `cameraYaw - bearing`.
 */
export function screenAngle(dx: number, dz: number, cameraYaw: number): number {
  if (dx === 0 && dz === 0) return 0;
  return wrapAngle(cameraYaw - Math.atan2(dx, dz));
}

/** Whole degrees 0..359 for a rotation written to CSS. */
export function angleDegrees(angle: number): number {
  const degrees = Math.round((wrapAngle(angle) * 180) / Math.PI);
  // `| 0` also turns -0 (from rounding a tiny negative angle) into 0.
  return (degrees < 0 ? degrees + 360 : degrees >= 360 ? degrees - 360 : degrees) | 0;
}

/** OPACITY_STEPS (fresh) down to 0 (gone). Holds full for the first third, then fades. */
export function damageArcOpacityStep(ageS: number, strength: number): number {
  if (!(ageS >= 0) || ageS >= DAMAGE_ARC_LIFE_S) return 0;
  const hold = DAMAGE_ARC_LIFE_S / 3;
  const fade = ageS <= hold ? 1 : 1 - (ageS - hold) / (DAMAGE_ARC_LIFE_S - hold);
  const weight = 0.55 + 0.45 * (strength > 0 ? (strength < 1 ? strength : 1) : 0);
  const step = Math.ceil(fade * weight * OPACITY_STEPS);
  return step < 1 ? 1 : step;
}

export function damageArcLive(arc: Readonly<HudDamageArc>): boolean {
  return arc.ageS >= 0 && arc.ageS < DAMAGE_ARC_LIFE_S;
}

/**
 * Which pool entry a new hit from `angle` goes into: the live arc pointing nearly the same way
 * (so sustained fire from one attacker keeps one arc lit), else a free entry, else the oldest.
 */
export function damageArcSlot(arcs: readonly Readonly<HudDamageArc>[], angle: number): number {
  let free = -1;
  let oldest = 0;
  let oldestAge = -1;
  let nearest = -1;
  let nearestGap = DAMAGE_ARC_MERGE_RAD;
  for (let i = 0; i < arcs.length; i++) {
    const arc = arcs[i];
    if (arc === undefined) continue;
    if (!damageArcLive(arc)) {
      if (free < 0) free = i;
      continue;
    }
    const gap = Math.abs(wrapAngle(arc.angle - angle));
    if (gap <= nearestGap) {
      nearestGap = gap;
      nearest = i;
    }
    if (arc.ageS > oldestAge) {
      oldestAge = arc.ageS;
      oldest = i;
    }
  }
  if (nearest >= 0) return nearest;
  return free >= 0 ? free : oldest;
}

/**
 * Where a marker sits on the strip: -1 (left end) to 1 (right end), linear in angle across
 * the span. Anything further round, including straight behind, sits on the end of its side.
 */
export function compassOffset(angle: number, halfSpan: number = COMPASS_HALF_SPAN_RAD): number {
  const wrapped = wrapAngle(angle);
  if (!(halfSpan > 0)) return 0;
  const offset = wrapped / halfSpan;
  return offset > 1 ? 1 : offset < -1 ? -1 : offset;
}

/** True when the marker is outside the span and pinned to an end (drawn as "behind you"). */
export function compassPinned(angle: number, halfSpan: number = COMPASS_HALF_SPAN_RAD): boolean {
  return Math.abs(wrapAngle(angle)) > halfSpan;
}

/** Steps across the strip (UNIT_STRINGS gives the CSS value). */
export const COMPASS_STEPS = UNIT_STEPS;

/** 0..COMPASS_STEPS along the strip for a screen angle. */
export function compassStep(angle: number): number {
  return Math.round((compassOffset(angle) * 0.5 + 0.5) * COMPASS_STEPS);
}

/** Where a marker's distance figure is printed: under it, a line lower, or not at all. */
export const COMPASS_LANE_FIRST = 0;
export const COMPASS_LANE_SECOND = 1;
export const COMPASS_LANE_NONE = 2;
/**
 * Two figures on one line need this many strip steps between them ("280 m" is about eleven
 * steps wide). A figure that was moved off the first line needs a little more room before it
 * comes back, so two markers drifting at the limit do not make their figures jump.
 */
export const COMPASS_LABEL_GAP = 12;
export const COMPASS_LABEL_GAP_BACK = 15;

/** Order in which markers get their figure: shards, the brazier, objectives, then riders. */
export function compassLabelRank(
  kind: HudCompassKind,
  pinned: boolean,
  distanceM: number,
): number {
  const kindRank = kind === 'shard' ? 0 : kind === 'brazier' ? 1 : kind === 'objective' ? 2 : 3;
  // What is behind you (pinned to an end of the strip) waits for what is in front; then nearer first.
  return (pinned ? 4 : 0) * 10000 + kindRank * 10000 + (distanceM > 0 ? Math.min(distanceM, 9999) : 0);
}

const lanePlaced = new Uint8Array(64);

/**
 * Keeps the distance figures under the compass markers apart. Two markers closer than a figure
 * is wide used to print their figures over each other ("280 m 300 m" as one smear). Now, in
 * the order of `ranks` (lowest first), each marker takes the first line if no figure already
 * stands there within reach; otherwise it SHARES (prints nothing) when that neighbour shows the
 * very same number, STAGGERS onto the second line when that is free, and prints nothing when
 * both lines are taken (a crowd: the shapes still show where everybody is).
 *
 * `lanes` is kept between calls (the last answer is the hysteresis) and receives the result
 * for markers 0..count-1; the rest are reset. No allocation.
 */
export function compassLabelLanes(
  lanes: Uint8Array,
  steps: ArrayLike<number>,
  ranks: ArrayLike<number>,
  figures: ArrayLike<number>,
  count: number,
): void {
  const total = count < lanePlaced.length ? count : lanePlaced.length;
  for (let i = 0; i < lanes.length; i++) {
    if (i >= total) lanes[i] = COMPASS_LANE_FIRST;
    if (i < lanePlaced.length) lanePlaced[i] = 0;
  }
  for (let round = 0; round < total; round++) {
    let best = -1;
    let bestRank = 0;
    for (let i = 0; i < total; i++) {
      if (lanePlaced[i] === 1) continue;
      const rank = ranks[i] ?? 0;
      if (best < 0 || rank < bestRank) {
        best = i;
        bestRank = rank;
      }
    }
    if (best < 0) return;
    const step = steps[best] ?? 0;
    const firstGap = lanes[best] === COMPASS_LANE_FIRST ? COMPASS_LABEL_GAP : COMPASS_LABEL_GAP_BACK;
    let firstFree = true;
    let secondFree = true;
    let shared = false;
    for (let i = 0; i < total; i++) {
      if (lanePlaced[i] !== 1) continue;
      const gap = Math.abs((steps[i] ?? 0) - step);
      if (lanes[i] === COMPASS_LANE_FIRST && gap < firstGap) {
        firstFree = false;
        if (figures[i] === figures[best]) shared = true;
      } else if (lanes[i] === COMPASS_LANE_SECOND && gap < COMPASS_LABEL_GAP) {
        secondFree = false;
      }
    }
    lanes[best] = firstFree
      ? COMPASS_LANE_FIRST
      : shared || !secondFree
        ? COMPASS_LANE_NONE
        : COMPASS_LANE_SECOND;
    lanePlaced[best] = 1;
  }
}

/** Metres printed under a marker: to 5 m up close, 10 m beyond 100 m, capped at 990. */
export function distanceShown(distanceM: number): number {
  if (!(distanceM > 0)) return 0;
  const rounded = distanceM < 100 ? Math.round(distanceM / 5) * 5 : Math.round(distanceM / 10) * 10;
  return rounded > 990 ? 990 : rounded;
}

// --- Killfeed -----------------------------------------------------------------------------------------

/** OPACITY_STEPS while fresh, fading over the last second, 0 once it has expired. */
export function killfeedOpacityStep(ageS: number): number {
  if (!(ageS >= 0) || ageS >= KILLFEED_LIFE_S) return 0;
  const left = KILLFEED_LIFE_S - ageS;
  if (left >= KILLFEED_FADE_S) return OPACITY_STEPS;
  const step = Math.ceil((left / KILLFEED_FADE_S) * OPACITY_STEPS);
  return step < 1 ? 1 : step;
}

// --- Scoreboard ---------------------------------------------------------------------------------------

function ranksBefore(a: Readonly<ScoreboardRow>, b: Readonly<ScoreboardRow>): boolean {
  // Ember Relay: the riders who brought shards home lead. 0 for everybody in other modes.
  const capturesA = a.captures ?? 0;
  const capturesB = b.captures ?? 0;
  if (capturesA !== capturesB) return capturesA > capturesB;
  if (a.takedowns !== b.takedowns) return a.takedowns > b.takedowns;
  if (a.deaths !== b.deaths) return a.deaths < b.deaths;
  const assistsA = a.assists ?? 0;
  const assistsB = b.assists ?? 0;
  if (assistsA !== assistsB) return assistsA > assistsB;
  if (a.damage !== b.damage) return a.damage > b.damage;
  return a.playerId < b.playerId;
}

/**
 * Writes into `out` the indices of `team`'s rows among the first `count`, best first: most
 * captures (Ember Relay), most takedowns, then fewest deaths, most assists, most damage, lowest
 * id (stable between frames).
 * Returns how many it wrote (at most `out.length`). Insertion sort in place: no allocation.
 */
export function sortTeamRows(
  rows: readonly Readonly<ScoreboardRow>[],
  count: number,
  team: TeamId,
  out: number[],
): number {
  const limit = count < rows.length ? count : rows.length;
  let written = 0;
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (row === undefined || row.team !== team) continue;
    let at = written < out.length ? written : out.length - 1;
    if (written >= out.length) {
      // Full: only a row that beats the current last one gets in.
      const lastRow = rows[out[at] ?? -1];
      if (lastRow === undefined || !ranksBefore(row, lastRow)) continue;
    } else {
      written++;
    }
    while (at > 0) {
      const above = rows[out[at - 1] ?? -1];
      if (above === undefined || !ranksBefore(row, above)) break;
      out[at] = out[at - 1] ?? 0;
      at--;
    }
    out[at] = i;
  }
  return written;
}

/** Index of the player's row among the first `count`, or -1. */
export function findRow(
  rows: readonly Readonly<ScoreboardRow>[],
  count: number,
  playerId: PlayerId,
): number {
  if (playerId === NO_PLAYER) return -1;
  const limit = count < rows.length ? count : rows.length;
  for (let i = 0; i < limit; i++) {
    if (rows[i]?.playerId === playerId) return i;
  }
  return -1;
}

/** Live entries of a pooled list: the explicit count when given, clamped to the array. */
export function liveCount(length: number, count: number | undefined): number {
  if (count === undefined) return length;
  return count > 0 ? (count < length ? Math.floor(count) : length) : 0;
}

/** Damage for the board: whole HP, capped at the table. */
export function damageShown(damage: number): number {
  return damage > 0 ? Math.round(damage) : 0;
}

// --- Score header and banners -----------------------------------------------------------------------

/** Pips per side in Duel: the round wins needed (`scoreLimit`), 0 in other modes. */
export function roundPipCount(mode: ModeId, scoreLimit: number): number {
  if (mode !== 'duel' || !(scoreLimit > 0)) return 0;
  const pips = Math.ceil(scoreLimit);
  return pips > MAX_ROUND_PIPS ? MAX_ROUND_PIPS : pips;
}

/** 0..UNIT_STEPS of the way to the score limit (Skirmish progress line). */
export function scoreProgressStep(score: number, scoreLimit: number): number {
  if (!(scoreLimit > 0)) return 0;
  return quantize(score / scoreLimit, UNIT_STEPS);
}

export const BANNER_NONE = 0;
export const BANNER_COUNTDOWN = 1;
export const BANNER_ROUND_WON = 2;
export const BANNER_ROUND_LOST = 3;
export const BANNER_ROUND_DRAW = 4;
export const BANNER_VICTORY = 5;
export const BANNER_DEFEAT = 6;
export const BANNER_DRAW = 7;
/** A spectator's view of a finished round or match: the winner is named, nobody "lost". */
export const BANNER_EMBER_WINS = 8;
export const BANNER_FROST_WINS = 9;
export type BannerId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

/**
 * Which centre banner a phase calls for. `localTeam` is null for spectators. A `roundEnd` or
 * `results` phase without a winner yet shows nothing rather than guessing.
 */
export function bannerFor(
  phase: MatchPhase,
  countdown: number,
  winner: MatchWinner | null | undefined,
  localTeam: TeamId | null,
): BannerId {
  if (phase === 'countdown') return countdown > 0 ? BANNER_COUNTDOWN : BANNER_NONE;
  if (phase !== 'roundEnd' && phase !== 'results') return BANNER_NONE;
  if (winner === null || winner === undefined) return BANNER_NONE;
  const final = phase === 'results';
  if (winner === 'draw') return final ? BANNER_DRAW : BANNER_ROUND_DRAW;
  if (localTeam === null) return winner === TEAM_EMBER ? BANNER_EMBER_WINS : BANNER_FROST_WINS;
  if (winner === localTeam) return final ? BANNER_VICTORY : BANNER_ROUND_WON;
  return final ? BANNER_DEFEAT : BANNER_ROUND_LOST;
}

/** Banner headline, indexed by BannerId (the countdown prints its digit instead). */
export const BANNER_TITLES: readonly string[] = [
  '',
  '',
  'Round won',
  'Round lost',
  'Round drawn',
  'Victory',
  'Defeat',
  'Draw',
  'Ember Order',
  'Frost Order',
];

// --- Ember Relay (T-6.3) ------------------------------------------------------------------------------

/** What the scoreboard's note counts toward: "First to 3 captures". */
export function scoreNoun(mode: ModeId): string {
  return mode === 'duel' ? 'rounds' : mode === 'emberRelay' ? 'captures' : 'takedowns';
}

/** An announcement ("Your shard is taken") stays this long, fading over the last part. */
export const RELAY_NOTICE_LIFE_S = 4.5;
export const RELAY_NOTICE_FADE_S = 0.8;

/** OPACITY_STEPS while fresh, fading at the end, 0 once it is over (or there is none). */
export function relayNoticeStep(kind: ObjectiveKind | null | undefined, ageS: number): number {
  if (kind === null || kind === undefined || kind === 'zoneTaken') return 0;
  if (!(ageS >= 0) || ageS >= RELAY_NOTICE_LIFE_S) return 0;
  const left = RELAY_NOTICE_LIFE_S - ageS;
  if (left >= RELAY_NOTICE_FADE_S) return OPACITY_STEPS;
  const step = Math.ceil((left / RELAY_NOTICE_FADE_S) * OPACITY_STEPS);
  return step < 1 ? 1 : step;
}

type ShardEventKind = Exclude<ObjectiveKind, 'zoneTaken'>;

/** The announcement when it is the local team's own shard. */
const NOTICE_OURS: Readonly<Record<ShardEventKind, string>> = {
  pickedUp: 'Your shard has been taken',
  dropped: 'Your shard was dropped: touch it to send it home',
  returned: 'Your shard is home',
  captured: 'The enemy captured your shard',
};

/** The announcement when it is the enemy's shard. */
const NOTICE_THEIRS: Readonly<Record<ShardEventKind, string>> = {
  pickedUp: 'Your side has the enemy shard',
  dropped: 'The enemy shard was dropped',
  returned: 'The enemy shard went home',
  captured: 'Shard captured',
};

/** What a spectator reads, and the wording of the feed lines: by the shard's owner. */
const SHARD_LINES: readonly Readonly<Record<ShardEventKind, string>>[] = [
  {
    pickedUp: 'Ember shard taken',
    dropped: 'Ember shard dropped',
    returned: 'Ember shard returned',
    captured: 'Ember shard captured',
  },
  {
    pickedUp: 'Frost shard taken',
    dropped: 'Frost shard dropped',
    returned: 'Frost shard returned',
    captured: 'Frost shard captured',
  },
];

/** The feed line for a shard event: "Frost shard taken". `shardTeam` owns the shard. */
export function shardLine(kind: ObjectiveKind, shardTeam: TeamId): string {
  if (kind === 'zoneTaken') return '';
  return SHARD_LINES[shardTeam === TEAM_FROST ? 1 : 0]?.[kind] ?? '';
}

/**
 * The announcement for a shard event, worded for whoever reads it: about "your" shard, about
 * the enemy's, or by name for a spectator (`localTeam` null).
 */
export function relayNoticeText(
  kind: ObjectiveKind,
  shardTeam: TeamId,
  localTeam: TeamId | null,
): string {
  if (kind === 'zoneTaken') return '';
  if (localTeam === null) return shardLine(kind, shardTeam);
  return (shardTeam === localTeam ? NOTICE_OURS : NOTICE_THEIRS)[kind];
}

/**
 * Whether the announcement is good news for the reader: taking and capturing the enemy's shard,
 * getting the own one back or seeing it dropped. Null for a spectator (no side).
 */
export function relayNoticeGood(
  kind: ObjectiveKind,
  shardTeam: TeamId,
  localTeam: TeamId | null,
): boolean | null {
  if (localTeam === null) return null;
  const ours = shardTeam === localTeam;
  return kind === 'pickedUp' || kind === 'captured' ? !ours : ours;
}

/** `data-status` and the word for a shard's state, indexed by SHARD_HOME / CARRIED / DROPPED. */
export const SHARD_STATUS_KEYS: readonly string[] = ['home', 'carried', 'dropped'];
export const SHARD_STATUS_WORDS: readonly string[] = ['Home', 'Taken', 'Dropped'];

/** 0..2 for a shard status, whatever arrives. */
export function shardStatusIndex(status: number): number {
  return status === 1 || status === 2 ? status : 0;
}

// --- Cinematic phases (T-5.4, T-5.5) ------------------------------------------------------------------

/**
 * False while a cinematic owns the screen: the intro flyby and the results podium. The combat
 * HUD (vitals, abilities, reticle, score, compass, killfeed) is hidden then; the title card,
 * the countdown and the hold-to-show scoreboard are not part of it.
 */
export function combatHudVisible(phase: MatchPhase): boolean {
  return phase !== 'intro' && phase !== 'results';
}

/**
 * 0..UNIT_STEPS for the intro title card's opacity; 0 = do not draw. The cinematic fades the
 * card through the state, so the step is fine (0.5 %) and nothing in CSS eases it.
 */
export function introCardStep(opacity: number | undefined): number {
  if (opacity === undefined) return 0;
  return quantizeVisible(opacity, UNIT_STEPS);
}

export function teamKey(team: TeamId | null): 'ember' | 'frost' | 'none' {
  return team === TEAM_EMBER ? 'ember' : team === TEAM_FROST ? 'frost' : 'none';
}
