/**
 * HUD glyphs: one small line drawing per ability, damage source and status, as SVG path data on
 * a 16-unit box (stroked with `currentColor`, no fill). Our own shapes: each class keeps one
 * visual idea (Talon darts and chevrons, Bastion plates and arcs, Tempest forks, Wraith smoke).
 * Pooled HUD nodes hold one `<path>` and swap its `d` when the glyph changes.
 */

import type { AbilitySlot, DragonClassId } from '../../shared/classes';
import type { DamageSource, ObjectiveKind } from '../../shared/events';

const SHIELD = 'M8 2 13 4V8C13 11 10.8 13 8 14 5.2 13 3 11 3 8V4Z';
const CHEVRONS = 'M3 4 7 8 3 12M8 4 12 8 8 12';
const OPEN_EYE_STRUCK =
  'M1.5 8C3.3 5 5.5 3.6 8 3.6S12.7 5 14.5 8C12.7 11 10.5 12.4 8 12.4S3.3 11 1.5 8ZM3 13 13 3';
const WIND = 'M2 6H10A2 2 0 1 0 8 4M2 9.5H12.5A2 2 0 1 1 10.5 11.5M2 13H6';

export const ABILITY_GLYPHS: Readonly<
  Record<DragonClassId, Readonly<Record<AbilitySlot, string>>>
> = {
  talon: {
    // Fire bolts: a dart with two trailing sparks.
    primary: 'M13 3 7.5 8.5M13 3H9.5M13 3V6.5M6 10 3 13M9.5 11 7.5 13',
    // Searing dash.
    secondary: CHEVRONS,
    // Afterburn: a wavering trail.
    utility: 'M2 11C4 9 5 12 7 10S10 8 14 5M2 7C3.5 6 4.5 7.5 6 6.5',
    // Meteor strafe: three falling stones in a line.
    ultimate:
      'M2.5 5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M6.5 8a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M10.5 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M6.5 1.5 5.2 3.2M10.5 4.5 9.2 6.2M14.5 7.5 13.2 9.2',
  },
  bastion: {
    // Flame cone.
    primary: 'M2.5 8 13 3.5M2.5 8 13 12.5M13 3.5C14.5 6.5 14.5 9.5 13 12.5M6.5 8H10',
    // Wing shield.
    secondary: SHIELD,
    // Rally roar: a mending cross between two calls.
    utility: 'M8 6V10M6 8H10M3.5 4.5A6 6 0 0 0 3.5 11.5M12.5 4.5A6 6 0 0 1 12.5 11.5',
    // Bulwark charge: a drive into a bow wave.
    ultimate: 'M2 8H9M6.5 5 9.5 8 6.5 11M12 3C13.5 6 13.5 10 12 13',
  },
  tempest: {
    // Lightning lance.
    primary: 'M10 1.5 5 8.5H8.5L6 14.5 11.5 6.5H8Z',
    // Static mine.
    secondary: 'M5 8a3 3 0 1 0 6 0a3 3 0 1 0-6 0M8 2V3.5M8 12.5V14M2 8H3.5M12.5 8H14',
    // Updraft.
    utility: 'M8 13V3M4.5 6.5 8 3 11.5 6.5M4 13H12',
    // Thunderhead: a cloud with a fork under it.
    ultimate:
      'M4.5 9H11.5A2.5 2.5 0 0 0 11.5 4 3.5 3.5 0 0 0 5 4.5 2.3 2.3 0 0 0 4.5 9ZM8.5 10 7 12H9L7.5 14.5',
  },
  wraith: {
    // Shade breath: drifting smoke.
    primary: 'M2.5 9C4.5 6 6 11 8 8S11.5 5 13.5 7M4 12.5C5.5 11 7 13.5 9 12',
    // Veil.
    secondary: OPEN_EYE_STRUCK,
    // Phase dive: a broken line passing through a surface.
    utility: 'M8 2V4M8 6V8M8 10V13.5M5 10.5 8 13.5 11 10.5M2.5 8H5.5M10.5 8H13.5',
    // Night terror.
    ultimate: 'M11.5 2.5A6 6 0 1 0 13.5 11 5 5 0 0 1 11.5 2.5Z',
  },
};

/** For takedowns nobody dealt: rock and the storm wall. */
export const ENVIRONMENT_GLYPHS: Readonly<Record<'terrain' | 'storm', string>> = {
  terrain: 'M1.5 13 6 5 8.5 9 10.5 6.5 14.5 13Z',
  storm: WIND,
};

/** A plain mark for a killfeed row whose source or class is unknown. */
export const PLAIN_TAKEDOWN_GLYPH = 'M3 8H11M8 4.5 11.5 8 8 11.5';

/** The glyph between the two names of a killfeed row. */
export function takedownGlyph(
  source: DamageSource | undefined,
  killerClassId: DragonClassId | null | undefined,
): string {
  if (source === 'terrain' || source === 'storm') return ENVIRONMENT_GLYPHS[source];
  if (source === undefined || killerClassId === null || killerClassId === undefined) {
    return PLAIN_TAKEDOWN_GLYPH;
  }
  return ABILITY_GLYPHS[killerClassId][source];
}

// --- Ember Relay (T-6.3) ----------------------------------------------------------------------------

/**
 * A sky-shard as a FILLED mark (compass, shard strip): a tall six-sided crystal with its
 * owner's team shape cut out of the middle (triangle = Ember, diamond = Frost), so whose shard
 * it is never rests on colour alone. The hole is the inner outline drawn the other way round.
 */
export const SHARD_SHAPES: Readonly<Record<'ember' | 'frost' | 'none', string>> = {
  ember: 'M8 0.6 14 4V12L8 15.4 2 12V4ZM8 4.4 4.7 10.6H11.3Z',
  frost: 'M8 0.6 14 4V12L8 15.4 2 12V4ZM8 4 4.6 8 8 12 11.4 8Z',
  none: 'M8 0.6 14 4V12L8 15.4 2 12V4Z',
};

/** The local team's brazier as a filled mark: a flame over a bowl. */
export const BRAZIER_SHAPE =
  'M8 0.8C10.4 3.4 11.2 5.4 10 7.6H6C4.8 5.4 5.6 3.4 8 0.8ZM1.8 9H14.2L11.6 14.6H4.4Z';

/** Feed-line glyphs for what happened to a shard (line drawings, like the ability glyphs). */
export const OBJECTIVE_GLYPHS: Readonly<Record<ObjectiveKind, string>> = {
  // Lifted: a crystal under a rising chevron.
  pickedUp: 'M8 6 11 7.8V11.6L8 13.4 5 11.6V7.8ZM5.2 4.4 8 2 10.8 4.4',
  // Let fall: a crystal over a falling chevron.
  dropped: 'M8 2.2 11 4V7.8L8 9.6 5 7.8V4ZM5.2 11.6 8 14 10.8 11.6',
  // Sent home: a crystal inside a turning arrow.
  returned: 'M8 5.2 10.2 6.5V9.5L8 10.8 5.8 9.5V6.5ZM3 9.5A5.2 5.2 0 1 0 4.2 4.4M4.2 1.6V4.4H7',
  // Brought to the brazier: a flame over a bowl.
  captured: 'M8 2C9.8 4 10.4 5.6 9.5 7.4H6.5C5.6 5.6 6.2 4 8 2ZM2.6 9.4H13.4L11.4 13.8H4.6Z',
  // Sky Crown's (not drawn yet): a plain ring.
  zoneTaken: 'M3 8a5 5 0 1 0 10 0a5 5 0 1 0-10 0',
};

export interface StatusGlyph {
  /** DRAGON_FLAG_* bit that shows it. */
  readonly key: StatusKey;
  readonly label: string;
  readonly d: string;
  /** Harmful effects are tinted as warnings; helpful ones stay parchment. */
  readonly harmful: boolean;
}

export type StatusKey =
  | 'protected'
  | 'shielded'
  | 'veiled'
  | 'phasing'
  | 'hasted'
  | 'regen'
  | 'slowed'
  | 'burning'
  | 'blinded'
  | 'storm';

export const STATUS_GLYPHS: readonly StatusGlyph[] = [
  { key: 'protected', label: 'Gate ward', d: SHIELD + 'M8 5.5V10.5', harmful: false },
  { key: 'shielded', label: 'Shield', d: SHIELD, harmful: false },
  { key: 'veiled', label: 'Veiled', d: OPEN_EYE_STRUCK, harmful: false },
  { key: 'phasing', label: 'Phasing', d: 'M3 3H10V10H3ZM6 6H13V13H6Z', harmful: false },
  { key: 'hasted', label: 'Haste', d: CHEVRONS, harmful: false },
  { key: 'regen', label: 'Mending', d: 'M8 3.5V12.5M3.5 8H12.5', harmful: false },
  { key: 'slowed', label: 'Slowed', d: 'M4 4 8 8 12 4M4 9 8 13 12 9', harmful: true },
  {
    key: 'burning',
    label: 'Burning',
    d: 'M8 14C5 14 3.5 12 3.5 9.8 3.5 7 6 6 6.5 2.5 9.5 4 12.5 6.8 12.5 9.8 12.5 12 11 14 8 14Z',
    harmful: true,
  },
  {
    key: 'blinded',
    label: 'Blinded',
    d: 'M2 7C4 10 6 11 8 11S12 10 14 7M4.5 10 3.5 12M8 11V13M11.5 10 12.5 12',
    harmful: true,
  },
  { key: 'storm', label: 'In the storm', d: WIND, harmful: true },
];
