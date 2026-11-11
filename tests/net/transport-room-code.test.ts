import { describe, expect, it } from 'vitest';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  peerIdToRoomCode,
  roomCodeToPeerId,
} from '../../src/net/room-code';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../src/shared/constants';

/** Small deterministic generator (mulberry32) so the test never depends on Math.random. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('room codes', () => {
  it('uses an alphabet without the look-alikes 0, O, 1 and I', () => {
    for (const bad of ['0', 'O', '1', 'I']) expect(ROOM_CODE_ALPHABET).not.toContain(bad);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
    expect(ROOM_CODE_ALPHABET).toMatch(/^[A-Z2-9]+$/);
  });

  it('generates 5 characters from the alphabet, every time', () => {
    const random = seeded(7);
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const code = generateRoomCode(random);
      expect(code).toHaveLength(ROOM_CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      for (const char of code) seen.add(char);
    }
    // Every character of the alphabet is reachable.
    expect(seen.size).toBe(ROOM_CODE_ALPHABET.length);
  });

  it('is a pure function of its random source', () => {
    expect(generateRoomCode(seeded(42))).toBe(generateRoomCode(seeded(42)));
    expect(generateRoomCode(() => 0)).toBe(ROOM_CODE_ALPHABET.charAt(0).repeat(ROOM_CODE_LENGTH));
    const last = ROOM_CODE_ALPHABET.charAt(ROOM_CODE_ALPHABET.length - 1);
    expect(generateRoomCode(() => 0.999999)).toBe(last.repeat(ROOM_CODE_LENGTH));
  });

  it('survives a random source that misbehaves', () => {
    for (const value of [1, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isValidRoomCode(generateRoomCode(() => value))).toBe(true);
    }
  });

  it('works with the default source', () => {
    expect(isValidRoomCode(generateRoomCode())).toBe(true);
  });

  it('validates length and characters', () => {
    expect(isValidRoomCode('ABCDE')).toBe(true);
    expect(isValidRoomCode('H2K9Z')).toBe(true);
    const invalid = ['', 'ABCD', 'ABCDEF', 'ABCD0', 'ABCDO', 'ABCD1', 'ABCDI', 'abcde', 'AB DE'];
    for (const bad of invalid) expect(isValidRoomCode(bad)).toBe(false);
  });

  it('normalizes what a player typed without guessing at look-alikes', () => {
    expect(normalizeRoomCode('  ab-cd2 ')).toBe('ABCD2');
    expect(normalizeRoomCode('h 2 k 9 z')).toBe('H2K9Z');
    expect(isValidRoomCode(normalizeRoomCode('abcd0'))).toBe(false);
  });

  it('maps codes to signaling ids and back', () => {
    expect(roomCodeToPeerId('ABCDE')).toBe('dragonfall-ABCDE');
    expect(peerIdToRoomCode('dragonfall-ABCDE')).toBe('ABCDE');
    expect(peerIdToRoomCode('dragonfall-ABCD0')).toBeNull();
    expect(peerIdToRoomCode('dragonfall-ABCDEF')).toBeNull();
    expect(peerIdToRoomCode('someone-ABCDE')).toBeNull();
    // PeerJS ids: alphanumeric with single dashes/underscores/spaces inside.
    expect(roomCodeToPeerId(generateRoomCode(seeded(3)))).toMatch(
      /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/,
    );
  });
});
