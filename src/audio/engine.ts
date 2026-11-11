/**
 * The WebAudio engine (T-3.8). One AudioContext, created on the first user gesture:
 *
 *   voice[i]: source -> low-pass -> gain -> stereo pan ─┐
 *                                                       ├─> bus (sfx | ui | ambience) ─┐
 *   pad: 3 oscillators -> low-pass -> gain -> music bus ────────────────────────────────┤
 *                                                                                       ▼
 *                                         master -> mute (hidden tab) -> limiter -> speakers
 *
 * Rules it keeps:
 * - The voice chains are built once (MAX_VOICES of them) and reused. The only node made per
 *   sound is its AudioBufferSourceNode, which the spec makes one-shot.
 * - `update` and `onEvent` allocate nothing else: state lives in typed arrays keyed by voice or
 *   by player id, and parameters move with `setTargetAtTime` at most AUDIO_TUNING.spatialHz
 *   times a second.
 * - Nothing here throws into the frame loop: every public method swallows and counts errors.
 * - It reads the game only through WorldView and GameEvents (src/shared) and never imports `ui`:
 *   `src/game` forwards UI sounds through `playUi`.
 *
 * Where WebAudio does not exist (node, some headless runs) `createAudio` returns a stub with
 * the same interface that does nothing.
 */

import type {
  AbilitySlot,
  DragonClassId,
  GameEvent,
  GameEventSource,
  PlayerId,
  QualityPreset,
  QualityPresetId,
  TeamId,
  Unsubscribe,
  Vec3,
  WorldView,
} from '../shared';
import {
  ABILITY_SLOTS,
  DEFAULT_QUALITY,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_HOVER,
  DRAGON_ANIM_TAKEOFF,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_IN_STORM,
  DRAGON_FLAG_SHIELDED,
  FLIGHT_TUNING,
  MATCH_TUNING,
  NO_PLAYER,
  QUALITY_PRESETS,
} from '../shared';
import { Rng } from './dsp';
import {
  ABILITY_SOUNDS,
  CHARGE_SOUNDS,
  COUNTDOWN_TICK_SOUND,
  FLIGHT_SOUNDS,
  SUSTAIN_SOUNDS,
  UI_SOUNDS,
  eventSound,
  localFeedbackSound,
} from './sound-table';
import type { UiSoundId } from './sound-table';
import {
  RENDER_SAMPLE_RATE,
  SOUND_BUSES,
  SOUND_COUNT,
  SOUND_DEF_LIST,
  SOUND_IDS,
  renderSound,
  soundIndexOf,
} from './sounds';
import type { SoundId } from './sounds';
import {
  createListenerFrame,
  createSpatialResult,
  spatialise,
  writeListenerFrame,
} from './spatial';
import type { AudioListener } from './spatial';
import { MAX_VOICES, NO_VOICE, VoiceAllocator } from './voices';

export const AUDIO_SCENES = ['title', 'lobby', 'match'] as const;
export type AudioScene = (typeof AUDIO_SCENES)[number];

/** Slider positions, 0..1. The engine squares them, so half a slider sounds about half as loud. */
export interface AudioVolumes {
  master: number;
  sfx: number;
  music: number;
  ui: number;
}

export interface PadTuning {
  /** Level of the pad on the music bus. */
  gain: number;
  /** Low-pass over the three oscillators (Hz): lower = darker. */
  cutoffHz: number;
  /** The three oscillator pitches (Hz), slightly detuned against each other. */
  notes: [number, number, number];
}

/** The engine's own mix numbers (not gameplay). Mutable, read live, so a dev GUI can tune them. */
export interface AudioTuning {
  /** Positional voices and loops are re-aimed this many times a second at most. */
  spatialHz: number;
  /** Time constant of those moves, and of the volume sliders. */
  paramSmoothS: number;
  volumeSmoothS: number;
  /** Time constant of a loop fading in or out. */
  loopFadeS: number;
  /** Own wind: quietest and lowest at stall speed, loudest and highest at max speed. */
  windGainMin: number;
  windRateMin: number;
  windRateMax: number;
  /** The storm wall is heard from this far inside it (metres). */
  stormHearM: number;
  /** Below this health fraction the local rider hears a heartbeat, faster as it falls. */
  lowHealth: number;
  heartbeatSlowS: number;
  heartbeatFastS: number;
  /** Seconds between wing-flap sounds of a dragon in a flapping animation. */
  flapPeriodS: number;
  /** A hit is played at (damage / hitDamageRef), kept between the two gains. */
  hitDamageRef: number;
  hitGainMin: number;
  hitGainMax: number;
  /** A predicted local cast swallows the host's echo of it for this long (as the VFX do). */
  localCastDedupeS: number;
  /** Placeholder rendering stops for the frame after this many milliseconds. */
  sliceBudgetMs: number;
  /** Seconds the pad takes to glide to another scene's notes. */
  padGlideS: number;
  pad: Record<AudioScene, PadTuning>;
}

export const AUDIO_TUNING: AudioTuning = {
  spatialHz: 20,
  paramSmoothS: 0.05,
  volumeSmoothS: 0.04,
  loopFadeS: 0.06,
  windGainMin: 0.25,
  windRateMin: 0.75,
  windRateMax: 1.45,
  stormHearM: 220,
  lowHealth: 0.3,
  heartbeatSlowS: 0.95,
  heartbeatFastS: 0.55,
  flapPeriodS: 0.62,
  hitDamageRef: 30,
  hitGainMin: 0.45,
  hitGainMax: 1.2,
  localCastDedupeS: 1,
  sliceBudgetMs: 3,
  padGlideS: 1.2,
  pad: {
    title: { gain: 0.16, cutoffHz: 700, notes: [110, 164.4, 220.7] },
    lobby: { gain: 0.14, cutoffHz: 800, notes: [146.8, 220.5, 293.2] },
    match: { gain: 0.07, cutoffHz: 420, notes: [98, 146.5, 196.4] },
  },
};

export interface AudioStats {
  /** Voices playing now (loops included). */
  activeVoices: number;
  /** Sounds that took a playing voice since creation. */
  stolen: number;
  /** Sounds dropped by the retrigger gap, the instance cap or a full pool of higher priority. */
  refused: number;
  /** Voice cap of the current quality preset. */
  capacity: number;
  /** True once the context exists and is running (after the first gesture). */
  ready: boolean;
  /** Placeholder sounds rendered so far, and the milliseconds that took in total. */
  soundsReady: number;
  initMs: number;
  /** Errors swallowed so far. Not 0 = something is wrong; see the console warning. */
  errors: number;
  /**
   * The master gain node's current value (the squared master volume, mid-fade while it moves);
   * 0 until the context exists. For the perf HUD and the settings checks.
   */
  masterGain: number;
}

export interface AudioOptions {
  /** Starting preset (voice cap). Default: DEFAULT_QUALITY. */
  readonly quality?: QualityPresetId;
  /**
   * Makes the context. Default: `new AudioContext()` when the browser has one. Returning null
   * (or throwing) leaves the engine silent. Tests pass a fake here.
   */
  readonly createContext?: () => AudioContext | null;
  /**
   * `sliced` (default): placeholders are rendered a few ms at a time from a timer, starting at
   * once, so loading never hitches. `now`: all inside `createAudio` (tests, loading screens).
   */
  readonly prerender?: 'sliced' | 'now';
}

export interface AudioEngine {
  /**
   * Call from a user-gesture handler (pointerdown, keydown): creates or resumes the context
   * (autoplay policy). Cheap and safe to call on every gesture.
   */
  unlock(): void;
  /** Once per rendered frame while a match is on screen. `listener` is the camera. */
  update(view: WorldView, listener: AudioListener, dtS: number): void;
  /** A game event (from `connect`, or forwarded by hand). Does not keep the event. */
  onEvent(event: GameEvent): void;
  /** Subscribes `onEvent` to every event type. Returns the unsubscribe function. */
  connect(source: GameEventSource): Unsubscribe;
  /**
   * The local rider's own predicted cast, heard at once; the host's `abilityCast` echo for the
   * slot is then skipped once. Only clients call it (same contract as `Vfx.spawnLocalShot`).
   */
  playLocalCast(classId: DragonClassId, slot: AbilitySlot): void;
  playUi(id: UiSoundId): void;
  setVolumes(volumes: Partial<AudioVolumes>): void;
  setQuality(preset: QualityPresetId | QualityPreset): void;
  /** Picks the music bed. Leaving `match` also fades every playing sound. */
  setScene(scene: AudioScene): void;
  /** The same object every call: read it, do not keep it. */
  stats(): Readonly<AudioStats>;
  dispose(): void;
}

// --- Fixed sizes ---------------------------------------------------------------------------------

/** Player ids are a `u8`; per-dragon state is indexed by id. */
const ID_SLOTS = 256;
const BUS_COUNT = SOUND_BUSES.length;
const OPEN_CUTOFF_HZ = 20_000;
const LOCAL_LOOP_WIND = 0;
const LOCAL_LOOP_BOOST = 1;
const LOCAL_LOOP_STORM = 2;
const LOCAL_LOOP_COUNT = 3;
const MAX_FRAME_DT_S = 0.1;
/** After this many swallowed errors the engine stops trying. */
const MAX_ERRORS = 25;

/** 1 where a sound lives on the `ui` bus: those are never placed in the world. */
const SOUND_IS_UI: Uint8Array = Uint8Array.from(SOUND_DEF_LIST, (def) =>
  def.bus === 'ui' ? 1 : 0,
);

function noop(): void {}

/** NaN comes out as 0. */
function clamp01(value: number): number {
  return value > 0 ? (value < 1 ? value : 1) : 0;
}

function busIndex(bus: (typeof SOUND_BUSES)[number]): number {
  return SOUND_BUSES.indexOf(bus);
}

function isFlapAnim(anim: number): boolean {
  return anim === DRAGON_ANIM_FLAP || anim === DRAGON_ANIM_HOVER || anim === DRAGON_ANIM_TAKEOFF;
}

function defaultContextFactory(): (() => AudioContext | null) | null {
  const scope = globalThis as { AudioContext?: typeof AudioContext };
  const Ctor = scope.AudioContext;
  if (typeof Ctor !== 'function') return null;
  return () => new Ctor({ latencyHint: 'interactive' });
}

/** The stub for environments without WebAudio. */
function createSilentAudio(): AudioEngine {
  const stats: AudioStats = {
    activeVoices: 0,
    stolen: 0,
    refused: 0,
    capacity: 0,
    ready: false,
    soundsReady: 0,
    initMs: 0,
    errors: 0,
    masterGain: 0,
  };
  return {
    unlock: noop,
    update: noop,
    onEvent: noop,
    connect: () => noop,
    playLocalCast: noop,
    playUi: noop,
    setVolumes: noop,
    setQuality: noop,
    setScene: noop,
    stats: () => stats,
    dispose: noop,
  };
}

export function createAudio(options: AudioOptions = {}): AudioEngine {
  const contextFactory = options.createContext ?? defaultContextFactory();
  if (contextFactory === null) return createSilentAudio();
  const makeContext: () => AudioContext | null = contextFactory;

  const defs = SOUND_DEF_LIST;
  const allocator = new VoiceAllocator(
    SOUND_COUNT,
    QUALITY_PRESETS[options.quality ?? DEFAULT_QUALITY].audioVoices,
  );
  const jitter = new Rng(0x5eed);
  const listener = createListenerFrame();
  const spatial = createSpatialResult();
  const volumes: AudioVolumes = { master: 1, sfx: 1, music: 0.7, ui: 1 };
  const stats: AudioStats = {
    activeVoices: 0,
    stolen: 0,
    refused: 0,
    capacity: allocator.capacity,
    ready: false,
    soundsReady: 0,
    initMs: 0,
    errors: 0,
    masterGain: 0,
  };

  let disposed = false;
  let broken = false;
  let contextFailed = false;
  let hidden = typeof document !== 'undefined' && document.hidden === true;
  let scene: AudioScene = 'title';

  // --- Graph (null until the first gesture) ------------------------------------------------------
  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  let muteGain: GainNode | null = null;
  let musicBus: GainNode | null = null;
  let padGain: GainNode | null = null;
  let padFilter: BiquadFilterNode | null = null;
  let maxCutoffHz = OPEN_CUTOFF_HZ;
  const buses: GainNode[] = [];
  const padOscillators: OscillatorNode[] = [];
  const filters: BiquadFilterNode[] = [];
  const gains: GainNode[] = [];
  const panners: StereoPannerNode[] = [];
  const sources: (AudioBufferSourceNode | null)[] = [];
  const endedHandlers: ((event: Event) => void)[] = [];
  for (let i = 0; i < MAX_VOICES; i++) sources.push(null);

  // --- Sounds ------------------------------------------------------------------------------------
  const pcm: (Float32Array | null)[] = [];
  const buffers: (AudioBuffer | null)[] = [];
  /** 1 = a real asset was decoded for this sound: the placeholder must not replace it. */
  const sampleLoaded = new Uint8Array(SOUND_COUNT);
  for (let i = 0; i < SOUND_COUNT; i++) {
    pcm.push(null);
    buffers.push(null);
  }
  let nextToRender = 0;
  let renderTimer: ReturnType<typeof setTimeout> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;

  // --- Per-voice state ---------------------------------------------------------------------------
  const vPositional = new Uint8Array(MAX_VOICES);
  const vFading = new Uint8Array(MAX_VOICES);
  const vFollow = new Int16Array(MAX_VOICES).fill(-1);
  const vBus = new Int8Array(MAX_VOICES).fill(-1);
  const vPos = new Float32Array(MAX_VOICES * 3);
  /** The sound's gain before distance. */
  const vGain = new Float32Array(MAX_VOICES);

  // --- Per-dragon state (by player id) -----------------------------------------------------------
  let frame = 1;
  const dSeen = new Int32Array(ID_SLOTS);
  const dFlags = new Uint16Array(ID_SLOTS);
  const dPos = new Float32Array(ID_SLOTS * 3);
  const dFlapS = new Float32Array(ID_SLOTS);
  const dLoopVoice = new Int8Array(ID_SLOTS).fill(NO_VOICE);
  const dLoopGen = new Uint32Array(ID_SLOTS);
  let dragonLoops = 0;

  // --- Local rider -------------------------------------------------------------------------------
  let localId: PlayerId = NO_PLAYER;
  let localTeam: TeamId | null = null;
  const localContext = {
    get localId(): PlayerId {
      return localId;
    },
    get localTeam(): TeamId | null {
      return localTeam;
    },
  };
  const loopVoice = new Int8Array(LOCAL_LOOP_COUNT).fill(NO_VOICE);
  const loopGen = new Uint32Array(LOCAL_LOOP_COUNT);
  const loopSound = [
    soundIndexOf(FLIGHT_SOUNDS.wind),
    soundIndexOf(FLIGHT_SOUNDS.boost),
    soundIndexOf(FLIGHT_SOUNDS.storm),
  ];
  const loopWant = new Uint8Array(LOCAL_LOOP_COUNT);
  const loopGain = new Float32Array(LOCAL_LOOP_COUNT);
  const loopRate = new Float32Array(LOCAL_LOOP_COUNT).fill(1);
  const localPending = new Uint8Array(ABILITY_SLOTS.length);
  const localPendingAt = new Float64Array(ABILITY_SLOTS.length);
  let heartbeatS = 0;
  let lastCountdown = -1;
  let spatialAccS = 0;
  const flapSound = soundIndexOf(FLIGHT_SOUNDS.flap);
  const heartbeatSound = soundIndexOf(FLIGHT_SOUNDS.heartbeat);
  const countdownSound = soundIndexOf(COUNTDOWN_TICK_SOUND);

  function fail(error: unknown): void {
    stats.errors++;
    if (stats.errors === 1) console.warn('[audio] error swallowed (audio keeps going)', error);
    if (stats.errors >= MAX_ERRORS) broken = true;
  }

  // --- Placeholder rendering ---------------------------------------------------------------------

  function uploadBuffer(index: number): void {
    const data = pcm[index];
    if (ctx === null || data === null || data === undefined) return;
    if (sampleLoaded[index] !== 1) {
      const buffer = ctx.createBuffer(1, data.length, RENDER_SAMPLE_RATE);
      buffer.getChannelData(0).set(data);
      buffers[index] = buffer;
    }
    // The context has its own copy now.
    pcm[index] = null;
  }

  function renderStep(): void {
    renderTimer = null;
    if (disposed) return;
    const budgetMs = options.prerender === 'now' ? Infinity : AUDIO_TUNING.sliceBudgetMs;
    const startMs = performance.now();
    let nowMs = startMs;
    try {
      while (nextToRender < SOUND_COUNT) {
        const id = SOUND_IDS[nextToRender];
        if (id !== undefined) {
          pcm[nextToRender] = renderSound(id);
          uploadBuffer(nextToRender);
        }
        nextToRender++;
        stats.soundsReady = nextToRender;
        nowMs = performance.now();
        if (nowMs - startMs >= budgetMs) break;
      }
    } catch (error) {
      nextToRender = SOUND_COUNT;
      fail(error);
    }
    stats.initMs += nowMs - startMs;
    if (nextToRender < SOUND_COUNT) renderTimer = setTimeout(renderStep, 16);
  }

  function loadSample(index: number, url: string): void {
    const context = ctx;
    if (context === null || typeof fetch !== 'function') return;
    fetch(url)
      .then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(response.status)))
      .then((data) => context.decodeAudioData(data))
      .then((decoded) => {
        if (disposed) return;
        buffers[index] = decoded;
        sampleLoaded[index] = 1;
      })
      // The placeholder stays in place when the asset is missing or cannot be decoded.
      .catch(noop);
  }

  // --- Graph -------------------------------------------------------------------------------------

  function buildGraph(context: AudioContext): void {
    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    limiter.connect(context.destination);
    const mute = context.createGain();
    mute.gain.value = hidden ? 0 : 1;
    mute.connect(limiter);
    const master = context.createGain();
    master.connect(mute);
    for (let b = 0; b < BUS_COUNT; b++) {
      const bus = context.createGain();
      bus.connect(master);
      buses.push(bus);
    }
    const music = context.createGain();
    music.connect(master);

    maxCutoffHz = Math.min(OPEN_CUTOFF_HZ, context.sampleRate * 0.45);
    for (let i = 0; i < MAX_VOICES; i++) {
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = 0.707;
      filter.frequency.value = maxCutoffHz;
      const gain = context.createGain();
      gain.gain.value = 0;
      const panner = context.createStereoPanner();
      filter.connect(gain);
      gain.connect(panner);
      filters.push(filter);
      gains.push(gain);
      panners.push(panner);
      // One handler per voice for its whole life: assigning it to a source allocates nothing.
      const voice = i;
      endedHandlers.push((event: Event) => {
        if (event.target === sources[voice]) freeVoice(voice);
      });
    }

    // The music bed: three detuned triangles through a low-pass, breathing on a slow LFO.
    const pad = AUDIO_TUNING.pad[scene];
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0.5;
    filter.frequency.value = pad.cutoffHz;
    const padOut = context.createGain();
    padOut.gain.value = 0;
    filter.connect(padOut);
    padOut.connect(music);
    for (let i = 0; i < pad.notes.length; i++) {
      const oscillator = context.createOscillator();
      oscillator.type = 'triangle';
      oscillator.frequency.value = pad.notes[i] ?? 110;
      oscillator.connect(filter);
      oscillator.start();
      padOscillators.push(oscillator);
    }
    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.07;
    const lfoDepth = context.createGain();
    // Cents on the filter: the pad opens and closes by about a third of an octave.
    lfoDepth.gain.value = 400;
    lfo.connect(lfoDepth);
    lfoDepth.connect(filter.detune);
    lfo.start();
    padOscillators.push(lfo);

    masterGain = master;
    muteGain = mute;
    musicBus = music;
    padGain = padOut;
    padFilter = filter;
  }

  function ensureContext(): boolean {
    if (ctx !== null) return true;
    if (contextFailed || disposed) return false;
    try {
      const context = makeContext();
      if (context === null) {
        contextFailed = true;
        return false;
      }
      buildGraph(context);
      ctx = context;
    } catch (error) {
      contextFailed = true;
      fail(error);
      return false;
    }
    applyVolumes(0);
    applyScene();
    for (let i = 0; i < SOUND_COUNT; i++) {
      uploadBuffer(i);
      const url = defs[i]?.url ?? null;
      if (url !== null) loadSample(i, url);
    }
    return true;
  }

  function applyVolumes(smoothS: number): void {
    if (ctx === null || masterGain === null || musicBus === null) return;
    const now = ctx.currentTime;
    const sfx = volumes.sfx * volumes.sfx;
    setParam(masterGain.gain, volumes.master * volumes.master, now, smoothS);
    setParam(musicBus.gain, volumes.music * volumes.music, now, smoothS);
    for (let b = 0; b < BUS_COUNT; b++) {
      const bus = buses[b];
      if (bus === undefined) continue;
      // Ambience has no slider of its own: it follows the effects.
      const value = SOUND_BUSES[b] === 'ui' ? volumes.ui * volumes.ui : sfx;
      setParam(bus.gain, value, now, smoothS);
    }
  }

  function applyScene(): void {
    if (ctx === null || padGain === null || padFilter === null) return;
    const pad = AUDIO_TUNING.pad[scene];
    const now = ctx.currentTime;
    const glide = AUDIO_TUNING.padGlideS;
    padGain.gain.setTargetAtTime(pad.gain, now, glide);
    padFilter.frequency.setTargetAtTime(pad.cutoffHz, now, glide);
    for (let i = 0; i < pad.notes.length; i++) {
      padOscillators[i]?.frequency.setTargetAtTime(pad.notes[i] ?? 110, now, glide);
    }
  }

  /** Moves a parameter: at once when `smoothS` is 0, otherwise gliding with that time constant. */
  function setParam(param: AudioParam, value: number, now: number, smoothS: number): void {
    if (smoothS > 0) {
      param.setTargetAtTime(value, now, smoothS);
    } else {
      param.cancelScheduledValues(now);
      param.setValueAtTime(value, now);
    }
  }

  // --- Voices ------------------------------------------------------------------------------------

  /** Cuts a voice's source without touching the allocator. */
  function stopSource(voice: number): void {
    const source = sources[voice];
    if (source === null || source === undefined) return;
    sources[voice] = null;
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped.
    }
    source.disconnect();
  }

  /** A voice's source ended by itself (or after a fade-out). */
  function freeVoice(voice: number): void {
    const source = sources[voice];
    if (source !== null && source !== undefined) {
      source.onended = null;
      source.disconnect();
    }
    sources[voice] = null;
    vFading[voice] = 0;
    vFollow[voice] = -1;
    allocator.release(voice);
  }

  function killVoice(voice: number): void {
    stopSource(voice);
    vFading[voice] = 0;
    vFollow[voice] = -1;
    allocator.release(voice);
  }

  /** Fades a voice out and lets its source end; the voice frees itself in `onended`. */
  function fadeOutVoice(voice: number): void {
    const source = sources[voice];
    const gain = gains[voice];
    if (ctx === null || source === null || source === undefined || gain === undefined) {
      killVoice(voice);
      return;
    }
    if (vFading[voice] === 1) return;
    vFading[voice] = 1;
    const now = ctx.currentTime;
    const fade = AUDIO_TUNING.loopFadeS;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setTargetAtTime(0, now, fade);
    try {
      source.stop(now + fade * 5);
    } catch {
      killVoice(voice);
    }
  }

  function stopAllVoices(fade: boolean): void {
    for (let i = 0; i < MAX_VOICES; i++) {
      if (allocator.active[i] !== 1) continue;
      if (fade) fadeOutVoice(i);
      else killVoice(i);
    }
    loopVoice.fill(NO_VOICE);
    dLoopVoice.fill(NO_VOICE);
    dragonLoops = 0;
  }

  /**
   * Starts a sound. `positional` sounds are placed at (x, y, z) and dropped when out of
   * earshot; `followId` keeps a positional voice on that dragon. Returns the voice or NO_VOICE.
   */
  function startVoice(
    soundIndex: number,
    positional: boolean,
    x: number,
    y: number,
    z: number,
    followId: number,
    gainScale: number,
    rate: number,
    fadeIn: boolean,
  ): number {
    const context = ctx;
    if (context === null || hidden || broken) return NO_VOICE;
    const def = defs[soundIndex];
    const buffer = buffers[soundIndex];
    if (def === undefined || buffer === null || buffer === undefined) return NO_VOICE;
    let distance = 0;
    let level = def.gain * gainScale;
    let pan = 0;
    let cutoff = maxCutoffHz;
    if (positional) {
      spatialise(spatial, listener, x, y, z, def.refDistanceM, def.maxDistanceM);
      if (!(spatial.gain > 0)) return NO_VOICE;
      distance = spatial.distance;
      level *= spatial.gain;
      pan = spatial.pan;
      cutoff = spatial.cutoffHz < maxCutoffHz ? spatial.cutoffHz : maxCutoffHz;
    }
    const now = context.currentTime;
    const voice = allocator.request(
      soundIndex,
      def.priority,
      distance,
      now,
      def.maxInstances,
      def.minRetriggerS,
    );
    if (voice === NO_VOICE) return NO_VOICE;
    if (allocator.wasStolen) stopSource(voice);
    const filter = filters[voice];
    const gain = gains[voice];
    const panner = panners[voice];
    if (filter === undefined || gain === undefined || panner === undefined) {
      allocator.release(voice);
      return NO_VOICE;
    }
    const bus = busIndex(def.bus);
    if (vBus[voice] !== bus) {
      if ((vBus[voice] ?? -1) >= 0) panner.disconnect();
      const target = buses[bus];
      if (target !== undefined) panner.connect(target);
      vBus[voice] = bus;
    }
    setParam(filter.frequency, cutoff, now, 0);
    setParam(panner.pan, pan, now, 0);
    if (fadeIn) {
      setParam(gain.gain, 0, now, 0);
      gain.gain.setTargetAtTime(level, now, AUDIO_TUNING.loopFadeS);
    } else {
      setParam(gain.gain, level, now, 0);
    }
    vPositional[voice] = positional ? 1 : 0;
    vFading[voice] = 0;
    vFollow[voice] = followId;
    vGain[voice] = def.gain * gainScale;
    vPos[voice * 3] = x;
    vPos[voice * 3 + 1] = y;
    vPos[voice * 3 + 2] = z;

    // The one allocation per sound: source nodes are one-shot by spec.
    let source: AudioBufferSourceNode;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = def.loop;
      const spread = def.pitchJitter > 0 ? 1 + def.pitchJitter * jitter.bipolar() : 1;
      source.playbackRate.value = rate > 0 ? rate * spread : spread;
      source.onended = endedHandlers[voice] ?? null;
      source.connect(filter);
      source.start();
    } catch (error) {
      // The voice must not stay taken by a sound that never started.
      allocator.release(voice);
      throw error;
    }
    sources[voice] = source;
    return voice;
  }

  function playAt(sound: SoundId, position: Vec3, gainScale: number): void {
    startVoice(
      soundIndexOf(sound),
      true,
      position.x,
      position.y,
      position.z,
      -1,
      gainScale,
      1,
      false,
    );
  }

  function playFlat(sound: SoundId, gainScale: number): void {
    startVoice(soundIndexOf(sound), false, 0, 0, 0, -1, gainScale, 1, false);
  }

  function voiceAlive(voice: number, generation: number): boolean {
    return (
      voice >= 0 &&
      allocator.active[voice] === 1 &&
      allocator.generation[voice] === generation &&
      vFading[voice] === 0
    );
  }

  /** Re-aims every positional voice and the local loops. Runs at AUDIO_TUNING.spatialHz. */
  function refreshVoices(): void {
    const context = ctx;
    if (context === null) return;
    const now = context.currentTime;
    const smooth = AUDIO_TUNING.paramSmoothS;
    for (let v = 0; v < MAX_VOICES; v++) {
      if (allocator.active[v] !== 1 || vPositional[v] !== 1 || vFading[v] === 1) continue;
      const follow = vFollow[v] ?? -1;
      if (follow >= 0 && dSeen[follow] === frame) {
        vPos[v * 3] = dPos[follow * 3] ?? 0;
        vPos[v * 3 + 1] = dPos[follow * 3 + 1] ?? 0;
        vPos[v * 3 + 2] = dPos[follow * 3 + 2] ?? 0;
      }
      const def = defs[allocator.sound[v] ?? -1];
      const filter = filters[v];
      const gain = gains[v];
      const panner = panners[v];
      if (def === undefined || filter === undefined || gain === undefined || panner === undefined) {
        continue;
      }
      spatialise(
        spatial,
        listener,
        vPos[v * 3] ?? 0,
        vPos[v * 3 + 1] ?? 0,
        vPos[v * 3 + 2] ?? 0,
        def.refDistanceM,
        def.maxDistanceM,
      );
      allocator.distance[v] = spatial.distance;
      const cutoff = spatial.cutoffHz < maxCutoffHz ? spatial.cutoffHz : maxCutoffHz;
      gain.gain.setTargetAtTime((vGain[v] ?? 0) * spatial.gain, now, smooth);
      panner.pan.setTargetAtTime(spatial.pan, now, smooth);
      filter.frequency.setTargetAtTime(cutoff, now, smooth);
    }

    for (let i = 0; i < LOCAL_LOOP_COUNT; i++) {
      let voice = loopVoice[i] ?? NO_VOICE;
      const alive = voiceAlive(voice, loopGen[i] ?? 0);
      if (loopWant[i] !== 1) {
        if (alive) fadeOutVoice(voice);
        loopVoice[i] = NO_VOICE;
        continue;
      }
      const soundIndex = loopSound[i] ?? 0;
      const level = (defs[soundIndex]?.gain ?? 0) * (loopGain[i] ?? 0);
      if (!alive) {
        voice = startVoice(
          soundIndex,
          false,
          0,
          0,
          0,
          -1,
          loopGain[i] ?? 0,
          loopRate[i] ?? 1,
          true,
        );
        loopVoice[i] = voice;
        if (voice !== NO_VOICE) loopGen[i] = allocator.generation[voice] ?? 0;
        continue;
      }
      gains[voice]?.gain.setTargetAtTime(level, now, smooth * 2);
      sources[voice]?.playbackRate.setTargetAtTime(loopRate[i] ?? 1, now, smooth * 2);
    }
  }

  function stopDragonLoop(id: number): void {
    const voice = dLoopVoice[id] ?? NO_VOICE;
    if (voice === NO_VOICE) return;
    if (voiceAlive(voice, dLoopGen[id] ?? 0)) fadeOutVoice(voice);
    dLoopVoice[id] = NO_VOICE;
    dragonLoops--;
  }

  // --- Frame -------------------------------------------------------------------------------------

  function updateFrame(view: WorldView, dtS: number): void {
    const dt = dtS > 0 ? (dtS < MAX_FRAME_DT_S ? dtS : MAX_FRAME_DT_S) : 0;
    frame++;
    spatialAccS += dt;
    const interval = 1 / AUDIO_TUNING.spatialHz;
    const spatialTick = spatialAccS >= interval;
    if (spatialTick) spatialAccS = spatialAccS >= interval * 2 ? 0 : spatialAccS - interval;

    localId = view.localDragonId;
    let localFound = false;
    let localAlive = false;
    let localBoosting = false;
    let localInStorm = false;
    let localSpeed = 0;
    let localHealth = 1;
    let localX = listener.x;
    let localZ = listener.z;

    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined) continue;
      const id = dragon.id;
      if (id < 0 || id >= ID_SLOTS) continue;
      const flags = dragon.flags;
      const fresh = dSeen[id] === frame - 1;
      const before = fresh ? (dFlags[id] ?? 0) : flags;
      const alive = (flags & DRAGON_FLAG_ALIVE) !== 0;
      const position = dragon.position;
      const isLocal = id === localId;

      if (alive && (flags & DRAGON_FLAG_CHARGING) !== 0 && (before & DRAGON_FLAG_CHARGING) === 0) {
        const charge = CHARGE_SOUNDS[dragon.classId];
        if (charge !== null) {
          if (isLocal) playFlat(charge, 1);
          else playAt(charge, position, 1);
        }
      }

      let flapS = (dFlapS[id] ?? 0) - dt;
      if (flapS <= 0) {
        flapS = 0;
        if (alive && isFlapAnim(dragon.anim)) {
          startVoice(flapSound, true, position.x, position.y, position.z, -1, 1, 1, false);
          flapS = AUDIO_TUNING.flapPeriodS * (0.9 + 0.2 * jitter.next());
        }
      }
      dFlapS[id] = flapS;

      const sustain = SUSTAIN_SOUNDS[dragon.classId];
      const wantLoop = sustain !== null && alive && (flags & DRAGON_FLAG_FIRING) !== 0;
      const loop = dLoopVoice[id] ?? NO_VOICE;
      if (!wantLoop) {
        if (loop !== NO_VOICE) stopDragonLoop(id);
      } else if (sustain !== null && spatialTick) {
        if (loop !== NO_VOICE && !voiceAlive(loop, dLoopGen[id] ?? 0)) {
          // Stolen: forget it and ask again below.
          dLoopVoice[id] = NO_VOICE;
          dragonLoops--;
        }
        if (dLoopVoice[id] === NO_VOICE) {
          const voice = startVoice(
            soundIndexOf(sustain),
            true,
            position.x,
            position.y,
            position.z,
            id,
            1,
            1,
            true,
          );
          if (voice !== NO_VOICE) {
            dLoopVoice[id] = voice;
            dLoopGen[id] = allocator.generation[voice] ?? 0;
            dragonLoops++;
          }
        }
      }

      dSeen[id] = frame;
      dFlags[id] = flags;
      dPos[id * 3] = position.x;
      dPos[id * 3 + 1] = position.y;
      dPos[id * 3 + 2] = position.z;

      if (isLocal) {
        localFound = true;
        localAlive = alive;
        localTeam = dragon.team;
        localBoosting = (flags & DRAGON_FLAG_BOOSTING) !== 0;
        localInStorm = (flags & DRAGON_FLAG_IN_STORM) !== 0;
        localHealth = dragon.health;
        const velocity = dragon.velocity;
        localSpeed = Math.sqrt(
          velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z,
        );
        localX = position.x;
        localZ = position.z;
      }
    }

    // A dragon that left the view (veiled, disconnected, despawned) takes its breath loop along.
    if (dragonLoops > 0) {
      for (let id = 0; id < ID_SLOTS; id++) {
        if (dLoopVoice[id] !== NO_VOICE && dSeen[id] !== frame) stopDragonLoop(id);
      }
    }

    // Own wind and boost.
    const inMatch = scene === 'match';
    const speedSpan = FLIGHT_TUNING.maxSpeed - FLIGHT_TUNING.stallSpeed;
    const speedT = speedSpan > 0 ? clamp01((localSpeed - FLIGHT_TUNING.stallSpeed) / speedSpan) : 0;
    loopWant[LOCAL_LOOP_WIND] = inMatch && localFound ? 1 : 0;
    loopGain[LOCAL_LOOP_WIND] = AUDIO_TUNING.windGainMin + (1 - AUDIO_TUNING.windGainMin) * speedT;
    loopRate[LOCAL_LOOP_WIND] =
      AUDIO_TUNING.windRateMin + (AUDIO_TUNING.windRateMax - AUDIO_TUNING.windRateMin) * speedT;
    loopWant[LOCAL_LOOP_BOOST] = inMatch && localAlive && localBoosting ? 1 : 0;
    loopGain[LOCAL_LOOP_BOOST] = 1;
    loopRate[LOCAL_LOOP_BOOST] = 0.9 + 0.25 * speedT;

    // Storm wall: louder the closer the rider (or a spectator's camera) is to its edge.
    let storm = localInStorm ? 1 : 0;
    if (storm === 0) {
      for (let i = 0; i < view.zoneCount; i++) {
        const zone = view.zones[i];
        if (zone === undefined || zone.kind !== 'stormWall') continue;
        const dx = localX - zone.position.x;
        const dz = localZ - zone.position.z;
        const inside = zone.radius - Math.sqrt(dx * dx + dz * dz);
        const near = clamp01(1 - inside / AUDIO_TUNING.stormHearM);
        if (near > storm) storm = near;
      }
    }
    loopWant[LOCAL_LOOP_STORM] = inMatch && storm > 0.02 ? 1 : 0;
    loopGain[LOCAL_LOOP_STORM] = storm * storm;
    loopRate[LOCAL_LOOP_STORM] = 1;

    // Low-health heartbeat.
    if (inMatch && localAlive && localHealth > 0 && localHealth < AUDIO_TUNING.lowHealth) {
      heartbeatS -= dt;
      if (heartbeatS <= 0) {
        const t = localHealth / AUDIO_TUNING.lowHealth;
        heartbeatS =
          AUDIO_TUNING.heartbeatFastS +
          (AUDIO_TUNING.heartbeatSlowS - AUDIO_TUNING.heartbeatFastS) * t;
        startVoice(heartbeatSound, false, 0, 0, 0, -1, 1.2 - 0.5 * t, 1, false);
      }
    } else {
      heartbeatS = 0;
    }

    // Countdown: one tick as each whole second comes up; "go" is the `playing` phase event.
    const clock = view.clock;
    if (clock.phase === 'countdown') {
      const left = Math.ceil(MATCH_TUNING.countdownS - clock.phaseTimeS);
      if (left !== lastCountdown) {
        lastCountdown = left;
        if (left > 0 && left <= Math.ceil(MATCH_TUNING.countdownS)) {
          startVoice(countdownSound, false, 0, 0, 0, -1, 1, 1, false);
        }
      }
    } else {
      lastCountdown = -1;
    }

    if (spatialTick) refreshVoices();
  }

  function handleEvent(event: GameEvent): void {
    switch (event.type) {
      case 'abilityCast': {
        const isLocal = event.dragonId === localId && localId !== NO_PLAYER;
        if (isLocal) {
          const slot = ABILITY_SLOTS.indexOf(event.slot);
          if (slot >= 0 && (localPending[slot] ?? 0) > 0 && ctx !== null) {
            const fresh =
              ctx.currentTime - (localPendingAt[slot] ?? 0) <= AUDIO_TUNING.localCastDedupeS;
            // A stale prediction is forgotten, and this event is played as usual.
            localPending[slot] = fresh ? (localPending[slot] ?? 1) - 1 : 0;
            if (fresh) return;
          }
        }
        const sound = eventSound(event, localContext);
        if (sound === null) return;
        // The rider's own casts are not placed: the camera trails the dragon, and a sound
        // pinned to where the dragon WAS would slide behind the listener.
        if (isLocal) playFlat(sound, 1);
        else playAt(sound, event.position, 1);
        return;
      }
      case 'hit': {
        const target = event.targetId;
        const shielded =
          target >= 0 &&
          target < ID_SLOTS &&
          frame - (dSeen[target] ?? 0) <= 2 &&
          ((dFlags[target] ?? 0) & DRAGON_FLAG_SHIELDED) !== 0;
        const sound = eventSound(event, localContext, shielded);
        if (sound !== null) {
          const scaled = event.damage / AUDIO_TUNING.hitDamageRef;
          // Written so that a NaN damage lands on the minimum.
          const level =
            scaled > AUDIO_TUNING.hitGainMin
              ? scaled < AUDIO_TUNING.hitGainMax
                ? scaled
                : AUDIO_TUNING.hitGainMax
              : AUDIO_TUNING.hitGainMin;
          if (target === localId && localId !== NO_PLAYER) playFlat(sound, level);
          else playAt(sound, event.position, level);
        }
        break;
      }
      case 'takedown':
      case 'spawn':
      case 'statusApplied':
      case 'impact':
      case 'objective': {
        const sound = eventSound(event, localContext);
        if (sound !== null) {
          if (SOUND_IS_UI[soundIndexOf(sound)] === 1) playFlat(sound, 1);
          else playAt(sound, event.position, 1);
        }
        break;
      }
      case 'matchPhase':
      case 'assist': {
        const sound = eventSound(event, localContext);
        if (sound !== null) playFlat(sound, 1);
        break;
      }
    }
    const feedback = localFeedbackSound(event, localContext);
    if (feedback !== null) playFlat(feedback, 1);
  }

  function onVisibility(): void {
    try {
      hidden = document.hidden === true;
      if (suspendTimer !== null) {
        clearTimeout(suspendTimer);
        suspendTimer = null;
      }
      const context = ctx;
      if (context === null || muteGain === null) return;
      muteGain.gain.setTargetAtTime(hidden ? 0 : 1, context.currentTime, 0.03);
      if (hidden) {
        // Let the fade finish, then stop the audio thread's work altogether.
        suspendTimer = setTimeout(suspendIfHidden, 250);
      } else if (context.state === 'suspended') {
        context.resume().catch(noop);
      }
    } catch (error) {
      fail(error);
    }
  }

  function suspendIfHidden(): void {
    suspendTimer = null;
    if (!hidden || ctx === null || disposed) return;
    try {
      ctx.suspend().catch(noop);
    } catch (error) {
      fail(error);
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  if (options.prerender === 'now') renderStep();
  else renderTimer = setTimeout(renderStep, 0);

  const engine: AudioEngine = {
    unlock(): void {
      if (disposed || broken) return;
      try {
        if (!ensureContext() || ctx === null) return;
        if (ctx.state === 'suspended' && !hidden) ctx.resume().catch(noop);
      } catch (error) {
        fail(error);
      }
    },

    update(view: WorldView, camera: AudioListener, dtS: number): void {
      if (disposed || broken) return;
      try {
        writeListenerFrame(listener, camera);
        updateFrame(view, dtS);
      } catch (error) {
        fail(error);
      }
    },

    onEvent(event: GameEvent): void {
      if (disposed || broken) return;
      try {
        handleEvent(event);
      } catch (error) {
        fail(error);
      }
    },

    connect(source: GameEventSource): Unsubscribe {
      const handler = (event: GameEvent): void => engine.onEvent(event);
      const off = [
        source.on('abilityCast', handler),
        source.on('hit', handler),
        source.on('takedown', handler),
        source.on('spawn', handler),
        source.on('statusApplied', handler),
        source.on('impact', handler),
        source.on('objective', handler),
        source.on('matchPhase', handler),
        source.on('assist', handler),
      ];
      return () => {
        for (const unsubscribe of off) unsubscribe();
      };
    },

    playLocalCast(classId: DragonClassId, slot: AbilitySlot): void {
      if (disposed || broken || ctx === null) return;
      try {
        const index = ABILITY_SLOTS.indexOf(slot);
        const sound = ABILITY_SOUNDS[classId]?.[slot];
        if (index < 0 || sound === undefined) return;
        const now = ctx.currentTime;
        // An echo that never came (the host refused the cast) must not eat a later event.
        if (now - (localPendingAt[index] ?? 0) > AUDIO_TUNING.localCastDedupeS) {
          localPending[index] = 0;
        }
        if ((localPending[index] ?? 0) < 255) localPending[index] = (localPending[index] ?? 0) + 1;
        localPendingAt[index] = now;
        playFlat(sound, 1);
      } catch (error) {
        fail(error);
      }
    },

    playUi(id: UiSoundId): void {
      if (disposed || broken) return;
      try {
        const sound = UI_SOUNDS[id];
        if (sound !== undefined) playFlat(sound, 1);
      } catch (error) {
        fail(error);
      }
    },

    setVolumes(next: Partial<AudioVolumes>): void {
      if (disposed) return;
      try {
        if (typeof next.master === 'number' && next.master === next.master) {
          volumes.master = clamp01(next.master);
        }
        if (typeof next.sfx === 'number' && next.sfx === next.sfx) volumes.sfx = clamp01(next.sfx);
        if (typeof next.music === 'number' && next.music === next.music) {
          volumes.music = clamp01(next.music);
        }
        if (typeof next.ui === 'number' && next.ui === next.ui) volumes.ui = clamp01(next.ui);
        applyVolumes(AUDIO_TUNING.volumeSmoothS);
      } catch (error) {
        fail(error);
      }
    },

    setQuality(preset: QualityPresetId | QualityPreset): void {
      if (disposed) return;
      try {
        const resolved = typeof preset === 'string' ? QUALITY_PRESETS[preset] : preset;
        if (resolved === undefined) return;
        allocator.setCapacity(resolved.audioVoices);
        for (let i = allocator.capacity; i < MAX_VOICES; i++) {
          if (allocator.active[i] === 1) killVoice(i);
        }
      } catch (error) {
        fail(error);
      }
    },

    setScene(next: AudioScene): void {
      if (disposed || next === scene) return;
      try {
        const leavingMatch = scene === 'match';
        scene = next;
        if (leavingMatch) {
          stopAllVoices(true);
          loopWant.fill(0);
          localPending.fill(0);
          localId = NO_PLAYER;
          localTeam = null;
          heartbeatS = 0;
          lastCountdown = -1;
        }
        applyScene();
      } catch (error) {
        fail(error);
      }
    },

    stats(): Readonly<AudioStats> {
      stats.activeVoices = allocator.activeVoices;
      stats.stolen = allocator.stolen;
      stats.refused = allocator.refused;
      stats.capacity = allocator.capacity;
      stats.ready = ctx !== null && ctx.state === 'running';
      stats.masterGain = masterGain !== null ? masterGain.gain.value : 0;
      return stats;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
          document.removeEventListener('visibilitychange', onVisibility);
        }
        if (renderTimer !== null) clearTimeout(renderTimer);
        if (suspendTimer !== null) clearTimeout(suspendTimer);
        renderTimer = null;
        suspendTimer = null;
        stopAllVoices(false);
        for (const oscillator of padOscillators) {
          try {
            oscillator.stop();
          } catch {
            // Never started.
          }
          oscillator.disconnect();
        }
        for (let i = 0; i < SOUND_COUNT; i++) {
          pcm[i] = null;
          buffers[i] = null;
        }
        const context = ctx;
        ctx = null;
        if (context !== null && context.state !== 'closed') context.close().catch(noop);
      } catch (error) {
        fail(error);
      }
    },
  };
  return engine;
}
