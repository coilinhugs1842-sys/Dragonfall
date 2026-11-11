/**
 * The post pass (T-4.7): the scene is drawn into ONE HDR target at the dynamic render scale,
 * then a single full-screen shader writes the canvas at display size.
 *
 *   Low     tone map + grade + vignette                                   (1 pass)
 *   Medium  + FXAA + sharpen, same shader                                 (1 pass)
 *   High    + bloom (3 buffers from half the scene size down) and sun shafts (6 passes)
 *
 * Dynamic resolution without reallocation: the scene target is allocated once at the preset's
 * LARGEST render scale and the scene is drawn into a viewport of the current scale. The
 * composite reads that sub-rectangle (`uRect`), so a scale step costs a few uniform writes
 * instead of a framebuffer reallocation and a hitch. Bloom buffers have a fixed size.
 *
 * The target is half-float where the GPU can render to it (WebGL2 + EXT_color_buffer_float or
 * _half_float); otherwise 8-bit sRGB-encoded, where highlights clip at 1 before the tone map.
 *
 * Per frame: no allocations; a handful of uniform writes.
 */
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  RGBAFormat,
  SRGBColorSpace,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderTarget,
} from 'three';
import type { Camera, Object3D, WebGLRenderer } from 'three';
import type { QualityPreset } from '../../shared/quality';
import { bloomLevelSize, postPlanFor, scaledSize } from './post-math';
import type { PostPlan } from './post-math';
import {
  BLOOM_BLUR_FRAGMENT_SHADER,
  BLOOM_PREFILTER_FRAGMENT_SHADER,
  COMPOSITE_FRAGMENT_SHADER,
  POST_VERTEX_SHADER,
} from './post-shaders';

/**
 * Look of the post pass. One mutable object for the app's life (`GameRenderer.post.settings`):
 * the world lighting writes the sun, a debug GUI may bind to the numbers. Read every frame.
 */
export interface PostSettings {
  /** Linear multiplier before the tone map. */
  exposure: number;
  /** 1 = unchanged. */
  saturation: number;
  /** Per-channel lift (blacks), gamma (mids), gain (whites) on the tone-mapped colour. */
  readonly lift: Vector3;
  readonly gamma: Vector3;
  readonly gain: Vector3;
  /** Darkening at the screen corners, 0..1. */
  vignette: number;
  /** Strength of the detail restore on flat areas (Medium / High). */
  sharpen: number;
  bloomStrength: number;
  /** Scene brightness (linear) above which a pixel blooms, and the soft knee below it. */
  bloomThreshold: number;
  bloomKnee: number;
  /** Sun-shaft strength (High); 0 turns the term off. */
  shaftStrength: number;
  /** Unit vector toward the sun, world space. The world lighting sets it per map. */
  readonly sunDirection: Vector3;
}

/**
 * Golden-hour grade: shadows lean cool violet-blue, highlights lean warm, a little extra
 * saturation. Small numbers: the sky and materials carry the palette, the grade only ties
 * them together.
 */
export function createPostSettings(): PostSettings {
  return {
    exposure: 1.0,
    saturation: 1.08,
    lift: new Vector3(0.004, 0.006, 0.02),
    gamma: new Vector3(1.0, 0.985, 0.97),
    gain: new Vector3(1.03, 1.0, 0.95),
    vignette: 0.26,
    sharpen: 0.55,
    bloomStrength: 0.32,
    bloomThreshold: 2.6,
    bloomKnee: 0.9,
    shaftStrength: 0.4,
    sunDirection: new Vector3(0.95, 0.31, 0).normalize(),
  };
}

/**
 * The settings of the app's one post pass. A module-level object so the world lighting can
 * write the sun without being handed the renderer; `GameRenderer.post.settings` is the same
 * object.
 */
export const POST_SETTINGS: PostSettings = createPostSettings();

/** Live numbers for the perf HUD. Mutated in place. */
export interface PostStats {
  /** Pixels the scene is drawn at this frame (the dynamic-resolution viewport). */
  readonly sceneWidth: number;
  readonly sceneHeight: number;
  /** Full-screen draw calls the post added this frame. */
  readonly passes: number;
  /** True when the scene target is half-float. */
  readonly hdr: boolean;
}

interface MutablePostStats {
  sceneWidth: number;
  sceneHeight: number;
  passes: number;
  hdr: boolean;
}

export interface PostPipeline {
  readonly settings: PostSettings;
  readonly stats: PostStats;
  readonly plan: PostPlan;
  /** Switches the shader variant and (re)allocates the targets. Not per frame. */
  setPreset(preset: QualityPreset): void;
  /**
   * Output size in drawing-buffer pixels and the current render scale. Cheap when nothing
   * changed; reallocates only when the output size changes.
   */
  setSize(outputWidth: number, outputHeight: number, renderScale: number): void;
  /** Draws `scene` through the post pass to the canvas: `renderScene` then `composite`. */
  render(scene: Object3D, camera: Camera): void;
  /** Only the scene into the HDR target (shadow pass included). */
  renderScene(scene: Object3D, camera: Camera): void;
  /**
   * Only the post passes, from the scene target as it is, onto the canvas. `camera` places the
   * sun for the shafts. Separate so the cost of the post can be measured on its own.
   */
  composite(camera: Camera): void;
  /**
   * Compiles the programs `scene` will be drawn with, without drawing it. With the scene target
   * bound: three.js keys a program on the output colour space, which is linear for the HDR
   * target and sRGB for the canvas, so compiling against the canvas builds programs that are
   * never used. Resolves when the GPU has linked them (KHR_parallel_shader_compile), so a
   * loading screen can wait without a frozen frame. Objects that are not `visible` are skipped.
   */
  precompile(scene: Object3D, camera: Camera): Promise<void>;
  dispose(): void;
}

function noop(): void {}

function createFullscreenTriangle(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  return geometry;
}

function fullscreenMaterial(name: string, fragmentShader: string): ShaderMaterial {
  return new ShaderMaterial({
    name,
    vertexShader: POST_VERTEX_SHADER,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    blending: NoBlending,
    fog: false,
    toneMapped: false,
  });
}

/** True when a half-float colour target can be rendered to. */
function supportsHalfFloatTarget(webgl: WebGLRenderer): boolean {
  return (
    webgl.extensions.has('EXT_color_buffer_float') ||
    webgl.extensions.has('EXT_color_buffer_half_float')
  );
}

function setNumber(uniform: { value: unknown } | undefined, value: number): void {
  if (uniform !== undefined) uniform.value = value;
}

class PostPipelineImpl implements PostPipeline {
  readonly settings: PostSettings;
  readonly stats: PostStats;
  plan: PostPlan;

  private readonly webgl: WebGLRenderer;
  private readonly hdr: boolean;
  private readonly mutableStats: MutablePostStats;
  private readonly sceneTarget: WebGLRenderTarget;
  private readonly bloomTargets: WebGLRenderTarget[] = [];
  private readonly geometry = createFullscreenTriangle();
  private readonly camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly compositeMaterial: ShaderMaterial;
  private readonly prefilter: ShaderMaterial;
  private readonly blurDown: ShaderMaterial;
  private readonly blurUp: ShaderMaterial;
  private readonly mesh: Mesh<BufferGeometry, ShaderMaterial>;
  private readonly rect = new Vector4(1, 1, 1, 1);
  private readonly texel = new Vector2(1, 1);
  private readonly sun = new Vector4(0.5, 0.5, 0, 0);
  private readonly vignette = new Vector3(0, 1, 0.5);
  private readonly invGamma = new Vector3(1, 1, 1);
  private readonly threshold = new Vector2(1, 0.5);
  private readonly blurOffset = new Vector2();
  private readonly scratch = new Vector3();
  private readonly scratchForward = new Vector3();

  private outputWidth = 1;
  private outputHeight = 1;
  private maxScale = 1;
  private scale = 1;
  /** Allocated scene target size (at `maxScale`). */
  private allocWidth = 1;
  private allocHeight = 1;

  constructor(webgl: WebGLRenderer, preset: QualityPreset, settings: PostSettings) {
    this.webgl = webgl;
    this.settings = settings;
    this.hdr = supportsHalfFloatTarget(webgl);
    this.mutableStats = { sceneWidth: 1, sceneHeight: 1, passes: 1, hdr: this.hdr };
    this.stats = this.mutableStats;
    this.plan = postPlanFor(preset);
    this.maxScale = preset.renderScaleMax;

    this.sceneTarget = this.createTarget('PostScene', true);
    // Only a part of the target is drawn and read; the scissor keeps the clear to that part.
    this.sceneTarget.scissorTest = true;

    this.compositeMaterial = fullscreenMaterial('PostComposite', COMPOSITE_FRAGMENT_SHADER);
    this.compositeMaterial.uniforms = {
      tScene: { value: this.sceneTarget.texture },
      tBloom: { value: null },
      uRect: { value: this.rect },
      uTexel: { value: this.texel },
      uExposure: { value: settings.exposure },
      uSharpen: { value: settings.sharpen },
      uLift: { value: settings.lift },
      uInvGamma: { value: this.invGamma },
      uGain: { value: settings.gain },
      uSaturation: { value: settings.saturation },
      uVignette: { value: this.vignette },
      uBloomStrength: { value: settings.bloomStrength },
      uSun: { value: this.sun },
    };
    this.prefilter = fullscreenMaterial('PostBloomPrefilter', BLOOM_PREFILTER_FRAGMENT_SHADER);
    this.prefilter.uniforms = {
      tSource: { value: this.sceneTarget.texture },
      uRect: { value: this.rect },
      uTexel: { value: this.texel },
      uThreshold: { value: this.threshold },
    };
    this.blurDown = fullscreenMaterial('PostBloomDown', BLOOM_BLUR_FRAGMENT_SHADER);
    this.blurDown.uniforms = {
      tSource: { value: null },
      uOffset: { value: this.blurOffset },
      uGain: { value: 1 },
    };
    this.blurUp = fullscreenMaterial('PostBloomUp', BLOOM_BLUR_FRAGMENT_SHADER);
    this.blurUp.blending = AdditiveBlending;
    this.blurUp.uniforms = {
      tSource: { value: null },
      uOffset: { value: this.blurOffset },
      uGain: { value: 1 },
    };

    this.mesh = new Mesh(this.geometry, this.compositeMaterial);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;

    this.applyPlan();
  }

  setPreset(preset: QualityPreset): void {
    this.plan = postPlanFor(preset);
    this.maxScale = preset.renderScaleMax;
    this.applyPlan();
    this.allocate();
  }

  setSize(outputWidth: number, outputHeight: number, renderScale: number): void {
    const width = outputWidth >= 1 ? Math.floor(outputWidth) : 1;
    const height = outputHeight >= 1 ? Math.floor(outputHeight) : 1;
    const resized = width !== this.outputWidth || height !== this.outputHeight;
    this.outputWidth = width;
    this.outputHeight = height;
    // A scale pinned above the preset's bound (never by the scaler itself) grows the target.
    const grow = renderScale > this.maxScale;
    if (grow) this.maxScale = renderScale;
    this.scale = renderScale;
    if (resized || grow) this.allocate();
    else this.applyScale();
  }

  render(scene: Object3D, camera: Camera): void {
    this.renderScene(scene, camera);
    this.composite(camera);
  }

  renderScene(scene: Object3D, camera: Camera): void {
    this.webgl.setRenderTarget(this.sceneTarget);
    this.webgl.render(scene, camera);
  }

  precompile(scene: Object3D, camera: Camera): Promise<void> {
    const webgl = this.webgl;
    const previous = webgl.getRenderTarget();
    webgl.setRenderTarget(this.sceneTarget);
    // The program keys are taken synchronously inside the call; the promise is only the wait
    // for the driver, so the target can go back at once.
    const done = webgl.compileAsync(scene, camera);
    webgl.setRenderTarget(previous);
    return done.then(noop, noop);
  }

  composite(camera: Camera): void {
    const webgl = this.webgl;
    const settings = this.settings;
    const plan = this.plan;

    const mesh = this.mesh;
    const autoClear = webgl.autoClear;
    // Every post pass covers its whole target: clearing first would be wasted fill.
    webgl.autoClear = false;

    if (plan.bloomLevels > 0) {
      const targets = this.bloomTargets;
      const first = targets[0];
      if (first !== undefined) {
        this.threshold.set(settings.bloomThreshold, settings.bloomKnee);
        mesh.material = this.prefilter;
        webgl.setRenderTarget(first);
        webgl.render(mesh, this.camera);

        const down = this.blurDown;
        const downSource = down.uniforms['tSource'];
        mesh.material = down;
        for (let i = 1; i < plan.bloomLevels; i++) {
          const source = targets[i - 1];
          const target = targets[i];
          if (source === undefined || target === undefined || downSource === undefined) continue;
          downSource.value = source.texture;
          this.blurOffset.set(1 / source.width, 1 / source.height);
          webgl.setRenderTarget(target);
          webgl.render(mesh, this.camera);
        }

        const up = this.blurUp;
        const upSource = up.uniforms['tSource'];
        mesh.material = up;
        for (let i = plan.bloomLevels - 1; i >= 1; i--) {
          const source = targets[i];
          const target = targets[i - 1];
          if (source === undefined || target === undefined || upSource === undefined) continue;
          upSource.value = source.texture;
          // Half a source texel: the four bilinear taps make a smooth tent.
          this.blurOffset.set(0.5 / source.width, 0.5 / source.height);
          webgl.setRenderTarget(target);
          webgl.render(mesh, this.camera);
        }
      }
      if (plan.sunShafts) this.placeSun(camera);
    }

    const uniforms = this.compositeMaterial.uniforms;
    setNumber(uniforms['uExposure'], settings.exposure);
    setNumber(uniforms['uSharpen'], settings.sharpen);
    setNumber(uniforms['uSaturation'], settings.saturation);
    setNumber(uniforms['uBloomStrength'], settings.bloomStrength);
    const gamma = settings.gamma;
    this.invGamma.set(1 / gamma.x, 1 / gamma.y, 1 / gamma.z);
    this.vignette.x = settings.vignette;

    mesh.material = this.compositeMaterial;
    webgl.setRenderTarget(null);
    webgl.render(mesh, this.camera);
    webgl.autoClear = autoClear;
  }

  dispose(): void {
    this.sceneTarget.dispose();
    for (const target of this.bloomTargets) target.dispose();
    this.bloomTargets.length = 0;
    this.geometry.dispose();
    this.compositeMaterial.dispose();
    this.prefilter.dispose();
    this.blurDown.dispose();
    this.blurUp.dispose();
  }

  /** Sun position on screen and how strongly the shafts show (0 when it is out of view). */
  private placeSun(camera: Camera): void {
    const dir = this.settings.sunDirection;
    const forward = camera.getWorldDirection(this.scratchForward);
    const facing = forward.dot(dir);
    if (!(facing > 0.05) || !(this.settings.shaftStrength > 0)) {
      this.sun.z = 0;
      return;
    }
    const e = camera.matrixWorld.elements;
    const p = this.scratch
      .set((e[12] ?? 0) + dir.x * 1000, (e[13] ?? 0) + dir.y * 1000, (e[14] ?? 0) + dir.z * 1000)
      .project(camera);
    // Fades out as the sun leaves the screen (fully gone half a screen outside).
    const outside = Math.max(Math.abs(p.x), Math.abs(p.y)) - 1;
    const onScreen = outside <= 0 ? 1 : outside >= 0.5 ? 0 : 1 - outside * 2;
    const front = facing >= 0.35 ? 1 : (facing - 0.05) / 0.3;
    this.sun.set(
      p.x * 0.5 + 0.5,
      p.y * 0.5 + 0.5,
      this.settings.shaftStrength * onScreen * front,
      0,
    );
  }

  private createTarget(name: string, depth: boolean): WebGLRenderTarget {
    const target = new WebGLRenderTarget(1, 1, {
      type: this.hdr ? HalfFloatType : UnsignedByteType,
      format: RGBAFormat,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: depth,
      stencilBuffer: false,
      samples: 0,
    });
    target.texture.name = name;
    // 8-bit fallback: sRGB8 storage spends its few bits where the eye needs them; the GPU
    // converts on write and on read, so shaders see linear values either way.
    if (!this.hdr) target.texture.colorSpace = SRGBColorSpace;
    return target;
  }

  private applyPlan(): void {
    const plan = this.plan;
    const defines: Record<string, string> = {};
    if (plan.fxaa) defines['POST_FXAA'] = '';
    if (plan.grade) defines['POST_GRADE'] = '';
    if (plan.vignette) defines['POST_VIGNETTE'] = '';
    if (plan.bloomLevels > 0) defines['POST_BLOOM'] = '';
    if (plan.sunShafts) defines['POST_SHAFTS'] = '';
    this.compositeMaterial.defines = defines;
    this.compositeMaterial.needsUpdate = true;
    this.mutableStats.passes = plan.passes;

    while (this.bloomTargets.length > plan.bloomLevels) this.bloomTargets.pop()?.dispose();
    while (this.bloomTargets.length < plan.bloomLevels) {
      this.bloomTargets.push(this.createTarget(`PostBloom${this.bloomTargets.length}`, false));
    }
    const bloom = this.compositeMaterial.uniforms['tBloom'];
    if (bloom !== undefined) bloom.value = this.bloomTargets[0]?.texture ?? null;
  }

  /** Sizes every target for the current output size and largest scale. */
  private allocate(): void {
    const width = scaledSize(this.outputWidth, this.maxScale);
    const height = scaledSize(this.outputHeight, this.maxScale);
    if (width !== this.allocWidth || height !== this.allocHeight) {
      this.allocWidth = width;
      this.allocHeight = height;
      this.sceneTarget.setSize(width, height);
    }
    const plan = this.plan;
    for (let i = 0; i < this.bloomTargets.length; i++) {
      const target = this.bloomTargets[i];
      if (target === undefined) continue;
      const w = bloomLevelSize(width, plan.bloomScale, i);
      const h = bloomLevelSize(height, plan.bloomScale, i);
      if (target.width !== w || target.height !== h) target.setSize(w, h);
    }
    this.applyScale();
  }

  /** Points the scene viewport and the readers at the current scale's sub-rectangle. */
  private applyScale(): void {
    const width = Math.min(scaledSize(this.outputWidth, this.scale), this.allocWidth);
    const height = Math.min(scaledSize(this.outputHeight, this.scale), this.allocHeight);
    this.sceneTarget.viewport.set(0, 0, width, height);
    this.sceneTarget.scissor.set(0, 0, width, height);
    this.rect.set(
      width / this.allocWidth,
      height / this.allocHeight,
      // Half a texel inside the edge: bilinear taps never reach the undrawn part.
      (width - 0.5) / this.allocWidth,
      (height - 0.5) / this.allocHeight,
    );
    this.texel.set(1 / this.allocWidth, 1 / this.allocHeight);
    const aspect = this.outputWidth / this.outputHeight;
    this.vignette.y = aspect;
    this.vignette.z = 1 / (aspect * aspect + 1);
    this.mutableStats.sceneWidth = width;
    this.mutableStats.sceneHeight = height;
  }
}

/** `settings` defaults to the app-wide `POST_SETTINGS`. */
export function createPostPipeline(
  webgl: WebGLRenderer,
  preset: QualityPreset,
  settings: PostSettings = POST_SETTINGS,
): PostPipeline {
  return new PostPipelineImpl(webgl, preset, settings);
}
