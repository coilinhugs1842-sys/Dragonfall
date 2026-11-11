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
import { AUDIO_TUNING, SPATIAL_TUNING } from '../audio';
import { APP_STATE_IDS } from '../game/app';
import type { App, AppStateId } from '../game/app';
import { CAMERA_RIG_TUNING } from '../render';
import type { GameRenderer } from '../render';
import { ABILITY_TABLE, COMBAT_TUNING, PROJECTILE_DEFS, ZONE_DEFS } from '../shared/abilities';
import { COLLISION_TUNING } from '../shared/collision-tuning';
import { MODE_TUNING } from '../shared/match';
import { QUALITY_PRESET_IDS } from '../shared/quality';
import type { QualityPresetId } from '../shared/quality';
import { FLIGHT_TUNING } from '../shared/tuning';
import { BOT_DIFFICULTY_TUNING, BOT_TUNING } from '../sim/bots';

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

/**
 * `addTuningTable` for a table of tables (class -> slot -> ability, mode -> rules): a folder per
 * nested object, a field per number or boolean, all bound to the live objects. Arrays and
 * strings are left alone.
 */
function addTuningTree<T extends object>(parent: GUI, title: string, table: T): GUI {
  const folder = parent.addFolder(title);
  for (const key in table) {
    const value = table[key];
    if (typeof value === 'number' || typeof value === 'boolean') folder.add(table, key);
    else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      addTuningTree(folder, key, value);
    }
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

  // The host's rules run where its sim runs: these tables are this page's copies, so with the
  // host in a worker (the default) only `?noworker` hosts and clients' prediction see an edit.
  const combat = gui.addFolder('Combat (host: use ?noworker)');
  addTuningTree(combat, 'Abilities', ABILITY_TABLE);
  addTuningTree(combat, 'Projectiles', PROJECTILE_DEFS);
  addTuningTree(combat, 'Zones', ZONE_DEFS);
  addTuningTable(combat, 'Combat rules', COMBAT_TUNING);
  addTuningTree(combat, 'Modes', MODE_TUNING);
  addTuningTree(combat, 'Bots', BOT_TUNING);
  addTuningTree(combat, 'Bot skill', BOT_DIFFICULTY_TUNING);
  combat.close();

  const sound = gui.addFolder('Audio');
  addTuningTree(sound, 'Mix', AUDIO_TUNING);
  addTuningTree(sound, 'Distance', SPATIAL_TUNING);
  sound.close();

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
