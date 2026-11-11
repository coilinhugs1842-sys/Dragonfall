/**
 * The sprite batch: every particle (and every per-frame sprite such as a bolt) is one instance
 * of a camera-facing quad, drawn in ONE call per layer with one shared program.
 *
 * Everything that happens to a particle after it spawns happens in the vertex shader, from
 * `uTime - birth`:
 *   - motion: velocity under linear drag, gravity (negative = buoyancy), a sine wobble
 *   - size from start to end, a fade in and out, colour from start to end
 *   - a dead or unborn instance leaves the clip volume, so it costs no fragments
 *
 * Overdraw guards (the top risk on an integrated GPU):
 *   - on-screen size cap: a sprite is shrunk so it never covers more than `uMaxScreen` of the
 *     screen's half-height
 *   - near fade: a sprite fades out as the camera gets within about its own size, and is gone
 *     before the camera is inside it
 *
 * Blending is premultiplied "over" with a per-particle `additive` factor: colour is always
 * added times alpha, and the background is dimmed by alpha * (1 - additive). So glowing sprites
 * (additive 1) and smoke (additive 0) share one draw call, and the additive ones need no sort.
 * Smoke is unsorted too; recipes keep it sparse and soft so the order does not read.
 *
 * Colours are linear and go through three's tone-mapping and colour-space chunks like the lit
 * scene does, BEFORE the alpha multiply. Fog fades additive sprites out and tints smoke toward
 * the fog colour.
 */

import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
  Vector2,
} from 'three';
import type { Texture } from 'three';
import { ATLAS_COLUMNS, ATLAS_ROWS } from './atlas';
import { PARTICLE_STRIDE } from './particle-pool';

/** Shared by every effect material: one write per frame moves everything. */
export interface VfxUniforms {
  readonly uTime: { value: number };
  readonly uMaxScreen: { value: number };
  /** Metres: sprites are invisible nearer than x (+ their size), full from y (+ twice it). */
  readonly uNearFade: { value: Vector2 };
}

export function createVfxUniforms(): VfxUniforms {
  return {
    uTime: { value: 0 },
    uMaxScreen: { value: 0.4 },
    uNearFade: { value: new Vector2(1.5, 5) },
  };
}

/** GLSL: exp2 or linear fog factor from a view depth, 0 without scene fog. */
export const FOG_FACTOR_GLSL = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		uniform float fogDensity;
	#else
		uniform float fogNear;
		uniform float fogFar;
	#endif
#endif
float dfFogFactor( float depth ) {
	#ifdef USE_FOG
		#ifdef FOG_EXP2
			return 1.0 - exp( - fogDensity * fogDensity * depth * depth );
		#else
			return smoothstep( fogNear, fogFar, depth );
		#endif
	#else
		return 0.0;
	#endif
}
`;

const VERTEX_SHADER = /* glsl */ `
attribute vec4 aPosBirth; // spawn position, birth time
attribute vec4 aVelLife;  // velocity, life
attribute vec4 aSize;     // start, end, rotation, spin
attribute vec4 aPhys;     // drag, gravity, turbulence, stretch
attribute vec4 aColorA;   // start colour (linear), blend: opacity % + additive fraction
attribute vec4 aColorB;   // end colour, sprite + seed
attribute vec4 aFade;     // fade in, fade out, anchor, aspect
uniform float uTime;
uniform float uMaxScreen;
uniform vec2 uNearFade;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vBlend;      // additive, fog
${FOG_FACTOR_GLSL}

void main() {
	float life = aVelLife.w;
	float age = uTime - aPosBirth.w;
	float u = age / max( life, 0.0001 );
	gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	vUv = vec2( 0.0 );
	vColor = vec4( 0.0 );
	vBlend = vec2( 0.0 );
	if ( life > 0.0 && age >= 0.0 && u < 1.0 ) {
		// Closed-form motion: dv/dt = -k v - g.
		float k = max( aPhys.x, 0.01 );
		float e = exp( - k * age );
		float s = ( 1.0 - e ) / k;
		vec3 vel = aVelLife.xyz * e;
		vel.y -= aPhys.y * s;
		vec3 p = aPosBirth.xyz + aVelLife.xyz * s;
		p.y -= aPhys.y * ( age - s ) / k;
		float seed = fract( aColorB.w );
		float phase = seed * 6.2831853;
		p += vec3( sin( age * 3.1 + phase * 7.0 ), sin( age * 2.3 + phase * 13.0 ), cos( age * 2.7 + phase * 5.0 ) )
			* ( aPhys.z * min( age * 2.0, 1.0 ) );

		float grow = 1.0 - ( 1.0 - u ) * ( 1.0 - u );
		float size = mix( aSize.x, aSize.y, grow );
		float fade = ( aFade.x > 0.0 ? min( u / aFade.x, 1.0 ) : 1.0 ) * ( 1.0 - smoothstep( aFade.y, 1.0, u ) )
			* ( floor( aColorA.w ) * 0.01 );

		vec4 mv = viewMatrix * vec4( p, 1.0 );
		float dist = max( - mv.z, 0.001 );
		fade *= smoothstep( uNearFade.x + size, uNearFade.y + size * 2.0, dist );
		float cap = min( 1.0, uMaxScreen * dist / ( max( size, 0.0001 ) * projectionMatrix[1][1] ) );

		vec2 corner = position.xy;
		vec2 offset;
		if ( aPhys.w > 0.0 ) {
			// Lined up with the velocity as seen on screen; longer the faster it moves across.
			vec2 vv = ( viewMatrix * vec4( vel, 0.0 ) ).xy;
			float planar = length( vv );
			vec2 axis = planar > 0.0001 ? vv / planar : vec2( 1.0, 0.0 );
			float halfLength = size * ( 1.0 + aPhys.w * planar );
			offset = axis * ( ( corner.x - aFade.z ) * halfLength )
				+ vec2( - axis.y, axis.x ) * ( corner.y * size * aFade.w );
		} else {
			float angle = aSize.z + aSize.w * age;
			float c = cos( angle );
			float sn = sin( angle );
			vec2 q = vec2( corner.x * aFade.w, corner.y ) * size;
			offset = vec2( c * q.x - sn * q.y, sn * q.x + c * q.y );
		}
		mv.xy += offset * cap;

		if ( fade > 0.003 ) {
			gl_Position = projectionMatrix * mv;
			float sprite = floor( aColorB.w );
			vec2 cell = vec2( mod( sprite, ${ATLAS_COLUMNS.toFixed(1)} ), floor( sprite / ${ATLAS_COLUMNS.toFixed(1)} ) );
			vUv = ( cell + corner * 0.5 + 0.5 ) / vec2( ${ATLAS_COLUMNS.toFixed(1)}, ${ATLAS_ROWS.toFixed(1)} );
			vColor = vec4( mix( aColorA.rgb, aColorB.rgb, u ), fade );
			vBlend = vec2( fract( aColorA.w ) / 0.99, dfFogFactor( dist ) );
		}
	}
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uAtlas; // r: shape, g: hot core
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vBlend;
#ifdef USE_FOG
	uniform vec3 fogColor;
#endif

void main() {
	vec2 texel = texture2D( uAtlas, vUv ).rg;
	float alpha = texel.r * vColor.a;
	// The core pushes bright sprites toward white-hot; dark ones (smoke) only get denser.
	float heat = min( max( vColor.r, max( vColor.g, vColor.b ) ), 1.0 );
	vec3 colour = vColor.rgb * ( 1.0 + texel.g * 0.6 ) + vec3( 1.0, 0.94, 0.84 ) * ( texel.g * texel.g * heat * 0.4 );
	gl_FragColor = vec4( colour, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	#ifdef USE_FOG
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, vBlend.y * ( 1.0 - vBlend.x ) );
		alpha *= 1.0 - vBlend.y * vBlend.x;
	#endif
	gl_FragColor = vec4( gl_FragColor.rgb * alpha, alpha * ( 1.0 - vBlend.x ) );
}
`;

/** Uniform slots three fills from `scene.fog` when `material.fog` is true. */
export function createFogUniforms(): Record<string, { value: unknown }> {
  return {
    fogColor: { value: new Color(0xffffff) },
    fogDensity: { value: 0 },
    fogNear: { value: 1 },
    fogFar: { value: 2000 },
  };
}

export function createSpriteMaterial(atlas: Texture, shared: VfxUniforms): ShaderMaterial {
  return new ShaderMaterial({
    name: 'VfxSprites',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      uAtlas: { value: atlas },
      uTime: shared.uTime,
      uMaxScreen: shared.uMaxScreen,
      uNearFade: shared.uNearFade,
      ...createFogUniforms(),
    },
    transparent: true,
    premultipliedAlpha: true,
    depthTest: true,
    depthWrite: false,
    fog: true,
  });
}

interface UpdateRange {
  start: number;
  count: number;
}

/**
 * One draw call of sprites over a caller-owned Float32Array (PARTICLE_STRIDE floats each).
 * `upload*` tells three which part changed; nothing here allocates per frame.
 */
export class SpriteLayer {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geometry: InstancedBufferGeometry;
  private readonly buffer: InstancedInterleavedBuffer;
  /** A marked change has not reached the GPU yet. */
  private awaitingUpload = false;
  private readonly ranges: [UpdateRange, UpdateRange] = [
    { start: 0, count: 0 },
    { start: 0, count: 0 },
  ];

  constructor(data: Float32Array, material: ShaderMaterial, name: string, renderOrder: number) {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
    );
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    const buffer = new InstancedInterleavedBuffer(data, PARTICLE_STRIDE, 1);
    buffer.setUsage(DynamicDrawUsage);
    buffer.onUpload(() => {
      this.awaitingUpload = false;
    });
    const names = ['aPosBirth', 'aVelLife', 'aSize', 'aPhys', 'aColorA', 'aColorB', 'aFade'];
    for (let i = 0; i < names.length; i++) {
      geometry.setAttribute(names[i] ?? '', new InterleavedBufferAttribute(buffer, 4, i * 4));
    }
    geometry.instanceCount = data.length / PARTICLE_STRIDE;
    this.geometry = geometry;
    this.buffer = buffer;
    this.mesh = new Mesh(geometry, material);
    this.mesh.name = name;
    // Particles go anywhere; the GPU clips single sprites.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
  }

  /** Instances drawn (from slot 0). */
  setInstanceCount(count: number): void {
    this.geometry.instanceCount = count;
  }

  /**
   * Marks up to two runs of slots as changed. If an earlier mark was never uploaded (the mesh
   * was hidden or the frame was not drawn), the whole buffer goes up instead, so nothing is
   * lost.
   */
  upload(start0: number, count0: number, start1: number, count1: number): void {
    if (count0 <= 0 && count1 <= 0) return;
    const pending = this.buffer.updateRanges;
    // Three leaves the ranges in place after the first, whole-buffer upload.
    pending.length = 0;
    this.buffer.needsUpdate = true;
    // No ranges = three uploads everything.
    if (this.awaitingUpload) return;
    this.awaitingUpload = true;
    const a = this.ranges[0];
    a.start = start0 * PARTICLE_STRIDE;
    a.count = count0 * PARTICLE_STRIDE;
    pending.push(a);
    if (count1 > 0) {
      const b = this.ranges[1];
      b.start = start1 * PARTICLE_STRIDE;
      b.count = count1 * PARTICLE_STRIDE;
      pending.push(b);
    }
  }

  /** Everything changed (pool cleared, capacity changed). */
  uploadAll(): void {
    this.buffer.updateRanges.length = 0;
    this.buffer.needsUpdate = true;
    this.awaitingUpload = true;
  }

  dispose(): void {
    this.geometry.dispose();
  }
}
