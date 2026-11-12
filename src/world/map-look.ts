/**
 * Switches a scene's sky, fog, lights, sea and cloud puffs to a map's look.
 *
 * The stage builds those views once, from the default map, and the title and the lobby keep
 * that sky. A match on another map calls `use(itsMap)` when it loads and `use(defaultMap)`
 * when it unloads. Nothing is rebuilt: every view repaints through uniform and buffer writes,
 * so there is no second set of textures and no shader to compile.
 *
 * Load-time code (it scatters the cloud puffs again): never per frame.
 */
import type { Scene } from 'three';
import type { MapManifest } from '../shared';
import { cloudFieldFromMap } from './clouds/cloud-placement';
import type { CloudBillboards } from './clouds/cloud-billboards';
import type { CloudSea } from './clouds/cloud-sea';
import type { WorldLighting } from './light/world-lighting';
import type { SkyDome } from './sky/sky-dome';
import { applySkyFog } from './sky/sky-fog';

/** The views a look is applied to: the ones `createStage` builds for every scene. */
export interface MapLookViews {
  readonly scene: Scene;
  readonly sky: SkyDome;
  readonly sea: CloudSea;
  readonly clouds: CloudBillboards;
  /** Also recolours the sun and hemisphere lights it was created with. */
  readonly lighting: WorldLighting;
}

/** What a look reads from a map. */
export type MapLookSource = Pick<MapManifest, 'id' | 'sky' | 'colliders' | 'spawnGates' | 'solids'>;

/** How far above the flight ceiling the light shafts start, metres. */
export const LIGHT_SHAFT_TOP_MARGIN = 200;

export interface MapLook {
  /** The map whose look the views show now. */
  readonly mapId: MapManifest['id'];
  /** Shows `map`'s look. A no-op when the views already show it. */
  use(map: MapLookSource): void;
}

/** `initial` is the map the views were created from (nothing is written for it). */
export function createMapLook(views: MapLookViews, initial: MapLookSource): MapLook {
  let current = initial.id;
  return {
    get mapId() {
      return current;
    },
    use(map: MapLookSource): void {
      if (map.id === current) return;
      current = map.id;
      const sky = map.sky;
      const cloudSeaY = map.colliders.cloudSeaY ?? map.colliders.floorY;
      // The sea and the puffs hide their edges in this fog, and the sky's horizon matches it.
      applySkyFog(views.scene, sky);
      views.sky.setSky(sky);
      views.sea.setSky(sky, cloudSeaY);
      views.clouds.setField(cloudFieldFromMap(map), sky);
      views.lighting.setSky(
        sky,
        cloudSeaY,
        sky.lightShafts === false
          ? null
          : {
              center: map.colliders.stormCenter,
              radius: map.colliders.stormRadius,
              topY: map.colliders.ceilingY + LIGHT_SHAFT_TOP_MARGIN,
            },
      );
    },
  };
}
