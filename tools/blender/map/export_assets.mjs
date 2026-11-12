#!/usr/bin/env node
// node tools/blender/map/export_assets.mjs [--no-glb] [--no-textures]
//
// Turns the Blender output for Shattered Spires (T-4.5) into runtime files:
//   art-source/maps/rocks|props/*.glb  -> public/assets/maps/shattered-spires/rocks|props/*.glb
//                                         (tools/pipeline/optimize.mjs: meshopt + quantization)
//   art-source/textures-raw/*.png      -> public/assets/textures/*.ktx2 (+ textures.json)
//   art-source/maps/hulls/*.json       -> src/shared/maps/generated/shattered-spires-hulls.ts
//                                         (convex collision hulls + per-type metadata, base64)
// Run from the repo root after build_rocks.py / build_props.py / make_textures.py.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HULLS = join(REPO, 'art-source', 'maps', 'hulls');
const MAP_OUT = join(REPO, 'public', 'assets', 'maps', 'shattered-spires');
const TEX_SRC = join(REPO, 'art-source', 'textures-raw');
const TEX_OUT = join(REPO, 'public', 'assets', 'textures');
const GENERATED = join(REPO, 'src', 'shared', 'maps', 'generated', 'shattered-spires-hulls.ts');
/** Metres per Int16 unit of the packed hull vertices. */
const QUANTUM = 0.01;

const ROCKS = [
  'spire-tall', 'spire-twin', 'spire-lean', 'stump-broken', 'island-large', 'island-small',
  'arch-great', 'arch-broken', 'crown-claw', 'crown-base', 'shard-cluster', 'cliff-wall',
];
const PROPS = [
  'column-ruined', 'column-broken', 'wall-fragment', 'bridge-span', 'stairs', 'standing-stone',
  'crystal-cluster', 'crystal-core', 'banner-tall', 'banner-wide', 'brazier', 'chain', 'aerie-gate',
  'backdrop-a', 'backdrop-b',
];
const TEXTURES = [
  { name: 'stone', linear: false, tileMetres: 64, use: 'rock detail / triplanar albedo' },
  { name: 'cliff', linear: false, tileMetres: 64, use: 'rock sides (strata), V along world up' },
  { name: 'moss', linear: false, tileMetres: 24, use: 'where _MASKS.g (moss) is set' },
  { name: 'masonry', linear: false, tileMetres: 12, use: 'props: worked ruin stone' },
  { name: 'brush', linear: true, tileMetres: 32, use: 'greyscale brush-stroke detail, mean 0.5' },
];

const args = new Set(process.argv.slice(2));

function run(script, argv) {
  return execFileSync(process.execPath, [join(REPO, script), ...argv], { cwd: REPO, encoding: 'utf8' });
}

function optimizeAll() {
  const sizes = {};
  for (const [folder, ids, kind] of [['rocks', ROCKS, 'rock'], ['props', PROPS, 'prop']]) {
    mkdirSync(join(MAP_OUT, folder), { recursive: true });
    for (const id of ids) {
      const input = join(REPO, 'art-source', 'maps', folder, `${id}.glb`);
      const output = join(MAP_OUT, folder, `${id}.glb`);
      run('tools/pipeline/optimize.mjs', [input, output, '--kind', kind]);
      sizes[id] = statSync(output).size;
      console.log(`${folder}/${id}.glb ${(sizes[id] / 1024).toFixed(1)} KB`);
    }
  }
  return sizes;
}

function convertTextures() {
  mkdirSync(TEX_OUT, { recursive: true });
  const means = JSON.parse(readFileSync(join(TEX_SRC, 'means.json'), 'utf8'));
  // The list is shared by every map: the entries other exporters added (Emberfall Caldera's
  // basalt, columnar, ash: export_caldera_assets.mjs) are kept, after this map's own.
  const listPath = join(TEX_OUT, 'textures.json');
  const own = new Set(TEXTURES.map((texture) => texture.name));
  const others = existsSync(listPath)
    ? JSON.parse(readFileSync(listPath, 'utf8')).textures.filter((entry) => !own.has(entry.id))
    : [];
  const entries = [];
  for (const texture of TEXTURES) {
    const output = join(TEX_OUT, `${texture.name}.ktx2`);
    const argv = [join(TEX_SRC, `${texture.name}.png`), output, '--kind', 'rock'];
    if (texture.linear) argv.push('--linear');
    run('tools/pipeline/texture.mjs', argv);
    entries.push({
      id: texture.name,
      url: `textures/${texture.name}.ktx2`,
      size: 1024,
      colorSpace: texture.linear ? 'linear' : 'srgb',
      tileMetres: texture.tileMetres,
      meanLinear: means[texture.name],
      use: texture.use,
      bytes: statSync(output).size,
    });
    console.log(`textures/${texture.name}.ktx2 ${(statSync(output).size / 1024).toFixed(1)} KB`);
  }
  writeFileSync(
    listPath,
    `${JSON.stringify({ version: 1, source: 'tools/textures/make_textures.py', textures: [...entries, ...others] }, null, 2)}\n`,
  );
}

function base64(typed) {
  return Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength).toString('base64');
}

function generateHulls(sizes) {
  const types = [];
  let totalTris = 0;
  for (const id of [...ROCKS, ...PROPS]) {
    const meta = JSON.parse(readFileSync(join(HULLS, `${id}.json`), 'utf8'));
    const verts = [];
    const tris = [];
    const hullStarts = [];
    for (const hull of meta.hulls) {
      const base = verts.length / 3;
      hullStarts.push(tris.length / 3);
      for (const v of hull.verts) verts.push(Math.round(v[0] / QUANTUM), Math.round(v[1] / QUANTUM), Math.round(v[2] / QUANTUM));
      for (const t of hull.tris) tris.push(base + t[0], base + t[1], base + t[2]);
    }
    if (verts.some((v) => v < -32768 || v > 32767)) throw new Error(`${id}: hull vertex outside the Int16 range`);
    totalTris += tris.length / 3;
    const folder = ROCKS.includes(id) ? 'rocks' : 'props';
    types.push({
      id,
      kind: meta.kind,
      glb: `maps/shattered-spires/${folder}/${id}.glb`,
      bytes: sizes?.[id] ?? (existsSync(join(MAP_OUT, folder, `${id}.glb`)) ? statSync(join(MAP_OUT, folder, `${id}.glb`)).size : 0),
      lodTriangles: meta.triangles,
      hasTint: meta.hasTint,
      radius: meta.radius,
      boundsMin: meta.boundsMin,
      boundsMax: meta.boundsMax,
      anchor: meta.anchor ?? 'base',
      top: meta.top ?? null,
      opening: meta.opening ?? null,
      hullCount: meta.hulls.length,
      hullTriangles: tris.length / 3,
      verts: base64(new Int16Array(verts)),
      tris: base64(new Uint16Array(tris)),
    });
  }
  const lines = [];
  lines.push('/**');
  lines.push(' * GENERATED by tools/blender/map/export_assets.mjs from art-source/maps/hulls/*.json');
  lines.push(' * (Blender: tools/blender/map/build_rocks.py, build_props.py). Do not edit by hand.');
  lines.push(' *');
  lines.push(' * Per asset type of Shattered Spires: metadata for the layout and the renderer, and the');
  lines.push(' * convex collision hulls packed as base64 (`verts`: Int16 xyz triples in units of');
  lines.push(' * SPIRES_HULL_QUANTUM metres, asset space, +Y up; `tris`: Uint16 index triples, counter-');
  lines.push(' * clockwise from outside, every hull a closed convex volume). Little-endian.');
  lines.push(' */');
  lines.push('');
  lines.push(`export const SPIRES_HULL_QUANTUM = ${QUANTUM};`);
  lines.push('');
  lines.push('export interface GeneratedMapAssetType {');
  lines.push('  readonly id: string;');
  lines.push("  readonly kind: 'rock' | 'prop' | 'gate' | 'backdrop';");
  lines.push('  /** Runtime GLB, relative to public/assets/. Nodes LOD0.. (see lodTriangles). */');
  lines.push('  readonly glb: string;');
  lines.push('  readonly bytes: number;');
  lines.push('  readonly lodTriangles: readonly number[];');
  lines.push('  /** True when the GLB has a second material "TeamTint". */');
  lines.push('  readonly hasTint: boolean;');
  lines.push('  /** Bounding sphere radius around the asset origin, and the box, at scale 1 (metres). */');
  lines.push('  readonly radius: number;');
  lines.push('  readonly boundsMin: readonly [number, number, number];');
  lines.push('  readonly boundsMax: readonly [number, number, number];');
  lines.push("  /** Where the origin sits: at the base, at the walkable top, or at the centre. */");
  lines.push("  readonly anchor: 'base' | 'top' | 'centre';");
  lines.push('  /** A flat top that props can stand on: local Y and usable radius. */');
  lines.push('  readonly top: { readonly y: number; readonly radius: number } | null;');
  lines.push('  /** A hole to fly through, along local Z: clear width/height and the Y of its centre. */');
  lines.push('  readonly opening: { readonly width: number; readonly height: number; readonly y: number } | null;');
  lines.push('  readonly hullCount: number;');
  lines.push('  readonly hullTriangles: number;');
  lines.push('  readonly verts: string;');
  lines.push('  readonly tris: string;');
  lines.push('}');
  lines.push('');
  lines.push('export const SPIRES_ASSET_TYPES: readonly GeneratedMapAssetType[] = [');
  for (const type of types) {
    lines.push('  {');
    for (const [key, value] of Object.entries(type)) {
      lines.push(`    ${key}: ${typeof value === 'string' ? `'${value}'` : JSON.stringify(value)},`);
    }
    lines.push('  },');
  }
  lines.push('];');
  lines.push('');
  mkdirSync(dirname(GENERATED), { recursive: true });
  writeFileSync(GENERATED, lines.join('\n'));
  console.log(`generated ${GENERATED} (${(statSync(GENERATED).size / 1024).toFixed(1)} KB, ${totalTris} hull triangles in ${types.length} types)`);
}

if (!existsSync(HULLS) || readdirSync(HULLS).length === 0) throw new Error('run the Blender builders first');
const sizes = args.has('--no-glb') ? null : optimizeAll();
if (!args.has('--no-textures')) convertTextures();
generateHulls(sizes);
