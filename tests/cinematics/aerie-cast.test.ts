/**
 * The aerie's cast: who lands, who is simply there, the ready roar, class and seat changes,
 * leaving, and the launch (in order, and everyone gone inside MATCH_TUNING.lobbyLaunchS).
 */
import { describe, expect, it } from 'vitest';
import {
  ARRIVE_FLIGHT_S,
  CAST_ARRIVING,
  CAST_FREE,
  CAST_HOPPING,
  CAST_LAUNCHING,
  CAST_LEAVING,
  CAST_PERCHED,
  CAST_POOL_SIZE,
  HOP_S,
  LAND_TOUCH_S,
  LAUNCH_FLIGHT_S,
  LEAVE_S,
  PERCH_SEAT_HEIGHT,
  ROAR_S,
  createAerieCast,
  createAerieLayout,
  launchStepS,
  perchSlot,
} from '../../src/cinematics/aerie';
import type { AerieCast } from '../../src/cinematics/aerie';
import {
  DEFAULT_HOST_SETTINGS,
  DRAGON_ANIM_BOOST,
  DRAGON_ANIM_FLAP,
  DRAGON_ANIM_GLIDE,
  DRAGON_ANIM_LAND,
  DRAGON_ANIM_ROAR,
  DRAGON_ANIM_TAKEOFF,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  MATCH_TUNING,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
  createShatteredSpires,
  findDragonView,
} from '../../src/shared';
import type { DragonClassId, LobbyPhase, LobbyPlayer, LobbySide, LobbyState, PlayerId } from '../../src/shared';

const layout = createAerieLayout(createShatteredSpires());
const DT = 1 / 60;

interface Seat {
  id: PlayerId;
  side: LobbySide;
  perch: number;
  classId?: DragonClassId;
  ready?: boolean;
}

function player(seat: Seat): LobbyPlayer {
  return {
    id: seat.id,
    name: `Rider ${seat.id}`,
    side: seat.side,
    perch: seat.perch,
    classId: seat.classId ?? 'talon',
    ready: seat.ready ?? false,
    isHost: seat.id === 0,
    connected: true,
    reconnectDeadlineTick: -1,
    isBot: false,
  };
}

function lobbyOf(seats: readonly Seat[], phase: LobbyPhase = 'lobby'): LobbyState {
  return {
    roomCode: 'TESTS',
    phase,
    hostId: 0,
    players: seats.map(player),
    settings: DEFAULT_HOST_SETTINGS,
  };
}

/** Ten riders: ids 0..4 Ember, 5..9 Frost, perch = id % 5, the four classes in turn. */
function fullRoom(ready = false): Seat[] {
  const seats: Seat[] = [];
  for (let id = 0; id < 10; id++) {
    seats.push({
      id,
      side: id < 5 ? TEAM_EMBER : TEAM_FROST,
      perch: id % 5,
      classId: DRAGON_CLASS_IDS[id % DRAGON_CLASS_IDS.length] ?? 'talon',
      ready,
    });
  }
  return seats;
}

function run(cast: AerieCast, lobby: LobbyState, seconds: number, local: PlayerId = NO_PLAYER): void {
  const frames = Math.round(seconds / DT);
  for (let i = 0; i < frames; i++) cast.update(lobby, local, DT);
}

function stateOf(cast: AerieCast, id: PlayerId): number {
  return cast.seated(id)?.state ?? CAST_FREE;
}

describe('aerie cast: first look', () => {
  it('shows a populated lobby perched at once', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf(fullRoom()), NO_PLAYER, DT);
    expect(cast.view.dragonCount).toBe(10);
    for (let id = 0; id < 10; id++) {
      expect(stateOf(cast, id)).toBe(CAST_PERCHED);
      const dragon = findDragonView(cast.view, id);
      const perch = layout.perches[perchSlot(id < 5 ? TEAM_EMBER : TEAM_FROST, id % 5)];
      if (dragon === undefined || perch === undefined) throw new Error('missing dragon');
      expect(dragon.anim).toBe(DRAGON_ANIM_LAND);
      expect(dragon.flags).toBe(DRAGON_FLAG_ALIVE);
      expect(dragon.team).toBe(id < 5 ? TEAM_EMBER : TEAM_FROST);
      expect(dragon.position.x).toBeCloseTo(perch.position.x, 6);
      expect(dragon.position.z).toBeCloseTo(perch.position.z, 6);
      expect(dragon.position.y).toBeCloseTo(perch.position.y + PERCH_SEAT_HEIGHT[dragon.classId], 6);
      expect(dragon.health).toBe(1);
    }
    expect(cast.launchProgress).toBe(0);
  });

  it('lands our own dragon on the first look, while the others are already there', () => {
    const cast = createAerieCast(layout);
    const lobby = lobbyOf(fullRoom());
    cast.update(lobby, 3, DT);
    expect(stateOf(cast, 3)).toBe(CAST_ARRIVING);
    expect(findDragonView(cast.view, 3)?.anim).toBe(DRAGON_ANIM_GLIDE);
    expect(cast.view.localDragonId).toBe(3);
    for (let id = 0; id < 10; id++) if (id !== 3) expect(stateOf(cast, id)).toBe(CAST_PERCHED);
    run(cast, lobby, ARRIVE_FLIGHT_S + LAND_TOUCH_S + 0.1, 3);
    expect(stateOf(cast, 3)).toBe(CAST_PERCHED);
  });

  it('leaves spectators and unseated riders out', () => {
    const cast = createAerieCast(layout);
    cast.update(
      lobbyOf([
        { id: 0, side: TEAM_EMBER, perch: 0 },
        { id: 1, side: 'spectator', perch: -1 },
        { id: 2, side: TEAM_FROST, perch: -1 },
      ]),
      1,
      DT,
    );
    expect(cast.view.dragonCount).toBe(1);
    expect(cast.view.localDragonId).toBe(NO_PLAYER);
    expect(cast.seated(1)).toBeNull();
  });

  it('shows everyone perched again when the room comes back from a match', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom();
    cast.update(lobbyOf(seats), 0, DT);
    run(cast, lobbyOf(seats, 'starting'), MATCH_TUNING.lobbyLaunchS, 0);
    cast.update(lobbyOf(seats, 'inMatch'), 0, DT);
    expect(cast.view.dragonCount).toBe(0);
    expect(cast.launchProgress).toBe(1);
    cast.update(lobbyOf(seats), 0, DT);
    expect(cast.launchProgress).toBe(0);
    expect(cast.view.dragonCount).toBe(10);
    for (let id = 0; id < 10; id++) expect(stateOf(cast, id)).toBe(CAST_PERCHED);
  });

  it('lands our dragon again after a reset (left the room, joined another)', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf(fullRoom()), 0, DT);
    run(cast, lobbyOf(fullRoom()), 4, 0);
    cast.reset();
    expect(cast.view.dragonCount).toBe(0);
    cast.update(lobbyOf(fullRoom()), 0, DT);
    expect(stateOf(cast, 0)).toBe(CAST_ARRIVING);
    expect(stateOf(cast, 1)).toBe(CAST_PERCHED);
  });
});

describe('aerie cast: joining and leaving', () => {
  it('flies a newcomer in: glide, flap, land, then perched', () => {
    const cast = createAerieCast(layout);
    const one: Seat[] = [{ id: 0, side: TEAM_EMBER, perch: 0 }];
    cast.update(lobbyOf(one), NO_PLAYER, DT);
    const two: Seat[] = [...one, { id: 7, side: TEAM_FROST, perch: 2, classId: 'bastion' }];
    const lobby = lobbyOf(two);
    cast.update(lobby, NO_PLAYER, DT);
    expect(stateOf(cast, 7)).toBe(CAST_ARRIVING);
    const perch = layout.perches[perchSlot(TEAM_FROST, 2)];
    if (perch === undefined) throw new Error('missing perch');
    const start = findDragonView(cast.view, 7);
    if (start === undefined) throw new Error('missing dragon');
    // It starts well away from the perch, above it.
    expect(Math.hypot(start.position.x - perch.position.x, start.position.z - perch.position.z)).toBeGreaterThan(50);
    expect(start.position.y).toBeGreaterThan(perch.position.y + 20);

    const seen: number[] = [];
    let last = -1;
    const frames = Math.round((ARRIVE_FLIGHT_S + LAND_TOUCH_S + 0.2) / DT);
    for (let i = 0; i < frames; i++) {
      cast.update(lobby, NO_PLAYER, DT);
      const anim = findDragonView(cast.view, 7)?.anim ?? -1;
      if (anim !== last) {
        seen.push(anim);
        last = anim;
      }
    }
    expect(seen).toEqual([DRAGON_ANIM_GLIDE, DRAGON_ANIM_FLAP, DRAGON_ANIM_LAND]);
    expect(stateOf(cast, 7)).toBe(CAST_PERCHED);
    const end = findDragonView(cast.view, 7);
    expect(end?.position.x).toBeCloseTo(perch.position.x, 6);
    expect(end?.position.y).toBeCloseTo(perch.position.y + PERCH_SEAT_HEIGHT.bastion, 6);
    // The first rider never moved.
    expect(stateOf(cast, 0)).toBe(CAST_PERCHED);
  });

  it('moves smoothly: no frame of an arrival jumps', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf([]), NO_PLAYER, DT);
    const lobby = lobbyOf([{ id: 2, side: TEAM_EMBER, perch: 4 }]);
    cast.update(lobby, NO_PLAYER, DT);
    let before = { ...(findDragonView(cast.view, 2)?.position ?? { x: 0, y: 0, z: 0 }) };
    const frames = Math.round((ARRIVE_FLIGHT_S + LAND_TOUCH_S) / DT);
    for (let i = 0; i < frames; i++) {
      cast.update(lobby, NO_PLAYER, DT);
      const now = findDragonView(cast.view, 2)?.position;
      if (now === undefined) throw new Error('missing dragon');
      // Under 150 m/s on every frame.
      expect(Math.hypot(now.x - before.x, now.y - before.y, now.z - before.z)).toBeLessThan(150 * DT);
      before = { ...now };
    }
  });

  it('takes a leaver off and removes it', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom();
    cast.update(lobbyOf(seats), NO_PLAYER, DT);
    const without = lobbyOf(seats.filter((seat) => seat.id !== 4));
    cast.update(without, NO_PLAYER, DT);
    // No perch any more (no name card), but still in the picture.
    expect(cast.seated(4)).toBeNull();
    expect(cast.members.find((m) => m.playerId === 4)?.state).toBe(CAST_LEAVING);
    expect(findDragonView(cast.view, 4)?.anim).toBe(DRAGON_ANIM_TAKEOFF);
    expect(cast.view.dragonCount).toBe(10);
    run(cast, without, 0.8);
    expect(findDragonView(cast.view, 4)?.anim).toBe(DRAGON_ANIM_FLAP);
    const perch = layout.perches[perchSlot(TEAM_EMBER, 4)];
    expect(findDragonView(cast.view, 4)?.position.y).toBeGreaterThan((perch?.position.y ?? 0) + 3);
    run(cast, without, LEAVE_S);
    expect(findDragonView(cast.view, 4)).toBeUndefined();
    expect(cast.view.dragonCount).toBe(9);
  });

  it('never shows one rider twice, even when it comes straight back', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom();
    cast.update(lobbyOf(seats), NO_PLAYER, DT);
    const without = lobbyOf(seats.filter((seat) => seat.id !== 4));
    run(cast, without, 0.5);
    run(cast, lobbyOf(seats), 0.1);
    expect(cast.view.dragonCount).toBe(10);
    expect(stateOf(cast, 4)).toBe(CAST_ARRIVING);
    run(cast, lobbyOf(seats), 3);
    expect(stateOf(cast, 4)).toBe(CAST_PERCHED);
  });

  it('flies a rider who changes seat or side to the new perch', () => {
    const cast = createAerieCast(layout);
    const before: Seat[] = [{ id: 0, side: TEAM_EMBER, perch: 0 }];
    cast.update(lobbyOf(before), NO_PLAYER, DT);
    const after = lobbyOf([{ id: 0, side: TEAM_FROST, perch: 3 }]);
    cast.update(after, NO_PLAYER, DT);
    expect(stateOf(cast, 0)).toBe(CAST_ARRIVING);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_TAKEOFF);
    expect(findDragonView(cast.view, 0)?.team).toBe(TEAM_FROST);
    run(cast, after, 3);
    expect(stateOf(cast, 0)).toBe(CAST_PERCHED);
    const perch = layout.perches[perchSlot(TEAM_FROST, 3)];
    expect(findDragonView(cast.view, 0)?.position.x).toBeCloseTo(perch?.position.x ?? 0, 6);
    expect(cast.view.dragonCount).toBe(1);
  });
});

describe('aerie cast: ready and class', () => {
  it('roars once when the rider readies up, lights the perch, then rests', () => {
    const cast = createAerieCast(layout);
    const idle: Seat[] = [{ id: 0, side: TEAM_FROST, perch: 1 }];
    cast.update(lobbyOf(idle), NO_PLAYER, DT);
    const slot = perchSlot(TEAM_FROST, 1);
    expect(cast.perchGlow[slot]).toBe(0);
    const ready = lobbyOf([{ id: 0, side: TEAM_FROST, perch: 1, ready: true }]);
    cast.update(ready, NO_PLAYER, DT);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_ROAR);
    run(cast, ready, ROAR_S - 0.2);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_ROAR);
    expect(cast.perchGlow[slot]).toBeGreaterThan(0.95);
    run(cast, ready, 0.4);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_LAND);
    // Still ready: it does not roar again.
    run(cast, ready, 5);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_LAND);
    expect(cast.perchGlow[slot]).toBeGreaterThan(0.99);
    // Only its own perch is lit.
    for (let other = 0; other < cast.perchGlow.length; other++) {
      if (other !== slot) expect(cast.perchGlow[other]).toBe(0);
    }
    // Un-ready: the glow goes out, no roar.
    run(cast, lobbyOf(idle), 2);
    expect(cast.perchGlow[slot]).toBeLessThan(0.01);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_LAND);
  });

  it('shows a rider who was ready before we looked with the glow already on, without a roar', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf(fullRoom(true)), NO_PLAYER, DT);
    cast.update(lobbyOf(fullRoom(true)), NO_PLAYER, DT);
    expect(findDragonView(cast.view, 6)?.anim).toBe(DRAGON_ANIM_LAND);
    run(cast, lobbyOf(fullRoom(true)), 1);
    for (let slot = 0; slot < 10; slot++) expect(cast.perchGlow[slot]).toBeGreaterThan(0.95);
  });

  it('roars after landing when the rider readied up in the air', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf([]), NO_PLAYER, DT);
    const lobby = lobbyOf([{ id: 0, side: TEAM_EMBER, perch: 2, ready: true }]);
    cast.update(lobby, NO_PLAYER, DT);
    expect(stateOf(cast, 0)).toBe(CAST_ARRIVING);
    // In the air: the perch is not lit yet.
    run(cast, lobby, 1);
    expect(cast.perchGlow[perchSlot(TEAM_EMBER, 2)]).toBe(0);
    run(cast, lobby, ARRIVE_FLIGHT_S + LAND_TOUCH_S - 1 + 0.1);
    expect(findDragonView(cast.view, 0)?.anim).toBe(DRAGON_ANIM_ROAR);
  });

  it('swaps the class in place with a small hop', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf([{ id: 0, side: TEAM_EMBER, perch: 0, classId: 'talon' }]), NO_PLAYER, DT);
    const next = lobbyOf([{ id: 0, side: TEAM_EMBER, perch: 0, classId: 'wraith' }]);
    cast.update(next, NO_PLAYER, DT);
    expect(stateOf(cast, 0)).toBe(CAST_HOPPING);
    expect(findDragonView(cast.view, 0)?.classId).toBe('wraith');
    const perch = layout.perches[perchSlot(TEAM_EMBER, 0)];
    if (perch === undefined) throw new Error('missing perch');
    let highest = 0;
    const frames = Math.round((HOP_S + 0.1) / DT);
    for (let i = 0; i < frames; i++) {
      cast.update(next, NO_PLAYER, DT);
      const dragon = findDragonView(cast.view, 0);
      if (dragon === undefined) throw new Error('missing dragon');
      highest = Math.max(highest, dragon.position.y - perch.position.y - PERCH_SEAT_HEIGHT.wraith);
      // In place: it never leaves the perch sideways.
      expect(dragon.position.x).toBeCloseTo(perch.position.x, 6);
      expect(dragon.position.z).toBeCloseTo(perch.position.z, 6);
    }
    expect(highest).toBeGreaterThan(0.8);
    expect(highest).toBeLessThan(3);
    expect(stateOf(cast, 0)).toBe(CAST_PERCHED);
    expect(findDragonView(cast.view, 0)?.position.y).toBeCloseTo(perch.position.y + PERCH_SEAT_HEIGHT.wraith, 6);
  });
});

describe('aerie cast: launch', () => {
  it('spaces the take-offs so ten dragons fit inside the launch', () => {
    const launchS = MATCH_TUNING.lobbyLaunchS;
    for (let count = 1; count <= 10; count++) {
      const step = launchStepS(count, launchS);
      expect(step).toBeGreaterThanOrEqual(0);
      expect((count - 1) * step + LAUNCH_FLIGHT_S).toBeLessThan(launchS);
    }
    expect(launchStepS(10, launchS)).toBeGreaterThan(0.08);
  });

  it('takes the dragons off one after another and has them all gone in time', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom(true);
    cast.update(lobbyOf(seats), NO_PLAYER, DT);
    const starting = lobbyOf(seats, 'starting');
    const launchS = MATCH_TUNING.lobbyLaunchS;
    const tookOffAt = new Map<PlayerId, number>();
    const goneAt = new Map<PlayerId, number>();
    let lastProgress = 0;
    const frames = Math.round(launchS / DT);
    for (let i = 1; i <= frames; i++) {
      cast.update(starting, NO_PLAYER, DT);
      const t = i * DT;
      expect(cast.launchProgress).toBeGreaterThanOrEqual(lastProgress);
      expect(cast.launchProgress).toBeCloseTo(Math.min(t / launchS, 1), 5);
      lastProgress = cast.launchProgress;
      for (let id = 0; id < 10; id++) {
        const dragon = findDragonView(cast.view, id);
        if (dragon === undefined) {
          if (!goneAt.has(id)) goneAt.set(id, t);
          continue;
        }
        // Once gone, a dragon does not come back.
        expect(goneAt.has(id)).toBe(false);
        if (dragon.anim === DRAGON_ANIM_TAKEOFF && !tookOffAt.has(id)) tookOffAt.set(id, t);
        if (!tookOffAt.has(id)) expect(dragon.anim).toBe(DRAGON_ANIM_LAND);
        else expect([DRAGON_ANIM_TAKEOFF, DRAGON_ANIM_BOOST]).toContain(dragon.anim);
      }
    }
    expect(tookOffAt.size).toBe(10);
    expect(goneAt.size).toBe(10);
    expect(cast.view.dragonCount).toBe(0);
    expect(cast.launchProgress).toBeCloseTo(1, 5);
    for (const t of goneAt.values()) expect(t).toBeLessThan(launchS);

    // One after another: ten different moments, the seats nearest the middle first, Ember and
    // Frost in turn.
    const order = [...tookOffAt.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 1; i < order.length; i++) {
      expect((order[i]?.[1] ?? 0) - (order[i - 1]?.[1] ?? 0)).toBeGreaterThan(0.05);
    }
    // ids 0..4 are Ember perches 0..4, ids 5..9 Frost perches 0..4.
    expect(order.map(([id]) => id)).toEqual([0, 5, 1, 6, 2, 7, 3, 8, 4, 9]);
    // A dragon that waits its turn still sits on its perch; one that left climbs away.
    expect(order[0]?.[1]).toBeLessThan(0.1);
  });

  it('climbs away from the terrace during the launch', () => {
    const cast = createAerieCast(layout);
    const seats: Seat[] = [{ id: 0, side: TEAM_EMBER, perch: 0 }];
    cast.update(lobbyOf(seats), NO_PLAYER, DT);
    const starting = lobbyOf(seats, 'starting');
    const perch = layout.perches[perchSlot(TEAM_EMBER, 0)];
    if (perch === undefined) throw new Error('missing perch');
    run(cast, starting, LAUNCH_FLIGHT_S - 0.1);
    const dragon = findDragonView(cast.view, 0);
    if (dragon === undefined) throw new Error('missing dragon');
    expect(cast.seated(0)?.state).toBe(CAST_LAUNCHING);
    expect(dragon.position.y).toBeGreaterThan(perch.position.y + 15);
    expect(Math.hypot(dragon.position.x - perch.position.x, dragon.position.z - perch.position.z)).toBeGreaterThan(30);
    expect(dragon.velocity.y).toBeGreaterThan(5);
    run(cast, starting, 0.2);
    expect(cast.view.dragonCount).toBe(0);
  });

  it('launches a dragon that was still landing from its perch', () => {
    const cast = createAerieCast(layout);
    cast.update(lobbyOf([]), NO_PLAYER, DT);
    const seats: Seat[] = [{ id: 0, side: TEAM_EMBER, perch: 1 }];
    run(cast, lobbyOf(seats), 0.5);
    expect(stateOf(cast, 0)).toBe(CAST_ARRIVING);
    cast.update(lobbyOf(seats, 'starting'), NO_PLAYER, DT);
    expect(stateOf(cast, 0)).toBe(CAST_LAUNCHING);
    run(cast, lobbyOf(seats, 'starting'), MATCH_TUNING.lobbyLaunchS);
    expect(cast.view.dragonCount).toBe(0);
  });

  it('keeps the roster frozen while starting: nobody new flies in', () => {
    const cast = createAerieCast(layout);
    const seats: Seat[] = [{ id: 0, side: TEAM_EMBER, perch: 0 }];
    cast.update(lobbyOf(seats), NO_PLAYER, DT);
    cast.update(lobbyOf(seats, 'starting'), NO_PLAYER, DT);
    cast.update(lobbyOf([...seats, { id: 1, side: TEAM_FROST, perch: 0 }], 'starting'), NO_PLAYER, DT);
    expect(cast.view.dragonCount).toBe(1);
  });
});

describe('aerie cast: pools', () => {
  it('does not grow anything after the first full lobby', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom();
    cast.update(lobbyOf(seats), 0, DT);
    // Everyone leaves and comes back at once: the worst case for the pool (ten ghosts flying
    // away while ten newcomers fly in).
    run(cast, lobbyOf([]), 0.2);
    run(cast, lobbyOf(seats), 0.2);
    const membersBefore = cast.members.length;
    const poolBefore = cast.view.dragons.length;
    const itemsBefore = cast.view.dragons.slice();
    expect(membersBefore).toBe(CAST_POOL_SIZE);
    for (let round = 0; round < 3; round++) {
      run(cast, lobbyOf([]), 0.3);
      run(cast, lobbyOf(seats), 0.3);
      run(cast, lobbyOf(seats.map((seat) => ({ ...seat, ready: true }))), 0.5);
      run(cast, lobbyOf(seats, 'starting'), MATCH_TUNING.lobbyLaunchS);
      run(cast, lobbyOf(seats, 'inMatch'), 0.1);
      run(cast, lobbyOf(seats), 0.5);
    }
    expect(cast.members.length).toBe(membersBefore);
    expect(cast.view.dragons.length).toBe(poolBefore);
    // The same objects, not replacements.
    for (let i = 0; i < itemsBefore.length; i++) {
      expect(cast.view.dragons[i]).toBe(itemsBefore[i]);
    }
    expect(cast.view.dragonCount).toBeLessThanOrEqual(CAST_POOL_SIZE);
  });

  it('never has two dragons with one id in the view', () => {
    const cast = createAerieCast(layout);
    const seats = fullRoom();
    const lobbies = [lobbyOf(seats), lobbyOf([]), lobbyOf(seats.slice(0, 5)), lobbyOf(seats)];
    for (let step = 0; step < 40; step++) {
      run(cast, lobbies[step % lobbies.length] as LobbyState, 0.13);
      const ids = new Set<number>();
      for (let i = 0; i < cast.view.dragonCount; i++) {
        const id = cast.view.dragons[i]?.id ?? -1;
        expect(ids.has(id)).toBe(false);
        ids.add(id);
      }
    }
  });
});
