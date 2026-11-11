import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DODGE_LEFT,
  BUTTON_FLAP,
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  RECONCILE_SMOOTH_MS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_MS,
  createInputFrame,
  createWorldView,
  acquireDragonView,
  beginWorldView,
} from '../../src/shared';
import type { InputFrame, MutableDragonView } from '../../src/shared';
import { createSim } from '../../src/sim';
import type { Sim } from '../../src/sim';
import { Reader, Writer, decodeInput, encodeInput } from '../../src/net/codec';
import {
  ClientPredictor,
  HOST_INPUT_WINDOW_TICKS,
  HostInputBuffer,
  INPUT_MARGIN_TARGET_TICKS,
  INPUT_MAX_DILATION,
  INPUT_REPEAT_MAX_TICKS,
  INPUT_RESYNC_CONFIRM,
  INPUT_RESYNC_TICKS,
  INPUT_TIMING_WINDOW,
  InputTiming,
  PREDICTION_HISTORY_TICKS,
  RECONCILE_CORRECTED,
  RECONCILE_IGNORED,
  RECONCILE_MATCHED,
  RECONCILE_NO_OWNER,
  RECONCILE_SNAPPED,
  RECONCILE_SNAP_DISTANCE_M,
  initialInputLeadTicks,
} from '../../src/net/prediction';
import { FAST_MAX_BYTES, createInputMessage } from '../../src/net/protocol';
import type { InputMessage, SnapshotMessage } from '../../src/net/protocol';
import {
  HostSnapshotBuilder,
  SnapshotBuffer,
  createSnapshotClock,
  createSnapshotSample,
} from '../../src/net/snapshot';

const ID = 1;

// --- Helpers -----------------------------------------------------------------------------------------

/** An INPUT message as the host decodes it: `frames[i]` is for wire tick `newest - i`. */
function inputMessage(
  newest: number,
  count: number,
  fill?: (frame: InputFrame, tick: number) => void,
): InputMessage {
  const msg = createInputMessage();
  msg.tick = newest & 0xffff;
  msg.frameCount = count;
  for (let i = 0; i < count; i++) {
    const frame = msg.frames[i];
    if (frame === undefined) throw new Error('no frame');
    frame.tick = (newest - i) & 0xffff;
    frame.steerX = 0;
    frame.steerY = 0;
    frame.buttons = 0;
    fill?.(frame, newest - i);
  }
  return msg;
}

function pilot(tick: number, frame: InputFrame): void {
  frame.steerX = Math.sin(tick * 0.2) * 0.7;
  frame.steerY = Math.cos(tick * 0.13) * 0.4;
  frame.buttons = tick % 40 < 12 ? BUTTON_BOOST : 0;
  if (tick % 25 === 3) frame.buttons |= BUTTON_FLAP;
}

interface Rig {
  sim: Sim;
  builder: HostSnapshotBuilder;
  predictor: ClientPredictor;
  frame: InputFrame;
  /** Steps the host one tick with the pilot's input for it (or with `override`). */
  hostStep(tick: number, override?: InputFrame | null): void;
  /** Steps the predictor one tick with the pilot's input. */
  clientStep(): number;
  snapshot(): SnapshotMessage;
}

function createRig(): Rig {
  const sim = createSim();
  sim.spawnDragon(ID, TEAM_FROST, 'tempest', { x: 100, y: 300, z: -50 }, 0.7);
  sim.spawnDragon(0, TEAM_EMBER, 'talon', { x: 0, y: 320, z: 0 }, 0);
  const builder = new HostSnapshotBuilder();
  const clock = createSnapshotClock();
  const predictor = new ClientPredictor();
  predictor.configure(ID, TEAM_FROST, 'tempest');
  const frame = createInputFrame();
  const hostFrame = createInputFrame();
  const inputs: (InputFrame | undefined)[] = [];
  return {
    sim,
    builder,
    predictor,
    frame,
    hostStep(tick, override) {
      if (override === null) inputs[ID] = undefined;
      else if (override !== undefined) inputs[ID] = override;
      else {
        pilot(tick, hostFrame);
        // What the wire would deliver.
        hostFrame.steerX = Math.round(hostFrame.steerX * 32767) / 32767;
        hostFrame.steerY = Math.round(hostFrame.steerY * 32767) / 32767;
        inputs[ID] = hostFrame;
      }
      sim.step(tick, inputs);
    },
    clientStep() {
      pilot(predictor.tick + 1, frame);
      return predictor.step(frame);
    },
    snapshot() {
      builder.begin(sim.current, clock);
      return builder.forRecipient(ID, true, sim.current.tick);
    },
  };
}

/** Host at tick 20, client predicted through tick 24 and reconciled with snapshot 20. */
function syncedRig(): Rig {
  const rig = createRig();
  for (let tick = 0; tick <= 20; tick++) rig.hostStep(tick);
  rig.predictor.setTick(20);
  for (let i = 0; i < 4; i++) rig.clientStep();
  expect(rig.predictor.reconcile(rig.snapshot(), 20)).toBe(RECONCILE_SNAPPED);
  return rig;
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function drawn(predictor: ClientPredictor, alpha = 1): MutableDragonView {
  const view = createWorldView();
  beginWorldView(view);
  const out = acquireDragonView(view);
  predictor.writeView(out, alpha);
  return out;
}

// --- HostInputBuffer -----------------------------------------------------------------------------------

describe('HostInputBuffer: which input the host applies on which tick', () => {
  it('has no ack and nothing to give before the first input', () => {
    const buffer = new HostInputBuffer();
    expect(buffer.hasAck).toBe(false);
    expect(buffer.ackTick).toBe(0);
    expect(buffer.margin(100)).toBe(0);
    expect(buffer.take(5)).toBeUndefined();
    expect(buffer.emptyCount).toBe(1);
    expect(buffer.hasSnapshotAck).toBe(false);
  });

  it('applies the frame for tick T on tick T and only then', () => {
    const buffer = new HostInputBuffer();
    const steer = (frame: InputFrame, tick: number): void => {
      frame.steerX = tick / 100;
    };
    expect(buffer.push(inputMessage(12, 3, steer), 9)).toBe(3);
    expect(buffer.hasAck).toBe(true);
    expect(buffer.ackTick).toBe(12);
    expect(buffer.margin(9)).toBe(3);
    expect(buffer.take(10)?.steerX).toBeCloseTo(0.1, 4);
    expect(buffer.take(11)?.steerX).toBeCloseTo(0.11, 4);
    const twelve = buffer.take(12);
    expect(twelve?.steerX).toBeCloseTo(0.12, 4);
    expect(twelve?.tick).toBe(12);
    expect(buffer.repeatedCount).toBe(0);
  });

  it('covers a lost packet with the copies in the next ones, and stores nothing twice', () => {
    const buffer = new HostInputBuffer();
    const steer = (frame: InputFrame, tick: number): void => {
      frame.steerX = tick / 100;
    };
    expect(buffer.push(inputMessage(10, 3, steer), 8)).toBe(2); // 10, 9 (8 is past)
    // The packets for 11 and 12 are lost; 13 carries 13, 12, 11.
    expect(buffer.push(inputMessage(13, 3, steer), 9)).toBe(3);
    expect(buffer.push(inputMessage(13, 3, steer), 9)).toBe(0); // a duplicate packet
    for (let tick = 9; tick <= 13; tick++) {
      expect(buffer.take(tick)?.steerX).toBeCloseTo(tick / 100, 4);
    }
    expect(buffer.repeatedCount).toBe(0);
    expect(buffer.storedCount).toBe(5);
    expect(buffer.packetCount).toBe(3);
  });

  it('never applies a frame after its tick has been simulated', () => {
    const buffer = new HostInputBuffer();
    buffer.take(20);
    expect(buffer.push(inputMessage(20, 3), 20)).toBe(0);
    expect(buffer.lateCount).toBe(1);
    // Not even when the caller passes a stale host tick.
    expect(buffer.push(inputMessage(20, 1), 18)).toBe(0);
    expect(buffer.ackTick).toBe(20);
  });

  it('repeats the newest known frame for a few ticks, then lets the dragon fly straight', () => {
    const buffer = new HostInputBuffer();
    buffer.push(
      inputMessage(10, 1, (frame) => {
        frame.steerX = 0.5;
        frame.buttons = BUTTON_BOOST | BUTTON_DODGE_LEFT;
      }),
      9,
    );
    expect(buffer.take(10)?.buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
    for (let tick = 11; tick <= 10 + INPUT_REPEAT_MAX_TICKS; tick++) {
      const frame = buffer.take(tick);
      expect(frame?.tick).toBe(tick);
      expect(frame?.steerX).toBeCloseTo(0.5, 4);
      // The same held buttons: the sim sees no new press, so no second dodge.
      expect(frame?.buttons).toBe(BUTTON_BOOST | BUTTON_DODGE_LEFT);
    }
    expect(buffer.take(11 + INPUT_REPEAT_MAX_TICKS)).toBeUndefined();
    expect(buffer.repeatedCount).toBe(INPUT_REPEAT_MAX_TICKS);
    expect(buffer.emptyCount).toBe(1);
  });

  it('a late frame is not applied but becomes the frame that is repeated', () => {
    const buffer = new HostInputBuffer();
    buffer.push(inputMessage(10, 1), 9);
    buffer.take(10);
    buffer.take(11);
    buffer.push(
      inputMessage(11, 1, (frame) => {
        frame.steerY = -0.25;
      }),
      11,
    );
    expect(buffer.take(12)?.steerY).toBeCloseTo(-0.25, 4);
  });

  it('acks ticks too far ahead to store, so the client learns it is running ahead', () => {
    const buffer = new HostInputBuffer();
    const far = 100 + HOST_INPUT_WINDOW_TICKS + 20;
    expect(buffer.push(inputMessage(far, 1), 100)).toBe(0);
    expect(buffer.ackTick).toBe(far);
    expect(buffer.margin(100)).toBe(HOST_INPUT_WINDOW_TICKS + 20);
    // The edge of the window is stored.
    expect(buffer.push(inputMessage(100 + HOST_INPUT_WINDOW_TICKS, 1), 100)).toBe(1);
  });

  it('follows the client when it steps its clock back', () => {
    const buffer = new HostInputBuffer();
    buffer.push(inputMessage(130, 3), 100);
    expect(buffer.ackTick).toBe(130);
    // A reordered packet from just before does not count as a step back...
    buffer.push(inputMessage(128, 1), 100);
    expect(buffer.ackTick).toBe(130);
    // ...this does, and what was filed for the old future is void.
    buffer.push(inputMessage(104, 3), 100);
    expect(buffer.ackTick).toBe(104);
    expect(buffer.margin(100)).toBe(4);
    // 101 was never sent on the new clock: the newest frame stands in for it.
    expect(buffer.take(101)?.tick).toBe(101);
    expect(buffer.repeatedCount).toBe(1);
    expect(buffer.take(102)?.tick).toBe(102);
    expect(buffer.take(104)?.tick).toBe(104);
    expect(buffer.repeatedCount).toBe(1);
  });

  it('detects the smallest step back the client ever makes, also with a packet lost', () => {
    const steer =
      (value: number) =>
      (frame: InputFrame): void => {
        frame.steerX = value;
      };
    // `InputTiming` jumps for an error above INPUT_RESYNC_TICKS: 7 ticks or more.
    for (const back of [INPUT_RESYNC_TICKS + 1, INPUT_RESYNC_TICKS + 2]) {
      for (const lost of [0, 1]) {
        const label = `back ${back}, lost ${lost}`;
        const buffer = new HostInputBuffer();
        // The client was `back` ticks too far ahead: 110 is its newest tick before the jump.
        for (let tick = 108; tick <= 110; tick++)
          buffer.push(inputMessage(tick, 3, steer(0.25)), 100);
        // After it the client re-uses tick numbers the host already holds frames for.
        const first = 111 - back + lost;
        buffer.push(inputMessage(first, 1, steer(-0.5)), 100);
        expect(buffer.ackTick, label).toBe(first);
        for (let tick = first + 1; tick <= 110; tick++) {
          buffer.push(inputMessage(tick, 3, steer(-0.5)), 100);
        }
        // The host applies what the client predicts with now, not the frames from before.
        for (let tick = first; tick <= 110; tick++) {
          expect(buffer.take(tick)?.steerX, `${label}, tick ${tick}`).toBeCloseTo(-0.5, 4);
        }
      }
    }
  });

  it('expands wire ticks around the host tick, across the 16-bit wrap', () => {
    const buffer = new HostInputBuffer();
    const hostTick = 65_536 * 3 - 2;
    expect(buffer.push(inputMessage(hostTick + 3, 3), hostTick)).toBe(3);
    expect(buffer.ackTick).toBe(hostTick + 3);
    expect(buffer.take(hostTick + 1)?.tick).toBe(hostTick + 1);
    expect(buffer.take(hostTick + 2)?.tick).toBe(65_536 * 3);
    expect(buffer.take(hostTick + 3)?.tick).toBe(65_536 * 3 + 1);
  });

  it('clamps whatever it is handed and passes the snapshot ack on', () => {
    const buffer = new HostInputBuffer();
    const msg = inputMessage(10, 1, (frame) => {
      frame.steerX = 9;
      frame.steerY = Number.NaN;
      frame.buttons = 0xffff;
    });
    msg.hasAck = true;
    msg.ackSnapshotTick = 4321;
    buffer.push(msg, 9);
    const frame = buffer.take(10);
    expect(frame?.steerX).toBe(1);
    expect(frame?.steerY).toBe(0);
    expect(frame?.buttons).toBe(0x7ff);

    // A frame that is already on the wire grid (everything the decoder produces) is unchanged.
    const onGrid = 12_345 / 32_767;
    buffer.push(
      inputMessage(11, 1, (grid) => {
        grid.steerX = onGrid;
        grid.steerY = -onGrid;
      }),
      10,
    );
    const eleven = buffer.take(11);
    expect(eleven?.steerX).toBe(onGrid);
    expect(eleven?.steerY).toBe(-onGrid);
    expect(buffer.hasSnapshotAck).toBe(true);
    expect(buffer.ackSnapshotTick).toBe(4321);
  });

  it('reset forgets everything', () => {
    const buffer = new HostInputBuffer();
    buffer.push(inputMessage(12, 3), 9);
    buffer.reset();
    expect(buffer.hasAck).toBe(false);
    expect(buffer.take(10)).toBeUndefined();
    expect(buffer.storedCount).toBe(0);
  });
});

// --- InputTiming ---------------------------------------------------------------------------------------

describe('InputTiming: the lead of the client clock', () => {
  const feed = (timing: InputTiming, margin: number, count: number, from = 1000): void => {
    for (let i = 0; i < count; i++) timing.onSnapshot(true, from + i * 2 + margin, from + i * 2);
  };

  it('runs at real time until the host has seen an input, and while the margin is right', () => {
    const timing = new InputTiming();
    timing.onSnapshot(false, 0, 500);
    expect(timing.timeScale).toBe(1);
    expect(timing.sampleCount).toBe(0);
    feed(timing, INPUT_MARGIN_TARGET_TICKS, 30);
    expect(timing.timeScale).toBe(1);
    feed(timing, INPUT_MARGIN_TARGET_TICKS + 1, 30);
    expect(timing.timeScale).toBe(1);
    expect(timing.resyncTicks).toBe(0);
    expect(timing.marginTicks).toBe(INPUT_MARGIN_TARGET_TICKS + 1);
  });

  it('speeds the client up when the host runs dry, by at most 3 %', () => {
    const timing = new InputTiming();
    feed(timing, 0, 3);
    expect(timing.timeScale).toBeGreaterThan(1);
    expect(timing.timeScale).toBeLessThan(1.02);
    feed(timing, -4, 2);
    expect(timing.timeScale).toBeCloseTo(1 + INPUT_MAX_DILATION, 12);
  });

  it('acts on the lowest margin of the last second, not the latest', () => {
    const timing = new InputTiming();
    feed(timing, 2, 10);
    feed(timing, 0, 1); // one dip
    feed(timing, 2, INPUT_TIMING_WINDOW - 2);
    expect(timing.lowestMarginTicks).toBe(0);
    expect(timing.timeScale).toBeGreaterThan(1);
    feed(timing, 2, 2); // the dip leaves the window
    expect(timing.lowestMarginTicks).toBe(2);
    expect(timing.timeScale).toBe(1);
  });

  it('slows the client down when its inputs pile up on the host', () => {
    const timing = new InputTiming();
    feed(timing, 4, INPUT_TIMING_WINDOW);
    expect(timing.timeScale).toBeLessThan(1);
    expect(timing.timeScale).toBeGreaterThanOrEqual(1 - INPUT_MAX_DILATION);
    feed(timing, 7, INPUT_TIMING_WINDOW);
    expect(timing.timeScale).toBeCloseTo(1 - INPUT_MAX_DILATION, 12);
  });

  it('asks for a jump when the margin is far off for several snapshots in a row', () => {
    const timing = new InputTiming();
    feed(timing, 2, 5);
    feed(timing, -20, INPUT_RESYNC_CONFIRM - 1);
    expect(timing.resyncTicks).toBe(0);
    feed(timing, 2, 1); // a blip is not enough
    feed(timing, -20, INPUT_RESYNC_CONFIRM);
    // Jumping by this puts the margin one above the target.
    expect(timing.resyncTicks).toBe(INPUT_MARGIN_TARGET_TICKS + 1 + 20);

    // After the jump, margins measured on pre-jump inputs are still arriving: ignored.
    timing.resyncApplied(160);
    expect(timing.resyncTicks).toBe(0);
    expect(timing.timeScale).toBe(1);
    const skipped = Math.ceil((160 + 2 * TICK_MS) / 50) + 2;
    feed(timing, -20, skipped);
    expect(timing.resyncTicks).toBe(0);
    expect(timing.timeScale).toBe(1);
    feed(timing, 2, 5);
    expect(timing.timeScale).toBe(1);
    expect(timing.lowestMarginTicks).toBe(2);
  });

  it('asks to jump back when the client is far ahead', () => {
    const timing = new InputTiming();
    feed(timing, 30, INPUT_RESYNC_CONFIRM);
    expect(timing.resyncTicks).toBe(INPUT_MARGIN_TARGET_TICKS + 1 - 30);
  });

  it('measures the margin on wire ticks across the wrap', () => {
    const timing = new InputTiming();
    timing.onSnapshot(true, 2, 65_534);
    expect(timing.marginTicks).toBe(4);
    timing.onSnapshot(true, 65_535, 1);
    expect(timing.marginTicks).toBe(-2);
  });

  it('first guess of the lead: one-way latency, jitter, margin', () => {
    expect(initialInputLeadTicks(0, 0)).toBe(INPUT_MARGIN_TARGET_TICKS + 1);
    expect(initialInputLeadTicks(160, 0)).toBe(Math.ceil(80 / TICK_MS) + 2);
    expect(initialInputLeadTicks(160, 20)).toBe(Math.ceil(100 / TICK_MS) + 2);
    expect(initialInputLeadTicks(Number.NaN, -5)).toBe(INPUT_MARGIN_TARGET_TICKS + 1);
  });

  it('reset goes back to real time', () => {
    const timing = new InputTiming();
    feed(timing, -30, 10);
    timing.reset();
    expect(timing.timeScale).toBe(1);
    expect(timing.resyncTicks).toBe(0);
    expect(timing.sampleCount).toBe(0);
  });
});

// --- ClientPredictor -----------------------------------------------------------------------------------

describe('ClientPredictor', () => {
  it('is inactive until the first owner block, but already records inputs', () => {
    const predictor = new ClientPredictor();
    expect(predictor.playerId).toBe(NO_PLAYER);
    expect(predictor.tick).toBe(-1);
    const rig = createRig();
    expect(rig.predictor.active).toBe(false);
    rig.predictor.setTick(20);
    expect(rig.clientStep()).toBe(21);
    expect(rig.predictor.tick).toBe(21);
    expect(rig.predictor.active).toBe(false);
    const msg = createInputMessage();
    expect(rig.predictor.writeInputMessage(msg, false, 0)).toBe(1);
  });

  it('ignores snapshots before `configure`', () => {
    const rig = createRig();
    for (let tick = 0; tick <= 5; tick++) rig.hostStep(tick);
    const predictor = new ClientPredictor();
    expect(predictor.reconcile(rig.snapshot(), 5)).toBe(RECONCILE_IGNORED);
    expect(predictor.active).toBe(false);
  });

  it('the first snapshot starts prediction by replaying the inputs already sent', () => {
    const rig = syncedRig();
    expect(rig.predictor.active).toBe(true);
    expect(rig.predictor.replayedTicks).toBe(4);
    expect(rig.predictor.lastSnapshotTick).toBe(20);
    expect(rig.predictor.visualOffsetM).toBe(0);
    // The host now simulates the same four ticks with the same inputs.
    for (let tick = 21; tick <= 24; tick++) rig.hostStep(tick);
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    expect(distance(rig.predictor.dragon.position, host.position)).toBeLessThan(1e-3);
    expect(rig.predictor.dragon.team).toBe(TEAM_FROST);
    expect(rig.predictor.dragon.classId).toBe('tempest');
    expect(rig.predictor.dragon.flags & DRAGON_FLAG_ALIVE).not.toBe(0);
  });

  it('agrees with the host tick after tick: later snapshots change nothing', () => {
    const rig = syncedRig();
    for (let tick = 21; tick <= 200; tick++) {
      rig.clientStep(); // the client is 4 ticks ahead
      rig.hostStep(tick);
      const before = { ...rig.predictor.dragon.position };
      expect(rig.predictor.reconcile(rig.snapshot(), tick)).toBe(RECONCILE_MATCHED);
      expect(rig.predictor.dragon.position).toEqual(before);
    }
    expect(rig.predictor.correctionCount).toBe(0);
    expect(rig.predictor.matchCount).toBe(180);
    expect(rig.predictor.lastCorrectionM).toBe(0);
    expect(rig.predictor.visualOffsetM).toBe(0);
  });

  it('ignores a snapshot that is not newer than the last one used', () => {
    const rig = syncedRig();
    rig.clientStep();
    rig.hostStep(21);
    const old = rig.snapshot();
    expect(rig.predictor.reconcile(old, 21)).toBe(RECONCILE_MATCHED);
    expect(rig.predictor.reconcile(old, 21)).toBe(RECONCILE_IGNORED);
    expect(rig.predictor.reconcile(old, 19)).toBe(RECONCILE_IGNORED);
  });

  it('a misprediction corrects the state at once and the picture over about 100 ms', () => {
    const rig = syncedRig();
    for (let tick = 21; tick <= 60; tick++) {
      rig.clientStep();
      rig.hostStep(tick);
      rig.predictor.reconcile(rig.snapshot(), tick);
    }
    // The host loses three inputs in a row and flies the dragon straight meanwhile.
    for (let tick = 61; tick <= 63; tick++) {
      rig.clientStep();
      rig.hostStep(tick, null);
    }
    const drawnBefore = drawn(rig.predictor);
    expect(rig.predictor.reconcile(rig.snapshot(), 63)).toBe(RECONCILE_CORRECTED);
    expect(rig.predictor.replayedTicks).toBe(4);
    const correction = rig.predictor.lastCorrectionM;
    expect(correction).toBeGreaterThan(0.01);
    expect(correction).toBeLessThan(RECONCILE_SNAP_DISTANCE_M);
    expect(rig.predictor.visualOffsetM).toBeCloseTo(correction, 9);
    expect(rig.predictor.largestCorrectionM).toBe(correction);
    expect(rig.predictor.correctionCount).toBe(1);

    // The picture has not moved at all: position and orientation are exactly where they were.
    const drawnAfter = drawn(rig.predictor);
    expect(distance(drawnAfter.position, drawnBefore.position)).toBeLessThan(1e-9);
    const dot =
      drawnAfter.orientation.x * drawnBefore.orientation.x +
      drawnAfter.orientation.y * drawnBefore.orientation.y +
      drawnAfter.orientation.z * drawnBefore.orientation.z +
      drawnAfter.orientation.w * drawnBefore.orientation.w;
    expect(Math.abs(dot)).toBeGreaterThan(1 - 1e-9);

    // The state itself is right already: replaying the host with the client's inputs agrees.
    for (let tick = 64; tick <= 67; tick++) rig.hostStep(tick);
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    expect(distance(rig.predictor.dragon.position, host.position)).toBeLessThan(1e-3);

    // The offset decays smoothly: monotonic, 5 % left after RECONCILE_SMOOTH_MS, then gone.
    let previous = rig.predictor.visualOffsetM;
    for (let ms = 0; ms < RECONCILE_SMOOTH_MS; ms += 10) {
      rig.predictor.updateSmoothing(10);
      expect(rig.predictor.visualOffsetM).toBeLessThan(previous);
      previous = rig.predictor.visualOffsetM;
    }
    expect(previous).toBeLessThan(correction * 0.06);
    expect(previous).toBeGreaterThan(correction * 0.04);
    for (let ms = 0; ms < 400; ms += 10) rig.predictor.updateSmoothing(10);
    expect(rig.predictor.visualOffsetM).toBe(0);
    expect(rig.predictor.visualOffsetRad).toBe(0);
  });

  it('smooths an orientation error too, the short way round', () => {
    const rig = syncedRig();
    for (let tick = 21; tick <= 40; tick++) {
      rig.clientStep();
      rig.hostStep(tick);
      rig.predictor.reconcile(rig.snapshot(), tick);
    }
    // The host saw a hard opposite turn for a few ticks.
    const wrong = createInputFrame();
    wrong.steerX = -1;
    wrong.steerY = 1;
    for (let tick = 41; tick <= 46; tick++) {
      rig.clientStep();
      rig.hostStep(tick, wrong);
    }
    expect(rig.predictor.reconcile(rig.snapshot(), 46)).toBe(RECONCILE_CORRECTED);
    const angle = rig.predictor.visualOffsetRad;
    expect(angle).toBeGreaterThan(0.01);
    expect(angle).toBeLessThan(Math.PI);
    let previous = angle;
    for (let i = 0; i < 10; i++) {
      rig.predictor.updateSmoothing(10);
      expect(rig.predictor.visualOffsetRad).toBeLessThan(previous);
      previous = rig.predictor.visualOffsetRad;
      const q = drawn(rig.predictor).orientation;
      expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
    }
    expect(previous).toBeLessThan(angle * 0.08);
  });

  it('snaps when the error is too large to be a misprediction', () => {
    const rig = syncedRig();
    rig.clientStep();
    rig.hostStep(21);
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    host.position.x += 300; // teleported by the host
    expect(rig.predictor.reconcile(rig.snapshot(), 21)).toBe(RECONCILE_SNAPPED);
    expect(rig.predictor.visualOffsetM).toBe(0);
    expect(rig.predictor.lastCorrectionM).toBeGreaterThan(250);
    expect(rig.predictor.snapCount).toBe(2);
    const view = drawn(rig.predictor);
    expect(Math.abs(view.position.x - rig.predictor.dragon.position.x)).toBeLessThan(1e-9);
  });

  it('snaps on a respawn even when the new place is close', () => {
    const rig = syncedRig();
    for (let tick = 21; tick <= 200; tick++) {
      rig.clientStep();
      rig.hostStep(tick);
      rig.predictor.reconcile(rig.snapshot(), tick);
    }
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    // Spawn protection had run out; the respawn brings it back, 3 m away.
    expect(host.spawnProtectTicks).toBe(0);
    rig.sim.spawnDragon(
      ID,
      TEAM_FROST,
      'tempest',
      { x: host.position.x + 3, y: host.position.y, z: host.position.z },
      host.yaw,
    );
    rig.clientStep();
    rig.hostStep(201);
    expect(rig.predictor.reconcile(rig.snapshot(), 201)).toBe(RECONCILE_SNAPPED);
    expect(rig.predictor.visualOffsetM).toBe(0);
  });

  it('switches off without an owner block and on again when it returns', () => {
    const rig = syncedRig();
    rig.clientStep();
    rig.hostStep(21);
    rig.sim.despawnDragon(ID);
    expect(rig.predictor.reconcile(rig.snapshot(), 21)).toBe(RECONCILE_NO_OWNER);
    expect(rig.predictor.active).toBe(false);
    // Inputs keep flowing meanwhile.
    expect(rig.clientStep()).toBe(26);
    rig.hostStep(22);
    expect(rig.predictor.reconcile(rig.snapshot(), 22)).toBe(RECONCILE_NO_OWNER);
    rig.sim.spawnDragon(ID, TEAM_FROST, 'tempest', { x: 5, y: 250, z: 5 }, 1);
    rig.hostStep(23);
    expect(rig.predictor.reconcile(rig.snapshot(), 23)).toBe(RECONCILE_SNAPPED);
    expect(rig.predictor.active).toBe(true);
    expect(rig.predictor.dragon.position.y).toBeGreaterThan(200);
  });

  it('when the client is behind the host it simply shows the host state', () => {
    const rig = syncedRig();
    // The host runs on to tick 40 while the client still sits at 24.
    for (let tick = 21; tick <= 40; tick++) rig.hostStep(tick);
    const result = rig.predictor.reconcile(rig.snapshot(), 40);
    expect(result === RECONCILE_CORRECTED || result === RECONCILE_SNAPPED).toBe(true);
    expect(rig.predictor.replayedTicks).toBe(0);
    expect(rig.predictor.tick).toBe(24);
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    expect(distance(rig.predictor.dragon.position, host.position)).toBeLessThan(1e-3);
    // Render interpolation still has a previous state one tick of motion behind.
    const step = distance(rig.predictor.previousDragon.position, rig.predictor.dragon.position);
    expect(step).toBeGreaterThan(0.3);
    expect(step).toBeLessThan(5);
  });

  it('replays a tick it has no input for as "no input", like the sim does', () => {
    const rig = syncedRig();
    rig.hostStep(21);
    // The client's clock jumps 3 ticks forward: 25..27 were never sampled.
    rig.predictor.shiftTick(3);
    expect(rig.predictor.tick).toBe(27);
    rig.clientStep(); // 28
    rig.predictor.reconcile(rig.snapshot(), 21);
    expect(rig.predictor.replayedTicks).toBe(7);
    for (let tick = 22; tick <= 28; tick++) {
      rig.hostStep(tick, tick >= 25 && tick <= 27 ? null : undefined);
    }
    const host = rig.sim.getDragon(ID);
    if (host === undefined) throw new Error('no dragon');
    expect(distance(rig.predictor.dragon.position, host.position)).toBeLessThan(1e-3);
  });

  it('does not replay when the client is hopelessly ahead', () => {
    const rig = syncedRig();
    rig.predictor.shiftTick(PREDICTION_HISTORY_TICKS * 3);
    rig.hostStep(21);
    rig.predictor.reconcile(rig.snapshot(), 21);
    expect(rig.predictor.replayedTicks).toBe(0);
    expect(rig.predictor.active).toBe(true);
  });

  it('rewrites the input to exactly what the host decodes', () => {
    const rig = syncedRig();
    rig.frame.steerX = 0.123456789;
    rig.frame.steerY = -0.987654321;
    rig.frame.buttons = 0xffff;
    const tick = rig.predictor.step(rig.frame);
    expect(rig.frame.tick).toBe(tick);

    const msg = createInputMessage();
    expect(rig.predictor.writeInputMessage(msg, true, 70_000)).toBe(3);
    expect(msg.hasAck).toBe(true);
    expect(msg.ackSnapshotTick).toBe(70_000 & 0xffff);
    const writer = new Writer(FAST_MAX_BYTES);
    const length = encodeInput(writer, msg);
    const bytes = writer.packet(length);
    const decoded = createInputMessage();
    const reader = new Reader().reset(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    );
    expect(decodeInput(reader, decoded)).toBe(true);
    expect(decoded.frames[0]?.steerX).toBe(rig.frame.steerX);
    expect(decoded.frames[0]?.steerY).toBe(rig.frame.steerY);
    expect(decoded.frames[0]?.buttons).toBe(rig.frame.buttons);
    expect(decoded.frames[0]?.tick).toBe(tick);
    // Newest first, consecutive.
    expect(decoded.frames[1]?.tick).toBe(tick - 1);
    expect(decoded.frames[2]?.tick).toBe(tick - 2);
  });

  it('only repeats frames that exist and are consecutive', () => {
    const predictor = new ClientPredictor();
    predictor.configure(ID, TEAM_FROST, 'tempest');
    const msg = createInputMessage();
    expect(predictor.writeInputMessage(msg, false, 0)).toBe(0);
    const frame = createInputFrame();
    predictor.setTick(99);
    predictor.step(frame);
    expect(predictor.writeInputMessage(msg, false, 0)).toBe(1);
    predictor.step(frame);
    expect(predictor.writeInputMessage(msg, false, 0)).toBe(2);
    predictor.step(frame);
    predictor.step(frame);
    expect(predictor.writeInputMessage(msg, false, 0)).toBe(3);
    expect(msg.frames[0]?.tick).toBe(103);
    expect(msg.frames[2]?.tick).toBe(101);
    predictor.shiftTick(5);
    predictor.step(frame);
    expect(predictor.writeInputMessage(msg, false, 0)).toBe(1);
    expect(msg.frames[0]?.tick).toBe(109);
    expect(msg.hasAck).toBe(false);
    expect(msg.ackSnapshotTick).toBe(0);
  });

  it('interpolates the drawn dragon between the last two ticks', () => {
    const rig = syncedRig();
    rig.clientStep();
    const before = rig.predictor.previousDragon.position;
    const now = rig.predictor.dragon.position;
    const half = drawn(rig.predictor, 0.5);
    expect(half.position.x).toBeCloseTo((before.x + now.x) / 2, 9);
    expect(half.position.y).toBeCloseTo((before.y + now.y) / 2, 9);
    expect(drawn(rig.predictor, 0).position.z).toBeCloseTo(before.z, 9);
    expect(drawn(rig.predictor, 7).position.z).toBeCloseTo(now.z, 9);
    expect(half.id).toBe(ID);
    expect(half.team).toBe(TEAM_FROST);
    expect(half.classId).toBe('tempest');
    expect(half.health).toBe(1);
    expect(half.stamina).toBeGreaterThan(0);
    expect(half.flags & DRAGON_FLAG_ALIVE).not.toBe(0);
  });

  it('is deterministic, and `reset` leaves no trace', () => {
    const fly = (rig: Rig): string => {
      for (let tick = 21; tick <= 120; tick++) {
        rig.clientStep();
        rig.hostStep(tick, tick % 17 === 0 ? null : undefined);
        rig.predictor.reconcile(rig.snapshot(), tick);
        rig.predictor.updateSmoothing(16);
      }
      return JSON.stringify([rig.predictor.dragon, drawn(rig.predictor, 0.3)]);
    };
    const first = fly(syncedRig());
    expect(fly(syncedRig())).toBe(first);

    // A used predictor, reset and reconfigured, behaves like a new one.
    const rig = syncedRig();
    fly(rig);
    const reused = syncedRig();
    reused.predictor.shiftTick(40);
    for (let i = 0; i < 30; i++) reused.clientStep();
    reused.predictor.configure(ID, TEAM_FROST, 'tempest');
    expect(reused.predictor.active).toBe(false);
    expect(reused.predictor.lastSnapshotTick).toBe(-1);
    reused.predictor.setTick(20);
    for (let i = 0; i < 4; i++) reused.clientStep();
    reused.predictor.reconcile(reused.snapshot(), 20);
    expect(fly(reused)).toBe(first);
  });
});

// --- Hot path allocations --------------------------------------------------------------------------------

describe('hot path allocations', () => {
  /**
   * Bytes of heap growth per call of `cycle`, after warm-up. Same method as
   * tests/net/codec-fast.test.ts: the median of nine trials absorbs a stray GC or JIT event.
   * Only integers may change inside `cycle` (float maths in the test closure allocates by itself).
   */
  function bytesPerCycle(cycle: () => void): number {
    for (let i = 0; i < 30_000; i++) cycle();
    const iterations = 2000;
    const growth: number[] = [];
    for (let trial = 0; trial < 9; trial++) {
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < iterations; i++) cycle();
      growth.push(process.memoryUsage().heapUsed - before);
    }
    growth.sort((a, b) => a - b);
    return (growth[4] ?? Infinity) / iterations;
  }

  it('everything around the sim step creates no garbage', () => {
    const rig = syncedRig();
    const buffer = new SnapshotBuffer();
    const sample = createSnapshotSample();
    const hostInputs = new HostInputBuffer();
    const timing = new InputTiming();
    const input = createInputMessage();
    const view = createWorldView();
    beginWorldView(view);
    const out = acquireDragonView(view);
    const ownerBase = rig.sim.getDragon(ID)?.position.x ?? 0;
    const ownerX = Float64Array.of(ownerBase, ownerBase + 0.37, ownerBase - 0.21, ownerBase + 0.11);
    const wobbles = Float64Array.of(0.13, 1.71, 2.9, 4.33);
    // Whole-millisecond clocks: integers, so the test itself passes no boxed floats.
    let tick = 20;
    let nowMs = 1000;
    let taken = 0;
    let reconciled = 0;

    const cycle = (): void => {
      tick++;
      nowMs += 33;
      // Client: the INPUT message for the newest predicted tick.
      rig.predictor.writeInputMessage(input, true, tick);
      const newest = input.frames[0];
      if (newest !== undefined) newest.tick = (tick + 2) & 0xffff;
      input.frameCount = 1;
      // Host: file it, take this tick's input, build the snapshot (the sim state is static
      // here; only the stamped tick moves).
      hostInputs.push(input, tick);
      if (hostInputs.take(tick + 2) !== undefined) taken++;
      const snapshot = rig.snapshot();
      snapshot.tick = tick & 0xffff;
      // Move the authoritative dragon a little every tick, so there is a real error to smooth
      // and real motion to interpolate (typed-array loads: no float maths in this closure).
      const wobble = wobbles[tick & 3] as number;
      snapshot.owner.position.x = ownerX[tick & 3] as number;
      const remote = snapshot.dragons[0];
      if (remote !== undefined) remote.position.z = wobble;
      // Client: buffer it, steer the clock, reconcile (client behind the host: reset, no
      // replay), smooth, draw, sample.
      const full = buffer.push(snapshot, nowMs, tick);
      timing.onSnapshot(snapshot.hasAck, snapshot.ackInputTick, snapshot.tick);
      if (rig.predictor.reconcile(snapshot, full) !== RECONCILE_IGNORED) reconciled++;
      rig.predictor.updateSmoothing(16.7);
      rig.predictor.writeView(out, 0.37);
      buffer.update(nowMs);
      buffer.sample(sample);
    };

    const bytes = bytesPerCycle(cycle);
    expect(rig.predictor.correctionCount).toBeGreaterThan(40_000);
    expect(rig.predictor.visualOffsetM).toBeGreaterThan(0);
    expect(sample.playTick % 1).not.toBe(0);
    expect(taken).toBeGreaterThan(40_000);
    expect(reconciled).toBeGreaterThan(40_000);
    expect(sample.valid).toBe(true);
    expect(sample.dragonCount).toBe(2);
    // One 16-byte object per cycle would read 16 here.
    expect(bytes).toBeLessThan(4);
  });

  it('prediction and replay cost only what the flight step itself costs', () => {
    // `integrateDragon` and `finalizeDragon` (src/sim/flight.ts) take the input frame and the
    // fallback position as objects: as plain numbers they were boxed on every call the JIT did
    // not inline (measured 32 B per call, 64 B per dragon-step). What is left is about 5 B per
    // dragon-step (21 B per cycle here, from float arguments of small helpers inside the flight
    // step), which is the sim's cost on the host as well (`sim.step`), not something
    // prediction adds. This test pins the budget so anything on top of it shows.
    const rig = syncedRig();
    const wrong = createInputFrame();
    wrong.buttons = BUTTON_BOOST;
    const simInputs: (InputFrame | undefined)[] = [];
    let tick = 20;
    let corrected = 0;
    let steps = 0;

    const cycle = (): void => {
      tick++;
      const frame = rig.frame;
      frame.buttons = 0;
      rig.predictor.step(frame);
      steps++;
      // Every 4th tick the host applies something else: a correction with a 4-tick replay.
      simInputs[ID] = (tick & 3) === 0 ? wrong : frame;
      rig.sim.step(tick, simInputs);
      if (rig.predictor.reconcile(rig.snapshot(), tick) === RECONCILE_CORRECTED) {
        corrected++;
        steps += rig.predictor.replayedTicks;
      }
    };
    const bytes = bytesPerCycle(cycle);
    expect(corrected).toBeGreaterThan(5000);
    // Dragon-steps per cycle: the predictor's own (incl. replays) plus the host's two dragons.
    const stepsPerCycle = steps / (tick - 20) + 2;
    expect(bytes).toBeLessThan(8 * stepsPerCycle + 16);
  });
});
