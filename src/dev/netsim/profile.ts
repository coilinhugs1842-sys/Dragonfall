/**
 * Netsim profiles: named network conditions and the `?netsim=` parser.
 *
 * Tiny, pure and import-free on purpose: `../query-flags` (which main.ts loads statically)
 * imports this file, so nothing heavier may be pulled in from here.
 *
 * All numbers are ONE-WAY and apply to each direction a wrapper simulates. A wrapper around one
 * end simulates both directions by default, so `bad` adds about 160 ms to the round trip and
 * each direction loses 2 % of its `fast` packets on its own.
 */

export interface NetsimProfile {
  /** A key of `NETSIM_PROFILES`, or 'custom' for numbers typed into the URL or the panel. */
  readonly name: string;
  /** Mean one-way delay in ms. */
  readonly latencyMs: number;
  /** Delay varies within latency ± jitter (never below 0). */
  readonly jitterMs: number;
  /** `fast` packets lost, in percent (0..100). `ctrl` is never lost. */
  readonly lossPct: number;
  /** `fast` packets delivered twice, in percent. */
  readonly duplicatePct: number;
  /** `fast` packets held back by an extra delay so later ones overtake them, in percent. */
  readonly reorderPct: number;
}

export type NetsimProfileName = 'off' | 'lan' | 'wifi' | 'bad' | 'awful';

export const NETSIM_PROFILE_NAMES: readonly NetsimProfileName[] = [
  'off',
  'lan',
  'wifi',
  'bad',
  'awful',
];

function profile(
  name: string,
  latencyMs: number,
  jitterMs: number,
  lossPct: number,
): NetsimProfile {
  return Object.freeze({ name, latencyMs, jitterMs, lossPct, duplicatePct: 0, reorderPct: 0 });
}

export const NETSIM_PROFILES: Readonly<Record<NetsimProfileName, NetsimProfile>> = Object.freeze({
  off: profile('off', 0, 0, 0),
  lan: profile('lan', 2, 1, 0),
  wifi: profile('wifi', 20, 8, 0.5),
  /** The standard test profile of docs/NETWORKING.md ("bad Wi-Fi"). */
  bad: profile('bad', 80, 20, 2),
  awful: profile('awful', 150, 50, 5),
});

/** What a bare `?netsim` means. */
export const DEFAULT_NETSIM_PROFILE: NetsimProfile = NETSIM_PROFILES.bad;

export const NETSIM_LIMITS = Object.freeze({
  latencyMaxMs: 2000,
  jitterMaxMs: 1000,
  percentMax: 100,
});

export function isNetsimProfileName(value: unknown): value is NetsimProfileName {
  return typeof value === 'string' && Object.hasOwn(NETSIM_PROFILES, value);
}

function clamp(value: number, max: number): number {
  return value < 0 ? 0 : value > max ? max : value;
}

/** A custom profile with every number clamped to its legal range (NaN becomes 0). */
export function createNetsimProfile(
  latencyMs: number,
  jitterMs = 0,
  lossPct = 0,
  duplicatePct = 0,
  reorderPct = 0,
): NetsimProfile {
  const fix = (v: number, max: number): number => (Number.isFinite(v) ? clamp(v, max) : 0);
  return Object.freeze({
    name: 'custom',
    latencyMs: fix(latencyMs, NETSIM_LIMITS.latencyMaxMs),
    jitterMs: fix(jitterMs, NETSIM_LIMITS.jitterMaxMs),
    lossPct: fix(lossPct, NETSIM_LIMITS.percentMax),
    duplicatePct: fix(duplicatePct, NETSIM_LIMITS.percentMax),
    reorderPct: fix(reorderPct, NETSIM_LIMITS.percentMax),
  });
}

/**
 * Parses the value of `?netsim=`:
 *
 * - a profile name (`bad`, case-insensitive),
 * - `latency,jitter,loss[,duplicate[,reorder]]` in ms, ±ms and percent (`80,20,2`; trailing
 *   numbers may be left out: `80` or `80,20`),
 * - '' (a bare `?netsim`) or `1` / `true` / `on`: the standard `bad` profile,
 * - `0` / `false` / `no`: `off`.
 *
 * Returns null for null and for anything else (unknown name, junk or negative numbers, too many
 * fields), so a typo fails visibly instead of silently testing the wrong conditions.
 */
export function parseNetsimProfile(value: string | null | undefined): NetsimProfile | null {
  if (value === null || value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === '' || v === '1' || v === 'true' || v === 'on') return DEFAULT_NETSIM_PROFILE;
  if (v === '0' || v === 'false' || v === 'no') return NETSIM_PROFILES.off;
  if (isNetsimProfileName(v)) return NETSIM_PROFILES[v];

  const parts = v.split(',');
  if (parts.length > 5) return null;
  const n = [0, 0, 0, 0, 0];
  for (let i = 0; i < parts.length; i++) {
    const text = parts[i]?.trim() ?? '';
    if (text === '') return null;
    const parsed = Number(text);
    if (!Number.isFinite(parsed) || parsed < 0) return null;
    n[i] = parsed;
  }
  return createNetsimProfile(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 0, n[4] ?? 0);
}

/** `bad (80 ms ±20, 2% loss)`: for logs and the debug panel. */
export function describeNetsimProfile(p: NetsimProfile): string {
  let text = `${p.name} (${p.latencyMs} ms ±${p.jitterMs}, ${p.lossPct}% loss`;
  if (p.duplicatePct > 0) text += `, ${p.duplicatePct}% dup`;
  if (p.reorderPct > 0) text += `, ${p.reorderPct}% reorder`;
  return `${text})`;
}
