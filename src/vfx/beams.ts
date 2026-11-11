/**
 * Beams and lightning: a pool of camera-facing strips, all in ONE draw call.
 *
 * A beam is written once (start, end, width, colour, seed); the vertex shader builds the strip,
 * turns it to face the camera, and for lightning bends it into a jagged path that is re-seeded
 * many times a second on the GPU. Forks are just more, shorter beams that leave the spine at an
 * angle and taper to a point. The fragment shader is a bright core in a soft glow with a flicker
 * running along it. Additive, unsorted, short-lived.
 *
 * A beam never gets thinner on screen than `MIN_SCREEN_HALF_WIDTH`, so a 400 m lance still reads
 * at a 0.6 render scale.
 */

import {
  BufferAttribute,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
} from 'three';
import type { PlayerId, TeamId } from '../shared';
import { NO_PLAYER } from '../shared';
import { COLOR_GLOW, COLOR_TEAM, PALETTE, paletteOffset } from './palette';
import { nextFloat, nextRange } from './rng';
import type { Rng } from './rng';
import { FOG_FACTOR_GLSL, createFogUniforms } from './sprite-layer';
import type { VfxUniforms } from './sprite-layer';

/** Beams alive at once, forks included. The oldest is replaced. */
export const BEAM_CAPACITY = 32;
export const BEAM_STRIDE = 16;
const BEAM_SEGMENTS = 14;
/** Half-width floor as a fraction of the screen's half-height. */
const MIN_SCREEN_HALF_WIDTH = 0.006;
/** Lightning takes a new shape this many times a second. */
const FLICKER_HZ = 22;

const B_START = 0;
const B_BIRTH = 3;
const B_END = 4;
const B_LIFE = 7;
const B_WIDTH = 8;
const B_JAG = 9;
const B_SEED = 10;
const B_TAPER = 11;
const B_COLOR = 12;
const B_INTENSITY = 15;

/** How a beam looks. Data, like the particle recipes. */
export interface BeamStyle {
  /** Half-width of the glow in metres. */
  readonly width: number;
  /** Sideways wander of a lightning path in metres; 0 = a straight beam. */
  readonly jag: number;
  readonly lifeS: number;
  readonly intensity: number;
  /** Forks leaving the spine. */
  readonly forks: number;
  /** Fork length in metres. */
  readonly forkLengthMin: number;
  readonly forkLengthMax: number;
  /** Forks leave the spine within this many metres of its start. */
  readonly forkReach: number;
}

const VERTEX_SHADER = /* glsl */ `
attribute vec4 aStart; // xyz, birth
attribute vec4 aEnd;   // xyz, life
attribute vec4 aShape; // half-width, jag, seed, taper
attribute vec4 aTint;  // rgb, intensity
uniform float uTime;
varying vec3 vCoord;   // metres along, side -1..1, seed
varying vec4 vColor;
${FOG_FACTOR_GLSL}

vec2 dfHash2( vec2 p ) {
	vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
	q += dot( q, q.yzx + 33.33 );
	return fract( ( q.xx + q.yz ) * q.zy );
}

void main() {
	float life = aEnd.w;
	float age = uTime - aStart.w;
	float t = age / max( life, 0.0001 );
	gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	vCoord = vec3( 0.0 );
	vColor = vec4( 0.0 );
	if ( life > 0.0 && age >= 0.0 && t < 1.0 ) {
		float u = position.x;
		vec3 axis = aEnd.xyz - aStart.xyz;
		float len = max( length( axis ), 0.001 );
		vec3 dir = axis / len;
		vec3 p = aStart.xyz + axis * u;

		// Lightning: each joint is pushed sideways by a hash of (joint, seed, time step). Both
		// ends stay put, so the bolt still leaves the muzzle and lands on the target.
		vec3 n1 = normalize( cross( dir, abs( dir.y ) < 0.9 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 ) ) );
		vec3 n2 = cross( dir, n1 );
		float joint = floor( u * ${BEAM_SEGMENTS.toFixed(1)} + 0.5 );
		float step = floor( uTime * ${FLICKER_HZ.toFixed(1)} );
		vec2 jitter = dfHash2( vec2( joint * 7.13 + aShape.z * 91.7, step * 3.31 + aShape.z * 17.0 ) ) - 0.5;
		float pinned = mix( sin( u * 3.14159265 ), u * ( 1.0 - u * u ) * 2.6, aShape.w );
		p += ( n1 * jitter.x + n2 * jitter.y ) * ( 2.0 * aShape.y * pinned );

		vec3 toCamera = cameraPosition - p;
		float dist = max( length( toCamera ), 0.001 );
		vec3 side = cross( dir, toCamera / dist );
		float sideLength = length( side );
		side = sideLength > 0.0001 ? side / sideLength : n1;
		// A flash that is widest at birth; forks thin to a point.
		float width = aShape.x * ( 1.0 - 0.55 * t ) * mix( 1.0, 1.0 - u, aShape.w );
		width = max( width, ${MIN_SCREEN_HALF_WIDTH.toFixed(4)} * dist / projectionMatrix[1][1] * mix( 1.0, 1.0 - u, aShape.w ) );
		p += side * ( position.y * width );

		vec4 mv = viewMatrix * vec4( p, 1.0 );
		gl_Position = projectionMatrix * mv;
		float fade = ( 1.0 - t * t ) * ( 1.0 - dfFogFactor( - mv.z ) );
		vCoord = vec3( u * len, position.y, aShape.z * 37.0 );
		vColor = vec4( aTint.rgb * aTint.w, fade );
	}
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
varying vec3 vCoord;
varying vec4 vColor;

void main() {
	float d = abs( vCoord.y );
	float core = smoothstep( 0.2, 0.04, d );
	float glow = pow( 1.0 - d, 1.5 );
	// A flicker running along the beam: two sines beating, cheaper than a noise lookup.
	float flow = 0.72 + 0.28 * sin( vCoord.x * 0.83 - uTime * 61.0 + vCoord.z ) * sin( vCoord.x * 0.19 + uTime * 23.0 );
	vec3 colour = vColor.rgb * ( 0.6 + 0.4 * flow ) + mix( vColor.rgb, vec3( 1.0, 0.97, 0.92 ), 0.7 ) * core;
	gl_FragColor = vec4( colour, 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	float alpha = vColor.a * min( 1.0, core + glow * 0.75 );
	// Mostly "over": the glow keeps its team colour against a bright sky.
	gl_FragColor = vec4( gl_FragColor.rgb * alpha, alpha * 0.8 );
}
`;

export class BeamBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly data = new Float32Array(BEAM_CAPACITY * BEAM_STRIDE);
  private readonly owner = new Uint8Array(BEAM_CAPACITY).fill(NO_PLAYER);
  /** Metres from the owner's spine start at which a fork leaves it; -1 for a spine. */
  private readonly forkAt = new Float32Array(BEAM_CAPACITY).fill(-1);
  private readonly death = new Float32Array(BEAM_CAPACITY).fill(-Infinity);
  private cursor = 0;
  private dirty = false;
  private aliveCount = 0;

  constructor(shared: VfxUniforms, renderOrder: number) {
    const geometry = new InstancedBufferGeometry();
    const vertices = new Float32Array((BEAM_SEGMENTS + 1) * 2 * 3);
    const indices: number[] = [];
    for (let i = 0; i <= BEAM_SEGMENTS; i++) {
      const u = i / BEAM_SEGMENTS;
      vertices[i * 6] = u;
      vertices[i * 6 + 1] = -1;
      vertices[i * 6 + 3] = u;
      vertices[i * 6 + 4] = 1;
      if (i < BEAM_SEGMENTS) {
        const a = i * 2;
        indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    geometry.setAttribute('position', new BufferAttribute(vertices, 3));
    geometry.setIndex(indices);
    const buffer = new InstancedInterleavedBuffer(this.data, BEAM_STRIDE, 1);
    buffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aStart', new InterleavedBufferAttribute(buffer, 4, 0));
    geometry.setAttribute('aEnd', new InterleavedBufferAttribute(buffer, 4, 4));
    geometry.setAttribute('aShape', new InterleavedBufferAttribute(buffer, 4, 8));
    geometry.setAttribute('aTint', new InterleavedBufferAttribute(buffer, 4, 12));
    geometry.instanceCount = BEAM_CAPACITY;
    this.geometry = geometry;
    this.buffer = buffer;
    this.material = new ShaderMaterial({
      name: 'VfxBeams',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uTime: shared.uTime, ...createFogUniforms() },
      transparent: true,
      premultipliedAlpha: true,
      depthTest: true,
      depthWrite: false,
      fog: true,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'VfxBeams';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  /** Beams (forks included) alive as of the last `update`. */
  get alive(): number {
    return this.aliveCount;
  }

  private write(
    time: number,
    ownerId: PlayerId,
    forkAt: number,
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
    width: number,
    jag: number,
    life: number,
    seed: number,
    taper: number,
    team: TeamId,
    role: number,
    intensity: number,
  ): void {
    const index = this.cursor;
    this.cursor = (index + 1) % BEAM_CAPACITY;
    const data = this.data;
    const o = index * BEAM_STRIDE;
    const c = paletteOffset(team, role);
    data[o + B_START] = sx;
    data[o + B_START + 1] = sy;
    data[o + B_START + 2] = sz;
    data[o + B_BIRTH] = time;
    data[o + B_END] = ex;
    data[o + B_END + 1] = ey;
    data[o + B_END + 2] = ez;
    data[o + B_LIFE] = life;
    data[o + B_WIDTH] = width;
    data[o + B_JAG] = jag;
    data[o + B_SEED] = seed;
    data[o + B_TAPER] = taper;
    data[o + B_COLOR] = PALETTE[c] ?? 0;
    data[o + B_COLOR + 1] = PALETTE[c + 1] ?? 0;
    data[o + B_COLOR + 2] = PALETTE[c + 2] ?? 0;
    data[o + B_INTENSITY] = intensity;
    this.owner[index] = ownerId;
    this.forkAt[index] = forkAt;
    this.death[index] = time + life;
    this.dirty = true;
  }

  /**
   * A beam from start to end, with the style's forks. `ownerId` lets `shorten` find it again
   * (NO_PLAYER = nobody will).
   */
  spawn(
    style: BeamStyle,
    time: number,
    rng: Rng,
    ownerId: PlayerId,
    team: TeamId,
    sx: number,
    sy: number,
    sz: number,
    ex: number,
    ey: number,
    ez: number,
  ): void {
    this.write(
      time,
      ownerId,
      -1,
      sx,
      sy,
      sz,
      ex,
      ey,
      ez,
      style.width,
      style.jag,
      style.lifeS,
      nextFloat(rng),
      0,
      team,
      COLOR_TEAM,
      style.intensity,
    );
    let dx = ex - sx;
    let dy = ey - sy;
    let dz = ez - sz;
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(length > 1) || style.forks <= 0) return;
    dx /= length;
    dy /= length;
    dz /= length;
    // Two axes square to the beam.
    let ax = -dz;
    let ay = 0;
    let az = dx;
    if (Math.abs(dy) >= 0.9) {
      ax = 0;
      ay = dz;
      az = -dy;
    }
    const aLength = Math.sqrt(ax * ax + ay * ay + az * az);
    ax /= aLength;
    ay /= aLength;
    az /= aLength;
    const bx = dy * az - dz * ay;
    const by = dz * ax - dx * az;
    const bz = dx * ay - dy * ax;
    const reach = Math.min(style.forkReach, length * 0.8);
    for (let i = 0; i < style.forks; i++) {
      const at = reach * (0.12 + (0.88 * (i + nextFloat(rng))) / style.forks);
      const angle = nextFloat(rng) * Math.PI * 2;
      const lean = nextRange(rng, 0.35, 0.75);
      const cos = Math.cos(angle) * lean;
      const sin = Math.sin(angle) * lean;
      const forkLength = nextRange(rng, style.forkLengthMin, style.forkLengthMax);
      const fx = sx + dx * at;
      const fy = sy + dy * at;
      const fz = sz + dz * at;
      this.write(
        time,
        ownerId,
        at,
        fx,
        fy,
        fz,
        fx + (dx + ax * cos + bx * sin) * forkLength,
        fy + (dy + ay * cos + by * sin) * forkLength,
        fz + (dz + az * cos + bz * sin) * forkLength,
        style.width * 0.6,
        style.jag * 0.6,
        style.lifeS * 0.85,
        nextFloat(rng),
        1,
        team,
        COLOR_GLOW,
        style.intensity * 0.8,
      );
    }
  }

  /**
   * The owner's newest beam ends at this point instead (the host said what it hit). Forks that
   * left the spine beyond the new end are dropped. Only beams younger than `maxAgeS` count.
   */
  shorten(ownerId: PlayerId, time: number, maxAgeS: number, x: number, y: number, z: number): void {
    const data = this.data;
    let spine = -1;
    let newest = -Infinity;
    for (let i = 0; i < BEAM_CAPACITY; i++) {
      if (this.owner[i] !== ownerId || (this.forkAt[i] ?? 0) >= 0) continue;
      const birth = data[i * BEAM_STRIDE + B_BIRTH] ?? 0;
      if (time - birth > maxAgeS || !((this.death[i] ?? 0) > time)) continue;
      if (birth > newest) {
        newest = birth;
        spine = i;
      }
    }
    if (spine < 0) return;
    const o = spine * BEAM_STRIDE;
    const dx = x - (data[o + B_START] ?? 0);
    const dy = y - (data[o + B_START + 1] ?? 0);
    const dz = z - (data[o + B_START + 2] ?? 0);
    const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
    data[o + B_END] = x;
    data[o + B_END + 1] = y;
    data[o + B_END + 2] = z;
    for (let i = 0; i < BEAM_CAPACITY; i++) {
      if (this.owner[i] !== ownerId || !((this.forkAt[i] ?? -1) > length * 0.9)) continue;
      if ((data[i * BEAM_STRIDE + B_BIRTH] ?? 0) !== newest) continue;
      data[i * BEAM_STRIDE + B_LIFE] = 0;
      this.death[i] = -Infinity;
    }
    this.dirty = true;
  }

  clear(): void {
    for (let i = 0; i < BEAM_CAPACITY; i++) {
      this.data[i * BEAM_STRIDE + B_LIFE] = 0;
      this.death[i] = -Infinity;
      this.owner[i] = NO_PLAYER;
    }
    this.dirty = true;
  }

  /** Once per frame: uploads what changed and hides the mesh when no beam is alive. */
  update(time: number): void {
    let alive = 0;
    for (let i = 0; i < BEAM_CAPACITY; i++) {
      if ((this.death[i] ?? 0) > time) alive++;
    }
    this.aliveCount = alive;
    this.mesh.visible = alive > 0;
    if (this.dirty && alive > 0) {
      // 2 KB: not worth tracking ranges.
      this.buffer.updateRanges.length = 0;
      this.buffer.needsUpdate = true;
      this.dirty = false;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
