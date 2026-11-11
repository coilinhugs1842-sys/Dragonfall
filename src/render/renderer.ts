/**
 * The app's one WebGLRenderer (docs/ARCHITECTURE.md: "one WebGLRenderer for its whole life"),
 * wrapped so quality presets and the dynamic render scale are applied in a single place.
 */
import { NoToneMapping, PCFShadowMap, SRGBColorSpace, WebGLRenderer } from 'three';
import type { Camera, Scene } from 'three';
import { QUALITY_PRESETS } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import { DynamicResolution } from './dynamic-resolution';
import { createPostPipeline } from './post';
import type { PostPipeline } from './post';
import { computePixelRatio } from './render-scale';

/** Thrown by `createGameRenderer` when no WebGL2 context can be created; main shows a fallback. */
export class WebGL2UnavailableError extends Error {
  override readonly name = 'WebGL2UnavailableError';

  constructor(message = 'WebGL2 is not available in this browser or on this GPU.') {
    super(message);
  }
}

/** Live numbers for the perf HUD. One object, mutated in place: read it, do not keep copies. */
export interface RenderStats {
  /** Current dynamic render scale (fraction of the 1080p-referenced target). */
  readonly renderScale: number;
  /**
   * Pixel ratio handed to three.js: drawing buffer = floor(css size * pixelRatio). The canvas
   * is always at display size (1080 lines at most); the render scale sizes the scene target.
   */
  readonly pixelRatio: number;
  /** The canvas drawing buffer: what the post pass writes. */
  readonly bufferWidth: number;
  readonly bufferHeight: number;
  /** Pixels the scene itself is drawn at this frame: buffer size * render scale. */
  readonly sceneWidth: number;
  readonly sceneHeight: number;
  /** Full-screen draw calls the post pass adds to every frame (1 on Low / Medium). */
  readonly postPasses: number;
  /** True when the scene target is half-float HDR, false on the 8-bit fallback. */
  readonly hdr: boolean;
  /** True between webglcontextlost and webglcontextrestored; `render` is a no-op meanwhile. */
  readonly contextLost: boolean;
}

export interface GameRenderer {
  /** The one renderer for the app's life. */
  readonly webgl: WebGLRenderer;
  readonly resolution: DynamicResolution;
  /** The post pass: `post.settings` holds exposure, grade, vignette, bloom and the sun. */
  readonly post: PostPipeline;
  readonly presetId: QualityPresetId;
  readonly stats: RenderStats;
  /**
   * Applies the preset's renderer settings and render-scale bounds, resets the scaler, then
   * tells every `onPresetChange` listener (the active scene forwards it to its views).
   */
  setPreset(id: QualityPresetId): void;
  /**
   * Subscribes to `setPreset` calls, whoever makes them (debug GUI, Settings menu, automatic
   * pick). Scenes use it to run `setQuality` on their views. Returns the unsubscribe function.
   */
  onPresetChange(listener: PresetChangeListener): () => void;
  /**
   * Call on window resize / DPR change. CSS sizes the canvas; this sizes the drawing buffer.
   * The new size takes effect at the start of the next `render`: resizing clears the buffer,
   * and a ResizeObserver callback runs after that frame was drawn but before it is shown.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void;
  /**
   * Feeds `frameMs` (previous frame's duration) to the scaler, then draws the scene into the
   * HDR target and the post pass onto the canvas.
   */
  render(scene: Scene, camera: Camera, frameMs: number): void;
  /**
   * Compiles every program `scene` needs as it stands (visible objects only), against the
   * target the scene is really drawn into. Resolves when they are linked; never rejects.
   * Load-time: call it behind a loading screen or a cinematic, not in the frame loop.
   */
  precompile(scene: Scene, camera: Camera): Promise<void>;
  dispose(): void;
}

export type PresetChangeListener = (id: QualityPresetId) => void;

interface MutableStats {
  renderScale: number;
  pixelRatio: number;
  bufferWidth: number;
  bufferHeight: number;
  sceneWidth: number;
  sceneHeight: number;
  postPasses: number;
  hdr: boolean;
  contextLost: boolean;
}

class GameRendererImpl implements GameRenderer {
  readonly webgl: WebGLRenderer;
  readonly resolution = new DynamicResolution();
  readonly post: PostPipeline;
  readonly stats: RenderStats;

  private readonly mutableStats: MutableStats = {
    renderScale: 1,
    pixelRatio: 1,
    bufferWidth: 0,
    bufferHeight: 0,
    sceneWidth: 0,
    sceneHeight: 0,
    postPasses: 1,
    hdr: false,
    contextLost: false,
  };
  private readonly canvas: HTMLCanvasElement;
  private currentPresetId: QualityPresetId;
  private cssWidth = 1;
  private cssHeight = 1;
  private devicePixelRatio = 1;
  // What three.js currently has, so the drawing buffer is only touched on a real change.
  private appliedWidth = -1;
  private appliedHeight = -1;
  private appliedPixelRatio = -1;
  /** `resize` was called since the last `applyResolution`. */
  private resizePending = false;
  /** Replaced, never mutated, so a listener may unsubscribe while being called. */
  private presetListeners: readonly PresetChangeListener[] = [];

  constructor(canvas: HTMLCanvasElement, context: WebGL2RenderingContext, id: QualityPresetId) {
    this.canvas = canvas;
    this.stats = this.mutableStats;
    this.currentPresetId = id;

    this.webgl = new WebGLRenderer({ canvas, context, ...CONTEXT_ATTRIBUTES });
    this.webgl.outputColorSpace = SRGBColorSpace;
    // Tone mapping (filmic, docs/ART_DIRECTION.md lighting recipe) and the sRGB transfer happen
    // in the post pass on every preset: the scene is drawn linear into the HDR target, where
    // three.js never tone-maps. Nothing but the post pass draws to the canvas.
    this.webgl.toneMapping = NoToneMapping;
    this.webgl.toneMappingExposure = 1.0;
    // PCFSoftShadowMap was removed from three.js; PCF is the cheapest filtered option.
    this.webgl.shadowMap.type = PCFShadowMap;
    // A frame will be several render() calls once shadows and the post pass exist. With the
    // default autoReset the perf HUD would only see the last call, so `render` resets the
    // counters once per frame instead and renderer.info holds whole-frame totals.
    this.webgl.info.autoReset = false;
    this.post = createPostPipeline(this.webgl, QUALITY_PRESETS[id]);
    this.mutableStats.hdr = this.post.stats.hdr;

    canvas.addEventListener('webglcontextlost', this.onContextLost);
    canvas.addEventListener('webglcontextrestored', this.onContextRestored);

    this.setPreset(id);
  }

  get presetId(): QualityPresetId {
    return this.currentPresetId;
  }

  setPreset(id: QualityPresetId): void {
    const preset = QUALITY_PRESETS[id];
    this.currentPresetId = id;
    // Only the on/off switch lives here; the map size and which objects cast are set on the
    // sun light and the meshes by the world/dragon modules from the same preset.
    this.webgl.shadowMap.enabled = preset.shadowMapSize > 0;
    this.resolution.setBounds(preset.renderScaleMin, preset.renderScaleMax);
    this.resolution.reset();
    this.post.setPreset(preset);
    this.applyResolution();
    for (const listener of this.presetListeners) listener(id);
  }

  onPresetChange(listener: PresetChangeListener): () => void {
    this.presetListeners = [...this.presetListeners, listener];
    return () => {
      this.presetListeners = this.presetListeners.filter((l) => l !== listener);
    };
  }

  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    // A hidden or collapsed canvas reports 0; three.js needs at least one pixel.
    this.cssWidth = cssWidth >= 1 ? Math.floor(cssWidth) : 1;
    this.cssHeight = cssHeight >= 1 ? Math.floor(cssHeight) : 1;
    this.devicePixelRatio = devicePixelRatio > 0 ? devicePixelRatio : 1;
    // Not applied here: see the interface comment.
    this.resizePending = true;
  }

  render(scene: Scene, camera: Camera, frameMs: number): void {
    // Drawing with a lost context only produces GL errors; the scaler would also read garbage.
    if (this.mutableStats.contextLost) return;
    // Also picks up a scale pinned from the debug GUI through resolution.setScale().
    if (
      this.resolution.update(frameMs) ||
      this.resizePending ||
      this.resolution.scale !== this.mutableStats.renderScale
    ) {
      this.applyResolution();
    }
    this.webgl.info.reset();
    this.post.render(scene, camera);
  }

  precompile(scene: Scene, camera: Camera): Promise<void> {
    if (this.mutableStats.contextLost) return Promise.resolve();
    return this.post.precompile(scene, camera);
  }

  dispose(): void {
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.post.dispose();
    this.webgl.dispose();
  }

  /**
   * Pushes the css size to three.js (only when it changed) and the render scale to the post
   * pass. The canvas stays at display size; a scale step only moves the scene viewport.
   */
  private applyResolution(): void {
    this.resizePending = false;
    const scale = this.resolution.scale;
    const pixelRatio = computePixelRatio(this.cssHeight, this.devicePixelRatio, 1);

    // One call for size and ratio together: setPixelRatio followed by setSize would reallocate
    // the drawing buffer twice whenever both change (every resize of a window taller than 1080
    // lines, where the ratio depends on the height). It never touches the canvas's CSS size,
    // which the stylesheet owns.
    if (
      this.cssWidth !== this.appliedWidth ||
      this.cssHeight !== this.appliedHeight ||
      pixelRatio !== this.appliedPixelRatio
    ) {
      this.webgl.setDrawingBufferSize(this.cssWidth, this.cssHeight, pixelRatio);
    }

    this.appliedWidth = this.cssWidth;
    this.appliedHeight = this.cssHeight;
    this.appliedPixelRatio = pixelRatio;
    this.post.setSize(this.canvas.width, this.canvas.height, scale);

    const stats = this.mutableStats;
    stats.renderScale = scale;
    stats.pixelRatio = pixelRatio;
    stats.bufferWidth = this.canvas.width;
    stats.bufferHeight = this.canvas.height;
    stats.sceneWidth = this.post.stats.sceneWidth;
    stats.sceneHeight = this.post.stats.sceneHeight;
    stats.postPasses = this.post.stats.passes;
  }

  private readonly onContextLost = (event: Event): void => {
    // Without preventDefault the browser never fires webglcontextrestored.
    event.preventDefault();
    this.mutableStats.contextLost = true;
  };

  private readonly onContextRestored = (): void => {
    // three.js re-creates its GL state in its own listener; frame times from before the loss
    // say nothing about the fresh context.
    this.mutableStats.contextLost = false;
    this.resolution.reset();
    this.applyResolution();
  };
}

/**
 * antialias off: the post pass does FXAA (Medium / High) and MSAA costs too much at these
 * budgets. No alpha (the canvas is opaque behind the HTML UI) and no stencil (nothing uses it):
 * both save memory and bandwidth on shared-memory integrated GPUs.
 */
const CONTEXT_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  powerPreference: 'high-performance',
  // Software rendering is unplayable, but a slow picture beats the fallback page; the
  // automatic quality pick deals with it.
  failIfMajorPerformanceCaveat: false,
};

/**
 * Creates the app's single renderer on `canvas`.
 * @throws WebGL2UnavailableError when the browser or GPU cannot provide a WebGL2 context.
 */
export function createGameRenderer(
  canvas: HTMLCanvasElement,
  presetId: QualityPresetId,
): GameRenderer {
  // Asked for here rather than left to three.js so the failure is a typed, catchable error.
  let context: WebGL2RenderingContext | null = null;
  try {
    context = canvas.getContext('webgl2', CONTEXT_ATTRIBUTES);
  } catch {
    context = null;
  }
  if (context === null) throw new WebGL2UnavailableError();
  return new GameRendererImpl(canvas, context, presetId);
}
