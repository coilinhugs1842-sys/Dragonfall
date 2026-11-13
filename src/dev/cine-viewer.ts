/**
 * `?viewer=cine:<name>`: a preview stage for one cinematic piece, without a room, a sim or the
 * menus. It builds the real stage (sky, cloud sea, lights, and on request the match map with
 * its dragons and effects) and hands it to the scene module `src/dev/cine/<name>.ts`, which
 * drives it with a WorldView it writes itself. Used to look at the aerie, the intro flyby, the
 * death cam and the podium on their own, to take screenshots of them (tools/capture/shot.mjs),
 * and to stage trailer shots.
 *
 * A scene module exports `start(harness)`. Useful URL parameters are its own business; the
 * harness understands:
 *   &t=<seconds>      start the scene clock here
 *   &speed=<factor>   time scale (0 = frozen on `t`)
 *   &hud=0            hide the small caption
 *   &map=<map id>     the map `loadMatch` loads (the game's own `?map=` flag); default: the first map
 *
 * `window.__cine = { name, timeS, info }` is there for the capture scripts.
 */
import { FrameDriver, createMatchAssetsCache, createStage } from '../game';
import type { CameraDirector, MatchAssets, Stage } from '../game';
import type { GameRenderer } from '../render';
import { FixedStepLoop } from '../sim';
import { DEFAULT_MAP_ID, TICK_MS, defaultSeedOfMap } from '../shared';
import type { ArenaMap, WorldView } from '../shared';
import { getQueryFlags } from './query-flags';
import type { RecordRig } from './record';

/** What a scene module asks the harness to draw this frame. */
export type CineFrame =
  | { readonly kind: 'match'; readonly view: WorldView }
  | { readonly kind: 'lobby'; readonly view: WorldView }
  | { readonly kind: 'backdrop' };

export interface CineHarness {
  readonly stage: Stage;
  readonly renderer: GameRenderer;
  /**
   * The default map: what the title and the aerie lobby stand on, as in the game. A match scene
   * reads its map from what `loadMatch` returns (`?map=` may have picked another one).
   */
  readonly map: ArenaMap;
  readonly uiRoot: HTMLElement;
  readonly params: URLSearchParams;
  /**
   * Loads the match views (the map of `?map=`, its dragons and effects) so `kind: 'match'`
   * frames draw a WorldView. The stage takes that map's sky, as at a match start.
   */
  loadMatch(): MatchAssets;
  /** Hand the camera to a director (null = chase rig / backdrop drift). */
  setDirector(director: CameraDirector | null): void;
  /**
   * The frame callback: called once per rendered frame with the scaled delta and the scene
   * clock; returns what to draw. Must not allocate (return one of a few kept objects).
   */
  run(frame: (dtS: number, timeS: number) => CineFrame): void;
  /** A line of text for the corner caption and `window.__cine.info`. */
  setInfo(text: string): void;
}

export interface CineSceneModule {
  start(harness: CineHarness): void;
}

export interface CineViewerOptions {
  readonly canvas: HTMLCanvasElement;
  readonly uiRoot: HTMLElement;
  readonly renderer: GameRenderer;
  /** The value of `?viewer=`: `cine:aerie`, `cine:intro`, ... */
  readonly spec: string;
  /** `?record`: frames are stepped by the recorder (src/dev/record.ts); the caption is left out. */
  readonly record?: RecordRig | null;
}

const SCENES = import.meta.glob<CineSceneModule>('./cine/*.ts');

interface CineProbe {
  name: string;
  timeS: number;
  info: string;
}

export function startCineViewer(options: CineViewerOptions): void {
  const { canvas, uiRoot, renderer } = options;
  const name = options.spec.slice('cine:'.length) || 'aerie';
  const params = new URLSearchParams(location.search);
  const speedParam = Number(params.get('speed') ?? '1');
  const speed = Number.isFinite(speedParam) && speedParam >= 0 ? speedParam : 1;
  const startParam = Number(params.get('t') ?? '0');
  let timeS = Number.isFinite(startParam) && startParam > 0 ? startParam : 0;

  // The game's own parsing: a missing or unknown `?map=` is the default map.
  const matchMapId = getQueryFlags().map ?? DEFAULT_MAP_ID;
  const cache = createMatchAssetsCache();
  const stage = createStage({
    quality: renderer.presetId,
    map: cache.defaultMap,
    webgl: renderer.webgl,
    precompile: (scene, camera) => renderer.precompile(scene, camera),
  });
  renderer.onPresetChange((id) => {
    stage.setQuality(id);
  });

  const caption = document.createElement('pre');
  caption.style.cssText =
    'position:absolute;left:8px;bottom:8px;margin:0;padding:4px 8px;pointer-events:none;' +
    'font:12px/1.4 ui-monospace,Consolas,Menlo,monospace;color:#fff6e8;' +
    'background:rgba(20,24,36,0.7);white-space:pre;';
  const captionText = document.createTextNode(`cine:${name}`);
  caption.appendChild(captionText);
  const record = options.record ?? null;
  if (params.get('hud') !== '0' && record === null) uiRoot.appendChild(caption);
  // The recorder holds its clock while the map is still loading or shaders are compiling.
  record?.setBusyProbe(() => stage.warming || stage.mapLoadState === 'loading');

  const probe: CineProbe = { name, timeS, info: '' };
  Reflect.set(window, '__cine', probe);

  let frame: ((dtS: number, timeS: number) => CineFrame) | null = null;
  let shownSecond = -1;

  const harness: CineHarness = {
    stage,
    renderer,
    map: cache.defaultMap,
    uiRoot,
    params,
    loadMatch(): MatchAssets {
      const assets = cache.get(defaultSeedOfMap(matchMapId), matchMapId);
      stage.loadMatch(assets);
      return assets;
    },
    setDirector(director: CameraDirector | null): void {
      stage.setCameraDirector(director);
    },
    run(next): void {
      frame = next;
    },
    setInfo(text: string): void {
      probe.info = text;
    },
  };

  const applySize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    renderer.resize(width, height, window.devicePixelRatio);
    if (width > 0 && height > 0) stage.setAspect(width / height);
  };
  applySize();
  new ResizeObserver(applySize).observe(canvas);

  const driver = new FrameDriver({
    loop: new FixedStepLoop(TICK_MS, () => {}),
    ...(record !== null ? { host: record.frameHost } : {}),
    render: (_alpha, frameMs) => {
      // A hidden tab or a breakpoint must not fast-forward the scene.
      const dtS = (frameMs < 100 ? frameMs : 100) * 0.001 * speed;
      timeS += dtS;
      probe.timeS = timeS;
      const what = frame !== null ? frame(dtS, timeS) : null;
      if (what === null || what.kind === 'backdrop') stage.updateBackdrop(dtS);
      else if (what.kind === 'lobby') stage.updateLobby(what.view, dtS);
      else stage.updateMatch(what.view, 0, 0, dtS);
      renderer.render(stage.scene, stage.camera, frameMs);
      const second = Math.floor(timeS);
      if (second !== shownSecond) {
        shownSecond = second;
        captionText.data = `cine:${name}  t=${second}s  ${probe.info}`;
      }
    },
  });

  const key = `./cine/${name}.ts`;
  const load = SCENES[key];
  if (load === undefined) {
    const known = Object.keys(SCENES)
      .map((path) => path.slice('./cine/'.length, -'.ts'.length))
      .join(', ');
    captionText.data = `cine: no scene "${name}". Known: ${known || '(none)'}`;
    driver.start();
    return;
  }
  load().then(
    (module) => {
      module.start(harness);
      driver.start();
    },
    (error: unknown) => {
      console.error(`cine:${name} failed to load`, error);
      captionText.data = `cine:${name} failed to load (see the console)`;
      driver.start();
    },
  );
}
