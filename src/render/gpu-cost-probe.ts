/**
 * GPU time of a frame's draw, for the automatic quality pick (src/game/auto-quality.ts).
 *
 * Frame time cannot rank machines: vsync holds every machine that is fast enough at the
 * display's rate. A timer query (`EXT_disjoint_timer_query_webgl2`) measures how long the GPU
 * itself worked on what was drawn between `begin` and `end`, whatever the display does. The
 * result is ready a frame or two later and is read without blocking; nothing here stalls the
 * pipeline the way `readPixels` or `finish` would.
 *
 * While the probe is active the renderer holds the render scale at `scale` (dynamic resolution
 * would hide the cost) and draws the scene `repeats` times inside the query (one title draw is
 * too light to measure a machine by). See `GameRenderer.render`.
 *
 * Only one timer query can be open on a context. The perf HUD's GPU graph (stats-gl) uses the
 * same extension, so the HUD skips its own timing while `active` is true, and `begin` checks
 * for a stranger's open query rather than raise a GL error.
 *
 * Not available everywhere (Firefox and Safari do not expose the extension): `supported` says.
 */

// Constants of EXT_disjoint_timer_query_webgl2 (the extension has no TypeScript typings).
const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

/** Queries in flight at once. Results arrive a frame or two late, so a few are enough. */
const POOL_SIZE = 8;
const NS_PER_MS = 1_000_000;

export interface RenderCostProbe {
  /** The browser has the timer extension. Without it `take` never returns a time. */
  readonly supported: boolean;
  /** Between `start` and `stop`: the renderer holds the scale and repeats the draw. */
  readonly active: boolean;
  /** The render scale held while active. */
  readonly scale: number;
  /** Scene draws per rendered frame while active. */
  readonly repeats: number;
  start(scale: number, repeats: number): void;
  stop(): void;
  /**
   * The GPU time in ms of one finished frame, oldest first, or -1 when none is ready. Call it
   * once a frame. Times of frames drawn before `start` can still arrive after it (they were in
   * flight): the caller discards its first frames, see `AUTO_QUALITY_TUNING.warmupFrames`.
   */
  take(): number;
}

export class GpuCostProbe implements RenderCostProbe {
  readonly supported: boolean;
  active = false;
  scale = 1;
  repeats = 1;

  private readonly gl: WebGL2RenderingContext;
  /** Created on first use; emptied when the context is lost (its queries die with it). */
  private readonly queries: WebGLQuery[] = [];
  /** Ring over `queries`: `pending` queries starting at `head` wait for their result. */
  private head = 0;
  private pending = 0;
  /** One of ours is open between `begin` and `end`. */
  private open = false;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    let extension: unknown = null;
    try {
      extension = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    } catch {
      extension = null;
    }
    this.supported = extension !== null && extension !== undefined;
  }

  start(scale: number, repeats: number): void {
    this.scale = scale > 0 ? scale : 1;
    this.repeats = repeats >= 1 ? Math.floor(repeats) : 1;
    this.active = true;
  }

  stop(): void {
    this.active = false;
  }

  /** Before the frame's draws. Allocation-free once the pool exists. */
  begin(): void {
    if (!this.supported || !this.active || this.open || this.pending >= POOL_SIZE) return;
    const gl = this.gl;
    // Somebody else is timing (a GPU profiler): two open queries would be a GL error.
    if (gl.getQuery(TIME_ELAPSED_EXT, gl.CURRENT_QUERY) !== null) return;
    const index = (this.head + this.pending) % POOL_SIZE;
    let query = this.queries[index];
    if (query === undefined) {
      const created = gl.createQuery();
      if (created === null) return;
      query = created;
      this.queries[index] = query;
    }
    gl.beginQuery(TIME_ELAPSED_EXT, query);
    this.open = true;
  }

  /** After the frame's draws. */
  end(): void {
    if (!this.open) return;
    const gl = this.gl;
    gl.endQuery(TIME_ELAPSED_EXT);
    // Send the frame's commands on their way now. Without this the tail of them (and with it
    // the end of the query) can sit in a buffer for 2-3 ms before the GPU sees it, and that
    // wait is counted: measured on the dev desktop, eight small title draws read 2.9 ms
    // without the flush and 0.75 ms with it. `flush` does not wait for the GPU.
    gl.flush();
    this.open = false;
    this.pending++;
  }

  take(): number {
    if (this.pending === 0) return -1;
    const gl = this.gl;
    const query = this.queries[this.head];
    if (query === undefined) return -1;
    if (gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) !== true) return -1;
    const nanoseconds: unknown = gl.getQueryParameter(query, gl.QUERY_RESULT);
    // Reading the flag clears it. Set = the GPU's clock was disturbed (power state change,
    // another process) while a query ran, and this result cannot be trusted.
    const disjoint = gl.getParameter(GPU_DISJOINT_EXT) === true;
    this.head = (this.head + 1) % POOL_SIZE;
    this.pending--;
    if (disjoint || typeof nanoseconds !== 'number') return -1;
    return nanoseconds / NS_PER_MS;
  }

  /** The context was lost and restored: the old query objects no longer exist. */
  contextRestored(): void {
    this.queries.length = 0;
    this.head = 0;
    this.pending = 0;
    this.open = false;
  }

  dispose(): void {
    this.active = false;
    if (this.open) this.end();
    for (const query of this.queries) this.gl.deleteQuery(query);
    this.queries.length = 0;
    this.head = 0;
    this.pending = 0;
  }
}
