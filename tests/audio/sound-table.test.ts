import { describe, expect, it } from 'vitest';
import {
  ABILITY_SOUNDS,
  ASSIST_SOUND,
  CHARGE_SOUNDS,
  COUNTDOWN_TICK_SOUND,
  FLIGHT_SOUNDS,
  HIT_CONFIRM_SOUND,
  HIT_SHIELD_SOUND,
  HIT_SOUNDS,
  IMPACT_SOUNDS,
  OBJECTIVE_SOUNDS,
  PHASE_SOUNDS,
  RESULT_SOUNDS,
  SOUND_DEFS,
  SOUND_IDS,
  SPAWN_SOUND,
  STATUS_SOUNDS,
  SUSTAIN_SOUNDS,
  TAKEDOWN_CONFIRM_SOUND,
  TAKEDOWN_SOUND,
  UI_SOUNDS,
  UI_SOUND_IDS,
  eventSound,
  localFeedbackSound,
  resultSound,
} from '../../src/audio';
import type { LocalContext, SoundId } from '../../src/audio';
import {
  ABILITY_SLOTS,
  ABILITY_TABLE,
  DAMAGE_SOURCES,
  DRAGON_CLASS_IDS,
  MATCH_PHASES,
  NO_PLAYER,
  OBJECTIVE_KINDS,
  PROJECTILE_DEFS,
  PROJECTILE_KINDS,
  STATUS_KINDS,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { GameEvent, GameEventType } from '../../src/shared';

const KNOWN = new Set<string>(SOUND_IDS);
const ORIGIN = { x: 0, y: 0, z: 0 };
const FORWARD = { x: 0, y: 0, z: 1 };
const RIDER: LocalContext = { localId: 3, localTeam: TEAM_EMBER };
const SPECTATOR: LocalContext = { localId: NO_PLAYER, localTeam: null };

function isSound(value: unknown): value is SoundId {
  return typeof value === 'string' && KNOWN.has(value);
}

/** One of every event type: adding a type to GameEvent fails the typecheck here. */
const SAMPLE_EVENTS: { readonly [T in GameEventType]: Extract<GameEvent, { type: T }> } = {
  hit: {
    type: 'hit',
    tick: 1,
    attackerId: 3,
    targetId: 5,
    source: 'primary',
    damage: 10,
    position: ORIGIN,
  },
  takedown: {
    type: 'takedown',
    tick: 1,
    killerId: 3,
    victimId: 5,
    source: 'primary',
    position: ORIGIN,
  },
  spawn: {
    type: 'spawn',
    tick: 1,
    dragonId: 5,
    team: TEAM_FROST,
    classId: 'talon',
    position: ORIGIN,
  },
  abilityCast: {
    type: 'abilityCast',
    tick: 1,
    dragonId: 5,
    classId: 'talon',
    slot: 'primary',
    position: ORIGIN,
    direction: FORWARD,
  },
  objective: {
    type: 'objective',
    tick: 1,
    kind: 'pickedUp',
    team: TEAM_EMBER,
    dragonId: 3,
    position: ORIGIN,
  },
  matchPhase: { type: 'matchPhase', tick: 1, phase: 'playing', round: 1, winner: null },
  assist: { type: 'assist', tick: 1, assisterId: 3, killerId: 4, victimId: 5 },
  statusApplied: {
    type: 'statusApplied',
    tick: 1,
    targetId: 5,
    sourceId: 3,
    status: 'slow',
    durationS: 1,
    position: ORIGIN,
  },
  impact: {
    type: 'impact',
    tick: 1,
    projectile: 'meteorBomb',
    ownerId: 3,
    targetId: NO_PLAYER,
    position: ORIGIN,
  },
};

const SINGLE_SOUNDS: readonly SoundId[] = [
  HIT_SHIELD_SOUND,
  HIT_CONFIRM_SOUND,
  TAKEDOWN_SOUND,
  TAKEDOWN_CONFIRM_SOUND,
  ASSIST_SOUND,
  SPAWN_SOUND,
  COUNTDOWN_TICK_SOUND,
];

describe('ability sounds', () => {
  it('every class and slot of the ability table has a real sound', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        expect(ABILITY_TABLE[classId][slot], `${classId}.${slot}`).toBeDefined();
        expect(isSound(ABILITY_SOUNDS[classId][slot]), `${classId}.${slot}`).toBe(true);
      }
    }
    expect(Object.keys(ABILITY_SOUNDS).sort()).toEqual([...DRAGON_CLASS_IDS].sort());
  });

  it('gives all 16 abilities their own sound (each class keeps its own family)', () => {
    const used = new Set<string>();
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) used.add(ABILITY_SOUNDS[classId][slot]);
    }
    expect(used.size).toBe(DRAGON_CLASS_IDS.length * ABILITY_SLOTS.length);
  });

  it('a held cone primary has a sustain loop; per-shot primaries do not', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const sustain = SUSTAIN_SOUNDS[classId];
      const kind = ABILITY_TABLE[classId].primary.kind;
      if (kind === 'cone') {
        expect(sustain, classId).not.toBeNull();
        if (sustain !== null) expect(SOUND_DEFS[sustain].loop, classId).toBe(true);
      } else {
        expect(sustain, classId).toBeNull();
      }
    }
  });

  it('every class with a wind-up has a charge sound', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      const windsUp = ABILITY_SLOTS.some((slot) => ABILITY_TABLE[classId][slot].windupS > 0);
      const charge = CHARGE_SOUNDS[classId];
      if (windsUp) expect(isSound(charge), classId).toBe(true);
      if (charge !== null) expect(SOUND_DEFS[charge].loop, classId).toBe(false);
    }
  });
});

describe('event tables', () => {
  it('cover every shared id', () => {
    for (const source of DAMAGE_SOURCES) expect(isSound(HIT_SOUNDS[source]), source).toBe(true);
    for (const status of STATUS_KINDS) {
      expect(status in STATUS_SOUNDS, status).toBe(true);
      const sound = STATUS_SOUNDS[status];
      if (sound !== null) expect(isSound(sound), status).toBe(true);
    }
    for (const kind of PROJECTILE_KINDS) {
      expect(kind in IMPACT_SOUNDS, kind).toBe(true);
      const sound = IMPACT_SOUNDS[kind];
      if (sound !== null) expect(isSound(sound), kind).toBe(true);
    }
    for (const kind of OBJECTIVE_KINDS) expect(isSound(OBJECTIVE_SOUNDS[kind]), kind).toBe(true);
    for (const phase of MATCH_PHASES) {
      expect(phase in PHASE_SOUNDS, phase).toBe(true);
      const sound = PHASE_SOUNDS[phase];
      if (sound !== null) expect(isSound(sound), phase).toBe(true);
    }
    for (const id of UI_SOUND_IDS) {
      expect(isSound(UI_SOUNDS[id]), id).toBe(true);
      expect(SOUND_DEFS[UI_SOUNDS[id]].bus, id).toBe('ui');
    }
    for (const sound of Object.values(RESULT_SOUNDS)) expect(isSound(sound)).toBe(true);
    for (const sound of Object.values(FLIGHT_SOUNDS)) expect(isSound(sound)).toBe(true);
    for (const sound of SINGLE_SOUNDS) expect(isSound(sound)).toBe(true);
  });

  it('projectiles that blast or leave a zone are heard when they land', () => {
    for (const kind of PROJECTILE_KINDS) {
      const def = PROJECTILE_DEFS[kind];
      if (def.blastRadius > 0 || def.zoneOnEnd !== null) {
        expect(IMPACT_SOUNDS[kind], kind).not.toBeNull();
      }
    }
  });

  it('hostile statuses are heard', () => {
    expect(STATUS_SOUNDS.slow).not.toBeNull();
    expect(STATUS_SOUNDS.burn).not.toBeNull();
    expect(STATUS_SOUNDS.blind).not.toBeNull();
  });

  it('the flight loops loop and the beats do not', () => {
    expect(SOUND_DEFS[FLIGHT_SOUNDS.wind].loop).toBe(true);
    expect(SOUND_DEFS[FLIGHT_SOUNDS.boost].loop).toBe(true);
    expect(SOUND_DEFS[FLIGHT_SOUNDS.storm].loop).toBe(true);
    expect(SOUND_DEFS[FLIGHT_SOUNDS.flap].loop).toBe(false);
    expect(SOUND_DEFS[FLIGHT_SOUNDS.heartbeat].loop).toBe(false);
  });

  it('every sound in the library is reachable from some table', () => {
    const used = new Set<string>();
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) used.add(ABILITY_SOUNDS[classId][slot]);
      used.add(SUSTAIN_SOUNDS[classId] ?? '');
      used.add(CHARGE_SOUNDS[classId] ?? '');
    }
    const tables: Readonly<Record<string, string | null>>[] = [
      HIT_SOUNDS,
      STATUS_SOUNDS,
      IMPACT_SOUNDS,
      OBJECTIVE_SOUNDS,
      PHASE_SOUNDS,
      RESULT_SOUNDS,
      FLIGHT_SOUNDS,
      UI_SOUNDS,
    ];
    for (const table of tables) for (const sound of Object.values(table)) used.add(sound ?? '');
    for (const sound of SINGLE_SOUNDS) used.add(sound);
    for (const id of SOUND_IDS) expect(used.has(id), id).toBe(true);
  });
});

describe('eventSound', () => {
  it('handles every event type', () => {
    const silentByDesign: GameEventType[] = ['assist'];
    for (const type of Object.keys(SAMPLE_EVENTS) as GameEventType[]) {
      const sound = eventSound(SAMPLE_EVENTS[type], RIDER);
      if (silentByDesign.includes(type)) expect(sound, type).toBeNull();
      else expect(isSound(sound), type).toBe(true);
    }
    // The assist is heard by the assister through the feedback path instead.
    expect(localFeedbackSound(SAMPLE_EVENTS.assist, RIDER)).toBe(ASSIST_SOUND);
  });

  it('maps a cast for every class and slot', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const sound = eventSound({ ...SAMPLE_EVENTS.abilityCast, classId, slot }, SPECTATOR);
        expect(sound).toBe(ABILITY_SOUNDS[classId][slot]);
      }
    }
  });

  it('maps a hit by its damage source, and by the shield', () => {
    for (const source of DAMAGE_SOURCES) {
      expect(eventSound({ ...SAMPLE_EVENTS.hit, source }, RIDER)).toBe(HIT_SOUNDS[source]);
    }
    expect(eventSound(SAMPLE_EVENTS.hit, RIDER, true)).toBe(HIT_SHIELD_SOUND);
    // The shield does not stop rock or storm.
    expect(eventSound({ ...SAMPLE_EVENTS.hit, source: 'terrain' }, RIDER, true)).toBe(
      HIT_SOUNDS.terrain,
    );
    expect(eventSound({ ...SAMPLE_EVENTS.hit, source: 'storm' }, RIDER, true)).toBe(
      HIT_SOUNDS.storm,
    );
    expect(new Set(Object.values(HIT_SOUNDS)).size).toBeGreaterThanOrEqual(3);
  });

  it('maps statuses, impacts and objectives through their tables', () => {
    for (const status of STATUS_KINDS) {
      expect(eventSound({ ...SAMPLE_EVENTS.statusApplied, status }, RIDER)).toBe(
        STATUS_SOUNDS[status],
      );
    }
    for (const projectile of PROJECTILE_KINDS) {
      expect(eventSound({ ...SAMPLE_EVENTS.impact, projectile }, RIDER)).toBe(
        IMPACT_SOUNDS[projectile],
      );
    }
    for (const kind of OBJECTIVE_KINDS) {
      expect(eventSound({ ...SAMPLE_EVENTS.objective, kind }, RIDER)).toBe(OBJECTIVE_SOUNDS[kind]);
    }
  });

  it('maps match phases: go on playing, a sting on round end, victory or defeat on results', () => {
    const phase = SAMPLE_EVENTS.matchPhase;
    expect(eventSound({ ...phase, phase: 'lobby' }, RIDER)).toBeNull();
    expect(eventSound({ ...phase, phase: 'intro' }, RIDER)).toBeNull();
    expect(eventSound({ ...phase, phase: 'countdown' }, RIDER)).toBeNull();
    expect(eventSound({ ...phase, phase: 'playing' }, RIDER)).toBe('countdownGo');
    expect(eventSound({ ...phase, phase: 'roundEnd', winner: TEAM_FROST }, RIDER)).toBe('roundEnd');
    expect(eventSound({ ...phase, phase: 'results', winner: TEAM_EMBER }, RIDER)).toBe('victory');
    expect(eventSound({ ...phase, phase: 'results', winner: TEAM_FROST }, RIDER)).toBe('defeat');
    expect(eventSound({ ...phase, phase: 'results', winner: 'draw' }, RIDER)).toBe('roundEnd');
    expect(eventSound({ ...phase, phase: 'results', winner: TEAM_EMBER }, SPECTATOR)).toBe(
      'roundEnd',
    );
  });

  it('resultSound', () => {
    expect(resultSound(TEAM_FROST, TEAM_FROST)).toBe(RESULT_SOUNDS.won);
    expect(resultSound(TEAM_EMBER, TEAM_FROST)).toBe(RESULT_SOUNDS.lost);
    expect(resultSound(null, TEAM_FROST)).toBe(RESULT_SOUNDS.draw);
    expect(resultSound('draw', TEAM_FROST)).toBe(RESULT_SOUNDS.draw);
    expect(resultSound(TEAM_EMBER, null)).toBe(RESULT_SOUNDS.draw);
  });
});

describe('localFeedbackSound', () => {
  it('confirms only the local rider’s own hits, takedowns and assists', () => {
    expect(localFeedbackSound(SAMPLE_EVENTS.hit, RIDER)).toBe(HIT_CONFIRM_SOUND);
    expect(localFeedbackSound({ ...SAMPLE_EVENTS.hit, attackerId: 7 }, RIDER)).toBeNull();
    expect(localFeedbackSound({ ...SAMPLE_EVENTS.hit, targetId: 3 }, RIDER)).toBeNull();
    expect(localFeedbackSound(SAMPLE_EVENTS.takedown, RIDER)).toBe(TAKEDOWN_CONFIRM_SOUND);
    expect(localFeedbackSound({ ...SAMPLE_EVENTS.takedown, killerId: 7 }, RIDER)).toBeNull();
    expect(localFeedbackSound({ ...SAMPLE_EVENTS.assist, assisterId: 7 }, RIDER)).toBeNull();
    expect(localFeedbackSound(SAMPLE_EVENTS.spawn, RIDER)).toBeNull();
  });

  it('gives a spectator nothing', () => {
    for (const type of Object.keys(SAMPLE_EVENTS) as GameEventType[]) {
      expect(localFeedbackSound(SAMPLE_EVENTS[type], SPECTATOR), type).toBeNull();
    }
    const environment = { ...SAMPLE_EVENTS.takedown, killerId: NO_PLAYER };
    expect(localFeedbackSound(environment, SPECTATOR)).toBeNull();
  });
});
