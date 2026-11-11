/**
 * Dev viewer for the dragon assets: `?viewer=dragon:<class>` (talon, bastion, tempest, wraith,
 * or `all` for the four side by side; add `&quality=low|medium|high`).
 *
 * It draws through the game's own renderer (post pass included), sky, lights and world
 * lighting, and through the real `createDragons` view fed a hand-made WorldView, so what it
 * shows is what a match shows. Buttons: clip, LOD, team, state flags, preset. A readout gives
 * triangles and draw calls of the whole frame and of the dragons alone.
 *
 * URL parameters, for screenshots from a script (all optional):
 *   clip=flap        play one clip (`auto` = the state machine)      phase=0.25  hold it there
 *   lod=0|1|2|3      force a level (3 = the far instanced dragon)    team=0|1
 *   yaw=35 elev=12   camera bearing and elevation in degrees         dist=1.6    x the radius
 *   spin=20          camera orbit in degrees per second (0 = still)
 *   flags=shield,spawn,veil,phase,charge,fire,boost,dead             health=0.2
 *   fly=1            fly a banking circle with a chase camera        n=10        a crowd
 *   slots=1          show the material slots                         ground=1    a shadow catcher
 *   muzzle=1         mark the manifest's muzzle point
 * `window.__viewer` exposes `ready`, `set(params)`, `stats()` and `bench()` to the same script.
 *
 * Dev-only: fetched as its own chunk when the flag is present, and it may allocate freely
 * outside its frame function.
 */

import {
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three';
import {
  advanceDragonAnim,
  createDragonAnimInput,
  createDragonAnimState,
  createDragons,
  createPoseAccumulator,
  sharedDragonAssetLibrary,
  writeDragonPose,
} from '../dragons';
import type { DragonAsset } from '../dragons';
import type { GameRenderer } from '../render';
import {
  DRAGON_ANIM_CLIPS,
  DRAGON_ANIM_GLIDE,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  DRAGON_FLAG_BOOSTING,
  DRAGON_FLAG_CHARGING,
  DRAGON_FLAG_FIRING,
  DRAGON_FLAG_PHASING,
  DRAGON_FLAG_SHIELDED,
  DRAGON_FLAG_SPAWN_PROTECTED,
  DRAGON_FLAG_VEILED,
  QUALITY_PRESETS,
  QUALITY_PRESET_IDS,
  SHATTERED_SPIRES_DEFAULT_SEED,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createShatteredSpires,
  createWorldView,
  isDragonClassId,
} from '../shared';
import type { DragonAnimClip, DragonClassId, QualityPresetId, TeamId } from '../shared';
import { createWorldLighting, useWorldLight } from '../world/light';
import { applySkyFog, createSkyDome, createSkyLights } from '../world/sky';

const FLAG_NAMES: Readonly<Record<string, number>> = {
  shield: DRAGON_FLAG_SHIELDED,
  spawn: DRAGON_FLAG_SPAWN_PROTECTED,
  veil: DRAGON_FLAG_VEILED,
  phase: DRAGON_FLAG_PHASING,
  charge: DRAGON_FLAG_CHARGING,
  fire: DRAGON_FLAG_FIRING,
  boost: DRAGON_FLAG_BOOSTING,
};

export interface DragonViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLElement;
  readonly renderer: GameRenderer;
  /** The value of `?viewer=`: `dragon:talon`, `dragon:all`, `dragon`. */
  readonly spec: string;
}

interface ViewerState {
  classes: DragonClassId[];
  clip: DragonAnimClip | null;
  phase: number;
  lod: number;
  team: TeamId;
  yawDeg: number;
  elevDeg: number;
  dist: number;
  spinDeg: number;
  flags: number;
  dead: boolean;
  health: number;
  fly: boolean;
  count: number;
  slots: boolean;
  ground: boolean;
  muzzle: boolean;
  hitPulse: boolean;
}

function parseClasses(spec: string): DragonClassId[] {
  const name = spec.includes(':') ? (spec.split(':')[1] ?? '').trim().toLowerCase() : '';
  if (name === 'all') return [...DRAGON_CLASS_IDS];
  return [isDragonClassId(name) ? name : 'talon'];
}

function numberParam(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function applyParams(state: ViewerState, params: URLSearchParams): void {
  const clip = params.get('clip');
  if (clip !== null) {
    state.clip = (DRAGON_ANIM_CLIPS as readonly string[]).includes(clip)
      ? (clip as DragonAnimClip)
      : null;
  }
  state.phase = numberParam(params, 'phase', state.phase);
  state.lod = numberParam(params, 'lod', state.lod);
  state.team = numberParam(params, 'team', state.team) === 1 ? TEAM_FROST : TEAM_EMBER;
  state.yawDeg = numberParam(params, 'yaw', state.yawDeg);
  state.elevDeg = numberParam(params, 'elev', state.elevDeg);
  state.dist = numberParam(params, 'dist', state.dist);
  state.spinDeg = numberParam(params, 'spin', state.spinDeg);
  state.health = numberParam(params, 'health', state.health);
  state.count = Math.max(1, Math.min(10, Math.floor(numberParam(params, 'n', state.count))));
  if (params.has('fly')) state.fly = params.get('fly') !== '0';
  if (params.has('slots')) state.slots = params.get('slots') !== '0';
  if (params.has('ground')) state.ground = params.get('ground') !== '0';
  if (params.has('muzzle')) state.muzzle = params.get('muzzle') !== '0';
  const flags = params.get('flags');
  if (flags !== null) {
    state.flags = 0;
    state.dead = false;
    for (const part of flags.split(',')) {
      const key = part.trim().toLowerCase();
      if (key === 'dead') state.dead = true;
      else state.flags |= FLAG_NAMES[key] ?? 0;
    }
  }
}

export interface DragonViewer {
  dispose(): void;
}

export function startDragonViewer(options: DragonViewerOptions): DragonViewer {
  const { canvas, uiRoot, renderer } = options;
  const params = new URLSearchParams(location.search);
  const state: ViewerState = {
    classes: parseClasses(options.spec),
    clip: null,
    phase: -1,
    lod: -1,
    team: TEAM_EMBER,
    yawDeg: 35,
    elevDeg: 12,
    dist: 1.7,
    spinDeg: 18,
    flags: 0,
    dead: false,
    health: 1,
    fly: false,
    count: 1,
    slots: false,
    ground: false,
    muzzle: false,
    hitPulse: false,
  };
  applyParams(state, params);

  // --- Scene: the game's own sky, lights and shared lighting ----------------------------------
  const map = createShatteredSpires(SHATTERED_SPIRES_DEFAULT_SEED);
  const scene = new Scene();
  applySkyFog(scene, map.sky);
  const sky = createSkyDome(map.sky);
  const lights = createSkyLights(map.sky);
  const lighting = createWorldLighting({ sky: map.sky, lights, cloudSeaY: -400 });
  scene.add(sky.object, lights.sun, lights.hemisphere, lighting.object);

  const ground = new Mesh(
    new CircleGeometry(60, 48).rotateX(-Math.PI / 2),
    useWorldLight(new MeshStandardMaterial({ color: 0x8a8f9c, roughness: 1 })),
  );
  ground.position.y = -5;
  scene.add(ground);

  const muzzleMarker = new Mesh(
    new SphereGeometry(0.12, 12, 8),
    new MeshBasicMaterial({ color: 0xff00ff, fog: false }),
  );
  scene.add(muzzleMarker);

  const camera = new PerspectiveCamera(38, 1, 0.3, 4000);
  const library = sharedDragonAssetLibrary(renderer.webgl);
  let presetId: QualityPresetId = renderer.presetId;
  const dragons = createDragons(QUALITY_PRESETS[presetId], { showDead: true, library });
  scene.add(dragons.object);

  function applyQuality(): void {
    const preset = QUALITY_PRESETS[presetId];
    sky.setQuality(preset);
    lights.setQuality(preset);
    lighting.setQuality(preset);
    dragons.setQuality(preset);
  }
  applyQuality();

  const view = createWorldView();
  const orientation = new Quaternion();
  const bank = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const forwardAxis = new Vector3(0, 0, 1);
  const leftAxis = new Vector3(1, 0, 0);
  const target = new Vector3();
  const muzzle = new Vector3();
  let timeS = 0;
  let lastMs = performance.now();
  let frameMsSmoothed = 16.7;
  let running = true;
  let ready = false;
  let dragonCalls = 0;

  // --- UI -----------------------------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:fixed;left:8px;top:8px;max-width:420px;font:12px/1.5 system-ui,sans-serif;' +
    'color:#fff6e8;background:#141824cc;padding:8px 10px;border-radius:6px;pointer-events:auto;' +
    'user-select:none;z-index:10';
  const readout = document.createElement('pre');
  readout.style.cssText = 'margin:6px 0 0;font:11px/1.4 ui-monospace,monospace;white-space:pre-wrap';
  if (params.has('noui')) panel.style.display = 'none';

  function row(label: string): HTMLDivElement {
    const element = document.createElement('div');
    element.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin:2px 0';
    const caption = document.createElement('span');
    caption.textContent = label;
    caption.style.cssText = 'width:44px;opacity:.7';
    element.append(caption);
    panel.append(element);
    return element;
  }

  const refreshers: (() => void)[] = [];
  function button(parent: HTMLElement, text: string, isOn: () => boolean, click: () => void): void {
    const element = document.createElement('button');
    element.textContent = text;
    element.style.cssText =
      'font:inherit;color:inherit;border:1px solid #fff6e855;border-radius:4px;padding:1px 6px;' +
      'cursor:pointer';
    const refresh = (): void => {
      element.style.background = isOn() ? '#ff7a1a' : 'transparent';
    };
    element.addEventListener('click', () => {
      click();
      for (const each of refreshers) each();
    });
    refreshers.push(refresh);
    refresh();
    parent.append(element);
  }

  const classRow = row('class');
  for (const name of [...DRAGON_CLASS_IDS, 'all'] as const) {
    button(
      classRow,
      name,
      () =>
        name === 'all'
          ? state.classes.length > 1
          : state.classes.length === 1 && state.classes[0] === name,
      () => {
        state.classes = name === 'all' ? [...DRAGON_CLASS_IDS] : [name];
      },
    );
  }
  const clipRow = row('clip');
  button(
    clipRow,
    'auto',
    () => state.clip === null,
    () => {
      state.clip = null;
    },
  );
  for (const clip of DRAGON_ANIM_CLIPS) {
    button(
      clipRow,
      clip,
      () => state.clip === clip,
      () => {
        state.clip = clip;
      },
    );
  }
  const lodRow = row('lod');
  for (const [text, value] of [
    ['auto', -1],
    ['0', 0],
    ['1', 1],
    ['2', 2],
    ['far', 3],
  ] as const) {
    button(
      lodRow,
      text,
      () => state.lod === value,
      () => {
        state.lod = value;
      },
    );
  }
  const teamRow = row('team');
  button(
    teamRow,
    'Ember',
    () => state.team === TEAM_EMBER,
    () => {
      state.team = TEAM_EMBER;
    },
  );
  button(
    teamRow,
    'Frost',
    () => state.team === TEAM_FROST,
    () => {
      state.team = TEAM_FROST;
    },
  );
  const flagRow = row('state');
  for (const name of Object.keys(FLAG_NAMES)) {
    const bit = FLAG_NAMES[name] ?? 0;
    button(
      flagRow,
      name,
      () => (state.flags & bit) !== 0,
      () => {
        state.flags ^= bit;
      },
    );
  }
  button(
    flagRow,
    'dead',
    () => state.dead,
    () => {
      state.dead = !state.dead;
    },
  );
  button(
    flagRow,
    'hurt',
    () => state.health < 0.5,
    () => {
      state.health = state.health < 0.5 ? 1 : 0.15;
    },
  );
  button(
    flagRow,
    'hit!',
    () => false,
    () => {
      state.hitPulse = true;
    },
  );
  const viewRow = row('view');
  button(
    viewRow,
    'fly',
    () => state.fly,
    () => {
      state.fly = !state.fly;
    },
  );
  button(
    viewRow,
    'spin',
    () => state.spinDeg !== 0,
    () => {
      state.spinDeg = state.spinDeg !== 0 ? 0 : 18;
    },
  );
  button(
    viewRow,
    'ground',
    () => state.ground,
    () => {
      state.ground = !state.ground;
    },
  );
  button(
    viewRow,
    'slots',
    () => state.slots,
    () => {
      state.slots = !state.slots;
    },
  );
  button(
    viewRow,
    'muzzle',
    () => state.muzzle,
    () => {
      state.muzzle = !state.muzzle;
    },
  );
  const qualityRow = row('preset');
  for (const id of QUALITY_PRESET_IDS) {
    button(
      qualityRow,
      id,
      () => presetId === id,
      () => {
        presetId = id;
        renderer.setPreset(id);
        applyQuality();
      },
    );
  }
  panel.append(readout);
  uiRoot.append(panel);

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.resize(width, height, window.devicePixelRatio);
    if (width > 0 && height > 0) {
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
  }
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);

  let hurtHealth = 1;

  function buildView(): number {
    beginWorldView(view);
    view.localDragonId = 0;
    const classes = state.classes;
    const total = Math.max(classes.length, state.count);
    let radius = 8;
    for (const classId of classes) radius = Math.max(radius, library.get(classId)?.radius ?? 8);
    // A hit: one frame at lower health, then back.
    hurtHealth = state.hitPulse ? Math.max(0.05, state.health - 0.1) : state.health;
    state.hitPulse = false;

    const columns = Math.min(total, 5);
    for (let i = 0; i < total; i++) {
      const dragon = acquireDragonView(view);
      dragon.id = i;
      dragon.team = total > 1 && state.count > 1 ? ((i % 2) as TeamId) : state.team;
      dragon.classId = classes[i % classes.length] ?? 'talon';
      dragon.health = hurtHealth;
      dragon.stamina = 1;
      dragon.flags = (state.dead ? 0 : DRAGON_FLAG_ALIVE) | state.flags;
      dragon.anim = DRAGON_ANIM_GLIDE;
      if (state.fly) {
        // A banking circle with a slow climb and dive, each dragon a little behind the last.
        const speed = 45;
        const circle = 70 + i * 6;
        const angle = (timeS * speed) / circle - i * 0.35;
        const climb = Math.sin(timeS * 0.5 - i) * 0.35;
        dragon.position.x = Math.sin(angle) * circle;
        dragon.position.z = Math.cos(angle) * circle;
        dragon.position.y = 40 - Math.cos(timeS * 0.5 - i) * 0.35 * speed * 2 + i * 3;
        const heading = angle + Math.PI / 2;
        orientation.setFromAxisAngle(up, heading);
        bank.setFromAxisAngle(leftAxis, -climb);
        orientation.multiply(bank);
        bank.setFromAxisAngle(forwardAxis, -0.55);
        orientation.multiply(bank);
        dragon.velocity.x = Math.cos(angle) * speed;
        dragon.velocity.z = -Math.sin(angle) * speed;
        dragon.velocity.y = climb * speed;
      } else {
        const column = i % columns;
        const rowIndex = Math.floor(i / columns);
        dragon.position.x = (column - (columns - 1) / 2) * radius * 1.9;
        dragon.position.y = 0;
        dragon.position.z = -rowIndex * radius * 2.2;
        orientation.identity();
        dragon.velocity.x = 0;
        dragon.velocity.y = 0;
        dragon.velocity.z = 45;
      }
      dragon.orientation.x = orientation.x;
      dragon.orientation.y = orientation.y;
      dragon.orientation.z = orientation.z;
      dragon.orientation.w = orientation.w;
    }
    return radius * Math.max(1, Math.min(total, 5) * 0.62);
  }

  function placeCamera(extent: number): void {
    const first = view.dragons[0];
    if (state.fly && first !== undefined) {
      const p = first.position;
      const v = first.velocity;
      const speed = Math.hypot(v.x, v.y, v.z) || 1;
      const back = 20 * state.dist;
      camera.position.set(
        p.x - (v.x / speed) * back,
        p.y + 5 * state.dist,
        p.z - (v.z / speed) * back,
      );
      target.set(p.x, p.y + 1, p.z);
    } else {
      const yaw = ((state.yawDeg + state.spinDeg * timeS) * Math.PI) / 180;
      const elev = (state.elevDeg * Math.PI) / 180;
      const distance = extent * state.dist * 1.55;
      const rows = Math.ceil(view.dragonCount / 5);
      target.set(0, 0, -(rows - 1) * extent * 0.5);
      camera.position.set(
        target.x + Math.sin(yaw) * Math.cos(elev) * distance,
        target.y + Math.sin(elev) * distance,
        target.z + Math.cos(yaw) * Math.cos(elev) * distance,
      );
    }
    camera.lookAt(target);
  }

  function frame(nowMs: number): void {
    if (!running) return;
    requestAnimationFrame(frame);
    const frameMs = Math.min(100, Math.max(0, nowMs - lastMs));
    lastMs = nowMs;
    const dt = frameMs / 1000;
    timeS += dt;
    frameMsSmoothed += (frameMs - frameMsSmoothed) * 0.05;

    dragons.setDebug({
      lod: state.lod,
      clip: state.clip,
      phase: state.phase,
      showSlots: state.slots,
    });
    const extent = buildView();
    placeCamera(extent);
    ground.visible = state.ground;
    sky.update(timeS);
    lighting.update(camera, timeS);
    dragons.update(view, dt, camera);
    muzzleMarker.visible = state.muzzle && dragons.muzzleWorld(0, muzzle);
    if (muzzleMarker.visible) muzzleMarker.position.copy(muzzle);

    renderer.render(scene, camera, frameMs);

    const info = renderer.webgl.info.render;
    const stats = dragons.stats;
    dragonCalls = stats.drawCalls;
    ready = stats.skinned > 0 || state.lod === 3;
    readout.textContent =
      `frame   ${info.calls} calls  ${info.triangles} tris  ${frameMsSmoothed.toFixed(1)} ms\n` +
      `dragons ${stats.drawCalls} calls  ${stats.triangles} tris  ` +
      `lod ${stats.lods.join('/')}  posed ${stats.posed}  rigs ${stats.rigs}\n` +
      state.classes
        .map((classId) => {
          const asset = library.get(classId);
          return asset === null
            ? `${classId}: ${library.status(classId)}`
            : `${classId}: ${asset.lodTriangles.join('/')} tris  r ${asset.radius.toFixed(1)} m`;
        })
        .join('\n');
  }
  requestAnimationFrame(frame);

  /** Cost of animating ten dragons for one frame: our baked blend against AnimationMixer. */
  async function bench(): Promise<Record<string, number>> {
    const classId = state.classes[0] ?? 'talon';
    const asset: DragonAsset = await library.load(classId);
    const dragonsCount = 10;
    const frames = 600;
    const out: Record<string, number> = {};

    const states = Array.from({ length: dragonsCount }, () => createDragonAnimState());
    const poses = Array.from({ length: dragonsCount }, () => createPoseAccumulator(asset.boneCount));
    const input = createDragonAnimInput();
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      for (let f = 0; f < frames; f++) {
        for (let d = 0; d < dragonsCount; d++) {
          input.speedRatio = 0.7 + 0.05 * d;
          input.climb = Math.sin(f * 0.01 + d) * 0.3;
          input.roll = Math.sin(f * 0.02 + d) * 0.6;
          input.yawRate = 0.4;
          advanceDragonAnim(states[d] as (typeof states)[number], input, asset, 1 / 60);
          writeDragonPose(states[d] as (typeof states)[number], asset, poses[d] as (typeof poses)[number]);
        }
      }
      out[`bakedMsPerFrame${round}`] = (performance.now() - start) / frames;
    }

    // The same blend (glide + flap + bank) through three's AnimationMixer on fresh GLB loads.
    const [{ GLTFLoader }, { KTX2Loader }, { MeshoptDecoder }, { AnimationMixer }] =
      await Promise.all([
        import('three/addons/loaders/GLTFLoader.js'),
        import('three/addons/loaders/KTX2Loader.js'),
        import('three/addons/libs/meshopt_decoder.module.js'),
        import('three'),
      ]);
    const ktx2 = new KTX2Loader().setTranscoderPath('/vendor/basis/').detectSupport(renderer.webgl);
    const loader = new GLTFLoader().setKTX2Loader(ktx2).setMeshoptDecoder(MeshoptDecoder);
    const url = `/assets/${asset.manifest.glb}`;
    const files = await Promise.all(
      Array.from({ length: dragonsCount }, () => loader.loadAsync(url)),
    );
    const mixers = files.map((file) => {
      const mixer = new AnimationMixer(file.scene);
      for (const [name, weight] of [
        ['glide', 0.5],
        ['flap', 0.3],
        ['bank_l', 0.2],
      ] as const) {
        const clip = file.animations.find((each) => each.name === name);
        if (clip !== undefined) {
          const action = mixer.clipAction(clip);
          action.setEffectiveWeight(weight);
          action.play();
        }
      }
      return mixer;
    });
    for (let round = 0; round < 3; round++) {
      const start = performance.now();
      for (let f = 0; f < frames; f++) {
        for (const mixer of mixers) mixer.update(1 / 60);
      }
      out[`mixerMsPerFrame${round}`] = (performance.now() - start) / frames;
    }
    ktx2.dispose();
    return out;
  }

  const hook = {
    get ready(): boolean {
      return ready;
    },
    state,
    set(search: string): void {
      applyParams(state, new URLSearchParams(search));
      if (search.includes('quality=')) {
        const id = new URLSearchParams(search).get('quality');
        if (id === 'low' || id === 'medium' || id === 'high') {
          presetId = id;
          renderer.setPreset(id);
          applyQuality();
        }
      }
      if (search.includes('class=')) {
        state.classes = parseClasses(`dragon:${new URLSearchParams(search).get('class') ?? ''}`);
      }
      for (const each of refreshers) each();
    },
    stats(): Record<string, unknown> {
      const info = renderer.webgl.info.render;
      const memory = (performance as { memory?: { usedJSHeapSize: number } }).memory;
      return {
        calls: info.calls,
        triangles: info.triangles,
        dragonCalls,
        dragons: { ...dragons.stats, lods: [...dragons.stats.lods] },
        frameMs: frameMsSmoothed,
        heapMb: memory !== undefined ? memory.usedJSHeapSize / 1048576 : -1,
        preset: presetId,
        status: state.classes.map((classId) => library.status(classId)),
      };
    },
    bench,
  };
  Reflect.set(window, '__viewer', hook);

  return {
    dispose(): void {
      running = false;
      observer.disconnect();
      panel.remove();
      dragons.dispose();
      lighting.dispose();
      lights.dispose();
      sky.dispose();
    },
  };
}
