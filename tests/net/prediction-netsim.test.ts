/**
 * Host and one client wired together through the real codec and a simulated network, with no
 * transport and no timers: a millisecond loop delivers packets with seeded latency, jitter and
 * loss. What the session layer will do for real is done by hand here, in the order it should do
 * it, so this file doubles as the reference wiring for `src/net/{snapshot,prediction,clock}`.
 *
 * The metrics the assertions are about:
 * - prediction error: |position the client predicted for tick T - position the host computed
 *   for T|, sampled when the host simulates T;
 * - visual discontinuity ("rubber-banding"): per rendered frame, how far the drawn dragon is
 *   from where its last drawn position and velocity said it would be,
 *   |p(n) - (p(n-1) + v(n-1) * dt)|. Smooth flight gives centimetres (curvature); a pop or a
 *   rubber-band gives metres;
 * - backwards frames: frames in which a dragon moved against its own velocity.
 */

import { describe, expect, it } from 'vitest';
import {
  BUTTON_BOOST,
  BUTTON_DIVE,
  BUTTON_DODGE_LEFT,
  BUTTON_DODGE_RIGHT,
  BUTTON_FLAP,
  DRAGON_FLAG_ALIVE,
  FLIGHT_TUNING,
  MAX_EXTRAPOLATION_MS,
  TEAM_EMBER,
  TEAM_FROST,
  TICK_MS,
  createGreyboxSpires,
  createInputFrame,
  createSeededRandom,
  createWorldView,
} from '../../src/shared';
import type { InputFrame, Vec3 } from '../../src/shared';
import { createMapCollisionWorld, createSim, findDragon } from '../../src/sim';
import type { DragonState } from '../../src/sim';
import { ClockSync } from '../../src/net/clock';
import {
  Reader,
  Writer,
  decodeInput,
  decodeSnapshot,
  encodeInput,
  encodeSnapshot,
} from '../../src/net/codec';
import {
  ClientPredictor,
  HostInputBuffer,
  InputTiming,
  RECONCILE_CORRECTED,
  RECONCILE_SNAPPED,
  initialInputLeadTicks,
} from '../../src/net/prediction';
import { FAST_MAX_BYTES, createInputMessage, createSnapshotMessage } from '../../src/net/protocol';
import {
  ClientRoster,
  HostSnapshotBuilder,
  SnapshotBuffer,
  buildClientWorldView,
  createSnapshotClock,
  createSnapshotSample,
  shouldSendSnapshot,
} from '../../src/net/snapshot';

const HOST_ID = 0;
const CLIENT_ID = 1;
const BOT_ID = 2;

interface Link {
  latencyMs: number;
  jitterMs: number;
  loss: number;
}

const PERFECT: Link = { latencyMs: 20, jitterMs: 0, loss: 0 };
/** docs/NETWORKING.md: the standard "bad Wi-Fi" profile. */
const BAD_WIFI: Link = { latencyMs: 80, jitterMs: 20, loss: 0.02 };

/** `dragon` is what the pilot sees of their own dragon (null before the first snapshot). */
type Script = (step: number, frame: InputFrame, dragon: Readonly<DragonState> | null) => void;

/** Steer-Y that holds an altitude, so a long flight stays inside the range the wire carries. */
function holdAltitude(dragon: Readonly<DragonState> | null, altitude: number): number {
  if (dragon === null) return 0;
  // Fold free-pitch wraps into a small band so the hold controller cannot wind into a loop.
  let pitch = dragon.pitch;
  while (pitch > Math.PI) pitch -= Math.PI * 2;
  while (pitch < -Math.PI) pitch += Math.PI * 2;
  pitch = Math.max(-1.2, Math.min(1.2, pitch));
  const wantedPitch = Math.max(-0.5, Math.min(0.5, (altitude - dragon.position.y) / 150));
  return Math.max(-1, Math.min(1, (wantedPitch - pitch) * 2));
}

interface RunOptions {
  durationMs: number;
  link: Link;
  seed?: number;
  /** Real greybox map collision on both sides (default: open sky). */
  map?: boolean;
  /** Where the client's dragon starts, and its heading. */
  spawn?: Vec3;
  spawnYaw?: number;
  /** The client's clock runs this much faster than the host's (1.001 = 0.1 % fast). */
  clientClockRate?: number;
  frameMs?: number;
  /** First host tick: put it just under 65536 to cross the wire wrap. */
  startTick?: number;
  /** The client freezes (no frames, nothing received) in this window of real ms. */
  stall?: { fromMs: number; toMs: number };
  /** Every snapshot sent in this window is lost. */
  blackout?: { fromMs: number; toMs: number };
  script?: Script;
}

interface RunResult {
  /** Largest prediction error (m) over the ticks after `settleMs`. */
  maxPredictionError: number;
  predictedTicks: number;
  /** Corrections (smoothed or snapped) after `SETTLE_MS`, and how many of them snapped. */
  lateCorrections: number;
  lateSnaps: number;
  /** Largest correction (m) after `SETTLE_MS`. */
  lateLargestCorrection: number;
  /** Prediction error and host-side input margin over the last FINAL_WINDOW_MS of the run. */
  finalPredictionError: number;
  finalMinMargin: number;
  finalMaxMargin: number;
  /** Largest per-frame discontinuity of the client's own dragon (m), after settling. */
  ownDiscontinuity: number;
  /** Same for the two remote dragons. */
  remoteDiscontinuity: number;
  remoteBackwardFrames: number;
  /** Largest distance a remote dragon moved in one frame, divided by that frame's dt (m/s). */
  remoteMaxFrameSpeed: number;
  terrainHits: number;
  hostRepeated: number;
  hostEmpty: number;
  hostLate: number;
  /** Lowest and highest input margin the host saw, after settling. */
  minMargin: number;
  maxMargin: number;
  resyncs: number;
  finalDelayMs: number;
  maxExtrapolatedMs: number;
  starvedFrames: number;
  /** While starved: largest movement of a remote dragon after the extrapolation ran out (m). */
  heldMovement: number;
  playbackSnaps: number;
  duplicatesDropped: number;
  hostTicks: number;
  clientAlive: boolean;
  /** Furthest any drawn dragon got from the map centre (m): must stay inside the wire range. */
  maxRange: number;
  /** A digest of everything drawn, for the determinism test. */
  digest: number;
}

const SETTLE_MS = 3000;
const FINAL_WINDOW_MS = 5000;

function defaultScript(
  step: number,
  frame: InputFrame,
  dragon: Readonly<DragonState> | null,
): void {
  // The constant part keeps the flight a loop, inside the range the wire can carry.
  frame.steerX = 0.3 + Math.sin(step * 0.05) * 0.6;
  frame.steerY = holdAltitude(dragon, 320) * 0.7 + Math.sin(step * 0.031) * 0.3;
  let buttons = 0;
  if (step % 200 < 60) buttons |= BUTTON_BOOST;
  if (step % 150 === 20) buttons |= BUTTON_DODGE_LEFT;
  if (step % 150 === 95) buttons |= BUTTON_DODGE_RIGHT;
  if (step % 90 < 3) buttons |= BUTTON_FLAP;
  if (step % 400 >= 300 && step % 400 < 320) buttons |= BUTTON_DIVE;
  frame.buttons = buttons;
}

function botScript(
  tick: number,
  id: number,
  frame: InputFrame,
  dragon: Readonly<DragonState> | null,
): void {
  frame.steerX = -0.3 + Math.sin(tick * 0.04 + id) * 0.6;
  frame.steerY = holdAltitude(dragon, 340 + id * 20) * 0.7 + Math.sin(tick * 0.023 + id * 2) * 0.3;
  frame.buttons = (tick + id * 40) % 180 < 50 ? BUTTON_BOOST : 0;
}

interface Packet {
  at: number;
  order: number;
  toHost: boolean;
  kind: 'fast' | 'ping' | 'pong';
  bytes: Uint8Array | null;
  a: number;
  b: number;
  c: number;
}

function run(options: RunOptions): RunResult {
  const random = createSeededRandom(options.seed ?? 1234);
  const link = options.link;
  const rate = options.clientClockRate ?? 1;
  const frameMs = options.frameMs ?? 1000 / 60;
  const startTick = options.startTick ?? 0;
  const script = options.script ?? defaultScript;
  const map = options.map === true ? createGreyboxSpires() : null;

  // --- Host ------------------------------------------------------------------------------------
  let terrainHits = 0;
  const hostCollision =
    map !== null
      ? createMapCollisionWorld(map, {
          onTerrainHit: (dragon) => {
            if (dragon.id === CLIENT_ID) terrainHits++;
          },
        })
      : undefined;
  const sim = createSim(hostCollision !== undefined ? { collisionWorld: hostCollision } : {});
  const spawn = options.spawn ?? { x: 0, y: 320, z: -300 };
  sim.spawnDragon(HOST_ID, TEAM_EMBER, 'talon', { x: 60, y: 340, z: 0 }, 0.4);
  sim.spawnDragon(CLIENT_ID, TEAM_FROST, 'tempest', spawn, options.spawnYaw ?? 0);
  sim.spawnDragon(BOT_ID, TEAM_FROST, 'bastion', { x: -80, y: 360, z: 100 }, 2);
  const hostInputs = new HostInputBuffer();
  const builder = new HostSnapshotBuilder();
  const snapshotClock = createSnapshotClock();
  const hostWriter = new Writer(FAST_MAX_BYTES);
  const hostReader = new Reader();
  const inputIn = createInputMessage();
  const simInputs: (InputFrame | undefined)[] = [];
  const hostFrame = createInputFrame();
  const botFrame = createInputFrame();
  let hostTick = startTick - 1;
  let nextHostTickAt = 0;
  const hostPositions = new Map<number, { x: number; y: number; z: number }>();

  // --- Client ----------------------------------------------------------------------------------
  const clientCollision = map !== null ? createMapCollisionWorld(map) : undefined;
  const predictor = new ClientPredictor(
    clientCollision !== undefined ? { collisionWorld: clientCollision } : {},
  );
  predictor.configure(CLIENT_ID, TEAM_FROST, 'tempest');
  const buffer = new SnapshotBuffer();
  const clock = new ClockSync();
  const timing = new InputTiming();
  const roster = new ClientRoster();
  roster.set(HOST_ID, TEAM_EMBER, 'talon');
  roster.set(CLIENT_ID, TEAM_FROST, 'tempest');
  roster.set(BOT_ID, TEAM_FROST, 'bastion');
  const clientWriter = new Writer(FAST_MAX_BYTES);
  const clientReader = new Reader();
  const inputOut = createInputMessage();
  const snapshotIn = createSnapshotMessage();
  const sample = createSnapshotSample();
  const view = createWorldView();
  const frame = createInputFrame();
  const predictedPositions = new Map<number, { x: number; y: number; z: number }>();
  let started = false;
  let accumulatorMs = 0;
  let stepIndex = 0;
  let lastSnapshotTick = -1;
  let lastClientNow = 0;
  let nextFrameAt = 0;
  let nextPingAt = 0;
  let resyncs = 0;

  // --- Network ---------------------------------------------------------------------------------
  const queue: Packet[] = [];
  let order = 0;
  let lastReliableToHost = 0;
  let lastReliableToClient = 0;
  function delay(): number {
    return link.latencyMs + (random() * 2 - 1) * link.jitterMs;
  }
  function sendFast(now: number, toHost: boolean, bytes: Uint8Array): void {
    const lost = random() < link.loss;
    const at = now + delay();
    if (lost) return;
    if (
      !toHost &&
      options.blackout &&
      now >= options.blackout.fromMs &&
      now < options.blackout.toMs
    ) {
      return;
    }
    queue.push({
      at,
      order: order++,
      toHost,
      kind: 'fast',
      bytes: bytes.slice(),
      a: 0,
      b: 0,
      c: 0,
    });
  }
  /** `ctrl`: never lost, never reordered. */
  function sendReliable(
    now: number,
    toHost: boolean,
    kind: 'ping' | 'pong',
    a: number,
    b: number,
    c: number,
  ): void {
    let at = now + delay();
    if (toHost) {
      at = Math.max(at, lastReliableToHost);
      lastReliableToHost = at;
    } else {
      at = Math.max(at, lastReliableToClient);
      lastReliableToClient = at;
    }
    queue.push({ at, order: order++, toHost, kind, bytes: null, a, b, c });
  }

  // --- Metrics ---------------------------------------------------------------------------------
  let maxPredictionError = 0;
  let predictedTicks = 0;
  let ownDiscontinuity = 0;
  let remoteDiscontinuity = 0;
  let remoteBackwardFrames = 0;
  let remoteMaxFrameSpeed = 0;
  let minMargin = Infinity;
  let maxMargin = -Infinity;
  let maxExtrapolatedMs = 0;
  let starvedFrames = 0;
  let heldMovement = 0;
  let digest = 0;
  let maxRange = 0;
  /** >= 0 once the run is past SETTLE_MS: only then do corrections count as "late". */
  let lateFrom = -1;
  let lateCorrections = 0;
  let lateSnaps = 0;
  let lateLargestCorrection = 0;
  let finalPredictionError = 0;
  let finalMinMargin = Infinity;
  let finalMaxMargin = -Infinity;
  let wasHeld = false;
  const finalFromMs = options.durationMs - FINAL_WINDOW_MS;
  const last = new Map<
    number,
    { x: number; y: number; z: number; vx: number; vy: number; vz: number }
  >();

  function mix(value: number): void {
    digest = (Math.imul(digest, 31) + Math.round(value * 1000)) | 0;
  }

  function stalledAt(now: number): boolean {
    return options.stall !== undefined && now >= options.stall.fromMs && now < options.stall.toMs;
  }

  function hostStep(now: number): void {
    hostTick++;
    simInputs[CLIENT_ID] = hostInputs.take(hostTick) as InputFrame | undefined;
    botScript(hostTick, HOST_ID, hostFrame, findDragon(sim.current, HOST_ID) ?? null);
    simInputs[HOST_ID] = hostFrame;
    botScript(hostTick, BOT_ID, botFrame, findDragon(sim.current, BOT_ID) ?? null);
    simInputs[BOT_ID] = botFrame;
    sim.step(hostTick, simInputs);

    const dragon = findDragon(sim.current, CLIENT_ID);
    if (dragon !== undefined) {
      hostPositions.set(hostTick, { ...dragon.position });
      hostPositions.delete(hostTick - 600);
      const predicted = predictedPositions.get(hostTick);
      if (predicted !== undefined && now >= SETTLE_MS) {
        const error = Math.hypot(
          predicted.x - dragon.position.x,
          predicted.y - dragon.position.y,
          predicted.z - dragon.position.z,
        );
        if (error > maxPredictionError) maxPredictionError = error;
        if (now >= finalFromMs && error > finalPredictionError) finalPredictionError = error;
        predictedTicks++;
      }
      predictedPositions.delete(hostTick);
    }
    if (now >= SETTLE_MS && hostInputs.hasAck) {
      const margin = hostInputs.margin(hostTick);
      if (margin < minMargin) minMargin = margin;
      if (margin > maxMargin) maxMargin = margin;
      if (now >= finalFromMs) {
        if (margin < finalMinMargin) finalMinMargin = margin;
        if (margin > finalMaxMargin) finalMaxMargin = margin;
      }
    }

    if (shouldSendSnapshot(hostTick)) {
      snapshotClock.phaseTimeS = (hostTick - startTick) * (TICK_MS / 1000);
      builder.begin(sim.current, snapshotClock);
      const message = builder.forRecipient(CLIENT_ID, hostInputs.hasAck, hostInputs.ackTick);
      const length = encodeSnapshot(hostWriter, message);
      expect(length).toBeGreaterThan(0);
      sendFast(now, false, hostWriter.packet(length));
    }
  }

  function clientReceive(packet: Packet, clientNow: number): void {
    if (packet.kind === 'pong') {
      clock.addSample(packet.a, packet.b, packet.c, clientNow);
      return;
    }
    if (packet.bytes === null || clock.sampleCount === 0) return;
    const bytes = packet.bytes;
    clientReader.reset(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    if (!decodeSnapshot(clientReader, snapshotIn)) throw new Error('snapshot did not decode');
    const tick = buffer.push(snapshotIn, clientNow, clock.hostTickAt(clientNow));
    if (tick < 0 || tick <= lastSnapshotTick) return;
    lastSnapshotTick = tick;
    if (!started) return;
    timing.onSnapshot(snapshotIn.hasAck, snapshotIn.ackInputTick, snapshotIn.tick);
    const result = predictor.reconcile(snapshotIn, tick);
    if (lateFrom >= 0 && (result === RECONCILE_CORRECTED || result === RECONCILE_SNAPPED)) {
      lateCorrections++;
      if (result === RECONCILE_SNAPPED) lateSnaps++;
      if (predictor.lastCorrectionM > lateLargestCorrection) {
        lateLargestCorrection = predictor.lastCorrectionM;
      }
    }
    if (timing.resyncTicks !== 0) {
      predictor.shiftTick(timing.resyncTicks);
      timing.resyncApplied(clock.rttMs);
      resyncs++;
    }
  }

  function clientFrame(now: number, clientNow: number): void {
    const dtMs = clientNow - lastClientNow;
    lastClientNow = clientNow;

    if (clientNow >= nextPingAt) {
      // A burst while syncing, then the 2 Hz of the spec.
      nextPingAt = clientNow + (clock.synced ? 500 : 100);
      sendReliable(now, true, 'ping', clientNow, 0, 0);
    }

    if (!started && clock.synced) {
      started = true;
      predictor.setTick(
        Math.floor(clock.hostTickAt(clientNow)) +
          initialInputLeadTicks(clock.rttMs, clock.rttJitterMs),
      );
    }

    if (started) {
      accumulatorMs += dtMs * timing.timeScale;
      let steps = 0;
      while (accumulatorMs >= TICK_MS && steps < 5) {
        accumulatorMs -= TICK_MS;
        steps++;
        script(stepIndex++, frame, predictor.active ? predictor.dragon : null);
        const tick = predictor.step(frame);
        if (predictor.active) {
          predictedPositions.set(tick, { ...predictor.dragon.position });
          predictedPositions.delete(tick - 600);
        }
        const count = predictor.writeInputMessage(
          inputOut,
          lastSnapshotTick >= 0,
          lastSnapshotTick,
        );
        expect(count).toBeGreaterThan(0);
        const length = encodeInput(clientWriter, inputOut);
        sendFast(now, true, clientWriter.packet(length));
      }
      if (accumulatorMs >= TICK_MS) accumulatorMs %= TICK_MS;
    }

    buffer.update(clientNow);
    buffer.sample(sample);
    predictor.updateSmoothing(dtMs);
    buildClientWorldView(view, sample, predictor, accumulatorMs / TICK_MS, roster, {
      localDragonId: CLIENT_ID,
      stormWall: null,
    });

    if (sample.starved) {
      starvedFrames++;
      if (sample.extrapolatedMs > maxExtrapolatedMs) maxExtrapolatedMs = sample.extrapolatedMs;
    }
    const held = sample.starved && sample.extrapolatedMs >= MAX_EXTRAPOLATION_MS;

    const dtS = dtMs / 1000;
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon === undefined) continue;
      mix(dragon.position.x);
      mix(dragon.position.y);
      mix(dragon.position.z);
      mix(dragon.orientation.w);
      const range = Math.hypot(dragon.position.x, dragon.position.y - 350, dragon.position.z);
      if (range > maxRange) maxRange = range;
      const before = last.get(dragon.id);
      const own = dragon.id === CLIENT_ID && predictor.active;
      if (before !== undefined && dtS > 0 && dtS < 0.1 && now >= SETTLE_MS) {
        const dx = dragon.position.x - before.x;
        const dy = dragon.position.y - before.y;
        const dz = dragon.position.z - before.z;
        // The own dragon moves on sim time, which `timeScale` stretches by up to 3 %.
        const scale = own ? timing.timeScale : buffer.clock.rate;
        const ex = dx - before.vx * dtS * scale;
        const ey = dy - before.vy * dtS * scale;
        const ez = dz - before.vz * dtS * scale;
        const discontinuity = Math.hypot(ex, ey, ez);
        if (own) {
          if (discontinuity > ownDiscontinuity) ownDiscontinuity = discontinuity;
        } else if (held) {
          // Held on both this frame and the last: the dragon must not move at all.
          if (wasHeld) heldMovement = Math.max(heldMovement, Math.hypot(dx, dy, dz));
        } else {
          if (discontinuity > remoteDiscontinuity) remoteDiscontinuity = discontinuity;
          const frameSpeed = Math.hypot(dx, dy, dz) / dtS;
          if (frameSpeed > remoteMaxFrameSpeed) remoteMaxFrameSpeed = frameSpeed;
          const along = dx * before.vx + dy * before.vy + dz * before.vz;
          const speed = Math.hypot(before.vx, before.vy, before.vz);
          if (speed > 5 && along < -0.02 * speed) remoteBackwardFrames++;
        }
      }
      last.set(dragon.id, {
        x: dragon.position.x,
        y: dragon.position.y,
        z: dragon.position.z,
        vx: dragon.velocity.x,
        vy: dragon.velocity.y,
        vz: dragon.velocity.z,
      });
    }
    wasHeld = held;
  }

  // --- The loop: one iteration per millisecond ------------------------------------------------
  const heldPackets: Packet[] = [];
  for (let now = 0; now <= options.durationMs; now++) {
    const clientNow = now * rate + 5000;
    if (now >= SETTLE_MS) lateFrom = now;
    const stalled = stalledAt(now);

    // Deliveries, in arrival order.
    queue.sort((p, q) => p.at - q.at || p.order - q.order);
    while (queue.length > 0) {
      const packet = queue[0];
      if (packet === undefined || packet.at > now) break;
      queue.shift();
      if (packet.toHost) {
        if (packet.kind === 'ping') {
          sendReliable(now, false, 'pong', packet.a, now + 777_000, Math.max(hostTick, 0));
        } else if (packet.bytes !== null) {
          const bytes = packet.bytes;
          hostReader.reset(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
          if (!decodeInput(hostReader, inputIn)) throw new Error('input did not decode');
          hostInputs.push(inputIn, hostTick);
        }
      } else if (stalled) {
        heldPackets.push(packet);
      } else {
        clientReceive(packet, clientNow);
      }
    }
    if (!stalled && heldPackets.length > 0) {
      for (const packet of heldPackets) clientReceive(packet, clientNow);
      heldPackets.length = 0;
    }

    if (now >= nextHostTickAt) {
      nextHostTickAt += TICK_MS;
      hostStep(now);
    }
    if (now >= nextFrameAt) {
      nextFrameAt += frameMs;
      if (!stalled) clientFrame(now, clientNow);
    }
  }

  const clientDragon = findDragon(sim.current, CLIENT_ID);
  return {
    maxPredictionError,
    predictedTicks,
    lateCorrections,
    lateSnaps,
    lateLargestCorrection,
    finalPredictionError,
    finalMinMargin,
    finalMaxMargin,
    ownDiscontinuity,
    remoteDiscontinuity,
    remoteBackwardFrames,
    remoteMaxFrameSpeed,
    terrainHits,
    hostRepeated: hostInputs.repeatedCount,
    hostEmpty: hostInputs.emptyCount,
    hostLate: hostInputs.lateCount,
    minMargin,
    maxMargin,
    resyncs,
    finalDelayMs: buffer.clock.delayMs,
    maxExtrapolatedMs,
    starvedFrames,
    heldMovement,
    playbackSnaps: buffer.clock.snapCount,
    duplicatesDropped: buffer.duplicateCount,
    hostTicks: hostTick - startTick + 1,
    clientAlive: clientDragon !== undefined && (clientDragon.flags & DRAGON_FLAG_ALIVE) !== 0,
    maxRange,
    digest,
  };
}

/** A low weave between the spires: the route bounces off terrain several times and survives. */
const weave: Script = (step, frame, dragon) => {
  frame.steerX = 0.25 + Math.sin(step * 0.02) * 0.5;
  frame.steerY = holdAltitude(dragon, 60);
  frame.buttons = 0;
};

let perfectBaseline: RunResult | null = null;
function baseline(): RunResult {
  perfectBaseline ??= run({ durationMs: 60_000, link: PERFECT });
  return perfectBaseline;
}

describe('perfect network (20 ms, no jitter, no loss)', () => {
  it('predicts the host exactly: no correction after start-up, error far below a millimetre', () => {
    const result = baseline();
    expect(result.predictedTicks).toBeGreaterThan(1600);
    expect(result.maxPredictionError).toBeLessThan(1e-3);
    expect(result.lateCorrections).toBe(0);
    expect(result.resyncs).toBe(0);
    // The host always had the input for the tick it simulated, with one tick to spare.
    expect(result.minMargin).toBeGreaterThanOrEqual(1);
    expect(result.maxMargin).toBeLessThanOrEqual(2);
    expect(result.maxRange).toBeLessThan(1500);
  });

  it('draws remote dragons smoothly at the minimum delay, never starved', () => {
    const result = baseline();
    expect(result.finalDelayMs).toBeCloseTo(70, 0);
    expect(result.starvedFrames).toBe(0);
    expect(result.playbackSnaps).toBe(0);
    expect(result.remoteBackwardFrames).toBe(0);
    expect(result.remoteDiscontinuity).toBeLessThan(0.15);
    expect(result.remoteMaxFrameSpeed).toBeLessThan(120);
  });

  it.each([
    { spawn: { x: 30, y: 40, z: -200 }, spawnYaw: 0 },
    { spawn: { x: 30, y: 120, z: -400 }, spawnYaw: 1.5 },
  ])('stays exact through terrain bounces on the real map (yaw $spawnYaw)', (route) => {
    // Soft-cap pitch for this route: free inverted loops make a low weave skip the pillars.
    const prevClimb = FLIGHT_TUNING.maxClimbPitch;
    const prevDive = FLIGHT_TUNING.maxDivePitch;
    FLIGHT_TUNING.maxClimbPitch = 1.05;
    FLIGHT_TUNING.maxDivePitch = 1.3;
    try {
      const result = run({ durationMs: 60_000, link: PERFECT, map: true, script: weave, ...route });
      expect(result.terrainHits).toBeGreaterThanOrEqual(1);
      expect(result.clientAlive).toBe(true);
      // A bounce amplifies the f32 rounding of the first owner block; still millimetres.
      expect(result.maxPredictionError).toBeLessThan(0.02);
      expect(result.lateCorrections).toBe(0);
    } finally {
      FLIGHT_TUNING.maxClimbPitch = prevClimb;
      FLIGHT_TUNING.maxDivePitch = prevDive;
    }
  });
});

describe('bad Wi-Fi (80 ms +- 20 ms, 2 % loss)', () => {
  it.each([1, 2, 3, 4])('remote dragons stay continuous, never backwards (seed %i)', (seed) => {
    const result = run({ durationMs: 60_000, link: BAD_WIFI, seed });
    expect(result.remoteBackwardFrames).toBe(0);
    // Centimetres per frame off the drawn velocity; a pop would be metres.
    expect(result.remoteDiscontinuity).toBeLessThan(0.3);
    expect(result.remoteMaxFrameSpeed).toBeLessThan(120);
    expect(result.playbackSnaps).toBe(0);
    // The delay settled near the nominal 100 ms, inside the 70-150 ms band.
    expect(result.finalDelayMs).toBeGreaterThan(85);
    expect(result.finalDelayMs).toBeLessThan(120);
    expect(result.maxExtrapolatedMs).toBeLessThanOrEqual(MAX_EXTRAPOLATION_MS);
    expect(result.heldMovement).toBe(0);
  });

  it.each([1, 2, 3, 4])('the own dragon is corrected rarely, by little (seed %i)', (seed) => {
    const result = run({ durationMs: 60_000, link: BAD_WIFI, seed });
    expect(result.lateSnaps).toBe(0);
    expect(result.lateCorrections).toBeLessThanOrEqual(6);
    expect(result.lateLargestCorrection).toBeLessThan(2);
    // No rubber-banding: the drawn dragon is never further from its own extrapolation than
    // on a perfect network (where the only "jump" is the dodge impulse) plus a small allowance.
    expect(result.ownDiscontinuity).toBeLessThan(baseline().ownDiscontinuity + 0.25);
    // Redundant inputs + the timing loop: the host all but never ran out of this client's input.
    expect(result.minMargin).toBeGreaterThanOrEqual(0);
    expect(result.maxMargin).toBeLessThanOrEqual(5);
    expect(result.resyncs).toBe(0);
    expect(result.hostLate).toBe(0);
  });

  it('crosses the 16-bit tick wrap without noticing', () => {
    const result = run({ durationMs: 30_000, link: BAD_WIFI, startTick: 65536 - 300 });
    expect(result.hostTicks).toBeGreaterThan(600);
    expect(result.remoteBackwardFrames).toBe(0);
    expect(result.remoteDiscontinuity).toBeLessThan(0.3);
    expect(result.playbackSnaps).toBe(0);
    expect(result.lateSnaps).toBe(0);
    expect(result.resyncs).toBe(0);
    expect(result.maxPredictionError).toBeLessThan(2);
    expect(result.finalPredictionError).toBeLessThan(1e-3);
  });
});

describe('a much worse link (120 ms +- 40 ms, 15 % loss)', () => {
  it.each([1, 2, 3])('still corrects by decimetres and smooths it (seed %i)', (seed) => {
    const result = run({
      durationMs: 60_000,
      link: { latencyMs: 120, jitterMs: 40, loss: 0.15 },
      seed,
    });
    expect(result.lateCorrections).toBeGreaterThan(0);
    expect(result.lateSnaps).toBe(0);
    expect(result.lateLargestCorrection).toBeLessThan(3);
    expect(result.ownDiscontinuity).toBeLessThan(baseline().ownDiscontinuity + 0.5);
    expect(result.remoteBackwardFrames).toBe(0);
    expect(result.remoteDiscontinuity).toBeLessThan(1.5);
    expect(result.finalDelayMs).toBeGreaterThan(110);
    expect(result.finalDelayMs).toBeLessThanOrEqual(150);
    expect(result.resyncs).toBe(0);
  });
});

describe('clock drift', () => {
  // 0.2 % over 90 s is 5.4 ticks: with no correction the margin would leave the buffer.
  it.each([1.002, 0.998])('time dilation holds the input margin (client clock x%f)', (rate) => {
    const result = run({ durationMs: 90_000, link: BAD_WIFI, clientClockRate: rate });
    expect(result.resyncs).toBe(0);
    expect(result.minMargin).toBeGreaterThanOrEqual(0);
    expect(result.maxMargin).toBeLessThanOrEqual(5);
    expect(result.finalMinMargin).toBeGreaterThanOrEqual(0);
    expect(result.finalMaxMargin).toBeLessThanOrEqual(5);
    expect(result.lateSnaps).toBe(0);
    expect(result.remoteBackwardFrames).toBe(0);
    expect(result.playbackSnaps).toBe(0);
  });
});

describe('stalls and starvation', () => {
  it('a 1.2 s client freeze is jumped over and everything is in step again afterwards', () => {
    const result = run({
      durationMs: 20_000,
      link: BAD_WIFI,
      stall: { fromMs: 8000, toMs: 9200 },
    });
    expect(result.resyncs).toBeGreaterThanOrEqual(1);
    expect(result.resyncs).toBeLessThanOrEqual(3);
    // During the freeze the host ran dry and flew the dragon itself...
    expect(result.hostEmpty).toBeGreaterThan(20);
    // ...and by the end prediction is exact again with a normal margin.
    expect(result.finalPredictionError).toBeLessThan(1e-3);
    expect(result.finalMinMargin).toBeGreaterThanOrEqual(0);
    expect(result.finalMaxMargin).toBeLessThanOrEqual(5);
    expect(result.remoteBackwardFrames).toBe(0);
  });

  it('with no snapshots for 1 s remote dragons extrapolate 150 ms, then hold still', () => {
    const result = run({
      durationMs: 20_000,
      link: PERFECT,
      blackout: { fromMs: 8000, toMs: 9000 },
    });
    expect(result.starvedFrames).toBeGreaterThan(40);
    expect(result.maxExtrapolatedMs).toBe(MAX_EXTRAPOLATION_MS);
    expect(result.heldMovement).toBe(0);
    expect(result.remoteBackwardFrames).toBe(0);
    // The own dragon does not care: prediction ran on, and was right.
    expect(result.maxPredictionError).toBeLessThan(1e-3);
    expect(result.lateCorrections).toBe(0);
  });

  it('after a short gap (250 ms) the remote dragons catch up without a pop', () => {
    const result = run({
      durationMs: 20_000,
      link: PERFECT,
      blackout: { fromMs: 8000, toMs: 8250 },
    });
    expect(result.starvedFrames).toBeGreaterThan(5);
    expect(result.heldMovement).toBe(0);
    expect(result.remoteBackwardFrames).toBe(0);
    // About 6 m of error is closed over ~100 ms: fast, but several frames, not one.
    expect(result.remoteDiscontinuity).toBeLessThan(4);
  });
});

describe('determinism', () => {
  it('the same seed gives the same run, bit for bit; another seed does not', () => {
    const options: RunOptions = { durationMs: 15_000, link: BAD_WIFI, seed: 99, map: true };
    const first = run(options);
    const second = run(options);
    expect(second).toEqual(first);
    const other = run({ ...options, seed: 100 });
    expect(other.digest).not.toBe(first.digest);
  });
});
