/**
 * `?debug` controls for a live Netsim: profile picker, latency / jitter / loss sliders and
 * read-only counters. Only a TYPE is imported from lil-gui, so this file adds nothing to a
 * bundle; the caller already holds the panel (see ../debug-gui.ts):
 *
 *     if (devTools.debugGui) addNetsimFolder(devTools.debugGui, netsim);
 *
 * The sliders drive both directions at once. For different conditions per direction, edit
 * `netsim.outbound` / `netsim.inbound` in code.
 */
import type { GUI } from 'lil-gui';
import { JITTER_SHAPES } from './netsim';
import type { JitterShape, Netsim, NetsimSettings } from './netsim';
import { NETSIM_PROFILES, NETSIM_PROFILE_NAMES, isNetsimProfileName } from './profile';

/** Satisfied by a lil-gui `GUI` and by `DebugGui`. */
export interface NetsimGuiParent {
  addFolder(title: string): GUI;
}

const CUSTOM = 'custom';

type NumericSetting = 'latencyMs' | 'jitterMs' | 'lossPct' | 'duplicatePct' | 'reorderPct';

/** What the controls bind to. Exported for tests; the panel only needs `addNetsimFolder`. */
export interface NetsimGuiModel {
  profile: string;
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
  duplicatePct: number;
  reorderPct: number;
  jitterShape: JitterShape;
  readonly queued: number;
  readonly lost: number;
  readonly overflowDropped: number;
}

/**
 * Accessors that forward to the netsim, so there is no copied state to drift. Reads show the
 * outbound direction; writes go to both and mark the profile as custom.
 */
export function createNetsimGuiModel(netsim: Netsim): NetsimGuiModel {
  const setBoth = (key: NumericSetting, value: number): void => {
    const v = Number.isFinite(value) && value > 0 ? value : 0;
    netsim.outbound[key] = v;
    netsim.inbound[key] = v;
    netsim.profileName = CUSTOM;
  };
  const out: Readonly<NetsimSettings> = netsim.outbound;
  return {
    get profile(): string {
      return isNetsimProfileName(netsim.profileName) ? netsim.profileName : CUSTOM;
    },
    set profile(name: string) {
      if (isNetsimProfileName(name)) netsim.setProfile(NETSIM_PROFILES[name]);
    },
    get latencyMs(): number {
      return out.latencyMs;
    },
    set latencyMs(v: number) {
      setBoth('latencyMs', v);
    },
    get jitterMs(): number {
      return out.jitterMs;
    },
    set jitterMs(v: number) {
      setBoth('jitterMs', v);
    },
    get lossPct(): number {
      return out.lossPct;
    },
    set lossPct(v: number) {
      setBoth('lossPct', v);
    },
    get duplicatePct(): number {
      return out.duplicatePct;
    },
    set duplicatePct(v: number) {
      setBoth('duplicatePct', v);
    },
    get reorderPct(): number {
      return out.reorderPct;
    },
    set reorderPct(v: number) {
      setBoth('reorderPct', v);
    },
    get jitterShape(): JitterShape {
      return out.jitterShape;
    },
    set jitterShape(shape: JitterShape) {
      if (!JITTER_SHAPES.includes(shape)) return;
      netsim.outbound.jitterShape = shape;
      netsim.inbound.jitterShape = shape;
    },
    get queued(): number {
      return netsim.queued;
    },
    get lost(): number {
      return netsim.counters.lost;
    },
    get overflowDropped(): number {
      return netsim.counters.overflowDropped;
    },
  };
}

/** Adds a collapsed "Netsim" folder. It is destroyed with the panel it was added to. */
export function addNetsimFolder(parent: NetsimGuiParent, netsim: Netsim, title = 'Netsim'): GUI {
  const model = createNetsimGuiModel(netsim);
  const folder = parent.addFolder(title);

  // `listen()` keeps every control in step with the others (picking a profile moves the
  // sliders, moving a slider turns the profile into "custom") and with changes made in code.
  folder
    .add(model, 'profile', [...NETSIM_PROFILE_NAMES, CUSTOM])
    .name('profile')
    .listen();
  folder.add(model, 'latencyMs', 0, 500, 1).name('latency ms (one way)').listen();
  folder.add(model, 'jitterMs', 0, 200, 1).name('jitter ± ms').listen();
  folder.add(model, 'lossPct', 0, 50, 0.1).name('loss %').listen();
  folder.add(model, 'duplicatePct', 0, 20, 0.1).name('duplicate %').listen();
  folder.add(model, 'reorderPct', 0, 20, 0.1).name('reorder %').listen();
  folder
    .add(model, 'jitterShape', [...JITTER_SHAPES])
    .name('jitter shape')
    .listen();
  folder.add(model, 'queued').name('queued').disable().listen();
  folder.add(model, 'lost').name('lost').disable().listen();
  folder.add(model, 'overflowDropped').name('overflow drops').disable().listen();
  folder.close();
  return folder;
}
