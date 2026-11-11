/**
 * GameEvents: discrete things that happened in the match. The host sim emits them, net carries
 * them to clients on the reliable `ctrl` channel, and VFX, audio, UI and cinematics react.
 * Continuous state (positions, health) belongs in WorldView, not here.
 */

import type { StatusKind } from './abilities';
import type { AbilitySlot, DragonClassId } from './classes';
import type { PlayerId, TeamId } from './constants';
import { NO_PLAYER, TEAM_EMBER } from './constants';
import type { MatchPhase, MatchWinner } from './match';
import type { MutableVec3, Vec3 } from './math-types';
import { copyVec3, createVec3 } from './math-types';
import type { ProjectileKind } from './world-view';

/**
 * What dealt the damage. Ability damage is identified by its slot (the attacker's class gives
 * the ability), so the list starts with ABILITY_SLOTS in order; damage over time and zones count
 * as the slot that caused them. Index = `u8` wire value. Append only.
 */
export const DAMAGE_SOURCES = [
  'primary',
  'secondary',
  'utility',
  'ultimate',
  'terrain',
  'storm',
] as const satisfies readonly (AbilitySlot | 'terrain' | 'storm')[];

export type DamageSource = (typeof DAMAGE_SOURCES)[number];

export interface HitEvent {
  readonly type: 'hit';
  readonly tick: number;
  /** NO_PLAYER when the environment (terrain, storm wall) dealt the damage. */
  readonly attackerId: PlayerId;
  readonly targetId: PlayerId;
  readonly source: DamageSource;
  /** HP removed, after shields and immunity. */
  readonly damage: number;
  readonly position: Vec3;
}

export interface TakedownEvent {
  readonly type: 'takedown';
  readonly tick: number;
  /** NO_PLAYER when the environment got the takedown. */
  readonly killerId: PlayerId;
  readonly victimId: PlayerId;
  readonly source: DamageSource;
  readonly position: Vec3;
}

export interface SpawnEvent {
  readonly type: 'spawn';
  readonly tick: number;
  readonly dragonId: PlayerId;
  readonly team: TeamId;
  readonly classId: DragonClassId;
  readonly position: Vec3;
}

export interface AbilityCastEvent {
  readonly type: 'abilityCast';
  readonly tick: number;
  readonly dragonId: PlayerId;
  readonly classId: DragonClassId;
  readonly slot: AbilitySlot;
  readonly position: Vec3;
  /** Unit vector the ability was aimed along. */
  readonly direction: Vec3;
}

/**
 * TBD in T-6.x (Ember Relay, Sky Crown): the kinds will follow the objective modes.
 * Index = `u8` wire value. Append only.
 */
export const OBJECTIVE_KINDS = [
  'pickedUp',
  'dropped',
  'returned',
  'captured',
  'zoneTaken',
] as const;

export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export interface ObjectiveEvent {
  readonly type: 'objective';
  readonly tick: number;
  readonly kind: ObjectiveKind;
  /** Team the event is good for. */
  readonly team: TeamId;
  /** NO_PLAYER when no single dragon caused it. */
  readonly dragonId: PlayerId;
  readonly position: Vec3;
}

export interface MatchPhaseEvent {
  readonly type: 'matchPhase';
  readonly tick: number;
  readonly phase: MatchPhase;
  readonly round: number;
  /** Set when entering `roundEnd` or `results`, otherwise null. */
  readonly winner: MatchWinner | null;
}

/** Someone who hurt the victim shortly before a takedown. Follows its `takedown` event. */
export interface AssistEvent {
  readonly type: 'assist';
  readonly tick: number;
  readonly assisterId: PlayerId;
  /** NO_PLAYER when the environment got the takedown. */
  readonly killerId: PlayerId;
  readonly victimId: PlayerId;
}

/**
 * A timed effect landed on a dragon (not sent again while it is merely refreshed). Continuous
 * display belongs to the DRAGON_FLAG_* bits; this is the moment it starts.
 */
export interface StatusAppliedEvent {
  readonly type: 'statusApplied';
  readonly tick: number;
  readonly targetId: PlayerId;
  /** Who caused it; the target itself for its own buffs. */
  readonly sourceId: PlayerId;
  readonly status: StatusKind;
  readonly durationS: number;
  readonly position: Vec3;
}

/** A projectile ended against something: a blast, a mine arming, a bolt stopped by a dragon. */
export interface ImpactEvent {
  readonly type: 'impact';
  readonly tick: number;
  readonly projectile: ProjectileKind;
  readonly ownerId: PlayerId;
  /** The dragon it hit directly, or NO_PLAYER (terrain, end of flight). */
  readonly targetId: PlayerId;
  readonly position: Vec3;
}

export type GameEvent =
  | HitEvent
  | TakedownEvent
  | SpawnEvent
  | AbilityCastEvent
  | ObjectiveEvent
  | MatchPhaseEvent
  | AssistEvent
  | StatusAppliedEvent
  | ImpactEvent;

export type GameEventType = GameEvent['type'];
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;
export type GameEventHandler<T extends GameEventType> = (event: GameEventOf<T>) => void;
export type Unsubscribe = () => void;

/** What views see: subscribe only. */
export interface GameEventSource {
  /**
   * Handlers run during `flush()`. They must not keep the event object or its vectors: both
   * are pooled slots of the bus and are overwritten by later events. Copy what you need.
   */
  on<T extends GameEventType>(type: T, handler: GameEventHandler<T>): Unsubscribe;
}

/** What the sim (host) and net (client) see: emit only. */
export interface GameEventSink {
  /**
   * Queues a COPY of the event; nothing is delivered until `flush()`. The caller keeps ownership
   * of `event` and its vectors and may overwrite them as soon as `emit` returns, so the sim can
   * fill one scratch object per event type and emit it any number of times per tick.
   */
  emit(event: GameEvent): void;
}

export interface GameEventBus extends GameEventSource, GameEventSink {
  /**
   * Delivers queued events in emit order, then empties the queue. `src/game` calls it once per
   * rendered frame, so handlers never run in the middle of a sim tick. Events emitted by a
   * handler are delivered in the same flush.
   */
  flush(): void;
  /**
   * Drops queued events without delivering them (scene change). Called from a handler, the
   * current event still reaches its remaining handlers and later emits are delivered.
   */
  clear(): void;
  /**
   * Drops the queued events that are not of type `keep`; those stay queued, in order. For a
   * page whose frames stopped for a while (a hidden tab): the casts and hits of that time must
   * not all be shown at once, but the match phases still have to be heard. Not for handlers:
   * during a flush it does nothing.
   */
  dropExcept(keep: GameEventType): void;
  readonly pending: number;
}

type AnyHandler = (event: GameEvent) => void;

/** Writable twin of an event type, for the bus-owned slots. */
type EventSlot<E extends GameEvent> = {
  -readonly [K in keyof E]: E[K] extends Vec3 ? MutableVec3 : E[K];
};

/** Grow-only pool, same rules as WorldView: only the first `used` slots are live. */
interface SlotPool<S> {
  readonly slots: S[];
  used: number;
}

function createSlotPool<S>(): SlotPool<S> {
  return { slots: [], used: 0 };
}

/** Returns the next free slot, allocating only when the pool grows. */
function acquireSlot<S>(pool: SlotPool<S>, create: () => S): S {
  let slot = pool.slots[pool.used];
  if (slot === undefined) {
    slot = create();
    pool.slots.push(slot);
  }
  pool.used++;
  return slot;
}

function createHitSlot(): EventSlot<HitEvent> {
  return {
    type: 'hit',
    tick: 0,
    attackerId: NO_PLAYER,
    targetId: NO_PLAYER,
    source: 'primary',
    damage: 0,
    position: createVec3(),
  };
}

function createTakedownSlot(): EventSlot<TakedownEvent> {
  return {
    type: 'takedown',
    tick: 0,
    killerId: NO_PLAYER,
    victimId: NO_PLAYER,
    source: 'primary',
    position: createVec3(),
  };
}

function createSpawnSlot(): EventSlot<SpawnEvent> {
  return {
    type: 'spawn',
    tick: 0,
    dragonId: NO_PLAYER,
    team: TEAM_EMBER,
    classId: 'talon',
    position: createVec3(),
  };
}

function createAbilityCastSlot(): EventSlot<AbilityCastEvent> {
  return {
    type: 'abilityCast',
    tick: 0,
    dragonId: NO_PLAYER,
    classId: 'talon',
    slot: 'primary',
    position: createVec3(),
    direction: createVec3(),
  };
}

function createObjectiveSlot(): EventSlot<ObjectiveEvent> {
  return {
    type: 'objective',
    tick: 0,
    kind: 'pickedUp',
    team: TEAM_EMBER,
    dragonId: NO_PLAYER,
    position: createVec3(),
  };
}

function createMatchPhaseSlot(): EventSlot<MatchPhaseEvent> {
  return { type: 'matchPhase', tick: 0, phase: 'lobby', round: 1, winner: null };
}

function createAssistSlot(): EventSlot<AssistEvent> {
  return {
    type: 'assist',
    tick: 0,
    assisterId: NO_PLAYER,
    killerId: NO_PLAYER,
    victimId: NO_PLAYER,
  };
}

function createStatusAppliedSlot(): EventSlot<StatusAppliedEvent> {
  return {
    type: 'statusApplied',
    tick: 0,
    targetId: NO_PLAYER,
    sourceId: NO_PLAYER,
    status: 'slow',
    durationS: 0,
    position: createVec3(),
  };
}

function createImpactSlot(): EventSlot<ImpactEvent> {
  return {
    type: 'impact',
    tick: 0,
    projectile: 'fireBolt',
    ownerId: NO_PLAYER,
    targetId: NO_PLAYER,
    position: createVec3(),
  };
}

/**
 * The bus owns the storage: `emit` copies the event into a pooled slot of its type and `flush`
 * hands those slots to the handlers, then marks them all free. So emitting allocates only while
 * a pool grows to the busiest frame seen so far, and an emitter that reuses one scratch object
 * for several events before a flush cannot alias them. Subscribing and unsubscribing allocate
 * (copy-on-write, so doing either from inside a handler is safe), and those happen at scene
 * setup, not per frame.
 */
export function createGameEventBus(): GameEventBus {
  const handlers = new Map<GameEventType, readonly AnyHandler[]>();
  // Only the first `queued` entries are live. The array is never shortened: `length = 0` would
  // drop its backing store and every flush would then allocate a new one.
  const queue: GameEvent[] = [];
  let queued = 0;
  const hits = createSlotPool<EventSlot<HitEvent>>();
  const takedowns = createSlotPool<EventSlot<TakedownEvent>>();
  const spawns = createSlotPool<EventSlot<SpawnEvent>>();
  const abilityCasts = createSlotPool<EventSlot<AbilityCastEvent>>();
  const objectives = createSlotPool<EventSlot<ObjectiveEvent>>();
  const matchPhases = createSlotPool<EventSlot<MatchPhaseEvent>>();
  const assists = createSlotPool<EventSlot<AssistEvent>>();
  const statuses = createSlotPool<EventSlot<StatusAppliedEvent>>();
  const impacts = createSlotPool<EventSlot<ImpactEvent>>();
  let flushing = false;
  /** Index of the event `flush` is delivering. */
  let cursor = 0;

  function releaseSlots(): void {
    queued = 0;
    hits.used = 0;
    takedowns.used = 0;
    spawns.used = 0;
    abilityCasts.used = 0;
    objectives.used = 0;
    matchPhases.used = 0;
    assists.used = 0;
    statuses.used = 0;
    impacts.used = 0;
  }

  return {
    on<T extends GameEventType>(type: T, handler: GameEventHandler<T>): Unsubscribe {
      // Safe: flush only calls a handler stored under `type` with events of that type.
      const stored = handler as AnyHandler;
      handlers.set(type, [...(handlers.get(type) ?? []), stored]);
      return () => {
        const current = handlers.get(type);
        if (current === undefined) return;
        const index = current.indexOf(stored);
        if (index < 0) return;
        handlers.set(type, [...current.slice(0, index), ...current.slice(index + 1)]);
      };
    },

    emit(event: GameEvent): void {
      switch (event.type) {
        case 'hit': {
          const slot = acquireSlot(hits, createHitSlot);
          slot.tick = event.tick;
          slot.attackerId = event.attackerId;
          slot.targetId = event.targetId;
          slot.source = event.source;
          slot.damage = event.damage;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
        case 'takedown': {
          const slot = acquireSlot(takedowns, createTakedownSlot);
          slot.tick = event.tick;
          slot.killerId = event.killerId;
          slot.victimId = event.victimId;
          slot.source = event.source;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
        case 'spawn': {
          const slot = acquireSlot(spawns, createSpawnSlot);
          slot.tick = event.tick;
          slot.dragonId = event.dragonId;
          slot.team = event.team;
          slot.classId = event.classId;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
        case 'abilityCast': {
          const slot = acquireSlot(abilityCasts, createAbilityCastSlot);
          slot.tick = event.tick;
          slot.dragonId = event.dragonId;
          slot.classId = event.classId;
          slot.slot = event.slot;
          copyVec3(slot.position, event.position);
          copyVec3(slot.direction, event.direction);
          queue[queued++] = slot;
          break;
        }
        case 'objective': {
          const slot = acquireSlot(objectives, createObjectiveSlot);
          slot.tick = event.tick;
          slot.kind = event.kind;
          slot.team = event.team;
          slot.dragonId = event.dragonId;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
        case 'matchPhase': {
          const slot = acquireSlot(matchPhases, createMatchPhaseSlot);
          slot.tick = event.tick;
          slot.phase = event.phase;
          slot.round = event.round;
          slot.winner = event.winner;
          queue[queued++] = slot;
          break;
        }
        case 'assist': {
          const slot = acquireSlot(assists, createAssistSlot);
          slot.tick = event.tick;
          slot.assisterId = event.assisterId;
          slot.killerId = event.killerId;
          slot.victimId = event.victimId;
          queue[queued++] = slot;
          break;
        }
        case 'statusApplied': {
          const slot = acquireSlot(statuses, createStatusAppliedSlot);
          slot.tick = event.tick;
          slot.targetId = event.targetId;
          slot.sourceId = event.sourceId;
          slot.status = event.status;
          slot.durationS = event.durationS;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
        case 'impact': {
          const slot = acquireSlot(impacts, createImpactSlot);
          slot.tick = event.tick;
          slot.projectile = event.projectile;
          slot.ownerId = event.ownerId;
          slot.targetId = event.targetId;
          copyVec3(slot.position, event.position);
          queue[queued++] = slot;
          break;
        }
      }
    },

    flush(): void {
      // A handler calling flush() would re-deliver the events still being walked.
      if (flushing) return;
      flushing = true;
      try {
        // `queued` is re-read each step so events emitted by handlers are delivered too.
        for (cursor = 0; cursor < queued; cursor++) {
          const event = queue[cursor];
          if (event === undefined) continue;
          const list = handlers.get(event.type);
          if (list === undefined) continue;
          for (let h = 0; h < list.length; h++) list[h]?.(event);
        }
      } finally {
        releaseSlots();
        flushing = false;
      }
    },

    clear(): void {
      if (!flushing) {
        releaseSlots();
        return;
      }
      // From a handler: the slots stay taken until the flush ends, because the event being
      // delivered is one of them and a later emit must not overwrite it. The flush goes on with
      // whatever is emitted from here on.
      queued = 0;
      cursor = -1;
    },

    dropExcept(keep: GameEventType): void {
      if (flushing) return;
      let kept = 0;
      for (let i = 0; i < queued; i++) {
        const event = queue[i];
        if (event !== undefined && event.type === keep) queue[kept++] = event;
      }
      queued = kept;
      // The kept events still live in their pool's slots; every other pool is free again.
      if (keep !== 'hit') hits.used = 0;
      if (keep !== 'takedown') takedowns.used = 0;
      if (keep !== 'spawn') spawns.used = 0;
      if (keep !== 'abilityCast') abilityCasts.used = 0;
      if (keep !== 'objective') objectives.used = 0;
      if (keep !== 'matchPhase') matchPhases.used = 0;
      if (keep !== 'assist') assists.used = 0;
      if (keep !== 'statusApplied') statuses.used = 0;
      if (keep !== 'impact') impacts.used = 0;
    },

    get pending(): number {
      return queued;
    },
  };
}
