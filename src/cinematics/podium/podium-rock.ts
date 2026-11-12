/**
 * The podium as an object in the scene: a small floating island of the map's own rock, the
 * stepped plinth on it (podium-geometry.ts), two tall banners and the inlays in the winning
 * team's colour (the neutral violet for a draw), and on Medium / High two braziers.
 *
 * TWO VERSIONS
 * - The real one draws the map's shipped geometry (`island-small`, `banner-tall`, `brazier`
 *   from the map's asset bundle, which the map view has already loaded) and the plinth with the
 *   painterly world material, so it takes the same sun, fog and dragon shadows as every other
 *   rock, and compiles no shader of its own (same source and defines as the map's). Each part
 *   is one `InstancedMesh` whose instance matrices are already in world space: the world
 *   material lights instanced meshes by their instance matrix alone.
 * - The stand-in (a plain cone of rock and the plinth, Lambert under the world light) shows
 *   until the bundle is there, and for good without a renderer (node tests, tools) or on a map
 *   that does not ship those assets.
 *
 * COST of the real one: 5 draw calls and about 950 triangles on Low (the rock and banners at
 * their second LOD, no braziers), 6 calls and about 2,500 triangles on Medium and High (on High
 * the rock, plinth and braziers also go into the shadow map). Nothing is updated per frame but
 * one time uniform.
 *
 * Everything here but `setTime` is load-time code.
 */
import {
  BufferGeometry,
  Color,
  DataTexture,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  RGFormat,
  UnsignedByteType,
  Vector3,
} from 'three';
import type { Material, ShaderMaterial, WebGLRenderer } from 'three';
import { TEAMS, TEAM_EMBER, TEAM_FROST } from '../../shared';
import type { ArenaMap, MatchWinner, QualityPreset } from '../../shared';
import { useWorldLight } from '../../world/light';
import {
  TINT_NEUTRAL_INDEX,
  createWorldMaterials,
  loadMapAssets,
  loadedMapAssets,
} from '../../world/props';
import type { MapAssetBundle, WorldMaterials } from '../../world/props';
import { buildPodiumSteps, buildStandInRock } from './podium-geometry';
import { ISLAND_DEPTH, ISLAND_SCALE } from './podium-layout';
import type { PodiumSite } from './podium-layout';

/** Asset ids of the map's bundle the podium is dressed with. */
const ISLAND_ASSET = 'island-small';
const BANNER_ASSET = 'banner-tall';
const BRAZIER_ASSET = 'brazier';

/**
 * The island's own standing rocks leave about 160 degrees of its rim free. It is turned so
 * that free arc faces the camera: this bearing for a site with the sun (and the podium shot)
 * on the right, the other for a mirrored one.
 */
const ISLAND_YAW = -0.82;
const ISLAND_YAW_MIRRORED = -1.41;
/** The island's top is a low dome; it sits this much lower so the plinth covers it. */
const ISLAND_Y = -0.2;
/** Banners behind the outer steps: site X (mirrored for the left one), Y, Z, and their scale. */
const BANNER_X = 16.6;
const BANNER_Y = -0.3;
const BANNER_Z = -5.6;
/** Standards rather than the map's tall banners: their tops stay below the dragons hovering behind. */
const BANNER_SCALE = 0.56;
/** `banner-tall` as shipped: 18.6 m of pole; the cloth sways like the map's own banners. */
const BANNER_HEIGHT = 18.6;
const CLOTH_SWING = 0.045;
/** Braziers beside the plinth. */
const BRAZIER_X = 19.2;
const BRAZIER_Y = -0.1;
const BRAZIER_Z = 2.4;
/** Radius of the stand-in's rock, metres. */
const STAND_IN_RADIUS = 24;
/** sRGB hex of the stand-in's inlays in a draw (the world material's neutral violet). */
const NEUTRAL_ACCENT = 0x8f7fb0;

export interface PodiumRock {
  readonly object: Group;
  /** Puts the podium at `site` and makes sure the map's real rock is (being) loaded. */
  place(site: PodiumSite, map: ArenaMap): void;
  /** Team colour of the banners and inlays. */
  setWinner(winner: MatchWinner): void;
  setQuality(preset: QualityPreset): void;
  /** Per frame: the clock of the cloth, the flames and the glow pulse. Allocation-free. */
  setTime(timeS: number): void;
  /** True once the real rock is drawn instead of the stand-in. */
  readonly real: boolean;
  dispose(): void;
}

/** One instance of a part: place in the site frame, turn and scale. */
interface PartInstance {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly scale: number;
}

/** One draw call of the real podium. */
interface Part {
  readonly mesh: InstancedMesh<BufferGeometry, ShaderMaterial>;
  readonly inst: InstancedBufferAttribute;
  readonly instances: readonly PartInstance[];
  /** Site-relative places that swap sides on a mirrored site keep their own list. */
  readonly mirrored: readonly PartInstance[];
  readonly castsShadow: boolean;
}

interface RealSet {
  readonly mapId: string;
  readonly bundle: MapAssetBundle;
  readonly materials: WorldMaterials;
  readonly farState: DataTexture;
  readonly parts: Part[];
  /** Wrapper geometries (they share the bundle's vertex data) to free with the set. */
  readonly wrappers: BufferGeometry[];
}

function winnerIndex(winner: MatchWinner): number {
  return winner === TEAM_EMBER ? 0 : winner === TEAM_FROST ? 1 : TINT_NEUTRAL_INDEX;
}

/** A geometry that shares `source`'s vertex data and adds the per-instance attribute. */
function instancedGeometry(source: BufferGeometry, inst: InstancedBufferAttribute): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setIndex(source.getIndex());
  for (const name in source.attributes) {
    const attribute = source.attributes[name];
    // `color` is for the stand-in's Lambert material only.
    if (attribute !== undefined && name !== 'color') geometry.setAttribute(name, attribute);
  }
  geometry.setAttribute('aInst', inst);
  geometry.boundingSphere = source.boundingSphere;
  geometry.boundingBox = source.boundingBox;
  return geometry;
}

export function createPodiumRock(initial: QualityPreset, webgl: WebGLRenderer | null): PodiumRock {
  let preset = initial;
  let winner: MatchWinner = 'draw';
  let disposed = false;
  /** Bumped by every `place` and by `dispose`: a load that finishes later knows it is stale. */
  let loadToken = 0;
  let real: RealSet | null = null;

  const site: PodiumSite = { x: 0, y: 0, z: 0, yaw: 0, sin: 0, cos: 1, mirror: 1 };

  const object = new Group();
  object.name = 'podium';
  object.matrixAutoUpdate = false;

  const steps = buildPodiumSteps();

  // --- Stand-in ------------------------------------------------------------------------------------
  const standIn = new Group();
  standIn.name = 'podium-stand-in';
  standIn.matrixAutoUpdate = false;
  const standInRock = buildStandInRock(STAND_IN_RADIUS, ISLAND_DEPTH);
  const standInStone = useWorldLight(new MeshLambertMaterial({ vertexColors: true }));
  const standInAccent = useWorldLight(new MeshBasicMaterial({ color: NEUTRAL_ACCENT }));
  const standInMeshes: Mesh<BufferGeometry, Material>[] = [
    new Mesh(standInRock, standInStone),
    new Mesh(steps.stone, standInStone),
    new Mesh(steps.accent, standInAccent),
  ];
  for (const mesh of standInMeshes) {
    mesh.matrixAutoUpdate = false;
    standIn.add(mesh);
  }
  object.add(standIn);

  // --- Real set --------------------------------------------------------------------------------------
  const siteMatrix = new Matrix4();
  const localMatrix = new Matrix4();
  const scratchPosition = new Vector3();
  const scratchQuaternion = new Quaternion();
  const scratchScale = new Vector3();
  const up = new Vector3(0, 1, 0);

  function addPart(
    set: RealSet,
    source: BufferGeometry | null | undefined,
    material: ShaderMaterial,
    name: string,
    instances: readonly PartInstance[],
    mirrored: readonly PartInstance[],
    glowMode: number,
    castsShadow: boolean,
  ): void {
    if (source === null || source === undefined) return;
    const count = instances.length;
    const data = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      data[i * 4] = 1; // fully faded in
      data[i * 4 + 1] = (i * 0.618034 + 0.137) % 1; // phase of the sway, flicker and pulse
      data[i * 4 + 2] = glowMode;
      data[i * 4 + 3] = winnerIndex(winner);
    }
    const inst = new InstancedBufferAttribute(data, 4);
    const geometry = instancedGeometry(source, inst);
    set.wrappers.push(geometry);
    const mesh = new InstancedMesh(geometry, material, count);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    object.add(mesh);
    set.parts.push({ mesh, inst, instances, mirrored, castsShadow });
  }

  /** Writes every part's world-space instance matrices for the current site. */
  function positionReal(set: RealSet): void {
    siteMatrix.makeRotationY(site.yaw);
    siteMatrix.setPosition(site.x, site.y, site.z);
    for (const part of set.parts) {
      const list = site.mirror < 0 ? part.mirrored : part.instances;
      for (let i = 0; i < list.length; i++) {
        const place = list[i];
        if (place === undefined) continue;
        scratchPosition.set(place.x, place.y, place.z);
        scratchQuaternion.setFromAxisAngle(up, place.yaw);
        scratchScale.setScalar(place.scale);
        localMatrix.compose(scratchPosition, scratchQuaternion, scratchScale);
        localMatrix.premultiply(siteMatrix);
        part.mesh.setMatrixAt(i, localMatrix);
      }
      part.mesh.instanceMatrix.needsUpdate = true;
      // Culled as one object by the sphere round its instances.
      part.mesh.computeBoundingSphere();
      part.mesh.castShadow = part.castsShadow && preset.shadowCasters === 'all';
    }
  }

  function disposeReal(): void {
    if (real === null) return;
    for (const part of real.parts) {
      object.remove(part.mesh);
      // Frees the instance buffers; the vertex data belongs to the map's bundle and stays.
      part.mesh.dispose();
    }
    for (const geometry of real.wrappers) geometry.dispose();
    real.materials.dispose();
    real.farState.dispose();
    real = null;
    standIn.visible = true;
  }

  /** Builds the real podium from a loaded bundle; throws when it lacks what the podium needs. */
  function buildReal(bundle: MapAssetBundle, mapId: string): RealSet {
    const stone = bundle.textures.get('stone');
    const island = bundle.assets.get(ISLAND_ASSET);
    if (stone === undefined || island === undefined || island.lods.length === 0) {
      throw new Error('podium: the map bundle has no stone texture or no island-small');
    }
    // The world material's far-mesh variant wants a state texture; the podium has no far mesh.
    const farState = new DataTexture(new Uint8Array(2), 1, 1, RGFormat, UnsignedByteType);
    const materials = createWorldMaterials(
      {
        stone,
        masonry: bundle.textures.get('masonry') ?? stone,
        moss: bundle.textures.get('moss') ?? stone,
        cliff: bundle.textures.get('cliff') ?? stone,
        brush: bundle.textures.get('brush') ?? stone,
      },
      farState,
      preset,
    );
    const set: RealSet = { mapId, bundle, materials, farState, parts: [], wrappers: [] };
    const low = preset.id === 'low';
    const pick = <T>(lods: readonly T[]): T | undefined => lods[Math.min(low ? 1 : 0, lods.length - 1)];

    const one: PartInstance = { x: 0, y: 0, z: 0, yaw: 0, scale: 1 };
    const islandLod = pick(island.lods);
    addPart(
      set,
      islandLod?.stone,
      materials.rock,
      'podium-island',
      [{ x: 0, y: ISLAND_Y, z: 0, yaw: ISLAND_YAW, scale: ISLAND_SCALE }],
      [{ x: 0, y: ISLAND_Y, z: 0, yaw: ISLAND_YAW_MIRRORED, scale: ISLAND_SCALE }],
      0,
      true,
    );
    addPart(set, steps.stone, materials.prop, 'podium-steps', [one], [one], 0, true);
    addPart(set, steps.accent, materials.tint, 'podium-inlays', [one], [one], 0, false);

    // The banners stand behind the outer steps, cloth outward, face to the camera.
    const banners: PartInstance[] = [
      { x: BANNER_X, y: BANNER_Y, z: BANNER_Z, yaw: Math.PI * 0.5, scale: BANNER_SCALE },
      { x: -BANNER_X, y: BANNER_Y, z: BANNER_Z, yaw: -Math.PI * 0.5, scale: BANNER_SCALE },
    ];
    const banner = bundle.assets.get(BANNER_ASSET);
    const bannerLod = banner !== undefined ? pick(banner.lods) : undefined;
    addPart(set, bannerLod?.stone, materials.prop, 'podium-banner-poles', banners, banners, 0, false);
    if (bannerLod?.tint !== null && bannerLod?.tint !== undefined) {
      const cloth = materials.createCloth(
        BANNER_HEIGHT * 0.94,
        BANNER_HEIGHT * 0.85,
        BANNER_HEIGHT * CLOTH_SWING,
      );
      addPart(set, bannerLod.tint, cloth, 'podium-banner-cloth', banners, banners, 0, false);
    }
    // The braziers are dressing: Low leaves them out.
    if (!low) {
      const braziers: PartInstance[] = [
        { x: BRAZIER_X, y: BRAZIER_Y, z: BRAZIER_Z, yaw: 0.4, scale: 1 },
        { x: -BRAZIER_X, y: BRAZIER_Y, z: BRAZIER_Z, yaw: -0.4, scale: 1 },
      ];
      const brazier = bundle.assets.get(BRAZIER_ASSET);
      const brazierLod = brazier !== undefined ? pick(brazier.lods) : undefined;
      // Glow mode 1: the flame flickers and licks (see the world material).
      addPart(set, brazierLod?.stone, materials.prop, 'podium-braziers', braziers, braziers, 1, true);
    }
    return set;
  }

  /** The stand-in leaves, the real set is drawn (or the other way round when it cannot be). */
  function adopt(bundle: MapAssetBundle, mapId: string): void {
    disposeReal();
    try {
      real = buildReal(bundle, mapId);
    } catch (error) {
      console.warn('[podium] keeping the stand-in rock.', error);
      real = null;
      return;
    }
    positionReal(real);
    standIn.visible = false;
  }

  function place(next: PodiumSite, map: ArenaMap): void {
    site.x = next.x;
    site.y = next.y;
    site.z = next.z;
    site.yaw = next.yaw;
    site.sin = next.sin;
    site.cos = next.cos;
    site.mirror = next.mirror;
    standIn.position.set(site.x, site.y, site.z);
    standIn.rotation.set(0, site.yaw, 0);
    standIn.updateMatrix();

    const token = ++loadToken;
    if (real !== null && real.mapId === map.id) {
      positionReal(real);
      return;
    }
    disposeReal();
    // A map without the island (a greybox) has nothing to load: the stand-in stays.
    if (webgl === null || !map.props.some((set) => set.id === ISLAND_ASSET)) return;
    const ready = loadedMapAssets(map.id, webgl);
    if (ready !== null) {
      adopt(ready, map.id);
      return;
    }
    loadMapAssets(map, webgl).then(
      (bundle) => {
        if (!disposed && token === loadToken) adopt(bundle, map.id);
      },
      () => {
        // The map view reports a failed load; the podium just keeps its stand-in.
      },
    );
  }

  const accentColor = new Color();

  function setWinner(next: MatchWinner): void {
    winner = next;
    accentColor.setHex(
      next === TEAM_EMBER || next === TEAM_FROST ? TEAMS[next].color : NEUTRAL_ACCENT,
    );
    standInAccent.color.copy(accentColor);
    if (real === null) return;
    const index = winnerIndex(next);
    for (const part of real.parts) {
      const data = part.inst.array;
      for (let i = 3; i < data.length; i += 4) data[i] = index;
      part.inst.needsUpdate = true;
    }
  }

  function setQuality(next: QualityPreset): void {
    if (next.id === preset.id) return;
    preset = next;
    if (real === null) return;
    // Another preset draws other LODs and leaves the braziers out or in: build the few
    // wrappers again from the same bundle (no fetch, no decode).
    const { bundle, mapId } = real;
    adopt(bundle, mapId);
  }

  return {
    object,
    place,
    setWinner,
    setQuality,
    setTime(timeS: number): void {
      if (real !== null) real.materials.setTime(timeS);
    },
    get real(): boolean {
      return real !== null;
    },
    dispose(): void {
      disposed = true;
      loadToken++;
      disposeReal();
      steps.stone.dispose();
      steps.accent.dispose();
      standInRock.dispose();
      standInStone.dispose();
      standInAccent.dispose();
      object.clear();
    },
  };
}
