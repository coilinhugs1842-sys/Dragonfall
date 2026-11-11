/**
 * Volume hints: zones (static field, thunderhead, rally aura), the Bastion's wing shield and the
 * spawn-protection bubble. All of them are instances of one low-poly sphere in ONE draw call,
 * rewritten every frame from the WorldView (there are never more than a few dozen).
 *
 * The look is a fresnel rim: bright where the surface turns away from the eye, nearly empty
 * where it faces it, with slow bands drifting over it. A shield is the same sphere cut to a
 * cap in front of the dragon.
 *
 * Overdraw guards:
 *   - a shell the camera is inside (or about to enter) fades out and leaves the clip volume, so
 *     standing in a zone is never a full-screen transparent layer; the zone's interior
 *     particles carry the feedback there
 *   - back faces are thrown away except for the shield cap (its rider looks at it from behind)
 */

import {
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferGeometry,
  InstancedInterleavedBuffer,
  InterleavedBufferAttribute,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
} from 'three';
import type { Quat, TeamId } from '../shared';
import { PALETTE, paletteOffset } from './palette';
import type { ColorRole } from './palette';
import { FOG_FACTOR_GLSL, createFogUniforms } from './sprite-layer';
import type { VfxUniforms } from './sprite-layer';

export const SHELL_CAPACITY = 48;
export const SHELL_STRIDE = 16;

const VERTEX_SHADER = /* glsl */ `
attribute vec4 aCentre; // xyz, radius
attribute vec4 aTurn;   // orientation quaternion
attribute vec4 aTint;   // rgb, intensity
attribute vec4 aShell;  // cut (local z below it is hidden), rim power, fill, two-sided
uniform float uTime;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
varying vec4 vColor;
varying vec3 vShell;
${FOG_FACTOR_GLSL}

vec3 dfRotate( vec3 v, vec4 q ) {
	return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v );
}

void main() {
	float radius = aCentre.w;
	float toCentre = distance( cameraPosition, aCentre.xyz );
	// A capped shell (the shield) is small and its rider sits right behind it: always drawn.
	float outside = aShell.w > 0.5 ? 1.0 : smoothstep( radius * 1.04, radius * 1.35, toCentre );
	gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
	vNormal = vec3( 0.0 );
	vView = vec3( 0.0 );
	vLocal = position;
	vColor = vec4( 0.0 );
	vShell = aShell.xyz;
	if ( radius > 0.0 && outside > 0.004 ) {
		vec3 normal = dfRotate( position, aTurn );
		vec3 world = aCentre.xyz + normal * radius;
		vec4 mv = viewMatrix * vec4( world, 1.0 );
		gl_Position = projectionMatrix * mv;
		vNormal = normal;
		vView = cameraPosition - world;
		vColor = vec4( aTint.rgb, aTint.w * outside * ( 1.0 - dfFogFactor( - mv.z ) ) );
		vShell = vec3( aShell.xyz );
		// Smuggle the two-sided flag in the sign of the fill.
		vShell.z = aShell.w > 0.5 ? aShell.z + 2.0 : aShell.z;
	}
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform float uTime;
varying vec3 vNormal;
varying vec3 vView;
varying vec3 vLocal;
varying vec4 vColor;
varying vec3 vShell;

void main() {
	bool twoSided = vShell.z > 1.0;
	if ( ! gl_FrontFacing && ! twoSided ) discard;
	float fill = twoSided ? vShell.z - 2.0 : vShell.z;
	float facing = abs( dot( normalize( vNormal ), normalize( vView ) ) );
	float rim = pow( 1.0 - facing, vShell.y );
	// The cap: a bright lip where the sphere is cut.
	float cut = smoothstep( vShell.x, vShell.x + 0.06, vLocal.z );
	float lip = vShell.x > -0.99 ? 1.0 - smoothstep( vShell.x + 0.04, vShell.x + 0.3, vLocal.z ) : 0.0;
	float bands = 0.8 + 0.2 * sin( vLocal.y * 9.0 + uTime * 1.7 + vLocal.x * 4.0 );
	float glow = ( rim + fill + lip * 0.6 ) * bands * cut;
	float alpha = clamp( glow, 0.0, 1.0 ) * vColor.a;
	gl_FragColor = vec4( vColor.rgb * ( 0.8 + 0.5 * rim ), 1.0 );
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// Mostly "over": the rim keeps its colour against a bright sky.
	gl_FragColor = vec4( gl_FragColor.rgb * alpha, alpha * 0.6 );
}
`;

export class ShellBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;
  private readonly geometry: InstancedBufferGeometry;
  private readonly material: ShaderMaterial;
  private readonly buffer: InstancedInterleavedBuffer;
  private readonly data = new Float32Array(SHELL_CAPACITY * SHELL_STRIDE);
  private used = 0;

  constructor(shared: VfxUniforms, renderOrder: number) {
    const sphere = new SphereGeometry(1, 40, 22);
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', sphere.getAttribute('position'));
    geometry.setIndex(sphere.getIndex());
    const buffer = new InstancedInterleavedBuffer(this.data, SHELL_STRIDE, 1);
    buffer.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aCentre', new InterleavedBufferAttribute(buffer, 4, 0));
    geometry.setAttribute('aTurn', new InterleavedBufferAttribute(buffer, 4, 4));
    geometry.setAttribute('aTint', new InterleavedBufferAttribute(buffer, 4, 8));
    geometry.setAttribute('aShell', new InterleavedBufferAttribute(buffer, 4, 12));
    geometry.instanceCount = 0;
    this.geometry = geometry;
    this.buffer = buffer;
    this.material = new ShaderMaterial({
      name: 'VfxShells',
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      uniforms: { uTime: shared.uTime, ...createFogUniforms() },
      transparent: true,
      premultipliedAlpha: true,
      depthTest: true,
      depthWrite: false,
      side: DoubleSide,
      fog: true,
    });
    this.mesh = new Mesh(geometry, this.material);
    this.mesh.name = 'VfxShells';
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
    this.mesh.visible = false;
  }

  /** Shells in this frame. */
  get count(): number {
    return this.used;
  }

  /** Start of a frame: forget last frame's shells. */
  begin(): void {
    this.used = 0;
  }

  /**
   * One shell for this frame. `cut` is the local +Z height (-1..1) below which the sphere is
   * hidden: -1 = whole sphere, 0.4 = a cap in front. `orientation` null = unturned.
   */
  add(
    x: number,
    y: number,
    z: number,
    radius: number,
    orientation: Quat | null,
    team: TeamId,
    role: ColorRole,
    intensity: number,
    cut: number,
    rimPower: number,
    fill: number,
    twoSided: boolean,
  ): void {
    if (this.used >= SHELL_CAPACITY || !(radius > 0) || !(intensity > 0)) return;
    const data = this.data;
    const o = this.used * SHELL_STRIDE;
    const c = paletteOffset(team, role);
    data[o] = x;
    data[o + 1] = y;
    data[o + 2] = z;
    data[o + 3] = radius;
    if (orientation !== null) {
      data[o + 4] = orientation.x;
      data[o + 5] = orientation.y;
      data[o + 6] = orientation.z;
      data[o + 7] = orientation.w;
    } else {
      data[o + 4] = 0;
      data[o + 5] = 0;
      data[o + 6] = 0;
      data[o + 7] = 1;
    }
    data[o + 8] = PALETTE[c] ?? 0;
    data[o + 9] = PALETTE[c + 1] ?? 0;
    data[o + 10] = PALETTE[c + 2] ?? 0;
    data[o + 11] = intensity;
    data[o + 12] = cut;
    data[o + 13] = rimPower;
    data[o + 14] = fill;
    data[o + 15] = twoSided ? 1 : 0;
    this.used++;
  }

  /** End of a frame: uploads the shells and hides the mesh when there are none. */
  end(): void {
    this.geometry.instanceCount = this.used;
    this.mesh.visible = this.used > 0;
    if (this.used > 0) {
      // Under 3 KB a frame at the cap.
      this.buffer.updateRanges.length = 0;
      this.buffer.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
