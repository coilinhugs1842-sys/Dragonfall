// Optimize the raw dragon GLBs into public/assets and write their manifests.
//   node tools/blender/dragons/finish.mjs [class ...]      (run from the repo root)
// Reads art-source/dragons/<class>/<class>.glb + <class>_info.json (from build_dragon.py).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const ALL = ['talon', 'bastion', 'tempest', 'wraith'];
const classes = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const wing = (side) =>
  ['shoulder', 'elbow', 'wrist', 'finger1', 'finger2', 'finger3'].map((b) => `wing_${b}_${side}`);

for (const cls of classes.length ? classes : ALL) {
  const src = `art-source/dragons/${cls}`;
  const outDir = `public/assets/dragons/${cls}`;
  const info = JSON.parse(readFileSync(`${src}/${cls}_info.json`, 'utf8'));
  mkdirSync(outDir, { recursive: true });
  const out = `${outDir}/${cls}.glb`;
  execFileSync(
    process.execPath,
    ['tools/pipeline/optimize.mjs', `${src}/${cls}.glb`, out, '--kind', 'dragon', '--texture-mode', 'uastc'],
    { stdio: 'inherit' },
  );
  const clips = Object.fromEntries(Object.keys(info.clips).map((c) => [c, c]));
  const manifest = {
    classId: cls,
    glb: `dragons/${cls}/${cls}.glb`,
    lods: [0, 1, 2].map((i) => ({ node: `LOD${i}`, triangles: info.triangles[i] })),
    clips,
    bones: {
      root: 'root',
      head: 'head',
      neck: ['neck1', 'neck2', 'neck3'],
      wingLeft: wing('L'),
      wingRight: wing('R'),
      tail: ['tail1', 'tail2', 'tail3', 'tail4'],
      // extra (optional) names for the procedural layer
      jaw: 'jaw',
      chest: 'chest',
      hips: 'hips',
    },
    tintSlots: { hide: 'Hide', membrane: 'Membrane', runes: 'Runes' },
    wingspan: info.wingspan,
    muzzleOffset: { x: info.muzzle[0], y: info.muzzle[1], z: info.muzzle[2] },
    source: `art-source/dragons/${cls}/${cls}.glb (procedural: tools/blender/dragons, LOG.md 2026-11-11)`,
    // optional extras
    clipInfo: info.clips,
    bodyLength: info.length,
    cloakSlot: 'Membrane',
  };
  writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${cls}: ${(statSync(out).size / 1024).toFixed(1)} KB, manifest written`);
}

// merge into the root manifest (another tool owns "maps")
const rootPath = 'public/assets/manifest.json';
const root = existsSync(rootPath) ? JSON.parse(readFileSync(rootPath, 'utf8')) : { version: 1 };
root.version ??= 1;
root.dragons ??= {};
root.maps ??= {};
for (const cls of ALL) {
  if (existsSync(`public/assets/dragons/${cls}/manifest.json`)) {
    root.dragons[cls] = `dragons/${cls}/manifest.json`;
  }
}
writeFileSync(rootPath, JSON.stringify(root, null, 2) + '\n');
console.log('root manifest updated');
