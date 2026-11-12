/**
 * Ember Relay as the riders see it (docs/GAME_DESIGN.md, "Ember Relay"): each team's sky-shard
 * on its stand, dropped in mid-air or held under the tail of the dragon that carries it, each team's
 * brazier, and a column of light over all four so they can be found from across the map.
 *
 * Reads only the WorldView's `relay`: the host and every client draw the same thing from the
 * same numbers, and outside an Ember Relay match (`relay.active` false) nothing is drawn.
 *
 * COST (docs/PERFORMANCE.md): the whole mode is at most four draw calls and about 800 triangles.
 *   Low     3 draws: stone, shards, beacons (the coals glow, there are no flames; a dropped
 *           shard is told by its blinking beacon and its list);
 *   Medium  4 draws: + a halo round each shard (rings run out from a dropped one) and three
 *           flame tongues per brazier;
 *   High    4 draws: five tongues per brazier, taller beacons.
 * No texture, no light, no shadow caster. Per frame: six anchors, two matrices and a time are
 * written; nothing is allocated and no buffer is touched.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Matrix4,
  Mesh,
  NormalBlending,
  ShaderMaterial,
  Vector3,
  Vector4,
} from 'three';
import {
  NO_PLAYER,
  SHARD_CARRIED,
  SHARD_DROPPED,
  TEAMS,
  TEAM_EMBER,
  TEAM_FROST,
  findDragonView,
} from '../../shared';
import type { QualityPreset, QualityPresetId, TeamId, WorldView } from '../../shared';
import { setPaintedColor } from '../light/light-math';
import { useWorldLight } from '../light/light-patch';
import {
  ANCHOR_BRAZIER,
  ANCHOR_COUNT,
  ANCHOR_SHARD,
  ANCHOR_STAND,
  buildRelayShards,
  buildRelayStone,
} from './relay-geometry';
import type { RelayMeshData } from './relay-geometry';
import {
  BEACON_FRAGMENT,
  BEACON_VERTEX,
  CARD_FRAGMENT,
  CARD_VERTEX,
  SHARD_FRAGMENT,
  SHARD_VERTEX,
  STONE_FRAGMENT,
  STONE_VERTEX,
} from './relay-shaders';

/** The palette's objective magenta (docs/ART_DIRECTION.md): a shard lying loose. */
const LOOSE_COLOR = 0xff3fa4;
/** After the opaque world, the clouds and the storm wall (5), before the effect sprites. */
export const RELAY_GLOW_RENDER_ORDER = 6;

/** Height of the light columns in metres. */
export const BEACON_HEIGHT_M: Readonly<Record<QualityPresetId, number>> = {
  low: 150,
  medium: 210,
  high: 270,
};
/** Half-width of a column at its foot, metres (it never gets thinner than a few pixels). */
const BEACON_HALF_WIDTH_M = 2;
/** Light a column adds at its foot, as a multiple of the team colour. */
const BEACON_STRENGTH = 1.25;

/** Flame tongues per brazier. */
export const FLAMES_PER_BRAZIER: Readonly<Record<QualityPresetId, number>> = {
  low: 0,
  medium: 3,
  high: 5,
};
const MAX_FLAMES = FLAMES_PER_BRAZIER.high;
/** Halo radius round a shard, metres (Medium, High). */
const HALO_RADIUS_M = 10;
/** One halo per shard. */
const HALO_QUADS = 2;

/**
 * Where a carried shard rides, in the carrier's own space (forward is +Z): held under the root
 * of the tail. Below the body it never sits between the chase camera and what its own rider
 * is aiming at, and close to the body it does not fill the bottom of that rider's screen (a
 * shard trailing far behind the tail is right in front of the chase camera).
 */
const CARRY_OFFSET = { x: 0, y: -1.8, z: -3 } as const;
const CARRY_SCALE = 0.36;

export interface EmberRelayView {
  /** Add to the scene. Hidden until a WorldView with an active relay is drawn. */
  readonly object: Group;
  /** Draw calls and triangles submitted at the current preset while the mode is on. */
  readonly drawCalls: number;
  readonly triangles: number;
  /** Per frame, after the WorldView is built. Allocation-free. */
  update(view: WorldView, timeS: number): void;
  setQuality(preset: QualityPreset): void;
  dispose(): void;
}

function litGeometry(data: RelayMeshData): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(data.normals, 3));
  geometry.setAttribute('aPaint', new BufferAttribute(data.colors, 4));
  geometry.setAttribute('aAnchor', new BufferAttribute(data.anchors, 1));
  return geometry;
}

interface QuadSpec {
  readonly anchor: number;
  readonly team: TeamId;
  /** `aCard`: kind, seed, half-width, height. Unused by the beacons. */
  readonly card: readonly [number, number, number, number];
}

/** One geometry of camera-facing quads; the vertex shader places them. */
function quadGeometry(quads: readonly QuadSpec[], tints: readonly Color[]): BufferGeometry {
  const count = quads.length;
  const positions = new Float32Array(count * 4 * 3);
  const corners = new Float32Array(count * 4 * 2);
  const anchors = new Float32Array(count * 4);
  const tint = new Float32Array(count * 4 * 3);
  const cards = new Float32Array(count * 4 * 4);
  const indices = new Uint16Array(count * 6);
  const cornerX = [-1, 1, 1, -1];
  const cornerY = [0, 0, 1, 1];
  quads.forEach((quad, i) => {
    const color = tints[quad.team] ?? new Color(1, 1, 1);
    for (let c = 0; c < 4; c++) {
      const v = i * 4 + c;
      corners[v * 2] = cornerX[c] ?? 0;
      corners[v * 2 + 1] = cornerY[c] ?? 0;
      anchors[v] = quad.anchor;
      tint[v * 3] = color.r;
      tint[v * 3 + 1] = color.g;
      tint[v * 3 + 2] = color.b;
      cards.set(quad.card, v * 4);
    }
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  });
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  geometry.setAttribute('aAnchor', new BufferAttribute(anchors, 1));
  geometry.setAttribute('aTint', new BufferAttribute(tint, 3));
  geometry.setAttribute('aCard', new BufferAttribute(cards, 4));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

const TEAM_IDS: readonly TeamId[] = [TEAM_EMBER, TEAM_FROST];

/** The halo and flame quads, ordered so that a prefix is a preset: the halos, then tongue by tongue. */
function cardQuads(): QuadSpec[] {
  const quads: QuadSpec[] = [];
  for (const team of TEAM_IDS) {
    quads.push({ anchor: ANCHOR_SHARD + team, team, card: [1, 0, HALO_RADIUS_M, 0] });
  }
  for (let flame = 0; flame < MAX_FLAMES; flame++) {
    for (const team of TEAM_IDS) {
      // The first tongue is the tall one in the middle (seed 0), the rest stand round it.
      const seed = flame === 0 ? 0 : (flame * 0.211 + team * 0.37 + 0.13) % 1;
      const height = flame === 0 ? 13 : 7.5 + 2.5 * ((flame * 0.61) % 1);
      const halfWidth = flame === 0 ? 4.2 : 2.9;
      quads.push({ anchor: ANCHOR_BRAZIER + team, team, card: [0, seed, halfWidth, height] });
    }
  }
  return quads;
}

/** Load-time: builds the four meshes. `preset` picks what is drawn (see the file comment). */
export function createEmberRelayView(preset: QualityPreset): EmberRelayView {
  const anchors: Vector4[] = [];
  for (let i = 0; i < ANCHOR_COUNT; i++) anchors.push(new Vector4(0, 0, 0, 0));
  const uAnchor = { value: anchors };
  const uTime = { value: 0 };
  const shardMatrices = [new Matrix4(), new Matrix4()];
  const uBeacon = {
    value: new Vector4(BEACON_HEIGHT_M[preset.id], BEACON_HALF_WIDTH_M, 0, BEACON_STRENGTH),
  };
  // What the post pass shows as each team's colour: light, not paint.
  const tints = TEAM_IDS.map((team) => setPaintedColor(new Color(), TEAMS[team].color));

  const stoneData = buildRelayStone();
  const stoneGeometry = litGeometry(stoneData);
  const stoneMaterial = useWorldLight(
    new ShaderMaterial({
      name: 'RelayStone',
      vertexShader: STONE_VERTEX,
      fragmentShader: STONE_FRAGMENT,
      uniforms: { uAnchor, uTime },
      fog: false,
      toneMapped: false,
    }),
  );
  const stone = new Mesh(stoneGeometry, stoneMaterial);
  stone.name = 'RelayStone';

  const shardData = buildRelayShards();
  const shardGeometry = litGeometry(shardData);
  const shardMaterial = useWorldLight(
    new ShaderMaterial({
      name: 'RelayShards',
      vertexShader: SHARD_VERTEX,
      fragmentShader: SHARD_FRAGMENT,
      uniforms: { uShardMatrix: { value: shardMatrices }, uTime },
      fog: false,
      toneMapped: false,
    }),
    { shadows: false },
  );
  const shards = new Mesh(shardGeometry, shardMaterial);
  shards.name = 'RelayShards';

  const beaconQuads: QuadSpec[] = [];
  for (const team of TEAM_IDS) {
    beaconQuads.push({ anchor: ANCHOR_SHARD + team, team, card: [0, 0, 0, 0] });
    beaconQuads.push({ anchor: ANCHOR_BRAZIER + team, team, card: [0, 0, 0, 0] });
  }
  const beaconGeometry = quadGeometry(beaconQuads, tints);
  const beaconMaterial = useWorldLight(
    new ShaderMaterial({
      name: 'RelayBeacons',
      vertexShader: BEACON_VERTEX,
      fragmentShader: BEACON_FRAGMENT,
      uniforms: { uAnchor, uBeacon },
      // Premultiplied (see BEACON_FRAGMENT): light plus a little cover, not light alone.
      blending: NormalBlending,
      premultipliedAlpha: true,
      transparent: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }),
    { shadows: false },
  );
  const beacons = new Mesh(beaconGeometry, beaconMaterial);
  beacons.name = 'RelayBeacons';
  beacons.renderOrder = RELAY_GLOW_RENDER_ORDER;

  const cards = cardQuads();
  const cardGeometry = quadGeometry(cards, tints);
  const cardMaterial = new ShaderMaterial({
    name: 'RelayCards',
    vertexShader: CARD_VERTEX,
    fragmentShader: CARD_FRAGMENT,
    uniforms: { uAnchor, uTime, uLoose: { value: setPaintedColor(new Color(), LOOSE_COLOR) } },
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const cardMesh = new Mesh(cardGeometry, cardMaterial);
  cardMesh.name = 'RelayCards';
  cardMesh.renderOrder = RELAY_GLOW_RENDER_ORDER;

  const object = new Group();
  object.name = 'EmberRelay';
  object.visible = false;
  for (const mesh of [stone, shards, beacons, cardMesh]) {
    // Everything is placed in the vertex shaders: the geometry's own bounds mean nothing.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    object.add(mesh);
  }
  object.matrixAutoUpdate = false;

  let cardQuadCount = 0;
  function setQuality(next: QualityPreset): void {
    uBeacon.value.x = BEACON_HEIGHT_M[next.id];
    const flames = FLAMES_PER_BRAZIER[next.id] * TEAM_IDS.length;
    // Low draws no cards at all. Medium and High: the two halos (which carry the rings that
    // mark a dropped shard), then as many flames as the preset has.
    cardQuadCount = flames > 0 ? HALO_QUADS + flames : 0;
    cardGeometry.setDrawRange(0, cardQuadCount * 6);
    cardMesh.visible = cardQuadCount > 0;
  }
  setQuality(preset);

  // Scratch for the shard poses.
  const turn = new Matrix4();
  const tilt = new Matrix4();
  const scale = new Vector3();
  const place = new Vector3();

  function poseShard(view: WorldView, team: TeamId, timeS: number): void {
    const shard = view.relay.shards[team];
    const matrix = shardMatrices[team];
    const anchor = anchors[ANCHOR_SHARD + team];
    if (shard === undefined || matrix === undefined || anchor === undefined) return;
    // The two shards never move in step.
    const phase = team * 2.1;
    let size = 1;
    let lean = 0;
    let spin = timeS * 0.5 + phase;
    place.set(shard.position.x, shard.position.y, shard.position.z);
    if (shard.status === SHARD_CARRIED) {
      size = CARRY_SCALE;
      lean = 0.35;
      spin = timeS * 2.2 + phase;
      const carrier =
        shard.carrierId !== NO_PLAYER ? findDragonView(view, shard.carrierId) : undefined;
      if (carrier !== undefined) {
        // CARRY_OFFSET turned by the carrier's orientation (v' = v + 2w(q x v) + 2 q x (q x v)).
        const q = carrier.orientation;
        const vx = CARRY_OFFSET.x;
        const vy = CARRY_OFFSET.y;
        const vz = CARRY_OFFSET.z;
        const cx = q.y * vz - q.z * vy;
        const cy = q.z * vx - q.x * vz;
        const cz = q.x * vy - q.y * vx;
        place.set(
          carrier.position.x + vx + 2 * (q.w * cx + q.y * cz - q.z * cy),
          carrier.position.y + vy + 2 * (q.w * cy + q.z * cx - q.x * cz),
          carrier.position.z + vz + 2 * (q.w * cz + q.x * cy - q.y * cx),
        );
      }
    } else if (shard.status === SHARD_DROPPED) {
      // Loose: it lists and turns faster, bobbing where it fell.
      lean = 0.5;
      spin = timeS * 1.4 + phase;
      place.y += Math.sin(timeS * 2.2 + phase) * 0.8;
    } else {
      place.y += Math.sin(timeS * 0.9 + phase) * 0.45;
    }
    turn.makeRotationY(spin);
    tilt.makeRotationZ(lean);
    scale.set(size, size, size);
    matrix.multiplyMatrices(turn, tilt).scale(scale).setPosition(place);
    // The beacon and the halo follow the crystal as drawn; w tells them its state.
    anchor.set(place.x, place.y, place.z, shard.status);
  }

  return {
    object,

    get drawCalls(): number {
      return cardQuadCount > 0 ? 4 : 3;
    },

    get triangles(): number {
      return stoneData.triangles + shardData.triangles + beaconQuads.length * 2 + cardQuadCount * 2;
    },

    update(view: WorldView, timeS: number): void {
      const relay = view.relay;
      object.visible = relay.active;
      if (!relay.active) return;
      for (const team of TEAM_IDS) {
        const stand = relay.stands[team];
        const brazier = relay.braziers[team];
        if (stand !== undefined) anchors[ANCHOR_STAND + team]?.set(stand.x, stand.y, stand.z, 0);
        if (brazier !== undefined) {
          anchors[ANCHOR_BRAZIER + team]?.set(brazier.x, brazier.y, brazier.z, 0);
        }
        poseShard(view, team, timeS);
      }
      // Kept small so the shaders' `fract` and `sin` keep their precision.
      const wrapped = timeS % 6000;
      uTime.value = wrapped;
      uBeacon.value.z = wrapped;
    },

    setQuality,

    dispose(): void {
      stoneGeometry.dispose();
      stoneMaterial.dispose();
      shardGeometry.dispose();
      shardMaterial.dispose();
      beaconGeometry.dispose();
      beaconMaterial.dispose();
      cardGeometry.dispose();
      cardMaterial.dispose();
    },
  };
}
