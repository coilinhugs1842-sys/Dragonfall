/**
 * The aerie you can see: the placed map assets (./aerie-set.ts) drawn by the map's own prop
 * renderer, plus the team lights (./aerie-glow.ts).
 *
 * The map's GLBs and textures are already being fetched behind the title screen
 * (`loadMapAssets` is cached per map), so this normally builds on the first frames of the
 * lobby. Until they arrive, or when they cannot load, or without a renderer (tests), a plain
 * stand-in is shown instead: a stone post under every perch, so the dragons never sit on air.
 */
import {
  BoxGeometry,
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { Camera, WebGLRenderer } from 'three';
import type { ArenaMap, QualityPreset, Vec3 } from '../../shared';
import { useWorldLight } from '../../world/light';
import { GLOW_MODE_CARVED, createPropField, glowModeOf, loadMapAssets } from '../../world/props';
import type { MapAssetBundle, PropField } from '../../world/props';
import { createAerieGlow } from './aerie-glow';
import type { AerieLayout } from './aerie-layout';
import { aerieBraziers, aerieDetailLevel, aeriePlacements, sameAerieSet } from './aerie-set';

/** What the set costs, refreshed every frame (also on `object.userData.aerieStats` for tools). */
export interface AerieSetStats {
  /** 'standIn' until the map's assets are in; 'fallback' when they could not be loaded. */
  state: 'standIn' | 'ready' | 'fallback';
  /** Draw calls of the set this frame: prop meshes with something to draw, plus the glow. */
  drawCalls: number;
  /** Triangles the set submitted this frame. */
  triangles: number;
  /** Placed pieces of the current preset. */
  placements: number;
}

export interface AerieSetView {
  readonly object: Group;
  readonly stats: Readonly<AerieSetStats>;
  /** How bright a perch's shards are, 0..1 (ready riders). */
  setPerchGlow(slot: number, glow: number): void;
  /** Per frame, after the camera is placed. `camera` null = no culling. Allocation-free. */
  update(eye: Vec3, camera: Camera | null, timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

export interface AerieSetViewOptions {
  readonly map: ArenaMap;
  readonly layout: AerieLayout;
  readonly quality: QualityPreset;
  /** Null = no assets are loaded (tests): the stand-in stays. */
  readonly webgl: WebGLRenderer | null;
}

/**
 * The perch stones' runes are carved here, not lit: on a map their magenta says "objective",
 * and in a close-up the top bar of one showed above the terrace as a flat pink bar. A perch's
 * own light is its team-coloured shards (./aerie-glow.ts).
 */
export function aerieGlowModeOf(typeId: string): number {
  return typeId === 'standing-stone' ? GLOW_MODE_CARVED : glowModeOf(typeId);
}

/** Stand-in post: metres across, and how far it reaches below the perch. */
const POST_WIDTH = 4.4;
const POST_HEIGHT = 30;
/** Palette slate, the colour of unlit greybox stone. */
const POST_HEX = 0x5f7186;

function createStandIn(layout: AerieLayout): InstancedMesh<BoxGeometry, MeshLambertMaterial> {
  const geometry = new BoxGeometry(POST_WIDTH, POST_HEIGHT, POST_WIDTH);
  const material = useWorldLight(new MeshLambertMaterial({ color: new Color().setHex(POST_HEX) }));
  const mesh = new InstancedMesh(geometry, material, layout.perches.length);
  mesh.name = 'aerie-stand-in';
  mesh.matrixAutoUpdate = false;
  mesh.frustumCulled = false;
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3(1, 1, 1);
  const up = new Vector3(0, 1, 0);
  for (const perch of layout.perches) {
    position.set(perch.position.x, perch.position.y - POST_HEIGHT * 0.5, perch.position.z);
    rotation.setFromAxisAngle(up, perch.yaw);
    mesh.setMatrixAt(perch.slot, matrix.compose(position, rotation, scale));
  }
  mesh.instanceMatrix.needsUpdate = true;
  return mesh;
}

/** Load-time. Starts (or joins) the load of the map's assets when there is a renderer. */
export function createAerieSetView(options: AerieSetViewOptions): AerieSetView {
  const { map, layout, webgl } = options;
  let preset = options.quality;
  let disposed = false;
  let bundle: MapAssetBundle | null = null;
  let field: PropField | null = null;

  const object = new Group();
  object.name = 'aerie';
  object.matrixAutoUpdate = false;

  const stats: AerieSetStats = { state: 'standIn', drawCalls: 0, triangles: 0, placements: 0 };
  object.userData['aerieStats'] = stats;

  const glow = createAerieGlow(layout, aerieBraziers(layout));
  // No brazier models yet, so no fire either: a flame hanging in the air would look broken.
  glow.setDetail(-1);
  object.add(glow.mesh);

  const standIn = createStandIn(layout);
  object.add(standIn);

  /**
   * Out of the picture, but kept until `dispose`: the stage may still be warming its shader
   * up in the background (`precompile`), and deleting a program under that check makes WebGL
   * complain. Twelve triangles of memory are not worth the race.
   */
  function hideStandIn(): void {
    standIn.visible = false;
  }

  /** Builds the prop field for the current preset from the loaded bundle. */
  function build(): void {
    if (bundle === null) return;
    const placements = aeriePlacements(layout, preset.id);
    let built: PropField;
    try {
      built = createPropField(placements, bundle, preset, undefined, aerieGlowModeOf);
    } catch (error) {
      console.warn('[aerie] the loaded map assets do not fit the aerie; keeping the stand-in.', error);
      stats.state = 'fallback';
      return;
    }
    if (field !== null) {
      object.remove(field.object);
      field.dispose();
    }
    field = built;
    object.add(built.object);
    stats.state = 'ready';
    stats.placements = placements.length;
    glow.setDetail(aerieDetailLevel(preset.id));
    hideStandIn();
  }

  if (webgl !== null) {
    loadMapAssets(map, webgl).then(
      (loaded) => {
        if (disposed) return;
        bundle = loaded;
        build();
      },
      (error: unknown) => {
        if (disposed) return;
        console.warn('[aerie] the map assets failed to load; the lobby keeps its stand-in.', error);
        stats.state = 'fallback';
      },
    );
  }

  const glowTriangles = glow.trianglesPerInstance * glow.mesh.count;
  const standInTriangles = 12 * layout.perches.length;

  return {
    object,
    stats,

    setPerchGlow(slot: number, value: number): void {
      glow.setPerchGlow(slot, value);
    },

    update(eye: Vec3, camera: Camera | null, timeS: number): void {
      glow.update(timeS);
      let drawCalls = 1;
      let triangles = glowTriangles;
      if (field !== null) {
        field.update(eye, camera, timeS);
        drawCalls += field.stats.meshesDrawn;
        triangles += field.stats.trianglesDrawn;
      } else {
        drawCalls += 1;
        triangles += standInTriangles;
      }
      stats.drawCalls = drawCalls;
      stats.triangles = triangles;
    },

    setQuality(next: QualityPreset): void {
      const before = preset;
      preset = next;
      if (field === null) return;
      // Same list of pieces: the field only changes its LOD distances. Otherwise rebuild it
      // (a preset change is a menu action, not a frame).
      if (sameAerieSet(before.id, next.id)) field.setQuality(next);
      else build();
    },

    dispose(): void {
      disposed = true;
      object.remove(standIn);
      standIn.geometry.dispose();
      standIn.material.dispose();
      standIn.dispose();
      if (field !== null) {
        object.remove(field.object);
        field.dispose();
        field = null;
      }
      object.remove(glow.mesh);
      glow.dispose();
    },
  };
}
