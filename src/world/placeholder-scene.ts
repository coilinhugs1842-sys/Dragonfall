/**
 * Phase 0 placeholder: a flat sky colour and one slowly turning low-poly rock, enough to prove
 * that the renderer draws and that render interpolation between two sim ticks works.
 *
 * Throwaway: the real sky is T-1.4 and the real title backdrop comes with the aerie (Phase 5).
 * Colours are from the docs/ART_DIRECTION.md palette and midday lighting recipe.
 */
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  IcosahedronGeometry,
  Mesh,
  MeshLambertMaterial,
  PerspectiveCamera,
  Scene,
} from 'three';

const SKY_PEACH = 0xf2b984;
const STONE_SLATE = 0x4e6a86;
const SUN_WARM = 0xffd9a0;
const HEMI_SKY = 0x9fb7d9;
const HEMI_GROUND = 0x3f5a55;

const SUN_INTENSITY = 2.2;
const SUN_ELEVATION_RAD = (18 * Math.PI) / 180;
const HEMI_INTENSITY = 1.0;

const CAMERA_FOV_DEG = 60;
const CAMERA_DISTANCE = 4;
/** Radians per simulated second: one turn in about 16 s. */
const SPIN_RATE = 0.4;
const TILT_RATE = 0.15;

export interface PlaceholderScene {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Call when the canvas aspect ratio (width / height) changes. */
  setAspect(aspect: number): void;
  /**
   * Poses the rock for this frame at the sim time interpolated between the previous and the
   * latest tick: `alpha` 0 is `prevTimeS`, 1 is `currentTimeS`. Allocation-free.
   */
  update(prevTimeS: number, currentTimeS: number, alpha: number): void;
  dispose(): void;
}

export function createPlaceholderScene(): PlaceholderScene {
  const scene = new Scene();
  scene.background = new Color(SKY_PEACH);

  const camera = new PerspectiveCamera(CAMERA_FOV_DEG, 1, 0.1, 100);
  camera.position.set(0, 0.6, CAMERA_DISTANCE);
  camera.lookAt(0, 0, 0);

  const geometry = new IcosahedronGeometry(1, 0);
  const material = new MeshLambertMaterial({ color: STONE_SLATE, flatShading: true });
  const rock = new Mesh(geometry, material);
  scene.add(rock);

  const sun = new DirectionalLight(SUN_WARM, SUN_INTENSITY);
  sun.position.set(Math.cos(SUN_ELEVATION_RAD), Math.sin(SUN_ELEVATION_RAD), 0.6);
  scene.add(sun);
  scene.add(new HemisphereLight(HEMI_SKY, HEMI_GROUND, HEMI_INTENSITY));

  return {
    scene,
    camera,
    setAspect(aspect: number): void {
      if (!(aspect > 0) || aspect === camera.aspect) return;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    },
    update(prevTimeS: number, currentTimeS: number, alpha: number): void {
      const timeS = prevTimeS + (currentTimeS - prevTimeS) * alpha;
      rock.rotation.y = timeS * SPIN_RATE;
      rock.rotation.x = timeS * TILT_RATE;
    },
    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}
