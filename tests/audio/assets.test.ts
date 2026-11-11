/**
 * Real audio files (T-4.8): the manifest parser, the loader's priority order, the music
 * intensity model, the track player, the engine playing decoded files with variations and
 * falling back to its procedural sounds, and the shipped manifest against the files on disk.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUDIO_TUNING,
  AssetLoader,
  INTENSITY_TUNING,
  MAX_VARIATIONS,
  MUSIC_DUCKS,
  MusicIntensity,
  SOUND_DEFS,
  SOUND_IDS,
  TRACK_IDS,
  TRACK_TUNING,
  createAudio,
  createTrackPlayer,
  layerGains,
  loadTier,
  parseAudioManifest,
  sampleLoadOrder,
  soundIndexOf,
} from '../../src/audio';
import type { AudioEngine, AudioListener, AudioTrack, SoundId } from '../../src/audio';
import {
  ASSET_BUDGETS,
  DRAGON_FLAG_ALIVE,
  QUALITY_PRESETS,
  TEAM_EMBER,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { MutableWorldView } from '../../src/shared';
import { FakeContext, FakeGain, createFakeServer, settle } from './fake-webaudio';
import type { FakeServer, FakeSource } from './fake-webaudio';

const BASE = 'assets/audio/';
const LOOP = { startS: 0.25, endS: 3.25 };

function sampleManifest(): Record<string, unknown> {
  return {
    version: 1,
    sounds: {
      uiClick: { files: ['sfx/uiClick_1.ogg', 'sfx/uiClick_2.ogg', 'sfx/uiClick_3.ogg'], gain: 0.5, loop: null },
      fireBolt: { files: ['sfx/fireBolt_1.ogg', 'sfx/fireBolt_2.ogg'], gain: 0.8, loop: null },
      windLoop: { files: ['sfx/windLoop_1.ogg'], gain: 0.6, loop: LOOP },
      victory: { files: ['music/victory.ogg'], gain: 0.7, loop: null },
      takedownBoom: { files: ['sfx/takedownBoom_1.ogg'], gain: 1, loop: null },
    },
    music: {
      lobby: { file: 'music/lobby.ogg', gain: 0.8, loop: { startS: 0.5, endS: 58.68 } },
      matchLow: { file: 'music/matchLow.ogg', gain: 0.8, loop: { startS: 0.5, endS: 48.5 } },
      matchHigh: { file: 'music/matchHigh.ogg', gain: 0.8, loop: { startS: 0.5, endS: 48.5 } },
    },
    ambience: {
      aerie: { file: 'ambience/aerie.ogg', gain: 0.9, loop: { startS: 0.5, endS: 24.5 } },
      windBed: { file: 'ambience/windBed.ogg', gain: 0.8, loop: { startS: 0.5, endS: 24.5 } },
      thunder: { file: 'ambience/thunder.ogg', gain: 1, loop: { startS: 0.5, endS: 36.5 } },
    },
  };
}

describe('parseAudioManifest', () => {
  it('reads sounds by id with resolved URLs, gain and loop points', () => {
    const manifest = parseAudioManifest(sampleManifest(), BASE);
    expect(manifest).not.toBeNull();
    const click = manifest?.sounds[soundIndexOf('uiClick')];
    expect(click?.urls).toEqual([`${BASE}sfx/uiClick_1.ogg`, `${BASE}sfx/uiClick_2.ogg`, `${BASE}sfx/uiClick_3.ogg`]);
    expect(click?.gain).toBe(0.5);
    expect(click?.loop).toBeNull();
    expect(manifest?.sounds[soundIndexOf('windLoop')]?.loop).toEqual(LOOP);
    expect(manifest?.sounds[soundIndexOf('hitFlesh')]).toBeNull();
    expect(manifest?.sounds.length).toBe(SOUND_IDS.length);
    expect(manifest?.tracks.map((track) => track?.url)).toEqual([
      `${BASE}music/lobby.ogg`,
      `${BASE}music/matchLow.ogg`,
      `${BASE}music/matchHigh.ogg`,
      `${BASE}ambience/aerie.ogg`,
      `${BASE}ambience/windBed.ogg`,
      `${BASE}ambience/thunder.ogg`,
    ]);
  });

  it('rejects what is not a manifest of this version', () => {
    expect(parseAudioManifest(null)).toBeNull();
    expect(parseAudioManifest('x')).toBeNull();
    expect(parseAudioManifest([])).toBeNull();
    expect(parseAudioManifest({ version: 2, sounds: {} })).toBeNull();
    expect(parseAudioManifest({ version: 1 })?.sounds.every((entry) => entry === null)).toBe(true);
  });

  it('drops a malformed entry and keeps the rest', () => {
    const json = sampleManifest();
    const sounds = json['sounds'] as Record<string, unknown>;
    sounds['uiClick'] = { files: ['../secrets.ogg'], gain: 0.5, loop: null };
    sounds['fireBolt'] = { files: ['https://elsewhere.example/a.ogg'], gain: 0.5, loop: null };
    sounds['victory'] = { files: ['music/victory.ogg'], gain: -1, loop: null };
    sounds['takedownBoom'] = { files: [], gain: 1, loop: null };
    sounds['hitFlesh'] = { files: ['sfx/hit.wav'], gain: 1, loop: null };
    sounds['hitRock'] = { files: ['sfx/hitRock_1.ogg'], gain: Number.NaN, loop: null };
    sounds['notASound'] = { files: ['sfx/x.ogg'], gain: 1, loop: null };
    (json['music'] as Record<string, unknown>)['lobby'] = { file: 'music/lobby.ogg', gain: 1, loop: { startS: 5, endS: 2 } };
    const manifest = parseAudioManifest(json, BASE);
    for (const id of ['uiClick', 'fireBolt', 'victory', 'takedownBoom', 'hitFlesh', 'hitRock'] as const) {
      expect(manifest?.sounds[soundIndexOf(id)], id).toBeNull();
    }
    expect(manifest?.sounds[soundIndexOf('windLoop')]).not.toBeNull();
    expect(manifest?.tracks[0]).toBeNull();
    expect(manifest?.tracks[1]).not.toBeNull();
  });

  it('a loop without loop points, or a one-shot with them, is not the sound the table expects', () => {
    const json = sampleManifest();
    const sounds = json['sounds'] as Record<string, unknown>;
    sounds['windLoop'] = { files: ['sfx/windLoop_1.ogg'], gain: 0.6, loop: null };
    sounds['uiClick'] = { files: ['sfx/uiClick_1.ogg'], gain: 0.5, loop: LOOP };
    const manifest = parseAudioManifest(json, BASE);
    expect(manifest?.sounds[soundIndexOf('windLoop')]).toBeNull();
    expect(manifest?.sounds[soundIndexOf('uiClick')]).toBeNull();
  });

  it('keeps at most MAX_VARIATIONS files of a sound', () => {
    const json = sampleManifest();
    const files = Array.from({ length: 12 }, (_, i) => `sfx/fireBolt_${i + 1}.ogg`);
    (json['sounds'] as Record<string, unknown>)['fireBolt'] = { files, gain: 1, loop: null };
    expect(parseAudioManifest(json, BASE)?.sounds[soundIndexOf('fireBolt')]?.urls.length).toBe(MAX_VARIATIONS);
  });

  it('orders loading: interface, then the local rider, then the fight', () => {
    expect(loadTier(SOUND_DEFS.uiClick)).toBe(0);
    expect(loadTier(SOUND_DEFS.victory)).toBe(0);
    expect(loadTier(SOUND_DEFS.windLoop)).toBe(1);
    expect(loadTier(SOUND_DEFS.fireBolt)).toBe(2);
    const manifest = parseAudioManifest(sampleManifest(), BASE);
    const order = manifest === null ? [] : sampleLoadOrder(manifest);
    const tiers = order.map((index) => loadTier(SOUND_DEFS[SOUND_IDS[index] as SoundId]));
    expect(tiers).toEqual([...tiers].sort((a, b) => a - b));
    expect(order.length).toBe(5);
  });
});

describe('AssetLoader', () => {
  it('fetches a few at a time, highest priority first, and reports failures as null', async () => {
    const ctx = new FakeContext();
    const server = createFakeServer({});
    server.missing.add('gone.ogg');
    ctx.undecodable.add('broken.ogg');
    const loader = new AssetLoader(server.fetch, ctx as unknown as AudioContext, 1);
    const done: string[] = [];
    const note = (name: string) => (buffer: AudioBuffer | null) => done.push(`${name}:${buffer === null ? 'null' : 'ok'}`);
    loader.request('first.ogg', 1, -1, note('first'));
    loader.request('low.ogg', 1, 7, note('low'));
    loader.request('high.ogg', 9, -1, note('high'));
    loader.request('gone.ogg', 5, -1, note('gone'));
    loader.request('broken.ogg', 4, -1, note('broken'));
    expect(loader.stats.pending).toBe(5);
    await settle();
    // The first was already in flight; the rest went by priority.
    expect(done).toEqual(['first:ok', 'high:ok', 'gone:null', 'broken:null', 'low:ok']);
    expect(server.requests).toEqual(['first.ogg', 'high.ogg', 'gone.ogg', 'broken.ogg', 'low.ogg']);
    expect(loader.stats).toMatchObject({ loaded: 3, failed: 2, pending: 0, bytes: 64 });
  });

  it('raise moves a queued group up, and dispose answers the queue with null', async () => {
    const ctx = new FakeContext();
    const server = createFakeServer({});
    const loader = new AssetLoader(server.fetch, ctx as unknown as AudioContext, 1);
    const done: string[] = [];
    loader.request('a.ogg', 5, -1, () => done.push('a'));
    loader.request('b.ogg', 5, 1, () => done.push('b'));
    loader.request('c.ogg', 1, 2, () => done.push('c'));
    loader.request('d.ogg', 3, 3, () => done.push('d'));
    loader.raise(2, 50);
    await settle();
    expect(done).toEqual(['a', 'c', 'b', 'd']);

    const late: (AudioBuffer | null)[] = [];
    loader.request('e.ogg', 1, -1, (buffer) => late.push(buffer));
    loader.request('f.ogg', 1, -1, (buffer) => late.push(buffer));
    loader.dispose();
    await settle();
    expect(late).toEqual([null, null]);
    loader.request('g.ogg', 1, -1, (buffer) => late.push(buffer));
    expect(late.length).toBe(3);
  });
});

describe('MusicIntensity', () => {
  function run(model: MusicIntensity, seconds: number, phase: 'playing' | 'countdown', health = 1, left = Infinity): number {
    let value = 0;
    for (let t = 0; t < seconds; t += 1 / 20) value = model.update(1 / 20, phase, health, left);
    return value;
  }

  it('rests at the base level in a quiet round and at zero outside one', () => {
    const model = new MusicIntensity();
    expect(run(model, 30, 'countdown')).toBeCloseTo(0, 3);
    expect(run(model, 30, 'playing')).toBeCloseTo(INTENSITY_TUNING.base, 2);
    expect(run(model, 60, 'countdown')).toBeLessThan(0.01);
  });

  it('takedowns heat it up and it cools off again', () => {
    const model = new MusicIntensity();
    run(model, 20, 'playing');
    model.takedown(false);
    model.takedown(true);
    const hot = run(model, 3, 'playing');
    expect(hot).toBeGreaterThan(0.6);
    const cooled = run(model, 60, 'playing');
    expect(cooled).toBeLessThan(INTENSITY_TUNING.base + 0.03);
  });

  it('low health and the last seconds raise it, and it never leaves 0..1', () => {
    const calm = run(new MusicIntensity(), 20, 'playing');
    expect(run(new MusicIntensity(), 20, 'playing', 0.1)).toBeGreaterThan(calm + 0.2);
    expect(run(new MusicIntensity(), 20, 'playing', 1, 5)).toBeGreaterThan(calm + 0.4);
    const model = new MusicIntensity();
    for (let i = 0; i < 20; i++) model.takedown(true);
    expect(run(model, 5, 'playing', 0.05, 1)).toBeLessThanOrEqual(1);
    expect(model.update(Number.NaN, 'playing', Number.NaN, Number.NaN)).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(model.value)).toBe(true);
  });

  it('rises faster than it falls', () => {
    const up = new MusicIntensity();
    for (let i = 0; i < 4; i++) up.takedown(true);
    const afterOne = run(up, 1, 'playing');
    expect(afterOne).toBeGreaterThan(0.45);
    const down = new MusicIntensity();
    for (let i = 0; i < 4; i++) down.takedown(true);
    run(down, 6, 'playing');
    const high = down.value;
    expect(run(down, 1, 'countdown')).toBeGreaterThan(high * 0.75);
  });

  it('layer gains are an equal-power cross-fade', () => {
    const out = new Float32Array(2);
    layerGains(0, out);
    expect([out[0], out[1]]).toEqual([1, 0]);
    layerGains(1, out);
    expect(out[0]).toBeCloseTo(0, 6);
    expect(out[1]).toBeCloseTo(1, 6);
    for (const t of [0.1, 0.37, 0.5, 0.9]) {
      layerGains(t, out);
      expect((out[0] ?? 0) ** 2 + (out[1] ?? 0) ** 2).toBeCloseTo(1, 5);
    }
    layerGains(7, out);
    expect(out[1]).toBeCloseTo(1, 6);
  });
});

describe('track player', () => {
  function rig(): {
    ctx: FakeContext;
    server: FakeServer;
    music: FakeGain;
    ambience: FakeGain;
    changes: { count: number };
    player: ReturnType<typeof createTrackPlayer>;
    tracks: (AudioTrack | null)[];
  } {
    const ctx = new FakeContext();
    const server = createFakeServer({});
    const loader = new AssetLoader(server.fetch, ctx as unknown as AudioContext);
    const music = new FakeGain('gain');
    const ambience = new FakeGain('gain');
    const changes = { count: 0 };
    const player = createTrackPlayer(
      ctx as unknown as AudioContext,
      music as unknown as AudioNode,
      ambience as unknown as AudioNode,
      loader,
      () => changes.count++,
    );
    const tracks = [...(parseAudioManifest(sampleManifest(), BASE)?.tracks ?? [])];
    return { ctx, server, music, ambience, changes, player, tracks };
  }

  /** The gain node a source feeds. */
  function gainOf(source: FakeSource): FakeGain {
    return source.outputs[0] as FakeGain;
  }

  it('plays the lobby theme and the aerie bed outside a match, looping between the loop points', async () => {
    const { ctx, server, player, tracks, changes } = rig();
    player.setTracks(tracks);
    expect(player.musicPlaying()).toBe(false);
    await settle();
    expect(server.requests.sort()).toEqual([`${BASE}ambience/aerie.ogg`, `${BASE}music/lobby.ogg`]);
    expect(player.playingCount()).toBe(2);
    expect(player.musicPlaying()).toBe(true);
    expect(changes.count).toBe(1);
    const lobby = ctx.playingFile('lobby')[0] as FakeSource;
    expect(lobby.loop).toBe(true);
    expect(lobby.loopStart).toBe(0.5);
    expect(lobby.loopEnd).toBe(58.68);
    expect(lobby.startOffset).toBe(0.5);
    expect(gainOf(lobby).gain.value).toBeCloseTo(0.8, 5);
    // Title -> lobby keeps the same tracks running.
    player.setScene('lobby');
    await settle();
    expect(ctx.sources.length).toBe(2);
  });

  it('switches to the match layers, started together, and drops the lobby buffer', async () => {
    const { ctx, player, tracks } = rig();
    player.setTracks(tracks);
    await settle();
    const lobby = ctx.playingFile('lobby')[0] as FakeSource;
    player.setScene('match');
    expect(lobby.stopped).toBe(true);
    expect(gainOf(lobby).gain.value).toBe(0);
    expect(player.musicPlaying()).toBe(false);
    await settle();
    const low = ctx.playingFile('matchLow')[0] as FakeSource;
    const high = ctx.playingFile('matchHigh')[0] as FakeSource;
    expect(low.startWhen).toBe(high.startWhen);
    expect(low.startOffset).toBe(high.startOffset);
    expect(ctx.playingFile('windBed').length).toBe(1);
    expect(ctx.playingFile('thunder').length).toBe(1);
    expect(player.playingCount()).toBe(4);
    // Calm at first: the battle layer is silent.
    expect(gainOf(low).gain.value).toBeCloseTo(0.8, 5);
    expect(gainOf(high).gain.value).toBeCloseTo(0, 5);
    // Back to the lobby: the theme is fetched and started again.
    player.setScene('lobby');
    await settle();
    expect(ctx.playingFile('lobby').length).toBe(2);
    expect(low.stopped && high.stopped).toBe(true);
  });

  it('cross-fades the layers with intensity, and only when it moved enough to hear', async () => {
    const { ctx, player, tracks } = rig();
    player.setTracks(tracks);
    player.setScene('match');
    await settle();
    const low = gainOf(ctx.playingFile('matchLow')[0] as FakeSource);
    const high = gainOf(ctx.playingFile('matchHigh')[0] as FakeSource);
    player.setIntensity(1);
    expect(low.gain.value).toBeCloseTo(0, 5);
    expect(high.gain.value).toBeCloseTo(0.8, 5);
    player.setIntensity(0.5);
    expect(low.gain.value).toBeCloseTo(0.8 * Math.SQRT1_2, 5);
    expect(high.gain.value).toBeCloseTo(0.8 * Math.SQRT1_2, 5);
    const sent = low.gain.events.length;
    for (let i = 0; i < 100; i++) player.setIntensity(0.5 + TRACK_TUNING.layerStep * 0.4);
    expect(low.gain.events.length).toBe(sent);
  });

  it('a layer that fails to load leaves the other playing, and Low drops the thunder bed', async () => {
    const { ctx, server, player, tracks } = rig();
    server.missing.add(`${BASE}music/matchHigh.ogg`);
    player.setLowDetail(true);
    player.setTracks(tracks);
    player.setScene('match');
    await settle();
    expect(ctx.playingFile('matchLow').length).toBe(1);
    expect(ctx.playingFile('matchHigh').length).toBe(0);
    expect(ctx.playingFile('thunder').length).toBe(0);
    expect(server.requests.some((url) => url.includes('thunder'))).toBe(false);
    expect(player.musicPlaying()).toBe(true);
    player.setLowDetail(false);
    await settle();
    expect(ctx.playingFile('thunder').length).toBe(1);
  });

  it('ducks the music bus and schedules its return', async () => {
    const { ctx, music, player, tracks } = rig();
    player.setTracks(tracks);
    await settle();
    const lobby = ctx.playingFile('lobby')[0] as FakeSource;
    const duck = gainOf(lobby).outputs[0] as FakeGain;
    expect(duck.outputs[0]).toBe(music);
    ctx.currentTime = 10;
    player.duck(0.1, 4);
    expect(duck.gain.events.slice(-2)).toEqual([
      { kind: 'target', value: 0.1, time: 10 },
      { kind: 'target', value: 1, time: 14 },
    ]);
  });

  it('stops everything on dispose and ignores a decode that arrives afterwards', async () => {
    const { ctx, player, tracks } = rig();
    player.setTracks(tracks);
    player.dispose();
    await settle();
    expect(ctx.sources.length).toBe(0);
    expect(player.playingCount()).toBe(0);
  });
});

// --- Engine ----------------------------------------------------------------------------------------

const CAMERA: AudioListener = {
  position: { x: 0, y: 0, z: 0 },
  forward: { x: 0, y: 0, z: 1 },
  up: { x: 0, y: 1, z: 0 },
};
const LOCAL_ID = 3;
const engines: AudioEngine[] = [];

afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose();
});

async function engineRig(
  manifest: unknown = sampleManifest(),
  quality: 'low' | 'medium' | 'high' = 'medium',
  prepare?: (server: FakeServer, ctx: FakeContext) => void,
): Promise<{ audio: AudioEngine; ctx: FakeContext; server: FakeServer }> {
  const ctx = new FakeContext();
  const server = createFakeServer(manifest);
  prepare?.(server, ctx);
  const audio = createAudio({
    quality,
    prerender: 'now',
    createContext: () => ctx as unknown as AudioContext,
    assets: { fetch: server.fetch },
  });
  engines.push(audio);
  audio.unlock();
  await settle();
  return { audio, ctx, server };
}

function localView(health = 1, speedZ = 60, sinkY = 0): MutableWorldView {
  const view = createWorldView();
  beginWorldView(view);
  view.localDragonId = LOCAL_ID;
  view.clock.phase = 'playing';
  const dragon = acquireDragonView(view);
  dragon.id = LOCAL_ID;
  dragon.team = TEAM_EMBER;
  dragon.classId = 'talon';
  dragon.position.x = 0;
  dragon.position.y = 0;
  dragon.position.z = 5;
  dragon.velocity.x = 0;
  dragon.velocity.y = sinkY;
  dragon.velocity.z = speedZ;
  dragon.health = health;
  dragon.flags = DRAGON_FLAG_ALIVE;
  return view;
}

function frames(audio: AudioEngine, ctx: FakeContext, view: MutableWorldView, count: number): void {
  for (let i = 0; i < count; i++) {
    ctx.currentTime += 1 / 60;
    audio.update(view, CAMERA, 1 / 60);
  }
}

describe('engine with real files', () => {
  it('fetches the manifest after the first gesture, the interface sounds first', async () => {
    const { audio, server } = await engineRig();
    expect(server.requests[0]).toBe(`${BASE}manifest.json`);
    const files = server.requests.slice(1);
    // On the title screen: music and the interface and local tiers, not yet the fight.
    expect(files).toContain(`${BASE}music/lobby.ogg`);
    expect(files).toContain(`${BASE}sfx/uiClick_1.ogg`);
    expect(files).toContain(`${BASE}sfx/windLoop_1.ogg`);
    expect(files.some((url) => url.includes('fireBolt'))).toBe(false);
    expect(files.indexOf(`${BASE}sfx/uiClick_1.ogg`)).toBeLessThan(files.indexOf(`${BASE}sfx/windLoop_1.ogg`));
    const stats = audio.stats();
    expect(stats.samplesReady).toBe(3);
    expect(stats.samplesFailed).toBe(0);
    expect(stats.tracksPlaying).toBe(2);
    expect(stats.assetBytes).toBeGreaterThan(0);
    // Entering the lobby brings in the fight.
    audio.setScene('lobby');
    await settle();
    expect(server.requests).toContain(`${BASE}sfx/fireBolt_2.ogg`);
    expect(audio.stats().samplesReady).toBe(5);
    expect(audio.stats().errors).toBe(0);
  });

  it('plays the decoded file with its base gain, and never the same variation twice running', async () => {
    const { audio, ctx } = await engineRig();
    const picks: string[] = [];
    const levels: number[] = [];
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 1;
      const before = ctx.sources.length;
      audio.playUi('click');
      const source = ctx.sources[before] as FakeSource;
      picks.push(ctx.urlOf(source) ?? 'placeholder');
      levels.push(((source.outputs[0] as FakeGain).outputs[0] as FakeGain).gain.value);
      source.finish();
    }
    expect(new Set(picks)).toEqual(
      new Set([`${BASE}sfx/uiClick_1.ogg`, `${BASE}sfx/uiClick_2.ogg`, `${BASE}sfx/uiClick_3.ogg`]),
    );
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    // UI sounds have no pitch jitter, so no gain jitter either: def gain x manifest gain.
    for (const level of levels) expect(level).toBeCloseTo(SOUND_DEFS.uiClick.gain * 0.5, 5);
  });

  it('spreads the gain a little on sounds that vary', async () => {
    const { audio, ctx } = await engineRig();
    audio.setScene('match');
    await settle();
    const view = localView();
    frames(audio, ctx, view, 2);
    const levels = new Set<number>();
    for (let i = 0; i < 12; i++) {
      ctx.currentTime += 1;
      const before = ctx.sources.length;
      audio.playLocalCast('talon', 'primary');
      const source = ctx.sources[before] as FakeSource;
      expect(ctx.urlOf(source)).toContain('fireBolt');
      const level = ((source.outputs[0] as FakeGain).outputs[0] as FakeGain).gain.value;
      const centre = SOUND_DEFS.fireBolt.gain * 0.8;
      expect(Math.abs(level / centre - 1)).toBeLessThanOrEqual(AUDIO_TUNING.gainJitter + 1e-6);
      levels.add(Math.round(level * 1e5));
      source.finish();
    }
    expect(levels.size).toBeGreaterThan(4);
  });

  it('falls back to the procedural sound for a file that is missing or cannot be decoded', async () => {
    const { audio, ctx } = await engineRig(sampleManifest(), 'medium', (server, context) => {
      for (let v = 1; v <= 3; v++) server.missing.add(`${BASE}sfx/uiClick_${v}.ogg`);
      context.undecodable.add(`${BASE}sfx/windLoop_1.ogg`);
    });
    const stats = audio.stats();
    expect(stats.samplesFailed).toBe(2);
    expect(stats.errors).toBe(0);
    audio.playUi('click');
    const source = ctx.sources[ctx.sources.length - 1] as FakeSource;
    expect(source.started).toBe(true);
    expect(ctx.urlOf(source)).toBeUndefined();
    expect(source.buffer?.length).toBeGreaterThan(100);
  });

  it('stays procedural with no manifest, a broken one, or assets turned off', async () => {
    for (const manifest of [null, { version: 99 }, 'nonsense']) {
      const { audio, ctx, server } = await engineRig(manifest);
      expect(server.requests).toEqual([`${BASE}manifest.json`]);
      audio.playUi('click');
      expect(ctx.urlOf(ctx.sources[0] as FakeSource)).toBeUndefined();
      expect(audio.stats().errors).toBe(0);
      expect(audio.stats().tracksPlaying).toBe(0);
    }
    const ctx = new FakeContext();
    const server = createFakeServer(sampleManifest());
    const audio = createAudio({ prerender: 'now', createContext: () => ctx as unknown as AudioContext, assets: null });
    engines.push(audio);
    audio.unlock();
    await settle();
    expect(server.requests.length).toBe(0);
    audio.playUi('click');
    expect(ctx.sources.length).toBe(1);
  });

  it('a sound asked for before its turn jumps the queue and plays its placeholder meanwhile', async () => {
    // Still on the title screen: the fight tier has not been asked for.
    const { audio, ctx, server } = await engineRig();
    expect(server.requests.some((url) => url.includes('takedownBoom'))).toBe(false);
    audio.setScene('match');
    const view = localView();
    frames(audio, ctx, view, 1);
    const before = ctx.sources.length;
    audio.onEvent({ type: 'takedown', tick: 1, killerId: 9, victimId: 8, source: 'primary', position: { x: 0, y: 0, z: 20 } });
    const boom = ctx.sources[before] as FakeSource;
    expect(ctx.urlOf(boom)).toBeUndefined();
    await settle();
    expect(server.requests).toContain(`${BASE}sfx/takedownBoom_1.ogg`);
    ctx.currentTime += 5;
    const next = ctx.sources.length;
    audio.onEvent({ type: 'takedown', tick: 2, killerId: 9, victimId: 8, source: 'primary', position: { x: 0, y: 0, z: 20 } });
    expect(ctx.urlOf(ctx.sources[next] as FakeSource)).toContain('takedownBoom_1.ogg');
  });

  it('loops a real loop between its loop points and keeps its level tied to the file gain', async () => {
    const { audio, ctx } = await engineRig();
    audio.setScene('match');
    await settle();
    const view = localView(1, 95);
    frames(audio, ctx, view, 12);
    const wind = ctx.playingFile('windLoop')[0] as FakeSource;
    expect(wind.loop).toBe(true);
    expect(wind.loopStart).toBe(LOOP.startS);
    expect(wind.loopEnd).toBe(LOOP.endS);
    expect(wind.startOffset).toBe(LOOP.startS);
    const gain = (wind.outputs[0] as FakeGain).outputs[0] as FakeGain;
    // Full speed: def gain x wind gain 1 x manifest gain 0.6.
    expect(gain.gain.value).toBeCloseTo(SOUND_DEFS.windLoop.gain * 0.6, 4);
  });

  it('a loop already running on its placeholder moves to the real file when it arrives', async () => {
    let release: (() => void) | null = null;
    const ctx = new FakeContext();
    const server = createFakeServer(sampleManifest());
    const held: FetchLikeResult[] = [];
    type FetchLikeResult = Awaited<ReturnType<typeof server.fetch>>;
    const slowFetch: typeof server.fetch = (url) => {
      if (!url.includes('windLoop')) return server.fetch(url);
      return new Promise((resolvePromise) => {
        release = () => {
          void server.fetch(url).then((response) => {
            held.push(response);
            resolvePromise(response);
          });
        };
      });
    };
    const audio = createAudio({ prerender: 'now', createContext: () => ctx as unknown as AudioContext, assets: { fetch: slowFetch } });
    engines.push(audio);
    audio.unlock();
    audio.setScene('match');
    await settle();
    const view = localView();
    frames(audio, ctx, view, 12);
    const placeholder = ctx.sources.find((source) => source.loop && ctx.urlOf(source) === undefined) as FakeSource;
    expect(placeholder).toBeDefined();
    expect(ctx.playingFile('windLoop').length).toBe(0);
    (release as (() => void) | null)?.();
    await settle();
    expect(placeholder.stopped).toBe(true);
    frames(audio, ctx, view, 12);
    expect(ctx.playingFile('windLoop').length).toBe(1);
    expect(held.length).toBe(1);
  });

  it('rests the pad while a music track plays and switches music with the scene', async () => {
    const { audio, ctx } = await engineRig();
    expect(ctx.playingFile('lobby').length).toBe(1);
    audio.setScene('match');
    await settle();
    expect(ctx.playingFile('matchLow').length).toBe(1);
    expect(ctx.playingFile('matchHigh').length).toBe(1);
    expect(audio.stats().tracksPlaying).toBe(4);
    audio.setScene('lobby');
    await settle();
    expect(audio.stats().tracksPlaying).toBe(2);

    // Without files the pad is the music; with them it rests.
    const bare = new FakeContext();
    const silent = createAudio({ prerender: 'now', createContext: () => bare as unknown as AudioContext, assets: null });
    engines.push(silent);
    silent.unlock();
    const padLevels = (context: FakeContext): number[] =>
      context.gains.map((gain) => gain.gain.events.filter((e) => e.kind === 'target').pop()?.value ?? -1);
    expect(padLevels(bare)).toContain(AUDIO_TUNING.pad.title.gain);
    expect(padLevels(ctx)).not.toContain(AUDIO_TUNING.pad.lobby.gain);
  });

  it('raises the battle layer on takedowns and low health, and resets on leaving the match', async () => {
    const { audio, ctx } = await engineRig();
    audio.setScene('match');
    await settle();
    const high = (ctx.playingFile('matchHigh')[0] as FakeSource).outputs[0] as FakeGain;
    const calm = localView();
    frames(audio, ctx, calm, 600);
    const quiet = audio.stats().intensity;
    expect(quiet).toBeCloseTo(INTENSITY_TUNING.base, 1);
    const quietLevel = high.gain.value;
    for (let i = 0; i < 3; i++) {
      audio.onEvent({ type: 'takedown', tick: i, killerId: LOCAL_ID, victimId: 8, source: 'primary', position: { x: 0, y: 0, z: 9000 } });
    }
    frames(audio, ctx, calm, 240);
    expect(audio.stats().intensity).toBeGreaterThan(0.7);
    expect(high.gain.value).toBeGreaterThan(quietLevel * 2);
    const hurt = localView(0.08);
    frames(audio, ctx, hurt, 60);
    expect(audio.stats().intensity).toBeGreaterThan(0.8);
    audio.setScene('lobby');
    expect(audio.stats().intensity).toBe(0);
  });

  it('ducks the music under a result sting', async () => {
    const { audio, ctx } = await engineRig();
    audio.setScene('match');
    await settle();
    const low = ctx.playingFile('matchLow')[0] as FakeSource;
    const duck = (low.outputs[0] as FakeGain).outputs[0] as FakeGain;
    const view = localView();
    frames(audio, ctx, view, 2);
    const before = duck.gain.events.length;
    audio.onEvent({ type: 'matchPhase', tick: 1, phase: 'results', round: 1, winner: TEAM_EMBER });
    const played = ctx.sources[ctx.sources.length - 1] as FakeSource;
    expect(ctx.urlOf(played)).toContain('music/victory.ogg');
    const events = duck.gain.events.slice(before);
    expect(events.length).toBe(2);
    expect(events[0]?.value).toBeCloseTo(MUSIC_DUCKS.victory?.to ?? -1, 5);
    expect(events[1]?.value).toBe(1);
    expect((events[1]?.time ?? 0) - (events[0]?.time ?? 0)).toBeCloseTo(MUSIC_DUCKS.victory?.holdS ?? 0, 5);
  });

  it('adds the dive rush in a steep fast dive only', async () => {
    const { audio, ctx } = await engineRig({ version: 1 });
    audio.setScene('match');
    const level = localView(1, 95, 0);
    frames(audio, ctx, level, 12);
    const loopsBefore = ctx.sources.filter((source) => source.loop).length;
    const diving = localView(1, 60, -70);
    frames(audio, ctx, diving, 12);
    expect(ctx.sources.filter((source) => source.loop).length).toBe(loopsBefore + 1);
    const rush = ctx.sources[ctx.sources.length - 1] as FakeSource;
    frames(audio, ctx, level, 12);
    expect(rush.stopped).toBe(true);
  });

  it('Low keeps the thunder bed out; the voice cap still follows the preset', async () => {
    const { audio, ctx } = await engineRig(sampleManifest(), 'low');
    audio.setScene('match');
    await settle();
    expect(ctx.playingFile('thunder').length).toBe(0);
    expect(audio.stats().tracksPlaying).toBe(3);
    expect(audio.stats().capacity).toBe(QUALITY_PRESETS.low.audioVoices);
    audio.setQuality('high');
    await settle();
    expect(ctx.playingFile('thunder').length).toBe(1);
  });

  it('dispose stops the tracks and nothing plays afterwards', async () => {
    const { audio, ctx } = await engineRig();
    const lobby = ctx.playingFile('lobby')[0] as FakeSource;
    audio.dispose();
    expect(lobby.stopped).toBe(true);
    const count = ctx.sources.length;
    audio.playUi('click');
    audio.setScene('match');
    await settle();
    expect(ctx.sources.length).toBe(count);
  });
});

// --- The shipped files -----------------------------------------------------------------------------

describe('public/assets/audio', () => {
  const dir = resolve(__dirname, '../../public/assets/audio');
  const path = resolve(dir, 'manifest.json');
  const present = existsSync(path);
  const raw: unknown = present ? JSON.parse(readFileSync(path, 'utf8')) : null;

  it.runIf(present)('lists a real file for every sound and track, and parses cleanly', () => {
    const manifest = parseAudioManifest(raw, '');
    expect(manifest).not.toBeNull();
    for (const id of SOUND_IDS) {
      const set = manifest?.sounds[soundIndexOf(id)];
      expect(set, id).not.toBeNull();
      expect(set?.loop !== null, id).toBe(SOUND_DEFS[id].loop);
      for (const url of set?.urls ?? []) expect(existsSync(resolve(dir, url)), url).toBe(true);
      expect(set?.gain, id).toBeGreaterThan(0.1);
      expect(set?.gain, id).toBeLessThanOrEqual(1.6);
    }
    for (let i = 0; i < TRACK_IDS.length; i++) {
      const track = manifest?.tracks[i];
      expect(track, TRACK_IDS[i]).not.toBeNull();
      expect(existsSync(resolve(dir, track?.url ?? 'missing')), TRACK_IDS[i]).toBe(true);
    }
    // The two match layers must be the same length to cross-fade in step.
    const low = manifest?.tracks[1]?.loop;
    const high = manifest?.tracks[2]?.loop;
    expect(low).toEqual(high);
  });

  it.runIf(present)('has no entry the sound table does not know', () => {
    const sounds = (raw as { sounds: Record<string, unknown> }).sounds;
    const known = new Set<string>(SOUND_IDS);
    for (const id of Object.keys(sounds)) expect(known.has(id), id).toBe(true);
  });

  it.runIf(present)('stays inside the audio budget', () => {
    const manifest = parseAudioManifest(raw, '');
    const files = new Set<string>();
    for (const set of manifest?.sounds ?? []) for (const url of set?.urls ?? []) files.add(url);
    for (const track of manifest?.tracks ?? []) if (track) files.add(track.url);
    let total = statSync(path).size;
    for (const file of files) total += statSync(resolve(dir, file)).size;
    expect(total).toBeLessThanOrEqual(ASSET_BUDGETS.mapMaxAudioBytes);
    expect(files.size).toBeGreaterThan(100);
  });
});
