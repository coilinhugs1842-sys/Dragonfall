#!/usr/bin/env node
// npm run assets:check [-- --root <assets dir>]
//
// Validates public/assets/manifest.json and every dragon/map manifest it lists against the
// contracts in src/shared/manifests.ts: field shapes, that every referenced file exists, that the
// names a manifest quotes (LOD nodes, clips, bones, tint-slot materials) exist in the GLB, and
// the ASSET_BUDGETS. Exits 1 on any error. Unknown extra fields are allowed (the contracts grow
// by optional fields).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BUDGETS,
  DRAGON_ANIM_CLIPS,
  DRAGON_CLASS_IDS,
  MAP_IDS,
  REPO_ROOT,
  formatBytes,
  isMain,
  parseArgs,
} from './lib/common.mjs';
import { analyzeFile, checkGlbBudgets } from './lib/glb.mjs';

const MAX_TEAM_SIZE = 5; // src/shared/constants.ts
const TEAM_COUNT = 2;

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isString = (value) => typeof value === 'string' && value.length > 0;
const isVec3 = (value) =>
  isObject(value) && isNumber(value.x) && isNumber(value.y) && isNumber(value.z);
const isQuat = (value) => isVec3(value) && isNumber(value.w);
const isColor = (value) => Number.isInteger(value) && value >= 0 && value <= 0xffffff;

/** Collects findings under a path prefix such as `dragons/talon/talon.json`. */
class Report {
  constructor() {
    this.errors = [];
    this.warnings = [];
  }
  scope(prefix) {
    return {
      error: (message) => this.errors.push(`${prefix}: ${message}`),
      warn: (message) => this.warnings.push(`${prefix}: ${message}`),
    };
  }
}

/** Resolves and checks a manifest URL (relative to the assets dir); returns its size or -1. */
function checkFile(assetsDir, url, field, log, files) {
  if (!isString(url)) {
    log.error(`${field} must be a non-empty string`);
    return -1;
  }
  if (/^([a-z]+:|\/)/i.test(url) || url.includes('\\') || url.split('/').includes('..')) {
    log.error(`${field} "${url}" must be a path relative to public/assets, with forward slashes`);
    return -1;
  }
  const full = join(assetsDir, url);
  if (!existsSync(full) || !statSync(full).isFile()) {
    log.error(`${field} "${url}" does not exist`);
    return -1;
  }
  const bytes = statSync(full).size;
  files?.set(url, bytes);
  return bytes;
}

function readJson(assetsDir, url, field, log) {
  if (checkFile(assetsDir, url, field, log) < 0) return null;
  try {
    return JSON.parse(readFileSync(join(assetsDir, url), 'utf8'));
  } catch (error) {
    log.error(`${field} "${url}" is not valid JSON: ${error.message}`);
    return null;
  }
}

function checkNameList(value, field, log) {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isString)) {
    log.error(`${field} must be a non-empty array of names`);
    return [];
  }
  return value;
}

async function checkDragon(assetsDir, classId, url, report) {
  const log = report.scope(url);
  const manifest = readJson(assetsDir, url, `dragons.${classId}`, report.scope('manifest.json'));
  if (manifest === null) return;
  if (!isObject(manifest)) return log.error('must be a JSON object');
  if (manifest.classId !== classId) {
    log.error(`classId is "${manifest.classId}", listed under "${classId}"`);
  }

  // Shapes first; the GLB cross-checks below need them.
  const lodsOk =
    Array.isArray(manifest.lods) &&
    manifest.lods.length === 3 &&
    manifest.lods.every(
      (lod) => isObject(lod) && isString(lod.node) && Number.isInteger(lod.triangles),
    );
  if (!lodsOk) log.error('lods must be 3 entries of { node: string, triangles: integer }');

  const clipNames = [];
  if (!isObject(manifest.clips)) {
    log.error('clips must map every animation state to a clip name');
  } else {
    for (const state of DRAGON_ANIM_CLIPS) {
      if (isString(manifest.clips[state])) clipNames.push(manifest.clips[state]);
      else log.error(`clips.${state} is missing`);
    }
  }

  const boneNames = [];
  if (!isObject(manifest.bones)) {
    log.error('bones is missing');
  } else {
    for (const key of ['root', 'head']) {
      if (isString(manifest.bones[key])) boneNames.push(manifest.bones[key]);
      else log.error(`bones.${key} must be a bone name`);
    }
    for (const key of ['neck', 'wingLeft', 'wingRight', 'tail']) {
      boneNames.push(...checkNameList(manifest.bones[key], `bones.${key}`, log));
    }
  }

  const slotNames = [];
  if (!isObject(manifest.tintSlots)) {
    log.error('tintSlots is missing');
  } else {
    for (const key of ['hide', 'membrane', 'runes']) {
      if (isString(manifest.tintSlots[key])) slotNames.push(manifest.tintSlots[key]);
      else log.error(`tintSlots.${key} must be a material name`);
    }
  }

  if (!isNumber(manifest.wingspan) || manifest.wingspan <= 0) {
    log.error('wingspan must be a positive number (metres)');
  } else if (manifest.wingspan < 8 || manifest.wingspan > 24) {
    log.warn(`wingspan ${manifest.wingspan} m is far from the 14 m reference`);
  }
  if (!isVec3(manifest.muzzleOffset)) log.error('muzzleOffset must be { x, y, z }');
  if (manifest.impostor !== undefined) checkFile(assetsDir, manifest.impostor, 'impostor', log);
  if (manifest.source !== undefined && !isString(manifest.source))
    log.error('source must be a string');

  if (checkFile(assetsDir, manifest.glb, 'glb', log) < 0) return;
  let analysis;
  try {
    analysis = await analyzeFile(join(assetsDir, manifest.glb));
  } catch (error) {
    return log.error(`glb "${manifest.glb}" could not be read: ${error.message}`);
  }
  for (const finding of checkGlbBudgets(analysis, 'dragon')) {
    (finding.level === 'error' ? log.error : log.warn)(`${manifest.glb}: ${finding.message}`);
  }

  if (lodsOk) {
    for (let index = 0; index < 3; index++) {
      const lod = manifest.lods[index];
      let lodAnalysis = analysis;
      let where = manifest.glb;
      if (lod.url !== undefined) {
        if (checkFile(assetsDir, lod.url, `lods[${index}].url`, log) < 0) continue;
        lodAnalysis = await analyzeFile(join(assetsDir, lod.url));
        where = lod.url;
      }
      const found = lodAnalysis.lods.find((entry) => entry.nodes.includes(lod.node));
      if (!lodAnalysis.nodeNames.includes(lod.node) || !found) {
        log.error(`lods[${index}].node "${lod.node}" is not a LOD node of ${where}`);
        continue;
      }
      if (found.triangles !== lod.triangles) {
        log.error(
          `lods[${index}].triangles says ${lod.triangles}, ${where} node "${lod.node}" has ${found.triangles}`,
        );
      }
      const budget = BUDGETS.dragonLodTriangles[index];
      if (found.triangles > budget) {
        log.error(`lods[${index}] has ${found.triangles} triangles, budget ${budget}`);
      }
    }
  }
  const glbClips = new Set(analysis.clips.map((clip) => clip.name));
  for (const name of new Set(clipNames)) {
    if (!glbClips.has(name)) log.error(`clip "${name}" is not in ${manifest.glb}`);
  }
  const glbNodes = new Set(analysis.nodeNames);
  const glbBones = new Set(analysis.bones);
  for (const name of new Set(boneNames)) {
    if (!glbNodes.has(name)) log.error(`bone "${name}" is not a node of ${manifest.glb}`);
    else if (analysis.skins > 0 && !glbBones.has(name)) {
      log.warn(`bone "${name}" is a node but not a skin joint of ${manifest.glb}`);
    }
  }
  const glbMaterials = new Set(analysis.materials);
  for (const name of new Set(slotNames)) {
    if (!glbMaterials.has(name))
      log.error(`tint slot material "${name}" is not in ${manifest.glb}`);
  }
}

async function checkMap(assetsDir, mapId, url, report) {
  const log = report.scope(url);
  const manifest = readJson(assetsDir, url, `maps.${mapId}`, report.scope('manifest.json'));
  if (manifest === null) return;
  if (!isObject(manifest)) return log.error('must be a JSON object');
  /** url -> bytes of everything this map downloads. */
  const files = new Map();
  files.set(url, statSync(join(assetsDir, url)).size);

  if (manifest.id !== mapId) log.error(`id is "${manifest.id}", listed under "${mapId}"`);
  if (!isString(manifest.name)) log.error('name must be a string');
  if (!isNumber(manifest.size) || manifest.size <= 0) log.error('size must be a positive number');

  if (!Array.isArray(manifest.chunks)) {
    log.error('chunks must be an array (empty on a greybox map)');
  } else {
    const ids = new Set();
    manifest.chunks.forEach((chunk, i) => {
      const at = `chunks[${i}]`;
      if (!isObject(chunk)) return log.error(`${at} must be an object`);
      if (!isString(chunk.id)) log.error(`${at}.id must be a string`);
      else if (ids.has(chunk.id)) log.error(`${at}.id "${chunk.id}" is used twice`);
      else ids.add(chunk.id);
      if (!Array.isArray(chunk.lods) || chunk.lods.length < 1 || chunk.lods.length > 3) {
        log.error(`${at}.lods must list 1 to 3 URLs, nearest first`);
      } else {
        chunk.lods.forEach((lod, j) => checkFile(assetsDir, lod, `${at}.lods[${j}]`, log, files));
      }
      if (!isVec3(chunk.center)) log.error(`${at}.center must be { x, y, z }`);
      if (!isNumber(chunk.radius) || chunk.radius <= 0) log.error(`${at}.radius must be positive`);
    });
  }

  if (!Array.isArray(manifest.props)) {
    log.error('props must be an array');
  } else {
    for (const [i, prop] of manifest.props.entries()) {
      const at = `props[${i}]`;
      if (!isObject(prop)) {
        log.error(`${at} must be an object`);
        continue;
      }
      if (!isString(prop.id)) log.error(`${at}.id must be a string`);
      if (!Number.isInteger(prop.count) || prop.count < 0)
        log.error(`${at}.count must be an integer`);
      checkFile(assetsDir, prop.instances, `${at}.instances`, log, files);
      if (checkFile(assetsDir, prop.glb, `${at}.glb`, log, files) >= 0) {
        try {
          const analysis = await analyzeFile(join(assetsDir, prop.glb));
          // Hero rocks are instanced through the same list; they get the rock budget by folder.
          const kind = /(^|\/)(hero-?)?rocks?\//i.test(prop.glb) ? 'rock' : 'prop';
          for (const finding of checkGlbBudgets(analysis, kind)) {
            (finding.level === 'error' ? log.error : log.warn)(`${prop.glb}: ${finding.message}`);
          }
        } catch (error) {
          log.error(`${at}.glb "${prop.glb}" could not be read: ${error.message}`);
        }
      }
    }
  }

  const sky = manifest.sky;
  if (!isObject(sky)) {
    log.error('sky is missing');
  } else {
    if (sky.panorama !== undefined) {
      const bytes = checkFile(assetsDir, sky.panorama, 'sky.panorama', log, files);
      if (bytes > BUDGETS.skyPanoramaMaxFileBytes) {
        log.error(
          `sky.panorama is ${formatBytes(bytes)}, budget ${formatBytes(BUDGETS.skyPanoramaMaxFileBytes)}`,
        );
      }
    }
    if (!isVec3(sky.sunDirection)) {
      log.error('sky.sunDirection must be { x, y, z }');
    } else {
      const length = Math.hypot(sky.sunDirection.x, sky.sunDirection.y, sky.sunDirection.z);
      if (Math.abs(length - 1) > 0.01)
        log.error(`sky.sunDirection has length ${length.toFixed(3)}, not 1`);
    }
    if (!isColor(sky.sunColor)) log.error('sky.sunColor must be an sRGB hex integer');
    if (!isColor(sky.fogColor)) log.error('sky.fogColor must be an sRGB hex integer');
    if (!isNumber(sky.fogDensity) || sky.fogDensity < 0) log.error('sky.fogDensity must be >= 0');
  }

  if (!Array.isArray(manifest.spawnGates) || manifest.spawnGates.length !== TEAM_COUNT) {
    log.error(`spawnGates must have ${TEAM_COUNT} entries, indexed by team`);
  } else {
    manifest.spawnGates.forEach((gate, i) => {
      const at = `spawnGates[${i}]`;
      if (!isObject(gate)) return log.error(`${at} must be an object`);
      if (gate.team !== i) log.error(`${at}.team is ${gate.team}, expected ${i}`);
      if (!isVec3(gate.position)) log.error(`${at}.position must be { x, y, z }`);
      if (!isQuat(gate.orientation)) {
        log.error(`${at}.orientation must be { x, y, z, w }`);
      } else {
        const q = gate.orientation;
        const length = Math.hypot(q.x, q.y, q.z, q.w);
        if (Math.abs(length - 1) > 0.01) log.error(`${at}.orientation is not a unit quaternion`);
      }
      if (!Array.isArray(gate.slots) || !gate.slots.every(isVec3)) {
        log.error(`${at}.slots must be an array of { x, y, z }`);
      } else if (gate.slots.length < MAX_TEAM_SIZE) {
        log.error(`${at}.slots has ${gate.slots.length} spawn points, needs ${MAX_TEAM_SIZE}`);
      }
    });
  }

  const colliders = manifest.colliders;
  if (!isObject(colliders)) {
    log.error('colliders is missing');
  } else {
    if (colliders.terrain !== undefined) {
      checkFile(assetsDir, colliders.terrain, 'colliders.terrain', log, files);
    }
    if (!isVec3(colliders.stormCenter)) log.error('colliders.stormCenter must be { x, y, z }');
    if (!isNumber(colliders.stormRadius) || colliders.stormRadius <= 0) {
      log.error('colliders.stormRadius must be positive');
    }
    if (!isNumber(colliders.ceilingY) || !isNumber(colliders.floorY)) {
      log.error('colliders.ceilingY and floorY must be numbers');
    } else if (colliders.ceilingY <= colliders.floorY) {
      log.error('colliders.ceilingY must be above floorY');
    }
    if (colliders.cloudSeaY !== undefined) {
      if (!isNumber(colliders.cloudSeaY)) log.error('colliders.cloudSeaY must be a number');
      else if (isNumber(colliders.floorY) && colliders.cloudSeaY < colliders.floorY) {
        log.error('colliders.cloudSeaY must be at or above floorY');
      }
    }
    const hasSolids = Array.isArray(manifest.solids) && manifest.solids.length > 0;
    // T-4.5: a real map collides with the hulls of its placed assets (src/shared/maps/placements.ts).
    const hasPlacements = Array.isArray(manifest.placements) && manifest.placements.length > 0;
    if (colliders.terrain === undefined && !hasSolids && !hasPlacements) {
      log.error('no collision source: set colliders.terrain, solids or placements');
    }
  }

  if (manifest.solids !== undefined) {
    if (!Array.isArray(manifest.solids)) log.error('solids must be an array');
    else {
      manifest.solids.forEach((solid, i) => {
        if (!isObject(solid) || !isString(solid.role) || !isVec3(solid.position)) {
          log.error(`solids[${i}] needs at least { role, position }`);
        }
      });
    }
  }
  if (
    Array.isArray(manifest.chunks) &&
    manifest.chunks.length === 0 &&
    manifest.solids === undefined
  ) {
    log.warn('no chunks and no solids: nothing to draw');
  }
  if (
    manifest.chunkSize !== undefined &&
    !(isNumber(manifest.chunkSize) && manifest.chunkSize > 0)
  ) {
    log.error('chunkSize must be a positive number');
  }
  if (manifest.introSpline !== undefined) {
    if (!Array.isArray(manifest.introSpline) || !manifest.introSpline.every(isVec3)) {
      log.error('introSpline must be an array of { x, y, z }');
    }
  }

  let audioBytes = 0;
  if (manifest.audio !== undefined) {
    if (!isObject(manifest.audio)) {
      log.error('audio must be { ambience: string[], music: string[] }');
    } else {
      for (const key of ['ambience', 'music']) {
        const list = manifest.audio[key];
        if (!Array.isArray(list)) {
          log.error(`audio.${key} must be an array of URLs`);
          continue;
        }
        list.forEach((entry, i) => {
          const already = files.has(entry);
          const bytes = checkFile(assetsDir, entry, `audio.${key}[${i}]`, log, files);
          if (bytes >= 0 && !already) audioBytes += bytes;
          if (isString(entry) && !/\.ogg$/i.test(entry))
            log.error(`audio.${key}[${i}] must be an .ogg file`);
        });
      }
    }
  }
  if (audioBytes > BUDGETS.mapMaxAudioBytes) {
    log.error(
      `audio totals ${formatBytes(audioBytes)}, budget ${formatBytes(BUDGETS.mapMaxAudioBytes)}`,
    );
  }
  let total = 0;
  for (const bytes of files.values()) total += bytes;
  if (total > BUDGETS.mapMaxDownloadBytes) {
    log.error(
      `download totals ${formatBytes(total)}, budget ${formatBytes(BUDGETS.mapMaxDownloadBytes)}`,
    );
  }
  return { files: files.size, bytes: total, audioBytes };
}

/**
 * Checks `<assetsDir>/manifest.json` and everything it lists.
 * @returns {Promise<{ errors: string[], warnings: string[], dragons: string[], maps: string[] }>}
 */
export async function checkManifest(assetsDir = join(REPO_ROOT, 'public', 'assets')) {
  const report = new Report();
  const log = report.scope('manifest.json');
  const result = {
    errors: report.errors,
    warnings: report.warnings,
    dragons: [],
    maps: [],
    mapTotals: {},
  };
  const rootPath = join(assetsDir, 'manifest.json');
  if (!existsSync(rootPath)) {
    log.error(`${rootPath} does not exist`);
    return result;
  }
  let root;
  try {
    root = JSON.parse(readFileSync(rootPath, 'utf8'));
  } catch (error) {
    log.error(`not valid JSON: ${error.message}`);
    return result;
  }
  if (!isObject(root)) {
    log.error('must be a JSON object');
    return result;
  }
  if (!Number.isInteger(root.version) || root.version < 1)
    log.error('version must be an integer >= 1');
  if (!isObject(root.dragons)) log.error('dragons must be an object of classId -> manifest URL');
  if (!isObject(root.maps)) log.error('maps must be an object of mapId -> manifest URL');

  for (const [classId, url] of Object.entries(isObject(root.dragons) ? root.dragons : {})) {
    if (!DRAGON_CLASS_IDS.includes(classId)) {
      log.error(`dragons.${classId} is not a dragon class (${DRAGON_CLASS_IDS.join(', ')})`);
      continue;
    }
    result.dragons.push(classId);
    await checkDragon(assetsDir, classId, url, report);
  }
  for (const [mapId, url] of Object.entries(isObject(root.maps) ? root.maps : {})) {
    if (!MAP_IDS.includes(mapId)) {
      log.error(`maps.${mapId} is not a map id (${MAP_IDS.join(', ')})`);
      continue;
    }
    result.maps.push(mapId);
    const totals = await checkMap(assetsDir, mapId, url, report);
    if (totals) result.mapTotals[mapId] = totals;
  }
  return result;
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const assetsDir = options.root ? resolve(options.root) : join(REPO_ROOT, 'public', 'assets');
  const result = await checkManifest(assetsDir);
  console.log(`Checked ${join(assetsDir, 'manifest.json')}`);
  console.log(`  dragons: ${result.dragons.join(', ') || 'none'}`);
  console.log(`  maps: ${result.maps.join(', ') || 'none'}`);
  for (const [mapId, totals] of Object.entries(result.mapTotals)) {
    console.log(
      `  ${mapId}: ${totals.files} file(s), ${formatBytes(totals.bytes)} download, ` +
        `${formatBytes(totals.audioBytes)} audio`,
    );
  }
  for (const warning of result.warnings) console.log(`  warning: ${warning}`);
  for (const error of result.errors) console.log(`  ERROR: ${error}`);
  console.log(
    result.errors.length === 0
      ? `OK (${result.warnings.length} warning(s)).`
      : `${result.errors.length} error(s), ${result.warnings.length} warning(s).`,
  );
  process.exit(result.errors.length === 0 ? 0 : 1);
}

if (isMain(import.meta.url)) {
  main().catch((error) => {
    console.error(`assets:check failed: ${error.message}`);
    process.exit(1);
  });
}
