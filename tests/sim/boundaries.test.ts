/**
 * Golden rule 3 as a test: `src/sim` and `src/net` never import a view module, never use
 * three.js scene objects and never touch the DOM, so they stay runnable in node and in a Web
 * Worker. `src/shared` is held to the same rules, because sim and net import it freely.
 *
 * Imports are checked against an ALLOW-list: a new module or package is rejected until it is
 * added here on purpose. This scans the source text; it does not execute anything, so it will
 * not see a global reached through `globalThis` or a dependency's own imports.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');
const VIEW_MODULES = ['render', 'world', 'dragons', 'vfx', 'cinematics', 'ui', 'audio'];
/** Not view modules, but they own the DOM, the devices or the dev tools all the same. */
const OTHER_FORBIDDEN_MODULES = ['dev', 'game', 'input'];

interface Boundary {
  /** Top-level `src/` directories a relative import may land in. */
  readonly modules: ReadonlySet<string>;
  /** Bare packages besides the math subset of 'three'. */
  readonly packages: ReadonlySet<string>;
}

/** Guarded `src/` directory -> what its files may import. Everything else is a violation. */
const BOUNDARIES: Readonly<Record<string, Boundary>> = {
  shared: { modules: new Set(['shared']), packages: new Set() },
  // three-mesh-bvh: terrain raycasts (docs/ARCHITECTURE.md, "Physics").
  sim: { modules: new Set(['sim', 'shared']), packages: new Set(['three-mesh-bvh']) },
  net: { modules: new Set(['net', 'sim', 'shared']), packages: new Set(['peerjs']) },
};
const GUARDED_DIRS = Object.keys(BOUNDARIES);

/**
 * three.js exports that are plain math with no scene graph or GPU state behind them. Anything
 * else from 'three' (Scene, Object3D, Mesh, materials, the renderer, ...) is a view concern.
 */
const THREE_MATH_ALLOWLIST = new Set([
  'Box3',
  'Euler',
  'Line3',
  'MathUtils',
  'Matrix3',
  'Matrix4',
  'Plane',
  'Quaternion',
  'Ray',
  'Sphere',
  'Triangle',
  'Vector2',
  'Vector3',
  'Vector4',
]);

/**
 * Browser-only globals. The lookbehind skips property names (`zone.window`), and the words that
 * are also everyday identifiers only count in the form that uses the global (`location.href`,
 * `alert(`, `new Image`).
 */
const DOM_GLOBALS = new RegExp(
  '(?<![.\\w$])(' +
    [
      'document',
      'window',
      'localStorage',
      'sessionStorage',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'HTML\\w*Element',
      'navigator(?=\\s*\\.)',
      'location(?=\\s*\\.)',
      'alert(?=\\s*\\()',
      'new\\s+Image',
    ].join('|') +
    ')\\b',
);

interface ImportRef {
  /** Text between `import`/`export` and `from`; empty for side-effect and dynamic imports. */
  clause: string;
  specifier: string;
}

function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

/** Removes comments so prose such as "never touch the document" is not flagged. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

function findImports(code: string): ImportRef[] {
  const refs: ImportRef[] = [];
  const fromForm = /\b(?:import|export)\s+([^'";]*?)\s*\bfrom\s*['"]([^'"]+)['"]/g;
  const bareForm = /\bimport\s*['"]([^'"]+)['"]/g;
  const callForm = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  for (const match of code.matchAll(fromForm)) {
    refs.push({ clause: match[1] ?? '', specifier: match[2] ?? '' });
  }
  for (const match of code.matchAll(bareForm)) refs.push({ clause: '', specifier: match[1] ?? '' });
  for (const match of code.matchAll(callForm)) refs.push({ clause: '', specifier: match[1] ?? '' });
  return refs;
}

/** Top-level `src/` entry a path or relative import lands in, or null if it leaves `src/`. */
function srcModuleOf(path: string): string | null {
  const target = relative(SRC, path);
  if (target.startsWith('..')) return null;
  // `../main` and `../main.ts` are the same module.
  return (target.split(sep)[0] ?? '').replace(/\.\w+$/, '');
}

/** `peerjs/dist/x` -> `peerjs`, `@scope/pkg/x` -> `@scope/pkg`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

function checkThreeImport(ref: ImportRef): string | null {
  if (ref.specifier !== 'three') {
    return `imports '${ref.specifier}' (three.js addons are view code)`;
  }
  const named = /^(?:type\s+)?\{([^}]*)\}$/.exec(ref.clause.trim());
  if (!named) {
    return `imports 'three' without a named list, so scene usage cannot be ruled out`;
  }
  const names = (named[1] ?? '')
    .split(',')
    .map(
      (part) =>
        part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0] ?? '',
    )
    .filter((name) => name.length > 0);
  const bad = names.filter((name) => !THREE_MATH_ALLOWLIST.has(name));
  return bad.length > 0 ? `imports non-math three.js exports: ${bad.join(', ')}` : null;
}

/** Returns one message per violation in `source`, as if it were the file at `file`. */
function findViolations(file: string, source: string): string[] {
  const code = stripComments(source);
  const problems: string[] = [];
  const guarded = srcModuleOf(file);
  const boundary = guarded === null ? undefined : BOUNDARIES[guarded];
  if (guarded === null || boundary === undefined) return [`is not inside a guarded directory`];

  for (const ref of findImports(code)) {
    if (ref.specifier.startsWith('.')) {
      const module = srcModuleOf(resolve(dirname(file), ref.specifier));
      if (module === null || !boundary.modules.has(module)) {
        problems.push(
          `${guarded} may not import '${module ?? 'outside src'}' ('${ref.specifier}')`,
        );
      }
    } else if (ref.specifier === 'three' || ref.specifier.startsWith('three/')) {
      const problem = checkThreeImport(ref);
      if (problem !== null) problems.push(problem);
    } else if (!boundary.packages.has(packageName(ref.specifier))) {
      problems.push(`${guarded} may not import the package '${ref.specifier}'`);
    }
  }

  code.split('\n').forEach((line, index) => {
    const match = DOM_GLOBALS.exec(line);
    if (match) problems.push(`uses the browser global '${match[1]}' on line ${index + 1}`);
  });

  return problems;
}

describe('sim/net boundaries (golden rule 3)', () => {
  it.each(GUARDED_DIRS)('src/%s only has allowed imports and no DOM access', (dir) => {
    const failures: string[] = [];
    for (const file of listSourceFiles(join(SRC, dir))) {
      for (const problem of findViolations(file, readFileSync(file, 'utf8'))) {
        failures.push(`${relative(SRC, file)}: ${problem}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it.each(['sim', 'shared'])('actually scans the %s sources', (dir) => {
    expect(listSourceFiles(join(SRC, dir)).length).toBeGreaterThan(0);
  });

  it('tolerates a missing directory', () => {
    expect(listSourceFiles(join(SRC, 'does-not-exist'))).toEqual([]);
  });
});

describe('boundary scanner', () => {
  const file = join(SRC, 'sim', 'systems', 'example.ts');
  const check = (source: string): string[] => findViolations(file, source);
  const checkIn = (dir: string, source: string): string[] =>
    findViolations(join(SRC, dir, 'example.ts'), source);

  it('accepts shared contracts, sibling files and its own packages', () => {
    expect(
      check(`
        import { TICK_MS } from '../../shared';
        import type { InputFrame } from '../../shared/input';
        import { createSimState } from '../sim-state';
        import { MeshBVH } from 'three-mesh-bvh';
        export * from './other';
      `),
    ).toEqual([]);
    expect(
      checkIn(
        'net',
        `
        import { Peer } from 'peerjs';
        import type { SimState } from '../sim';
        import { PROTOCOL_VERSION } from '../shared';
        import { encode } from './codec';
      `,
      ),
    ).toEqual([]);
  });

  it.each([...VIEW_MODULES, ...OTHER_FORBIDDEN_MODULES])('flags an import from %s', (module) => {
    expect(check(`import { x } from '../../${module}/thing';`)).toHaveLength(1);
    expect(check(`import type { X } from '../../${module}';`)).toHaveLength(1);
    expect(check(`export { x } from '../../${module}/index';`)).toHaveLength(1);
    expect(check(`const m = await import('../../${module}/lazy');`)).toHaveLength(1);
    expect(check(`import '../../${module}/side-effect';`)).toHaveLength(1);
    expect(checkIn('net', `import { x } from '../${module}/thing';`)).toHaveLength(1);
    expect(checkIn('shared', `import { x } from '../${module}/thing';`)).toHaveLength(1);
  });

  it('flags the entry file, files outside src and modules that do not exist yet', () => {
    expect(check(`import { boot } from '../../main';`)).toHaveLength(1);
    expect(check(`import { boot } from '../../main.ts';`)).toHaveLength(1);
    expect(check(`import config from '../../../vite.config';`)).toHaveLength(1);
    expect(check(`import { x } from '../../brand-new-module/x';`)).toHaveLength(1);
  });

  it('keeps the sim from importing net, and shared from importing anything else', () => {
    expect(check(`import { HostSession } from '../../net';`)).toHaveLength(1);
    expect(checkIn('shared', `import { createSim } from '../sim';`)).toHaveLength(1);
    expect(checkIn('shared', `import { encode } from '../net/codec';`)).toHaveLength(1);
    expect(checkIn('shared', `import type { Vec3 } from './math-types';`)).toEqual([]);
  });

  it('flags packages that are not on the list for that directory', () => {
    expect(check(`import GUI from 'lil-gui';`)).toHaveLength(1);
    expect(check(`import Stats from 'stats-gl';`)).toHaveLength(1);
    expect(check(`import { readFileSync } from 'node:fs';`)).toHaveLength(1);
    expect(check(`import { Peer } from 'peerjs';`)).toHaveLength(1);
    expect(check(`const m = await import('lil-gui');`)).toHaveLength(1);
    expect(checkIn('net', `import { MeshBVH } from 'three-mesh-bvh';`)).toHaveLength(1);
    expect(checkIn('net', `import { util } from 'peerjs/dist/util';`)).toEqual([]);
    expect(checkIn('shared', `import { Peer } from 'peerjs';`)).toHaveLength(1);
  });

  it('flags multi-line imports', () => {
    expect(check(`import {\n  a,\n  b,\n} from '../../render';`)).toHaveLength(1);
  });

  it('allows three.js math but not scene objects, namespaces or addons', () => {
    expect(check(`import { Vector3, Quaternion as Q } from 'three';`)).toEqual([]);
    expect(check(`import type { Vector3 } from 'three';`)).toEqual([]);
    expect(check(`import { Vector3, Mesh } from 'three';`)).toHaveLength(1);
    expect(check(`import { Scene } from 'three';`)).toHaveLength(1);
    expect(check(`import * as THREE from 'three';`)).toHaveLength(1);
    expect(check(`import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';`)).toHaveLength(
      1,
    );
    expect(checkIn('shared', `import { Mesh } from 'three';`)).toHaveLength(1);
  });

  it('flags DOM globals in code but not in comments', () => {
    expect(check(`const el = document.body;`)).toHaveLength(1);
    expect(check(`window.addEventListener('x', f);`)).toHaveLength(1);
    expect(check(`// never touch the document or window here\nconst a = 1;`)).toEqual([]);
    expect(check(`/** The window\n * of time. */\nconst slidingWindowMs = 1;`)).toEqual([]);
  });

  it.each([
    `const saved = localStorage.getItem('quality');`,
    `sessionStorage.clear();`,
    `requestAnimationFrame(step);`,
    `cancelAnimationFrame(handle);`,
    `const img = new Image();`,
    `function draw(canvas: HTMLCanvasElement): void {}`,
    `const el: HTMLElement | null = null;`,
    `const query = location.search;`,
    `alert('desync');`,
    `const cores = navigator.hardwareConcurrency;`,
  ])('flags browser-only code: %s', (source) => {
    expect(check(source)).toHaveLength(1);
    expect(checkIn('shared', source)).toHaveLength(1);
  });

  it('does not flag property names or everyday words that match a global', () => {
    expect(
      check(`
        const location = spawn.location;
        const zone = { location };
        if (state.alert) raiseAlert(zone.window);
        const elapsed = performance.now();
        interface Probe { navigator: number }
      `),
    ).toEqual([]);
  });
});
