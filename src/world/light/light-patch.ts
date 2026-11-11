/**
 * `useWorldLight(material)`: gives any material the shared world lighting.
 *
 * - A `ShaderMaterial` gets the shared uniform objects and the quality defines; its own GLSL
 *   includes `WORLD_LIGHT_PARS_FRAGMENT` and calls the `wl*` functions.
 * - A built-in lit material (Standard, Lambert, Phong, Toon, Physical) is patched in
 *   `onBeforeCompile`: the sun's contribution is multiplied by `wlSunVisibility` (shadow map
 *   with an edge fade on Medium / High, blob shadows on Low), an optional warm rim is added,
 *   and three's fog is replaced by `wlApplyFog` (sun-tinted haze + sea haze). Lighting itself
 *   stays three's own, from the scene's sun and hemisphere light.
 * - `MeshBasicMaterial` only gets the fog.
 *
 * Every material passed here is tracked until it is disposed, so a preset change recompiles
 * them all with the right shadow define; callers never touch the defines.
 *
 * Do NOT also set `mesh.receiveShadow = true` on a mesh whose material uses this: three would
 * apply its own shadow lookup on top. `castShadow` is what marks a caster.
 */
import { ShaderChunk } from 'three';
import type { Material, ShaderMaterial, WebGLProgramParametersWithUniforms } from 'three';
import { WORLD_LIGHT_PARS_FRAGMENT } from './light-glsl';
import { MAX_SHADOW_BLOBS } from './light-math';
import type { ShadowMode } from './light-math';
import { worldLightUniforms } from './light-uniforms';

export interface WorldLightOptions {
  /** Receive the sun shadow (map or blobs, by preset). Default true. */
  readonly shadows?: boolean;
  /** Strength of the warm sun-side rim on a built-in lit material; 0 (default) = none. */
  readonly rim?: number;
}

interface ResolvedOptions {
  readonly shadows: boolean;
  readonly rim: number;
}

/** The statement in three's `lights_fragment_begin` after which the sun gets its visibility. */
export const SUN_LIGHT_ANCHOR = 'getDirectionalLightInfo( directionalLight, directLight );';

const tracked = new Map<Material, ResolvedOptions>();
let shadowMode: ShadowMode = 'none';

function isShaderMaterial(material: Material): material is ShaderMaterial {
  return (material as { isShaderMaterial?: boolean }).isShaderMaterial === true;
}

/** Writes the shadow define for the current mode. Returns true when a define changed. */
function applyDefines(material: Material, options: ResolvedOptions): boolean {
  const defines = (material.defines ??= {}) as Record<string, string | number>;
  const wantMap = options.shadows && shadowMode === 'map';
  const wantBlobs = options.shadows && shadowMode === 'blobs';
  const hadMap = 'WL_SHADOW_MAP' in defines;
  const hadBlobs = 'WL_BLOBS' in defines;
  if (wantMap === hadMap && wantBlobs === hadBlobs) return false;
  if (wantMap) defines['WL_SHADOW_MAP'] = '';
  else delete defines['WL_SHADOW_MAP'];
  if (wantBlobs) defines['WL_BLOBS'] = MAX_SHADOW_BLOBS;
  else delete defines['WL_BLOBS'];
  return true;
}

const VERTEX_PARS = /* glsl */ `
varying vec3 vWlWorldPos;
`;

/** Mirrors three's <project_vertex>, with the model matrix instead of the model-view. */
const VERTEX_MAIN = /* glsl */ `
{
  vec4 wlWorld = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    wlWorld = batchingMatrix * wlWorld;
  #endif
  #ifdef USE_INSTANCING
    wlWorld = instanceMatrix * wlWorld;
  #endif
  vWlWorldPos = ( modelMatrix * wlWorld ).xyz;
}
`;

const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = wlApplyFog( gl_FragColor.rgb, vWlWorldPos );
#endif
`;

/** The patched GLSL for a built-in material. Exported for tests. */
export function patchWorldLightShader(
  vertexShader: string,
  fragmentShader: string,
  rim: number,
): { vertexShader: string; fragmentShader: string } {
  const vertex = vertexShader
    .replace('#include <common>', `#include <common>\n${VERTEX_PARS}`)
    .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_MAIN}`);

  const rimLine =
    rim > 0
      ? `reflectedLight.directDiffuse += wlRim( wlNormal, normalize( cameraPosition - vWlWorldPos ) )
           * material.diffuseColor * ${rim.toFixed(3)};`
      : '';
  const lights = `
vec3 wlNormal = inverseTransformDirection( normal, viewMatrix );
float wlVisibility = wlSunVisibility( vWlWorldPos, wlNormal );
${ShaderChunk.lights_fragment_begin.replace(
  SUN_LIGHT_ANCHOR,
  `${SUN_LIGHT_ANCHOR}\n\t\tdirectLight.color *= wlVisibility;`,
)}
${rimLine}
`;
  const fragment = fragmentShader
    .replace(
      '#include <common>',
      `#include <common>\nvarying vec3 vWlWorldPos;\n${WORLD_LIGHT_PARS_FRAGMENT}`,
    )
    .replace('#include <lights_fragment_begin>', lights)
    .replace('#include <fog_fragment>', FOG_FRAGMENT);
  return { vertexShader: vertex, fragmentShader: fragment };
}

/**
 * Hooks `material` up to the world lighting (see the file comment) and returns it. Safe to
 * call again with other options. Load-time only.
 */
export function useWorldLight<T extends Material>(material: T, options: WorldLightOptions = {}): T {
  const resolved: ResolvedOptions = {
    shadows: options.shadows ?? true,
    rim: options.rim ?? 0,
  };
  const known = tracked.has(material);
  tracked.set(material, resolved);

  if (isShaderMaterial(material)) {
    const uniforms = material.uniforms;
    const shared = worldLightUniforms();
    for (const name in shared) {
      const uniform = shared[name];
      if (uniform !== undefined) uniforms[name] = uniform;
    }
  } else if (!known) {
    const previous = material.onBeforeCompile;
    material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms, renderer): void => {
      previous.call(material, shader, renderer);
      Object.assign(shader.uniforms, worldLightUniforms());
      const rim = tracked.get(material)?.rim ?? 0;
      const patched = patchWorldLightShader(shader.vertexShader, shader.fragmentShader, rim);
      shader.vertexShader = patched.vertexShader;
      shader.fragmentShader = patched.fragmentShader;
    };
    const previousKey = material.customProgramCacheKey;
    material.customProgramCacheKey = (): string =>
      `${previousKey.call(material)}|wl:${(tracked.get(material)?.rim ?? 0).toFixed(3)}`;
  }
  if (!known) {
    material.addEventListener('dispose', () => {
      tracked.delete(material);
    });
  }
  applyDefines(material, resolved);
  material.needsUpdate = true;
  return material;
}

/**
 * Switches every tracked material to the preset's shadow mode (recompiles the ones that
 * change). Called by `WorldLighting.setQuality`; not per frame.
 */
export function setWorldLightShadowMode(mode: ShadowMode): void {
  if (mode === shadowMode) return;
  shadowMode = mode;
  for (const [material, options] of tracked) {
    if (applyDefines(material, options)) material.needsUpdate = true;
  }
}

/** The mode new materials are set up for. */
export function worldLightShadowMode(): ShadowMode {
  return shadowMode;
}

/** Materials currently hooked up (for tests and leak checks). */
export function trackedWorldLightMaterials(): number {
  return tracked.size;
}
