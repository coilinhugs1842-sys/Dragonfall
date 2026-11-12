/**
 * GLSL of the Ember Relay view. Four programs, one per draw call:
 *
 *   STONE    the stands and braziers: faceted rock lit by the shared world light, with the
 *            glowing panels and coals painted in through the vertex colour's alpha;
 *   SHARD    the two crystals: their own light, a pale edge and a glint toward the sun;
 *   BEACON   a tall thin column of light over each shard and brazier, turned to the camera
 *            round the vertical, so the objectives can be found from across the map;
 *   CARD     a soft halo round each shard and flame tongues in the braziers (Medium, High),
 *            camera-facing quads.
 *
 * Everything is placed in the vertex shader from `uAnchor` (see relay-geometry.ts), so the
 * view writes a handful of uniforms per frame and never touches a buffer.
 *
 * Output is scene-linear like the rest of `src/world` (the post pass tone-maps).
 */

import { WORLD_LIGHT_FOG_PARS_FRAGMENT, WORLD_LIGHT_PARS_FRAGMENT } from '../light/light-glsl';
import { ANCHOR_COUNT, ANCHOR_SHARD, BRAZIER_COALS_DEPTH_M } from './relay-geometry';

const ANCHORS = /* glsl */ `
uniform vec4 uAnchor[${ANCHOR_COUNT}];  // xyz: world position. w (shards only): 0 home, 1 carried, 2 dropped
`;

// --- Stone -------------------------------------------------------------------------------------------

export const STONE_VERTEX = /* glsl */ `
attribute vec4 aPaint;    // rgb: colour, a: glow
attribute float aAnchor;
${ANCHORS}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vPaint;

void main() {
  vec3 world = position + uAnchor[int(aAnchor + 0.5)].xyz;
  vWorld = world;
  vNormal = normal;
  vPaint = aPaint;
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
}
`;

export const STONE_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vPaint;
${WORLD_LIGHT_PARS_FRAGMENT}

void main() {
  vec3 N = normalize(vNormal);
  vec3 toCamera = cameraPosition - vWorld;
  vec3 V = toCamera / max(length(toCamera), 1e-3);
  float nl = dot(N, uWlSunDir);
  // The map rock's painted terminator: half Lambert, half a soft two-tone ramp.
  float sunTerm = mix(max(nl, 0.0), smoothstep(-0.08, 0.42, nl) * 0.82, 0.55);
  float visibility = wlSunVisibility(vWorld, N);
  vec3 irradiance = uWlSunColor * (sunTerm * visibility) + wlAmbient(N);
  // The lit cloud sea throws warm light back up onto undersides.
  irradiance += uWlFogColor * (max(-N.y, 0.0) * 0.35);
  vec3 lit = vPaint.rgb * irradiance * 0.3183 + wlRim(N, V) * vPaint.rgb * (0.9 * visibility);

  // Panels and coals: their own light, breathing slowly, hotter where they face the eye.
  float breathe = 0.86 + 0.14 * sin(uTime * 1.7 + vWorld.y * 0.35 + vWorld.x * 0.2);
  vec3 lightOut = vPaint.rgb * (breathe * (0.65 + 0.35 * max(dot(N, V), 0.0)));

  vec3 color = mix(lit, lightOut, vPaint.a);
  // Light carries through the haze further than stone does.
  gl_FragColor = vec4(mix(wlApplyFog(color, vWorld), color, 0.45 * vPaint.a), 1.0);
}
`;

// --- Shards ------------------------------------------------------------------------------------------

export const SHARD_VERTEX = /* glsl */ `
attribute vec4 aPaint;    // rgb: colour, a: facet brightness
attribute float aAnchor;
uniform mat4 uShardMatrix[2];
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vPaint;

void main() {
  mat4 pose = uShardMatrix[int(aAnchor + 0.5) - ${ANCHOR_SHARD}];
  vec4 world = pose * vec4(position, 1.0);
  vWorld = world.xyz;
  vNormal = mat3(pose) * normal;
  vPaint = aPaint;
  gl_Position = projectionMatrix * (viewMatrix * world);
}
`;

export const SHARD_FRAGMENT = /* glsl */ `
uniform float uTime;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec4 vPaint;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  vec3 N = normalize(vNormal);
  vec3 toCamera = cameraPosition - vWorld;
  vec3 V = toCamera / max(length(toCamera), 1e-3);
  float facing = max(dot(N, V), 0.0);
  float edge = 1.0 - facing;
  float glint = pow(max(dot(reflect(-uWlSunDir, N), V), 0.0), 20.0);
  float pulse = 0.9 + 0.1 * sin(uTime * 2.3);
  // Lit from inside: each facet its own brightness, a pale rim, a spark toward the sun.
  vec3 color = vPaint.rgb * (vPaint.a * pulse * (0.45 + 0.65 * facing));
  color += vec3(1.0, 0.95, 0.88) * (edge * edge * edge * 0.45 + glint * 1.6);
  gl_FragColor = vec4(mix(color, wlApplyFog(color, vWorld), 0.4), 1.0);
}
`;

// --- Beacons -----------------------------------------------------------------------------------------

export const BEACON_VERTEX = /* glsl */ `
attribute vec2 aCorner;   // x: side -1 / +1, y: 0 at the foot .. 1 at the top
attribute float aAnchor;
attribute vec3 aTint;
${ANCHORS}
uniform vec4 uBeacon;     // x: height (m), y: half-width at the foot (m), z: time (s), w: strength
varying vec3 vUvw;        // x: across -1..1, y: along 0..1, z: brightness
varying vec3 vTint;
varying float vState;     // 0: a brazier. A shard: 1 home, 2 carried, 3 dropped
varying vec3 vWorld;

void main() {
  vec4 anchor = uAnchor[int(aAnchor + 0.5)];
  float shard = step(${(ANCHOR_SHARD - 0.5).toFixed(1)}, aAnchor);
  // Starts above the object: the crystal and the flame are their own mark close up.
  vec3 foot = anchor.xyz + vec3(0.0, 5.5, 0.0);
  vec3 toCamera = cameraPosition - foot;
  float dist = length(toCamera);
  float flatDist = length(toCamera.xz);
  vec3 side = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
  // Never thinner than a few pixels, however far away: this is what you steer by.
  float halfWidth = max(uBeacon.y, dist * 0.0075) * mix(1.0, 0.35, aCorner.y);
  vec3 world = foot + side * (aCorner.x * halfWidth) + vec3(0.0, aCorner.y * uBeacon.x, 0.0);

  // Close up it would be a bright bar across the screen: gone before that.
  float fade = smoothstep(24.0, 85.0, flatDist);
  // Looked at steeply from above its top or below its foot it is a fat smear. Beside it (the
  // eye level with any part of the column) the look is level and it stays.
  float beyond = toCamera.y - clamp(toCamera.y, 0.0, uBeacon.x);
  fade *= 1.0 - smoothstep(0.86, 0.98, abs(beyond) / max(length(vec2(flatDist, beyond)), 1e-3));

  vUvw = vec3(aCorner.x, aCorner.y, fade * uBeacon.w);
  vTint = aTint;
  vState = shard * (1.0 + anchor.w);
  vWorld = world;
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
  if (fade < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const BEACON_FRAGMENT = /* glsl */ `
uniform vec4 uBeacon;
varying vec3 vUvw;
varying vec3 vTint;
varying float vState;
varying vec3 vWorld;
${WORLD_LIGHT_FOG_PARS_FRAGMENT}

void main() {
  float across = 1.0 - vUvw.x * vUvw.x;
  across *= across;
  // Full for most of its height, then it thins out into the sky.
  float along = (1.0 - vUvw.y * vUvw.y) * smoothstep(0.0, 0.03, vUvw.y);
  float isShard = step(0.5, vState);
  float carried = step(1.5, vState) * (1.0 - step(2.5, vState));
  float dropped = step(2.5, vState);
  // A brazier's column is steady. A shard's is a string of beads climbing it, so the two are
  // told apart by more than colour; a carried shard's runs faster and brighter, a dropped
  // one's blinks.
  float metres = vUvw.y * uBeacon.x;
  float speed = mix(0.7, 1.9, carried);
  float beads = 0.4 + 0.6 * smoothstep(0.3, 0.5, abs(fract(metres / 15.0 - uBeacon.z * speed) - 0.5) * 2.0);
  float pattern = mix(1.0, beads, isShard);
  float blink = mix(1.0, 0.35 + 0.65 * smoothstep(-0.2, 0.2, sin(uBeacon.z * 6.5)), dropped);
  float dist = length(vWorld - cameraPosition);
  // Objectives are waypoints: the fog thins them, but less than it thins rock.
  float clear = 1.0 - 0.5 * wlFogFactor(vWorld, dist);
  float level = across * along * pattern * blink * (1.0 + 0.5 * carried) * vUvw.z * clear;
  // Premultiplied alpha: the column adds its light and also takes away part of what is behind
  // it. Light alone vanishes into this world's bright sky (Ember's orange on a sunset most of
  // all); with the sky dimmed under it the team colour reads against any backdrop.
  gl_FragColor = vec4(vTint * level, min(level, 1.0) * 0.85);
}
`;

// --- Cards: flames and halos -------------------------------------------------------------------------

export const CARD_VERTEX = /* glsl */ `
attribute vec2 aCorner;   // x: -1..1 across, y: 0..1 up
attribute float aAnchor;
attribute vec3 aTint;
attribute vec4 aCard;     // x: 0 flame / 1 halo, y: seed 0..1, z: half-width (m), w: height (m)
${ANCHORS}
uniform float uTime;
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vCard;       // x: kind, y: seed, z: brightness
varying float vState;

void main() {
  vec4 anchor = uAnchor[int(aAnchor + 0.5)];
  float halo = step(0.5, aCard.x);
  float seed = aCard.y;
  vec3 world;
  vec3 centre;
  if (halo > 0.5) {
    // A disc facing the camera, centred on the shard.
    centre = anchor.xyz;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    // A carried shard is drawn small behind its dragon: its glow shrinks with it, so the
    // carrier's own screen is not washed out.
    float carried = step(0.5, anchor.w) * (1.0 - step(1.5, anchor.w));
    float radius = aCard.z * (1.0 - 0.55 * carried);
    world = centre + (right * aCorner.x + up * (aCorner.y * 2.0 - 1.0)) * radius;
  } else {
    // A tongue standing on the coals, turned to the camera round the vertical; the first one
    // is in the middle of the bowl, the others round it.
    float angle = seed * 6.2832 * 3.0;
    float radial = 4.6 * step(0.05, seed) * (0.45 + 0.55 * fract(seed * 7.3));
    centre = anchor.xyz + vec3(cos(angle) * radial, ${(-BRAZIER_COALS_DEPTH_M + 0.2).toFixed(2)}, sin(angle) * radial);
    vec3 toCamera = cameraPosition - centre;
    vec3 side = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
    float sway = sin(uTime * (2.1 + seed * 2.3) + seed * 40.0) * 0.5 * aCorner.y * aCorner.y;
    world = centre + side * ((aCorner.x + sway) * aCard.z) + vec3(0.0, aCorner.y * aCard.w, 0.0);
  }
  // Flying through the flame (that is how a capture is made) must not fill the screen.
  float near = smoothstep(7.0, 26.0, length(cameraPosition - centre));
  vUv = aCorner;
  vTint = aTint;
  vCard = vec3(halo, seed, near);
  vState = anchor.w;
  gl_Position = projectionMatrix * (viewMatrix * vec4(world, 1.0));
  if (near < 0.01) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

export const CARD_FRAGMENT = /* glsl */ `
uniform float uTime;
uniform vec3 uLoose;      // the palette's objective magenta: a shard that lies loose
varying vec2 vUv;
varying vec3 vTint;
varying vec3 vCard;
varying float vState;

void main() {
  vec3 color;
  if (vCard.x > 0.5) {
    float r = length(vec2(vUv.x, vUv.y * 2.0 - 1.0));
    float soft = max(1.0 - r, 0.0);
    color = vTint * (soft * soft * 0.3);
    // Dropped: rings run outward from it, the mark of something to be picked up.
    float dropped = step(1.5, vState);
    float wave = fract(uTime * 0.7);
    float ring = (1.0 - smoothstep(0.0, 0.07, abs(r - (0.25 + 0.7 * wave)))) * (1.0 - wave);
    color += uLoose * (ring * dropped * 0.9);
  } else {
    float y = vUv.y;
    float seed = vCard.y;
    // The tongue's outline narrows as it rises and wanders from side to side.
    float wander = (sin(y * 7.0 - uTime * 5.2 + seed * 30.0) * 0.2
                  + sin(y * 13.0 - uTime * 8.4 + seed * 11.0) * 0.09) * y;
    float width = (1.0 - y) * (0.5 + 0.5 * (1.0 - y)) + 0.02;
    float d = abs(vUv.x - wander) / width;
    float body = (1.0 - smoothstep(0.45, 1.0, d)) * smoothstep(0.0, 0.06, y);
    float core = (1.0 - smoothstep(0.0, 0.55, d)) * (1.0 - y);
    // The heart is the team colour run pale, not white: on a bright sky white reads as fog.
    color = vTint * (body * (0.45 + 0.55 * (1.0 - y)))
          + mix(vTint, vec3(1.0, 0.93, 0.82), 0.45) * (core * core * 0.5);
  }
  gl_FragColor = vec4(color * vCard.z, 1.0);
}
`;
