/**
 * Dev-only load check: proves that the three.js build the game ships can load what the pipeline
 * wrote, with the same decoders the runtime uses (MeshoptDecoder from three/addons, KTX2Loader
 * with the Basis transcoder that vite.config.ts copies to /vendor/basis/).
 *
 *   npm run dev -- --port 5211
 *   http://localhost:5211/tools/pipeline/verify.html?file=/art-source/_scratch/x.glb[&clip=flap]
 *   ...?file=/assets/textures/x.ktx2             shows the texture on a quad
 *   ...?file=/path/x.ogg                        decodes it with decodeAudioData
 *
 * The result is shown on the page and left in `window.__verify` for a CDP script.
 * Not part of the game build; it may allocate freely.
 */
import {
  AmbientLight,
  AnimationMixer,
  Box3,
  Color,
  DirectionalLight,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SkinnedMesh,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import type { Material, Object3D, Texture } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

interface VerifyResult {
  file: string;
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __verify?: { done: boolean; results: VerifyResult[] };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const logElement = document.getElementById('log') as HTMLPreElement;
const params = new URLSearchParams(location.search);
const files = params.getAll('file');
const clipName = params.get('clip');

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight, false);
const scene = new Scene();
scene.background = new Color(0x1b2233);
scene.add(new AmbientLight(0xbfd0ff, 1.1));
const sun = new DirectionalLight(0xffd9a0, 2.4);
sun.position.set(3, 5, 4);
scene.add(sun);
const camera = new PerspectiveCamera(40, innerWidth / innerHeight, 0.05, 2000);

const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/').detectSupport(renderer);
const gltfLoader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);

const mixers: AnimationMixer[] = [];
const results: VerifyResult[] = [];
window.__verify = { done: false, results };

function describeTexture(texture: Texture | null): Record<string, unknown> | null {
  if (!texture) return null;
  const image = texture.image as { width?: number; height?: number } | undefined;
  return {
    name: texture.name,
    width: image?.width ?? 0,
    height: image?.height ?? 0,
    compressed: (texture as { isCompressedTexture?: boolean }).isCompressedTexture === true,
    gpuFormat: texture.format,
    mipLevels: texture.mipmaps?.length ?? 0,
    colorSpace: texture.colorSpace,
  };
}

function frame(object: Object3D, offsetX: number): void {
  const box = new Box3().setFromObject(object);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());
  object.position.x += offsetX - center.x;
  const radius = Math.max(size.x, size.y, size.z, 0.001);
  camera.position.set(radius * 1.2, center.y + radius * 0.5, radius * 2.2);
  camera.lookAt(0, center.y, 0);
}

async function checkGlb(file: string): Promise<VerifyResult> {
  const gltf = await gltfLoader.loadAsync(file);
  const nodes: string[] = [];
  const lodNodes: Record<string, number> = {};
  const meshes: Record<string, unknown>[] = [];
  const materials = new Map<string, Material>();
  const bones = new Set<string>();

  gltf.scene.traverse((object) => {
    if (object.name) nodes.push(object.name);
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    const triangles = (index ? index.count : position.count) / 3;
    const attributes: Record<string, string> = {};
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      attributes[name] =
        `${attribute.array.constructor.name}x${attribute.itemSize}` +
        (attribute.normalized ? ' normalized' : '');
    }
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.set(material.name, material);
    const skinned = object as SkinnedMesh;
    if (skinned.isSkinnedMesh) {
      for (const bone of skinned.skeleton.bones) bones.add(bone.name);
    }
    // Attribute the mesh to its outermost ancestor named like a LOD node. (GLTFLoader turns a
    // node whose mesh has several primitives into a Group `LOD0` with children `LOD0_1`, ...)
    let lod: Object3D | null = null;
    for (let at: Object3D | null = object; at; at = at.parent) {
      if (/(^|[_.\- ])LOD\d($|[_.\- ])/i.test(at.name)) lod = at;
    }
    if (lod) lodNodes[lod.name] = (lodNodes[lod.name] ?? 0) + triangles;
    meshes.push({
      name: object.name,
      parent: object.parent?.name ?? '',
      skinned: skinned.isSkinnedMesh === true,
      triangles,
      material: list.map((material) => material.name).join(','),
      vertexColors: list.every((material) => material.vertexColors),
      attributes,
    });
  });

  const textures: Record<string, unknown>[] = [];
  for (const material of materials.values()) {
    const map = (material as { map?: Texture | null }).map ?? null;
    const described = describeTexture(map);
    if (described) textures.push({ material: material.name, slot: 'map', ...described });
  }

  // Show LOD0 only when the file has LOD nodes, so the screenshot is not three meshes overlapped.
  const lodNames = Object.keys(lodNodes).sort();
  gltf.scene.traverse((object) => {
    if (lodNames.includes(object.name) && object.name !== lodNames[0]) object.visible = false;
  });
  scene.add(gltf.scene);
  frame(gltf.scene, 0);

  const clip = gltf.animations.find((entry) => entry.name === clipName) ?? gltf.animations[0];
  if (clip) {
    const mixer = new AnimationMixer(gltf.scene);
    mixer.clipAction(clip).play();
    mixers.push(mixer);
  }

  return {
    file,
    ok: true,
    type: 'glb',
    nodes,
    lodNodes,
    meshes,
    bones: [...bones],
    clips: gltf.animations.map((entry) => ({
      name: entry.name,
      duration: Number(entry.duration.toFixed(3)),
      tracks: entry.tracks.length,
    })),
    materials: [...materials.keys()],
    textures,
    playing: clip?.name ?? null,
    extensionsUsed: (gltf.parser.json as { extensionsUsed?: string[] }).extensionsUsed ?? [],
  };
}

async function checkKtx2(file: string, slot: number): Promise<VerifyResult> {
  const texture = await ktx2.loadAsync(file);
  const image = texture.image as { width: number; height: number };
  const aspect = image.width / image.height;
  // KTX2 images are stored top row first and cannot be flipped on upload: v = 0 is the TOP.
  const quad = new Mesh(
    new PlaneGeometry(2 * aspect, 2),
    new MeshBasicMaterial({ map: texture, side: DoubleSide }),
  );
  quad.scale.y = -1;
  quad.position.set(slot * 2.2 * aspect, 0, 0);
  scene.add(quad);
  camera.position.set(slot * 1.1 * aspect, 0, 4.2 + slot * 2.4);
  camera.lookAt(slot * 1.1 * aspect, 0, 0);
  return { file, ok: true, type: 'ktx2', ...describeTexture(texture) };
}

async function checkAudio(file: string): Promise<VerifyResult> {
  const response = await fetch(file);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const context = new OfflineAudioContext(2, 44100, 44100);
  const buffer = await context.decodeAudioData(await response.arrayBuffer());
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i] ?? 0));
  }
  return {
    file,
    ok: true,
    type: 'audio',
    duration: Number(buffer.duration.toFixed(3)),
    channels: buffer.numberOfChannels,
    sampleRate: buffer.sampleRate,
    samplePeakDb: Number((20 * Math.log10(peak)).toFixed(2)),
  };
}

async function main(): Promise<void> {
  let textureSlot = 0;
  for (const file of files) {
    try {
      if (/\.glb$/i.test(file)) results.push(await checkGlb(file));
      else if (/\.ktx2$/i.test(file)) results.push(await checkKtx2(file, textureSlot++));
      else if (/\.ogg$/i.test(file)) results.push(await checkAudio(file));
      else results.push({ file, ok: false, error: 'unknown file type' });
    } catch (error) {
      results.push({
        file,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logElement.textContent =
    files.length === 0
      ? 'usage: verify.html?file=/path/to/asset.glb|.ktx2|.ogg (repeatable) [&clip=name]'
      : JSON.stringify(results, null, 1);

  const timer = new Timer();
  let frames = 0;
  renderer.setAnimationLoop((time) => {
    timer.update(time);
    const delta = timer.getDelta();
    for (const mixer of mixers) mixer.update(delta);
    renderer.render(scene, camera);
    // Two rendered frames, so compressed textures are uploaded before a script reads `done`.
    if (++frames === 2 && window.__verify) window.__verify.done = true;
  });
}

addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
});

void main();
