/**
 * `?viewer=cine:orbit`: the smallest scene module, and the template for the others. It loads the
 * match map, puts one hovering dragon of each class above the arena centre and circles them.
 *   &r=<metres>  orbit radius (default 60)
 */
import type { PerspectiveCamera } from 'three';
import {
  DRAGON_ANIM_HOVER,
  DRAGON_CLASS_IDS,
  DRAGON_FLAG_ALIVE,
  TEAM_EMBER,
  TEAM_FROST,
  acquireDragonView,
  beginWorldView,
  createWorldView,
} from '../../shared';
import type { CineFrame, CineHarness } from '../cine-viewer';

const SPACING_M = 18;
const ORBIT_RATE = 0.25;

export function start(harness: CineHarness): void {
  const centre = harness.map.colliders.stormCenter;
  const y = harness.map.colliders.ceilingY - 120;
  const radiusParam = Number(harness.params.get('r') ?? '60');
  const radius = radiusParam > 5 ? radiusParam : 60;

  harness.loadMatch();
  const view = createWorldView();
  view.clock.phase = 'playing';
  const frame: CineFrame = { kind: 'match', view };

  let clock = 0;
  harness.setDirector({
    direct(camera: PerspectiveCamera): boolean {
      const angle = clock * ORBIT_RATE;
      camera.position.set(
        centre.x + Math.sin(angle) * radius,
        y + radius * 0.25,
        centre.z + Math.cos(angle) * radius,
      );
      camera.fov = 50;
      camera.lookAt(centre.x, y, centre.z);
      return true;
    },
  });
  harness.setInfo(`${DRAGON_CLASS_IDS.length} dragons, r=${radius} m`);

  harness.run((_dtS, timeS) => {
    clock = timeS;
    beginWorldView(view);
    for (let i = 0; i < DRAGON_CLASS_IDS.length; i++) {
      const classId = DRAGON_CLASS_IDS[i];
      if (classId === undefined) continue;
      const dragon = acquireDragonView(view);
      dragon.id = i;
      dragon.team = i % 2 === 0 ? TEAM_EMBER : TEAM_FROST;
      dragon.classId = classId;
      dragon.position.x = centre.x + (i - (DRAGON_CLASS_IDS.length - 1) / 2) * SPACING_M;
      dragon.position.y = y;
      dragon.position.z = centre.z;
      dragon.orientation.x = 0;
      dragon.orientation.y = 0;
      dragon.orientation.z = 0;
      dragon.orientation.w = 1;
      dragon.velocity.x = 0;
      dragon.velocity.y = 0;
      dragon.velocity.z = 0;
      dragon.health = 1;
      dragon.stamina = 1;
      dragon.flags = DRAGON_FLAG_ALIVE;
      dragon.anim = DRAGON_ANIM_HOVER;
    }
    return frame;
  });
}
