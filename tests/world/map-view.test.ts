import { Frustum, Matrix4, PerspectiveCamera } from 'three';
import type { BufferGeometry, Mesh, MeshLambertMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  QUALITY_PRESETS,
  TEAM_EMBER,
  TEAM_FROST,
  buildMapTriangles,
  createGreyboxSpires,
} from '../../src/shared';
import { createMapDebugMarkers, createMapView, mapDrawDistance } from '../../src/world/map';
import type { MapView } from '../../src/world/map';

const map = createGreyboxSpires();

function chunkMeshes(view: MapView): Mesh<BufferGeometry>[] {
  return view.object.children as Mesh<BufferGeometry>[];
}

describe('createMapView', () => {
  const view = createMapView(map, QUALITY_PRESETS.medium);
  const meshes = chunkMeshes(view);
  const triangles = buildMapTriangles(map);

  it('draws exactly the collision triangles, one mesh per non-empty chunk', () => {
    expect(meshes.length).toBe(triangles.chunks.length);
    expect(view.stats.chunkCount).toBe(triangles.chunks.length);
    expect(view.stats.triangleCount).toBe(triangles.triangleCount);
    let indexTotal = 0;
    let vertexTotal = 0;
    for (const mesh of meshes) {
      indexTotal += mesh.geometry.getIndex()?.count ?? 0;
      vertexTotal += mesh.geometry.getAttribute('position').count;
    }
    expect(indexTotal).toBe(triangles.triangleCount * 3);
    expect(vertexTotal).toBe(triangles.vertexCount);
  });

  it('stays far inside the Low and Medium budgets', () => {
    // Worst case = every chunk on screen at once.
    expect(view.stats.chunkCount).toBeLessThanOrEqual(64);
    expect(view.stats.chunkCount).toBeLessThan(QUALITY_PRESETS.low.maxDrawCalls / 2);
    expect(view.stats.triangleCount).toBeLessThan(QUALITY_PRESETS.low.maxTriangles / 10);
  });

  it('shares one cheap material and never recomputes matrices', () => {
    const material = meshes[0]?.material;
    expect(material).toBeDefined();
    const identity = new Matrix4();
    for (const mesh of meshes) {
      expect(mesh.material).toBe(material);
      expect(mesh.matrixAutoUpdate).toBe(false);
      expect(mesh.matrixWorld.equals(identity)).toBe(true);
    }
    const lambert = material as MeshLambertMaterial;
    expect(lambert.type).toBe('MeshLambertMaterial');
    expect(lambert.vertexColors).toBe(true);
    expect(lambert.fog).toBe(true);
  });

  it('gives every chunk normals, colours and a bounding sphere that holds its vertices', () => {
    for (const mesh of meshes) {
      const geometry = mesh.geometry;
      const position = geometry.getAttribute('position');
      const color = geometry.getAttribute('color');
      expect(geometry.getAttribute('normal').count).toBe(position.count);
      expect(color.count).toBe(position.count);
      expect(color.itemSize).toBe(3);
      const sphere = geometry.boundingSphere;
      expect(sphere).not.toBeNull();
      if (sphere === null) continue;
      let worst = 0;
      let colorMin = Infinity;
      let colorMax = -Infinity;
      for (let i = 0; i < position.count; i++) {
        const d = Math.hypot(
          position.getX(i) - sphere.center.x,
          position.getY(i) - sphere.center.y,
          position.getZ(i) - sphere.center.z,
        );
        worst = Math.max(worst, d);
        for (let c = 0; c < 3; c++) {
          const value = color.getComponent(i, c);
          colorMin = Math.min(colorMin, value);
          colorMax = Math.max(colorMax, value);
        }
      }
      expect(worst).toBeLessThanOrEqual(sphere.radius);
      // Tight: not a whole-map sphere.
      expect(sphere.radius).toBeLessThan(450);
      expect(colorMin).toBeGreaterThanOrEqual(0);
      expect(colorMax).toBeLessThanOrEqual(1);
    }
  });

  it('frustum-culls: a camera at a gate looking at the centre draws only part of the map', () => {
    const gate = map.spawnGates[TEAM_EMBER];
    expect(gate).toBeDefined();
    if (gate === undefined) return;
    const camera = new PerspectiveCamera(60, 16 / 9, 0.5, 3000);
    camera.position.set(gate.position.x, gate.position.y, gate.position.z);
    camera.lookAt(0, 260, 0);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    view.update(camera.position);
    let drawn = 0;
    for (const mesh of meshes) {
      const sphere = mesh.geometry.boundingSphere;
      if (mesh.visible && sphere !== null && frustum.intersectsSphere(sphere)) drawn++;
    }
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(meshes.length);
  });

  it('distance-culls only what the fog already hides, the same on every preset', () => {
    const density = map.sky.fogDensity;
    const distance = mapDrawDistance(density);
    // exp2 fog leaves at most 0.5 % of a chunk's colour at the cull distance: toggling it moves
    // a pixel by about one 8-bit level, so nothing pops in (at 97 % it was about six).
    const visible = Math.exp(-((density * distance) ** 2));
    expect(visible).toBeLessThanOrEqual(0.005 + 1e-12);
    expect(visible * 255).toBeLessThan(1.5);
    expect(distance).toBeGreaterThan(1300);
    expect(distance).toBeLessThan(1500);
    expect(mapDrawDistance(0)).toBe(Infinity);

    for (const id of ['low', 'medium', 'high'] as const) {
      view.setQuality(QUALITY_PRESETS[id]);
      expect(view.stats.drawDistance).toBe(distance);
    }
    view.setQuality(QUALITY_PRESETS.low);
    view.update({ x: 0, y: 300, z: 0 });
    expect(view.stats.chunksInRange).toBe(meshes.length);
    view.update({ x: 0, y: 300, z: -900 });
    expect(view.stats.chunksInRange).toBeLessThan(meshes.length);
    expect(view.stats.chunksInRange).toBeGreaterThan(0);
    expect(meshes.filter((mesh) => mesh.visible).length).toBe(view.stats.chunksInRange);
    view.update({ x: 0, y: 300, z: 50_000 });
    expect(view.stats.chunksInRange).toBe(0);
    view.setQuality(QUALITY_PRESETS.medium);
  });

  it('follows the preset for shadows', () => {
    view.setQuality(QUALITY_PRESETS.low);
    expect(meshes.every((mesh) => !mesh.castShadow && !mesh.receiveShadow)).toBe(true);
    view.setQuality(QUALITY_PRESETS.medium);
    expect(meshes.every((mesh) => !mesh.castShadow && mesh.receiveShadow)).toBe(true);
    view.setQuality(QUALITY_PRESETS.high);
    expect(meshes.every((mesh) => mesh.castShadow && mesh.receiveShadow)).toBe(true);
  });

  it('accepts a coarser chunk size without changing the triangles', () => {
    const coarse = createMapView(map, QUALITY_PRESETS.medium, { chunkSize: 500 });
    expect(coarse.stats.triangleCount).toBe(view.stats.triangleCount);
    expect(coarse.stats.chunkCount).toBeLessThanOrEqual(16);
    coarse.dispose();
    expect(coarse.object.children.length).toBe(0);
  });

  it('gives an empty group for a map without solids', () => {
    const empty = createMapView({ ...map, solids: [] }, QUALITY_PRESETS.medium);
    expect(empty.object.children.length).toBe(0);
    expect(empty.stats.triangleCount).toBe(0);
    empty.update({ x: 0, y: 0, z: 0 });
    empty.dispose();
  });
});

describe('createMapDebugMarkers', () => {
  it('is two hidden draw calls with finite data covering both gates', () => {
    const markers = createMapDebugMarkers(map);
    expect(markers.object.visible).toBe(false);
    expect(markers.object.children.length).toBe(2);
    const gates = markers.object.children[0] as Mesh<BufferGeometry>;
    const position = gates.geometry.getAttribute('position');
    const emberShapes = (map.spawnGates[TEAM_EMBER]?.slots.length ?? 0) + 1;
    const frostShapes = (map.spawnGates[TEAM_FROST]?.slots.length ?? 0) + 1;
    // 3-sided darts (6 triangles) for Ember, 4-sided diamonds (8) for Frost.
    expect(position.count).toBe((emberShapes * 6 + frostShapes * 8) * 3);
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < position.count; i++) {
      expect(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i))).toBe(true);
      minZ = Math.min(minZ, position.getZ(i));
      maxZ = Math.max(maxZ, position.getZ(i));
    }
    expect(minZ).toBeLessThan(-700);
    expect(maxZ).toBeGreaterThan(700);
    markers.setVisible(true);
    expect(markers.object.visible).toBe(true);
    markers.dispose();
  });
});
