/**
 * GLSL of the post pass. Every pass is one full-screen triangle; the vertex shader is shared.
 * The curves mirror ./post-math.ts.
 */

export const POST_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/**
 * Bloom prefilter: scene (sub-rectangle of its target) -> first bloom buffer. A 4-tap box with
 * Karis weights (bright single pixels do not flicker) and a soft-knee threshold.
 */
export const BLOOM_PREFILTER_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D tSource;
uniform vec4 uRect;      // xy: uv scale of the used part of the scene target, zw: largest uv
uniform vec2 uTexel;     // one scene texel in uv
uniform vec2 uThreshold; // x: threshold, y: knee
varying vec2 vUv;

vec3 tap(vec2 uv, inout float weightSum) {
  vec3 c = max(texture2D(tSource, min(uv, uRect.zw)).rgb, 0.0);
  float w = 1.0 / (1.0 + max(c.r, max(c.g, c.b)));
  weightSum += w;
  return c * w;
}

void main() {
  vec2 uv = vUv * uRect.xy;
  float weightSum = 0.0;
  vec3 c = tap(uv + vec2(-1.0, -1.0) * uTexel, weightSum);
  c += tap(uv + vec2(1.0, -1.0) * uTexel, weightSum);
  c += tap(uv + vec2(-1.0, 1.0) * uTexel, weightSum);
  c += tap(uv + vec2(1.0, 1.0) * uTexel, weightSum);
  c /= weightSum;
  float brightness = max(c.r, max(c.g, c.b));
  float soft = clamp(brightness - uThreshold.x + uThreshold.y, 0.0, 2.0 * uThreshold.y);
  soft = soft * soft / (4.0 * uThreshold.y + 1e-4);
  float keep = max(soft, brightness - uThreshold.x) / max(brightness, 1e-4);
  gl_FragColor = vec4(c * keep, 1.0);
}
`;

/** 4-tap box used for both the downsamples and the (additively blended) upsamples. */
export const BLOOM_BLUR_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D tSource;
uniform vec2 uOffset; // tap offset in uv of the source
uniform float uGain;
varying vec2 vUv;

void main() {
  vec3 c = texture2D(tSource, vUv + vec2(-uOffset.x, -uOffset.y)).rgb;
  c += texture2D(tSource, vUv + vec2(uOffset.x, -uOffset.y)).rgb;
  c += texture2D(tSource, vUv + vec2(-uOffset.x, uOffset.y)).rgb;
  c += texture2D(tSource, vUv + uOffset).rgb;
  gl_FragColor = vec4(c * (0.25 * uGain), 1.0);
}
`;

/**
 * The combined pass: (FXAA + sharpen) + (bloom + sun shafts) + exposure + vignette + filmic
 * tone map + lift/gamma/gain grade + sRGB + dither, each behind a define.
 *
 * FXAA and the sharpen work on a locally compressed copy `c / (1 + max(c))` of the HDR colour,
 * so a very bright texel cannot bleed over its neighbours, and are expanded back afterwards.
 * The scene target is smaller than the output, so this pass is also the upscale.
 */
export const COMPOSITE_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D tScene;
uniform vec4 uRect;   // xy: uv scale of the used part of the scene target, zw: largest uv
uniform vec2 uTexel;  // one scene texel in uv
uniform float uExposure;
uniform float uSharpen;
uniform vec3 uLift;
uniform vec3 uInvGamma;
uniform vec3 uGain;
uniform float uSaturation;
uniform vec3 uVignette; // x: strength, y: aspect, z: 1 / (aspect^2 + 1)
#ifdef POST_BLOOM
  uniform sampler2D tBloom;
  uniform float uBloomStrength;
#endif
#ifdef POST_SHAFTS
  uniform vec4 uSun; // xy: sun position in screen uv, z: shaft strength (0 = sun out of view)
#endif
varying vec2 vUv;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 compress(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 expand(vec3 c) { return c / max(1.0 - max(c.r, max(c.g, c.b)), 1e-3); }
vec3 fetch(vec2 uv) { return compress(max(texture2D(tScene, min(uv, uRect.zw)).rgb, 0.0)); }

float gradientNoise(vec2 p) {
  return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec2 uv = vUv * uRect.xy;

  #ifdef POST_FXAA
    vec3 m = fetch(uv);
    vec3 nw = fetch(uv + vec2(-1.0, -1.0) * uTexel);
    vec3 ne = fetch(uv + vec2(1.0, -1.0) * uTexel);
    vec3 sw = fetch(uv + vec2(-1.0, 1.0) * uTexel);
    vec3 se = fetch(uv + vec2(1.0, 1.0) * uTexel);
    float lM = dot(m, LUMA);
    float lNW = dot(nw, LUMA);
    float lNE = dot(ne, LUMA);
    float lSW = dot(sw, LUMA);
    float lSE = dot(se, LUMA);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    float range = lMax - lMin;
    vec3 col = m;
    if (range > max(0.02, lMax * 0.10)) {
      vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
      float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
      float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
      dir = clamp(dir * rcp, -8.0, 8.0) * uTexel;
      vec3 a = 0.5 * (fetch(uv + dir * (1.0 / 3.0 - 0.5)) + fetch(uv + dir * (2.0 / 3.0 - 0.5)));
      vec3 b = a * 0.5 + 0.25 * (fetch(uv - dir * 0.5) + fetch(uv + dir * 0.5));
      float lB = dot(b, LUMA);
      col = (lB < lMin || lB > lMax) ? a : b;
    } else {
      // Flat or softly shaded area: restore the crispness the upscale took, never on an edge.
      col = max(m + (m - (nw + ne + sw + se) * 0.25) * uSharpen, 0.0);
    }
    col = expand(col);
  #else
    vec3 col = max(texture2D(tScene, min(uv, uRect.zw)).rgb, 0.0);
  #endif

  #ifdef POST_BLOOM
    vec3 glow = texture2D(tBloom, vUv).rgb;
    #ifdef POST_SHAFTS
      if (uSun.z > 0.0) {
        // Eight taps of the (already blurred) bloom along the line to the sun: bright sky leaks
        // past whatever dark shape sits between, which reads as shafts.
        vec2 toSun = uSun.xy - vUv;
        vec2 stepUv = toSun * (0.9 / 8.0);
        // No jitter needed: every tap sits at a fixed fraction of the way to the sun, so the
        // sum is a smooth function of the pixel position.
        vec2 p = vUv + stepUv * 0.5;
        vec3 acc = vec3(0.0);
        float w = 1.0;
        for (int i = 0; i < 8; i++) {
          acc += texture2D(tBloom, p).rgb * w;
          p += stepUv;
          w *= 0.85;
        }
        float reach = 1.0 - smoothstep(0.15, 0.9, length(toSun * vec2(uVignette.y, 1.0)));
        glow += acc * (uSun.z * reach * 0.17);
      }
    #endif
    col += glow * uBloomStrength;
  #endif

  col *= uExposure;
  #ifdef POST_VIGNETTE
    vec2 centred = (vUv * 2.0 - 1.0) * vec2(uVignette.y, 1.0);
    float v = clamp(dot(centred, centred) * uVignette.z, 0.0, 1.0);
    col *= 1.0 - uVignette.x * v * v * (3.0 - 2.0 * v);
  #endif

  // Filmic curve (Narkowicz ACES fit), per channel.
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);

  #ifdef POST_GRADE
    col = pow(max(uGain * (col + uLift * (1.0 - col)), 0.0), uInvGamma);
    col = max(mix(vec3(dot(col, LUMA)), col, uSaturation), 0.0);
  #endif

  // Linear -> sRGB, then half an 8-bit step of noise against banding in the slow gradients.
  vec3 lo = col * 12.92;
  vec3 hi = 1.055 * pow(max(col, 0.0031308), vec3(1.0 / 2.4)) - 0.055;
  col = mix(lo, hi, step(0.0031308, col));
  col += (gradientNoise(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}
`;
