/**
 * Dragon classes and their ability names (docs/GAME_DESIGN.md, "Dragons").
 * Identity and display text only; the numbers are in tuning.ts.
 */

export type DragonClassId =
  | 'talon'
  | 'bastion'
  | 'tempest'
  | 'wraith'
  | 'verdant'
  | 'aureate'
  | 'zephyr'
  | 'granite'
  | 'mirage';

/** Order is the wire encoding (index = `u8` class id). Append only. */
export const DRAGON_CLASS_IDS: readonly DragonClassId[] = [
  'talon',
  'bastion',
  'tempest',
  'wraith',
  'verdant',
  'aureate',
  'zephyr',
  'granite',
  'mirage',
];

export const DEFAULT_DRAGON_CLASS: DragonClassId = 'talon';

export type AbilitySlot = 'primary' | 'secondary' | 'utility' | 'ultimate';

/** Order is the wire encoding (index = `u8` slot id). */
export const ABILITY_SLOTS: readonly AbilitySlot[] = [
  'primary',
  'secondary',
  'utility',
  'ultimate',
];

export interface AbilityInfo {
  readonly name: string;
  readonly summary: string;
}

export interface DragonClassInfo {
  readonly id: DragonClassId;
  readonly name: string;
  readonly role: string;
  readonly abilities: Readonly<Record<AbilitySlot, AbilityInfo>>;
}

export const DRAGON_CLASSES: Readonly<Record<DragonClassId, DragonClassInfo>> = {
  talon: {
    id: 'talon',
    name: 'Talon',
    role: 'skirmisher',
    abilities: {
      primary: { name: 'Fire bolts', summary: 'Rapid projectiles' },
      secondary: { name: 'Searing dash', summary: 'Damaging lunge' },
      utility: { name: 'Afterburn', summary: 'Speed trail that burns pursuers' },
      ultimate: { name: 'Meteor strafe', summary: 'Line of fire bombs' },
    },
  },
  bastion: {
    id: 'bastion',
    name: 'Bastion',
    role: 'frontline',
    abilities: {
      primary: { name: 'Flame cone', summary: 'Short range, sustained' },
      secondary: { name: 'Wing shield', summary: 'Blocks frontal damage' },
      utility: { name: 'Rally roar', summary: 'Allies near you heal over time' },
      ultimate: { name: 'Bulwark charge', summary: 'Knock-back wave' },
    },
  },
  tempest: {
    id: 'tempest',
    name: 'Tempest',
    role: 'artillery',
    abilities: {
      primary: { name: 'Lightning lance', summary: 'Charge-up beam, long range' },
      secondary: { name: 'Static mine', summary: 'Area slow' },
      utility: { name: 'Updraft', summary: 'Vertical burst' },
      ultimate: { name: 'Thunderhead', summary: 'Storm cloud that zaps an area' },
    },
  },
  wraith: {
    id: 'wraith',
    name: 'Wraith',
    role: 'ambusher',
    abilities: {
      primary: { name: 'Shade breath', summary: 'Damage over time' },
      secondary: { name: 'Veil', summary: 'Briefly invisible until you attack' },
      utility: { name: 'Phase dive', summary: 'Pass through terrain for 1 s' },
      ultimate: { name: 'Night terror', summary: 'Blinds enemies in a cone' },
    },
  },
  verdant: {
    id: 'verdant',
    name: 'Verdant',
    role: 'support',
    abilities: {
      primary: { name: 'Bloom bolts', summary: 'Rapid thorn projectiles' },
      secondary: { name: 'Mending pod', summary: 'Heal bubble allies can fly through' },
      utility: { name: 'Spur bubble', summary: 'Minor haste buff bubble' },
      ultimate: { name: 'Canopy', summary: 'Large regen field for your team' },
    },
  },
  aureate: {
    id: 'aureate',
    name: 'Aureate',
    role: 'disruptor',
    abilities: {
      primary: { name: 'Prism shards', summary: 'Midrange crystal bolts' },
      secondary: { name: 'Flash orb', summary: 'Light ball that flashbangs enemies' },
      utility: { name: 'Drift haze', summary: 'Bubble that softens enemy control' },
      ultimate: { name: 'Prism storm', summary: 'Lingering deny field ahead' },
    },
  },
  zephyr: {
    id: 'zephyr',
    name: 'Zephyr',
    role: 'scout',
    abilities: {
      primary: { name: 'Gale bolts', summary: 'Fast light projectiles' },
      secondary: { name: 'Blink', summary: 'Short forward teleport' },
      utility: { name: 'Slipstream', summary: 'Speed burst' },
      ultimate: { name: 'Gale wall', summary: 'Deny a lane with wind' },
    },
  },
  granite: {
    id: 'granite',
    name: 'Granite',
    role: 'siege',
    abilities: {
      primary: { name: 'Magma spit', summary: 'Heavy arcing bombs' },
      secondary: { name: 'Magma burst', summary: 'Proximity explosion around you' },
      utility: { name: 'Stone mend', summary: 'Self regen over a few seconds' },
      ultimate: { name: 'Crater smash', summary: 'Impact crater ahead' },
    },
  },
  mirage: {
    id: 'mirage',
    name: 'Mirage',
    role: 'trickster',
    abilities: {
      primary: { name: 'Decoy bolt', summary: 'Soft phantom projectiles' },
      secondary: { name: 'Phantom double', summary: 'Fake dragon that flies straight' },
      utility: { name: 'Mirror step', summary: 'Short blink dash' },
      ultimate: { name: 'Phantasm', summary: 'Blinding mirage field' },
    },
  },
};

export function isDragonClassId(value: unknown): value is DragonClassId {
  return typeof value === 'string' && (DRAGON_CLASS_IDS as readonly string[]).includes(value);
}
