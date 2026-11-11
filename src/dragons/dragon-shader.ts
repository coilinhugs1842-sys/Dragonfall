/**
 * GLSL patches that animate the placeholder dragon's wings in the vertex shader, so all the
 * dragons of a class draw in ONE instanced call with no per-wing objects. Pure string work
 * (node-testable); placeholder-dragons.ts hooks it into `Material.onBeforeCompile`.
 *
 * Inputs (see dragon-geometry.ts for `aWing`):
 *   attribute vec4 aWing    per vertex:   hinge X (signed, 0 = body), tip weight, tail weight,
 *                                         membrane mask
 *   attribute vec4 aPose    per instance: flap, extra tip flap, sweep (radians), tail lift (m)
 *   attribute vec3 aAccent  per instance: linear RGB emissive of the team accent (lit pass only)
 *
 * A wing vertex is turned about its shoulder hinge: first SWEEP about the up axis (+Y), then
 * FLAP about the forward axis (+Z). In dragon space +X is the left wing, so the left wing uses
 * the angles as given and the right wing (hinge X < 0) their negatives: positive flap raises
 * both tips, positive sweep moves both tips toward the tail. Body vertices have hinge X = 0,
 * `sign()` gives 0 and both rotations collapse to the identity.
 */

import { WING_HINGE_Y, WING_HINGE_Z } from './dragon-geometry';

/** Changes whenever the patch text does: three.js caches compiled programs under this key. */
export const DRAGON_SHADER_CACHE_KEY = 'dragonfall-placeholder-dragon-2';

export type DragonShaderVariant = 'lit' | 'depth';

/** The part of three's shader object the patch touches. */
export interface PatchableShader {
  vertexShader: string;
  fragmentShader: string;
}

const COMMON = '#include <common>';
const BEGIN_NORMAL = '#include <beginnormal_vertex>';
const BEGIN_VERTEX = '#include <begin_vertex>';
const EMISSIVE = '#include <emissivemap_fragment>';

const VERTEX_PARS = /* glsl */ `
attribute vec4 aWing;
attribute vec4 aPose;
vec3 dfTurnWing( vec3 v, vec2 sweep, vec2 flap ) {
	v = vec3( sweep.x * v.x + sweep.y * v.z, v.y, sweep.x * v.z - sweep.y * v.x );
	return vec3( flap.x * v.x - flap.y * v.y, flap.y * v.x + flap.x * v.y, v.z );
}
`;

const ACCENT_VERTEX_PARS = /* glsl */ `
attribute vec3 aAccent;
varying vec3 vDfAccent;
`;

const POSE_SETUP = /* glsl */ `
float dfSide = sign( aWing.x );
float dfFlapAngle = dfSide * ( aPose.x + aWing.y * aPose.y );
float dfSweepAngle = dfSide * aPose.z;
vec2 dfFlap = vec2( cos( dfFlapAngle ), sin( dfFlapAngle ) );
vec2 dfSweep = vec2( cos( dfSweepAngle ), sin( dfSweepAngle ) );
`;

const TURN_NORMAL = /* glsl */ `
objectNormal = dfTurnWing( objectNormal, dfSweep, dfFlap );
`;

const TURN_POSITION = /* glsl */ `
vec3 dfHinge = vec3( aWing.x, ${WING_HINGE_Y.toFixed(4)}, ${WING_HINGE_Z.toFixed(4)} );
transformed = dfHinge + dfTurnWing( transformed - dfHinge, dfSweep, dfFlap );
transformed.y += aWing.z * aWing.z * aPose.w;
`;

const ACCENT_VERTEX = /* glsl */ `
vDfAccent = aAccent * aWing.w;
`;

const ACCENT_FRAGMENT_PARS = /* glsl */ `
varying vec3 vDfAccent;
`;

const ACCENT_FRAGMENT = /* glsl */ `
totalEmissiveRadiance += vDfAccent;
`;

function insertAfter(source: string, token: string, addition: string): string {
  const at = source.indexOf(token);
  if (at < 0) throw new Error(`dragon shader patch: "${token}" not found (three.js changed?)`);
  const end = at + token.length;
  return `${source.slice(0, end)}\n${addition}${source.slice(end)}`;
}

/**
 * Patches a three.js built-in shader pair in place.
 * - 'lit': MeshLambertMaterial (wing motion on position and normal, team accent emissive)
 * - 'depth': MeshDepthMaterial for the shadow pass (wing motion on position only)
 * Throws if three's chunk layout no longer has the include it hooks into.
 */
export function patchDragonShader(shader: PatchableShader, variant: DragonShaderVariant): void {
  let vertex = shader.vertexShader;
  if (variant === 'lit') {
    vertex = insertAfter(vertex, COMMON, VERTEX_PARS + ACCENT_VERTEX_PARS);
    vertex = insertAfter(vertex, BEGIN_NORMAL, POSE_SETUP + TURN_NORMAL);
    vertex = insertAfter(vertex, BEGIN_VERTEX, TURN_POSITION + ACCENT_VERTEX);
    let fragment = shader.fragmentShader;
    fragment = insertAfter(fragment, COMMON, ACCENT_FRAGMENT_PARS);
    fragment = insertAfter(fragment, EMISSIVE, ACCENT_FRAGMENT);
    shader.fragmentShader = fragment;
  } else {
    vertex = insertAfter(vertex, COMMON, VERTEX_PARS);
    vertex = insertAfter(vertex, BEGIN_VERTEX, POSE_SETUP + TURN_POSITION);
  }
  shader.vertexShader = vertex;
}
