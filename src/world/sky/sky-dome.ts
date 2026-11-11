/**
 * Procedural golden-hour sky (T-1.4): a vertical cream -> peach -> dusk-violet gradient, a soft
 * sun, and a horizon haze band that is exactly the fog colour.
 *
 * How it is drawn, and why:
 * - ONE full-screen triangle whose vertices are written straight to clip space at the far plane
 *   (z = w). It has no world position, so it follows the camera with no parallax, can never be
 *   clipped by the far plane, and needs no per-frame CPU work at all.
 * - Drawn LAST among the opaque objects (`renderOrder`), depth test on, depth write off. On an
 *   integrated GPU fill is the cost, and by then the depth buffer rejects every sky pixel that
 *   terrain, dragons or the cloud sea already cover. Transparent objects still draw after it.
 * - The view ray is rebuilt in the vertex shader from `projectionMatrix` and `viewMatrix`.
 *
 * Colour: three.js applies fog AFTER tone mapping and the output transfer, with a fog colour
 * that is never tone-mapped. So fully fogged geometry lands on the fog colour itself. The sky
 * therefore sets `toneMapped = false` and only runs `<colorspace_fragment>`: its horizon band
 * comes out as the same value on the canvas (sRGB) and in a linear render target (post pass).
 */
import { BufferAttribute, BufferGeometry, Color, Mesh, ShaderMaterial, Vector3 } from 'three';
import type { QualityPreset } from '../../shared';
import { GOLDEN_HOUR_SKY, SKY_CREAM, SKY_DUSK_VIOLET, SKY_PEACH } from './sky-math';
import type { SkySetup } from './sky-math';

/** After every opaque object (default 0) and after the cloud sea. */
export const SKY_RENDER_ORDER = 1000;

const VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;

void main() {
  // position.xy is already clip space; z = w puts the triangle on the far plane.
  gl_Position = vec4(position.xy, 1.0, 1.0);
  // View-space ray through this vertex at depth 1 (the [2] terms are zero for a centred frustum).
  vec3 ray = vec3(
    (position.x + projectionMatrix[2][0]) / projectionMatrix[0][0],
    (position.y + projectionMatrix[2][1]) / projectionMatrix[1][1],
    -1.0
  );
  // viewMatrix's 3x3 is a pure rotation: v * M is transpose(M) * v, i.e. view -> world.
  vDir = ray * mat3(viewMatrix);
}
`;

const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uHorizon;
uniform vec3 uCream;
uniform vec3 uPeach;
uniform vec3 uZenith;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
varying vec3 vDir;

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y; // sine of the elevation: 0 at the horizon, 1 straight up

  // Vertical gradient (all colours are linear working space).
  vec3 col = mix(uCream, uPeach, smoothstep(0.02, 0.30, h));
  col = mix(col, uZenith, smoothstep(0.22, 0.95, h));

  // Sun: a wide warm glow, a tighter halo and a small disc, by repeated squaring (no pow).
  float s = max(dot(dir, uSunDir), 0.0);
  float s2 = s * s;
  float s8 = s2 * s2 * s2 * s2;
  float glow = s8 * 0.22;
  #ifdef SKY_HALO
    float s64 = s8 * s8;
    s64 = s64 * s64 * s64 * s64;
    glow += s64 * 0.45;
  #endif
  col += uSunColor * glow;
  col = mix(col, uSunColor * 1.6, smoothstep(0.99905, 0.9996, s)); // about 2 degrees across

  // Haze: at and below the horizon the sky IS the fog colour, so fogged geometry vanishes.
  col = mix(col, uHorizon, 1.0 - smoothstep(0.0, 0.10, h));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #ifdef SKY_DITHER
    // Half an 8-bit step of interleaved-gradient noise hides banding in the slow gradient.
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor.rgb += (n - 0.5) / 255.0;
  #endif
}
`;

export interface SkyDome {
  /** Add to the scene. Needs no update: the shader follows the camera by itself. */
  readonly object: Mesh<BufferGeometry, ShaderMaterial>;
  /** Low: gradient + glow + disc. Medium/High: + tight sun halo and gradient dithering. */
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export function createSkyDome(setup: SkySetup = GOLDEN_HOUR_SKY): SkyDome {
  // One triangle that covers the whole viewport: no diagonal seam, no overdraw.
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );

  const sunDir = new Vector3(
    setup.sunDirection.x,
    setup.sunDirection.y,
    setup.sunDirection.z,
  ).normalize();

  const material = new ShaderMaterial({
    name: 'SkyDome',
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    uniforms: {
      // `Color` holds linear working-space values; the shader mixes in linear.
      uHorizon: { value: new Color(setup.fogColor) },
      uCream: { value: new Color(SKY_CREAM) },
      uPeach: { value: new Color(SKY_PEACH) },
      uZenith: { value: new Color(SKY_DUSK_VIOLET) },
      uSunColor: { value: new Color(setup.sunColor) },
      uSunDir: { value: sunDir },
    },
    defines: {},
    depthTest: true,
    depthWrite: false,
    fog: false,
    // See the file comment: the sky has to match the (never tone-mapped) fog colour.
    toneMapped: false,
  });

  const object = new Mesh(geometry, material);
  object.name = 'SkyDome';
  // The triangle is in clip space: a world-space bounding sphere would cull it wrongly.
  object.frustumCulled = false;
  object.matrixAutoUpdate = false;
  object.renderOrder = SKY_RENDER_ORDER;

  let detailed: boolean | null = null;

  return {
    object,
    setQuality(preset: QualityPreset): void {
      const wantDetailed = preset.id !== 'low';
      if (wantDetailed === detailed) return;
      detailed = wantDetailed;
      // Assigning the object needs the property to be writable; rebuild the two flags in place.
      const defines = material.defines as Record<string, string>;
      if (wantDetailed) {
        defines['SKY_HALO'] = '';
        defines['SKY_DITHER'] = '';
      } else {
        delete defines['SKY_HALO'];
        delete defines['SKY_DITHER'];
      }
      material.needsUpdate = true;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
