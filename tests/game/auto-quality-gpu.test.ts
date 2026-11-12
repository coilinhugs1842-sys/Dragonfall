import { describe, expect, it } from 'vitest';
import { isSoftwareRenderer, readGpuName, shortGpuName } from '../../src/render/gpu-info';

const RENDERER = 0x1f01;
const UNMASKED_RENDERER_WEBGL = 0x9246;

interface FakeGl {
  readonly gl: WebGL2RenderingContext;
  /** `getExtension` calls, by name. */
  readonly asked: string[];
}

/** A context that answers `RENDERER` with `plain` and the debug extension with `unmasked`. */
function fakeGl(plain: unknown, unmasked: unknown, hasExtension = true): FakeGl {
  const asked: string[] = [];
  const gl = {
    RENDERER,
    getParameter(name: number): unknown {
      if (name === RENDERER) return plain;
      if (name === UNMASKED_RENDERER_WEBGL) return unmasked;
      return null;
    },
    getExtension(name: string): unknown {
      asked.push(name);
      return hasExtension && name === 'WEBGL_debug_renderer_info'
        ? { UNMASKED_RENDERER_WEBGL }
        : null;
    },
  };
  // Only the three members above are used: a whole WebGL2 context is not worth faking.
  return { gl: gl as unknown as WebGL2RenderingContext, asked };
}

const INTEL = 'ANGLE (Intel, Intel(R) Graphics (0x00007D45) Direct3D11 vs_5_0 ps_5_0, D3D11)';

describe('readGpuName', () => {
  it('reads the unmasked name where the plain one is masked (Chromium)', () => {
    expect(readGpuName(fakeGl('WebKit WebGL', INTEL).gl)).toBe(INTEL);
    expect(readGpuName(fakeGl('', INTEL).gl)).toBe(INTEL);
    expect(readGpuName(fakeGl('Mozilla', INTEL).gl)).toBe(INTEL);
  });

  it('uses the plain name when it already says the GPU, without touching the extension', () => {
    // Firefox answers RENDERER properly and warns in the console when the extension is used.
    const firefox = fakeGl('ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)', 'x');
    expect(readGpuName(firefox.gl)).toBe(
      'ANGLE (Intel, Intel(R) HD Graphics Direct3D11 vs_5_0 ps_5_0)',
    );
    expect(firefox.asked).toEqual([]);
  });

  it('falls back to what there is', () => {
    expect(readGpuName(fakeGl('WebKit WebGL', '', true).gl)).toBe('WebKit WebGL');
    expect(readGpuName(fakeGl('WebKit WebGL', INTEL, false).gl)).toBe('WebKit WebGL');
    expect(readGpuName(fakeGl(null, null, false).gl)).toBe('unknown');
    expect(readGpuName(fakeGl('', 42).gl)).toBe('unknown');
  });

  it('never throws', () => {
    const lost = {
      RENDERER,
      getParameter(): unknown {
        throw new Error('context lost');
      },
      getExtension(): unknown {
        throw new Error('context lost');
      },
    };
    expect(readGpuName(lost as unknown as WebGL2RenderingContext)).toBe('unknown');
  });
});

describe('isSoftwareRenderer', () => {
  it.each([
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader',
    'llvmpipe (LLVM 15.0.7, 256 bits)',
    'softpipe',
    'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Mesa Software Rasterizer',
  ])('knows %s', (name) => {
    expect(isSoftwareRenderer(name)).toBe(true);
  });

  it.each([
    INTEL,
    'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)',
    'Apple M2',
    'Mesa Intel(R) Xe Graphics (TGL GT2)',
    'unknown',
    '',
  ])('does not take %s for one', (name) => {
    expect(isSoftwareRenderer(name)).toBe(false);
  });
});

describe('shortGpuName', () => {
  it('keeps the model of an ANGLE name', () => {
    expect(shortGpuName(INTEL)).toBe('Intel(R) Graphics');
    expect(
      shortGpuName(
        'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER (0x000021C4) Direct3D11 vs_5_0 ps_5_0, D3D11)',
      ),
    ).toBe('NVIDIA GeForce GTX 1660 SUPER');
  });

  it('leaves other names as they are', () => {
    expect(shortGpuName('Apple M2')).toBe('Apple M2');
    expect(shortGpuName('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(
      'llvmpipe (LLVM 15.0.7, 256 bits)',
    );
    expect(shortGpuName('unknown')).toBe('unknown');
  });
});
