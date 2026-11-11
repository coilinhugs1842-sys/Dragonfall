/**
 * Writer and Reader: bounds-checked cursors over a caller-owned buffer. Neither ever throws.
 * A write past the end sets `overflow` (and writes nothing); a read past the end sets `error`
 * and returns 0. Both conditions are sticky, so an encoder or decoder can run straight through
 * and check once at the end. All multi-byte values are little-endian.
 */

import {
  DECODE_OK,
  DECODE_OVERSIZED,
  DECODE_TRUNCATED,
  DECODE_WRONG_TYPE,
  HEADER_BYTES,
  MSG_INVALID,
  isMessageType,
} from '../protocol';
import type { DecodeError, MessageType } from '../protocol';

const TEXT_ENCODER = new TextEncoder();
/** Non-fatal: malformed UTF-8 decodes to U+FFFD instead of throwing. */
const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

const EMPTY_VIEW = new DataView(new ArrayBuffer(0));

/** Packets up to this size get a cached, exactly-sized view from `Writer.packet`. */
const PACKET_CACHE_LIMIT = 1024;

export class Writer {
  readonly buffer: ArrayBuffer;
  readonly view: DataView;
  readonly bytes: Uint8Array;
  readonly capacity: number;
  offset = 0;
  /** Set when a write did not fit. `finish()` then returns 0. */
  overflow = false;
  private readonly packets: (Uint8Array | undefined)[] = [];

  /** Owns a new buffer of `capacity` bytes. Make one per channel and reuse it for every send. */
  constructor(capacity: number) {
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
    this.bytes = new Uint8Array(this.buffer);
    this.capacity = capacity;
  }

  /** Rewinds to the start for the next message. */
  reset(): this {
    this.offset = 0;
    this.overflow = false;
    return this;
  }

  /** Bytes written, or 0 if the message did not fit (0 is never a valid message length). */
  finish(): number {
    return this.overflow ? 0 : this.offset;
  }

  /**
   * The first `byteLength` bytes as a view to hand to the transport. Views for packets up to
   * 1 KB are cached per length, so sending the hot messages allocates nothing once warm. The
   * view ALIASES this writer's buffer: it is valid until the next message is encoded, so a
   * transport that may queue a send (instead of copying at once) needs a copy.
   */
  packet(byteLength: number): Uint8Array {
    const length = byteLength < 0 ? 0 : byteLength > this.capacity ? this.capacity : byteLength;
    if (length > PACKET_CACHE_LIMIT) return this.bytes.subarray(0, length);
    let cached = this.packets[length];
    if (cached === undefined) {
      // Fill the gap so the cache stays a dense array.
      while (this.packets.length <= length) this.packets.push(undefined);
      cached = this.bytes.subarray(0, length);
      this.packets[length] = cached;
    }
    return cached;
  }

  private claim(size: number): number {
    const at = this.offset;
    if (this.overflow || at + size > this.capacity) {
      this.overflow = true;
      return -1;
    }
    this.offset = at + size;
    return at;
  }

  u8(value: number): void {
    const at = this.claim(1);
    if (at >= 0) this.view.setUint8(at, value);
  }

  i8(value: number): void {
    const at = this.claim(1);
    if (at >= 0) this.view.setInt8(at, value);
  }

  u16(value: number): void {
    const at = this.claim(2);
    if (at >= 0) this.view.setUint16(at, value, true);
  }

  i16(value: number): void {
    const at = this.claim(2);
    if (at >= 0) this.view.setInt16(at, value, true);
  }

  u32(value: number): void {
    const at = this.claim(4);
    if (at >= 0) this.view.setUint32(at, value, true);
  }

  f32(value: number): void {
    const at = this.claim(4);
    if (at >= 0) this.view.setFloat32(at, value, true);
  }

  f64(value: number): void {
    const at = this.claim(8);
    if (at >= 0) this.view.setFloat64(at, value, true);
  }

  /** Overwrites one byte that was already written (a count that is only known at the end). */
  patchU8(at: number, value: number): void {
    if (at >= 0 && at < this.offset) this.view.setUint8(at, value);
  }

  /** The message header: `u8 type`, `u16 tick` (only the low 16 bits of `tick` are kept). */
  header(type: MessageType, tick: number): void {
    this.u8(type);
    this.u16(tick & 0xffff);
  }

  /**
   * UTF-8 text with a length prefix of `prefixBytes` (1 or 2). Text longer than `maxBytes`
   * overflows the writer rather than being cut mid-character. Allocates (ctrl messages only).
   */
  text(value: string, prefixBytes: 1 | 2, maxBytes: number): void {
    const prefixAt = this.claim(prefixBytes);
    if (prefixAt < 0) return;
    const room = Math.min(maxBytes, this.capacity - this.offset);
    const target = this.bytes.subarray(this.offset, this.offset + room);
    const result = TEXT_ENCODER.encodeInto(value, target);
    if (result.read < value.length) {
      this.overflow = true;
      return;
    }
    if (prefixBytes === 1) this.view.setUint8(prefixAt, result.written);
    else this.view.setUint16(prefixAt, result.written, true);
    this.offset += result.written;
  }
}

export class Reader {
  /** The message being read. The fast-channel decoders read it directly once the size is checked. */
  view: DataView = EMPTY_VIEW;
  private end = 0;
  offset = 0;
  /** DECODE_OK, or why the last decode on this reader failed. Sticky until `reset`/`rewind`. */
  error: DecodeError = DECODE_OK;

  /**
   * Points the reader at a received message. The view is not copied. For an `ArrayBuffer` from
   * a data channel, the one `new DataView(buffer)` per packet is the only allocation the
   * receive path needs.
   */
  reset(view: DataView): this {
    this.view = view;
    this.end = view.byteLength;
    this.offset = 0;
    this.error = DECODE_OK;
    return this;
  }

  /** Back to the first byte of the same message, clearing any error. Every decoder starts here. */
  rewind(): this {
    this.offset = 0;
    this.error = DECODE_OK;
    return this;
  }

  get ok(): boolean {
    return this.error === DECODE_OK;
  }

  get byteLength(): number {
    return this.end;
  }

  get remaining(): number {
    return this.end - this.offset;
  }

  /** Records the failure (the first one wins) and returns false, so decoders can `return r.fail(..)`. */
  fail(error: DecodeError): false {
    if (this.error === DECODE_OK) this.error = error;
    return false;
  }

  /** The message type of the current buffer without moving the cursor, or MSG_INVALID. */
  peekType(): MessageType | typeof MSG_INVALID {
    if (this.end < HEADER_BYTES) return MSG_INVALID;
    const type = this.view.getUint8(0);
    return isMessageType(type) ? type : MSG_INVALID;
  }

  /** The header's wire tick without moving the cursor (0 for a buffer shorter than a header). */
  peekTick(): number {
    return this.end < HEADER_BYTES ? 0 : this.view.getUint16(1, true);
  }

  /**
   * Rewinds, checks the size limit and the type byte, and returns the header's wire tick. On
   * failure `ok` is false (and the returned tick is 0).
   */
  header(type: MessageType, maxBytes: number): number {
    this.rewind();
    if (this.end > maxBytes) {
      this.fail(DECODE_OVERSIZED);
      return 0;
    }
    if (this.end < HEADER_BYTES) {
      this.fail(DECODE_TRUNCATED);
      return 0;
    }
    if (this.u8() !== type) {
      this.fail(DECODE_WRONG_TYPE);
      return 0;
    }
    return this.u16();
  }

  /** Call when the message should be fully consumed: leftover bytes are a failure. */
  finish(): boolean {
    if (this.error !== DECODE_OK) return false;
    if (this.offset !== this.end) return this.fail(DECODE_OVERSIZED);
    return true;
  }

  private claim(size: number): number {
    const at = this.offset;
    if (this.error !== DECODE_OK) return -1;
    if (at + size > this.end) {
      this.error = DECODE_TRUNCATED;
      return -1;
    }
    this.offset = at + size;
    return at;
  }

  u8(): number {
    const at = this.claim(1);
    return at < 0 ? 0 : this.view.getUint8(at);
  }

  i8(): number {
    const at = this.claim(1);
    return at < 0 ? 0 : this.view.getInt8(at);
  }

  u16(): number {
    const at = this.claim(2);
    return at < 0 ? 0 : this.view.getUint16(at, true);
  }

  i16(): number {
    const at = this.claim(2);
    return at < 0 ? 0 : this.view.getInt16(at, true);
  }

  u32(): number {
    const at = this.claim(4);
    return at < 0 ? 0 : this.view.getUint32(at, true);
  }

  f32(): number {
    const at = this.claim(4);
    return at < 0 ? 0 : this.view.getFloat32(at, true);
  }

  f64(): number {
    const at = this.claim(8);
    return at < 0 ? 0 : this.view.getFloat64(at, true);
  }

  /** Moves the cursor forward without reading. */
  skip(size: number): void {
    this.claim(size);
  }

  /**
   * Length-prefixed UTF-8 text. A declared length above `maxBytes` or beyond the end of the
   * buffer fails and returns ''. Malformed UTF-8 becomes U+FFFD. Allocates (ctrl messages only).
   */
  text(prefixBytes: 1 | 2, maxBytes: number): string {
    const length = prefixBytes === 1 ? this.u8() : this.u16();
    if (this.error !== DECODE_OK) return '';
    if (length > maxBytes) {
      this.fail(DECODE_OVERSIZED);
      return '';
    }
    const at = this.claim(length);
    if (at < 0) return '';
    return TEXT_DECODER.decode(new Uint8Array(this.view.buffer, this.view.byteOffset + at, length));
  }
}
