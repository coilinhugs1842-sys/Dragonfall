/**
 * View-safe terrain queries (camera rig, later VFX ground checks). The map collision world in
 * `src/sim/collision` implements it; a view receives it as this interface from `src/game` and
 * never imports `src/sim` (golden rule 3).
 *
 * Both methods are allocation-free and safe to call every frame.
 */
export interface TerrainQuery {
  /**
   * Distance in metres from the origin to the first terrain surface along the direction, or -1
   * when nothing is hit within `maxDistance`. The direction does not have to be unit length.
   * Both sides of a surface count, so a ray that starts inside rock still reports its way out.
   * A zero or non-finite direction gives -1.
   */
  raycast(
    originX: number,
    originY: number,
    originZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    maxDistance: number,
  ): number;
  /**
   * Distance in metres from the point to the nearest terrain surface, or -1 when there is none
   * within `maxDistance`. For keeping a camera sphere off the rock.
   */
  clearance(x: number, y: number, z: number, maxDistance: number): number;
}
