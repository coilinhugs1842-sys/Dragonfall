/**
 * Dev-only HUD preview: feeds `createHud` a synthetic HudState along a timeline so the HUD can
 * be looked at (and screenshotted) without a match. Not part of the game bundle.
 *
 *   npx vite  ->  /tools/hud-preview.html
 *   ?t=7.5          freeze the timeline at 7.5 s (for screenshots)
 *   ?mode=duel      Duel header (round pips), no respawn countdown
 *   ?class=wraith   talon | bastion | tempest | wraith
 *   ?team=frost     local rider's team
 *   ?spectate       no local rider
 *   ?board          scoreboard held open
 *   ?stats          DOM-mutation counter (how many writes the HUD makes per second)
 *   ?scale=1.25     UI scale variable
 *
 * Timeline (seconds): 0 countdown · 3 flying, landing hits · 6 hit from the left · 8 low health,
 * burning and slowed · 11 downed · 16 back at the gate · 18 ultimate fills · 20 scoreboard ·
 * 23 blinded · 25 round/match result · 28 loop.
 */

import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  CLASS_TUNING,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BLINDED,
  DRAGON_FLAG_BURNING,
  DRAGON_FLAG_HASTED,
  DRAGON_FLAG_SLOWED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  isDragonClassId,
} from '../src/shared';
import type { DragonClassId, TeamId } from '../src/shared';
import { ageHudState, createHud, createHudState, pushDamageArc, pushKillfeed } from '../src/ui/hud';

const query = new URLSearchParams(location.search);
const frozenAt = query.has('t') ? Number(query.get('t')) : -1;
const duel = query.get('mode') === 'duel';
const classParam = query.get('class');
const classId: DragonClassId = isDragonClassId(classParam) ? classParam : 'talon';
const localTeam: TeamId = query.get('team') === 'frost' ? TEAM_FROST : TEAM_EMBER;
const spectate = query.has('spectate');
const LOOP_S = 28;
const ME = 0;

const uiRoot = document.getElementById('ui');
if (uiRoot === null) throw new Error('missing #ui');
if (query.has('scale')) uiRoot.style.setProperty('--df-ui-scale', query.get('scale') ?? '1');

const hud = createHud(uiRoot);
const state = createHudState();
state.mode = duel ? 'duel' : 'skirmish';
state.scoreLimit = duel ? 3 : 30;
state.localPlayerId = spectate ? NO_PLAYER : ME;
state.reticle = state.reticlePool;
state.spectators.push('Quillon', 'a_very_long_spectator_name_indeed');
state.spectatingName = 'Marrow';

const NAMES = [
  'Aman',
  'Marrow',
  'Sable',
  'Icthar',
  'Wren',
  'Oksana',
  'Vey',
  'Halcyon',
  'Brand',
  'Tuli',
];
const CLASSES: DragonClassId[] = ['talon', 'bastion', 'tempest', 'wraith'];
const riders = duel ? 2 : 10;
for (let i = 0; i < riders; i++) {
  const row = state.scoreboard[i];
  if (row === undefined) continue;
  const team: TeamId = i % 2 === 0 ? localTeam : localTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
  row.playerId = i;
  row.name = NAMES[i] ?? `Rider ${i}`;
  row.team = team;
  row.classId = i === ME ? classId : (CLASSES[i % 4] ?? 'talon');
  row.takedowns = (i * 7) % 9;
  row.deaths = (i * 5) % 6;
  row.assists = (i * 3) % 5;
  row.damage = 400 + ((i * 613) % 2900);
  row.pingMs = i === ME ? 0 : 18 + ((i * 37) % 160);
  row.alive = i % 4 !== 3;
}
state.scoreboardCount = riders;

for (let i = 0; i < 4; i++) {
  const marker = state.compass[i];
  if (marker === undefined) continue;
  marker.kind = i === 3 ? 'objective' : 'ally';
  marker.team = i === 3 ? null : localTeam;
  marker.alive = i !== 2;
}
state.compassCount = duel ? 0 : 4;

const local = state.localPool;
local.classId = classId;
local.healthMax = CLASS_TUNING[classId].maxHp;
local.maxCharges[1] = classId === 'tempest' ? 2 : 1;

let fired = new Set<string>();
function once(key: string, at: number, t: number, run: () => void): void {
  if (t >= at && !fired.has(key)) {
    fired.add(key);
    run();
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

function name(id: number): string {
  return NAMES[id] ?? '';
}

/** Rewrites `state` for timeline time `t`. Events fire once as `t` passes them. */
function drive(t: number, dt: number): void {
  ageHudState(state, dt);
  const enemy = localTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;

  state.phase = t < 3 ? 'countdown' : t >= 25 ? (duel ? 'roundEnd' : 'results') : 'playing';
  state.countdown = t < 3 ? Math.ceil(3 - t) : 0;
  state.round = duel ? 2 : 1;
  state.winner = t >= 25 ? (t < 26.5 ? localTeam : enemy) : null;
  state.timeRemainingS = 420 - Math.max(0, t - 3);
  state.scores[0] = duel ? 1 : 12 + (t > 11 ? 1 : 0);
  state.scores[1] = duel ? (t > 11 ? 2 : 1) : 9 + (t > 5 ? 1 : 0);
  state.scoreboardOpen = query.has('board') || (t >= 20 && t < 23);

  // The reticle drifts in a slow figure; the pointer is "unlocked" for a moment at the start.
  state.reticlePool.locked = t > 0.6;
  state.reticlePool.x = Math.sin(t * 0.9) * 0.45;
  state.reticlePool.y = Math.cos(t * 1.3) * 0.25;

  for (let i = 0; i < state.compassCount; i++) {
    const marker = state.compass[i];
    if (marker === undefined) continue;
    marker.angle = Math.sin(t * 0.25 + i * 1.7) * 2.2 + (i - 1.5) * 0.5;
    marker.distanceM = 80 + i * 140 + Math.sin(t * 0.5 + i) * 40;
  }

  if (spectate) {
    state.local = null;
  } else {
    state.local = local;
    const dead = t >= 11 && t < 16;
    local.alive = !dead;
    let health = 1;
    if (t >= 6) health = lerp(1, 0.6, (t - 6) / 0.4);
    if (t >= 8) health = lerp(0.6, 0.22, (t - 8) / 1.2);
    if (t >= 10) health = lerp(0.22, 0.06, (t - 10) / 1);
    if (dead) health = 0;
    if (t >= 16) health = 1;
    local.health = health;
    local.stamina = 0.5 + 0.5 * Math.sin(t * 0.8);
    local.respawnInS = dead ? (duel ? Infinity : 16 - t) : 0;
    local.killerId = 3;
    let flags = dead ? 0 : DRAGON_FLAG_ALIVE;
    if (t >= 8 && t < 11) flags |= DRAGON_FLAG_BURNING | DRAGON_FLAG_SLOWED;
    if (t >= 16 && t < 18) flags |= DRAGON_FLAG_SPAWN_PROTECTED;
    if (t >= 3 && t < 5) flags |= DRAGON_FLAG_HASTED;
    if (t >= 23 && t < 25) flags |= DRAGON_FLAG_BLINDED;
    local.flags = flags;
    local.blindS = t >= 23 && t < 25 ? 25 - t : 0;
    local.ultimateCharge = t < 18 ? Math.min(0.62, t * 0.04) : lerp(0.62, 1, (t - 18) / 1.2);

    // Primary: rapid. Secondary: 8 s cooldown used at 4 s. Utility: winds up at 5 s.
    const firing = !dead && t >= 3 && t < 10 && t % 2 < 1.4;
    local.buttons = firing ? BUTTON_PRIMARY : 0;
    local.cooldowns.primary = firing ? (t * 5) % 1 : 0;
    local.cooldownS[0] = local.cooldowns.primary * 0.2;
    local.ready[0] = !dead && local.cooldowns.primary === 0;
    const secondaryLeft = t >= 4 ? Math.max(0, 8 - (t - 4)) : 0;
    local.cooldowns.secondary = secondaryLeft / 8;
    local.cooldownS[1] = secondaryLeft;
    const twoCharges = local.maxCharges[1] === 2;
    local.charges[1] = twoCharges ? (secondaryLeft > 0 ? 1 : 2) : secondaryLeft > 0 ? 0 : 1;
    local.ready[1] = !dead && (local.charges[1] ?? 0) > 0;
    // A press on the cooling secondary at 6.5 s: the "not ready" flash.
    if (t >= 6.5 && t < 6.7) local.buttons |= BUTTON_SECONDARY;
    const casting = t >= 5 && t < 5.5;
    local.castSlot = casting ? 2 : -1;
    local.castProgress = casting ? (t - 5) / 0.5 : 0;
    local.active[2] = t >= 5.5 && t < 7;
    const utilityLeft = t >= 7 ? Math.max(0, 12 - (t - 7)) : 0;
    local.cooldowns.utility = utilityLeft / 12;
    local.cooldownS[2] = utilityLeft;
    local.charges[2] = utilityLeft > 0 ? 0 : 1;
    local.ready[2] = !dead && utilityLeft === 0 && !casting && !(local.active[2] ?? false);
    local.ready[3] = !dead && local.ultimateCharge >= 1;
  }

  once('hit1', 3.6, t, () => state.hitSeq++);
  once('hit2', 4.2, t, () => state.hitSeq++);
  once('feed1', 5, t, () => {
    state.hitSeq++;
    state.takedownSeq++;
    pushKillfeed(state, ME, name(ME), localTeam, classId, 5, name(5), enemy, 'primary');
  });
  once('arc1', 6, t, () => pushDamageArc(state, -Math.PI / 2, 0.7));
  once('arc1b', 6.3, t, () => pushDamageArc(state, -Math.PI / 2 + 0.1, 0.4));
  once('feed2', 7, t, () =>
    pushKillfeed(state, 3, name(3), enemy, 'wraith', 4, name(4), localTeam, 'ultimate'),
  );
  once('arc2', 8, t, () => pushDamageArc(state, 2.6, 1));
  once('arc3', 8.6, t, () => pushDamageArc(state, 0.5, 0.5));
  once('feed3', 9, t, () =>
    pushKillfeed(state, NO_PLAYER, '', null, null, 7, name(7), enemy, 'storm'),
  );
  once('arc4', 10.2, t, () => pushDamageArc(state, -2.2, 0.8));
  once('arc5', 10.7, t, () => pushDamageArc(state, -0.9, 1));
  once('feed4', 11, t, () =>
    pushKillfeed(state, 3, name(3), enemy, 'bastion', ME, name(ME), localTeam, 'primary'),
  );
  once('feed5', 12, t, () =>
    pushKillfeed(state, 2, name(2), localTeam, 'tempest', 9, name(9), enemy, 'secondary'),
  );
  once('feed6', 12.6, t, () =>
    pushKillfeed(state, NO_PLAYER, '', null, null, 1, name(1), enemy, 'terrain'),
  );
}

// --- Stats: how many DOM writes the HUD makes ----------------------------------------------------
const statsNode = document.getElementById('stats');
let mutations = 0;
if (query.has('stats') && statsNode !== null) {
  statsNode.hidden = false;
  new MutationObserver((records) => {
    mutations += records.length;
  }).observe(hud.element, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  setInterval(() => {
    statsNode.textContent = `HUD DOM writes in the last second: ${mutations}`;
    (window as unknown as { hudWrites: number }).hudWrites = mutations;
    mutations = 0;
  }, 1000);
}

if (frozenAt >= 0) {
  // Step to the frozen time in 60 Hz frames so events and ages are right, then hold there.
  const step = 1 / 60;
  let now = 0;
  for (let t = 0; t <= frozenAt + 1e-9; t += step) {
    drive(t, step);
    hud.update(state, (now += step * 1000));
  }
  const hold = (): void => {
    hud.update(state, (now += 1000 / 60));
    requestAnimationFrame(hold);
  };
  requestAnimationFrame(hold);
} else {
  let start = performance.now();
  let last = start;
  const frame = (nowMs: number): void => {
    let t = (nowMs - start) / 1000;
    if (t >= LOOP_S) {
      start = nowMs;
      t = 0;
      fired = new Set();
    }
    drive(t, Math.max(0, (nowMs - last) / 1000));
    last = nowMs;
    hud.update(state, nowMs);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
