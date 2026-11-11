/**
 * The storm wall as the riders see it: the arena edge (docs/GAME_DESIGN.md, "Flight"), a
 * vertical cylinder whose radius a Duel shrinks. Read from the WorldView's `stormWall` zone, so
 * the host and the clients draw the same wall from the same number.
 *
 * COST: one draw call, 128 triangles, one unlit transparent material with depth writes off. A
 * wall that filled the screen from across the map would be a full-screen transparent layer on
 * an integrated GPU, so it fades in only as the camera comes near: beyond the preset's range
 * the fragment shader's result is zero and the mesh is not drawn at all when the camera is
 * further than that from the wall. Low draws it over the shortest range, High over the longest.
 *
 * Hazards are magenta (docs/ART_DIRECTION.md, "Palette by role").
 */

import {
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
} from 'three';
import type { QualityPreset, WorldView } from '../../shared';

const HAZARD_COLOR = 0xff3fa4;
const SEGMENTS = 64;
/** Metres from the wall at which it is fully faded out, per preset. */
const FADE_RANGE_M: Readonly<Record<QualityPreset['id'], number>> = {
  low: 260,
  medium: 380,
  high: 520,
};
/** Opacity right at the wall. */
const PEAK_OPACITY = 0.42;

export interface StormWallViewOptions {
  /** Bottom and top of the wall in world Y. */
  readonly floorY: number;
  readonly ceilingY: number;
}

export interface StormWallView {
  readonly object: Mesh;
  /** Per frame, after the WorldView is built and the camera is placed. Allocation-free. */
  update(view: WorldView, cameraPosition: Vector3, timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

const VERTEX = /* glsl */ `
varying vec3 vWorld;
varying vec2 vUv;
void main() {
	vec4 world = modelMatrix * vec4( position, 1.0 );
	vWorld = world.xyz;
	vUv = uv;
	gl_Position = projectionMatrix * viewMatrix * world;
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uRange;
uniform float uOpacity;
uniform float uCircumference;
varying vec3 vWorld;
varying vec2 vUv;
void main() {
	float near = 1.0 - clamp( distance( cameraPosition, vWorld ) / uRange, 0.0, 1.0 );
	if ( near <= 0.0 ) discard;
	// Slanted bands that drift upward: reads as a moving curtain, not a painted wall.
	float along = vUv.x * uCircumference;
	float band = 0.5 + 0.5 * sin( ( vWorld.y * 0.045 + along * 0.02 ) - uTime * 1.3 );
	float streak = 0.5 + 0.5 * sin( along * 0.11 + uTime * 0.4 );
	float alpha = uOpacity * near * near * ( 0.35 + 0.45 * band + 0.2 * streak * band );
	gl_FragColor = vec4( uColor * ( 0.85 + 0.6 * band ), alpha );
	#include <colorspace_fragment>
}
`;

export function createStormWallView(
  preset: QualityPreset,
  options: StormWallViewOptions,
): StormWallView {
  const height = Math.max(1, options.ceilingY - options.floorY);
  const geometry = new CylinderGeometry(1, 1, 1, SEGMENTS, 1, true);
  const uniforms = {
    uColor: { value: new Color(HAZARD_COLOR) },
    uTime: { value: 0 },
    uRange: { value: FADE_RANGE_M[preset.id] },
    uOpacity: { value: PEAK_OPACITY },
    uCircumference: { value: 1 },
  };
  const material = new ShaderMaterial({
    name: 'storm-wall',
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: NormalBlending,
    fog: false,
  });
  const mesh = new Mesh(geometry, material);
  mesh.name = 'storm-wall';
  mesh.frustumCulled = false;
  mesh.visible = false;
  mesh.matrixAutoUpdate = false;
  // After the opaque world and the clouds, before the effect sprites.
  mesh.renderOrder = 5;
  mesh.position.y = options.floorY + height / 2;

  let range = FADE_RANGE_M[preset.id];
  let lastRadius = -1;
  let lastX = Number.NaN;
  let lastZ = Number.NaN;

  return {
    object: mesh,

    update(view: WorldView, cameraPosition: Vector3, timeS: number): void {
      let radius = -1;
      let x = 0;
      let z = 0;
      for (let i = 0; i < view.zoneCount; i++) {
        const zone = view.zones[i];
        if (zone !== undefined && zone.kind === 'stormWall') {
          radius = zone.radius;
          x = zone.position.x;
          z = zone.position.z;
          break;
        }
      }
      if (!(radius > 0)) {
        mesh.visible = false;
        return;
      }
      const dx = cameraPosition.x - x;
      const dz = cameraPosition.z - z;
      const fromWall = Math.abs(Math.sqrt(dx * dx + dz * dz) - radius);
      // Out of range: every fragment would be discarded, so do not submit the mesh at all.
      mesh.visible = fromWall < range;
      if (!mesh.visible) return;
      if (radius !== lastRadius || x !== lastX || z !== lastZ) {
        lastRadius = radius;
        lastX = x;
        lastZ = z;
        mesh.position.x = x;
        mesh.position.z = z;
        mesh.scale.set(radius, height, radius);
        mesh.updateMatrix();
        uniforms.uCircumference.value = Math.PI * 2 * radius;
      }
      uniforms.uTime.value = timeS;
    },

    setQuality(next: QualityPreset): void {
      range = FADE_RANGE_M[next.id];
      uniforms.uRange.value = range;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
