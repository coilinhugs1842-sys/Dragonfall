/**
 * What plays when (T-3.8): GameEvents, WorldView states and UI actions -> SoundId. Pure data
 * plus small resolvers, so the mapping is testable without WebAudio and a sound swap is a table
 * edit. Every table is keyed by a shared id list (`Record<...>`), so adding a class, status,
 * projectile or event type upstream fails the typecheck here until it has a sound decision.
 * `null` is a decision too: "this has no sound of its own".
 */

import type {
  AbilitySlot,
  DamageSource,
  DragonClassId,
  GameEvent,
  MatchPhase,
  MatchWinner,
  ObjectiveKind,
  PlayerId,
  ProjectileKind,
  StatusKind,
  TeamId,
} from '../shared';
import { NO_PLAYER } from '../shared';
import type { SoundId } from './sounds';

/** The moment an ability fires (`abilityCast`). Each class keeps its own sound family. */
export const ABILITY_SOUNDS: Readonly<
  Record<DragonClassId, Readonly<Record<AbilitySlot, SoundId>>>
> = {
  talon: {
    primary: 'fireBolt',
    secondary: 'dashWhoosh',
    utility: 'afterburn',
    ultimate: 'meteorDrop',
  },
  bastion: {
    primary: 'flameStart',
    secondary: 'shieldUp',
    utility: 'healShimmer',
    ultimate: 'bulwarkWave',
  },
  tempest: {
    primary: 'lightningCrack',
    secondary: 'mineLaunch',
    utility: 'updraft',
    ultimate: 'thunder',
  },
  wraith: {
    primary: 'shadeHiss',
    secondary: 'veil',
    utility: 'phaseDive',
    ultimate: 'nightTerror',
  },
};

/**
 * Loop that runs on a dragon while DRAGON_FLAG_FIRING is set (a held breath emits ONE
 * `abilityCast`, so the sustain is driven by the flag). null = its primary is per-shot.
 */
export const SUSTAIN_SOUNDS: Readonly<Record<DragonClassId, SoundId | null>> = {
  talon: null,
  bastion: 'flameLoop',
  tempest: null,
  wraith: 'shadeLoop',
};

/** Played when a dragon starts winding up (DRAGON_FLAG_CHARGING goes on). */
export const CHARGE_SOUNDS: Readonly<Record<DragonClassId, SoundId | null>> = {
  talon: null,
  bastion: 'windup',
  tempest: 'lightningCharge',
  wraith: 'windup',
};

/** `hit`, by what dealt the damage. */
export const HIT_SOUNDS: Readonly<Record<DamageSource, SoundId>> = {
  primary: 'hitFlesh',
  secondary: 'hitFlesh',
  utility: 'hitFlesh',
  ultimate: 'hitFlesh',
  terrain: 'hitRock',
  storm: 'stormZap',
};
/** An ability hit on a dragon whose wing shield is up (the part that got through). */
export const HIT_SHIELD_SOUND: SoundId = 'hitShield';
/** The local rider's own hit landing on someone, on top of the positional hit. */
export const HIT_CONFIRM_SOUND: SoundId = 'hitConfirm';
export const TAKEDOWN_SOUND: SoundId = 'takedownBoom';
/** The local rider got the takedown. */
export const TAKEDOWN_CONFIRM_SOUND: SoundId = 'takedownConfirm';
/** The local rider got an assist. Other riders' assists are silent. */
export const ASSIST_SOUND: SoundId = 'assist';
export const SPAWN_SOUND: SoundId = 'spawnChime';

/** `statusApplied`. Self-buffs are null: their cast sound already said it. */
export const STATUS_SOUNDS: Readonly<Record<StatusKind, SoundId | null>> = {
  slow: 'slowZap',
  burn: 'burnIgnite',
  blind: 'blindSwell',
  veil: null,
  phase: null,
  shield: null,
  haste: null,
  regen: 'healShimmer',
};

/** `impact`. Bolts are null: a bolt that lands is heard as its `hit`. */
export const IMPACT_SOUNDS: Readonly<Record<ProjectileKind, SoundId | null>> = {
  fireBolt: null,
  meteorBomb: 'blast',
  staticMine: 'mineArm',
};

/** `objective` (T-6.x fills in distinct ones). */
export const OBJECTIVE_SOUNDS: Readonly<Record<ObjectiveKind, SoundId>> = {
  pickedUp: 'objective',
  dropped: 'objective',
  returned: 'objective',
  captured: 'objective',
  zoneTaken: 'objective',
};

/**
 * `matchPhase`, on entering the phase. `countdown` is null because its ticks follow the clock
 * (COUNTDOWN_TICK_SOUND), and `results` is decided by RESULT_SOUNDS.
 */
export const PHASE_SOUNDS: Readonly<Record<MatchPhase, SoundId | null>> = {
  lobby: null,
  intro: null,
  countdown: null,
  playing: 'countdownGo',
  roundEnd: 'roundEnd',
  results: null,
};

export const COUNTDOWN_TICK_SOUND: SoundId = 'countdownTick';

/** The sting on `results`, from the local rider's side. Spectators hear `draw`. */
export const RESULT_SOUNDS: Readonly<Record<'won' | 'lost' | 'draw', SoundId>> = {
  won: 'victory',
  lost: 'defeat',
  draw: 'roundEnd',
};

/** Own-flight loops and beats driven by the WorldView. */
export const FLIGHT_SOUNDS = {
  wind: 'windLoop',
  boost: 'boostLoop',
  storm: 'stormLoop',
  flap: 'flap',
  heartbeat: 'heartbeat',
} as const satisfies Record<string, SoundId>;

/** What the UI may ask for through `playUi` (wired by `src/game`; the UI never imports audio). */
export const UI_SOUND_IDS = ['hover', 'click', 'ready', 'error'] as const;
export type UiSoundId = (typeof UI_SOUND_IDS)[number];

export const UI_SOUNDS: Readonly<Record<UiSoundId, SoundId>> = {
  hover: 'uiHover',
  click: 'uiClick',
  ready: 'uiReady',
  error: 'uiError',
};

/** What a resolver needs to know about this browser's rider. */
export interface LocalContext {
  /** NO_PLAYER for spectators. */
  readonly localId: PlayerId;
  /** null for spectators and before the first match frame. */
  readonly localTeam: TeamId | null;
}

export function resultSound(winner: MatchWinner | null, localTeam: TeamId | null): SoundId {
  if (winner === null || winner === 'draw' || localTeam === null) return RESULT_SOUNDS.draw;
  return winner === localTeam ? RESULT_SOUNDS.won : RESULT_SOUNDS.lost;
}

/**
 * The world sound of an event (the one placed at the event's position), or null when it has
 * none. `targetShielded`: whether a `hit`'s target has its wing shield up.
 */
export function eventSound(
  event: GameEvent,
  local: LocalContext,
  targetShielded = false,
): SoundId | null {
  switch (event.type) {
    case 'abilityCast':
      return ABILITY_SOUNDS[event.classId][event.slot];
    case 'hit':
      if (targetShielded && event.source !== 'terrain' && event.source !== 'storm') {
        return HIT_SHIELD_SOUND;
      }
      return HIT_SOUNDS[event.source];
    case 'takedown':
      return TAKEDOWN_SOUND;
    case 'spawn':
      return SPAWN_SOUND;
    case 'statusApplied':
      return STATUS_SOUNDS[event.status];
    case 'impact':
      return IMPACT_SOUNDS[event.projectile];
    case 'objective':
      return OBJECTIVE_SOUNDS[event.kind];
    case 'matchPhase':
      return event.phase === 'results'
        ? resultSound(event.winner, local.localTeam)
        : PHASE_SOUNDS[event.phase];
    case 'assist':
      // Follows a takedown, which already boomed: only the assister hears a note.
      return null;
    default: {
      const unhandled: never = event;
      return unhandled;
    }
  }
}

/**
 * The extra, non-positional feedback sound an event gives the local rider (a hit landed, a
 * takedown, an assist), or null.
 */
export function localFeedbackSound(event: GameEvent, local: LocalContext): SoundId | null {
  if (local.localId === NO_PLAYER) return null;
  switch (event.type) {
    case 'hit':
      return event.attackerId === local.localId && event.targetId !== local.localId
        ? HIT_CONFIRM_SOUND
        : null;
    case 'takedown':
      return event.killerId === local.localId && event.victimId !== local.localId
        ? TAKEDOWN_CONFIRM_SOUND
        : null;
    case 'assist':
      return event.assisterId === local.localId ? ASSIST_SOUND : null;
    default:
      return null;
  }
}
