/**
 * `?debug` panel (lil-gui): live switches for the renderer and the app state machine, a "Flight"
 * folder bound to the live tuning tables (flight model, terrain + storm, chase camera), plus
 * `addFolder` so later modules (vfx, audio) can hang their own controls on it.
 *
 * The tuning controls edit the shared tables in place. The sim, the collision world and the
 * camera read them every tick / frame, so a change takes effect at once. Nothing is saved:
 * copy a value that feels right back into the source table.
 *
 * Heavy module (pulls in lil-gui): only ever load it with a dynamic import, see ./boot.ts.
 */
import { GUI } from 'lil-gui';
import { APP_STATE_IDS } from '../game/app';
import type { App, AppStateId } from '../game/app';
import { CAMERA_RIG_TUNING } from '../render';
import type { GameRenderer } from '../render';
import { COLLISION_TUNING } from '../shared/collision-tuning';
import { QUALITY_PRESET_IDS } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import { FLIGHT_TUNING } from '../shared/tuning';

export interface DebugGui {
  /** The root panel, for anything `addFolder` does not cover. */
  readonly gui: GUI;
  /** Adds a collapsed top-level folder; it is destroyed with the panel. */
  addFolder(title: string): GUI;
  dispose(): void;
}

export interface DebugGuiOptions {
  renderer: GameRenderer;
  app?: App;
}

/**
 * One number field per numeric property of a tuning table, in the table's own order. Fields,
 * not sliders: the tables have no declared ranges, and a typed value is exact.
 */
function addTuningTable<T extends object>(parent: GUI, title: string, table: T): GUI {
  const folder = parent.addFolder(title);
  for (const key in table) {
    if (typeof table[key] === 'number') folder.add(table, key);
  }
  folder.close();
  return folder;
}

export function createDebugGui(opts: DebugGuiOptions): DebugGui {
  const { renderer, app } = opts;
  const gui = new GUI({ title: 'Dragonfall debug' });

  // lil-gui reads and writes plain properties. Accessors forward straight to the renderer, so
  // there is no copied state to drift, and `listen()` also picks up changes made elsewhere
  // (Settings menu, automatic quality pick).
  const renderModel = {
    get preset(): QualityPresetId {
      return renderer.presetId;
    },
    set preset(id: QualityPresetId) {
      renderer.setPreset(id);
    },
    get dynamicResolution(): boolean {
      return renderer.resolution.enabled;
    },
    set dynamicResolution(on: boolean) {
      renderer.resolution.enabled = on;
    },
    get renderScale(): number {
      return renderer.resolution.scale;
    },
  };

  const render = gui.addFolder('Render');
  render
    .add(renderModel, 'preset', [...QUALITY_PRESET_IDS])
    .name('quality preset')
    .listen();
  render.add(renderModel, 'dynamicResolution').name('dynamic resolution').listen();
  render.add(renderModel, 'renderScale').name('render scale').decimals(2).disable().listen();

  if (app) {
    const appModel = {
      get state(): AppStateId {
        return app.state;
      },
    };
    const folder = gui.addFolder('App');
    folder.add(appModel, 'state').name('state').disable().listen();
    for (const id of APP_STATE_IDS) {
      // The state machine rejects illegal transitions itself; a rejected click is just a no-op.
      const action = {
        go(): void {
          app.transition(id);
        },
      };
      folder.add(action, 'go').name(`go to ${id}`);
    }
  }

  const flight = gui.addFolder('Flight');
  addTuningTable(flight, 'Flight model', FLIGHT_TUNING);
  addTuningTable(flight, 'Terrain + storm', COLLISION_TUNING);
  addTuningTable(flight, 'Chase camera', CAMERA_RIG_TUNING);
  flight.close();

  let disposed = false;
  return {
    gui,
    addFolder(title: string): GUI {
      const folder = gui.addFolder(title);
      folder.close();
      return folder;
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Also stops the `listen()` rAF loops and removes the panel from the page.
      gui.destroy();
    },
  };
}
