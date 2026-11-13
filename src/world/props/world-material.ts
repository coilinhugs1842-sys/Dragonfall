/**
 * The painterly world material: ONE shader for every rock, ruin, banner and backdrop of a map.
 *
 * INPUT (see prop-loader.ts): `aColor` is the finished painted albedo (linear, with the artist's
 * AO, strata, moss and cream chamfers already in it), `aMasks` = AO / moss / lit edge / glow,
 * `uv` a box projection in metres. The shader adds what a vertex colour cannot carry:
 *
 * - brush detail from a shared tileable texture (`albedo *= texel / mean`), moss texture and a
 *   noisy moss fringe on up-facing stone, strata on steep rock faces (High);
 * - warm sun / cool sky lighting from the shared world-light uniforms with a soft painted
 *   terminator, a warm bounce from the lit cloud sea on undersides, a sun-side rim, brighter
 *   chamfers where the sun catches them, and the dragons' shadow (map or blobs, by preset);
 * - emissive crystals, runes and flames (`glow` mask) with a slow pulse / a flicker;
 * - the base of every spire melting into the cloud sea, cool aerial perspective, then the
 *   scene's sun-tinted distance fog, so far rock sits in the sky's colours;
 * - screen-door dither for LOD cross-fades (Medium / High).
 *
 * VARIANTS (defines; `createWorldMaterials` builds the five the map needs):
 *   WM_QUALITY 0|1|2   Low: 1 texture fetch. Medium: 2. High: 4.
 *   WM_FADE            dithered cross-fade (off on Low: fades snap)
 *   WM_FAR             static merged far mesh: world-space vertices, per-instance fade read from
 *                      the far-state texture in the vertex shader, hidden instances collapsed
 *   WM_TINT            vertex colour x the instance's team colour (banners, gate trim)
 *   WM_WIND            cloth sway in the vertex shader (banner cloth only)
 *
 * COST: opaque, no blending, depth-tested front to back by three's opaque sort. No per-frame
 * uniform work beyond one shared time value.
 */

import { Color, DoubleSide, FrontSide, ShaderMaterial, Vector3, Vector4 } from 'three';
import type { IUniform, Side, Texture } from 'three';
import { TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { QualityPreset, QualityPresetId } from '../../shared';
import {
  SEA_HAZE_DISTANCE,
  SEA_HAZE_HEIGHT,
  SEA_HAZE_STRENGTH,
  WORLD_LIGHT_PARS_FRAGMENT,
  setPaintedColor,
  useWorldLight,
} from '../light';
import { GOLDEN_HOUR_LOOK } from '../sky/sky-look';
import type { SkyLook } from '../sky/sky-look';
import type { LoadedMapTexture } from './prop-loader';

/** Team index of a neutral instance in `uTeam` (after Ember 0 and Frost 1). */
export const TINT_NEUTRAL_INDEX = 2;
/** sRGB hex of neutral cloth: a faded dusk violet. */
const NEUTRAL_TINT = 0x8f7fb0;
/**
 * Glow modes (`aInst.z`), what an instance's `glow` faces do:
 * 0 steady: a rune, a lava crack, and a far flame (slow pulse, the faces toward the eye run hot);
 * 1 a flame (flickers and licks sideways);
 * 2 a marker that says "fly here": the palette's magenta at the painted brightness (not the pale
 *   pink the art pipeline's lifted glow colours give), shaded like a crystal but quieter;
 * 3 a crystal: a cut gem instead of a flat pink shape. Each facet takes one tone from the sun
 *   (deep violet-magenta away from it), the colour runs from deep at the foot to light at the
 *   tip, edges seen at a slant lighten, and a facet that mirrors the sun flashes. Low keeps the
 *   facet tones and the run;
 * 4 carved: no light at all, the glyph is a dark groove in the stone (the aerie's perch stones,
 *   where a magenta rune would wrongly say "objective").
 */
export const GLOW_MODE_STEADY = 0;
export const GLOW_MODE_FLAME = 1;
export const GLOW_MODE_MARKER = 2;
export const GLOW_MODE_CRYSTAL = 3;
export const GLOW_MODE_CARVED = 4;
/** The palette's magenta for hazards, pickups and objectives (docs/ART_DIRECTION.md). */
const MARKER_COLOR = 0xff3fa4;
/** A marker's sunlit facets, as a gain on the palette magenta (it was 1.18 on every face): a sign, not a lamp. */
const MARKER_LIT = 0.42;
/** Metres above (or below) an instance's origin at which the run along a crystal is half done. */
const GEM_RUN_METRES = 14;
/** A crystal's sunlit facets, as a share of the look's glow gain (1.9 on the first map). */
const CRYSTAL_LIT = 0.54;
/** What a facet turned away from the sun keeps of each channel: deeper, and toward violet. */
const GEM_SHADE = 'vec3(0.3, 0.24, 0.5)';
/** The same for a marker: it has to stay magenta from every side. */
const MARKER_SHADE = 'vec3(0.5, 0.42, 0.66)';
/** Metres above the sea over which the glow from below (lava) fades to 37 %. */
const BOUNCE_HEIGHT = 110;
/** Strength of that glow on rock that faces down, and on rock that faces up. */
const BOUNCE_GAIN = 1.0;
/** Metres over which the aerial tint reaches 63 % of `AIR_STRENGTH`. */
const AIR_DISTANCE = 450;
const AIR_STRENGTH = 0.8;
/** Share of the scene fog's sea-haze band the world material applies (the rest would bleach rock). */
const SEA_VEIL = 0.35;

const QUALITY_LEVEL: Readonly<Record<QualityPresetId, number>> = { low: 0, medium: 1, high: 2 };

const VERTEX = /* glsl */ `
attribute vec4 aColor;
attribute vec4 aMasks;
uniform float uTime;
uniform vec3 uTeam[3];
#ifdef WM_FAR
  attribute vec2 aFar;          // x: placement index, y: fog distance scale
  uniform sampler2D uFarState;  // R: fade magnitude, G: sign
#else
  attribute vec4 aInst;         // x: signed fade, y: phase 0..1, z: glow mode, w: team index
#endif
#ifdef WM_WIND
  uniform vec3 uWind;           // x: local Y of the cloth's top edge, y: 1 / cloth length, z: metres
#endif
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vMasks;
varying vec4 vFx;               // x: signed fade, y: phase, z: glow mode, w: fog distance scale
varying float vLift;            // metres above the instance's origin (0 on the merged far meshes: no run)

void main() {
  vec3 p = position;
  vColor = aColor.rgb;
  vMasks = aMasks;
  vUv = uv;
  #ifdef WM_FAR
    vec4 state = texelFetch(uFarState, ivec2(int(aFar.x + 0.5), 0), 0);
    // The glow mode rides in the colour's fourth byte (prop-field.ts): 0, marker or crystal.
    vFx = vec4(state.g > 0.5 ? -state.r : state.r, fract(aFar.x * 0.618034), floor(aColor.a * 255.0 + 0.5), aFar.y);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vNormal = normal;
    vLift = 0.0;
  #else
    vFx = vec4(aInst.x, aInst.y, aInst.z, 1.0);
    #ifdef WM_TINT
      vColor *= uTeam[int(aInst.w + 0.5)];
    #endif
    #ifdef WM_WIND
      float hang = clamp((uWind.x - p.y) * uWind.y, 0.0, 1.0);
      float swing = sin(uTime * 1.9 + aInst.y * 6.2832 - hang * 3.4 + p.x * 0.35)
                  + 0.45 * sin(uTime * 3.3 + aInst.y * 17.0 - hang * 6.0);
      p.z += swing * hang * hang * uWind.z;
      p.x += cos(uTime * 1.3 + aInst.y * 9.0 - hang * 2.0) * hang * hang * uWind.z * 0.35;
    #endif
    // Flames (glow mode 1) lick sideways; everything else with a glow mask stays rigid.
    float flame = step(0.5, aInst.z) * (1.0 - step(1.5, aInst.z)) * aMasks.a;
    p.x += flame * 0.16 * sin(uTime * 9.0 + p.y * 2.3 + aInst.y * 40.0);
    p.z += flame * 0.16 * cos(uTime * 7.3 + p.y * 2.9 + aInst.y * 23.0);
    #ifdef USE_INSTANCING
      vec4 world = modelMatrix * (instanceMatrix * vec4(p, 1.0));
      vNormal = normalize(mat3(instanceMatrix) * normal);
      vLift = world.y - (modelMatrix * instanceMatrix[3]).y;
    #else
      vec4 world = modelMatrix * vec4(p, 1.0);
      vNormal = normalize(mat3(modelMatrix) * normal);
      vLift = world.y - modelMatrix[3].y;
    #endif
  #endif
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * (viewMatrix * world);
  #ifdef WM_FAR
    // A hidden instance: every vertex to one point behind the near plane (clipped, no fill).
    if (state.r <= 0.0) gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
  #endif
}
`;

const FRAGMENT = /* glsl */ `
uniform float uTime;
uniform sampler2D uDetail;
uniform vec4 uDetailGain;       // rgb: 1 / mean colour, a: strength
uniform vec3 uMossColor;
uniform vec3 uEdgeColor;
uniform vec3 uStoneColor;
uniform vec4 uGlow;             // x: emissive gain, y: pulse depth, z: sea fade height (m), w: sea fade strength
uniform vec4 uAir;              // rgb: aerial-perspective tint away from the sun, a: 1 / distance
uniform vec4 uAirWarm;          // rgb: the same toward the sun, a: strength 0..1
uniform vec4 uGrade;            // x: stone saturation, y: stone gain, z: fog distance scale, w: bounce
uniform vec4 uBounce;           // rgb: glow from below the sea (lava), a: 1 / fade height. rgb 0 = none
uniform vec3 uMarkerColor;      // what glow mode 2 ("fly here") glows in
#if WM_QUALITY >= 1
  uniform sampler2D uMoss;
  uniform vec4 uMossGain;       // rgb: 1 / mean colour, a: 1 / tile metres
#endif
#if WM_QUALITY >= 2
  uniform sampler2D uCliff;
  uniform vec4 uCliffGain;      // rgb: 1 / mean colour, a: 1 / tile metres
  uniform sampler2D uBrush;
  uniform float uBrushScale;    // 1 / tile metres
#endif
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying vec3 vColor;
varying vec4 vMasks;
varying vec4 vFx;
varying float vLift;
${WORLD_LIGHT_PARS_FRAGMENT}

void main() {
  #ifdef WM_FADE
    float dither = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    if (vFx.x >= 0.0 ? dither >= vFx.x : dither < 1.0 + vFx.x) discard;
  #endif

  vec3 N = normalize(vNormal);
  #ifdef DOUBLE_SIDED
    if (!gl_FrontFacing) N = -N;
  #endif
  float ao = vMasks.r;
  float moss = vMasks.g;
  float edge = vMasks.b;
  // Glow modes 2..4 (see GLOW_MODE_*): marker, crystal, carved.
  float marker = step(1.5, vFx.z) * (1.0 - step(2.5, vFx.z));
  float crystal = step(2.5, vFx.z) * (1.0 - step(3.5, vFx.z));
  float carved = step(3.5, vFx.z);
  float glow = vMasks.a * (1.0 - carved);
  float solid = 1.0 - glow;

  // --- Albedo: painted vertex colour x brush detail -------------------------------------------
  vec3 albedo = vColor;
  vec3 texel = texture2D(uDetail, vUv).rgb;
  vec3 detail = texel * uDetailGain.rgb;
  float grain = dot(detail, vec3(0.3333));          // about 1 on average
  #if WM_QUALITY >= 2
    // Strata on steep rock: projected along the facet's dominant horizontal axis (facets are
    // flat, so the choice is constant across a face and leaves no seam inside it).
    vec2 cliffUv = (abs(N.x) > abs(N.z) ? vWorldPos.zy : vWorldPos.xy) * uCliffGain.a;
    vec3 strata = texture2D(uCliff, cliffUv).rgb * uCliffGain.rgb;
    detail = mix(detail, strata, (1.0 - smoothstep(0.35, 0.7, abs(N.y))) * 0.55);
    float brush = texture2D(uBrush, vWorldPos.xz * uBrushScale + vWorldPos.y * uBrushScale * 0.37).r;
    detail *= 0.78 + 0.44 * brush;
  #endif
  // Painted cream chamfers are a pixel wide from afar and shimmer: fold them back into stone.
  albedo = mix(albedo, uStoneColor * 0.8, edge * solid * smoothstep(60.0, 220.0, length(cameraPosition - vWorldPos)) * 0.75);
  albedo *= mix(vec3(1.0), detail, uDetailGain.a * solid);
  // Grade: the painted slate is pushed a little deeper and bluer than the vertex colours alone.
  float albedoLuma = dot(albedo, vec3(0.2126, 0.7152, 0.0722));
  albedo = mix(albedo, max(mix(vec3(albedoLuma), albedo, uGrade.x), 0.0) * uGrade.y, solid);
  // A carved glyph: a groove of dark stone where the glow would be.
  albedo = mix(albedo, uStoneColor * 0.28 * grain, vMasks.a * carved);

  // Painted moss: calmer than the raw vertex green.
  float mossy = moss * solid;
  vec3 calm = mix(vec3(dot(albedo, vec3(0.2126, 0.7152, 0.0722))), albedo, 0.72) * 0.82;
  #if WM_QUALITY >= 1
    vec3 mossTexel = texture2D(uMoss, vWorldPos.xz * uMossGain.a).rgb;
    vec3 mossDetail = mossTexel * uMossGain.rgb;
    float mossLuma = dot(mossDetail, vec3(0.3333));
    // Textured, and worn through to stone in patches.
    albedo = mix(albedo, calm * mix(vec3(1.0), mossDetail, 0.6), mossy);
    float worn = (1.0 - smoothstep(0.78, 1.05, mossLuma * 0.55 + grain * 0.5)) * mossy;
    albedo = mix(albedo, uStoneColor * detail * 0.9, worn * 0.55);
    // A ragged fringe of moss creeping over up-facing stone, broken up by the textures.
    float up = smoothstep(0.55, 0.92, N.y);
    float patchy = smoothstep(0.92, 1.18, grain * 0.5 + mossLuma * 0.62);
    float fringe = up * patchy * (1.0 - moss) * solid * (1.0 - edge) * 0.6;
    albedo = mix(albedo, uMossColor * mix(vec3(1.0), mossDetail, 0.6) * (0.45 + 0.4 * ao), fringe);
  #else
    albedo = mix(albedo, calm * (0.8 + 0.2 * grain), mossy);
  #endif

  // --- Light -------------------------------------------------------------------------------------
  vec3 toCamera = cameraPosition - vWorldPos;
  float dist = max(length(toCamera), 1e-3);
  vec3 V = toCamera / dist;
  float nl = dot(N, uWlSunDir);
  // Half Lambert, half a soft two-tone ramp: a painted terminator instead of a long grey falloff.
  float sunTerm = mix(max(nl, 0.0), smoothstep(-0.08, 0.42, nl) * 0.82, 0.55);
  float visibility = wlSunVisibility(vWorldPos, N);
  // Chamfers catch the sun, but only close up: thin bright edges shimmer at a distance.
  float edgeNear = edge * solid * exp(-dist * 0.012);
  vec3 irradiance = uWlSunColor * (sunTerm * visibility * (1.0 + edgeNear * 0.5));
  irradiance += wlAmbient(N) * mix(0.45, 1.0, ao);
  // The lit cloud sea throws warm light back up onto undersides.
  irradiance += uWlFogColor * (max(-N.y, 0.0) * uGrade.w) * mix(0.6, 1.0, ao);
  // A glowing sea (lava under ash) lights rock from below: strongest on undersides close to
  // it, gone a hundred metres up. All zero on a map without one.
  float lift = max(vWorldPos.y - uWlFogParams.y, 0.0);
  irradiance += uBounce.rgb * (exp(-lift * uBounce.a) * (0.12 + 0.88 * max(-N.y, 0.0)) * mix(0.5, 1.0, ao));
  vec3 color = albedo * irradiance * 0.3183;
  color += wlRim(N, V) * albedo * (0.9 * visibility);
  color += uEdgeColor * edgeNear * max(nl, 0.0) * visibility * 0.2;

  // --- Emissive ------------------------------------------------------------------------------------
  float slow = sin(uTime * 0.9 + vFx.y * 6.2832);
  float flicker = sin(uTime * 11.0 + vFx.y * 50.0) * sin(uTime * 7.3 + vFx.y * 31.0);
  float gem = marker + crystal;
  float pulse = 1.0 + uGlow.y * mix(slow, flicker, step(0.5, vFx.z) * (1.0 - step(1.5, vFx.z)));
  // Facets stay readable (a little of the lighting survives) and the ones facing the eye run hot.
  float facing = max(dot(N, V), 0.0);
  vec3 glowColor = mix(vColor, vColor * vColor * 1.5, 0.7);
  // The white-hot core is what the gain has above 1 (0.3 of the gain at the first map's 1.9).
  float hot = max(uGlow.x - 1.0, 0.0) * 0.6333 * pulse;
  vec3 ember = glowColor * (uGlow.x * pulse) * (0.6 + 0.4 * facing)
             + vec3(1.0, 0.9, 0.85) * (facing * facing * facing * hot);
  // Crystals and markers are cut stones, not lamps. A marker is the palette's magenta at the
  // painted brightness (the art pipeline lifts glow colours toward white: pale pink).
  float paint = max(vColor.r, max(vColor.g, vColor.b));
  vec3 gemColor = mix(glowColor, uMarkerColor * paint, marker);
  // One tone per flat facet, lightest toward the sun. Along its length the stone runs from
  // deep at the foot to light at the tip (-1..1 around the instance's origin); a crystal's tip
  // is paler too, a marker stays the one magenta.
  float facet = smoothstep(-0.4, 0.8, nl) * (0.55 + 0.45 * visibility);
  float run = vLift / (abs(vLift) + ${GEM_RUN_METRES.toFixed(1)});
  vec3 gemLit = gemColor * (mix(uGlow.x * ${CRYSTAL_LIT.toFixed(3)}, ${MARKER_LIT.toFixed(3)}, marker) * (1.0 + 0.4 * run));
  gemLit = mix(gemLit, gemLit.r * vec3(1.0, 0.6, 0.86), 0.22 * max(run, 0.0) * crystal);
  vec3 gemBody = mix(gemLit * mix(${GEM_SHADE}, ${MARKER_SHADE}, marker), gemLit, facet) * pulse;
  #if WM_QUALITY >= 1
    // Looked into straight on, the stone is deepest; edges seen at a slant lighten (it is
    // clear), and a facet that mirrors the sun flashes. Markers get half the edge and no
    // flash: they guide, they do not sparkle.
    float slant = 1.0 - facing;
    gemBody *= 1.0 - 0.22 * facing * facing;
    gemBody += mix(gemColor, vec3(1.0, 0.72, 0.9), 0.55) * (slant * slant * slant * (0.8 - 0.4 * marker));
    float flash = max(dot(N, normalize(V + uWlSunDir)), 0.0);
    flash *= flash;
    flash *= flash;
    flash *= flash;
    gemBody += vec3(1.0, 0.86, 0.8) * (flash * flash * 0.9 * visibility * crystal);
  #endif
  ember = mix(ember, gemBody, gem);
  color = mix(color, ember + color * 0.25, glow);

  // --- Atmosphere --------------------------------------------------------------------------------
  vec3 viewDir = -V;
  vec3 haze = wlHaze(viewDir);
  float sunward = max(dot(viewDir, uWlSunDir), 0.0);
  vec3 airColor = mix(uAir.rgb, uAirWarm.rgb, sunward * sunward);
  float fogDist = dist * vFx.w;
  // Spires rise out of the cloud sea: the lowest metres dissolve into its mist, and the sea's
  // own haze layer (the scene fog's low band, here at reduced strength) veils what stands in it.
  float height = vWorldPos.y - uWlFogParams.y;
  float sea = 1.0 - smoothstep(0.0, uGlow.z, height + (grain - 1.0) * uGlow.z * 0.35);
  float band = clamp(1.0 - height * ${(1 / SEA_HAZE_HEIGHT).toFixed(6)}, 0.0, 1.0);
  float veil = band * band * ${(SEA_HAZE_STRENGTH * SEA_VEIL).toFixed(4)} * uWlFogParams.w
             * (1.0 - exp(-fogDist * ${(1 / SEA_HAZE_DISTANCE).toFixed(6)}));
  color = mix(color, mix(haze, airColor, 0.5), max(sea * sea * uGlow.w, veil));
  // Far layers become flat violet silhouettes (rose toward the sun) that the sky outshines.
  float air = (1.0 - exp(-fogDist * uAir.a)) * uAirWarm.a;
  color = mix(color, airColor, air * (1.0 - 0.6 * glow));
  // Then the scene's distance fog, slower than on the sea so the far rim keeps its shape.
  float fx = uWlFogParams.x * fogDist * uGrade.z;
  color = mix(color, haze, 1.0 - exp(-fx * fx));

  gl_FragColor = vec4(color, 1.0);
}
`;

/** Shared, mutable look of every world material (one object per map view). */
export interface WorldMaterialUniforms {
  readonly uTime: IUniform<number>;
  readonly uTeam: IUniform<Color[]>;
}

export interface WorldMaterialOptions {
  /** `uDetail`: the brush detail sampled by the mesh UVs. */
  readonly detail: LoadedMapTexture;
  /** 0..1: how much of the detail texture multiplies the painted colour. */
  readonly detailStrength: number;
  readonly side: Side;
  readonly far?: { readonly state: Texture };
  readonly tint?: boolean;
  /** Cloth sway: local Y of the top edge, cloth length and swing in metres. */
  readonly wind?: { readonly topY: number; readonly length: number; readonly amplitude: number };
}

export interface WorldMaterialTextures {
  readonly stone: LoadedMapTexture;
  readonly masonry: LoadedMapTexture;
  readonly moss: LoadedMapTexture;
  readonly cliff: LoadedMapTexture;
  readonly brush: LoadedMapTexture;
}

function inverseMean(loaded: LoadedMapTexture, w: number): Vector4 {
  const mean = loaded.info.meanLinear;
  return new Vector4(
    1 / Math.max(mean[0] ?? 1, 1e-3),
    1 / Math.max(mean[1] ?? 1, 1e-3),
    1 / Math.max(mean[2] ?? 1, 1e-3),
    w,
  );
}

/** The five materials a map view draws with, plus the uniforms they share. */
export interface WorldMaterials {
  /** Hero rocks: stone detail by UV. */
  readonly rock: ShaderMaterial;
  /** Ruins and props: masonry detail, double-sided (chains, thin slabs). */
  readonly prop: ShaderMaterial;
  /** `TeamTint` slots that stay rigid (gate trim). */
  readonly tint: ShaderMaterial;
  /** The merged far meshes. */
  readonly far: ShaderMaterial;
  readonly shared: WorldMaterialUniforms;
  /** A `TeamTint` cloth material that sways (one per banner type: the cloth sizes differ). */
  createCloth(topY: number, length: number, amplitude: number): ShaderMaterial;
  setQuality(preset: QualityPreset): void;
  setTime(timeS: number): void;
  dispose(): void;
}

/** Linear RGB triple of an sRGB hex, for baking team colours into the far meshes. */
export function srgbHexToLinear(hex: number): readonly number[] {
  return new Color().setHex(hex).toArray();
}

/** Scene-linear colour of an sRGB hex (three converts in `setHex`). */
function linear(hex: number): Color {
  return new Color().setHex(hex);
}

/** The colours of a look the world material paints with (a `SkyLook` has them all). */
export type WorldPalette = Pick<
  SkyLook,
  'stone' | 'moss' | 'edge' | 'air' | 'airWarm' | 'bounce' | 'stoneSaturation' | 'glowGain'
>;

/** `palette` left out = the first map's (slate, moss, cream edges, no glow from below). */
export function createWorldMaterials(
  textures: WorldMaterialTextures,
  farState: Texture,
  preset: QualityPreset,
  palette: WorldPalette = GOLDEN_HOUR_LOOK,
): WorldMaterials {
  const shared: WorldMaterialUniforms = {
    uTime: { value: 0 },
    uTeam: {
      value: [linear(TEAMS[TEAM_EMBER].color), linear(TEAMS[TEAM_FROST].color), linear(NEUTRAL_TINT)],
    },
  };
  // Display-referred palette colours: stored as the scene-linear values the post pass shows as these.
  const airCool = setPaintedColor(new Color(), palette.air);
  const airSun = setPaintedColor(new Color(), palette.airWarm);
  const air = new Vector4(airCool.r, airCool.g, airCool.b, 1 / AIR_DISTANCE);
  const airWarm = new Vector4(airSun.r, airSun.g, airSun.b, AIR_STRENGTH);
  // Light, not paint: scene-linear, and shared by every material of the field.
  const glowBelow = linear(palette.bounce).multiplyScalar(palette.bounce === 0 ? 0 : BOUNCE_GAIN);
  const bounce = new Vector4(glowBelow.r, glowBelow.g, glowBelow.b, 1 / BOUNCE_HEIGHT);
  const all: ShaderMaterial[] = [];
  let level = QUALITY_LEVEL[preset.id];

  function build(name: string, options: WorldMaterialOptions): ShaderMaterial {
    const defines: Record<string, string | number> = { WM_QUALITY: level };
    if (level > 0) defines['WM_FADE'] = '';
    if (options.far !== undefined) defines['WM_FAR'] = '';
    if (options.tint === true) defines['WM_TINT'] = '';
    if (options.wind !== undefined) defines['WM_WIND'] = '';
    const moss = inverseMean(textures.moss, 1 / textures.moss.info.tileMetres);
    const cliff = inverseMean(textures.cliff, 1 / textures.cliff.info.tileMetres);
    const uniforms: Record<string, IUniform> = {
      uTime: shared.uTime,
      uTeam: shared.uTeam,
      uDetail: { value: options.detail.texture },
      uDetailGain: { value: inverseMean(options.detail, options.detailStrength) },
      uMossColor: { value: linear(palette.moss) },
      uEdgeColor: { value: linear(palette.edge) },
      uStoneColor: { value: linear(palette.stone) },
      uBounce: { value: bounce },
      uMarkerColor: { value: linear(MARKER_COLOR) },
      uGlow: { value: new Vector4(palette.glowGain, 0.22, 40, 0.85) },
      uAir: { value: air },
      uAirWarm: { value: airWarm },
      uGrade: { value: new Vector4(palette.stoneSaturation, 0.8, 0.5, 0.2) },
      uMoss: { value: textures.moss.texture },
      uMossGain: { value: moss },
      uCliff: { value: textures.cliff.texture },
      uCliffGain: { value: cliff },
      uBrush: { value: textures.brush.texture },
      uBrushScale: { value: 1 / textures.brush.info.tileMetres },
    };
    if (options.far !== undefined) uniforms['uFarState'] = { value: options.far.state };
    if (options.wind !== undefined) {
      uniforms['uWind'] = {
        value: new Vector3(options.wind.topY, 1 / Math.max(options.wind.length, 0.01), options.wind.amplitude),
      };
    }
    const material = new ShaderMaterial({
      name,
      defines,
      uniforms,
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      side: options.side,
      fog: false,
    });
    all.push(material);
    return useWorldLight(material);
  }

  const rock = build('world-rock', { detail: textures.stone, detailStrength: 0.8, side: FrontSide });
  const prop = build('world-prop', { detail: textures.masonry, detailStrength: 0.65, side: DoubleSide });
  const tint = build('world-tint', {
    detail: textures.masonry,
    detailStrength: 0.3,
    side: DoubleSide,
    tint: true,
  });
  const far = build('world-far', {
    detail: textures.stone,
    detailStrength: 0.8,
    side: DoubleSide,
    far: { state: farState },
  });

  return {
    rock,
    prop,
    tint,
    far,
    shared,
    createCloth(topY: number, length: number, amplitude: number): ShaderMaterial {
      return build('world-cloth', {
        detail: textures.brush,
        detailStrength: 0,
        side: DoubleSide,
        tint: true,
        wind: { topY, length, amplitude },
      });
    },
    setQuality(next: QualityPreset): void {
      const wanted = QUALITY_LEVEL[next.id];
      if (wanted === level) return;
      level = wanted;
      for (const material of all) {
        material.defines['WM_QUALITY'] = level;
        if (level > 0) material.defines['WM_FADE'] = '';
        else delete material.defines['WM_FADE'];
        material.needsUpdate = true;
      }
    },
    setTime(timeS: number): void {
      shared.uTime.value = timeS;
    },
    dispose(): void {
      for (const material of all) material.dispose();
      all.length = 0;
    },
  };
}
