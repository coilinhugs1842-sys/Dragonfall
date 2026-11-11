/**
 * The match HUD (T-3.6, T-3.7): plain HTML/CSS in the UI overlay, so it is drawn at full
 * resolution whatever the 3D render scale is. It is a function of `UiState.hud`: it reads nothing
 * else and raises no intents.
 *
 * Cost contract. `update` runs every rendered frame and must be free when nothing changed:
 * - every node is created here, once (killfeed rows, damage arcs, compass markers, scoreboard
 *   rows and status chips are fixed pools);
 * - each written value is first reduced to a small integer step or a string reference and
 *   compared with the one last written; the DOM is only touched on a difference;
 * - numbers (HP, seconds, distances, the board) are refreshed at 10 Hz, bars and sweeps every
 *   frame through `transform` / CSS variables looked up in ready-made string tables;
 * - nothing is read back from the DOM (no layout reads), and remote text (names) only ever goes
 *   through `textContent`.
 */

import './hud.css';
import { ABILITY_SLOTS, DRAGON_CLASSES } from '../../shared/classes';
import type { DragonClassId } from '../../shared/classes';
import { NO_PLAYER, TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared/constants';
import type { TeamId } from '../../shared/constants';
import { BUTTON_PRIMARY } from '../../shared/input';
import { MODES } from '../../shared/match';
import type { ModeId } from '../../shared/match';
import { HUD_COMPASS_MARKERS, HUD_DAMAGE_ARCS, HUD_KILLFEED_ROWS } from '../../shared/ui';
import type { HudLocalState, HudState, ScoreboardRow } from '../../shared/ui';
import {
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_REGEN,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
} from '../../shared/world-view';
import { ABILITY_GLYPHS, STATUS_GLYPHS, takedownGlyph } from './glyphs';
import type { StatusKey } from './glyphs';
import {
  BANNER_COUNTDOWN,
  BANNER_DEFEAT,
  BANNER_DRAW,
  BANNER_EMBER_WINS,
  BANNER_FROST_WINS,
  BANNER_NONE,
  BANNER_TITLES,
  BANNER_VICTORY,
  DEGREE_STRINGS,
  MAX_ROUND_PIPS,
  OPACITY_STEPS,
  OPACITY_STRINGS,
  PERCENT_STRINGS,
  SCOREBOARD_INTERVAL_MS,
  SLOT_ACTIVE,
  SLOT_CHARGING,
  SLOT_STATE_NAMES,
  SWEEP_STEPS,
  TEXT_INTERVAL_MS,
  UNIT_STEPS,
  UNIT_STRINGS,
  angleDegrees,
  bannerFor,
  blindLevel,
  clockMinutesString,
  clockSecondsString,
  clockTotalSeconds,
  compassPinned,
  compassStep,
  cooldownSecondsShown,
  cooldownSweepStep,
  countdownSeconds,
  damageArcOpacityStep,
  damageShown,
  deniedPress,
  distanceShown,
  findRow,
  healthPoints,
  intString,
  killfeedOpacityStep,
  liveCount,
  lowHealthLevel,
  quantize,
  quantizeVisible,
  roundPipCount,
  scoreProgressStep,
  shownCooldown,
  slotState,
  sortTeamRows,
  teamKey,
  ultimatePercent,
} from './hud-model';
import type { BannerId } from './hud-model';

export interface HudOptions {
  /**
   * Radius in CSS pixels of the steering circle the reticle moves in. Must match what the input
   * layer assumes (the flight overlay's default is 110).
   */
  readonly reticleRadiusPx?: number;
  /** Hold Tab to show the scoreboard (default true). `HudState.scoreboardOpen` works either way. */
  readonly listenForTab?: boolean;
}

export interface Hud {
  readonly element: HTMLElement;
  /**
   * Draws `hud`, or hides everything for null (not in a match). `nowMs` is the frame time
   * (`performance.now()` scale); it only paces the 10 Hz text refresh.
   */
  update(hud: HudState | null, nowMs?: number): void;
  dispose(): void;
}

// --- Construction helpers and write-if-changed cells ---------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';
const TEAM_SHAPES: Readonly<Record<'ember' | 'frost' | 'none', string>> = {
  ember: 'M8 1.8 14.6 13.6H1.4Z',
  frost: 'M8 1 14.4 8 8 15 1.6 8Z',
  // Neutral objective: a ring.
  none: 'M8 2.5A5.5 5.5 0 1 0 8 13.5 5.5 5.5 0 1 0 8 2.5ZM8 5.5A2.5 2.5 0 1 1 8 10.5 2.5 2.5 0 1 1 8 5.5Z',
};
const DEFAULT_KEY_LABELS: readonly string[] = ['LMB', 'RMB', 'F', 'R'];
const DEFAULT_RETICLE_RADIUS_PX = 110;
const MAX_RETICLE_RADIUS_PX = 400;
/** Most charge pips a slot draws. */
const MAX_CHARGE_PIPS = 3;
const TEAM_ROWS = 5;
const MAX_SPECTATORS_LISTED = 12;

function div(className: string, text?: string): HTMLDivElement {
  const node = document.createElement('div');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function span(className: string, text?: string): HTMLSpanElement {
  const node = document.createElement('span');
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Text node content, written only when the string differs. */
class TextCell {
  private last: string;
  constructor(
    readonly node: HTMLElement,
    initial = '',
  ) {
    this.last = initial;
    if (initial !== '') node.textContent = initial;
  }
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.textContent = value;
  }
}

/** A whole number shown through the string table, written only when the number differs. */
class NumberCell {
  private last = Number.NaN;
  constructor(readonly node: HTMLElement) {}
  set(value: number): void {
    if (value === this.last) return;
    this.last = value;
    this.node.textContent = intString(value);
  }
  /** Shows fixed text (a dash) instead of a number. */
  setText(text: string, key: number): void {
    if (key === this.last) return;
    this.last = key;
    this.node.textContent = text;
  }
}

/** A CSS custom property (or plain property) fed from a string table by integer step. */
class StepStyle {
  private last = -1;
  constructor(
    private readonly node: HTMLElement | SVGElement,
    private readonly property: string,
    private readonly table: readonly string[],
  ) {}
  set(step: number): void {
    if (step === this.last) return;
    this.last = step;
    this.node.style.setProperty(this.property, this.table[step] ?? this.table[0] ?? '0');
  }
}

/** `hidden`, written only on a change. Starts hidden. */
class Visibility {
  private shown = false;
  constructor(private readonly node: HTMLElement | SVGElement) {
    node.setAttribute('hidden', '');
  }
  set(visible: boolean): void {
    if (visible === this.shown) return;
    this.shown = visible;
    if (visible) this.node.removeAttribute('hidden');
    else this.node.setAttribute('hidden', '');
  }
  get visible(): boolean {
    return this.shown;
  }
}

/** A `data-*` attribute, written only on a change. */
class DataAttr {
  private last = '';
  constructor(
    private readonly node: HTMLElement,
    private readonly name: string,
  ) {}
  set(value: string): void {
    if (value === this.last) return;
    this.last = value;
    this.node.dataset[this.name] = value;
  }
}

/** A small stroked (or filled) icon whose path can be swapped. */
class Glyph {
  readonly svg: SVGSVGElement;
  private readonly path: SVGPathElement;
  private last = '';
  constructor(className: string, d: string, filled = false) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 16 16');
    this.svg.setAttribute('aria-hidden', 'true');
    this.svg.setAttribute('focusable', 'false');
    this.svg.setAttribute('class', filled ? `${className} dfh-fill` : className);
    this.path = document.createElementNS(SVG_NS, 'path');
    this.svg.appendChild(this.path);
    this.set(d);
  }
  set(d: string): void {
    if (d === this.last) return;
    this.last = d;
    this.path.setAttribute('d', d);
  }
}

/** Restarts a CSS animation without a layout read: alternates between two twin keyframe names. */
class Pulse {
  private flip = false;
  constructor(
    private readonly node: HTMLElement,
    private readonly name: string,
  ) {}
  fire(kind: string): void {
    this.flip = !this.flip;
    this.node.dataset[this.name] = this.flip ? `${kind}-a` : `${kind}-b`;
  }
}

const STATUS_BITS: Readonly<Record<StatusKey, number>> = {
  protected: DRAGON_FLAG_SPAWN_PROTECTED,
  shielded: DRAGON_FLAG_SHIELDED,
  veiled: DRAGON_FLAG_VEILED,
  phasing: DRAGON_FLAG_PHASING,
  hasted: DRAGON_FLAG_HASTED,
  regen: DRAGON_FLAG_REGEN,
  slowed: DRAGON_FLAG_SLOWED,
  burning: DRAGON_FLAG_BURNING,
  blinded: DRAGON_FLAG_BLINDED,
  storm: DRAGON_FLAG_IN_STORM,
};

let STATUS_MASK = 0;
for (const status of STATUS_GLYPHS) STATUS_MASK |= STATUS_BITS[status.key];

// --- Parts ----------------------------------------------------------------------------------------------

interface SlotPart {
  readonly state: DataAttr;
  readonly held: DataAttr;
  readonly glyph: Glyph;
  readonly sweep: StepStyle;
  readonly sweepShown: Visibility;
  readonly cast: StepStyle;
  readonly seconds: NumberCell;
  readonly secondsShown: Visibility;
  readonly key: TextCell;
  readonly pips: readonly DataAttr[];
  readonly pipsShown: Visibility;
  readonly pipSlots: readonly Visibility[];
  readonly denied: Pulse;
  lastState: number;
}

interface FeedRow {
  readonly shown: Visibility;
  readonly opacity: StepStyle;
  readonly own: DataAttr;
  readonly killerShown: Visibility;
  readonly killerTeam: DataAttr;
  readonly killerIcon: Glyph;
  readonly killerName: TextCell;
  readonly glyph: Glyph;
  readonly victimTeam: DataAttr;
  readonly victimIcon: Glyph;
  readonly victimName: TextCell;
}

interface CompassPart {
  readonly shown: Visibility;
  readonly position: StepStyle;
  readonly team: DataAttr;
  readonly icon: Glyph;
  readonly pinned: DataAttr;
  readonly down: DataAttr;
  readonly distance: NumberCell;
}

interface BoardRow {
  readonly shown: Visibility;
  readonly own: DataAttr;
  readonly down: DataAttr;
  readonly name: TextCell;
  readonly classLabel: TextCell;
  readonly takedowns: NumberCell;
  readonly deaths: NumberCell;
  readonly assists: NumberCell;
  readonly damage: NumberCell;
  readonly ping: NumberCell;
}

interface BoardTeam {
  readonly score: NumberCell;
  readonly rows: readonly BoardRow[];
  readonly order: number[];
}

interface ScoreSide {
  readonly score: NumberCell;
  readonly progress: StepStyle;
  readonly pips: readonly DataAttr[];
  readonly pipSlots: readonly Visibility[];
}

function teamIconPath(team: TeamId | null): string {
  return TEAM_SHAPES[teamKey(team)];
}

export function createHud(root: HTMLElement, options: HudOptions = {}): Hud {
  const requested = Math.round(options.reticleRadiusPx ?? DEFAULT_RETICLE_RADIUS_PX);
  const radius = Math.min(
    MAX_RETICLE_RADIUS_PX,
    Math.max(8, Number.isFinite(requested) ? requested : DEFAULT_RETICLE_RADIUS_PX),
  );
  // PX[i] = `${i - radius}px` for every whole-pixel offset the reticle can have.
  const px: string[] = [];
  for (let i = -radius; i <= radius; i++) px.push(`${i}px`);

  const el = div('dfh-root');
  el.style.setProperty('--dfh-ring', `${radius}px`);
  const rootShown = new Visibility(el);
  const rootTeam = new DataAttr(el, 'team');
  const rootDown = new DataAttr(el, 'down');

  // --- Full-screen veils (each a single static gradient; only opacity changes) -------------------
  const lowHealth = div('dfh-lowhp');
  const lowHealthShown = new Visibility(lowHealth);
  const lowHealthOpacity = new StepStyle(lowHealth, 'opacity', OPACITY_STRINGS);
  const blind = div('dfh-blind');
  const blindShown = new Visibility(blind);
  const blindOpacity = new StepStyle(blind, 'opacity', OPACITY_STRINGS);
  el.append(lowHealth, blind);

  // --- Centre: reticle, hit marker, damage arcs ---------------------------------------------------
  const centre = div('dfh-centre');
  const arcRadius = radius + 42;
  const arcHalf = (18 * Math.PI) / 180;
  const arcX = (Math.sin(arcHalf) * arcRadius).toFixed(2);
  const arcY = (-Math.cos(arcHalf) * arcRadius).toFixed(2);
  const arcShown: Visibility[] = [];
  const arcOpacity: StepStyle[] = [];
  const arcAngle: StepStyle[] = [];
  for (let i = 0; i < HUD_DAMAGE_ARCS; i++) {
    const arc = div('dfh-arc');
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `${-arcRadius} ${-arcRadius - 8} ${arcRadius * 2} 60`);
    svg.setAttribute('width', String(arcRadius * 2));
    svg.setAttribute('height', '60');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.left = `${-arcRadius}px`;
    svg.style.top = `${-arcRadius - 8}px`;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', `M-${arcX} ${arcY}A${arcRadius} ${arcRadius} 0 0 1 ${arcX} ${arcY}`);
    svg.appendChild(path);
    arc.appendChild(svg);
    centre.appendChild(arc);
    arcShown.push(new Visibility(arc));
    arcOpacity.push(new StepStyle(arc, 'opacity', OPACITY_STRINGS));
    arcAngle.push(new StepStyle(arc, '--dfh-a', DEGREE_STRINGS));
  }
  const ring = div('dfh-ring');
  const ringShown = new Visibility(ring);
  const aim = div('dfh-aim');
  const aimShown = new Visibility(aim);
  const dot = div('dfh-dot');
  const hit = div('dfh-hit');
  hit.append(
    document.createElement('i'),
    document.createElement('i'),
    document.createElement('i'),
    document.createElement('i'),
  );
  const hitPulse = new Pulse(hit, 'pulse');
  aim.append(dot, hit);
  const prompt = div('dfh-prompt', 'Click to fly');
  const promptShown = new Visibility(prompt);
  centre.append(ring, aim, prompt);
  el.appendChild(centre);

  // --- Top: score, clock, compass strip ------------------------------------------------------------
  const top = div('dfh-top');
  const header = div('dfh-score');
  const scoreSides: ScoreSide[] = [];
  const buildSide = (team: TeamId): HTMLElement => {
    const info = TEAMS[team];
    const side = div(`dfh-side dfh-side-${info.key}`);
    side.dataset['team'] = info.key;
    const mark = new Glyph('dfh-shape', teamIconPath(team), true);
    const number = span('dfh-num dfh-side-num', '0');
    const pipBox = div('dfh-pips');
    const pips: DataAttr[] = [];
    const pipSlots: Visibility[] = [];
    for (let i = 0; i < MAX_ROUND_PIPS; i++) {
      const pip = document.createElement('i');
      pipBox.appendChild(pip);
      pips.push(new DataAttr(pip, 'on'));
      pipSlots.push(new Visibility(pip));
    }
    const line = div('dfh-side-line');
    const fill = document.createElement('i');
    line.appendChild(fill);
    side.append(mark.svg, number, pipBox, line);
    scoreSides.push({
      score: new NumberCell(number),
      progress: new StepStyle(fill, '--dfh-v', UNIT_STRINGS),
      pips,
      pipSlots,
    });
    return side;
  };
  const emberSide = buildSide(TEAM_EMBER);
  const clock = div('dfh-clock');
  const clockTime = div('dfh-num dfh-clock-time');
  const clockMin = span('', '--');
  const clockSec = span('', '--');
  clockTime.append(clockMin, span('dfh-clock-sep', ':'), clockSec);
  const clockMinutes = new TextCell(clockMin, '--');
  const clockSeconds = new TextCell(clockSec, '--');
  const clockNoteNode = div('dfh-clock-note');
  const clockNote = new TextCell(clockNoteNode);
  clock.append(clockTime, clockNoteNode);
  const frostSide = buildSide(TEAM_FROST);
  header.append(emberSide, clock, frostSide);
  const headerMode = new DataAttr(header, 'mode');

  const compass = div('dfh-compass');
  compass.appendChild(div('dfh-compass-notch'));
  const compassParts: CompassPart[] = [];
  for (let i = 0; i < HUD_COMPASS_MARKERS; i++) {
    const marker = div('dfh-mark');
    const inner = div('dfh-mark-in');
    const icon = new Glyph('dfh-shape', TEAM_SHAPES.none, true);
    const distance = span('dfh-num dfh-mark-dist');
    inner.append(icon.svg, distance);
    marker.appendChild(inner);
    compass.appendChild(marker);
    compassParts.push({
      shown: new Visibility(marker),
      position: new StepStyle(marker, '--dfh-p', UNIT_STRINGS),
      team: new DataAttr(marker, 'team'),
      icon,
      pinned: new DataAttr(marker, 'pinned'),
      down: new DataAttr(marker, 'down'),
      distance: new NumberCell(distance),
    });
  }
  top.append(header, compass);
  el.appendChild(top);

  // --- Killfeed ---------------------------------------------------------------------------------------
  const feed = div('dfh-feed');
  feed.setAttribute('aria-hidden', 'true');
  const feedRows: FeedRow[] = [];
  for (let i = 0; i < HUD_KILLFEED_ROWS; i++) {
    const row = div('dfh-feed-row');
    const killer = span('dfh-feed-who');
    const killerIcon = new Glyph('dfh-shape', TEAM_SHAPES.ember, true);
    const killerName = span('dfh-feed-name');
    killer.append(killerIcon.svg, killerName);
    const glyph = new Glyph('dfh-glyph dfh-feed-glyph', '');
    const victim = span('dfh-feed-who');
    const victimIcon = new Glyph('dfh-shape', TEAM_SHAPES.ember, true);
    const victimName = span('dfh-feed-name');
    victim.append(victimIcon.svg, victimName);
    row.append(killer, glyph.svg, victim);
    feed.appendChild(row);
    feedRows.push({
      shown: new Visibility(row),
      opacity: new StepStyle(row, 'opacity', OPACITY_STRINGS),
      own: new DataAttr(row, 'own'),
      killerShown: new Visibility(killer),
      killerTeam: new DataAttr(killer, 'team'),
      killerIcon,
      killerName: new TextCell(killerName),
      glyph,
      victimTeam: new DataAttr(victim, 'team'),
      victimIcon,
      victimName: new TextCell(victimName),
    });
  }
  el.appendChild(feed);

  // --- Vitals (bottom left) -----------------------------------------------------------------------
  const vitals = div('dfh-vitals');
  const vitalsShown = new Visibility(vitals);
  const statusBox = div('dfh-status');
  const statusShown: Visibility[] = [];
  for (const status of STATUS_GLYPHS) {
    const chip = div(status.harmful ? 'dfh-chip dfh-chip-harm' : 'dfh-chip');
    chip.append(new Glyph('dfh-glyph', status.d).svg, span('dfh-chip-label', status.label));
    statusBox.appendChild(chip);
    statusShown.push(new Visibility(chip));
  }
  const vitalsHead = div('dfh-vitals-head');
  const ownShape = new Glyph('dfh-shape', TEAM_SHAPES.none, true);
  const classNode = span('dfh-class');
  const classLabel = new TextCell(classNode);
  const hpBox = span('dfh-hp');
  const hpNode = span('dfh-num dfh-hp-now');
  const hpMaxNode = span('dfh-num dfh-hp-max');
  hpBox.append(hpNode, hpMaxNode);
  const hpNumber = new NumberCell(hpNode);
  const hpMax = new NumberCell(hpMaxNode);
  const hpBoxShown = new Visibility(hpBox);
  vitalsHead.append(ownShape.svg, classNode, hpBox);
  const healthBar = div('dfh-bar dfh-bar-hp');
  const healthGhost = document.createElement('i');
  healthGhost.className = 'dfh-bar-ghost';
  const healthFill = document.createElement('i');
  healthFill.className = 'dfh-bar-fill';
  healthBar.append(healthGhost, healthFill);
  const healthStep = new StepStyle(healthBar, '--dfh-v', UNIT_STRINGS);
  const healthLow = new DataAttr(healthBar, 'low');
  const staminaBar = div('dfh-bar dfh-bar-st');
  const staminaFill = document.createElement('i');
  staminaFill.className = 'dfh-bar-fill';
  staminaBar.appendChild(staminaFill);
  const staminaStep = new StepStyle(staminaBar, '--dfh-v', UNIT_STRINGS);
  const staminaSpent = new DataAttr(staminaBar, 'low');
  vitals.append(statusBox, vitalsHead, healthBar, staminaBar);
  el.appendChild(vitals);

  // --- Ability slots (bottom right) ---------------------------------------------------------------
  const abilities = div('dfh-abilities');
  const abilitiesShown = new Visibility(abilities);
  const slots: SlotPart[] = [];
  for (let i = 0; i < ABILITY_SLOTS.length; i++) {
    const isUltimate = i === ABILITY_SLOTS.length - 1;
    const slot = div(isUltimate ? 'dfh-slot dfh-ult' : 'dfh-slot');
    const face = div('dfh-slot-face');
    const glyph = new Glyph('dfh-glyph dfh-slot-glyph', '');
    const cast = div('dfh-slot-cast');
    const sweep = div('dfh-slot-sweep');
    const seconds = span('dfh-num dfh-slot-secs');
    const flash = div('dfh-slot-flash');
    face.append(cast, glyph.svg, sweep, seconds, flash);
    const key = span('dfh-slot-key', DEFAULT_KEY_LABELS[i] ?? '');
    const pipBox = div('dfh-slot-pips');
    const pips: DataAttr[] = [];
    const pipSlots: Visibility[] = [];
    for (let p = 0; p < MAX_CHARGE_PIPS; p++) {
      const pip = document.createElement('i');
      pipBox.appendChild(pip);
      pips.push(new DataAttr(pip, 'on'));
      pipSlots.push(new Visibility(pip));
    }
    slot.append(face, pipBox, key);
    abilities.appendChild(slot);
    slots.push({
      state: new DataAttr(slot, 'state'),
      held: new DataAttr(slot, 'held'),
      glyph,
      sweep: new StepStyle(isUltimate ? slot : sweep, '--dfh-cd', PERCENT_STRINGS),
      sweepShown: new Visibility(sweep),
      cast: new StepStyle(cast, '--dfh-v', UNIT_STRINGS),
      seconds: new NumberCell(seconds),
      secondsShown: new Visibility(seconds),
      key: new TextCell(key, DEFAULT_KEY_LABELS[i] ?? ''),
      pips,
      pipsShown: new Visibility(pipBox),
      pipSlots,
      denied: new Pulse(flash, 'pulse'),
      lastState: -1,
    });
  }
  el.appendChild(abilities);

  // --- Respawn panel, spectating label, banner ------------------------------------------------------
  const respawn = div('dfh-respawn');
  respawn.setAttribute('role', 'status');
  const respawnShown = new Visibility(respawn);
  const respawnOverNode = div('dfh-overline');
  const respawnOver = new TextCell(respawnOverNode);
  const killerLine = div('dfh-killer');
  const killerLineShown = new Visibility(killerLine);
  const killerTeam = new DataAttr(killerLine, 'team');
  const killerIcon = new Glyph('dfh-shape', TEAM_SHAPES.none, true);
  const killerNameNode = span('dfh-killer-name');
  const killerName = new TextCell(killerNameNode);
  const killerClassNode = span('dfh-killer-class');
  const killerClass = new TextCell(killerClassNode);
  killerLine.append(killerIcon.svg, killerNameNode, killerClassNode);
  const respawnCount = div('dfh-respawn-count');
  const respawnCountShown = new Visibility(respawnCount);
  const respawnNumNode = span('dfh-num dfh-respawn-num');
  const respawnNum = new NumberCell(respawnNumNode);
  respawnCount.append(span('dfh-respawn-label', 'Back at the gate in'), respawnNumNode);
  const respawnOut = div('dfh-respawn-label', 'Out until the round ends');
  const respawnOutShown = new Visibility(respawnOut);
  respawn.append(respawnOverNode, killerLine, respawnCount, respawnOut);
  el.appendChild(respawn);

  const spectate = div('dfh-spectate');
  const spectateShown = new Visibility(spectate);
  const spectateNameNode = div('dfh-spectate-name');
  const spectateName = new TextCell(spectateNameNode);
  spectate.append(div('dfh-overline', 'Spectating'), spectateNameNode);
  el.appendChild(spectate);

  const banner = div('dfh-banner');
  banner.setAttribute('role', 'status');
  const bannerShown = new Visibility(banner);
  const bannerKind = new DataAttr(banner, 'kind');
  const bannerOverNode = div('dfh-overline');
  const bannerOver = new TextCell(bannerOverNode);
  const bannerTitleNode = div('dfh-banner-title');
  const bannerTitle = new TextCell(bannerTitleNode);
  const bannerBeat = new Pulse(bannerTitleNode, 'pulse');
  banner.append(bannerOverNode, bannerTitleNode);
  el.appendChild(banner);

  // --- Scoreboard --------------------------------------------------------------------------------------
  const board = div('dfh-board');
  const boardShown = new Visibility(board);
  const boardHead = div('dfh-board-head');
  const boardTitleNode = div('dfh-board-title');
  const boardTitle = new TextCell(boardTitleNode);
  const boardNoteNode = div('dfh-board-note');
  const boardNote = new TextCell(boardNoteNode);
  boardHead.append(boardTitleNode, boardNoteNode);
  const boardTeams = div('dfh-board-teams');
  const boards: BoardTeam[] = [];
  for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
    const info = TEAMS[team];
    const block = div('dfh-team');
    block.dataset['team'] = info.key;
    const head = div('dfh-team-head');
    const scoreNode = span('dfh-num dfh-team-score', '0');
    head.append(
      new Glyph('dfh-shape', teamIconPath(team), true).svg,
      span('dfh-team-name', info.name),
      scoreNode,
    );
    const columns = div('dfh-row dfh-row-head');
    columns.append(
      span('dfh-cell-name', 'Rider'),
      span('dfh-cell-class', 'Dragon'),
      span('dfh-cell-n', 'Tkd'),
      span('dfh-cell-n', 'Dth'),
      span('dfh-cell-n', 'Ast'),
      span('dfh-cell-n dfh-cell-wide', 'Dmg'),
      span('dfh-cell-n', 'ms'),
    );
    block.append(head, columns);
    const rows: BoardRow[] = [];
    const order: number[] = [];
    for (let i = 0; i < TEAM_ROWS; i++) {
      const row = div('dfh-row');
      const name = span('dfh-cell-name');
      const classCell = span('dfh-cell-class');
      const takedowns = span('dfh-num dfh-cell-n dfh-cell-key');
      const deaths = span('dfh-num dfh-cell-n');
      const assists = span('dfh-num dfh-cell-n');
      const damage = span('dfh-num dfh-cell-n dfh-cell-wide');
      const ping = span('dfh-num dfh-cell-n dfh-cell-ping');
      row.append(name, classCell, takedowns, deaths, assists, damage, ping);
      block.appendChild(row);
      rows.push({
        shown: new Visibility(row),
        own: new DataAttr(row, 'own'),
        down: new DataAttr(row, 'down'),
        name: new TextCell(name),
        classLabel: new TextCell(classCell),
        takedowns: new NumberCell(takedowns),
        deaths: new NumberCell(deaths),
        assists: new NumberCell(assists),
        damage: new NumberCell(damage),
        ping: new NumberCell(ping),
      });
      order.push(0);
    }
    boardTeams.appendChild(block);
    boards.push({ score: new NumberCell(scoreNode), rows, order });
  }
  const watchersNode = div('dfh-board-watch');
  const watchersShown = new Visibility(watchersNode);
  const watchersLabel = span('dfh-overline', 'Watching');
  const watchersNamesNode = span('dfh-board-watch-names');
  watchersNode.append(watchersLabel, watchersNamesNode);
  const shownWatchers: string[] = [];
  board.append(boardHead, boardTeams, watchersNode);
  el.appendChild(board);

  root.appendChild(el);

  // --- State kept between frames ------------------------------------------------------------------
  let disposed = false;
  let lastTextMs = -Infinity;
  let lastBoardMs = -Infinity;
  let fresh = true;
  let shownHitSeq = 0;
  let shownTakedownSeq = 0;
  let lastButtons = 0;
  let lastClass: DragonClassId | null = null;
  let lastStatusBits = -1;
  let lastReticleX = 0;
  let lastReticleY = 0;
  let localTeam: TeamId | null = null;
  let shownBanner: BannerId = BANNER_NONE;
  let shownBannerRound = -1;
  let shownBannerMode: ModeId | null = null;
  let shownCountdown = -1;
  let shownNoteMode: ModeId | null = null;
  let shownNoteLimit = -1;
  let shownNoteRound = -1;
  let shownBoardMode: ModeId | null = null;
  let shownBoardLimit = -1;
  let shownClockTotal = -2;
  let tabHeld = false;

  const reticleX = new StepStyle(aim, '--dfh-rx', px);
  const reticleY = new StepStyle(aim, '--dfh-ry', px);
  // The table index of 0px, so the first frame does not write a centred reticle.
  reticleX.set(radius);
  reticleY.set(radius);

  // --- Sections ---------------------------------------------------------------------------------------

  function updateVeils(local: HudLocalState | null): void {
    const low =
      local === null ? 0 : quantize(lowHealthLevel(local.health, local.alive), OPACITY_STEPS);
    lowHealthShown.set(low > 0);
    if (low > 0) lowHealthOpacity.set(low);
    const dark =
      local === null || !local.alive ? 0 : quantize(blindLevel(local.blindS ?? 0), OPACITY_STEPS);
    blindShown.set(dark > 0);
    if (dark > 0) blindOpacity.set(dark);
  }

  function updateCentre(hud: HudState, local: HudLocalState | null): void {
    const reticle = hud.reticle;
    const playing = local !== null && local.alive;
    const locked = reticle !== null && reticle !== undefined && reticle.locked;
    ringShown.set(locked && playing);
    aimShown.set(locked && playing);
    promptShown.set(reticle !== null && reticle !== undefined && !reticle.locked && playing);
    if (reticle !== null && reticle !== undefined && locked && playing) {
      // NaN fails both comparisons and lands on 0.
      const fx = reticle.x > -1 ? (reticle.x < 1 ? reticle.x : 1) : reticle.x <= -1 ? -1 : 0;
      const fy = reticle.y > -1 ? (reticle.y < 1 ? reticle.y : 1) : reticle.y <= -1 ? -1 : 0;
      const x = Math.round(fx * radius);
      // Screen y points down.
      const y = Math.round(-fy * radius);
      if (x !== lastReticleX) reticleX.set((lastReticleX = x) + radius);
      if (y !== lastReticleY) reticleY.set((lastReticleY = y) + radius);
    }

    const hitSeq = hud.hitSeq ?? 0;
    const takedownSeq = hud.takedownSeq ?? 0;
    if (fresh) {
      shownHitSeq = hitSeq;
      shownTakedownSeq = takedownSeq;
    } else if (takedownSeq !== shownTakedownSeq) {
      // A takedown also lands a hit on the same frame: the stronger mark wins.
      shownTakedownSeq = takedownSeq;
      shownHitSeq = hitSeq;
      hitPulse.fire('down');
    } else if (hitSeq !== shownHitSeq) {
      shownHitSeq = hitSeq;
      hitPulse.fire('hit');
    }

    const arcs = hud.damageArcs;
    for (let i = 0; i < HUD_DAMAGE_ARCS; i++) {
      const arc = arcs === undefined ? undefined : arcs[i];
      const shown = arcShown[i];
      const opacity = arcOpacity[i];
      const angle = arcAngle[i];
      if (shown === undefined || opacity === undefined || angle === undefined) continue;
      // Arcs point at what hurt the local rider: a spectator has none.
      const step =
        arc === undefined || local === null ? 0 : damageArcOpacityStep(arc.ageS, arc.strength);
      shown.set(step > 0);
      if (arc === undefined || step === 0) continue;
      opacity.set(step);
      angle.set(angleDegrees(arc.angle));
    }
  }

  function updateHeader(hud: HudState, text: boolean): void {
    const pipCount = roundPipCount(hud.mode, hud.scoreLimit);
    headerMode.set(pipCount > 0 ? 'rounds' : 'score');
    for (let t = 0; t < scoreSides.length; t++) {
      const side = scoreSides[t];
      if (side === undefined) continue;
      const score = hud.scores[t] ?? 0;
      side.score.set(score);
      side.progress.set(pipCount > 0 ? 0 : scoreProgressStep(score, hud.scoreLimit));
      for (let i = 0; i < MAX_ROUND_PIPS; i++) {
        side.pipSlots[i]?.set(i < pipCount);
        if (i < pipCount) side.pips[i]?.set(i < score ? '1' : '0');
      }
    }
    if (!text) return;
    const total = clockTotalSeconds(hud.timeRemainingS);
    if (total !== shownClockTotal) {
      shownClockTotal = total;
      clockMinutes.set(total < 0 ? '--' : clockMinutesString(total));
      clockSeconds.set(total < 0 ? '--' : clockSecondsString(total));
    }
    if (
      hud.mode !== shownNoteMode ||
      hud.scoreLimit !== shownNoteLimit ||
      hud.round !== shownNoteRound
    ) {
      shownNoteMode = hud.mode;
      shownNoteLimit = hud.scoreLimit;
      shownNoteRound = hud.round;
      // Built only when the mode, limit or round changes.
      clockNote.set(
        pipCount > 0
          ? `Round ${hud.round}`
          : hud.scoreLimit > 0
            ? `First to ${hud.scoreLimit}`
            : MODES[hud.mode].name,
      );
    }
  }

  function updateCompass(hud: HudState, text: boolean): void {
    const markers = hud.compass;
    // Blinded riders lose their bearings too: the strip empties while the veil is closed.
    const blinded = hud.local !== null && hud.local.alive && (hud.local.blindS ?? 0) > 0;
    const count =
      markers === undefined || blinded ? 0 : liveCount(markers.length, hud.compassCount);
    for (let i = 0; i < compassParts.length; i++) {
      const part = compassParts[i];
      if (part === undefined) continue;
      const marker = i < count && markers !== undefined ? markers[i] : undefined;
      part.shown.set(marker !== undefined);
      if (marker === undefined) continue;
      part.position.set(compassStep(marker.angle));
      part.pinned.set(compassPinned(marker.angle) ? '1' : '0');
      part.down.set(marker.alive ? '0' : '1');
      const key = marker.kind === 'objective' ? 'none' : teamKey(marker.team);
      part.team.set(marker.kind === 'objective' ? 'objective' : key);
      part.icon.set(TEAM_SHAPES[key]);
      if (text) part.distance.set(distanceShown(marker.distanceM));
    }
  }

  function updateFeed(hud: HudState): void {
    const entries = hud.killfeed;
    const count = liveCount(entries.length, hud.killfeedCount);
    const me = hud.localPlayerId ?? NO_PLAYER;
    for (let i = 0; i < feedRows.length; i++) {
      const row = feedRows[i];
      if (row === undefined) continue;
      const entry = i < count ? entries[i] : undefined;
      const step = entry === undefined ? 0 : killfeedOpacityStep(entry.ageS);
      row.shown.set(step > 0);
      if (entry === undefined || step === 0) continue;
      row.opacity.set(step);
      const hasKiller = entry.killerId !== NO_PLAYER && entry.killerTeam !== null;
      row.killerShown.set(hasKiller);
      if (hasKiller) {
        row.killerTeam.set(teamKey(entry.killerTeam));
        row.killerIcon.set(teamIconPath(entry.killerTeam));
        row.killerName.set(entry.killerName);
      }
      row.glyph.set(takedownGlyph(entry.source, hasKiller ? entry.killerClassId : null));
      row.victimTeam.set(teamKey(entry.victimTeam));
      row.victimIcon.set(teamIconPath(entry.victimTeam));
      row.victimName.set(entry.victimName);
      row.own.set(me !== NO_PLAYER && (entry.killerId === me || entry.victimId === me) ? '1' : '0');
    }
  }

  function updateVitals(local: HudLocalState, text: boolean): void {
    const healthStepNow = local.alive ? quantizeVisible(local.health, UNIT_STEPS) : 0;
    healthStep.set(healthStepNow);
    healthLow.set(lowHealthLevel(local.health, local.alive) > 0 ? '1' : '0');
    staminaStep.set(quantize(local.stamina, UNIT_STEPS));
    staminaSpent.set(local.stamina < 0.15 ? '1' : '0');

    const bits = (local.flags ?? 0) & STATUS_MASK;
    if (bits !== lastStatusBits) {
      lastStatusBits = bits;
      for (let i = 0; i < STATUS_GLYPHS.length; i++) {
        const status = STATUS_GLYPHS[i];
        if (status !== undefined) statusShown[i]?.set((bits & STATUS_BITS[status.key]) !== 0);
      }
    }
    if (!text) return;
    classLabel.set(DRAGON_CLASSES[local.classId].name);
    ownShape.set(teamIconPath(localTeam));
    const max = local.healthMax ?? 0;
    hpBoxShown.set(max > 0);
    if (max > 0) {
      hpNumber.set(local.alive ? healthPoints(local.health, max) : 0);
      hpMax.set(Math.round(max));
    }
  }

  function updateSlots(hud: HudState, local: HudLocalState, text: boolean): void {
    if (local.classId !== lastClass) {
      lastClass = local.classId;
      const glyphs = ABILITY_GLYPHS[local.classId];
      for (let i = 0; i < slots.length; i++) {
        const slot = ABILITY_SLOTS[i];
        if (slot !== undefined) slots[i]?.glyph.set(glyphs[slot]);
      }
    }
    const buttons = local.alive ? (local.buttons ?? 0) : 0;
    const castSlot = local.castSlot ?? -1;
    const labels = hud.keyLabels;
    for (let i = 0; i < slots.length; i++) {
      const part = slots[i];
      const slot = ABILITY_SLOTS[i];
      if (part === undefined || slot === undefined) continue;
      const isUltimate = slot === 'ultimate';
      const rawCooldown = local.cooldowns[slot];
      const cooldown = shownCooldown(rawCooldown, local.cooldownS?.[i]);
      // A fire rate, not a wait: the slot stays lit between shots.
      const rapid = rawCooldown > 0 && cooldown === 0;
      const charges = rapid ? 1 : (local.charges?.[i] ?? (cooldown > 0 ? 0 : 1));
      const maxCharges = local.maxCharges?.[i] ?? 1;
      const state = slotState(
        isUltimate,
        cooldown,
        local.ultimateCharge,
        charges,
        rapid && local.alive ? true : local.ready?.[i],
        local.active?.[i] === true,
        castSlot === i,
      );
      if (state !== part.lastState) {
        part.lastState = state;
        part.state.set(SLOT_STATE_NAMES[state]);
      }
      const bit = BUTTON_PRIMARY << i;
      part.held.set((buttons & bit) !== 0 ? '1' : '0');
      if (!fresh && deniedPress(buttons, lastButtons, bit, state)) part.denied.fire('no');

      if (isUltimate) {
        // The ring is the charge; once full it shows any cooldown like the other slots.
        part.sweep.set(quantize(local.ultimateCharge, SWEEP_STEPS));
        part.sweepShown.set(false);
      } else {
        // With a charge in store the sweep shows the next one loading, but dimmer (CSS).
        const sweep = state === SLOT_ACTIVE ? 0 : cooldownSweepStep(cooldown);
        part.sweepShown.set(sweep > 0);
        if (sweep > 0) part.sweep.set(sweep);
      }
      part.cast.set(state === SLOT_CHARGING ? quantize(local.castProgress ?? 0, UNIT_STEPS) : 0);

      part.pipsShown.set(maxCharges > 1);
      if (maxCharges > 1) {
        for (let p = 0; p < MAX_CHARGE_PIPS; p++) {
          part.pipSlots[p]?.set(p < maxCharges);
          if (p < maxCharges) part.pips[p]?.set(p < charges ? '1' : '0');
        }
      }
      if (!text) continue;
      if (isUltimate) {
        const percent = ultimatePercent(local.ultimateCharge);
        part.secondsShown.set(percent < 100);
        if (percent < 100) part.seconds.set(percent);
      } else {
        const seconds = charges > 0 ? 0 : cooldownSecondsShown(local.cooldownS?.[i] ?? 0);
        part.secondsShown.set(seconds > 0);
        if (seconds > 0) part.seconds.set(seconds);
      }
      if (labels !== undefined) part.key.set(labels[i] ?? DEFAULT_KEY_LABELS[i] ?? '');
    }
    lastButtons = buttons;
  }

  function updateRespawn(hud: HudState, local: HudLocalState | null): void {
    const down = local !== null && !local.alive && hud.phase === 'playing';
    respawnShown.set(down);
    if (!down || local === null) return;
    const rows = hud.scoreboard;
    const count = liveCount(rows.length, hud.scoreboardCount);
    const me = hud.localPlayerId ?? NO_PLAYER;
    const index = local.killerId === me ? -1 : findRow(rows, count, local.killerId);
    const killer = index >= 0 ? rows[index] : undefined;
    killerLineShown.set(killer !== undefined);
    if (killer !== undefined) {
      respawnOver.set('Downed by');
      killerTeam.set(teamKey(killer.team));
      killerIcon.set(teamIconPath(killer.team));
      killerName.set(killer.name);
      killerClass.set(DRAGON_CLASSES[killer.classId].name);
    } else {
      respawnOver.set('Downed');
    }
    const seconds = countdownSeconds(local.respawnInS);
    respawnCountShown.set(seconds > 0);
    respawnOutShown.set(seconds < 0);
    if (seconds > 0) respawnNum.set(seconds);
  }

  function updateBanner(hud: HudState): void {
    const kind = bannerFor(hud.phase, hud.countdown, hud.winner, localTeam);
    bannerShown.set(kind !== BANNER_NONE);
    if (kind === BANNER_NONE) {
      shownBanner = kind;
      return;
    }
    if (kind === BANNER_COUNTDOWN) {
      if (hud.countdown !== shownCountdown || shownBanner !== kind) {
        shownCountdown = hud.countdown;
        bannerTitle.set(intString(hud.countdown));
        bannerBeat.fire('beat');
      }
    }
    if (kind === shownBanner && hud.round === shownBannerRound && hud.mode === shownBannerMode) {
      return;
    }
    shownBanner = kind;
    shownBannerRound = hud.round;
    shownBannerMode = hud.mode;
    bannerKind.set(
      kind === BANNER_VICTORY
        ? 'won'
        : kind === BANNER_DEFEAT
          ? 'lost'
          : kind === BANNER_COUNTDOWN
            ? 'count'
            : 'plain',
    );
    const rounds = hud.mode === 'duel';
    const final = hud.phase === 'results';
    if (kind === BANNER_COUNTDOWN) {
      bannerOver.set(rounds ? `Round ${hud.round}` : MODES[hud.mode].name);
      return;
    }
    bannerTitle.set(BANNER_TITLES[kind] ?? '');
    if (kind === BANNER_EMBER_WINS || kind === BANNER_FROST_WINS) {
      bannerOver.set(final ? 'The match goes to' : 'The round goes to');
    } else if (final) {
      const winner = hud.winner;
      bannerOver.set(
        kind === BANNER_DRAW || winner === 'draw' || winner === null || winner === undefined
          ? 'Match over'
          : TEAMS[winner].name,
      );
    } else {
      bannerOver.set(`Round ${hud.round}`);
    }
  }

  function updateBoard(hud: HudState, nowMs: number): void {
    const open = hud.scoreboardOpen === true || tabHeld;
    if (!open) {
      boardShown.set(false);
      return;
    }
    const opening = !boardShown.visible;
    if (!opening && nowMs - lastBoardMs < SCOREBOARD_INTERVAL_MS) return;
    lastBoardMs = nowMs;

    if (hud.mode !== shownBoardMode || hud.scoreLimit !== shownBoardLimit) {
      shownBoardMode = hud.mode;
      shownBoardLimit = hud.scoreLimit;
      boardTitle.set(MODES[hud.mode].name);
      boardNote.set(
        hud.mode === 'duel'
          ? `First to ${hud.scoreLimit} rounds`
          : hud.scoreLimit > 0
            ? `First to ${hud.scoreLimit} takedowns`
            : '',
      );
    }
    const rows = hud.scoreboard;
    const count = liveCount(rows.length, hud.scoreboardCount);
    const me = hud.localPlayerId ?? NO_PLAYER;
    for (let t = 0; t < boards.length; t++) {
      const team = boards[t];
      if (team === undefined) continue;
      team.score.set(hud.scores[t] ?? 0);
      const written = sortTeamRows(rows, count, t === 0 ? TEAM_EMBER : TEAM_FROST, team.order);
      for (let i = 0; i < team.rows.length; i++) {
        const part = team.rows[i];
        if (part === undefined) continue;
        const row: ScoreboardRow | undefined = i < written ? rows[team.order[i] ?? -1] : undefined;
        part.shown.set(row !== undefined);
        if (row === undefined) continue;
        part.own.set(row.playerId === me ? '1' : '0');
        part.down.set(row.alive ? '0' : '1');
        part.name.set(row.name);
        part.classLabel.set(DRAGON_CLASSES[row.classId].name);
        part.takedowns.set(row.takedowns);
        part.deaths.set(row.deaths);
        part.assists.set(row.assists ?? 0);
        part.damage.set(damageShown(row.damage));
        if (row.pingMs >= 0) part.ping.set(Math.round(row.pingMs));
        else part.ping.setText('–', -1);
      }
    }
    const watchers = hud.spectators;
    const watching =
      watchers === undefined
        ? 0
        : watchers.length < MAX_SPECTATORS_LISTED
          ? watchers.length
          : MAX_SPECTATORS_LISTED;
    let changed = watching !== shownWatchers.length;
    for (let i = 0; i < watching && !changed; i++) {
      if (watchers?.[i] !== shownWatchers[i]) changed = true;
    }
    if (changed) {
      shownWatchers.length = 0;
      for (let i = 0; i < watching; i++) shownWatchers.push(watchers?.[i] ?? '');
      // Names are remote data: text only.
      watchersNamesNode.textContent = shownWatchers.join(', ');
    }
    watchersShown.set(watching > 0);
    boardShown.set(true);
  }

  function update(hud: HudState | null, nowMs: number = performance.now()): void {
    if (disposed) return;
    if (hud === null) {
      if (rootShown.visible) {
        rootShown.set(false);
        boardShown.set(false);
        tabHeld = false;
        fresh = true;
      }
      return;
    }
    const text = fresh || nowMs - lastTextMs >= TEXT_INTERVAL_MS || nowMs < lastTextMs;
    if (text) lastTextMs = nowMs;
    const local = hud.local;

    if (text) {
      // Own team: from the board row (it is also what the board highlights).
      const rows = hud.scoreboard;
      const index = findRow(
        rows,
        liveCount(rows.length, hud.scoreboardCount),
        hud.localPlayerId ?? NO_PLAYER,
      );
      localTeam = index >= 0 ? (rows[index]?.team ?? null) : null;
      rootTeam.set(teamKey(localTeam));
    }
    rootDown.set(local !== null && !local.alive ? '1' : '0');

    updateVeils(local);
    updateCentre(hud, local);
    updateHeader(hud, text);
    updateCompass(hud, text);
    updateFeed(hud);
    vitalsShown.set(local !== null);
    abilitiesShown.set(local !== null);
    if (local !== null) {
      updateVitals(local, text);
      updateSlots(hud, local, text);
    } else {
      lastButtons = 0;
    }
    updateRespawn(hud, local);
    spectateShown.set(local === null);
    if (local === null && text) spectateName.set(hud.spectatingName ?? '');
    updateBanner(hud);
    updateBoard(hud, nowMs);

    rootShown.set(true);
    fresh = false;
  }

  // --- Scoreboard key -----------------------------------------------------------------------------
  const listen = options.listenForTab !== false;
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.code !== 'Tab' || !rootShown.visible) return;
    // Tab would otherwise walk the focus through the page behind the HUD.
    event.preventDefault();
    tabHeld = true;
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.code === 'Tab') tabHeld = false;
  };
  const onBlur = (): void => {
    tabHeld = false;
  };
  if (listen) {
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
  }

  return {
    element: el,
    update,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (listen) {
        document.removeEventListener('keydown', onKeyDown);
        document.removeEventListener('keyup', onKeyUp);
        window.removeEventListener('blur', onBlur);
      }
      el.remove();
    },
  };
}
