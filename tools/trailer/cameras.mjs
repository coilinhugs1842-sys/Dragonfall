/**
 * Trailer cameras for a LIVE match. A cine-viewer scene (src/dev/cine/*.ts) cannot film a real
 * fight, because it has no sim; these are placed on the running game instead, through the same
 * seam the bench path uses (`game.setDevCameraDirector`, src/render/camera-director.ts).
 *
 * Each entry is the source of a function that the recorder runs once in the page before the
 * first frame (`record.mjs --setup-file`). The page is a `?record` page, so `window.__dragonfall`
 * is there. The director runs every frame: it keeps its numbers in closed-over variables and
 * allocates nothing. It knows nothing about rock (the terrain query is not reachable from
 * here), so a take can pass through a spire: look at the take before using it.
 */

/**
 * A slow orbit round a fight: the two enemies that are closest to each other. The camera
 * circles the middle between them, further out the further they are apart, and looks at it.
 * When one of the two goes down (or they part) it glides on to the next closest pair, with a
 * preference for one near where it already is.
 * `window.__trailerCam.enemyM` is the distance between the two (Infinity before there is a
 * pair), for a shot's start condition.
 */
const fightOrbit = `(() => {
  const game = window.__dragonfall.game;
  const state = { enemyM: Infinity, pairs: 0 };
  window.__trailerCam = state;
  const ALIVE = 1;
  const RATE = 0.2;          // radians per second
  const FOLLOW = 2.2;        // how fast the middle follows the pair, 1/s
  const NEAR_M = 28;         // orbit radius round two dragons wing to wing
  const LOSE_M = 150;        // further apart than this is not a fight any more
  const STAY_NEAR = 0.4;     // metres of "apart" one metre of travel for the camera is worth
  let angle = 0.6;
  let fx = 0, fy = 0, fz = 0, spread = 40, placed = false;
  let aId = -1, bId = -1;
  const find = (view, id) => {
    for (let i = 0; i < view.dragonCount; i++) {
      const dragon = view.dragons[i];
      if (dragon.id === id) return (dragon.flags & ALIVE) !== 0 ? dragon : null;
    }
    return null;
  };
  const apart = (p, q) => {
    const dx = p.position.x - q.position.x;
    const dy = p.position.y - q.position.y;
    const dz = p.position.z - q.position.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
  game.setDevCameraDirector({
    direct(camera, view, dtS) {
      if (view === null) return false;
      let a = aId >= 0 ? find(view, aId) : null;
      let b = bId >= 0 ? find(view, bId) : null;
      let between = a !== null && b !== null ? apart(a, b) : Infinity;
      if (between > LOSE_M) {
        a = null;
        b = null;
        let best = Infinity;
        for (let i = 0; i < view.dragonCount; i++) {
          const p = view.dragons[i];
          if ((p.flags & ALIVE) === 0) continue;
          for (let j = i + 1; j < view.dragonCount; j++) {
            const q = view.dragons[j];
            if (q.team === p.team || (q.flags & ALIVE) === 0) continue;
            let cost = apart(p, q);
            if (placed) {
              const mx = (p.position.x + q.position.x) * 0.5 - fx;
              const my = (p.position.y + q.position.y) * 0.5 - fy;
              const mz = (p.position.z + q.position.z) * 0.5 - fz;
              cost += STAY_NEAR * Math.sqrt(mx * mx + my * my + mz * mz);
            }
            if (cost < best) {
              best = cost;
              a = p;
              b = q;
            }
          }
        }
        if (a === null || b === null) {
          state.enemyM = Infinity;
          // Nobody to film: the game's own camera keeps the frame.
          return false;
        }
        aId = a.id;
        bId = b.id;
        between = apart(a, b);
        state.pairs++;
      }
      state.enemyM = between;
      const mx = (a.position.x + b.position.x) * 0.5;
      const my = (a.position.y + b.position.y) * 0.5;
      const mz = (a.position.z + b.position.z) * 0.5;
      const k = placed ? 1 - Math.exp(-FOLLOW * dtS) : 1;
      fx += (mx - fx) * k;
      fy += (my - fy) * k;
      fz += (mz - fz) * k;
      spread += (Math.min(between, LOSE_M) - spread) * k;
      placed = true;
      angle += RATE * dtS;
      const radius = NEAR_M + spread * 0.8;
      camera.position.set(
        fx + Math.sin(angle) * radius,
        fy + 7 + spread * 0.12,
        fz + Math.cos(angle) * radius,
      );
      camera.fov = 50;
      camera.lookAt(fx, fy + 1.5, fz);
      return true;
    },
  });
  return 'fightOrbit';
})()`;

export const CAMERAS = { fightOrbit };
