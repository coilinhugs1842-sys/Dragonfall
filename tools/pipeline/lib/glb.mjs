// GLB reading and analysis shared by optimize, inspect and manifest.
import { statSync } from 'node:fs';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { BUDGETS, formatBytes } from './common.mjs';

let ioPromise;

/** NodeIO with every glTF extension and the meshopt codec registered. */
export function getIO() {
  ioPromise ??= (async () => {
    await MeshoptDecoder.ready;
    await MeshoptEncoder.ready;
    return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
      'meshopt.decoder': MeshoptDecoder,
      'meshopt.encoder': MeshoptEncoder,
    });
  })();
  return ioPromise;
}

/** `LOD0`, `LOD1_body`, `rock_LOD2`: the digit after "LOD" as a separate token. */
const LOD_NAME = /(?:^|[_.\- ])LOD(\d)(?:$|[_.\- ])/i;

/** LOD index encoded in a node name, or -1. */
export function lodIndexOf(name) {
  const match = LOD_NAME.exec(name);
  return match ? Number(match[1]) : -1;
}

function primitiveTriangles(primitive) {
  const indices = primitive.getIndices();
  const position = primitive.getAttribute('POSITION');
  const count = indices ? indices.getCount() : position ? position.getCount() : 0;
  const mode = primitive.getMode();
  if (mode === 4) return Math.floor(count / 3);
  if (mode === 5 || mode === 6) return Math.max(0, count - 2);
  return 0;
}

function subtreeStats(node, stats = { triangles: 0, vertices: 0, primitives: 0 }) {
  const mesh = node.getMesh();
  if (mesh) {
    for (const primitive of mesh.listPrimitives()) {
      stats.triangles += primitiveTriangles(primitive);
      stats.vertices += primitive.getAttribute('POSITION')?.getCount() ?? 0;
      stats.primitives += 1;
    }
  }
  for (const child of node.listChildren()) subtreeStats(child, stats);
  return stats;
}

/**
 * Everything the tools report on, as plain data.
 * `lods[i]` sums the subtree of every node whose name carries LOD index i.
 */
export function analyzeDocument(document, fileBytes = 0) {
  const root = document.getRoot();
  const nodes = root.listNodes();

  const lodMap = new Map();
  for (const node of nodes) {
    const index = lodIndexOf(node.getName());
    if (index < 0) continue;
    const stats = subtreeStats(node);
    const entry = lodMap.get(index) ?? {
      index,
      nodes: [],
      triangles: 0,
      vertices: 0,
      primitives: 0,
    };
    entry.nodes.push(node.getName());
    entry.triangles += stats.triangles;
    entry.vertices += stats.vertices;
    entry.primitives += stats.primitives;
    lodMap.set(index, entry);
  }
  const lods = [...lodMap.values()].sort((a, b) => a.index - b.index);

  const total = { triangles: 0, vertices: 0, primitives: 0 };
  for (const scene of root.listScenes()) {
    for (const child of scene.listChildren()) subtreeStats(child, total);
  }

  const bones = new Set();
  for (const skin of root.listSkins()) {
    for (const joint of skin.listJoints()) bones.add(joint.getName());
  }

  let colorPrimitives = 0;
  let primitiveCount = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      primitiveCount += 1;
      if (primitive.getAttribute('COLOR_0')) colorPrimitives += 1;
    }
  }

  const textures = root.listTextures().map((texture) => {
    const size = texture.getSize();
    return {
      name: texture.getName() || texture.getURI() || '(unnamed)',
      mimeType: texture.getMimeType(),
      width: size ? size[0] : 0,
      height: size ? size[1] : 0,
      bytes: texture.getImage()?.byteLength ?? 0,
      slots: listTextureSlots(texture),
    };
  });

  const clips = root.listAnimations().map((animation) => {
    let duration = 0;
    for (const sampler of animation.listSamplers()) {
      const input = sampler.getInput();
      if (input && input.getCount() > 0) {
        duration = Math.max(duration, input.getScalar(input.getCount() - 1));
      }
    }
    return {
      name: animation.getName(),
      duration,
      channels: animation.listChannels().length,
    };
  });

  return {
    fileBytes,
    nodeNames: nodes.map((node) => node.getName()),
    lods,
    total,
    bones: [...bones],
    skins: root.listSkins().length,
    materials: root.listMaterials().map((material) => material.getName()),
    textures,
    clips,
    colorPrimitives,
    primitiveCount,
    extensionsUsed: root.listExtensionsUsed().map((extension) => extension.extensionName),
    extensionsRequired: root.listExtensionsRequired().map((extension) => extension.extensionName),
  };
}

export async function analyzeFile(path) {
  const io = await getIO();
  const document = await io.read(path);
  return analyzeDocument(document, statSync(path).size);
}

/** Asset kind from the path (`dragons/`, `rocks/`, `props/`), else from the content. */
export function inferKind(path, analysis) {
  const normalized = path.replace(/\\/g, '/').toLowerCase();
  if (/(^|\/)dragons?\//.test(normalized)) return 'dragon';
  if (/(^|\/)(hero-?)?rocks?\//.test(normalized)) return 'rock';
  if (/(^|\/)props?\//.test(normalized)) return 'prop';
  if (analysis && analysis.skins > 0) return 'dragon';
  return null;
}

/**
 * Budget findings for one GLB. `level: 'error'` means over ASSET_BUDGETS (non-zero exit);
 * 'warn' is advice (not compressed, odd sizes).
 */
export function checkGlbBudgets(analysis, kind) {
  const findings = [];
  const error = (message) => findings.push({ level: 'error', message });
  const warn = (message) => findings.push({ level: 'warn', message });
  const lodAt = (index) => analysis.lods.find((lod) => lod.index === index);

  const checkLods = (limits, label, required) => {
    limits.forEach((limit, index) => {
      const lod = lodAt(index);
      if (!lod) {
        if (required) error(`${label}: node LOD${index} is missing`);
        return;
      }
      if (lod.triangles > limit) {
        error(`${label}: LOD${index} has ${lod.triangles} triangles, budget ${limit}`);
      }
      if (lod.triangles === 0) error(`${label}: LOD${index} has no triangles`);
    });
  };
  const checkFile = (limit, label) => {
    if (analysis.fileBytes > limit) {
      error(`${label}: file is ${formatBytes(analysis.fileBytes)}, budget ${formatBytes(limit)}`);
    }
  };

  if (kind === 'dragon') {
    checkLods(BUDGETS.dragonLodTriangles, 'dragon', true);
    checkFile(BUDGETS.dragonMaxFileBytes, 'dragon');
    if (analysis.bones.length > BUDGETS.dragonMaxBones) {
      error(`dragon: ${analysis.bones.length} bones, budget ${BUDGETS.dragonMaxBones}`);
    }
    for (const texture of analysis.textures) {
      if (Math.max(texture.width, texture.height) > BUDGETS.dragonMaxTextureSize) {
        error(
          `dragon: texture "${texture.name}" is ${texture.width}x${texture.height}, ` +
            `budget ${BUDGETS.dragonMaxTextureSize}`,
        );
      }
    }
  } else if (kind === 'rock') {
    if (analysis.lods.length > 0) {
      checkLods(BUDGETS.heroRockLodTriangles, 'rock', false);
      if (!lodAt(0)) error('rock: node LOD0 is missing');
    } else if (analysis.total.triangles > BUDGETS.heroRockLodTriangles[0]) {
      error(
        `rock: ${analysis.total.triangles} triangles and no LOD nodes, ` +
          `budget ${BUDGETS.heroRockLodTriangles[0]}`,
      );
    }
    checkFile(BUDGETS.heroRockMaxFileBytes, 'rock');
  } else if (kind === 'prop') {
    const lod0 = lodAt(0);
    const triangles = lod0 ? lod0.triangles : analysis.total.triangles;
    if (triangles > BUDGETS.propMaxTriangles) {
      error(`prop: ${triangles} triangles, budget ${BUDGETS.propMaxTriangles}`);
    }
    checkFile(BUDGETS.propMaxFileBytes, 'prop');
  }

  for (const texture of analysis.textures) {
    if (texture.mimeType !== 'image/ktx2') {
      warn(`texture "${texture.name}" is ${texture.mimeType}, not KTX2 (run assets:optimize)`);
    }
    if (texture.width % 4 !== 0 || texture.height % 4 !== 0) {
      warn(`texture "${texture.name}" is ${texture.width}x${texture.height}, not a multiple of 4`);
    }
  }
  if (analysis.primitiveCount > 0 && !analysis.extensionsUsed.includes('EXT_meshopt_compression')) {
    warn('not meshopt-compressed (run assets:optimize)');
  }
  if (analysis.extensionsUsed.includes('KHR_draco_mesh_compression')) {
    error('Draco-compressed: the runtime only ships the meshopt decoder');
  }
  return findings;
}
