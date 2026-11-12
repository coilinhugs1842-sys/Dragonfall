#!/usr/bin/env node
// node tools/blender/map/export_caldera_manifest.mjs [--register]
//
// Bakes the default Emberfall Caldera layout (src/shared/maps/emberfall-caldera.ts) into
//   public/assets/maps/emberfall-caldera/manifest.json   (MapManifest, with `placements`, `vents`)
//   public/assets/maps/emberfall-caldera/instances/<type>.bin  (float32 4x4 per instance)
// It writes nothing outside that folder, unless --register is given: then the map is also merged
// into the root public/assets/manifest.json (other entries are kept), which makes
// `npm run assets:check` cover it. The TypeScript is loaded through Vite's SSR loader, so this
// always matches the game's code. The layout module is loaded by its own path: it does not have
// to be exported from the src/shared/maps barrel for this to work.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ASSETS = join(REPO, 'public', 'assets');
const MAP_ID = 'emberfall-caldera';
const MAP_DIR = join(ASSETS, 'maps', MAP_ID);
/** Slot of the world material each texture fills on this map (id -> role). */
const TEXTURE_ROLES = { basalt: 'stone', columnar: 'cliff', ash: 'moss', masonry: 'masonry', brush: 'brush' };

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
  const caldera = await server.ssrLoadModule('/src/shared/maps/emberfall-caldera.ts');
  const placements = await server.ssrLoadModule('/src/shared/maps/placements.ts');
  const map = caldera.createEmberfallCaldera();
  const sets = placements.buildPlacementInstances(map.placements);

  const instanceDir = join(MAP_DIR, 'instances');
  if (existsSync(instanceDir)) for (const file of readdirSync(instanceDir)) rmSync(join(instanceDir, file));
  mkdirSync(instanceDir, { recursive: true });
  for (const set of sets) {
    writeFileSync(join(instanceDir, `${set.type.id}.bin`), Buffer.from(set.matrices.buffer, set.matrices.byteOffset, set.matrices.byteLength));
  }

  // Only the textures this map's materials use, each with the material slot it fills.
  const texturesPath = join(ASSETS, 'textures', 'textures.json');
  const textures = existsSync(texturesPath)
    ? JSON.parse(readFileSync(texturesPath, 'utf8'))
        .textures.filter((t) => t.id in TEXTURE_ROLES)
        .map((t) => ({
          id: t.id,
          url: t.url,
          tileMetres: t.tileMetres,
          meanLinear: t.meanLinear,
          colorSpace: t.colorSpace,
          role: TEXTURE_ROLES[t.id],
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
    source: 'src/shared/maps/emberfall-caldera.ts (default seed); art-source/LOG.md "T-6.4"',
  };
  writeFileSync(join(MAP_DIR, 'manifest.json'), `${JSON.stringify(manifest)}\n`);

  if (process.argv.includes('--register')) {
    const rootPath = join(ASSETS, 'manifest.json');
    const root = existsSync(rootPath) ? JSON.parse(readFileSync(rootPath, 'utf8')) : { version: 1, dragons: {}, maps: {} };
    root.version ??= 1;
    root.dragons ??= {};
    root.maps = { ...(root.maps ?? {}), [MAP_ID]: `maps/${MAP_ID}/manifest.json` };
    writeFileSync(rootPath, `${JSON.stringify(root, null, 2)}\n`);
    console.log(`registered ${MAP_ID} in ${rootPath}`);
  }

  const counts = sets.map((set) => `${set.type.id} x${set.count}`).join(', ');
  console.log(`manifest: ${map.placements.length} placements in ${sets.length} types, ${map.vents.length} vents`);
  console.log(counts);
} finally {
  await server.close();
}
