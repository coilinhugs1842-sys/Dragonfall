/**
 * The binary side of the main <-> host-worker protocol: everything that happens per tick or per
 * packet travels as RECORDS packed into one `ArrayBuffer` per `postMessage`, and that buffer is
 * TRANSFERRED, not cloned. Nothing here is structured-cloned per tick.
 *
 *   batch  := header, record*
 *   header := u32 byteLength, u16 recordCount, u16 reserved, f64 sentAtMs        (16 bytes)
 *   record := u8 kind, u8 aux, u16 payloadLength, u32 link, payload              (8 + n bytes)
 *
 * Little-endian, read and written through a `DataView`, so records need no alignment.
 *
 * BUFFERS PING-PONG. Each side owns a small pool of equally sized buffers. A transferred buffer
 * is gone for its sender, so the receiver hands every buffer it has finished reading back with
 * its next message (`BatchMessage.r`), and the owner puts it back in its pool. In steady state
 * no `ArrayBuffer` is allocated on either side; what `postMessage` itself costs (one small
 * wrapper object, one `DataView` per arriving buffer) is all that is left.
 */

export const BATCH_HEADER_BYTES = 16;
export const RECORD_HEADER_BYTES = 8;
/** Big enough for a tick of snapshots to nine clients plus a lobby broadcast. */
export const BATCH_BUFFER_BYTES = 32 * 1024;
/** `u16 payloadLength`. */
export const RECORD_MAX_PAYLOAD = 0xffff;

/** A packet: main -> worker "this arrived on `link`", worker -> main "send this to `link`". */
export const REC_PACKET = 1;
/** main -> worker: a string message arrived (the protocol is binary: the host counts and drops it). */
export const REC_TEXT = 2;
/** main -> worker: both channels of a new link are open. */
export const REC_PEER_OPEN = 3;
/** main -> worker: a link ended. `aux` is the reason. */
export const REC_PEER_GONE = 4;
/** worker -> main: close this link. */
export const REC_CLOSE = 5;
/** main -> worker: the host player's input sample. */
export const REC_INPUT = 6;
/** worker -> main: the authoritative view state after a tick (`view-state.ts`). */
export const REC_STATE = 7;
/** worker -> main: once a second, the numbers the lobby and the HUD show. */
export const REC_STATS = 8;
/** Either way: "I am alive" when there is nothing else to say. */
export const REC_KEEPALIVE = 9;
/**
 * worker -> main: the tick's GameEvents for the host's own views, as one GAME_EVENTS message
 * (the bytes the clients get; `codec/events.ts`).
 */
export const REC_EVENTS = 10;
/** worker -> main: the per-rider totals, as one SCOREBOARD message (`session/scores.ts`). */
export const REC_SCORES = 11;

/** `aux` of a packet record. */
export const AUX_CTRL = 0;
export const AUX_FAST = 1;

/** `aux` of REC_PEER_GONE. */
export const AUX_REASON_LOCAL = 0;
export const AUX_REASON_REMOTE = 1;
export const AUX_REASON_LOST = 2;

/** What travels through `postMessage` for a batch. `r` = buffers handed back to their owner. */
export interface BatchMessage {
  t: 'b';
  b: ArrayBuffer;
  r: ArrayBuffer[];
}

/** Fixed-size buffers for one side's outgoing batches. */
export class BufferPool {
  private readonly free: ArrayBuffer[] = [];
  /** Buffers created so far (a steady number means the ping-pong works). */
  allocated = 0;

  constructor(
    readonly bufferBytes: number = BATCH_BUFFER_BYTES,
    private readonly maxFree = 16,
  ) {}

  acquire(minBytes: number): ArrayBuffer {
    if (minBytes <= this.bufferBytes) {
      const pooled = this.free.pop();
      if (pooled !== undefined) return pooled;
      this.allocated++;
      return new ArrayBuffer(this.bufferBytes);
    }
    // One record larger than a pool buffer: a one-off that is not kept afterwards.
    this.allocated++;
    return new ArrayBuffer(minBytes);
  }

  /** Takes a buffer back (one the other side returned). Odd sizes and detached ones are dropped. */
  release(buffer: ArrayBuffer): void {
    if (buffer.byteLength === this.bufferBytes && this.free.length < this.maxFree) {
      this.free.push(buffer);
    }
  }
}

/**
 * Packs records into a pooled buffer. `begin` reserves a record and returns where its payload
 * starts (write it through `view` / `bytes`); when the current buffer is full the `flush`
 * callback is asked to post it first (it calls `take`).
 */
export class BatchWriter {
  private buffer: ArrayBuffer | null = null;
  private dataView: DataView | null = null;
  private byteView: Uint8Array | null = null;
  private offset = BATCH_HEADER_BYTES;
  private count = 0;
  /** Used bytes of the batch the latest `take` gave up. */
  takenBytes = 0;
  /** Assigned by the owner: posts the current batch (through `take`). */
  flush: () => void = () => {};

  constructor(private readonly pool: BufferPool) {}

  get empty(): boolean {
    return this.count === 0;
  }

  /** Valid after `begin`, until the next `begin` or `take`. */
  get view(): DataView {
    const view = this.dataView;
    if (view === null) throw new Error('BatchWriter: no open batch');
    return view;
  }

  get bytes(): Uint8Array {
    const bytes = this.byteView;
    if (bytes === null) throw new Error('BatchWriter: no open batch');
    return bytes;
  }

  /** Reserves a record. Returns the payload offset, or -1 when `length` cannot be sent at all. */
  begin(kind: number, aux: number, link: number, length: number): number {
    if (length < 0 || length > RECORD_MAX_PAYLOAD) return -1;
    const need = RECORD_HEADER_BYTES + length;
    if (this.buffer !== null && this.offset + need > this.buffer.byteLength) this.flush();
    if (this.buffer !== null && this.offset + need > this.buffer.byteLength) {
      // `flush` was not wired up: the batch cannot grow, so the record is lost.
      return -1;
    }
    if (this.buffer === null) {
      const buffer = this.pool.acquire(BATCH_HEADER_BYTES + need);
      this.buffer = buffer;
      this.dataView = new DataView(buffer);
      this.byteView = new Uint8Array(buffer);
      this.offset = BATCH_HEADER_BYTES;
      this.count = 0;
    }
    const view = this.view;
    const at = this.offset;
    view.setUint8(at, kind);
    view.setUint8(at + 1, aux);
    view.setUint16(at + 2, length, true);
    view.setUint32(at + 4, link >>> 0, true);
    this.offset = at + need;
    this.count++;
    return at + RECORD_HEADER_BYTES;
  }

  /** A record with no payload. */
  mark(kind: number, aux: number, link: number): boolean {
    return this.begin(kind, aux, link, 0) >= 0;
  }

  /** A record whose payload is a copy of `source`. */
  copy(kind: number, aux: number, link: number, source: Uint8Array): boolean {
    const at = this.begin(kind, aux, link, source.byteLength);
    if (at < 0) return false;
    this.bytes.set(source, at);
    return true;
  }

  /**
   * Finishes the batch and gives its buffer up (the caller transfers it). Null when nothing was
   * written. The writer starts a new buffer on the next `begin`.
   */
  take(sentAtMs: number): ArrayBuffer | null {
    const buffer = this.buffer;
    const view = this.dataView;
    if (buffer === null || view === null || this.count === 0) return null;
    view.setUint32(0, this.offset, true);
    view.setUint16(4, this.count, true);
    view.setUint16(6, 0, true);
    view.setFloat64(8, sentAtMs, true);
    this.takenBytes = this.offset;
    this.buffer = null;
    this.dataView = null;
    this.byteView = null;
    this.offset = BATCH_HEADER_BYTES;
    this.count = 0;
    return buffer;
  }
}

/**
 * Walks the records of a received batch. `open` returns false for a buffer that is not a
 * well-formed batch (nothing is read past its end either way); then `next()` moves to each
 * record in turn and the fields describe it.
 */
export class BatchReader {
  view: DataView = EMPTY_VIEW;
  bytes: Uint8Array = EMPTY_BYTES;
  /** Used bytes of the batch (what crossed the thread boundary). */
  byteLength = 0;
  sentAtMs = 0;
  kind = 0;
  aux = 0;
  link = 0;
  /** Payload position and size of the current record. */
  offset = 0;
  length = 0;
  private remaining = 0;
  private cursor = 0;

  open(buffer: ArrayBuffer): boolean {
    this.remaining = 0;
    if (buffer.byteLength < BATCH_HEADER_BYTES) return false;
    const view = new DataView(buffer);
    const used = view.getUint32(0, true);
    if (used < BATCH_HEADER_BYTES || used > buffer.byteLength) return false;
    this.view = view;
    this.bytes = new Uint8Array(buffer);
    this.byteLength = used;
    this.remaining = view.getUint16(4, true);
    this.sentAtMs = view.getFloat64(8, true);
    this.cursor = BATCH_HEADER_BYTES;
    return true;
  }

  next(): boolean {
    if (this.remaining <= 0) return false;
    const at = this.cursor;
    if (at + RECORD_HEADER_BYTES > this.byteLength) {
      this.remaining = 0;
      return false;
    }
    const view = this.view;
    const length = view.getUint16(at + 2, true);
    if (at + RECORD_HEADER_BYTES + length > this.byteLength) {
      this.remaining = 0;
      return false;
    }
    this.kind = view.getUint8(at);
    this.aux = view.getUint8(at + 1);
    this.length = length;
    this.link = view.getUint32(at + 4, true);
    this.offset = at + RECORD_HEADER_BYTES;
    this.cursor = this.offset + length;
    this.remaining--;
    return true;
  }

  /** Lets go of the buffer (it is about to be handed back). */
  close(): void {
    this.view = EMPTY_VIEW;
    this.bytes = EMPTY_BYTES;
    this.remaining = 0;
    this.byteLength = 0;
  }
}

const EMPTY_BUFFER = new ArrayBuffer(0);
const EMPTY_VIEW = new DataView(EMPTY_BUFFER);
const EMPTY_BYTES = new Uint8Array(EMPTY_BUFFER);

/**
 * Exact-size scratch buffers, one per size, for handing a record's payload to code that wants a
 * message of exactly its length (`HostTransportHandlers.onMessage`, `HostTransport.send`). The
 * same buffer comes back for the same size, so it is only valid until the next call with that
 * size: fine for a transport, which copies or consumes before it returns.
 */
export class ExactBuffers {
  private readonly bySize = new Map<number, Uint8Array<ArrayBuffer>>();

  constructor(private readonly maxSizes = 512) {}

  /** A `byteLength`-sized view filled from `source[offset ..]`. */
  filled(source: Uint8Array, offset: number, byteLength: number): Uint8Array<ArrayBuffer> {
    let target = this.bySize.get(byteLength);
    if (target === undefined) {
      if (this.bySize.size >= this.maxSizes) this.bySize.clear();
      target = new Uint8Array(new ArrayBuffer(byteLength));
      this.bySize.set(byteLength, target);
    }
    for (let i = 0; i < byteLength; i++) target[i] = source[offset + i] ?? 0;
    return target;
  }
}
