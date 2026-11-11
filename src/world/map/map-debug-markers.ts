/**
 * Optional debug overlay for a map: where the spawn gates and their slots are, and where the
 * storm wall stands. Two draw calls in total (one merged marker mesh, one line set), unlit,
 * unfogged so they stay readable from across the arena. Hidden by default.
 *
 * Team shapes follow the colour-blind rule of docs/GAME_DESIGN.md: Ember markers are triangular
 * (3-sided darts), Frost markers are diamonds (4-sided spindles). The storm hint is magenta.
 */

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { TEAMS, TEAM_EMBER } from '../../shared';
import type { MapManifest, Quat, Vec3 } from '../../shared';
import { writeLinearFromSrgbHex } from './map-colors';

const HAZARD_MAGENTA = 0xff3fa4;
const GATE_RADIUS = 7;
const GATE_LENGTH = 26;
const SLOT_RADIUS = 1.6;
const SLOT_LENGTH = 5;
const STORM_RING_SEGMENTS = 96;
const STORM_POSTS = 16;

export interface MapDebugMarkers {
  /** Add to the scene once; toggle with `setVisible`. */
  readonly object: Group;
  setVisible(visible: boolean): void;
  dispose(): void;
}

/** Triangles a spindle with `sides` sides emits (front cone + back cone). */
function spindleTriangles(sides: number): number {
  return sides * 2;
}

/**
 * Writes a spindle: a ring of `sides` points around `center`, joined to an apex `frontLength`
 * ahead (local +Z of `orientation`) and one `backLength` behind. Returns the next vertex index.
 */
function writeSpindle(
  positions: Float32Array,
  colors: Float32Array,
  vertex: number,
  center: Vec3,
  orientation: Quat,
  sides: number,
  radius: number,
  frontLength: number,
  backLength: number,
  color: Float32Array,
): number {
  const rotation = new Quaternion(orientation.x, orientation.y, orientation.z, orientation.w);
  const point = new Vector3();
  const put = (x: number, y: number, z: number): void => {
    point.set(x, y, z).applyQuaternion(rotation);
    const o = vertex * 3;
    positions[o] = center.x + point.x;
    positions[o + 1] = center.y + point.y;
    positions[o + 2] = center.z + point.z;
    colors[o] = color[0] ?? 0;
    colors[o + 1] = color[1] ?? 0;
    colors[o + 2] = color[2] ?? 0;
    vertex++;
  };
  const step = (Math.PI * 2) / sides;
  for (let k = 0; k < sides; k++) {
    // First ring point straight up, so a 3-sided dart reads as an upright triangle.
    const a0 = Math.PI / 2 + k * step;
    const a1 = a0 + step;
    const x0 = Math.cos(a0) * radius;
    const y0 = Math.sin(a0) * radius;
    const x1 = Math.cos(a1) * radius;
    const y1 = Math.sin(a1) * radius;
    put(x0, y0, 0);
    put(x1, y1, 0);
    put(0, 0, frontLength);
    put(x1, y1, 0);
    put(x0, y0, 0);
    put(0, 0, -backLength);
  }
  return vertex;
}

function buildGateGeometry(map: MapManifest): BufferGeometry {
  let triangleCount = 0;
  for (const gate of map.spawnGates) {
    const sides = gate.team === TEAM_EMBER ? 3 : 4;
    triangleCount += spindleTriangles(sides) * (1 + gate.slots.length);
  }
  const positions = new Float32Array(triangleCount * 9);
  const colors = new Float32Array(triangleCount * 9);
  const color = new Float32Array(3);
  let vertex = 0;
  for (const gate of map.spawnGates) {
    const ember = gate.team === TEAM_EMBER;
    const sides = ember ? 3 : 4;
    writeLinearFromSrgbHex(TEAMS[gate.team].color, color);
    // Above the launch ledge, so the marker is not buried in the gate geometry.
    const above = { x: gate.position.x, y: gate.position.y + 40, z: gate.position.z };
    vertex = writeSpindle(
      positions,
      colors,
      vertex,
      above,
      gate.orientation,
      sides,
      GATE_RADIUS,
      GATE_LENGTH,
      ember ? 0 : GATE_LENGTH * 0.5,
      color,
    );
    for (const slot of gate.slots) {
      vertex = writeSpindle(
        positions,
        colors,
        vertex,
        slot,
        gate.orientation,
        sides,
        SLOT_RADIUS,
        SLOT_LENGTH,
        ember ? 0 : SLOT_LENGTH * 0.5,
        color,
      );
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function buildStormGeometry(map: MapManifest): BufferGeometry {
  const { stormCenter, stormRadius, ceilingY, floorY } = map.colliders;
  const seaY = map.colliders.cloudSeaY ?? floorY;
  const ringYs = [seaY, (seaY + ceilingY) * 0.5, ceilingY];
  const segmentCount = ringYs.length * STORM_RING_SEGMENTS + STORM_POSTS;
  const positions = new Float32Array(segmentCount * 6);
  let o = 0;
  const put = (angle: number, y: number): void => {
    positions[o] = stormCenter.x + Math.cos(angle) * stormRadius;
    positions[o + 1] = y;
    positions[o + 2] = stormCenter.z + Math.sin(angle) * stormRadius;
    o += 3;
  };
  const step = (Math.PI * 2) / STORM_RING_SEGMENTS;
  for (const y of ringYs) {
    for (let k = 0; k < STORM_RING_SEGMENTS; k++) {
      put(k * step, y);
      put((k + 1) * step, y);
    }
  }
  for (let k = 0; k < STORM_POSTS; k++) {
    const angle = (k / STORM_POSTS) * Math.PI * 2;
    put(angle, seaY);
    put(angle, ceilingY);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Load-time only. The markers show the manifest's static data, not the live storm zone. */
export function createMapDebugMarkers(map: MapManifest): MapDebugMarkers {
  const object = new Group();
  object.name = 'map-debug-markers';
  object.matrixAutoUpdate = false;
  object.visible = false;

  const gateGeometry = buildGateGeometry(map);
  const gateMaterial = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
    fog: false,
    toneMapped: false,
  });
  const gates = new Mesh(gateGeometry, gateMaterial);
  gates.name = 'map-debug-gates';
  gates.matrixAutoUpdate = false;
  object.add(gates);

  const stormGeometry = buildStormGeometry(map);
  const stormMaterial = new LineBasicMaterial({
    color: HAZARD_MAGENTA,
    fog: false,
    toneMapped: false,
  });
  const storm = new LineSegments(stormGeometry, stormMaterial);
  storm.name = 'map-debug-storm';
  storm.matrixAutoUpdate = false;
  object.add(storm);

  return {
    object,
    setVisible(visible: boolean): void {
      object.visible = visible;
    },
    dispose(): void {
      gateGeometry.dispose();
      gateMaterial.dispose();
      stormGeometry.dispose();
      stormMaterial.dispose();
      object.clear();
    },
  };
}
