/**
 * Wires the `match` app state to its scene. Phase 1: the scene is the flight sandbox
 * (./flight-sandbox.ts); the lobby, teams and rounds arrive with Phase 2/3.
 *
 * The scene exists only while the state is active: it is created in the state's `enter` hook
 * and disposed in `exit` (docs/ARCHITECTURE.md, "Scenes and memory"). While it exists it follows
 * the renderer's quality preset, whoever changes it.
 */

import type { GameRenderer } from '../render';
import type { App } from './app';
import { createFlightSandbox } from './flight-sandbox';
import type { FlightSandbox } from './flight-sandbox';

export interface MatchSceneOptions {
  readonly app: App;
  readonly renderer: GameRenderer;
  /** The game canvas (pointer lock target). */
  readonly canvas: HTMLElement;
  /** `?autopilot`: a scripted pilot flies instead of the devices. */
  readonly autopilot?: boolean;
  /** `?skip`: seconds of flight each new scene runs before its first frame. */
  readonly skipSeconds?: number;
}

export interface MatchScene {
  /** The live scene, or null outside the `match` state. */
  readonly active: FlightSandbox | null;
  /** Canvas width / height; remembered for scenes created later. */
  setAspect(aspect: number): void;
  /**
   * One rendered frame: updates the scene for `alpha` and draws it. Returns false (and draws
   * nothing) when there is no scene. Allocation-free.
   */
  renderFrame(alpha: number, frameMs: number): boolean;
  /** Unregisters from the app and frees the scene if one is live. */
  dispose(): void;
}

export function createMatchScene(options: MatchSceneOptions): MatchScene {
  const { app, renderer, canvas } = options;
  const autopilot = options.autopilot ?? false;
  const skipSeconds = options.skipSeconds ?? 0;
  let sandbox: FlightSandbox | null = null;
  let aspect = 1;

  function leave(): void {
    sandbox?.dispose();
    sandbox = null;
  }

  // Created once, not per scene: the listener outlives every sandbox and finds the live one.
  const unsubscribePreset = renderer.onPresetChange((id) => sandbox?.setQuality(id));

  const unregister = app.register('match', {
    enter(): void {
      leave();
      sandbox = createFlightSandbox({
        canvas,
        quality: renderer.presetId,
        autopilot,
        skipSeconds,
      });
      sandbox.setAspect(aspect);
    },
    exit(): void {
      leave();
    },
    update(): void {
      sandbox?.step();
    },
  });

  return {
    get active() {
      return sandbox;
    },
    setAspect(next: number): void {
      if (!(next > 0)) return;
      aspect = next;
      sandbox?.setAspect(next);
    },
    renderFrame(alpha: number, frameMs: number): boolean {
      if (sandbox === null) return false;
      sandbox.update(alpha, frameMs);
      renderer.render(sandbox.scene, sandbox.camera, frameMs);
      return true;
    },
    dispose(): void {
      unregister();
      unsubscribePreset();
      leave();
    },
  };
}
