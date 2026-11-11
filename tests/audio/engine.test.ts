/**
 * The engine against a fake AudioContext (node has no WebAudio): what gets started, on which
 * bus, how many nodes exist, and that nothing ever throws into the caller.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ABILITY_SOUNDS,
  MAX_VOICES,
  RENDER_SAMPLE_RATE,
  SOUND_COUNT,
  SOUND_DEFS,
  SOUND_IDS,
  createAudio,
  renderSound,
  soundLength,
} from '../../src/audio';
import type { AudioEngine, AudioListener, SoundId } from '../../src/audio';
import {
  ABILITY_SLOTS,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_SHIELDED,
  MATCH_TUNING,
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  acquireZoneView,
  beginWorldView,
  createGameEventBus,
  createWorldView,
} from '../../src/shared';
import type {
  AbilityCastEvent,
  AbilitySlot,
  DragonClassId,
  GameEvent,
  MatchPhase,
  MutableDragonView,
  MutableWorldView,
} from '../../src/shared';

/** Identifies a rendered buffer by its samples (several sounds share a length). */
function signatureOf(data: Float32Array): string {
  let sum = 0;
  for (let i = 0; i < data.length; i += 5) sum += (data[i] ?? 0) * (1 + (i % 11));
  return `${data.length}:${sum.toFixed(5)}`;
}

const SIGNATURES = new Map<string, SoundId>(
  SOUND_IDS.map((id) => [signatureOf(renderSound(id)), id]),
);

// --- Fake WebAudio -------------------------------------------------------------------------------

class FakeParam {
  value: number;
  targets = 0;
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number): this {
    this.value = value;
    return this;
  }
  setTargetAtTime(value: number): this {
    this.value = value;
    this.targets++;
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

class FakeNode {
  readonly kind: string;
  outputs: unknown[] = [];
  constructor(kind: string) {
    this.kind = kind;
  }
  connect(target: unknown): unknown {
    this.outputs.push(target);
    return target;
  }
  disconnect(): void {
    this.outputs = [];
  }
}

class FakeGain extends FakeNode {
  readonly gain = new FakeParam(1);
}

class FakeFilter extends FakeNode {
  type = 'lowpass';
  readonly frequency = new FakeParam(350);
  readonly Q = new FakeParam(1);
  readonly detune = new FakeParam(0);
}

class FakePanner extends FakeNode {
  readonly pan = new FakeParam(0);
}

class FakeCompressor extends FakeNode {
  readonly threshold = new FakeParam();
  readonly knee = new FakeParam();
  readonly ratio = new FakeParam();
  readonly attack = new FakeParam();
  readonly release = new FakeParam();
}

class FakeOscillator extends FakeNode {
  type = 'sine';
  readonly frequency = new FakeParam(440);
  started = false;
  stopped = false;
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

interface FakeBuffer {
  readonly length: number;
  readonly sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  readonly playbackRate = new FakeParam(1);
  onended: ((event: { target: unknown }) => void) | null = null;
  started = false;
  stopped = false;
  stopAt: number | undefined;
  constructor() {
    super('source');
  }
  start(): void {
    this.started = true;
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stopAt = when;
  }
  /** What the browser does when the buffer runs out (or a scheduled stop is reached). */
  finish(): void {
    this.onended?.({ target: this });
  }
}

class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly destination = new FakeNode('destination');
  readonly sources: FakeSource[] = [];
  readonly oscillators: FakeOscillator[] = [];
  readonly created: Record<string, number> = {};
  failSources = false;

  private count(kind: string): void {
    this.created[kind] = (this.created[kind] ?? 0) + 1;
  }
  /** Nodes that are not per-sound sources. */
  get fixedNodes(): number {
    let total = 0;
    for (const [kind, count] of Object.entries(this.created)) {
      if (kind !== 'source') total += count;
    }
    return total;
  }
  createGain(): FakeGain {
    this.count('gain');
    return new FakeGain('gain');
  }
  createBiquadFilter(): FakeFilter {
    this.count('filter');
    return new FakeFilter('filter');
  }
  createStereoPanner(): FakePanner {
    this.count('panner');
    return new FakePanner('panner');
  }
  createDynamicsCompressor(): FakeCompressor {
    this.count('compressor');
    return new FakeCompressor('compressor');
  }
  createOscillator(): FakeOscillator {
    this.count('oscillator');
    const oscillator = new FakeOscillator('oscillator');
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    if (this.failSources) throw new Error('no more sources');
    this.count('source');
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Sources started and not yet stopped or finished. */
  playing(): FakeSource[] {
    return this.sources.filter((source) => source.started && source.onended !== null);
  }
  soundOf(source: FakeSource): SoundId | undefined {
    return source.buffer === null
      ? undefined
      : SIGNATURES.get(signatureOf(source.buffer.getChannelData(0)));
  }
  startedSounds(from = 0): (SoundId | undefined)[] {
    return this.sources.slice(from).map((source) => this.soundOf(source));
  }
}

// --- Helpers -------------------------------------------------------------------------------------

const CAMERA: AudioListener = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: 1 },
  up: { x: 0, y: 1, z: 0 },
};
const NEAR = { x: 0, y: 0, z: 20 };
const FORWARD = { x: 0, y: 0, z: 1 };
const LOCAL_ID = 3;

interface Rig {
  readonly audio: AudioEngine;
  readonly ctx: FakeContext;
}

const engines: AudioEngine[] = [];

function createRig(quality: 'low' | 'medium' | 'high' = 'medium'): Rig {
  const ctx = new FakeContext();
  const audio = createAudio({
    quality,
    prerender: 'now',
    createContext: () => ctx as unknown as AudioContext,
  });
  engines.push(audio);
  audio.unlock();
  audio.setScene('match');
  return { audio, ctx };
}

function addDragon(
  view: MutableWorldView,
  id: number,
  classId: DragonClassId,
  flags: number,
  x = 0,
  z = 20,
): MutableDragonView {
  const dragon = acquireDragonView(view);
  dragon.id = id;
  dragon.team = id === LOCAL_ID ? TEAM_EMBER : TEAM_FROST;
  dragon.classId = classId;
  dragon.position.x = x;
  dragon.position.y = 0;
  dragon.position.z = z;
  dragon.velocity.x = 0;
  dragon.velocity.y = 0;
  dragon.velocity.z = 60;
  dragon.orientation.x = 0;
  dragon.orientation.y = 0;
  dragon.orientation.z = 0;
  dragon.orientation.w = 1;
  dragon.health = 1;
  dragon.stamina = 1;
  dragon.flags = flags;
  dragon.anim = DRAGON_ANIM_GLIDE;
  return dragon;
}

function matchView(phase: MatchPhase = 'playing'): MutableWorldView {
  const view = createWorldView();
  beginWorldView(view);
  view.localDragonId = LOCAL_ID;
  view.clock.phase = phase;
  return view;
}

/** Runs frames at 60 fps; `build` refills the view each frame. */
function runFrames(rig: Rig, view: MutableWorldView, frames: number, build?: () => void): void {
  for (let i = 0; i < frames; i++) {
    build?.();
    rig.ctx.currentTime += 1 / 60;
    rig.audio.update(view, CAMERA, 1 / 60);
  }
}

function cast(classId: DragonClassId, slot: AbilitySlot, id = 7): AbilityCastEvent {
  return {
    type: 'abilityCast',
    tick: 1,
    dragonId: id,
    classId,
    slot,
    position: NEAR,
    direction: FORWARD,
  };
}

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
  vi.restoreAllMocks();
});

// --- Tests ---------------------------------------------------------------------------------------

describe('without WebAudio', () => {
  it('is a stub that accepts every call', () => {
    expect((globalThis as { AudioContext?: unknown }).AudioContext).toBeUndefined();
    const audio = createAudio();
    const view = matchView();
    addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE);
    audio.unlock();
    audio.setScene('match');
    audio.setQuality('high');
    audio.setVolumes({ master: 0.5 });
    audio.update(view, CAMERA, 1 / 60);
    audio.onEvent(cast('talon', 'primary'));
    audio.playLocalCast('talon', 'primary');
    audio.playUi('click');
    const off = audio.connect(createGameEventBus());
    off();
    expect(audio.stats()).toMatchObject({ activeVoices: 0, stolen: 0, ready: false, errors: 0 });
    audio.dispose();
  });

  it('stays silent when the context cannot be made', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = createAudio({ prerender: 'now', createContext: () => null });
    const throwing = createAudio({
      prerender: 'now',
      createContext: () => {
        throw new Error('blocked');
      },
    });
    engines.push(refused, throwing);
    for (const audio of [refused, throwing]) {
      audio.unlock();
      audio.unlock();
      audio.playUi('click');
      audio.onEvent(cast('talon', 'primary'));
      audio.update(matchView(), CAMERA, 1 / 60);
      expect(audio.stats().activeVoices).toBe(0);
      expect(audio.stats().ready).toBe(false);
    }
    expect(refused.stats().errors).toBe(0);
    expect(throwing.stats().errors).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('init', () => {
  it('renders every placeholder and reports the cost', () => {
    const { audio } = createRig();
    const stats = audio.stats();
    expect(stats.soundsReady).toBe(SOUND_COUNT);
    expect(stats.initMs).toBeGreaterThan(0);
    expect(stats.ready).toBe(true);
    expect(stats.capacity).toBe(QUALITY_PRESETS.medium.audioVoices);
  });

  it('renders in slices from a timer by default and plays nothing before a sound is ready', () => {
    vi.useFakeTimers();
    try {
      const ctx = new FakeContext();
      const audio = createAudio({ createContext: () => ctx as unknown as AudioContext });
      engines.push(audio);
      audio.unlock();
      expect(audio.stats().soundsReady).toBe(0);
      audio.playUi('click');
      expect(ctx.sources.length).toBe(0);
      vi.advanceTimersByTime(16 * SOUND_COUNT + 100);
      expect(audio.stats().soundsReady).toBe(SOUND_COUNT);
      audio.playUi('click');
      expect(ctx.sources.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates no context before the first gesture', () => {
    let made = 0;
    const ctx = new FakeContext();
    const audio = createAudio({
      prerender: 'now',
      createContext: () => {
        made++;
        return ctx as unknown as AudioContext;
      },
    });
    engines.push(audio);
    audio.playUi('click');
    audio.onEvent(cast('talon', 'primary'));
    audio.update(matchView(), CAMERA, 1 / 60);
    expect(made).toBe(0);
    audio.unlock();
    audio.unlock();
    expect(made).toBe(1);
    audio.playUi('click');
    expect(ctx.sources.length).toBe(1);
  });

  it('resumes a suspended context on unlock', () => {
    const ctx = new FakeContext();
    ctx.state = 'suspended';
    const audio = createAudio({
      prerender: 'now',
      createContext: () => ctx as unknown as AudioContext,
    });
    engines.push(audio);
    audio.unlock();
    expect(ctx.state).toBe('running');
  });

  it('uploads buffers at the render rate with the rendered length', () => {
    const { audio, ctx } = createRig();
    audio.playUi('ready');
    const source = ctx.sources[0];
    expect(source?.buffer?.sampleRate).toBe(RENDER_SAMPLE_RATE);
    expect(source?.buffer?.length).toBe(soundLength('uiReady'));
    expect(ctx.soundOf(source as FakeSource)).toBe('uiReady');
  });
});

describe('playback', () => {
  it('builds the voice chains once: sources are the only per-sound nodes', () => {
    const { audio, ctx } = createRig();
    const fixed = ctx.fixedNodes;
    // 3 nodes per voice + limiter, mute, master, 3 buses, music bus + the pad (7).
    expect(fixed).toBe(MAX_VOICES * 3 + 7 + 7);
    for (let i = 0; i < 400; i++) {
      ctx.currentTime += 0.11;
      audio.playUi(i % 2 === 0 ? 'click' : 'hover');
      audio.onEvent(cast('talon', 'primary'));
      audio.onEvent(cast('tempest', 'ultimate'));
      for (const source of ctx.playing()) if (i % 3 === 0) source.finish();
    }
    expect(ctx.sources.length).toBeGreaterThan(400);
    expect(ctx.fixedNodes).toBe(fixed);
  });

  it('plays and frees a UI sound on the ui bus, unpanned and unfiltered', () => {
    const { audio, ctx } = createRig();
    audio.playUi('click');
    expect(audio.stats().activeVoices).toBe(1);
    const source = ctx.sources[0] as FakeSource;
    expect(source.started).toBe(true);
    expect(source.loop).toBe(false);
    const filter = source.outputs[0] as FakeFilter;
    const gain = filter.outputs[0] as FakeGain;
    const panner = gain.outputs[0] as FakePanner;
    expect(filter.frequency.value).toBeGreaterThan(15_000);
    expect(gain.gain.value).toBeCloseTo(SOUND_DEFS.uiClick.gain, 5);
    expect(panner.pan.value).toBe(0);
    expect(panner.outputs.length).toBe(1);
    source.finish();
    expect(audio.stats().activeVoices).toBe(0);
    expect(source.outputs.length).toBe(0);
  });

  it('ignores an unknown UI id', () => {
    const { audio, ctx } = createRig();
    audio.playUi('nope' as never);
    expect(ctx.sources.length).toBe(0);
    expect(audio.stats().errors).toBe(0);
  });

  it('plays the table sound for every ability cast', () => {
    for (const classId of DRAGON_CLASS_IDS) {
      for (const slot of ABILITY_SLOTS) {
        const { audio, ctx } = createRig();
        audio.onEvent(cast(classId, slot));
        expect(ctx.startedSounds(), `${classId}.${slot}`).toEqual([ABILITY_SOUNDS[classId][slot]]);
      }
    }
  });

  it('places world sounds: pan, distance gain and low-pass', () => {
    const { audio, ctx } = createRig();
    audio.update(matchView(), CAMERA, 1 / 60);
    // The camera looks down +Z with +Y up, so -X is to its right.
    audio.onEvent({ ...cast('talon', 'secondary'), position: { x: -150, y: 0, z: 0 } });
    audio.onEvent({ ...cast('bastion', 'secondary'), position: { x: 150, y: 0, z: 0 } });
    const [right, left] = ctx.sources as [FakeSource, FakeSource];
    const chain = (source: FakeSource): [FakeFilter, FakeGain, FakePanner] => {
      const filter = source.outputs[0] as FakeFilter;
      const gain = filter.outputs[0] as FakeGain;
      return [filter, gain, gain.outputs[0] as FakePanner];
    };
    const [rightFilter, rightGain, rightPan] = chain(right);
    const [, , leftPan] = chain(left);
    expect(rightPan.pan.value).toBeGreaterThan(0.5);
    expect(leftPan.pan.value).toBeLessThan(-0.5);
    expect(rightGain.gain.value).toBeLessThan(SOUND_DEFS.dashWhoosh.gain * 0.6);
    expect(rightGain.gain.value).toBeGreaterThan(0);
    expect(rightFilter.frequency.value).toBeLessThan(15_000);
  });

  it('does not start a sound out of earshot', () => {
    const { audio, ctx } = createRig();
    audio.onEvent({ ...cast('talon', 'primary'), position: { x: 0, y: 0, z: 5000 } });
    expect(ctx.sources.length).toBe(0);
    expect(audio.stats().refused).toBe(0);
  });

  it('rapid fire is limited by the retrigger gap and the instance cap', () => {
    const { audio, ctx } = createRig();
    for (let i = 0; i < 50; i++) audio.onEvent(cast('talon', 'primary', 10 + (i % 10)));
    expect(ctx.sources.length).toBe(1);
    // 2 s of ten Talons firing every frame.
    for (let i = 0; i < 120; i++) {
      ctx.currentTime += 1 / 60;
      for (let shooter = 0; shooter < 10; shooter++) {
        audio.onEvent(cast('talon', 'primary', 10 + shooter));
      }
      expect(audio.stats().activeVoices).toBeLessThanOrEqual(SOUND_DEFS.fireBolt.maxInstances);
    }
    expect(ctx.sources.length).toBeLessThanOrEqual(2 / SOUND_DEFS.fireBolt.minRetriggerS + 2);
    expect(audio.stats().refused).toBeGreaterThan(1000);
  });

  it('never plays more voices than the preset allows, and shrinks with it', () => {
    const { audio, ctx } = createRig('low');
    const cap = QUALITY_PRESETS.low.audioVoices;
    const spam = (): void => {
      for (let i = 0; i < 300; i++) {
        ctx.currentTime += 0.021;
        const classId = DRAGON_CLASS_IDS[i % 4] ?? 'talon';
        const slot = ABILITY_SLOTS[(i >> 2) % 4] ?? 'primary';
        audio.onEvent(cast(classId, slot));
        audio.onEvent({
          type: 'takedown',
          tick: 1,
          killerId: 9,
          victimId: 8,
          source: 'primary',
          position: NEAR,
        });
        audio.onEvent({
          type: 'hit',
          tick: 1,
          attackerId: 9,
          targetId: 8,
          source: i % 2 === 0 ? 'terrain' : 'storm',
          damage: 20,
          position: NEAR,
        });
        audio.playUi('click');
        expect(audio.stats().activeVoices).toBeLessThanOrEqual(audio.stats().capacity);
        expect(ctx.playing().length).toBe(audio.stats().activeVoices);
      }
    };
    spam();
    expect(audio.stats().capacity).toBe(cap);
    expect(audio.stats().activeVoices).toBe(cap);
    expect(audio.stats().stolen).toBeGreaterThan(0);

    audio.setQuality('high');
    spam();
    expect(audio.stats().activeVoices).toBeGreaterThan(cap);
    audio.setQuality(QUALITY_PRESETS.low);
    expect(audio.stats().activeVoices).toBeLessThanOrEqual(cap);
    expect(ctx.playing().length).toBe(audio.stats().activeVoices);
  });

  it('a stolen voice stops its old source and cannot be freed by it later', () => {
    const { audio, ctx } = createRig();
    for (let i = 0; i < SOUND_DEFS.uiClick.maxInstances + 1; i++) {
      ctx.currentTime += 0.05;
      audio.playUi('click');
    }
    const first = ctx.sources[0] as FakeSource;
    expect(first.stopped).toBe(true);
    expect(first.onended).toBeNull();
    expect(audio.stats().activeVoices).toBe(SOUND_DEFS.uiClick.maxInstances);
    expect(audio.stats().stolen).toBe(1);
  });
});

describe('events', () => {
  it('a hit is scaled by damage, and the local attacker hears a confirm', () => {
    const { audio, ctx } = createRig();
    const view = matchView();
    addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5);
    addDragon(view, 8, 'bastion', DRAGON_FLAG_ALIVE);
    audio.update(view, CAMERA, 1 / 60);
    const before = ctx.sources.length;
    audio.onEvent({
      type: 'hit',
      tick: 1,
      attackerId: LOCAL_ID,
      targetId: 8,
      source: 'primary',
      damage: 9,
      position: NEAR,
    });
    expect(ctx.startedSounds(before)).toEqual(['hitFlesh', 'hitConfirm']);
    ctx.currentTime += 1;
    const next = ctx.sources.length;
    audio.onEvent({
      type: 'hit',
      tick: 1,
      attackerId: 8,
      targetId: 9,
      source: 'terrain',
      damage: 40,
      position: NEAR,
    });
    expect(ctx.startedSounds(next)).toEqual(['hitRock']);
    const gainOf = (source: FakeSource): number =>
      ((source.outputs[0] as FakeFilter).outputs[0] as FakeGain).gain.value;
    const soft = gainOf(ctx.sources[before] as FakeSource) / SOUND_DEFS.hitFlesh.gain;
    const hard = gainOf(ctx.sources[next] as FakeSource) / SOUND_DEFS.hitRock.gain;
    expect(hard).toBeGreaterThan(soft * 2);
  });

  it('a hit on a shielded dragon rings the shield', () => {
    const { audio, ctx } = createRig();
    const view = matchView();
    addDragon(view, 8, 'bastion', DRAGON_FLAG_ALIVE | DRAGON_FLAG_SHIELDED);
    audio.update(view, CAMERA, 1 / 60);
    const before = ctx.sources.length;
    audio.onEvent({
      type: 'hit',
      tick: 1,
      attackerId: 9,
      targetId: 8,
      source: 'primary',
      damage: 9,
      position: NEAR,
    });
    expect(ctx.startedSounds(before)).toEqual(['hitShield']);
  });

  it('takedown, spawn, status, impact, objective and phases each make their sound', () => {
    const { audio, ctx } = createRig();
    const view = matchView();
    addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5);
    audio.update(view, CAMERA, 1 / 60);
    const before = ctx.sources.length;
    const events: GameEvent[] = [
      {
        type: 'takedown',
        tick: 1,
        killerId: LOCAL_ID,
        victimId: 8,
        source: 'primary',
        position: NEAR,
      },
      { type: 'assist', tick: 1, assisterId: LOCAL_ID, killerId: 9, victimId: 8 },
      { type: 'assist', tick: 1, assisterId: 6, killerId: 9, victimId: 8 },
      { type: 'spawn', tick: 1, dragonId: 8, team: TEAM_FROST, classId: 'wraith', position: NEAR },
      {
        type: 'statusApplied',
        tick: 1,
        targetId: 8,
        sourceId: 9,
        status: 'slow',
        durationS: 1,
        position: NEAR,
      },
      {
        type: 'statusApplied',
        tick: 1,
        targetId: 8,
        sourceId: 8,
        status: 'veil',
        durationS: 5,
        position: NEAR,
      },
      {
        type: 'impact',
        tick: 1,
        projectile: 'meteorBomb',
        ownerId: 9,
        targetId: 255,
        position: NEAR,
      },
      {
        type: 'impact',
        tick: 1,
        projectile: 'staticMine',
        ownerId: 9,
        targetId: 255,
        position: NEAR,
      },
      {
        type: 'objective',
        tick: 1,
        kind: 'captured',
        team: TEAM_EMBER,
        dragonId: LOCAL_ID,
        position: { x: 0, y: 0, z: 9000 },
      },
      { type: 'matchPhase', tick: 1, phase: 'playing', round: 1, winner: null },
      { type: 'matchPhase', tick: 1, phase: 'results', round: 1, winner: TEAM_EMBER },
    ];
    for (const event of events) {
      ctx.currentTime += 3;
      audio.onEvent(event);
    }
    expect(ctx.startedSounds(before)).toEqual([
      'takedownBoom',
      'takedownConfirm',
      'assist',
      'spawnChime',
      'slowZap',
      'blast',
      'mineArm',
      // On the ui bus: heard wherever it happened.
      'objective',
      'countdownGo',
      'victory',
    ]);
    expect(audio.stats().errors).toBe(0);
  });

  it('results sound as defeat to the losing side', () => {
    const { audio, ctx } = createRig();
    const view = matchView();
    addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5);
    audio.update(view, CAMERA, 1 / 60);
    const before = ctx.sources.length;
    audio.onEvent({ type: 'matchPhase', tick: 1, phase: 'results', round: 1, winner: TEAM_FROST });
    expect(ctx.startedSounds(before)).toEqual(['defeat']);
  });

  it('connect subscribes to the bus and the returned function unsubscribes', () => {
    const { audio, ctx } = createRig();
    const bus = createGameEventBus();
    const off = audio.connect(bus);
    bus.emit(cast('tempest', 'utility'));
    bus.emit({ type: 'matchPhase', tick: 1, phase: 'playing', round: 1, winner: null });
    bus.flush();
    expect(ctx.startedSounds()).toEqual(['updraft', 'countdownGo']);
    off();
    ctx.currentTime += 5;
    bus.emit(cast('tempest', 'utility'));
    bus.flush();
    expect(ctx.sources.length).toBe(2);
  });

  it('a predicted local cast plays at once and swallows its echo once', () => {
    const { audio, ctx } = createRig();
    const view = matchView();
    addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5);
    audio.update(view, CAMERA, 1 / 60);
    const before = ctx.sources.length;
    audio.playLocalCast('talon', 'secondary');
    expect(ctx.startedSounds(before)).toEqual(['dashWhoosh']);
    ctx.currentTime += 0.08;
    audio.onEvent(cast('talon', 'secondary', LOCAL_ID));
    expect(ctx.sources.length).toBe(before + 1);
    // Someone else's dash is not swallowed, and neither is a second echo.
    ctx.currentTime += 0.2;
    audio.onEvent(cast('talon', 'secondary', 8));
    ctx.currentTime += 0.2;
    audio.onEvent(cast('talon', 'secondary', LOCAL_ID));
    expect(ctx.sources.length).toBe(before + 3);
    // A prediction whose echo never came is forgotten.
    ctx.currentTime += 0.2;
    audio.playLocalCast('talon', 'utility');
    ctx.currentTime += 5;
    audio.onEvent(cast('talon', 'utility', LOCAL_ID));
    expect(ctx.startedSounds(before + 3)).toEqual(['afterburn', 'afterburn']);
  });
});

describe('world-driven sounds', () => {
  it('runs the wind loop with speed, and the boost loop while boosting', () => {
    const rig = createRig();
    const { audio, ctx } = rig;
    const view = matchView();
    let flags = DRAGON_FLAG_ALIVE;
    let speed = 30;
    const build = (): void => {
      beginWorldView(view);
      addDragon(view, LOCAL_ID, 'talon', flags, 0, 5).velocity.z = speed;
    };
    runFrames(rig, view, 10, build);
    expect(ctx.startedSounds()).toEqual(['windLoop']);
    const wind = ctx.sources[0] as FakeSource;
    expect(wind.loop).toBe(true);
    const windGain = (wind.outputs[0] as FakeFilter).outputs[0] as FakeGain;
    const slowGain = windGain.gain.value;
    const slowRate = wind.playbackRate.value;

    speed = 95;
    flags |= DRAGON_FLAG_BOOSTING;
    runFrames(rig, view, 10, build);
    expect(windGain.gain.value).toBeGreaterThan(slowGain * 1.5);
    expect(wind.playbackRate.value).toBeGreaterThan(slowRate * 1.3);
    expect(ctx.startedSounds()).toEqual(['windLoop', 'boostLoop']);
    const boost = ctx.sources[1] as FakeSource;
    expect(audio.stats().activeVoices).toBe(2);

    flags = DRAGON_FLAG_ALIVE;
    runFrames(rig, view, 10, build);
    // Faded out, then stopped a moment later.
    expect(boost.stopped).toBe(true);
    expect(boost.stopAt).toBeGreaterThan(ctx.currentTime - 1);
    boost.finish();
    expect(audio.stats().activeVoices).toBe(1);

    audio.setScene('lobby');
    expect(wind.stopped).toBe(true);
    wind.finish();
    expect(audio.stats().activeVoices).toBe(0);
  });

  it('moves parameters at most 20 times a second', () => {
    const rig = createRig();
    const view = matchView();
    const build = (): void => {
      beginWorldView(view);
      addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5);
    };
    runFrames(rig, view, 6, build);
    const wind = rig.ctx.sources[0] as FakeSource;
    const gain = (wind.outputs[0] as FakeFilter).outputs[0] as FakeGain;
    const before = gain.gain.targets;
    runFrames(rig, view, 120, build);
    const moves = gain.gain.targets - before;
    expect(moves).toBeGreaterThanOrEqual(38);
    expect(moves).toBeLessThanOrEqual(41);
  });

  it('a held breath loops on its dragon, follows it, and stops with the flag', () => {
    const rig = createRig();
    const { audio, ctx } = rig;
    const view = matchView();
    let flags = DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING;
    let x = -100;
    const build = (): void => {
      beginWorldView(view);
      addDragon(view, 8, 'bastion', flags, x, 0);
    };
    runFrames(rig, view, 6, build);
    expect(ctx.startedSounds()).toEqual(['flameLoop']);
    const loop = ctx.sources[0] as FakeSource;
    const panner = ((loop.outputs[0] as FakeFilter).outputs[0] as FakeGain)
      .outputs[0] as FakePanner;
    expect(panner.pan.value).toBeGreaterThan(0.5);
    x = 100;
    runFrames(rig, view, 6, build);
    expect(panner.pan.value).toBeLessThan(-0.5);
    // Still one loop after many frames.
    runFrames(rig, view, 60, build);
    expect(ctx.sources.length).toBe(1);

    flags = DRAGON_FLAG_ALIVE;
    runFrames(rig, view, 2, build);
    expect(loop.stopped).toBe(true);
    loop.finish();
    expect(audio.stats().activeVoices).toBe(0);
  });

  it('a breathing dragon that leaves the view takes its loop along', () => {
    const rig = createRig();
    const view = matchView();
    let present = true;
    const build = (): void => {
      beginWorldView(view);
      if (present) addDragon(view, 8, 'wraith', DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING);
    };
    runFrames(rig, view, 6, build);
    expect(rig.ctx.startedSounds()).toEqual(['shadeLoop']);
    present = false;
    runFrames(rig, view, 2, build);
    expect((rig.ctx.sources[0] as FakeSource).stopped).toBe(true);
  });

  it('per-shot primaries have no loop', () => {
    const rig = createRig();
    const view = matchView();
    runFrames(rig, view, 30, () => {
      beginWorldView(view);
      addDragon(view, 8, 'talon', DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING);
      addDragon(view, 9, 'tempest', DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING);
    });
    expect(rig.ctx.sources.length).toBe(0);
  });

  it('plays the charge sound once when a wind-up starts', () => {
    const rig = createRig();
    const view = matchView();
    let flags = DRAGON_FLAG_ALIVE;
    const build = (): void => {
      beginWorldView(view);
      addDragon(view, 8, 'tempest', flags);
    };
    runFrames(rig, view, 3, build);
    flags |= DRAGON_FLAG_CHARGING;
    runFrames(rig, view, 20, build);
    flags = DRAGON_FLAG_ALIVE;
    runFrames(rig, view, 20, build);
    expect(rig.ctx.startedSounds()).toEqual(['lightningCharge']);
  });

  it('flaps at a throttled rate while a dragon is in a flapping animation', () => {
    const rig = createRig();
    const view = matchView();
    let anim = DRAGON_ANIM_GLIDE;
    const build = (): void => {
      beginWorldView(view);
      addDragon(view, 8, 'talon', DRAGON_FLAG_ALIVE).anim = anim;
    };
    runFrames(rig, view, 30, build);
    expect(rig.ctx.sources.length).toBe(0);
    anim = DRAGON_ANIM_FLAP;
    runFrames(rig, view, 180, build);
    const flaps = rig.ctx.startedSounds().filter((id) => id === 'flap').length;
    expect(flaps).toBe(rig.ctx.sources.length);
    expect(flaps).toBeGreaterThanOrEqual(4);
    expect(flaps).toBeLessThanOrEqual(6);
  });

  it('ticks once per countdown second', () => {
    const rig = createRig();
    const view = matchView('countdown');
    let t = 0;
    const frames = Math.round((MATCH_TUNING.countdownS + 0.5) * 60);
    runFrames(rig, view, frames, () => {
      view.clock.phase = t < MATCH_TUNING.countdownS ? 'countdown' : 'playing';
      view.clock.phaseTimeS = t < MATCH_TUNING.countdownS ? t : t - MATCH_TUNING.countdownS;
      t += 1 / 60;
    });
    const ticks = rig.ctx.startedSounds().filter((id) => id === 'countdownTick').length;
    expect(ticks).toBe(Math.ceil(MATCH_TUNING.countdownS));
  });

  it('beats faster as the local rider gets weaker, and not at all when healthy', () => {
    const count = (health: number): number => {
      const rig = createRig();
      const view = matchView();
      runFrames(rig, view, 300, () => {
        beginWorldView(view);
        addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, 0, 5).health = health;
      });
      return rig.ctx.startedSounds().filter((id) => id === 'heartbeat').length;
    };
    expect(count(1)).toBe(0);
    const weak = count(0.28);
    const dying = count(0.03);
    expect(weak).toBeGreaterThanOrEqual(5);
    expect(dying).toBeGreaterThan(weak);
  });

  it('crackles near the storm wall and not in the middle of the arena', () => {
    const storm = (x: number): boolean => {
      const rig = createRig();
      const view = matchView();
      runFrames(rig, view, 10, () => {
        beginWorldView(view);
        addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE, x, 0);
        const zone = acquireZoneView(view);
        zone.kind = 'stormWall';
        zone.team = null;
        zone.radius = 900;
        zone.position.x = 0;
        zone.position.y = 0;
        zone.position.z = 0;
      });
      return rig.ctx.startedSounds().includes('stormLoop');
    };
    expect(storm(0)).toBe(false);
    expect(storm(600)).toBe(false);
    expect(storm(820)).toBe(true);
    expect(storm(950)).toBe(true);
  });
});

describe('mix', () => {
  it('applies the volume sliders to master and buses', () => {
    const { audio, ctx } = createRig();
    audio.playUi('click');
    const source = ctx.sources[0] as FakeSource;
    const panner = ((source.outputs[0] as FakeFilter).outputs[0] as FakeGain)
      .outputs[0] as FakePanner;
    const uiBus = panner.outputs[0] as FakeGain;
    const master = uiBus.outputs[0] as FakeGain;
    expect(uiBus.gain.value).toBe(1);
    audio.setVolumes({ ui: 0.5, master: 0.8 });
    expect(uiBus.gain.value).toBeCloseTo(0.25, 6);
    expect(master.gain.value).toBeCloseTo(0.64, 6);
    // Out-of-range and broken values are clamped or ignored.
    audio.setVolumes({ ui: 7, master: NaN });
    expect(uiBus.gain.value).toBe(1);
    expect(master.gain.value).toBeCloseTo(0.64, 6);
    audio.setVolumes({ master: -1 });
    expect(master.gain.value).toBe(0);
  });

  it('routes master through the mute gain and the limiter to the speakers', () => {
    const { audio, ctx } = createRig();
    audio.playUi('click');
    const source = ctx.sources[0] as FakeSource;
    const panner = ((source.outputs[0] as FakeFilter).outputs[0] as FakeGain)
      .outputs[0] as FakePanner;
    const master = (panner.outputs[0] as FakeGain).outputs[0] as FakeGain;
    const mute = master.outputs[0] as FakeGain;
    const limiter = mute.outputs[0] as FakeCompressor;
    expect(limiter.kind).toBe('compressor');
    expect(limiter.outputs[0]).toBe(ctx.destination);
  });

  it('retunes the pad per scene with a handful of nodes', () => {
    const { audio, ctx } = createRig();
    expect(ctx.oscillators.length).toBe(4);
    for (const oscillator of ctx.oscillators) expect(oscillator.started).toBe(true);
    const matchNote = ctx.oscillators[0]?.frequency.value;
    audio.setScene('lobby');
    expect(ctx.oscillators[0]?.frequency.value).not.toBe(matchNote);
    audio.dispose();
    for (const oscillator of ctx.oscillators) expect(oscillator.stopped).toBe(true);
    expect(ctx.state).toBe('closed');
  });
});

describe('robustness', () => {
  it('swallows node failures, warns once, and then gives up quietly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const rig = createRig();
    const { audio, ctx } = rig;
    ctx.failSources = true;
    const view = matchView();
    expect(() => {
      for (let i = 0; i < 200; i++) {
        ctx.currentTime += 0.2;
        audio.playUi('click');
        audio.onEvent(cast('talon', 'primary'));
        beginWorldView(view);
        addDragon(view, LOCAL_ID, 'bastion', DRAGON_FLAG_ALIVE | DRAGON_FLAG_FIRING, 0, 5);
        audio.update(view, CAMERA, 1 / 60);
      }
    }).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(audio.stats().errors).toBeGreaterThan(0);
    expect(audio.stats().errors).toBeLessThanOrEqual(25);
    // A failed start does not leak its voice.
    expect(audio.stats().activeVoices).toBe(0);
  });

  it('survives a broken view and listener', () => {
    const rig = createRig();
    const view = matchView();
    const dragon = addDragon(view, LOCAL_ID, 'talon', DRAGON_FLAG_ALIVE | DRAGON_FLAG_BOOSTING);
    dragon.position.x = NaN;
    dragon.velocity.z = NaN;
    dragon.health = NaN;
    addDragon(view, 300, 'talon', DRAGON_FLAG_ALIVE);
    const badCamera: AudioListener = {
      position: { x: NaN, y: 0, z: 0 },
      forward: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 0 },
    };
    expect(() => {
      for (let i = 0; i < 30; i++) {
        rig.ctx.currentTime += 1 / 60;
        rig.audio.update(view, badCamera, NaN);
        rig.audio.update(view, badCamera, 1 / 60);
        rig.audio.update(view, CAMERA, -5);
      }
      rig.audio.onEvent({ ...cast('talon', 'primary'), position: { x: NaN, y: NaN, z: NaN } });
    }).not.toThrow();
    expect(rig.audio.stats().errors).toBe(0);
    for (const source of rig.ctx.sources) {
      const filter = source.outputs[0] as FakeFilter | undefined;
      if (filter === undefined) continue;
      const gain = filter.outputs[0] as FakeGain;
      expect(Number.isNaN(gain.gain.value)).toBe(false);
      expect(Number.isNaN(source.playbackRate.value)).toBe(false);
    }
  });

  it('does nothing after dispose', () => {
    const { audio, ctx } = createRig();
    audio.playUi('click');
    audio.dispose();
    audio.dispose();
    const count = ctx.sources.length;
    audio.unlock();
    audio.playUi('click');
    audio.onEvent(cast('talon', 'primary'));
    audio.update(matchView(), CAMERA, 1 / 60);
    audio.setScene('title');
    audio.setVolumes({ master: 1 });
    expect(ctx.sources.length).toBe(count);
    expect((ctx.sources[0] as FakeSource).stopped).toBe(true);
    expect(audio.stats().activeVoices).toBe(0);
  });
});
