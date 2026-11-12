/**
 * The aerie's team-coloured lights: ONE instanced mesh, one draw call, about 1.3k triangles
 * for all of it, and no real lights.
 *
 * Two kinds of instance share the mesh (the geometry holds both shapes; each instance keeps one
 * and collapses the other to a point in the vertex shader):
 * - PERCH SHARDS, one set per perch: five slivers of crystal floating in an arc in front of the
 *   stone, like the loose shards that drift above the map's spires. Dull tinted glass while the
 *   rider is not ready; when the rider readies up they lift and light up in the team colour.
 * - BRAZIER FIRE, one per brazier of the set: a faceted flame in the team colour, a little
 *   larger than the brazier model's own orange flame, which it hides inside itself. That is how
 *   Frost's fires burn glacier cyan without a second brazier model.
 *
 * Emissive only: bloom (High) picks the bright ones up by itself; on Low and Medium they are
 * simply bright. Per frame: one uniform, and ten floats re-uploaded on the frames a glow moves.
 */
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { TEAM_EMBER } from '../../shared';
import type { TeamId, Vec3 } from '../../shared';
import { WORLD_LIGHT_PARS_FRAGMENT, useWorldLight } from '../../world/light';
import { AERIE_PERCH_COUNT } from './aerie-layout';
import type { AerieLayout } from './aerie-layout';
import type { AerieBrazier } from './aerie-set';

/** Glow colours of the two teams (docs/ART_DIRECTION.md palette), sRGB hex by TeamId. */
const TEAM_GLOW_HEX: readonly number[] = [0xff9a3c, 0x6fe2ff];
/** Palette slate: what an unlit shard is made of. */
const SHARD_STONE_HEX = 0x4e6a86;

/** Metres from the middle of the perch to the arc of shards. */
const SHARD_RING_RADIUS = 3.3;
/** The arc spans this far either side of the way the dragon faces: its tail hangs behind. */
const SHARD_ARC = 1.95;
/** Half-height and half-width of each of the five shards, and its height on the arc. */
const SHARDS: readonly { readonly halfHeight: number; readonly halfWidth: number; readonly y: number }[] = [
  { halfHeight: 0.55, halfWidth: 0.19, y: -0.5 },
  { halfHeight: 0.8, halfWidth: 0.26, y: -1.1 },
  { halfHeight: 1.0, halfWidth: 0.32, y: -1.7 },
  { halfHeight: 0.7, halfWidth: 0.24, y: -1.0 },
  { halfHeight: 0.6, halfWidth: 0.2, y: -0.4 },
];

/** The flame, in the brazier model's own space: rings of (height, radius), bowl to tip. */
const FLAME_RINGS: readonly (readonly [number, number])[] = [
  [4.25, 0.95],
  [5.2, 1.2],
  [6.3, 0.9],
  [7.3, 0.5],
  [8.4, 0],
];
const FLAME_SIDES = 6;
const FLAME_BASE_Y = 4.25;
const FLAME_HEIGHT = 8.4 - 4.25;

const VERTEX = /* glsl */ `
attribute float aPart;      // 0: perch shard, 1: brazier flame
attribute float aSeed;      // per shard, for its own bob
attribute vec3 aTint;       // the instance's team colour, linear
attribute vec4 aState;      // x: glow 0..1, y: unused, z: which part this instance is, w: phase 0..1
uniform float uTime;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTint;
varying vec3 vFx;           // x: glow, y: part, z: phase
varying float vRise;        // flame only: 0 at the bowl, 1 at the tip

void main() {
  vec3 p = position;
  if (aPart < 0.5) {
    // A ready perch lifts its shards; every shard bobs a little on its own.
    p.y += aState.x * 0.9 + sin(uTime * 1.1 + aSeed * 2.3 + aState.w * 6.2832) * 0.2;
  } else {
    float rise = clamp((p.y - ${FLAME_BASE_Y.toFixed(2)}) * ${(1 / FLAME_HEIGHT).toFixed(4)}, 0.0, 1.0);
    p.x += rise * 0.22 * sin(uTime * 9.0 + p.y * 2.3 + aState.w * 40.0);
    p.z += rise * 0.22 * cos(uTime * 7.3 + p.y * 2.9 + aState.w * 23.0);
  }
  // The shape this instance does not use: every vertex to one point (no pixels).
  p *= 1.0 - step(0.5, abs(aPart - aState.z));
  vec4 world = modelMatrix * (instanceMatrix * vec4(p, 1.0));
  vWorldPos = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * normal));
  vTint = aTint;
  vFx = vec3(aState.x, aPart, aState.w);
  vRise = clamp((position.y - ${FLAME_BASE_Y.toFixed(2)}) * ${(1 / FLAME_HEIGHT).toFixed(4)}, 0.0, 1.0);
  gl_Position = projectionMatrix * (viewMatrix * world);
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uStone;
uniform float uGain;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec3 vTint;
varying vec3 vFx;
varying float vRise;
${WORLD_LIGHT_PARS_FRAGMENT}

void main() {
  vec3 N = normalize(vNormal);
  vec3 toCamera = cameraPosition - vWorldPos;
  float dist = max(length(toCamera), 1e-3);
  vec3 V = toCamera / dist;
  float facing = max(dot(N, V), 0.0);
  float flame = step(0.5, vFx.y);
  float phase = vFx.z * 6.2832;

  // Unlit: tinted slate glass under the world's sun, with a faint inner light so the team reads.
  vec3 glass = mix(uStone, vTint, 0.22);
  vec3 dull = wlDiffuse(glass, vWorldPos, N) + wlRim(N, V) * glass + vTint * (0.03 + 0.09 * facing * facing);

  // Lit: the facets facing the eye run hot, the others keep their shape. A flame is hot at the
  // bowl and the team's own colour toward its tip.
  float slow = sin(uTime * 2.4 + phase);
  float flicker = sin(uTime * 11.0 + phase * 8.0) * sin(uTime * 7.3 + phase * 5.0);
  float pulse = 1.0 + mix(0.14 * slow, 0.22 * flicker, flame);
  vec3 hot = mix(vTint, vec3(1.0, 0.96, 0.9), 0.45);
  float core = mix(facing * facing * facing * 0.55, (1.0 - vRise) * (1.0 - vRise) * 0.7, flame);
  vec3 lit = vTint * (uGain * pulse) * mix(0.5 + 0.5 * facing, 0.62 + 0.2 * facing, flame)
           + hot * (core * uGain * pulse);

  float glow = max(vFx.x, flame);
  vec3 color = mix(dull, lit, glow);

  // The scene's fog; a light cuts through it better than stone does.
  color = mix(color, wlHaze(-V), wlFogFactor(vWorldPos, dist) * (1.0 - 0.6 * glow));
  gl_FragColor = vec4(color, 1.0);
}
`;

/** Appends one flat-shaded triangle (three fresh vertices, the face normal on each). */
function pushTriangle(
  positions: number[],
  normals: number[],
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): void {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = cx - ax;
  const wy = cy - ay;
  const wz = cz - az;
  let nx = uy * wz - uz * wy;
  let ny = uz * wx - ux * wz;
  let nz = ux * wy - uy * wx;
  const length = Math.hypot(nx, ny, nz) || 1;
  nx /= length;
  ny /= length;
  nz /= length;
  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
}

/** Both shapes in one geometry (see the file comment). Load-time. */
export function createAerieGlowGeometry(): BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const parts: number[] = [];
  const seeds: number[] = [];
  const mark = (part: number, seed: number): void => {
    while (parts.length < positions.length / 3) {
      parts.push(part);
      seeds.push(seed);
    }
  };

  // --- Shards: four-sided double pyramids on an arc that is open at the back -------------------
  for (let i = 0; i < SHARDS.length; i++) {
    const shard = SHARDS[i];
    if (shard === undefined) continue;
    const angle = -SHARD_ARC + (2 * SHARD_ARC * i) / (SHARDS.length - 1);
    // Local +Z is the way the dragon faces: angle 0 is straight ahead.
    const cx = Math.sin(angle) * SHARD_RING_RADIUS;
    const cz = Math.cos(angle) * SHARD_RING_RADIUS;
    const cy = shard.y;
    const w = shard.halfWidth;
    const top = cy + shard.halfHeight;
    const bottom = cy - shard.halfHeight * 1.3;
    const waist = cy + shard.halfHeight * 0.2;
    // Waist corners, turned with the arc so no two shards show the same face.
    const corner: [number, number][] = [];
    for (let k = 0; k < 4; k++) {
      const a = angle + 0.5 + (k * Math.PI) / 2;
      corner.push([cx + Math.sin(a) * w, cz + Math.cos(a) * w]);
    }
    for (let k = 0; k < 4; k++) {
      const a = corner[k] as [number, number];
      const b = corner[(k + 1) % 4] as [number, number];
      pushTriangle(positions, normals, cx, top, cz, a[0], waist, a[1], b[0], waist, b[1]);
      pushTriangle(positions, normals, cx, bottom, cz, b[0], waist, b[1], a[0], waist, a[1]);
    }
    mark(0, i);
  }

  // --- Flame: a faceted teardrop round the brazier model's own flame ---------------------------
  for (let r = 0; r < FLAME_RINGS.length - 1; r++) {
    const lower = FLAME_RINGS[r] as readonly [number, number];
    const upper = FLAME_RINGS[r + 1] as readonly [number, number];
    for (let s = 0; s < FLAME_SIDES; s++) {
      // Each ring is turned a little against the one below: a flame, not a lathe.
      const a0 = ((s + r * 0.5) / FLAME_SIDES) * Math.PI * 2;
      const a1 = ((s + 1 + r * 0.5) / FLAME_SIDES) * Math.PI * 2;
      const b0 = ((s + (r + 1) * 0.5) / FLAME_SIDES) * Math.PI * 2;
      const b1 = ((s + 1 + (r + 1) * 0.5) / FLAME_SIDES) * Math.PI * 2;
      const l0x = Math.sin(a0) * lower[1];
      const l0z = Math.cos(a0) * lower[1];
      const l1x = Math.sin(a1) * lower[1];
      const l1z = Math.cos(a1) * lower[1];
      const u0x = Math.sin(b0) * upper[1];
      const u0z = Math.cos(b0) * upper[1];
      const u1x = Math.sin(b1) * upper[1];
      const u1z = Math.cos(b1) * upper[1];
      pushTriangle(positions, normals, l0x, lower[0], l0z, l1x, lower[0], l1z, u0x, upper[0], u0z);
      if (upper[1] > 0) {
        pushTriangle(positions, normals, l1x, lower[0], l1z, u1x, upper[0], u1z, u0x, upper[0], u0z);
      }
    }
  }
  mark(1, 0);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('aPart', new BufferAttribute(new Float32Array(parts), 1));
  geometry.setAttribute('aSeed', new BufferAttribute(new Float32Array(seeds), 1));
  return geometry;
}

export interface AerieGlow {
  readonly mesh: InstancedMesh<BufferGeometry, ShaderMaterial>;
  /** Triangles of one perch's shards and of one flame (the mesh submits both per instance). */
  readonly trianglesPerInstance: number;
  /** How bright a perch's shards are, 0..1. Cheap: nothing is uploaded unless a value moved. */
  setPerchGlow(slot: number, glow: number): void;
  /** Braziers above this detail level (aerie-set.ts) are not in the set: their fire goes too. */
  setDetail(level: number): void;
  /** Per frame: the clock of the bob and the flicker, and the upload of changed glows. */
  update(timeS: number): void;
  dispose(): void;
}

/** Load-time. `braziers` is every brazier the set can have, with the detail level it needs. */
export function createAerieGlow(
  layout: AerieLayout,
  braziers: readonly (AerieBrazier & { readonly detail: number })[],
): AerieGlow {
  const geometry = createAerieGlowGeometry();
  const count = AERIE_PERCH_COUNT + braziers.length;
  const tints = new Float32Array(count * 3);
  const states = new Float32Array(count * 4);
  const tintAttribute = new InstancedBufferAttribute(tints, 3);
  const stateAttribute = new InstancedBufferAttribute(states, 4);
  geometry.setAttribute('aTint', tintAttribute);
  geometry.setAttribute('aState', stateAttribute);

  const material = useWorldLight(
    new ShaderMaterial({
      name: 'aerie-glow',
      uniforms: {
        uTime: { value: 0 },
        uStone: { value: new Color().setHex(SHARD_STONE_HEX) },
        uGain: { value: 1.35 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      fog: false,
    }),
    // A light does not take a shadow.
    { shadows: false },
  );

  const mesh = new InstancedMesh(geometry, material, count);
  mesh.name = 'aerie-glow';
  mesh.matrixAutoUpdate = false;
  // The instances are spread over the whole aerie and there are sixteen of them: not worth a test.
  mesh.frustumCulled = false;

  const teamColors: Color[] = [];
  for (const hex of TEAM_GLOW_HEX) teamColors.push(new Color().setHex(hex));
  // Load-time scratch for the instance matrices.
  const matrix = new Matrix4();
  const scratchPosition = new Vector3();
  const scratchQuaternion = new Quaternion();
  const scratchScale = new Vector3();
  const UP = new Vector3(0, 1, 0);

  function writeInstance(
    index: number,
    position: Vec3,
    yaw: number,
    scale: number,
    team: TeamId,
    part: number,
  ): void {
    matrix.compose(
      scratchPosition.set(position.x, position.y, position.z),
      scratchQuaternion.setFromAxisAngle(UP, yaw),
      scratchScale.setScalar(scale),
    );
    mesh.setMatrixAt(index, matrix);
    const color = teamColors[team] ?? (teamColors[TEAM_EMBER] as Color);
    tints[index * 3] = color.r;
    tints[index * 3 + 1] = color.g;
    tints[index * 3 + 2] = color.b;
    states[index * 4] = 0;
    states[index * 4 + 1] = 0;
    states[index * 4 + 2] = part;
    // A golden-ratio spread: neighbours never bob or flicker in step.
    states[index * 4 + 3] = (index * 0.618034) % 1;
  }

  for (const perch of layout.perches) {
    writeInstance(perch.slot, perch.position, perch.yaw, 1, perch.side, 0);
  }
  for (let i = 0; i < braziers.length; i++) {
    const brazier = braziers[i];
    if (brazier === undefined) continue;
    writeInstance(AERIE_PERCH_COUNT + i, brazier.position, 0, brazier.scale, brazier.team, 1);
  }
  mesh.instanceMatrix.needsUpdate = true;

  let dirty = true;
  let detail = 2;

  function applyDetail(): void {
    for (let i = 0; i < braziers.length; i++) {
      const brazier = braziers[i];
      if (brazier === undefined) continue;
      // Part 2 matches neither shape: the whole instance collapses.
      states[(AERIE_PERCH_COUNT + i) * 4 + 2] = brazier.detail <= detail ? 1 : 2;
    }
    dirty = true;
  }
  applyDetail();

  return {
    mesh,
    trianglesPerInstance: geometry.getAttribute('position').count / 3,
    setPerchGlow(slot: number, glow: number): void {
      if (slot < 0 || slot >= AERIE_PERCH_COUNT) return;
      const o = slot * 4;
      // Steps of 1/255: an ease that has all but settled stops re-uploading the buffer.
      const quantised = Math.round(glow * 255) / 255;
      if (states[o] === quantised) return;
      states[o] = quantised;
      dirty = true;
    },
    setDetail(level: number): void {
      if (level === detail) return;
      detail = level;
      applyDetail();
    },
    update(timeS: number): void {
      (material.uniforms['uTime'] as { value: number }).value = timeS;
      if (dirty) {
        stateAttribute.needsUpdate = true;
        dirty = false;
      }
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
