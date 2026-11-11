/**
 * Player-name hygiene for the host: a name arrives in `hello` as untrusted text and ends up in
 * every client's lobby panel, nameplates and killfeed.
 */

import { FALLBACK_PLAYER_NAME, MAX_PLAYER_NAME_LENGTH } from '../../shared/lobby';

/** Raw input is cut to this many UTF-16 units before any work, so a huge `hello` stays cheap. */
const MAX_RAW_NAME_UNITS = 256;

/**
 * C0/C1 controls, DEL, zero-width and bidi format characters, variation of BOM. They either
 * break layout or let a name impersonate another one.
 */
const INVISIBLE_CHARS = /[\u0000-\u001f\u007f-\u009f­؜​-‏‪-‮⁠-⁯﻿￹-￻]/g;
/** In unicode mode a surrogate range only matches unpaired halves. */
const LONE_SURROGATES = /[\uD800-\uDFFF]/gu;

function capCodePoints(text: string, max: number): string {
  let units = 0;
  let count = 0;
  for (const char of text) {
    if (count === max) break;
    units += char.length;
    count += 1;
  }
  return units === text.length ? text : text.slice(0, units);
}

/**
 * Cleans a name: anything that is not a string becomes the fallback; whitespace runs (tabs and
 * newlines included) collapse to one space; control and invisible format characters are
 * dropped; the result is trimmed and capped at MAX_PLAYER_NAME_LENGTH code points. Never returns
 * an empty string. It does not escape markup: views must set names as text, never as HTML.
 */
export function sanitizePlayerName(raw: unknown): string {
  if (typeof raw !== 'string') return FALLBACK_PLAYER_NAME;
  const cleaned = raw
    .slice(0, MAX_RAW_NAME_UNITS)
    .replace(LONE_SURROGATES, '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(INVISIBLE_CHARS, '')
    .replace(/ {2,}/g, ' ')
    .trim();
  const capped = capCodePoints(cleaned, MAX_PLAYER_NAME_LENGTH).trim();
  return capped.length > 0 ? capped : FALLBACK_PLAYER_NAME;
}

function nameKey(name: string): string {
  return name.toLowerCase();
}

/**
 * Makes `name` (already sanitised) unique among `taken`, ignoring case: "Ash" → "Ash 2" →
 * "Ash 3". The base is shortened when needed so the result still fits the length cap.
 */
export function dedupePlayerName(name: string, taken: readonly string[]): string {
  const used = new Set<string>();
  for (const other of taken) used.add(nameKey(other));
  if (!used.has(nameKey(name))) return name;
  // `taken.length + 2` candidates always contain a free one.
  for (let n = 2; n <= taken.length + 2; n++) {
    const suffix = ` ${n}`;
    const base = capCodePoints(name, MAX_PLAYER_NAME_LENGTH - suffix.length).trim();
    const candidate = base + suffix;
    if (!used.has(nameKey(candidate))) return candidate;
  }
  return name;
}
