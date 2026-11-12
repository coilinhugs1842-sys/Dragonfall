/**
 * Ember Relay's view (T-6.3): the built shapes (sound, inside their budget, a team's form in
 * threes or fours), and the view itself: hidden outside the mode, the anchors and shard poses
 * it writes from a WorldView, what each preset draws, and no garbage per frame.
 */

import { Matrix4, Vector3, Vector4 } from 'three';
import type { Mesh, ShaderMaterial } from 'three';
import { describe, expect, it } from 'vitest';
import {
  DRAGON_FLAG_ALIVE,
  NO_PLAYER,
  QUALITY_PRESETS,
  SHARD_CARRIED,
  SHARD_DROPPED,
  SHARD_HOME,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../src/shared';
import type { MutableWorldView, TeamId } from '../../src/shared';
import {
  ANCHOR_BRAZIER,
  ANCHOR_COUNT,
  ANCHOR_SHARD,
  ANCHOR_STAND,
  BEACON_HEIGHT_M,
  BRAZIER_COALS_DEPTH_M,
  FLAMES_PER_BRAZIER,
  SHARD_LENGTH_M,
  STAND_DAIS_DEPTH_M,
  buildRelayShards,
  buildRelayStone,
  createEmberRelayView,
  teamFold,
} from '../../src/world/relay';
import type { RelayMeshData } from '../../src/world/relay';

function verticesOf(data: RelayMeshData, anchor: number): number[] {
  const out: number[] = [];
  for (let v = 0; v < data.anchors.length; v++) if (data.anchors[v] === anchor) out.push(v);
  return out;
}

function boundsOf(data: RelayMeshData, anchor: number): { minY: number; maxY: number; radius: number } {
  let minY = Infinity;
  let maxY = -Infinity;
  let radius = 0;
  for (const v of verticesOf(data, anchor)) {
    const x = data.positions[v * 3] ?? 0;
    const y = data.positions[v * 3 + 1] ?? 0;
    const z = data.positions[v * 3 + 2] ?? 0;
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    radius = Math.max(radius, Math.hypot(x, z));
  }
  return { minY, maxY, radius };
}

function expectSound(data: RelayMeshData): void {
  const vertices = data.triangles * 3;
  expect(Number.isInteger(data.triangles)).toBe(true);
  expect(data.positions).toHaveLength(vertices * 3);
  expect(data.normals).toHaveLength(vertices * 3);
  expect(data.colors).toHaveLength(vertices * 4);
  expect(data.anchors).toHaveLength(vertices);
  for (let v = 0; v < vertices; v++) {
    const nx = data.normals[v * 3] ?? 0;
    const ny = data.normals[v * 3 + 1] ?? 0;
    const nz = data.normals[v * 3 + 2] ?? 0;
    expect(Math.hypot(nx, ny, nz)).toBeCloseTo(1, 4);
    for (let c = 0; c < 4; c++) {
      const value = data.colors[v * 4 + c] ?? Number.NaN;
      expect(Number.isFinite(value) && value >= 0).toBe(true);
    }
    for (let c = 0; c < 3; c++) expect(Number.isFinite(data.positions[v * 3 + c])).toBe(true);
  }
}

describe('relay shapes', () => {
  it('builds the stands and braziers as one sound mesh inside the budget', () => {
    const stone = buildRelayStone();
    expectSound(stone);
    expect(stone.triangles).toBeGreaterThan(300);
    expect(stone.triangles).toBeLessThanOrEqual(900);
    // Deterministic: the same rock on every machine and in every match.
    expect(buildRelayStone().positions).toEqual(stone.positions);
    const anchors = new Set(stone.anchors);
    expect([...anchors].sort()).toEqual([
      ANCHOR_STAND + TEAM_EMBER,
      ANCHOR_STAND + TEAM_FROST,
      ANCHOR_BRAZIER + TEAM_EMBER,
      ANCHOR_BRAZIER + TEAM_FROST,
    ]);
  });

  it('keeps the stone out of the way of a dragon flying through the site', () => {
    const stone = buildRelayStone();
    for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
      const stand = boundsOf(stone, ANCHOR_STAND + team);
      // Everything is below the hovering shard: the claws stop a metre under its centre.
      expect(stand.maxY).toBeLessThanOrEqual(-1);
      expect(stand.maxY).toBeGreaterThan(-STAND_DAIS_DEPTH_M);
      expect(stand.minY).toBeLessThan(-STAND_DAIS_DEPTH_M - 8);
      expect(stand.radius).toBeLessThan(10);
      const brazier = boundsOf(stone, ANCHOR_BRAZIER + team);
      // The bowl is under the flame's heart; only the horn tips stand a little higher.
      expect(brazier.maxY).toBeLessThanOrEqual(3);
      expect(brazier.minY).toBeLessThan(-BRAZIER_COALS_DEPTH_M - 12);
      expect(brazier.radius).toBeLessThan(13);
    }
  });

  it('gives each team its own form: threes for Ember, fours for Frost', () => {
    expect(teamFold(TEAM_EMBER)).toBe(3);
    expect(teamFold(TEAM_FROST)).toBe(4);
    const stone = buildRelayStone();
    const shards = buildRelayShards();
    // More sides, claws and horns: Frost's pieces have more triangles than Ember's.
    for (const anchor of [ANCHOR_STAND, ANCHOR_BRAZIER]) {
      expect(verticesOf(stone, anchor + TEAM_FROST).length).toBeGreaterThan(
        verticesOf(stone, anchor + TEAM_EMBER).length,
      );
    }
    // Three crystals of two fans each.
    expect(verticesOf(shards, ANCHOR_SHARD + TEAM_EMBER)).toHaveLength(3 * 2 * 3 * 3);
    expect(verticesOf(shards, ANCHOR_SHARD + TEAM_FROST)).toHaveLength(3 * 2 * 4 * 3);
  });

  it('paints light in the team colour and stone without any', () => {
    const stone = buildRelayStone();
    for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
      let lit = 0;
      let redder = 0;
      for (const v of verticesOf(stone, ANCHOR_BRAZIER + team)) {
        if ((stone.colors[v * 4 + 3] ?? 0) < 0.5) continue;
        lit++;
        if ((stone.colors[v * 4] ?? 0) > (stone.colors[v * 4 + 2] ?? 0)) redder++;
      }
      // The coals and the panels under the rim.
      expect(lit).toBeGreaterThan(20);
      // Ember's light is orange (red over blue), Frost's cyan (blue over red).
      expect(redder).toBe(team === TEAM_EMBER ? lit : 0);
    }
  });

  it('centres each shard on its anchor', () => {
    const shards = buildRelayShards();
    expectSound(shards);
    expect(shards.triangles).toBe(3 * 2 * 3 + 3 * 2 * 4);
    for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
      const bounds = boundsOf(shards, ANCHOR_SHARD + team);
      expect(bounds.maxY).toBeCloseTo(SHARD_LENGTH_M / 2, 5);
      expect(bounds.minY).toBeCloseTo(-SHARD_LENGTH_M / 2, 5);
      expect(bounds.radius).toBeLessThan(4);
    }
  });
});

// --- The view -----------------------------------------------------------------------------------------

function sceneView(): MutableWorldView {
  const view = createWorldView();
  beginWorldView(view);
  const relay = view.relay;
  relay.active = true;
  const sites: [TeamId, number][] = [
    [TEAM_EMBER, -500],
    [TEAM_FROST, 500],
  ];
  for (const [team, z] of sites) {
    const stand = relay.stands[team];
    const brazier = relay.braziers[team];
    const shard = relay.shards[team];
    if (stand === undefined || brazier === undefined || shard === undefined) throw new Error('no site');
    stand.x = 10;
    stand.y = 300;
    stand.z = z;
    brazier.x = -40;
    brazier.y = 310;
    brazier.z = z * 1.1;
    shard.status = SHARD_HOME;
    shard.carrierId = NO_PLAYER;
    shard.position.x = stand.x;
    shard.position.y = stand.y;
    shard.position.z = stand.z;
    shard.returnInS = 0;
  }
  return view;
}

function anchorsOf(view: ReturnType<typeof createEmberRelayView>): Vector4[] {
  const stone = view.object.children.find((child) => child.name === 'RelayStone') as Mesh;
  return (stone.material as ShaderMaterial).uniforms['uAnchor']?.value as Vector4[];
}

function shardMatrices(view: ReturnType<typeof createEmberRelayView>): Matrix4[] {
  const shards = view.object.children.find((child) => child.name === 'RelayShards') as Mesh;
  return (shards.material as ShaderMaterial).uniforms['uShardMatrix']?.value as Matrix4[];
}

describe('relay view', () => {
  it('draws nothing until a relay is active, and nothing again after it', () => {
    const relay = createEmberRelayView(QUALITY_PRESETS.medium);
    expect(relay.object.visible).toBe(false);
    const idle = createWorldView();
    beginWorldView(idle);
    relay.update(idle, 1);
    expect(relay.object.visible).toBe(false);
    relay.update(sceneView(), 1);
    expect(relay.object.visible).toBe(true);
    relay.update(idle, 2);
    expect(relay.object.visible).toBe(false);
    relay.dispose();
  });

  it('stays inside the draw-call budget on every preset', () => {
    const relay = createEmberRelayView(QUALITY_PRESETS.low);
    const stone = buildRelayStone().triangles;
    const shards = buildRelayShards().triangles;
    const cards = relay.object.children.find((child) => child.name === 'RelayCards') as Mesh;
    const beacon = (relay.object.children.find((child) => child.name === 'RelayBeacons') as Mesh)
      .material as ShaderMaterial;
    expect(relay.object.children).toHaveLength(4);

    expect(relay.drawCalls).toBe(3);
    expect(cards.visible).toBe(false);
    expect(relay.triangles).toBe(stone + shards + 8);
    expect((beacon.uniforms['uBeacon']?.value as Vector4).x).toBe(BEACON_HEIGHT_M.low);

    relay.setQuality(QUALITY_PRESETS.medium);
    expect(relay.drawCalls).toBe(4);
    expect(cards.visible).toBe(true);
    // The two halos and Medium's flames.
    expect(cards.geometry.drawRange.count).toBe((FLAMES_PER_BRAZIER.medium * 2 + 2) * 6);
    expect(relay.triangles).toBe(stone + shards + 8 + FLAMES_PER_BRAZIER.medium * 4 + 4);

    relay.setQuality(QUALITY_PRESETS.high);
    expect(relay.drawCalls).toBe(4);
    // Every flame and the two halos.
    expect(cards.geometry.drawRange.count).toBe((FLAMES_PER_BRAZIER.high * 2 + 2) * 6);
    expect(relay.triangles).toBe(stone + shards + 8 + FLAMES_PER_BRAZIER.high * 4 + 4);
    expect((beacon.uniforms['uBeacon']?.value as Vector4).x).toBe(BEACON_HEIGHT_M.high);
    expect(relay.triangles).toBeLessThan(1000);

    relay.setQuality(QUALITY_PRESETS.low);
    expect(relay.drawCalls).toBe(3);
    expect(cards.visible).toBe(false);
    relay.dispose();
  });

  it('puts the stone on the sites and each shard where the view says', () => {
    const relay = createEmberRelayView(QUALITY_PRESETS.high);
    const view = sceneView();
    relay.update(view, 0);
    const anchors = anchorsOf(relay);
    expect(anchors).toHaveLength(ANCHOR_COUNT);
    expect(anchors[ANCHOR_STAND + TEAM_FROST]?.toArray()).toEqual([10, 300, 500, 0]);
    expect(anchors[ANCHOR_BRAZIER + TEAM_EMBER]?.toArray()).toEqual([-40, 310, -550, 0]);
    // Home: on its stand, within the bob, state 0.
    const home = anchors[ANCHOR_SHARD + TEAM_EMBER];
    expect(home?.x).toBe(10);
    expect(home?.z).toBe(-500);
    expect(Math.abs((home?.y ?? 0) - 300)).toBeLessThan(0.5);
    expect(home?.w).toBe(SHARD_HOME);

    // Dropped somewhere else.
    const frost = view.relay.shards[TEAM_FROST];
    if (frost === undefined) throw new Error('no shard');
    frost.status = SHARD_DROPPED;
    frost.position.x = 120;
    frost.position.y = 240;
    frost.position.z = 60;
    relay.update(view, 3);
    const dropped = anchors[ANCHOR_SHARD + TEAM_FROST];
    expect(dropped?.x).toBe(120);
    expect(Math.abs((dropped?.y ?? 0) - 240)).toBeLessThan(0.9);
    expect(dropped?.w).toBe(SHARD_DROPPED);
    // The crystal is drawn at the anchor, full size.
    const pose = shardMatrices(relay)[TEAM_FROST];
    const at = new Vector3().setFromMatrixPosition(pose ?? new Matrix4());
    expect(at.x).toBeCloseTo(120, 5);
    expect(at.y).toBeCloseTo(dropped?.y ?? 0, 5);
    expect(new Vector3().setFromMatrixScale(pose ?? new Matrix4()).x).toBeCloseTo(1, 5);
    relay.dispose();
  });

  it('trails a carried shard behind and above its carrier, smaller', () => {
    const relay = createEmberRelayView(QUALITY_PRESETS.medium);
    const view = sceneView();
    const carrier = acquireDragonView(view);
    carrier.id = 7;
    carrier.team = TEAM_EMBER;
    carrier.flags = DRAGON_FLAG_ALIVE;
    carrier.position.x = 200;
    carrier.position.y = 350;
    carrier.position.z = -100;
    // Flying along +X: a quarter turn about +Y from the dragon's own +Z.
    carrier.orientation.x = 0;
    carrier.orientation.y = Math.SQRT1_2;
    carrier.orientation.z = 0;
    carrier.orientation.w = Math.SQRT1_2;
    const frost = view.relay.shards[TEAM_FROST];
    if (frost === undefined) throw new Error('no shard');
    frost.status = SHARD_CARRIED;
    frost.carrierId = 7;
    frost.position.x = carrier.position.x;
    frost.position.y = carrier.position.y;
    frost.position.z = carrier.position.z;
    relay.update(view, 5);
    const anchor = anchorsOf(relay)[ANCHOR_SHARD + TEAM_FROST];
    // Behind (-X of the carrier), a little below, level with it sideways.
    expect(anchor?.x).toBeCloseTo(200 - 3, 4);
    expect(anchor?.y).toBeCloseTo(350 - 1.8, 4);
    expect(anchor?.z).toBeCloseTo(-100, 4);
    expect(anchor?.w).toBe(SHARD_CARRIED);
    const scale = new Vector3().setFromMatrixScale(shardMatrices(relay)[TEAM_FROST] ?? new Matrix4());
    expect(scale.x).toBeLessThan(0.7);

    // A carrier the view does not have (not drawn yet): the shard stays at the reported spot.
    frost.carrierId = 99;
    relay.update(view, 5);
    expect(anchor?.x).toBeCloseTo(200, 5);
    expect(anchor?.y).toBeCloseTo(350, 5);
    relay.dispose();
  });

  it('writes the frame into the same objects every time', () => {
    const relay = createEmberRelayView(QUALITY_PRESETS.high);
    const view = sceneView();
    relay.update(view, 0);
    const anchors = anchorsOf(relay);
    const before = [...anchors];
    const matrices = [...shardMatrices(relay)];
    for (let i = 1; i < 30; i++) relay.update(view, i / 60);
    expect(anchorsOf(relay)).toBe(anchors);
    anchors.forEach((anchor, i) => expect(anchor).toBe(before[i]));
    shardMatrices(relay).forEach((matrix, i) => expect(matrix).toBe(matrices[i]));
    // The shards turn: the pose changes with time while the site does not.
    const early = (matrices[0] ?? new Matrix4()).clone();
    relay.update(view, 9);
    expect(matrices[0]?.equals(early)).toBe(false);
    expect(anchors[ANCHOR_STAND + TEAM_EMBER]?.toArray()).toEqual([10, 300, -500, 0]);
    relay.dispose();
  });
});
