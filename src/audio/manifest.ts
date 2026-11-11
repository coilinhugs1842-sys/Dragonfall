/**
 * The audio asset manifest (T-4.8): `public/assets/audio/manifest.json`, written by
 * `tools/audio/build.py`. It lists the real `.ogg` files for the sounds of `sounds.ts` (by the
 * same ids, with variations, a base gain and loop points) and the music and ambience tracks.
 *
 * Parsing is defensive: the file comes over the network, so anything odd in it drops that one
 * entry (the engine then keeps the procedural fallback for it) and never throws.
 */

import { PRIORITY_LOCAL, SOUND_DEF_LIST, SOUND_IDS } from './sounds';
import type { SoundDef } from './sounds';

/** Folder of the manifest and its files, relative to the page (Vite `base` is `./`). */
export const AUDIO_ASSET_BASE = 'assets/audio/';
export const AUDIO_MANIFEST_FILE = 'manifest.json';
export const AUDIO_MANIFEST_VERSION = 1;

/**
 * Tracks are long stereo loops with their own gain node each (not pooled voices). The first
 * three are music (music bus), the rest ambience beds (ambience bus).
 */
export const TRACK_IDS = ['lobby', 'matchLow', 'matchHigh', 'aerie', 'windBed', 'thunder'] as const;
export type TrackId = (typeof TRACK_IDS)[number];
export const TRACK_COUNT = TRACK_IDS.length;
export const TRACK_LOBBY = 0;
export const TRACK_MATCH_LOW = 1;
export const TRACK_MATCH_HIGH = 2;
export const TRACK_AERIE = 3;
export const TRACK_WIND_BED = 4;
export const TRACK_THUNDER = 5;
/** Tracks below this index are music; from it on, ambience. */
export const FIRST_AMBIENCE_TRACK = TRACK_AERIE;

/** Most variations of one sound the engine keeps. */
export const MAX_VARIATIONS = 6;

/** The looping part of a file, in seconds. Files carry a little pre- and post-roll around it. */
export interface AudioLoop {
  readonly startS: number;
  readonly endS: number;
}

export interface SampleSet {
  /** One URL per variation, resolved against the asset base. */
  readonly urls: readonly string[];
  /** Linear gain that brings the files to the engine's reference loudness. */
  readonly gain: number;
  readonly loop: AudioLoop | null;
}

export interface AudioTrack {
  readonly url: string;
  readonly gain: number;
  readonly loop: AudioLoop | null;
}

export interface AudioManifest {
  /** Indexed like SOUND_IDS; null = no files for that sound (it stays procedural). */
  readonly sounds: readonly (SampleSet | null)[];
  /** Indexed like TRACK_IDS. */
  readonly tracks: readonly (AudioTrack | null)[];
}

const FILE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_\-/]*\.ogg$/;
const MAX_GAIN = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFile(value: unknown, baseUrl: string): string | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  if (!FILE_PATTERN.test(value) || value.includes('//')) return null;
  return baseUrl + value;
}

function parseGain(value: unknown): number | null {
  if (typeof value !== 'number' || !(value > 0) || value > MAX_GAIN) return null;
  return value;
}

/** `undefined` = malformed (drop the entry); null = not a loop. */
function parseLoop(value: unknown): AudioLoop | null | undefined {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) return undefined;
  const startS = value['startS'];
  const endS = value['endS'];
  if (typeof startS !== 'number' || typeof endS !== 'number') return undefined;
  if (!(startS >= 0) || !(endS > startS) || !(endS < 3600)) return undefined;
  return { startS, endS };
}

function parseSampleSet(value: unknown, baseUrl: string, wantLoop: boolean): SampleSet | null {
  if (!isRecord(value)) return null;
  const files = value['files'];
  const gain = parseGain(value['gain']);
  const loop = parseLoop(value['loop']);
  if (!Array.isArray(files) || files.length === 0 || gain === null || loop === undefined) return null;
  // A looping sound needs loop points and a one-shot must not have them: a mismatch means the
  // file is not the sound the table expects.
  if ((loop !== null) !== wantLoop) return null;
  const urls: string[] = [];
  for (let i = 0; i < files.length && urls.length < MAX_VARIATIONS; i++) {
    const url = parseFile(files[i], baseUrl);
    if (url === null) return null;
    urls.push(url);
  }
  return { urls, gain, loop };
}

function parseTrack(value: unknown, baseUrl: string): AudioTrack | null {
  if (!isRecord(value)) return null;
  const url = parseFile(value['file'], baseUrl);
  const gain = parseGain(value['gain']);
  const loop = parseLoop(value['loop']);
  if (url === null || gain === null || loop === undefined || loop === null) return null;
  return { url, gain, loop };
}

/**
 * Reads a decoded manifest JSON. Returns null when it is not a manifest of a version this build
 * knows; otherwise every well-formed entry, with unknown ids ignored.
 */
export function parseAudioManifest(
  json: unknown,
  baseUrl: string = AUDIO_ASSET_BASE,
): AudioManifest | null {
  if (!isRecord(json) || json['version'] !== AUDIO_MANIFEST_VERSION) return null;
  const soundsIn = isRecord(json['sounds']) ? json['sounds'] : {};
  const musicIn = isRecord(json['music']) ? json['music'] : {};
  const ambienceIn = isRecord(json['ambience']) ? json['ambience'] : {};
  const sounds: (SampleSet | null)[] = [];
  for (let i = 0; i < SOUND_IDS.length; i++) {
    const id = SOUND_IDS[i];
    const def = SOUND_DEF_LIST[i];
    const entry = id !== undefined && Object.hasOwn(soundsIn, id) ? soundsIn[id] : undefined;
    sounds.push(def === undefined ? null : parseSampleSet(entry, baseUrl, def.loop));
  }
  const tracks: (AudioTrack | null)[] = [];
  for (let i = 0; i < TRACK_COUNT; i++) {
    const id = TRACK_IDS[i];
    const from = i < FIRST_AMBIENCE_TRACK ? musicIn : ambienceIn;
    const entry = id !== undefined && Object.hasOwn(from, id) ? from[id] : undefined;
    tracks.push(parseTrack(entry, baseUrl));
  }
  return { sounds, tracks };
}

/**
 * How soon a sound's files are wanted, 0 first: the interface, then what the local rider hears
 * of their own dragon, then the rest of the fight. (A sound that is asked to play before its
 * turn jumps the queue: see the engine's loader.)
 */
export function loadTier(def: SoundDef): number {
  if (def.bus === 'ui') return 0;
  if (def.priority >= PRIORITY_LOCAL || def.loop) return 1;
  return 2;
}

/** Sound indices that have files, in the order they should be fetched. */
export function sampleLoadOrder(manifest: AudioManifest): number[] {
  const order: number[] = [];
  for (let i = 0; i < manifest.sounds.length; i++) {
    if (manifest.sounds[i] !== null && manifest.sounds[i] !== undefined) order.push(i);
  }
  const tier = (index: number): number => {
    const def = SOUND_DEF_LIST[index];
    return def === undefined ? 9 : loadTier(def);
  };
  return order.sort((a, b) => tier(a) - tier(b) || a - b);
}
