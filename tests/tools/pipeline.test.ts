/**
 * Asset pipeline tools (tools/pipeline): budget checks, structure preservation in optimize, and
 * the manifest validator, on small GLBs built in memory (no Blender needed).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { Document } from '@gltf-transform/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkKtx2Budgets, inspectPath } from '../../tools/pipeline/inspect.mjs';
import {
  BUDGETS,
  DRAGON_ANIM_CLIPS,
  PIPELINE_DIR,
  findKtxTool,
  parseArgs,
} from '../../tools/pipeline/lib/common.mjs';
import {
  analyzeDocument,
  analyzeFile,
  checkGlbBudgets,
  getIO,
  inferKind,
  lodIndexOf,
} from '../../tools/pipeline/lib/glb.mjs';
import { chooseKtxMode, fitTextureSize, readPngSize } from '../../tools/pipeline/lib/ktx.mjs';
import { checkManifest } from '../../tools/pipeline/manifest.mjs';
import { optimizeGlb } from '../../tools/pipeline/optimize.mjs';

interface DocOptions {
  lodTriangles?: readonly number[];
  bones?: number;
  clips?: readonly string[];
  materials?: readonly string[];
  /** PNG bytes for the first material's base colour. */
  texture?: Uint8Array;
}

/** A dragon-shaped document: LODn nodes, a bone chain, clips, materials, vertex colours. */
function makeDocument(options: DocOptions = {}): Document {
  const lodTriangles = options.lodTriangles ?? [120, 60, 20];
  const boneCount = options.bones ?? 4;
  const materialNames =
    options.materials ?? ['Hide', 'Membrane', 'Runes'].slice(0, lodTriangles.length);
  const document = new Document();
  const buffer = document.createBuffer();
  const scene = document.createScene('Scene');
  const rig = document.createNode('Rig');
  scene.addChild(rig);

  const materials = materialNames.map((name) =>
    // Identical values on purpose: optimize must not merge named tint slots.
    document.createMaterial(name).setBaseColorFactor([0.9, 0.4, 0.2, 1]),
  );
  if (options.texture) {
    const texture = document
      .createTexture('albedo')
      .setImage(options.texture)
      .setMimeType('image/png');
    materials[0]?.setBaseColorTexture(texture);
  }

  const bones = [];
  for (let i = 0; i < boneCount; i++) {
    const bone = document.createNode(`Bone${i}`).setTranslation([0, i === 0 ? 0 : 1, 0]);
    (bones[i - 1] ?? rig).addChild(bone);
    bones.push(bone);
  }
  const skin = boneCount > 0 ? document.createSkin('Skin') : null;
  for (const bone of bones) skin?.addJoint(bone);

  lodTriangles.forEach((triangles, lodIndex) => {
    const vertices = triangles * 3;
    const position = new Float32Array(vertices * 3);
    const color = new Float32Array(vertices * 4);
    const uv = new Float32Array(vertices * 2);
    const joints = new Uint8Array(vertices * 4);
    const weights = new Float32Array(vertices * 4);
    for (let v = 0; v < vertices; v++) {
      // Unique positions, so weld cannot change the triangle count.
      position[v * 3] = (v % 3) + lodIndex * 10;
      position[v * 3 + 1] = Math.floor(v / 3) * 0.01;
      position[v * 3 + 2] = v % 3 === 1 ? 1 : 0;
      color.set([v / vertices, 0.5, 1 - v / vertices, 1], v * 4);
      uv.set([(v % 3) / 2, (v % 7) / 6], v * 2);
      weights[v * 4] = 1;
    }
    const primitive = document
      .createPrimitive()
      .setAttribute(
        'POSITION',
        document.createAccessor().setType('VEC3').setArray(position).setBuffer(buffer),
      )
      .setAttribute(
        'COLOR_0',
        document.createAccessor().setType('VEC4').setArray(color).setBuffer(buffer),
      )
      .setAttribute(
        'TEXCOORD_0',
        document.createAccessor().setType('VEC2').setArray(uv).setBuffer(buffer),
      );
    if (skin) {
      primitive
        .setAttribute(
          'JOINTS_0',
          document.createAccessor().setType('VEC4').setArray(joints).setBuffer(buffer),
        )
        .setAttribute(
          'WEIGHTS_0',
          document.createAccessor().setType('VEC4').setArray(weights).setBuffer(buffer),
        );
    }
    const material = materials[lodIndex % materials.length];
    if (material) primitive.setMaterial(material);
    const node = document
      .createNode(`LOD${lodIndex}`)
      .setMesh(document.createMesh(`LOD${lodIndex}`).addPrimitive(primitive));
    if (skin) node.setSkin(skin);
    rig.addChild(node);
  });
  // Materials not used by a primitive would be pruned; give each one a tiny primitive on LOD0.
  const lod0 = document.getRoot().listMeshes()[0];
  materials.forEach((material, i) => {
    if (i < lodTriangles.length || !lod0) return;
    const array = new Float32Array([50 + i, 0, 0, 51 + i, 0, 0, 50 + i, 1, 0]);
    lod0.addPrimitive(
      document
        .createPrimitive()
        .setAttribute(
          'POSITION',
          document.createAccessor().setType('VEC3').setArray(array).setBuffer(buffer),
        )
        .setMaterial(material),
    );
  });

  // An empty leaf node: a socket the runtime looks up by name.
  (bones[bones.length - 1] ?? rig).addChild(document.createNode('Muzzle'));

  for (const name of options.clips ?? ['glide', 'flap']) {
    const target = bones[0] ?? rig;
    const input = document
      .createAccessor()
      .setType('SCALAR')
      .setArray(new Float32Array([0, 0.5, 1]))
      .setBuffer(buffer);
    const output = document
      .createAccessor()
      .setType('VEC3')
      .setArray(new Float32Array([0, 0, 0, 0, 1, 0, 0, 0, 0]))
      .setBuffer(buffer);
    const sampler = document.createAnimationSampler().setInput(input).setOutput(output);
    const channel = document
      .createAnimationChannel()
      .setTargetNode(target)
      .setTargetPath('translation')
      .setSampler(sampler);
    document.createAnimation(name).addSampler(sampler).addChannel(channel);
  }
  return document;
}

/** Minimal RGB PNG with a gradient (enough for toktx). */
function makePng(width: number, height: number): Uint8Array {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = (x * 255) / width;
      raw[row + 2 + x * 3] = (y * 255) / height;
      raw[row + 3 + x * 3] = 128;
    }
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let workDir = '';

async function writeGlb(relativePath: string, document: Document): Promise<string> {
  const path = join(workDir, relativePath);
  mkdirSync(join(path, '..'), { recursive: true });
  await (await getIO()).write(path, document);
  return path;
}

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'dragonfall-pipeline-test-'));
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('pipeline helpers', () => {
  it('reads LOD indices from node names', () => {
    expect(lodIndexOf('LOD0')).toBe(0);
    expect(lodIndexOf('LOD2_body')).toBe(2);
    expect(lodIndexOf('spire_a_LOD1')).toBe(1);
    expect(lodIndexOf('Rig')).toBe(-1);
    expect(lodIndexOf('MELODY')).toBe(-1);
    expect(lodIndexOf('LOD')).toBe(-1);
  });

  it('caps texture sizes, keeps the aspect ratio and rounds to multiples of 4', () => {
    expect(fitTextureSize(2048, 2048, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(fitTextureSize(4096, 2048, 1024)).toEqual({ width: 1024, height: 512 });
    expect(fitTextureSize(512, 512, 1024)).toEqual({ width: 512, height: 512 });
    expect(fitTextureSize(1000, 30, 1024)).toEqual({ width: 1000, height: 32 });
    expect(fitTextureSize(2, 2, 1024)).toEqual({ width: 4, height: 4 });
  });

  it('picks UASTC for data and small colour maps, ETC1S for large colour maps', () => {
    expect(chooseKtxMode({ srgb: true, width: 1024, height: 1024 })).toBe('etc1s');
    expect(chooseKtxMode({ srgb: true, width: 256, height: 256 })).toBe('uastc');
    expect(chooseKtxMode({ srgb: false, width: 1024, height: 1024 })).toBe('uastc');
    expect(chooseKtxMode({ srgb: true, normal: true, width: 1024, height: 1024 })).toBe('uastc');
    expect(chooseKtxMode({ mode: 'etc1s', srgb: false, width: 64, height: 64 })).toBe('etc1s');
    expect(() => chooseKtxMode({ mode: 'astc', srgb: true, width: 64, height: 64 })).toThrow();
  });

  it('parses CLI arguments', () => {
    const parsed = parseArgs(
      ['in.glb', '--kind', 'dragon', '--quantize-all', 'out.glb', '--max=512'],
      ['quantize-all'],
    );
    expect(parsed.positional).toEqual(['in.glb', 'out.glb']);
    expect(parsed.options).toEqual({ kind: 'dragon', 'quantize-all': true, max: '512' });
    expect(() => parseArgs(['--kind'])).toThrow();
  });

  it('infers the asset kind from the path, then from a skin', () => {
    expect(inferKind('public/assets/dragons/talon/talon.glb')).toBe('dragon');
    expect(inferKind('public\\assets\\maps\\spires\\rocks\\a.glb')).toBe('rock');
    expect(inferKind('public/assets/maps/spires/props/banner.glb')).toBe('prop');
    expect(inferKind('x/chunk_0_0.glb')).toBe(null);
    expect(inferKind('x/thing.glb', analyzeDocument(makeDocument()))).toBe('dragon');
  });

  it('reads PNG sizes', () => {
    expect(readPngSize(makePng(40, 24))).toEqual({ width: 40, height: 24 });
    expect(() => readPngSize(new Uint8Array(32))).toThrow();
  });
});

describe('GLB analysis and budgets', () => {
  it('counts triangles per LOD node, bones, clips, materials and vertex colours', () => {
    const analysis = analyzeDocument(makeDocument({ lodTriangles: [120, 60, 20], bones: 5 }));
    expect(analysis.lods.map((lod) => [lod.index, lod.triangles])).toEqual([
      [0, 120],
      [1, 60],
      [2, 20],
    ]);
    expect(analysis.total.triangles).toBe(200);
    expect(analysis.bones).toHaveLength(5);
    expect(analysis.clips.map((clip) => clip.name)).toEqual(['glide', 'flap']);
    expect(analysis.clips[0]?.duration).toBe(1);
    expect(analysis.materials).toEqual(['Hide', 'Membrane', 'Runes']);
    expect(analysis.colorPrimitives).toBe(3);
    expect(analysis.nodeNames).toContain('Muzzle');
  });

  const errorsOf = (document: Document, kind: 'dragon' | 'rock' | 'prop', fileBytes = 1000) =>
    checkGlbBudgets(analyzeDocument(document, fileBytes), kind)
      .filter((finding) => finding.level === 'error')
      .map((finding) => finding.message);

  it('accepts a dragon exactly at the triangle budgets', () => {
    expect(
      errorsOf(makeDocument({ lodTriangles: [8000, 3000, 1000], bones: 24 }), 'dragon'),
    ).toEqual([]);
  });

  it('rejects a dragon over a LOD, bone or file budget, or with a LOD missing', () => {
    expect(errorsOf(makeDocument({ lodTriangles: [8001, 3000, 1000] }), 'dragon')).toEqual([
      'dragon: LOD0 has 8001 triangles, budget 8000',
    ]);
    expect(errorsOf(makeDocument({ lodTriangles: [100, 50, 1001] }), 'dragon')).toHaveLength(1);
    expect(errorsOf(makeDocument({ bones: 25 }), 'dragon')).toEqual([
      'dragon: 25 bones, budget 24',
    ]);
    expect(errorsOf(makeDocument({ lodTriangles: [100, 50] }), 'dragon')).toEqual([
      'dragon: node LOD2 is missing',
    ]);
    expect(errorsOf(makeDocument(), 'dragon', BUDGETS.dragonMaxFileBytes + 1)).toHaveLength(1);
    expect(errorsOf(makeDocument(), 'dragon', BUDGETS.dragonMaxFileBytes)).toEqual([]);
  });

  it('applies the rock and prop budgets', () => {
    expect(errorsOf(makeDocument({ lodTriangles: [8000, 3000, 800], bones: 0 }), 'rock')).toEqual(
      [],
    );
    expect(
      errorsOf(makeDocument({ lodTriangles: [8000, 3000, 801], bones: 0 }), 'rock'),
    ).toHaveLength(1);
    expect(errorsOf(makeDocument({ lodTriangles: [3000], bones: 0 }), 'prop')).toEqual([]);
    expect(errorsOf(makeDocument({ lodTriangles: [3001], bones: 0 }), 'prop')).toEqual([
      'prop: 3001 triangles, budget 3000',
    ]);
    expect(errorsOf(makeDocument({ bones: 0 }), 'prop', BUDGETS.propMaxFileBytes + 1)).toHaveLength(
      1,
    );
  });

  it('flags an oversized sky panorama', () => {
    const info = {
      width: 4096,
      height: 2048,
      levels: 1,
      codec: 'ETC1S' as const,
      srgb: true,
      supercompression: 'BasisLZ',
    };
    expect(checkKtx2Budgets('maps/x/sky_panorama.ktx2', info, 1000)).toEqual([]);
    expect(
      checkKtx2Budgets('maps/x/sky_panorama.ktx2', info, BUDGETS.skyPanoramaMaxFileBytes + 1),
    ).toHaveLength(1);
    expect(
      checkKtx2Budgets('maps/x/sky_panorama.ktx2', { ...info, width: 8192 }, 1000),
    ).toHaveLength(1);
  });

  it('inspect reports errors for a directory and its CLI exits non-zero', async () => {
    await writeGlb(
      'inspect/props/ok.glb',
      makeDocument({ lodTriangles: [500], bones: 0, clips: [] }),
    );
    const quiet = await inspectPath(join(workDir, 'inspect'), { quiet: true });
    expect(quiet.errors).toBe(0);
    expect(quiet.files).toHaveLength(1);

    await writeGlb(
      'inspect/props/heavy.glb',
      makeDocument({ lodTriangles: [3500], bones: 0, clips: [] }),
    );
    // Over the triangle budget (and, uncompressed, over the file budget too).
    expect((await inspectPath(join(workDir, 'inspect'), { quiet: true })).errors).toBeGreaterThan(
      0,
    );

    const cli = join(PIPELINE_DIR, 'inspect.mjs');
    const bad = spawnSync(process.execPath, [cli, join(workDir, 'inspect')], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('OVER BUDGET: prop: 3500 triangles, budget 3000');
    const good = spawnSync(process.execPath, [cli, join(workDir, 'inspect', 'props', 'ok.glb')], {
      encoding: 'utf8',
    });
    expect(good.status).toBe(0);
  }, 60_000);
});

describe('optimize', () => {
  it('keeps nodes, bones, clips, same-valued materials and vertex colours; adds meshopt', async () => {
    const input = await writeGlb('optimize/raw.glb', makeDocument());
    const output = join(workDir, 'optimize', 'out', 'dragons', 'test.glb');
    const result = await optimizeGlb(input, output, { kind: 'dragon' });
    const before = await analyzeFile(input);
    const after = result.analysis;

    expect(after.nodeNames.sort()).toEqual(before.nodeNames.sort());
    expect(after.nodeNames).toContain('Muzzle');
    expect(after.bones).toEqual(before.bones);
    expect(after.clips.map((clip) => clip.name)).toEqual(['glide', 'flap']);
    expect(after.materials).toEqual(['Hide', 'Membrane', 'Runes']);
    expect(after.colorPrimitives).toBe(before.colorPrimitives);
    expect(after.lods.map((lod) => lod.triangles)).toEqual([120, 60, 20]);
    expect(after.extensionsRequired).toContain('EXT_meshopt_compression');
    expect(result.findings.filter((finding) => finding.level === 'error')).toEqual([]);

    // Default mode leaves positions and UVs as floats, so node transforms and UVs are untouched.
    const json = readGlbJson(output);
    const attributes = json.meshes[0]?.primitives[0]?.attributes ?? {};
    expect(json.accessors[attributes['POSITION'] ?? -1]?.componentType).toBe(5126);
    expect(json.accessors[attributes['TEXCOORD_0'] ?? -1]?.componentType).toBe(5126);
    expect(json.accessors[attributes['COLOR_0'] ?? -1]?.componentType).toBe(5121);
  }, 60_000);

  it.skipIf(!existsSync(findKtxTool('toktx')))(
    'converts textures to KTX2 and caps their size',
    async () => {
      const input = await writeGlb(
        'optimize/textured.glb',
        makeDocument({ texture: makePng(96, 64) }),
      );
      const output = join(workDir, 'optimize', 'textured-out.glb');
      const result = await optimizeGlb(input, output, { kind: 'dragon', maxTextureSize: 32 });
      expect(result.analysis.textures).toHaveLength(1);
      const texture = result.analysis.textures[0];
      expect(texture?.mimeType).toBe('image/ktx2');
      expect([texture?.width, texture?.height]).toEqual([32, 20]);
      expect(result.analysis.extensionsRequired).toContain('KHR_texture_basisu');
    },
    60_000,
  );
});

interface GlbJson {
  accessors: { componentType: number }[];
  meshes: { primitives: { attributes: Record<string, number> }[] }[];
}

function readGlbJson(path: string): GlbJson {
  const bytes = readFileSync(path);
  const length = bytes.readUInt32LE(12);
  return JSON.parse(bytes.subarray(20, 20 + length).toString('utf8')) as GlbJson;
}

describe('manifest check', () => {
  const clips = Object.fromEntries(DRAGON_ANIM_CLIPS.map((name) => [name, name]));
  const dragonManifest = () => ({
    classId: 'talon',
    glb: 'dragons/talon/talon.glb',
    lods: [
      { node: 'LOD0', triangles: 120 },
      { node: 'LOD1', triangles: 60 },
      { node: 'LOD2', triangles: 20 },
    ],
    clips,
    bones: {
      root: 'Bone0',
      head: 'Bone3',
      neck: ['Bone1', 'Bone2'],
      wingLeft: ['Bone1'],
      wingRight: ['Bone2'],
      tail: ['Bone0'],
    },
    tintSlots: { hide: 'Hide', membrane: 'Membrane', runes: 'Runes' },
    wingspan: 14,
    muzzleOffset: { x: 0, y: 0.4, z: 2.1 },
  });
  const gate = (team: number) => ({
    team,
    position: { x: team === 0 ? -400 : 400, y: 300, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    slots: Array.from({ length: 5 }, (_, i) => ({ x: i * 10, y: 300, z: 0 })),
  });
  const mapManifest = () => ({
    id: 'shattered-spires',
    name: 'Shattered Spires',
    size: 2000,
    chunks: [
      {
        id: 'c0',
        lods: ['maps/shattered-spires/c0.glb'],
        center: { x: 0, y: 0, z: 0 },
        radius: 180,
      },
    ],
    props: [
      {
        id: 'banner',
        glb: 'maps/shattered-spires/props/banner.glb',
        instances: 'maps/shattered-spires/props/banner.bin',
        count: 2,
      },
    ],
    sky: {
      sunDirection: { x: 0, y: 0.6, z: 0.8 },
      sunColor: 0xffd9a0,
      fogColor: 0x9fb4d8,
      fogDensity: 0.0004,
    },
    spawnGates: [gate(0), gate(1)],
    colliders: {
      terrain: 'maps/shattered-spires/collision.glb',
      stormCenter: { x: 0, y: 0, z: 0 },
      stormRadius: 1000,
      ceilingY: 900,
      floorY: -50,
      cloudSeaY: -20,
    },
    audio: { ambience: ['audio/wind.ogg'], music: [] },
  });

  let assetsDir = '';
  const writeJson = (relativePath: string, value: unknown): void => {
    const path = join(assetsDir, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  };
  const writeAll = (dragon: unknown, map: unknown): void => {
    writeJson('manifest.json', {
      version: 1,
      dragons: { talon: 'dragons/talon/talon.json' },
      maps: { 'shattered-spires': 'maps/shattered-spires/map.json' },
    });
    writeJson('dragons/talon/talon.json', dragon);
    writeJson('maps/shattered-spires/map.json', map);
  };

  beforeAll(async () => {
    assetsDir = join(workDir, 'assets');
    const clipNames = [...DRAGON_ANIM_CLIPS];
    await writeGlb('assets/dragons/talon/talon.glb', makeDocument({ clips: clipNames }));
    const simple = makeDocument({ lodTriangles: [40], bones: 0, clips: [] });
    await writeGlb('assets/maps/shattered-spires/c0.glb', simple);
    await writeGlb('assets/maps/shattered-spires/collision.glb', simple);
    await writeGlb('assets/maps/shattered-spires/props/banner.glb', simple);
    writeFileSync(join(assetsDir, 'maps/shattered-spires/props/banner.bin'), new Uint8Array(128));
    mkdirSync(join(assetsDir, 'audio'), { recursive: true });
    writeFileSync(join(assetsDir, 'audio/wind.ogg'), new Uint8Array(64));
  });

  it('accepts a complete manifest set', async () => {
    writeAll(dragonManifest(), mapManifest());
    const result = await checkManifest(assetsDir);
    expect(result.errors).toEqual([]);
    expect(result.dragons).toEqual(['talon']);
    expect(result.maps).toEqual(['shattered-spires']);
    expect(result.mapTotals['shattered-spires']?.files).toBe(6);
    expect(result.mapTotals['shattered-spires']?.audioBytes).toBe(64);
  });

  it('reports a missing root manifest', async () => {
    const result = await checkManifest(join(workDir, 'nowhere'));
    expect(result.errors).toHaveLength(1);
  });

  it('cross-checks the dragon manifest against its GLB', async () => {
    const dragon = dragonManifest();
    dragon.lods[1] = { node: 'LOD1', triangles: 61 };
    dragon.bones.head = 'Skull';
    dragon.tintSlots.runes = 'Glow';
    dragon.clips = { ...clips, roar: 'bellow' };
    writeAll(dragon, mapManifest());
    const { errors } = await checkManifest(assetsDir);
    expect(errors).toHaveLength(4);
    expect(errors.join('\n')).toMatch(/lods\[1\]\.triangles says 61, .* has 60/);
    expect(errors.join('\n')).toContain('bone "Skull" is not a node');
    expect(errors.join('\n')).toContain('tint slot material "Glow" is not in');
    expect(errors.join('\n')).toContain('clip "bellow" is not in');
  });

  it('reports structural problems and missing files', async () => {
    const dragon: Record<string, unknown> = dragonManifest();
    dragon['classId'] = 'bastion';
    dragon['glb'] = 'dragons/talon/missing.glb';
    delete dragon['wingspan'];
    dragon['clips'] = { glide: 'glide' };
    const map = mapManifest();
    map.sky.sunDirection = { x: 0, y: 2, z: 0 };
    map.spawnGates[1] = gate(0);
    map.spawnGates[0]?.slots.pop();
    map.colliders.ceilingY = -100;
    map.audio.ambience = ['../secret.ogg'];
    map.props[0] = { ...map.props[0]!, instances: 'maps/shattered-spires/props/none.bin' };
    writeAll(dragon, map);
    const { errors } = await checkManifest(assetsDir);
    const text = errors.join('\n');
    expect(text).toContain('classId is "bastion", listed under "talon"');
    expect(text).toContain('glb "dragons/talon/missing.glb" does not exist');
    expect(text).toContain('wingspan must be a positive number');
    expect(text).toContain('clips.flap is missing');
    expect(text).toContain('sky.sunDirection has length 2.000');
    expect(text).toContain('spawnGates[1].team is 0, expected 1');
    expect(text).toContain('spawnGates[0].slots has 4 spawn points, needs 5');
    expect(text).toContain('colliders.ceilingY must be above floorY');
    expect(text).toContain('must be a path relative to public/assets');
    expect(text).toContain(
      'props[0].instances "maps/shattered-spires/props/none.bin" does not exist',
    );
  });

  it('rejects ids that are not in the contracts and enforces the prop budget', async () => {
    writeAll(dragonManifest(), mapManifest());
    writeJson('manifest.json', {
      version: 1,
      dragons: { wyrm: 'dragons/talon/talon.json' },
      maps: { 'shattered-spires': 'maps/shattered-spires/map.json' },
    });
    await writeGlb(
      'assets/maps/shattered-spires/props/banner.glb',
      makeDocument({ lodTriangles: [3200], bones: 0, clips: [] }),
    );
    const { errors } = await checkManifest(assetsDir);
    expect(errors[0]).toContain('dragons.wyrm is not a dragon class');
    expect(errors.join(' | ')).toContain('prop: 3200 triangles, budget 3000');
  });
});
