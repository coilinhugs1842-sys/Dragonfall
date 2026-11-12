/**
 * Who does what in the results show: which dragons fly the pass and where in the V, who lands
 * on which step, and who hovers where. Worked out from the ids, teams and awards alone and in
 * id order, never from the order of the WorldView's pool, so every browser casts the same show.
 *
 * `planPodium` runs when the cast or the set of dragons changes (normally once, on the first
 * `results` frame); `planIsCurrent` is the cheap per-frame check. Neither allocates once the
 * plan's arrays have grown to the number of dragons.
 */
import { NO_PLAYER, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { MatchWinner, PlayerId, TeamId, WorldView } from '../../shared';
import {
  ARC_GAP,
  ARC_OTHERS,
  ARC_STEP,
  ARC_WINNERS,
  PASS_GROUP_BACK,
  PASS_ROW_BACK,
  SEAT_DAMAGE,
  SEAT_MVP,
  SEAT_TAKEDOWNS,
} from './podium-layout';
import {
  HOVER_STAGGER_S,
  HOVER_START_S,
  PASS_CUT_U,
  PASS_S,
  SEAT_START_S,
} from './podium-timeline';

/** What the cast needs to know of the awards (`PodiumCast` fits). */
export interface PodiumAwards {
  readonly winner: MatchWinner;
  readonly mvpId: PlayerId;
  readonly mostTakedownsId: PlayerId;
  readonly mostDamageId: PlayerId;
}

/**
 * One entry per dragon of the view, at the dragon's index in the pool. Plain arrays that only
 * grow (ten entries in a full room).
 */
export interface PodiumPlan {
  count: number;
  /** What the plan was made for: the dragons' ids and teams, and the awards. */
  readonly ids: number[];
  readonly teams: number[];
  winner: MatchWinner;
  mvpId: PlayerId;
  mostTakedownsId: PlayerId;
  mostDamageId: PlayerId;
  /** Step the dragon lands on (SEAT_*), or -1. */
  readonly seat: number[];
  /** Which V it flies in (0, or 1 for the second team of a draw), or -1: not in the pass. */
  readonly passGroup: number[];
  /** Row of the V (0 = the leader) and side (-1, 0, +1). */
  readonly passRow: number[];
  readonly passSide: number[];
  /** Hover arc (ARC_*) and bearing on it (0 = straight behind the podium), or arc -1 when seated. */
  readonly arc: number[];
  readonly arcAngle: number[];
  /** Its place along the arc (neighbours differ by one): odd and even places hang at different heights. */
  readonly arcSlot: number[];
  /** Seconds: how far behind the leader it flies the pass curve. */
  readonly passDelayS: number[];
  /** Seconds: when its pass ends (0 when it is not in the pass). */
  readonly cutS: number[];
  /** Seconds: when it leaves for its step or its place in the arc. */
  readonly startS: number[];
  /** Scratch: pool indices in id order. */
  readonly order: number[];
}

export function createPodiumPlan(): PodiumPlan {
  return {
    count: 0,
    ids: [],
    teams: [],
    winner: 'draw',
    mvpId: NO_PLAYER,
    mostTakedownsId: NO_PLAYER,
    mostDamageId: NO_PLAYER,
    seat: [],
    passGroup: [],
    passRow: [],
    passSide: [],
    arc: [],
    arcAngle: [],
    arcSlot: [],
    passDelayS: [],
    cutS: [],
    startS: [],
    order: [],
  };
}

/** True when `plan` was made for exactly these dragons and awards. Per frame; allocation-free. */
export function planIsCurrent(plan: PodiumPlan, view: WorldView, awards: PodiumAwards): boolean {
  if (
    plan.count !== view.dragonCount ||
    plan.winner !== awards.winner ||
    plan.mvpId !== awards.mvpId ||
    plan.mostTakedownsId !== awards.mostTakedownsId ||
    plan.mostDamageId !== awards.mostDamageId
  ) {
    return false;
  }
  for (let i = 0; i < view.dragonCount; i++) {
    const dragon = view.dragons[i];
    if (dragon === undefined) return false;
    if (plan.ids[i] !== dragon.id || plan.teams[i] !== dragon.team) return false;
  }
  return true;
}

/**
 * The step of a rider. One rider with several awards takes the highest of its steps and the
 * others stay empty; an award nobody earned (NO_PLAYER) leaves its step empty too.
 */
function seatOf(id: PlayerId, awards: PodiumAwards): number {
  if (id === NO_PLAYER) return -1;
  if (id === awards.mvpId) return SEAT_MVP;
  if (id === awards.mostTakedownsId) return SEAT_TAKEDOWNS;
  if (id === awards.mostDamageId) return SEAT_DAMAGE;
  return -1;
}

/** Row and side of the `rank`-th dragon of a V: the leader, then left and right in turn. */
function setPassPlace(plan: PodiumPlan, index: number, group: number, rank: number): void {
  const row = (rank + 1) >> 1;
  plan.passGroup[index] = group;
  plan.passRow[index] = row;
  plan.passSide[index] = rank === 0 ? 0 : (rank & 1) === 1 ? -1 : 1;
  const delay = (row * PASS_ROW_BACK + group * PASS_GROUP_BACK) / passSpeed();
  plan.passDelayS[index] = delay;
  plan.cutS[index] = PASS_CUT_U * PASS_S + delay;
}

/** Metres per second along the pass: the curve is about 220 m long. */
export function passSpeed(): number {
  return 220 / PASS_S;
}

/**
 * Casts the show for the dragons of `view`. A team's V is led by its award winners (the MVP
 * first), then by id. Hover places are handed out in id order, from the picture's left to its
 * right. In a draw both teams fly the pass and each keeps to its own side of the podium, Ember
 * on the left, in both arcs.
 */
export function planPodium(plan: PodiumPlan, view: WorldView, awards: PodiumAwards): PodiumPlan {
  const count = view.dragonCount;
  plan.count = count;
  plan.winner = awards.winner;
  plan.mvpId = awards.mvpId;
  plan.mostTakedownsId = awards.mostTakedownsId;
  plan.mostDamageId = awards.mostDamageId;

  const ids = plan.ids;
  const teams = plan.teams;
  const order = plan.order;
  let mvpTeam = -1;
  for (let i = 0; i < count; i++) {
    const dragon = view.dragons[i];
    const id = dragon !== undefined ? dragon.id : NO_PLAYER;
    const team = dragon !== undefined ? dragon.team : TEAM_EMBER;
    ids[i] = id;
    teams[i] = team;
    plan.seat[i] = seatOf(id, awards);
    if (plan.seat[i] === SEAT_MVP) mvpTeam = team;
    plan.passGroup[i] = -1;
    plan.passRow[i] = 0;
    plan.passSide[i] = 0;
    plan.passDelayS[i] = 0;
    plan.cutS[i] = 0;
    plan.arc[i] = -1;
    plan.arcAngle[i] = 0;
    plan.arcSlot[i] = 0;
    plan.startS[i] = 0;
    // Insertion sort by id (at most ten entries).
    let at = i;
    while (at > 0 && (ids[order[at - 1] ?? 0] ?? 0) > id) {
      order[at] = order[at - 1] ?? 0;
      at--;
    }
    order[at] = i;
  }

  // --- The pass: one V per flying team ---------------------------------------------------------
  const draw = awards.winner === 'draw';
  const leadTeam: TeamId = draw
    ? mvpTeam === TEAM_FROST
      ? TEAM_FROST
      : TEAM_EMBER
    : awards.winner === TEAM_FROST
      ? TEAM_FROST
      : TEAM_EMBER;
  const groups = draw ? 2 : 1;
  for (let group = 0; group < groups; group++) {
    const team = group === 0 ? leadTeam : leadTeam === TEAM_EMBER ? TEAM_FROST : TEAM_EMBER;
    let rank = 0;
    // Award winners lead (highest step first), then everyone else, each in id order.
    for (let wanted = SEAT_MVP; wanted <= SEAT_DAMAGE + 1; wanted++) {
      for (let o = 0; o < count; o++) {
        const index = order[o] ?? 0;
        if (teams[index] !== team) continue;
        const seat = plan.seat[index] ?? -1;
        if (wanted <= SEAT_DAMAGE ? seat !== wanted : seat !== -1) continue;
        setPassPlace(plan, index, group, rank++);
      }
    }
  }

  // --- The hover arcs ----------------------------------------------------------------------------
  if (draw) {
    // Each team on its own side, filling the near arc and the far arc in turn, outward: the
    // same places a full row would have, split down the middle.
    for (let side = 0; side < 2; side++) {
      const team = side === 0 ? TEAM_EMBER : TEAM_FROST;
      const sign = side === 0 ? -1 : 1;
      let placed = 0;
      for (let o = 0; o < count; o++) {
        const index = order[o] ?? 0;
        if (teams[index] !== team || (plan.seat[index] ?? -1) !== -1) continue;
        // Two on the near arc, then the far arc takes the fifth too: a third on the near arc
        // would hang outside the picture.
        const arc = (placed & 1) === 0 && placed < 4 ? ARC_WINNERS : ARC_OTHERS;
        const pair = placed < 4 ? placed >> 1 : 2;
        plan.arc[index] = arc;
        plan.arcAngle[index] = sign * ((ARC_GAP[arc] ?? 0) + pair * (ARC_STEP[arc] ?? 0));
        plan.arcSlot[index] = pair;
        plan.startS[index] = (HOVER_START_S[arc] ?? 0) + pair * HOVER_STAGGER_S;
        placed++;
      }
    }
  } else {
    for (let arc = ARC_WINNERS; arc <= ARC_OTHERS; arc++) {
      let total = 0;
      for (let i = 0; i < count; i++) {
        if ((plan.seat[i] ?? -1) !== -1) continue;
        if ((teams[i] === leadTeam) === (arc === ARC_WINNERS)) total++;
      }
      let placed = 0;
      for (let o = 0; o < count; o++) {
        const index = order[o] ?? 0;
        if ((plan.seat[index] ?? -1) !== -1) continue;
        if ((teams[index] === leadTeam) !== (arc === ARC_WINNERS)) continue;
        plan.arc[index] = arc;
        // Parted in the middle: the first ones to the left of the steps, the rest to the right.
        // Two fit on the left of the picture; a fifth goes to the right.
        const left = Math.min((total + 1) >> 1, 2);
        const outward = placed < left ? left - 1 - placed : placed - left;
        const angle = (ARC_GAP[arc] ?? 0) + outward * (ARC_STEP[arc] ?? 0);
        plan.arcAngle[index] = placed < left ? -angle : angle;
        plan.arcSlot[index] = outward;
        plan.startS[index] = (HOVER_START_S[arc] ?? 0) + placed * HOVER_STAGGER_S;
        placed++;
      }
    }
  }

  // --- Start times: the steps by award, and nobody leaves before its pass is over --------------
  for (let i = 0; i < count; i++) {
    const seat = plan.seat[i] ?? -1;
    if (seat >= 0) plan.startS[i] = SEAT_START_S[seat] ?? 0;
    const cut = plan.cutS[i] ?? 0;
    if ((plan.startS[i] ?? 0) < cut) plan.startS[i] = cut;
  }
  return plan;
}
