#!/usr/bin/env node
// node tools/blender/map/export_map_manifest.mjs
//
// Bakes the default Shattered Spires layout (src/shared/maps/shattered-spires.ts) into
//   public/assets/maps/shattered-spires/manifest.json   (MapManifest, with `placements`)
//   public/assets/maps/shattered-spires/instances/<type>.bin  (float32 4x4 per instance)
// and merges the map into the root public/assets/manifest.json (other entries are kept).
// The TypeScript is loaded through Vite's SSR loader, so this always matches the game's code.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ASSETS = join(REPO, 'public', 'assets');
const MAP_DIR = join(ASSETS, 'maps', 'shattered-spires');

const round = (value, digits) => {
  const rounded = Number(value.toFixed(digits));
  return rounded === 0 ? 0 : rounded;
};

const server = await createServer({
  root: REPO,
  configFile: false,
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, ws: false },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const maps = await server.ssrLoadModule('/src/shared/maps/index.ts');
  const map = maps.createShatteredSpires();
  const sets = maps.buildPlacementInstances(map.placements);

  const instanceDir = join(MAP_DIR, 'instances');
  if (existsSync(instanceDir)) for (const file of readdirSync(instanceDir)) rmSync(join(instanceDir, file));
  mkdirSync(instanceDir, { recursive: true });
  for (const set of sets) {
    writeFileSync(join(instanceDir, `${set.type.id}.bin`), Buffer.from(set.matrices.buffer, set.matrices.byteOffset, set.matrices.byteLength));
  }

  const texturesPath = join(ASSETS, 'textures', 'textures.json');
  const textures = existsSync(texturesPath)
    ? JSON.parse(readFileSync(texturesPath, 'utf8')).textures.map((t) => ({
        id: t.id,
        url: t.url,
        tileMetres: t.tileMetres,
        meanLinear: t.meanLinear,
        colorSpace: t.colorSpace,
      }))
    : [];

  const manifest = {
    ...map,
    placements: map.placements.map((p) => ({
      type: p.type,
      position: { x: round(p.position.x, 3), y: round(p.position.y, 3), z: round(p.position.z, 3) },
      yaw: round(p.yaw, 5),
      pitch: round(p.pitch, 5),
      roll: round(p.roll, 5),
      scale: round(p.scale, 4),
      ...(p.team !== undefined ? { team: p.team } : {}),
      ...(p.group !== undefined ? { group: p.group } : {}),
    })),
    textures,
    source: 'src/shared/maps/shattered-spires.ts (default seed); art-source/LOG.md "T-4.5"',
  };
  writeFileSync(join(MAP_DIR, 'manifest.json'), `${JSON.stringify(manifest)}\n`);

  const rootPath = join(ASSETS, 'manifest.json');
  const root = existsSync(rootPath) ? JSON.parse(readFileSync(rootPath, 'utf8')) : { version: 1, dragons: {}, maps: {} };
  root.version ??= 1;
  root.dragons ??= {};
  root.maps = { ...(root.maps ?? {}), 'shattered-spires': 'maps/shattered-spires/manifest.json' };
  writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);

  const counts = sets.map((set) => `${set.type.id} x${set.count}`).join(', ');
  console.log(`manifest: ${map.placements.length} placements in ${sets.length} types`);
  console.log(counts);
} finally {
  await server.close();
}
