/**
 * A small fake WebAudio and fetch for the asset tests (node has neither): enough of the graph to
 * see which buffer plays where, how gains were last set, and to hand out "decoded" buffers that
 * remember the URL they came from.
 */

import type { FetchLike } from '../../src/audio';

export class FakeParam {
  value: number;
  /** Every scheduled change, in call order. */
  readonly events: { kind: 'set' | 'target'; value: number; time: number }[] = [];
  constructor(value = 0) {
    this.value = value;
  }
  setValueAtTime(value: number, time = 0): this {
    this.value = value;
    this.events.push({ kind: 'set', value, time });
    return this;
  }
  setTargetAtTime(value: number, time = 0): this {
    this.value = value;
    this.events.push({ kind: 'target', value, time });
    return this;
  }
  cancelScheduledValues(): this {
    return this;
  }
}

export class FakeNode {
  outputs: unknown[] = [];
  constructor(readonly kind: string) {}
  connect(target: unknown): unknown {
    this.outputs.push(target);
    return target;
  }
  disconnect(): void {
    this.outputs = [];
  }
}

export class FakeGain extends FakeNode {
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
  start(): void {}
  stop(): void {}
}

export interface FakeBuffer {
  readonly length: number;
  readonly sampleRate: number;
  /** Set on buffers that came out of `decodeAudioData`. */
  readonly url?: string;
  getChannelData(channel: number): Float32Array;
}

export class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeParam(1);
  onended: ((event: { target: unknown }) => void) | null = null;
  started = false;
  startWhen: number | undefined;
  startOffset: number | undefined;
  stopped = false;
  stopAt: number | undefined;
  constructor() {
    super('source');
  }
  start(when?: number, offset?: number): void {
    this.started = true;
    this.startWhen = when;
    this.startOffset = offset;
  }
  stop(when?: number): void {
    this.stopped = true;
    this.stopAt = when;
  }
  finish(): void {
    this.onended?.({ target: this });
  }
}

/** Marks a fetched body with its URL so the decoder can label the buffer it makes. */
const BODY_URLS = new WeakMap<ArrayBuffer, string>();

export class FakeContext {
  currentTime = 0;
  readonly sampleRate = 48_000;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly destination = new FakeNode('destination');
  readonly sources: FakeSource[] = [];
  readonly gains: FakeGain[] = [];
  /** URLs whose decode should fail. */
  readonly undecodable = new Set<string>();
  decoded = 0;

  createGain(): FakeGain {
    const gain = new FakeGain('gain');
    this.gains.push(gain);
    return gain;
  }
  createBiquadFilter(): FakeFilter {
    return new FakeFilter('filter');
  }
  createStereoPanner(): FakePanner {
    return new FakePanner('panner');
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor('compressor');
  }
  createOscillator(): FakeOscillator {
    return new FakeOscillator('oscillator');
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const data = new Float32Array(length);
    return { length, sampleRate, getChannelData: () => data };
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    const url = BODY_URLS.get(data) ?? '';
    if (this.undecodable.has(url)) return Promise.reject(new Error('cannot decode'));
    this.decoded++;
    const samples = new Float32Array(480);
    return Promise.resolve({ length: 480, sampleRate: 48_000, url, getChannelData: () => samples });
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

  /** URL of the file a source is playing; undefined for a procedural placeholder. */
  urlOf(source: FakeSource): string | undefined {
    return source.buffer?.url;
  }
  /** Sources that started on a decoded file whose URL contains `part`. */
  playingFile(part: string): FakeSource[] {
    return this.sources.filter((source) => source.started && (source.buffer?.url ?? '').includes(part));
  }
}

export interface FakeServer {
  readonly fetch: FetchLike;
  /** Every URL asked for, in order. */
  readonly requests: string[];
  /** URLs answered with a 404. */
  readonly missing: Set<string>;
}

/** Serves `manifest` at `<base>manifest.json` and a few bytes for every other URL. */
export function createFakeServer(manifest: unknown, base = 'assets/audio/'): FakeServer {
  const requests: string[] = [];
  const missing = new Set<string>();
  const fetch: FetchLike = (url) => {
    requests.push(url);
    const ok = !missing.has(url);
    return Promise.resolve({
      ok,
      json: () => Promise.resolve(url === `${base}manifest.json` ? manifest : null),
      arrayBuffer: () => {
        const body = new ArrayBuffer(16);
        BODY_URLS.set(body, url);
        return Promise.resolve(body);
      },
    });
  };
  return { fetch, requests, missing };
}

/** Lets queued promise callbacks (fetch -> decode -> engine) run to completion. */
export async function settle(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}
