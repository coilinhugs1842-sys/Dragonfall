import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Decoder files that must be reachable by URL at runtime.
 *
 * - KTX2 / Basis: `KTX2Loader` fetches `basis_transcoder.js` + `.wasm` as text/binary and injects
 *   them into a Web Worker, so they cannot be bundled. They are copied to `public/vendor/basis/`
 *   and the loader is pointed there with `setTranscoderPath` (one stable, cacheable URL in dev and
 *   build, instead of three's hashed `new URL(..., import.meta.url)` fallback).
 * - Meshopt: NOT copied. `three/addons/libs/meshopt_decoder.module.js` is an ES module with the
 *   wasm embedded as a string, so it is simply imported and bundled.
 * - Draco: not used (the pipeline is meshopt-only, see docs/ASSET_PIPELINE.md).
 */
const VENDOR_FILES: readonly { from: string; to: string }[] = [
  {
    from: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.js',
    to: 'public/vendor/basis/basis_transcoder.js',
  },
  {
    from: 'node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm',
    to: 'public/vendor/basis/basis_transcoder.wasm',
  },
];

/** True when `to` is missing or no longer matches `from` (e.g. after a three.js upgrade). */
function isStale(from: string, to: string): boolean {
  if (!existsSync(to)) return true;
  const src = statSync(from);
  const dest = statSync(to);
  return src.size !== dest.size || src.mtimeMs > dest.mtimeMs;
}

/**
 * Copies the decoder files from node_modules into `public/vendor/` (git-ignored, generated).
 * Runs in the `config` hook rather than `buildStart` because Vite scans/copies `public/` before
 * `buildStart` fires, so a later copy could be missed on a fresh clone.
 */
function copyVendorDecoders(): Plugin {
  return {
    name: 'dragonfall:copy-vendor-decoders',
    config() {
      for (const file of VENDOR_FILES) {
        const from = resolve(ROOT, file.from);
        const to = resolve(ROOT, file.to);
        if (!existsSync(from)) {
          throw new Error(`[copy-vendor-decoders] missing ${file.from}; did three.js move it?`);
        }
        if (isStale(from, to)) {
          mkdirSync(dirname(to), { recursive: true });
          copyFileSync(from, to);
        }
      }
    },
  };
}

// HTTPS hook (off by default: whether LAN play needs HTTPS is an open Phase 2 question).
// To enable, uncomment the import and the plugin line below, then run with DRAGONFALL_HTTPS=1.
// import basicSsl from '@vitejs/plugin-basic-ssl';
// const httpsPlugins = process.env['DRAGONFALL_HTTPS'] === '1' ? [basicSsl()] : [];

export default defineConfig({
  // Relative base so the same build works at a domain root and under a GitHub Pages sub-path.
  base: './',
  plugins: [
    copyVendorDecoders(),
    // ...httpsPlugins,
  ],
  build: {
    target: 'es2022',
    // Maps are only fetched when devtools are open; they make field bug reports readable.
    sourcemap: true,
    // three alone is larger than Vite's default 500 kB warning threshold.
    chunkSizeWarningLimit: 1024,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // three changes far less often than game code: its own chunk stays browser-cached
          // across deploys.
          groups: [{ name: 'three', test: /node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
  test: {
    // Sim/shared tests are pure TS: no DOM, so the fast node environment is enough.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    passWithNoTests: true,
  },
});
