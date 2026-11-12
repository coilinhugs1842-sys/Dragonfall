#!/usr/bin/env node
// node tools/blender/map/export_caldera_assets.mjs [--no-glb] [--no-textures]
//
// Turns the Blender output for Emberfall Caldera (T-6.4) into runtime files. The same steps as
// export_assets.mjs does for Shattered Spires, on this map's own folders, and it never writes a
// Shattered Spires file:
//   art-source/maps/caldera/rocks|props/*.glb -> public/assets/maps/emberfall-caldera/rocks|props/*.glb
//                                                (tools/pipeline/optimize.mjs: meshopt + quantization)
//   art-source/textures-raw/{basalt,columnar,ash}.png -> public/assets/textures/*.ktx2, and their
//                                                entries ADDED to textures.json (others untouched)
//   art-source/maps/caldera/hulls/*.json      -> src/shared/maps/generated/emberfall-caldera-hulls.ts
// Run from the repo root after build_caldera_rocks.py / build_caldera_props.py and
// `python tools/textures/make_textures.py --set caldera`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = join(REPO, 'art-source', 'maps', 'caldera');
const HULLS = join(SOURCE, 'hulls');
const MAP_ID = 'emberfall-caldera';
const MAP_OUT = join(REPO, 'public', 'assets', 'maps', MAP_ID);
const TEX_SRC = join(REPO, 'art-source', 'textures-raw');
const TEX_OUT = join(REPO, 'public', 'assets', 'textures');
const GENERATED = join(REPO, 'src', 'shared', 'maps', 'generated', 'emberfall-caldera-hulls.ts');
/** Metres per Int16 unit of the packed hull vertices (the same as Shattered Spires). */
const QUANTUM = 0.01;

const ROCKS = [
  'crater-wall', 'crater-breach', 'rim-tooth', 'cone-wall', 'basalt-columns', 'basalt-tall',
  'obsidian-shards', 'obsidian-fan', 'ash-island-large', 'ash-island-small', 'vent-chimney', 'lava-arch',
];
const PROPS = [
  'vent-marker', 'caldera-gate', 'basalt-pylon', 'obsidian-cluster', 'fumarole', 'backdrop-ridge', 'backdrop-cone',
];
/** `role`: the slot of the world material (src/world/props/world-material.ts) the texture fills on this map. */
const TEXTURES = [
  { name: 'basalt', role: 'stone', tileMetres: 64, use: 'Emberfall Caldera: rock detail / triplanar albedo (stone slot)' },
  { name: 'columnar', role: 'cliff', tileMetres: 64, use: 'Emberfall Caldera: rock sides (columnar joints), V along world up (cliff slot)' },
  { name: 'ash', role: 'moss', tileMetres: 24, use: 'Emberfall Caldera: where _MASKS.g is set (ash, in the moss slot)' },
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
      const input = join(SOURCE, folder, `${id}.glb`);
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
  const listPath = join(TEX_OUT, 'textures.json');
  const list = existsSync(listPath)
    ? JSON.parse(readFileSync(listPath, 'utf8'))
    : { version: 1, source: 'tools/textures/make_textures.py', textures: [] };
  for (const texture of TEXTURES) {
    const output = join(TEX_OUT, `${texture.name}.ktx2`);
    run('tools/pipeline/texture.mjs', [join(TEX_SRC, `${texture.name}.png`), output, '--kind', 'rock']);
    const entry = {
      id: texture.name,
      url: `textures/${texture.name}.ktx2`,
      size: 1024,
      colorSpace: 'srgb',
      tileMetres: texture.tileMetres,
      meanLinear: means[texture.name],
      use: texture.use,
      bytes: statSync(output).size,
      map: MAP_ID,
      role: texture.role,
    };
    // Additive: an entry of this map is replaced in place or appended; nothing else moves.
    const at = list.textures.findIndex((t) => t.id === texture.name);
    if (at >= 0) list.textures[at] = entry;
    else list.textures.push(entry);
    console.log(`textures/${texture.name}.ktx2 ${(entry.bytes / 1024).toFixed(1)} KB`);
  }
  writeFileSync(listPath, `${JSON.stringify(list, null, 2)}\n`);
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
    for (const hull of meta.hulls) {
      const base = verts.length / 3;
      for (const v of hull.verts) verts.push(Math.round(v[0] / QUANTUM), Math.round(v[1] / QUANTUM), Math.round(v[2] / QUANTUM));
      for (const t of hull.tris) tris.push(base + t[0], base + t[1], base + t[2]);
    }
    if (verts.some((v) => v < -32768 || v > 32767)) throw new Error(`${id}: hull vertex outside the Int16 range`);
    if (verts.length / 3 > 65535) throw new Error(`${id}: too many hull vertices for Uint16 indices`);
    totalTris += tris.length / 3;
    const folder = ROCKS.includes(id) ? 'rocks' : 'props';
    const file = join(MAP_OUT, folder, `${id}.glb`);
    types.push({
      id,
      kind: meta.kind,
      glb: `maps/${MAP_ID}/${folder}/${id}.glb`,
      bytes: sizes?.[id] ?? (existsSync(file) ? statSync(file).size : 0),
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
  lines.push(' * GENERATED by tools/blender/map/export_caldera_assets.mjs from art-source/maps/caldera/hulls/*.json');
  lines.push(' * (Blender: tools/blender/map/build_caldera_rocks.py, build_caldera_props.py). Do not edit by hand.');
  lines.push(' *');
  lines.push(' * Per asset type of Emberfall Caldera: metadata for the layout and the renderer, and the');
  lines.push(' * convex collision hulls packed as base64, in exactly the format of ./shattered-spires-hulls.ts');
  lines.push(' * (`verts`: Int16 xyz triples in units of CALDERA_HULL_QUANTUM metres, asset space, +Y up;');
  lines.push(' * `tris`: Uint16 index triples, counter-clockwise from outside, every hull closed and convex).');
  lines.push(' */');
  lines.push('');
  lines.push("import type { GeneratedMapAssetType } from './shattered-spires-hulls';");
  lines.push('');
  lines.push(`export const CALDERA_HULL_QUANTUM = ${QUANTUM};`);
  lines.push('');
  lines.push('export const CALDERA_ASSET_TYPES: readonly GeneratedMapAssetType[] = [');
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
