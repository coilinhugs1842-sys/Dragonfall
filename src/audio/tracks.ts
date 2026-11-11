/**
 * Music and ambience beds (T-4.8): long stereo loops, each on its own gain node.
 *
 *   lobby ─┐
 *   matchLow ─┼─> duck ─> music bus          aerie, windBed, thunder ─> ambience bus
 *   matchHigh ┘
 *
 * - The scene picks which tracks are wanted. A wanted track is fetched and decoded when it is
 *   first needed and its buffer is dropped again when the scene no longer wants it, so only one
 *   scene's music is held decoded (a minute of stereo is about 25 MB).
 * - The two match layers are the same 24 bars at the same tempo: they are started on the same
 *   sample and cross-faded (equal power) by the match intensity.
 * - `duck` pulls the music down under a sting and lets it come back.
 * - Nothing here allocates per frame: `setIntensity` only moves two gain targets, and only when
 *   the value has changed enough to hear.
 */

import { layerGains } from './intensity';
import type { AssetLoader } from './loader';
import {
  FIRST_AMBIENCE_TRACK,
  TRACK_AERIE,
  TRACK_COUNT,
  TRACK_LOBBY,
  TRACK_MATCH_HIGH,
  TRACK_MATCH_LOW,
  TRACK_THUNDER,
  TRACK_WIND_BED,
} from './manifest';
import type { AudioTrack } from './manifest';

export type TrackScene = 'title' | 'lobby' | 'match';

export interface TrackTuning {
  /** Time constant of a track fading in or out on a scene change. */
  fadeS: number;
  /** Time constant of the calm/battle cross-fade following the intensity. */
  layerS: number;
  /** A change of intensity smaller than this is not sent to the gain nodes. */
  layerStep: number;
  /** Time constants of the music dropping under a sting and coming back. */
  duckDownS: number;
  duckUpS: number;
}

export const TRACK_TUNING: TrackTuning = {
  fadeS: 0.6,
  layerS: 0.8,
  layerStep: 0.01,
  duckDownS: 0.06,
  duckUpS: 0.5,
};

const IDLE = 0;
const LOADING = 1;
const READY = 2;
const PLAYING = 3;
const FAILED = 4;

/** Load priorities: above every sound sample, music before ambience. */
const PRIORITY_MUSIC = 60;
const PRIORITY_AMBIENCE = 25;

export interface TrackPlayer {
  setTracks(tracks: readonly (AudioTrack | null)[]): void;
  setScene(scene: TrackScene): void;
  /** Low preset: the distant-thunder bed is left out. */
  setLowDetail(low: boolean): void;
  /** 0..1 match intensity; cheap to call often. */
  setIntensity(value: number): void;
  duck(to: number, holdS: number): void;
  /** True while a music track of the current scene is sounding (the fallback pad then rests). */
  musicPlaying(): boolean;
  /** Tracks sounding now. */
  playingCount(): number;
  dispose(): void;
}

export function createTrackPlayer(
  ctx: AudioContext,
  musicOut: AudioNode,
  ambienceOut: AudioNode,
  loader: AssetLoader,
  onMusicChange: () => void,
): TrackPlayer {
  const duckGain = ctx.createGain();
  duckGain.connect(musicOut);
  const gains: GainNode[] = [];
  for (let i = 0; i < TRACK_COUNT; i++) {
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(i < FIRST_AMBIENCE_TRACK ? duckGain : ambienceOut);
    gains.push(gain);
  }

  let tracks: readonly (AudioTrack | null)[] = [];
  let scene: TrackScene = 'title';
  let lowDetail = false;
  let disposed = false;
  let intensity = 0;
  let sentIntensity = -1;
  const state = new Uint8Array(TRACK_COUNT);
  const want = new Uint8Array(TRACK_COUNT);
  /** Bumped whenever a track is released, so a late decode of an old request is ignored. */
  const epoch = new Uint32Array(TRACK_COUNT);
  const layer = new Float32Array(2);
  const buffers: (AudioBuffer | null)[] = [];
  const sources: (AudioBufferSourceNode | null)[] = [];
  /** A released source still fading out; cut short if its track starts again meanwhile. */
  const ending: (AudioBufferSourceNode | null)[] = [];
  /** Context time each playing track was started at (its loop start). */
  const startedAt = new Float64Array(TRACK_COUNT);
  for (let i = 0; i < TRACK_COUNT; i++) {
    buffers.push(null);
    sources.push(null);
    ending.push(null);
  }

  function levelOf(index: number): number {
    const base = tracks[index]?.gain ?? 0;
    if (index === TRACK_MATCH_LOW) return base * (layer[0] ?? 1);
    if (index === TRACK_MATCH_HIGH) return base * (layer[1] ?? 0);
    return base;
  }

  function release(index: number): void {
    epoch[index] = ((epoch[index] ?? 0) + 1) >>> 0;
    const source = sources[index];
    const gain = gains[index];
    const wasPlaying = state[index] === PLAYING;
    if (source !== null && source !== undefined && gain !== undefined) {
      const now = ctx.currentTime;
      gain.gain.cancelScheduledValues(now);
      gain.gain.setTargetAtTime(0, now, TRACK_TUNING.fadeS);
      try {
        source.stop(now + TRACK_TUNING.fadeS * 5);
        ending[index] = source;
      } catch {
        // Never started.
      }
    }
    sources[index] = null;
    buffers[index] = null;
    if (state[index] !== FAILED) state[index] = IDLE;
    if (wasPlaying && index < FIRST_AMBIENCE_TRACK) onMusicChange();
  }

  function start(index: number, when: number, partner = -1): void {
    const buffer = buffers[index];
    const track = tracks[index];
    const gain = gains[index];
    if (buffer === null || buffer === undefined || track === null || track === undefined) return;
    if (gain === undefined || state[index] !== READY) return;
    const old = ending[index];
    if (old !== null && old !== undefined) {
      ending[index] = null;
      try {
        old.stop();
      } catch {
        // Already stopped.
      }
      old.disconnect();
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    let offset = 0;
    let began = when;
    if (track.loop !== null) {
      source.loop = true;
      source.loopStart = track.loop.startS;
      source.loopEnd = track.loop.endS;
      offset = track.loop.startS;
      if (partner >= 0) {
        // Joining a layer that is already running: come in at the place it has reached.
        const length = track.loop.endS - track.loop.startS;
        began = startedAt[partner] ?? when;
        const into = when - began;
        offset += into > 0 ? into % length : 0;
      }
    }
    source.connect(gain);
    source.start(when, offset);
    sources[index] = source;
    startedAt[index] = began;
    state[index] = PLAYING;
    gain.gain.cancelScheduledValues(when);
    gain.gain.setValueAtTime(0, when);
    gain.gain.setTargetAtTime(levelOf(index), when, TRACK_TUNING.fadeS);
    if (index < FIRST_AMBIENCE_TRACK) onMusicChange();
  }

  /** Starts whatever is decoded and wanted. The match layers wait for each other. */
  function startReady(): void {
    const when = ctx.currentTime + 0.05;
    const low = state[TRACK_MATCH_LOW];
    const high = state[TRACK_MATCH_HIGH];
    const pairSettled = low !== LOADING && high !== LOADING;
    for (let i = 0; i < TRACK_COUNT; i++) {
      if (state[i] !== READY || want[i] !== 1) continue;
      if ((i === TRACK_MATCH_LOW || i === TRACK_MATCH_HIGH) && !pairSettled) continue;
      if (i === TRACK_MATCH_LOW && high === PLAYING) start(i, when, TRACK_MATCH_HIGH);
      else if (i === TRACK_MATCH_HIGH && low === PLAYING) start(i, when, TRACK_MATCH_LOW);
      else start(i, when);
    }
  }

  function load(index: number): void {
    const track = tracks[index];
    if (track === null || track === undefined) return;
    state[index] = LOADING;
    const mine = epoch[index] ?? 0;
    loader.request(
      track.url,
      index < FIRST_AMBIENCE_TRACK ? PRIORITY_MUSIC : PRIORITY_AMBIENCE,
      -1,
      (buffer) => {
        if (disposed || epoch[index] !== mine) return;
        if (buffer === null) {
          state[index] = FAILED;
        } else if (want[index] === 1) {
          buffers[index] = buffer;
          state[index] = READY;
        } else {
          state[index] = IDLE;
        }
        try {
          startReady();
        } catch {
          state[index] = FAILED;
        }
      },
    );
  }

  function apply(): void {
    want.fill(0);
    if (scene === 'match') {
      want[TRACK_MATCH_LOW] = 1;
      want[TRACK_MATCH_HIGH] = 1;
      want[TRACK_WIND_BED] = 1;
      want[TRACK_THUNDER] = lowDetail ? 0 : 1;
    } else {
      want[TRACK_LOBBY] = 1;
      want[TRACK_AERIE] = 1;
    }
    for (let i = 0; i < TRACK_COUNT; i++) {
      if (want[i] === 1) {
        if (state[i] === IDLE) load(i);
      } else if (state[i] !== IDLE && state[i] !== FAILED) {
        release(i);
      }
    }
  }

  function sendLayers(smoothS: number): void {
    layerGains(intensity, layer);
    sentIntensity = intensity;
    const now = ctx.currentTime;
    for (let i = TRACK_MATCH_LOW; i <= TRACK_MATCH_HIGH; i++) {
      if (state[i] === PLAYING) gains[i]?.gain.setTargetAtTime(levelOf(i), now, smoothS);
    }
  }

  layerGains(0, layer);

  return {
    setTracks(next: readonly (AudioTrack | null)[]): void {
      if (disposed) return;
      tracks = next;
      apply();
    },

    setScene(next: TrackScene): void {
      if (disposed) return;
      // Title and lobby share their tracks: moving between them changes nothing.
      const changed = (scene === 'match') !== (next === 'match');
      scene = next;
      if (!changed) return;
      if (next === 'match') {
        intensity = 0;
        sendLayers(0.01);
      }
      apply();
    },

    setLowDetail(low: boolean): void {
      if (disposed || low === lowDetail) return;
      lowDetail = low;
      apply();
    },

    setIntensity(value: number): void {
      if (disposed) return;
      intensity = value > 0 ? (value < 1 ? value : 1) : 0;
      const step = intensity - sentIntensity;
      if (step < TRACK_TUNING.layerStep && step > -TRACK_TUNING.layerStep) return;
      sendLayers(TRACK_TUNING.layerS);
    },

    duck(to: number, holdS: number): void {
      if (disposed) return;
      const now = ctx.currentTime;
      duckGain.gain.cancelScheduledValues(now);
      duckGain.gain.setTargetAtTime(to, now, TRACK_TUNING.duckDownS);
      duckGain.gain.setTargetAtTime(1, now + holdS, TRACK_TUNING.duckUpS);
    },

    musicPlaying(): boolean {
      for (let i = 0; i < FIRST_AMBIENCE_TRACK; i++) {
        if (state[i] === PLAYING) return true;
      }
      return false;
    },

    playingCount(): number {
      let count = 0;
      for (let i = 0; i < TRACK_COUNT; i++) {
        if (state[i] === PLAYING) count++;
      }
      return count;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (let i = 0; i < TRACK_COUNT; i++) {
        const source = sources[i];
        if (source !== null && source !== undefined) {
          try {
            source.stop();
          } catch {
            // Never started.
          }
          source.disconnect();
        }
        const old = ending[i];
        if (old !== null && old !== undefined) {
          try {
            old.stop();
          } catch {
            // Already stopped.
          }
          old.disconnect();
        }
        ending[i] = null;
        sources[i] = null;
        buffers[i] = null;
        gains[i]?.disconnect();
      }
      duckGain.disconnect();
    },
  };
}
