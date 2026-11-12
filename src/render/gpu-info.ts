/**
 * The name of the GPU the page got, for the automatic quality pick's console line, the perf HUD
 * and bug reports (docs/PERFORMANCE.md, "Automatic quality pick"). Read once per renderer:
 * `GameRenderer.gpuName`.
 */

/** What Chromium and WebKit answer for `RENDERER` instead of the real name. */
const MASKED_RENDERER = /^(webkit webgl|mozilla)?$/i;

/**
 * Renderers that draw on the CPU: SwiftShader (Chromium without a usable GPU), llvmpipe and
 * softpipe (Mesa), and Windows' "Microsoft Basic Render Driver" (no graphics driver installed).
 */
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|microsoft basic render|software rasterizer/i;

/**
 * The renderer string, e.g. "ANGLE (Intel, Intel(R) Graphics (0x00007D45) Direct3D11 vs_5_0
 * ps_5_0, D3D11)". Never throws; 'unknown' when the browser gives nothing.
 *
 * The plain `RENDERER` is asked first and used when it already names the GPU: Firefox answers
 * it properly and prints a deprecation warning for `WEBGL_debug_renderer_info`, and the project
 * allows no console warnings. Chromium masks it ("WebKit WebGL"), so there the extension is read.
 */
export function readGpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  let plain = '';
  try {
    const value: unknown = gl.getParameter(gl.RENDERER);
    if (typeof value === 'string') plain = value.trim();
    if (!MASKED_RENDERER.test(plain)) return plain;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext !== null) {
      const unmasked: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
      if (typeof unmasked === 'string' && unmasked.trim() !== '') return unmasked.trim();
    }
  } catch {
    // A lost context or a locked-down browser: fall through to what there is.
  }
  return plain === '' ? 'unknown' : plain;
}

/** True for a renderer that draws on the CPU: every preset but Low is out of the question. */
export function isSoftwareRenderer(gpuName: string): boolean {
  return SOFTWARE_RENDERER.test(gpuName);
}

/**
 * The model alone, for a narrow HUD line: "ANGLE (Intel, Intel(R) Graphics (0x00007D45)
 * Direct3D11 vs_5_0 ps_5_0, D3D11)" becomes "Intel(R) Graphics". Anything not in ANGLE's
 * format comes back unchanged.
 */
export function shortGpuName(gpuName: string): string {
  const angle = /^ANGLE \([^,]*, (.+)\)$/.exec(gpuName);
  if (angle === null || angle[1] === undefined) return gpuName;
  // "<model> (0x<device id>) <api and shader models>, <backend>": keep the model.
  const model = angle[1]
    .replace(/,[^,]*$/, '')
    .replace(/ (Direct3D|OpenGL|Vulkan|Metal).*$/, '')
    .replace(/ \(0x[0-9a-f]+\)$/i, '')
    .trim();
  return model === '' ? gpuName : model;
}
