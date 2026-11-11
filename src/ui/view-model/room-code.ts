/**
 * Room-code and rider-name text entry rules. DOM-free so they can be unit-tested; the title screen
 * calls these from its `input` and `paste` handlers.
 */

import { PEER_ID_PREFIX, ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '../../shared/constants';
import { MAX_PLAYER_NAME_LENGTH } from '../../shared/lobby';

function isCodeChar(char: string): boolean {
  return ROOM_CODE_ALPHABET.includes(char);
}

/**
 * What the code field should show after any edit: upper-cased, only characters a code can contain
 * (so O, 0, I and 1 simply do not appear), at most ROOM_CODE_LENGTH long.
 */
export function sanitizeRoomCodeInput(raw: string): string {
  const upper = raw.toUpperCase();
  let out = '';
  for (let i = 0; i < upper.length && out.length < ROOM_CODE_LENGTH; i++) {
    const char = upper.charAt(i);
    if (isCodeChar(char)) out += char;
  }
  return out;
}

export function isCompleteRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!isCodeChar(code.charAt(i))) return false;
  }
  return true;
}

/**
 * Best guess at the code inside pasted text. People paste whole chat lines ("room: KH7P2"), the
 * peer id (`dragonfall-KH7P2`) or a spaced-out code ("K H 7 P 2"), so:
 * 1. a code right after the peer-id prefix wins;
 * 2. otherwise the last stand-alone word that is exactly a code;
 * 3. otherwise whatever code characters the text holds, in order (same as typing it).
 */
export function extractRoomCode(pasted: string): string {
  const upper = pasted.toUpperCase();
  const prefix = PEER_ID_PREFIX.toUpperCase();
  const at = upper.lastIndexOf(prefix);
  if (at >= 0) {
    const candidate = upper.slice(at + prefix.length, at + prefix.length + ROOM_CODE_LENGTH);
    if (isCompleteRoomCode(candidate)) return candidate;
  }
  const words = upper.split(/[^A-Z0-9]+/);
  for (let i = words.length - 1; i >= 0; i--) {
    const word = words[i];
    if (word !== undefined && isCompleteRoomCode(word)) return word;
  }
  return sanitizeRoomCodeInput(upper);
}

/**
 * Tidies a typed rider name before it is sent or stored: control characters dropped, runs of
 * white space collapsed, trimmed, cut to MAX_PLAYER_NAME_LENGTH code points. May return ''. The
 * host sanitises again (and substitutes its fallback name); this only keeps the field honest.
 */
export function cleanPlayerNameInput(raw: string): string {
  let out = '';
  let count = 0;
  let pendingSpace = false;
  for (const char of raw) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) {
      // Tabs and line breaks count as a space; a leading one is dropped.
      pendingSpace = out.length > 0;
      continue;
    }
    // Other control characters vanish without leaving a gap.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) continue;
    if (pendingSpace) {
      if (count + 1 >= MAX_PLAYER_NAME_LENGTH) break;
      out += ' ';
      count += 1;
      pendingSpace = false;
    }
    if (count >= MAX_PLAYER_NAME_LENGTH) break;
    out += char;
    count += 1;
  }
  return out;
}
