/**
 * dev/netsim: artificial latency, jitter, loss, duplication and reordering for any transport
 * (docs/NETWORKING.md, "Testing multiplayer alone").
 *
 * A `Netsim` owns the conditions, a seeded PRNG, a clock and one pooled delay queue.
 * `wrapHost` / `wrapClient` return transports with the ordinary `HostTransport` /
 * `ClientTransport` interfaces, so sessions cannot tell the difference:
 *
 *     const netsim = createNetsim({ profile: flags.netsim ?? NETSIM_PROFILES.off });
 *     const transport = netsim.wrapClient(createPeerJsClientTransport(config));
 *     // every frame (or sim tick):
 *     netsim.pump(performance.now());
 *
 * What it does to traffic:
 *
 * - Both directions are simulated at the wrapped end: `outbound` conditions delay what the app
 *   sends before it reaches the inner transport, `inbound` conditions delay what the inner
 *   transport received before the app sees it. Wrap ONE end of a link, or the conditions add up.
 * - `fast`: each message gets its own delay (latency ± jitter), so jitter alone reorders. It can
 *   also be lost, duplicated, or held back by an extra reorder delay.
 * - `ctrl`: delayed only. Never lost, duplicated or reordered: a message is never due before the
 *   one sent before it on the same link and direction.
 * - Messages whose delay comes out as 0 (the `off` profile) pass straight through with no copy
 *   and no queueing, so an idle netsim costs a few branches.
 * - Connection events (`onOpen`, `onPeerConnected`, `onClose`, `onError`) are not delayed.
 *   Closing a link first hands queued outbound `ctrl` messages to the inner transport (a
 *   `reject` or `kick` sent just before `close` still goes out), and a link that ends remotely
 *   first delivers its queued inbound `ctrl` messages. Queued `fast` messages of a dead link
 *   are discarded.
 *
 * Delivery happens only inside `pump(nowMs)`: no timers, so background-tab throttling cannot
 * distort it and tests run on a manual clock. `startNetsimTimer` exists for pages without a
 * frame loop.
 *
 * Garbage: slots are pre-allocated and message bytes are copied into buffers pooled by exact
 * length, so steady traffic allocates nothing. With `recycleBuffers` (default on) a delivered
 * inbound `ArrayBuffer` is reused after `onMessage` returns, exactly as the transport contract
 * allows; turn it off if a receiver keeps buffers.
 */

import type {
  Channel,
  ClientTransport,
  ClientTransportHandlers,
  DisconnectReason,
  HostTransport,
  HostTransportHandlers,
  LinkId,
  TransportMessage,
  TransportPayload,
  TransportState,
} from '../../net/transport/transport';
import { NOOP_CLIENT_HANDLERS, NOOP_HOST_HANDLERS } from '../../net/transport/transport';
import { NETSIM_PROFILES } from './profile';
import type { NetsimProfile } from './profile';
import { createNetStats, recordDropped, recordReceived, recordSent, updateNetStats } from './stats';
import type { NetStats } from './stats';

/** `uniform`: flat within ± jitter. `normal`: bell-shaped (sum of three uniforms), same bounds. */
export type JitterShape = 'uniform' | 'normal';

export const JITTER_SHAPES: readonly JitterShape[] = ['uniform', 'normal'];

/** Live conditions of one direction. Plain mutable numbers: change them at any time. */
export interface NetsimSettings {
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
  duplicatePct: number;
  reorderPct: number;
  /** Extra delay of a packet picked by `reorderPct`. */
  reorderDelayMs: number;
  jitterShape: JitterShape;
}

export type NetsimDirection = 'both' | 'outbound' | 'inbound';

export interface NetsimCounters {
  /** `fast` messages removed by simulated loss. */
  lost: number;
  duplicated: number;
  reordered: number;
  /** `fast` messages evicted because the delay queue was full. */
  overflowDropped: number;
  /** Queued messages thrown away because their link ended first. */
  discarded: number;
  /** Highest number of messages waiting at once. */
  peakQueued: number;
}

export interface NetsimOptions {
  /** Starting conditions for both directions. Default: `off`. */
  readonly profile?: NetsimProfile;
  /** PRNG seed. The same seed and the same traffic give the same losses and delays. */
  readonly seed?: number;
  /**
   * Clock in ms, read once per message and once per `pump()` without an argument. Default
   * `performance.now()`, which costs one boxed number per call in V8; a game loop that wants
   * zero garbage passes a function returning its cached frame or tick time. Tests pass a
   * manual clock.
   */
  readonly now?: () => number;
  /**
   * Most `fast` messages that may wait at once. When full, the oldest waiting `fast` message is
   * dropped to make room. `ctrl` messages are never dropped; the pool grows for them instead.
   */
  readonly capacity?: number;
  /** Reuse delivered inbound buffers (see the file comment). Default true. */
  readonly recycleBuffers?: boolean;
  /** Counters to feed instead of a private struct, e.g. the one the perf HUD already shows. */
  readonly stats?: NetStats;
}

export const DEFAULT_NETSIM_CAPACITY = 4096;
export const DEFAULT_NETSIM_SEED = 0x0d5a601f;
export const DEFAULT_REORDER_DELAY_MS = 40;

const DIR_OUT = 0;
const DIR_IN = 1;
type Dir = typeof DIR_OUT | typeof DIR_IN;

/** Copies at or below this size use a plain loop (no temporary sub-view to allocate). */
const LOOP_COPY_MAX = 2048;
const POOL_MAX_PER_SIZE = 128;
const POOL_MAX_SIZES = 256;

/** One live link of one wrapped transport. Queued slots point at it; `alive` outlives the map. */
class LinkState {
  alive = true;
  /** Per direction: when the last queued `ctrl` message is due (keeps `ctrl` in order). */
  readonly lastCtrlDue = new Float64Array(2);
  pendingCtrlOut = 0;
  pendingCtrlIn = 0;

  constructor(readonly link: LinkId) {}
}

/** What the queue needs from a wrapper to finish a delayed message. */
interface Endpoint {
  emitOut(link: LinkId, channel: Channel, data: TransportPayload): boolean;
  emitIn(link: LinkId, channel: Channel, data: TransportMessage): void;
}

/**
 * Free buffers of one length. A counted stack instead of `push` / `pop`: V8 trims an array's
 * backing store when `pop` empties it, so a pool that hovers around empty would reallocate it
 * on every packet.
 */
interface BufferStack {
  readonly items: Uint8Array<ArrayBuffer>[];
  count: number;
}

/** Indices into the `t` scratch array of `Netsim`. */
const T_NOW = 0;
const T_DELAY = 1;
const T_DUE = 2;

const RANDOM_RANGE = 2 ** 30;
const RANDOM_TO_UNIT = 1 / RANDOM_RANGE;
const PERCENT_TO_RANDOM = RANDOM_RANGE / 100;

/** One waiting message. Pooled: fields are overwritten on reuse. Its due time is `due[id]`. */
interface Slot {
  readonly id: number;
  seq: number;
  owner: Endpoint | null;
  state: LinkState | null;
  dir: Dir;
  channel: Channel;
  text: string | null;
  bytes: Uint8Array<ArrayBuffer> | null;
  size: number;
}

function createSettings(): NetsimSettings {
  return {
    latencyMs: 0,
    jitterMs: 0,
    lossPct: 0,
    duplicatePct: 0,
    reorderPct: 0,
    reorderDelayMs: DEFAULT_REORDER_DELAY_MS,
    jitterShape: 'uniform',
  };
}

function applyProfile(settings: NetsimSettings, profile: NetsimProfile): void {
  settings.latencyMs = profile.latencyMs;
  settings.jitterMs = profile.jitterMs;
  settings.lossPct = profile.lossPct;
  settings.duplicatePct = profile.duplicatePct;
  settings.reorderPct = profile.reorderPct;
}

function defaultNow(): number {
  return performance.now();
}

export class Netsim {
  /** Conditions for what the app sends. */
  readonly outbound: NetsimSettings = createSettings();
  /** Conditions for what the app receives. */
  readonly inbound: NetsimSettings = createSettings();
  /**
   * Traffic as the app sees it at the wrapped end: `sent` is what it handed to `send`,
   * `received` what reached its `onMessage`, `dropped` what the simulation removed in either
   * direction. Rates are refreshed by `pump`.
   */
  readonly stats: NetStats;
  readonly counters: NetsimCounters = {
    lost: 0,
    duplicated: 0,
    reordered: 0,
    overflowDropped: 0,
    discarded: 0,
    peakQueued: 0,
  };
  readonly capacity: number;
  readonly now: () => number;
  /** Name of the profile last applied with `setProfile` (the debug panel shows it). */
  profileName: string;

  private readonly recycle: boolean;
  private randomState: number;
  /** Scratch times in ms: now, sampled delay, due (see `route`). */
  private readonly t = new Float64Array(3);
  /** Binary min-heap by (due, seq) in `heap[0..size)`. */
  private readonly heap: Slot[] = [];
  private size = 0;
  private fastQueued = 0;
  private readonly free: Slot[] = [];
  private freeCount = 0;
  private slotCount = 0;
  private due: Float64Array;
  private nextSeq = 1;
  private readonly freeBytes = new Map<number, BufferStack>();
  /** Whole-buffer views of senders' buffers, so a reused send buffer costs no allocation. */
  private readonly sourceViews = new WeakMap<ArrayBufferLike, Uint8Array>();
  private pumping = false;

  constructor(options: NetsimOptions = {}) {
    const capacity = Math.floor(options.capacity ?? DEFAULT_NETSIM_CAPACITY);
    this.capacity = capacity >= 1 ? capacity : 1;
    this.now = options.now ?? defaultNow;
    this.recycle = options.recycleBuffers ?? true;
    this.stats = options.stats ?? createNetStats();
    this.randomState = (options.seed ?? DEFAULT_NETSIM_SEED) | 0;
    this.due = new Float64Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) this.free.push(this.createSlot());
    this.freeCount = this.free.length;
    const profile = options.profile ?? NETSIM_PROFILES.off;
    this.profileName = profile.name;
    this.setProfile(profile);
  }

  /** Messages waiting in the delay queue. */
  get queued(): number {
    return this.size;
  }

  /** True when both directions add nothing: every message passes straight through. */
  get idle(): boolean {
    return isTransparent(this.outbound) && isTransparent(this.inbound);
  }

  /** Copies a profile's numbers into one or both directions. Takes effect on the next message. */
  setProfile(profile: NetsimProfile, direction: NetsimDirection = 'both'): void {
    if (direction !== 'inbound') applyProfile(this.outbound, profile);
    if (direction !== 'outbound') applyProfile(this.inbound, profile);
    this.profileName = profile.name;
  }

  /** Restarts the random sequence (repeatable test sections). */
  reseed(seed: number): void {
    this.randomState = seed | 0;
  }

  wrapHost(inner: HostTransport): NetsimHostTransport {
    return new NetsimHostTransport(this, inner);
  }

  wrapClient(inner: ClientTransport): NetsimClientTransport {
    return new NetsimClientTransport(this, inner);
  }

  /**
   * Delivers every message that is due at `nowMs` (same timeline as the `now` option), in due
   * order. Returns how many left the queue. A `pump` from inside a handler does nothing.
   */
  pump(nowMs: number = this.now()): number {
    if (this.pumping) return 0;
    this.pumping = true;
    let count = 0;
    try {
      while (this.size > 0) {
        const top = this.heap[0];
        if (top === undefined || (this.due[top.id] ?? 0) > nowMs) break;
        this.removeAt(0);
        count++;
        try {
          this.dispatch(top);
        } finally {
          this.releaseSlot(top);
        }
      }
    } finally {
      this.pumping = false;
    }
    updateNetStats(this.stats, nowMs);
    return count;
  }

  // --- used by the wrappers below ---------------------------------------------------------------

  /** @internal */
  createLink(link: LinkId): LinkState {
    return new LinkState(link);
  }

  /** @internal The app sends. Returns what `send` returns. */
  submitOut(owner: Endpoint, state: LinkState, channel: Channel, data: TransportPayload): boolean {
    const size = typeof data === 'string' ? data.length : data.byteLength;
    recordSent(this.stats, channel, size);
    if (!this.route(owner, state, DIR_OUT, channel, data, size)) return true;
    const sent = owner.emitOut(state.link, channel, data);
    if (!sent) recordDropped(this.stats, channel, size);
    return sent;
  }

  /** @internal The inner transport received. */
  submitIn(owner: Endpoint, state: LinkState, channel: Channel, data: TransportMessage): void {
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (!this.route(owner, state, DIR_IN, channel, data, size)) return;
    recordReceived(this.stats, channel, size);
    owner.emitIn(state.link, channel, data);
  }

  /** @internal Counts traffic of a link the netsim does not track (passed straight through). */
  countPassthrough(sending: boolean, channel: Channel, data: TransportPayload): void {
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (sending) recordSent(this.stats, channel, size);
    else recordReceived(this.stats, channel, size);
  }

  /**
   * @internal Finishes every queued `ctrl` message of one link and direction right now, in
   * order. Used before a link closes so reliable messages are not lost to the simulation.
   */
  flushCtrl(state: LinkState, outbound: boolean): void {
    const dir: Dir = outbound ? DIR_OUT : DIR_IN;
    for (;;) {
      let best = -1;
      let bestSeq = Infinity;
      for (let i = 0; i < this.size; i++) {
        const slot = this.heap[i];
        if (slot === undefined || slot.state !== state || slot.dir !== dir) continue;
        if (slot.channel === 'ctrl' && slot.seq < bestSeq) {
          best = i;
          bestSeq = slot.seq;
        }
      }
      if (best < 0 || !state.alive) return;
      const slot = this.removeAt(best);
      if (slot === undefined) return;
      try {
        this.dispatch(slot);
      } finally {
        this.releaseSlot(slot);
      }
    }
  }

  /** @internal The link is gone: forget everything still queued for it. */
  endLink(state: LinkState): void {
    state.alive = false;
    state.pendingCtrlOut = 0;
    state.pendingCtrlIn = 0;
    let kept = 0;
    for (let i = 0; i < this.size; i++) {
      const slot = this.heap[i];
      if (slot === undefined) continue;
      if (slot.state === state) {
        if (slot.channel === 'fast') this.fastQueued--;
        this.counters.discarded++;
        this.releaseSlot(slot);
      } else {
        this.heap[kept++] = slot;
      }
    }
    if (kept === this.size) return;
    this.size = kept;
    for (let i = (kept >> 1) - 1; i >= 0; i--) this.siftDown(i);
  }

  // --- conditions -------------------------------------------------------------------------------

  /**
   * Decides the fate of one message. True: deliver it right now, untouched (nothing was queued).
   * False: it was queued or lost.
   *
   * Times stay in the `t` scratch array and random numbers are small integers on purpose: a
   * float handed to or returned from a function V8 did not inline is boxed on the heap, which
   * would be garbage for every packet.
   */
  private route(
    owner: Endpoint,
    state: LinkState,
    dir: Dir,
    channel: Channel,
    data: TransportPayload,
    size: number,
  ): boolean {
    const s = dir === DIR_OUT ? this.outbound : this.inbound;
    const t = this.t;
    t[T_NOW] = this.now();

    if (channel === 'ctrl') {
      this.sampleDelay(s);
      let due = (t[T_NOW] ?? 0) + (t[T_DELAY] ?? 0);
      const last = state.lastCtrlDue[dir] ?? 0;
      if (due < last) due = last;
      const pending = dir === DIR_OUT ? state.pendingCtrlOut : state.pendingCtrlIn;
      if (pending === 0 && due <= (t[T_NOW] ?? 0)) return true;
      state.lastCtrlDue[dir] = due;
      if (dir === DIR_OUT) state.pendingCtrlOut++;
      else state.pendingCtrlIn++;
      t[T_DUE] = due;
      this.push(owner, state, dir, channel, data, size);
      return false;
    }

    if (s.lossPct > 0 && this.random30() < s.lossPct * PERCENT_TO_RANDOM) {
      this.counters.lost++;
      recordDropped(this.stats, channel, size);
      return false;
    }
    this.sampleDelay(s);
    let delay = t[T_DELAY] ?? 0;
    if (s.reorderPct > 0 && this.random30() < s.reorderPct * PERCENT_TO_RANDOM) {
      if (s.reorderDelayMs > 0) delay += s.reorderDelayMs;
      this.counters.reordered++;
    }
    if (s.duplicatePct > 0 && this.random30() < s.duplicatePct * PERCENT_TO_RANDOM) {
      this.counters.duplicated++;
      this.sampleDelay(s);
      t[T_DUE] = (t[T_NOW] ?? 0) + (t[T_DELAY] ?? 0);
      this.push(owner, state, dir, channel, data, size);
    }
    if (delay <= 0) return true;
    t[T_DUE] = (t[T_NOW] ?? 0) + delay;
    this.push(owner, state, dir, channel, data, size);
    return false;
  }

  /** Writes latency ± jitter (never negative) to `t[T_DELAY]`. */
  private sampleDelay(s: NetsimSettings): void {
    const latency = s.latencyMs > 0 ? s.latencyMs : 0;
    let delay = latency;
    if (s.jitterMs > 0) {
      const unit =
        s.jitterShape === 'normal'
          ? (this.random30() + this.random30() + this.random30()) * (RANDOM_TO_UNIT * (2 / 3)) - 1
          : this.random30() * (RANDOM_TO_UNIT * 2) - 1;
      delay = latency + unit * s.jitterMs;
      if (!(delay > 0)) delay = 0;
    }
    this.t[T_DELAY] = delay;
  }

  /** mulberry32, cut to 30 bits so the result is always a small integer (never boxed). */
  private random30(): number {
    const state = (this.randomState + 0x6d2b79f5) | 0;
    this.randomState = state;
    let x = Math.imul(state ^ (state >>> 15), state | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return (x ^ (x >>> 14)) >>> 2;
  }

  // --- queue ------------------------------------------------------------------------------------

  private push(
    owner: Endpoint,
    state: LinkState,
    dir: Dir,
    channel: Channel,
    data: TransportPayload,
    size: number,
  ): void {
    const slot = this.takeSlot(channel);
    slot.seq = this.nextSeq++;
    slot.owner = owner;
    slot.state = state;
    slot.dir = dir;
    slot.channel = channel;
    slot.size = size;
    if (typeof data === 'string') slot.text = data;
    else slot.bytes = this.copyIn(data, dir === DIR_OUT || this.recycle);
    this.due[slot.id] = this.t[T_DUE] ?? 0;

    if (channel === 'fast') this.fastQueued++;
    const index = this.size++;
    if (index < this.heap.length) this.heap[index] = slot;
    else this.heap.push(slot);
    this.siftUp(index);
    if (this.size > this.counters.peakQueued) this.counters.peakQueued = this.size;
  }

  private takeSlot(channel: Channel): Slot {
    if (channel === 'fast' && this.fastQueued >= this.capacity) {
      // Full: the oldest waiting fast message makes room. Stale state is the cheapest to lose.
      let oldest = -1;
      let oldestSeq = Infinity;
      for (let i = 0; i < this.size; i++) {
        const slot = this.heap[i];
        if (slot !== undefined && slot.channel === 'fast' && slot.seq < oldestSeq) {
          oldest = i;
          oldestSeq = slot.seq;
        }
      }
      const victim = oldest >= 0 ? this.removeAt(oldest) : undefined;
      if (victim !== undefined) {
        this.counters.overflowDropped++;
        recordDropped(this.stats, 'fast', victim.size);
        this.clearSlot(victim);
        return victim;
      }
    }
    if (this.freeCount > 0) {
      const slot = this.free[--this.freeCount];
      if (slot !== undefined) return slot;
    }
    return this.createSlot();
  }

  private createSlot(): Slot {
    const id = this.slotCount++;
    if (id >= this.due.length) {
      const grown = new Float64Array(this.due.length * 2);
      grown.set(this.due);
      this.due = grown;
    }
    return {
      id,
      seq: 0,
      owner: null,
      state: null,
      dir: DIR_OUT,
      channel: 'ctrl',
      text: null,
      bytes: null,
      size: 0,
    };
  }

  private dispatch(slot: Slot): void {
    const state = slot.state;
    const owner = slot.owner;
    if (state === null || owner === null) return;
    if (slot.channel === 'ctrl') {
      if (slot.dir === DIR_OUT) {
        if (state.pendingCtrlOut > 0) state.pendingCtrlOut--;
      } else if (state.pendingCtrlIn > 0) {
        state.pendingCtrlIn--;
      }
    }
    if (!state.alive) {
      this.counters.discarded++;
      return;
    }
    const bytes = slot.bytes;
    if (slot.dir === DIR_OUT) {
      const sent = owner.emitOut(state.link, slot.channel, slot.text ?? bytes ?? '');
      if (!sent) recordDropped(this.stats, slot.channel, slot.size);
    } else {
      recordReceived(this.stats, slot.channel, slot.size);
      owner.emitIn(state.link, slot.channel, slot.text ?? bytes?.buffer ?? '');
    }
  }

  /** Returns the slot's buffer to the pool (when allowed) and the slot to the free list. */
  private releaseSlot(slot: Slot): void {
    this.clearSlot(slot);
    if (this.freeCount < this.free.length) this.free[this.freeCount] = slot;
    else this.free.push(slot);
    this.freeCount++;
  }

  private clearSlot(slot: Slot): void {
    const bytes = slot.bytes;
    // Outbound copies are always ours again (the inner transport copied them in `send`).
    if (bytes !== null && (slot.dir === DIR_OUT || this.recycle)) {
      let bucket = this.freeBytes.get(bytes.length);
      if (bucket === undefined && this.freeBytes.size < POOL_MAX_SIZES) {
        bucket = { items: [], count: 0 };
        this.freeBytes.set(bytes.length, bucket);
      }
      if (bucket !== undefined && bucket.count < POOL_MAX_PER_SIZE) {
        if (bucket.count < bucket.items.length) bucket.items[bucket.count] = bytes;
        else bucket.items.push(bytes);
        bucket.count++;
      }
    }
    slot.owner = null;
    slot.state = null;
    slot.text = null;
    slot.bytes = null;
  }

  /** Copies the payload's bytes into a buffer of exactly that length. */
  private copyIn(data: ArrayBuffer | ArrayBufferView, pooled: boolean): Uint8Array<ArrayBuffer> {
    let source: Uint8Array;
    let offset = 0;
    if (data instanceof Uint8Array) {
      source = data;
    } else if (ArrayBuffer.isView(data)) {
      source = this.sourceView(data.buffer);
      offset = data.byteOffset;
    } else {
      source = this.sourceView(data);
    }
    const length = data.byteLength;
    let target: Uint8Array<ArrayBuffer> | undefined;
    if (pooled) {
      const bucket = this.freeBytes.get(length);
      if (bucket !== undefined && bucket.count > 0) target = bucket.items[--bucket.count];
    }
    target ??= new Uint8Array(length);
    if (length <= LOOP_COPY_MAX) {
      for (let i = 0; i < length; i++) target[i] = source[offset + i] ?? 0;
    } else {
      target.set(source.subarray(offset, offset + length));
    }
    return target;
  }

  private sourceView(buffer: ArrayBufferLike): Uint8Array {
    let view = this.sourceViews.get(buffer);
    if (view === undefined) {
      view = new Uint8Array(buffer);
      this.sourceViews.set(buffer, view);
    }
    return view;
  }

  // --- heap -------------------------------------------------------------------------------------

  private before(a: Slot, b: Slot): boolean {
    const da = this.due[a.id] ?? 0;
    const db = this.due[b.id] ?? 0;
    return da < db || (da === db && a.seq < b.seq);
  }

  private siftUp(start: number): void {
    const heap = this.heap;
    const slot = heap[start];
    if (slot === undefined) return;
    let index = start;
    while (index > 0) {
      const parentIndex = (index - 1) >> 1;
      const parent = heap[parentIndex];
      if (parent === undefined || !this.before(slot, parent)) break;
      heap[index] = parent;
      index = parentIndex;
    }
    heap[index] = slot;
  }

  private siftDown(start: number): void {
    const heap = this.heap;
    const size = this.size;
    const slot = heap[start];
    if (slot === undefined) return;
    let index = start;
    for (;;) {
      let childIndex = index * 2 + 1;
      if (childIndex >= size) break;
      let child = heap[childIndex];
      const right = heap[childIndex + 1];
      if (childIndex + 1 < size && right !== undefined && child !== undefined) {
        if (this.before(right, child)) {
          childIndex++;
          child = right;
        }
      }
      if (child === undefined || !this.before(child, slot)) break;
      heap[index] = child;
      index = childIndex;
    }
    heap[index] = slot;
  }

  /** Takes the slot at a heap index out of the queue (it is NOT released). */
  private removeAt(index: number): Slot | undefined {
    const heap = this.heap;
    const slot = heap[index];
    if (slot === undefined || index >= this.size) return undefined;
    const lastIndex = --this.size;
    const last = heap[lastIndex];
    if (slot.channel === 'fast') this.fastQueued--;
    if (index < lastIndex && last !== undefined) {
      heap[index] = last;
      this.siftDown(index);
      if (heap[index] === last) this.siftUp(index);
    }
    return slot;
  }
}

function isTransparent(s: Readonly<NetsimSettings>): boolean {
  return (
    !(s.latencyMs > 0) &&
    !(s.jitterMs > 0) &&
    !(s.lossPct > 0) &&
    !(s.duplicatePct > 0) &&
    !(s.reorderPct > 0 && s.reorderDelayMs > 0)
  );
}

export function createNetsim(options?: NetsimOptions): Netsim {
  return new Netsim(options);
}

/**
 * A `HostTransport` that runs every link of `inner` through the netsim. Create it with
 * `netsim.wrapHost(inner)`; it takes over the inner transport's handlers.
 */
export class NetsimHostTransport implements HostTransport, Endpoint {
  private handlers: HostTransportHandlers = NOOP_HOST_HANDLERS;
  private readonly links = new Map<LinkId, LinkState>();

  constructor(
    private readonly sim: Netsim,
    /** The wrapped transport, for implementation-specific extras (`linkCount`, `sever`). */
    readonly inner: HostTransport,
  ) {
    inner.setHandlers({
      onOpen: (roomCode) => this.handlers.onOpen(roomCode),
      onError: (error) => this.handlers.onError(error),
      onPeerConnected: (link) => {
        this.links.set(link, sim.createLink(link));
        this.handlers.onPeerConnected(link);
      },
      onPeerDisconnected: (link, reason) => this.peerGone(link, reason),
      onMessage: (link, channel, data) => {
        const state = this.links.get(link);
        if (state !== undefined) {
          sim.submitIn(this, state, channel, data);
        } else {
          sim.countPassthrough(false, channel, data);
          this.handlers.onMessage(link, channel, data);
        }
      },
    });
  }

  get state(): TransportState {
    return this.inner.state;
  }

  get roomCode(): string {
    return this.inner.roomCode;
  }

  setHandlers(handlers: HostTransportHandlers): void {
    this.handlers = handlers;
  }

  open(roomCode: string): void {
    this.inner.open(roomCode);
  }

  send(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    const state = this.links.get(link);
    if (state === undefined) return this.inner.send(link, channel, data);
    return this.sim.submitOut(this, state, channel, data);
  }

  close(link: LinkId): void {
    const state = this.links.get(link);
    if (state !== undefined) this.sim.flushCtrl(state, true);
    this.inner.close(link);
  }

  dispose(): void {
    for (const state of this.links.values()) {
      this.sim.flushCtrl(state, true);
      this.sim.endLink(state);
    }
    this.links.clear();
    this.handlers = NOOP_HOST_HANDLERS;
    this.inner.dispose();
  }

  /** @internal */
  emitOut(link: LinkId, channel: Channel, data: TransportPayload): boolean {
    return this.inner.send(link, channel, data);
  }

  /** @internal */
  emitIn(link: LinkId, channel: Channel, data: TransportMessage): void {
    this.handlers.onMessage(link, channel, data);
  }

  private peerGone(link: LinkId, reason: DisconnectReason): void {
    const state = this.links.get(link);
    if (state !== undefined) {
      // The peer's last reliable words still count, unless the app itself hung up.
      if (reason !== 'local') this.sim.flushCtrl(state, false);
      this.links.delete(link);
      this.sim.endLink(state);
    }
    this.handlers.onPeerDisconnected(link, reason);
  }
}

/**
 * A `ClientTransport` that runs the link of `inner` through the netsim. Create it with
 * `netsim.wrapClient(inner)`; it takes over the inner transport's handlers.
 */
export class NetsimClientTransport implements ClientTransport, Endpoint {
  private handlers: ClientTransportHandlers = NOOP_CLIENT_HANDLERS;
  /** The open link, or null. A reconnect gets a fresh one, so stale queued messages die. */
  private link: LinkState | null = null;

  constructor(
    private readonly sim: Netsim,
    /** The wrapped transport. */
    readonly inner: ClientTransport,
  ) {
    inner.setHandlers({
      onOpen: () => {
        if (this.link !== null) sim.endLink(this.link);
        this.link = sim.createLink(0);
        this.handlers.onOpen();
      },
      onClose: (reason) => {
        const state = this.link;
        if (state !== null) {
          if (reason !== 'local') sim.flushCtrl(state, false);
          this.link = null;
          sim.endLink(state);
        }
        this.handlers.onClose(reason);
      },
      onError: (error) => {
        // A fatal error ends the link without `onClose`.
        if (error.fatal && this.link !== null) {
          sim.endLink(this.link);
          this.link = null;
        }
        this.handlers.onError(error);
      },
      onMessage: (channel, data) => {
        const state = this.link;
        if (state !== null) {
          sim.submitIn(this, state, channel, data);
        } else {
          sim.countPassthrough(false, channel, data);
          this.handlers.onMessage(channel, data);
        }
      },
    });
  }

  get state(): TransportState {
    return this.inner.state;
  }

  setHandlers(handlers: ClientTransportHandlers): void {
    this.handlers = handlers;
  }

  connect(roomCode: string): void {
    this.inner.connect(roomCode);
  }

  send(channel: Channel, data: TransportPayload): boolean {
    const state = this.link;
    if (state === null) return this.inner.send(channel, data);
    return this.sim.submitOut(this, state, channel, data);
  }

  close(): void {
    if (this.link !== null) this.sim.flushCtrl(this.link, true);
    this.inner.close();
  }

  dispose(): void {
    const state = this.link;
    if (state !== null) {
      this.sim.flushCtrl(state, true);
      this.sim.endLink(state);
      this.link = null;
    }
    this.handlers = NOOP_CLIENT_HANDLERS;
    this.inner.dispose();
  }

  /** @internal */
  emitOut(_link: LinkId, channel: Channel, data: TransportPayload): boolean {
    return this.inner.send(channel, data);
  }

  /** @internal */
  emitIn(_link: LinkId, channel: Channel, data: TransportMessage): void {
    this.handlers.onMessage(channel, data);
  }
}

export interface ManualClock {
  /** Pass this as the `now` option. */
  readonly now: () => number;
  advance(ms: number): number;
  set(ms: number): void;
}

/** A clock that only moves when told to: for tests and fixed-step tools. */
export function createManualClock(startMs = 0): ManualClock {
  let t = startMs;
  return {
    now: () => t,
    advance(ms: number): number {
      t += ms;
      return t;
    },
    set(ms: number): void {
      t = ms;
    },
  };
}

/**
 * Pumps on a timer, for pages without a frame loop (a host tab left in the background still
 * gets throttled to about 1 Hz by the browser; prefer calling `pump` from the game loop).
 * Returns the function that stops it.
 */
export function startNetsimTimer(netsim: Netsim, intervalMs = 4): () => void {
  const handle = setInterval(() => {
    netsim.pump();
  }, intervalMs);
  return () => clearInterval(handle);
}
