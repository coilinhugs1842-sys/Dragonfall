/**
 * Room codes (docs/NETWORKING.md, "Connection setup"): 5 characters from an alphabet without
 * 0/O/1/I. The host registers the signaling id `dragonfall-<CODE>`; clients type the code.
 * Pure functions: the random source is injected so tests are deterministic.
 */

import { PEER_ID_PREFIX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../shared/constants';

/** Returns a float in [0, 1), like `Math.random`. */
export type RandomSource = () => number;

/** A fresh room code. Not a secret: it only has to be unlikely to collide and easy to read out. */
export function generateRoomCode(random: RandomSource = Math.random): string {
  const size = ROOM_CODE_ALPHABET.length;
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    // Clamp so a source that returns exactly 1 (or garbage) still yields a valid character.
    const roll = Math.floor(random() * size);
    const index = roll >= 0 && roll < size ? roll : 0;
    code += ROOM_CODE_ALPHABET.charAt(index);
  }
  return code;
}

/**
 * Tidies what a player typed: trims, upper-cases, and drops spaces and dashes ("ab-cd2" ->
 * "ABCD2"). It does not guess at look-alikes (0/O, 1/I are simply not in the alphabet), so the
 * result still has to pass `isValidRoomCode`.
 */
export function normalizeRoomCode(input: string): string {
  return input.replace(/[\s-]+/g, '').toUpperCase();
}

/** True for exactly `ROOM_CODE_LENGTH` characters of `ROOM_CODE_ALPHABET` (case-sensitive). */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!ROOM_CODE_ALPHABET.includes(code.charAt(i))) return false;
  }
  return true;
}

/** `ABCDE` -> `dragonfall-ABCDE`. The caller validates the code first. */
export function roomCodeToPeerId(code: string): string {
  return PEER_ID_PREFIX + code;
}

/** `dragonfall-ABCDE` -> `ABCDE`, or null when the id is not one of our room ids. */
export function peerIdToRoomCode(peerId: string): string | null {
  if (!peerId.startsWith(PEER_ID_PREFIX)) return null;
  const code = peerId.slice(PEER_ID_PREFIX.length);
  return isValidRoomCode(code) ? code : null;
}
