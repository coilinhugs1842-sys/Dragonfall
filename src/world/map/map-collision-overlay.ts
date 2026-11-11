/**
 * Debug overlay: the map's COLLISION triangles drawn over its visuals (`?debug&collision`), to
 * check by eye that what a dragon hits is what the player sees. It triangulates the map with
 * the same `buildMapTriangles` the sim's collision world uses.
 *
 * Two draw calls: a translucent cyan fill (where it shows, the hull stands proud of the rock;
 * where rock shows through, the rock stands proud of the hull) and magenta wire edges. Unlit and
 * unfogged. Hidden by default; never created in normal play.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import { buildMapTriangles } from '../../shared';
import type { MapManifest } from '../../shared';

export interface MapCollisionOverlay {
  /** Add to the scene once; toggle with `setVisible`. */
  readonly object: Group;
  readonly triangleCount: number;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createMapCollisionOverlay(map: MapManifest): MapCollisionOverlay {
  const triangles = buildMapTriangles(map);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(triangles.positions, 3));
  geometry.setIndex(new BufferAttribute(triangles.indices, 1));
  geometry.computeBoundingSphere();

  const fillMaterial = new MeshBasicMaterial({
    color: 0x00e5ff,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
    side: DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const wireMaterial = new MeshBasicMaterial({
    color: 0xff3fa4,
    wireframe: true,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const fill = new Mesh(geometry, fillMaterial);
  const wire = new Mesh(geometry, wireMaterial);
  fill.name = 'map-collision-fill';
  wire.name = 'map-collision-wire';
  fill.renderOrder = 10;
  wire.renderOrder = 11;

  const object = new Group();
  object.name = 'map-collision-overlay';
  object.matrixAutoUpdate = false;
  object.visible = false;
  object.add(fill, wire);
  for (const mesh of [fill, wire]) {
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
  }

  return {
    object,
    triangleCount: triangles.triangleCount,
    setVisible(visible: boolean): void {
      object.visible = visible;
    },
    dispose(): void {
      geometry.dispose();
      fillMaterial.dispose();
      wireMaterial.dispose();
      object.clear();
    },
  };
}
