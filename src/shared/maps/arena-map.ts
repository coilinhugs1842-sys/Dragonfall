/**
 * What every playable map object carries, greybox or real: a MapManifest plus the few fields the
 * game layer relies on (the layout seed that travels in MATCH_START, the chunk grid, the drawn
 * cloud-sea level and the central objective).
 */

import type { MapColliders, MapManifest, SpawnGate } from '../manifests';
import type { Vec3 } from '../math-types';

export interface ArenaColliders extends MapColliders {
  readonly cloudSeaY: number;
}

export interface ArenaMap extends MapManifest {
  readonly seed: number;
  readonly chunkSize: number;
  readonly colliders: ArenaColliders;
  /** Indexed by TeamId: `[TEAM_EMBER]` at -Z, `[TEAM_FROST]` at +Z. */
  readonly spawnGates: readonly SpawnGate[];
  /** The central objective: where the glowing core floats, and the radius of the ring around it. */
  readonly skyWell: { readonly position: Vec3; readonly ringRadius: number };
}
