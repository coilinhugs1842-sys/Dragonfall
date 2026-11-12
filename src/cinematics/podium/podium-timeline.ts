/**
 * The clock of the results show, in seconds of `WorldView.clock.phaseTimeS` (the `results`
 * phase lasts MODE_TUNING.resultsS = 12 s). Everything the podium does is a function of that
 * clock, so every browser shows the same moment:
 *
 *    0.0 - 4.0   the winning team's formation pass, seen from the wide camera
 *    4.6 - 5.1   each dragon of the pass has gone over the camera: its pass ends (`cut`)
 *                (in a draw both teams fly, the second V 0.9 s behind the first)
 *    4.1 - 5.6   the camera moves to the three-quarter view of the podium
 *    3.8 - 7.9   everyone else takes a place in the two hover arcs: the other team first,
 *                climbing up behind the rock, then the winners from above
 *    4.85 - 7.6  most damage (down at 7.45) and most takedowns (7.6) dive in and land
 *    4.6 - 6.7   the MVP dives in and stops in the air over the middle step
 *    6.1 - 8.25  the MVP roars, hanging over its step
 *    8.25 - 9.5  the MVP lands
 *    9.5 - 12.0  hold: three on the steps, the hoverers bob, the camera drifts
 *
 * The roar is in the air and before the landing for two reasons: the roar pose hangs the tail
 * well below the feet, and the animator plays `land` from its start whenever it is asked for
 * it again, so a roar on the stone would be followed by a second landing.
 */

/** Seconds the leader of the pass takes from one end of the pass curve to the other. */
export const PASS_S = 5.6;
/**
 * How far along the curve (0..1) a dragon is when its pass ends. By then it has gone over the
 * wide shot's camera and is behind it, so its next appearance (diving in from above) needs no
 * visible turn. tests/cinematics/podium.test.ts checks that it really is out of frame.
 */
export const PASS_CUT_U = 0.82;

/** When each award winner starts its dive: [MVP, most takedowns, most damage]. */
export const SEAT_START_S: readonly number[] = [4.6, 5.0, 4.85];
/** Seconds from the start of the dive to the feet on the stone (the two side steps). */
export const SEAT_APPROACH_S = 2.6;
/** Seconds from the start of the MVP's dive to its stop in the air over the middle step. */
export const MVP_APPROACH_S = 2.1;
/**
 * The `land` clip puts the feet down this long after it starts (it is 1.6 s long: a flare with
 * braking beats, the touchdown, a small bounce), so the clip is started this long before the
 * dragon reaches its step.
 */
export const LAND_LEAD_S = 1.25;
/** The MVP's roar starts this long before it stops over its step: it rears up as it brakes. */
export const ROAR_LEAD_S = 0.6;
/** A little under the `roar` clip's 2.2 s, so the roar hands over to `land` before it runs out. */
export const ROAR_S = 2.15;

/** When the first dragon of each hover arc leaves for its place: [winners' arc, outer arc]. */
export const HOVER_START_S: readonly number[] = [4.7, 3.8];
/** The next one of the same arc leaves this much later. */
export const HOVER_STAGGER_S = 0.18;
export const HOVER_APPROACH_S = 2.6;

/** The camera's move from the wide shot to the podium. */
export const CAMERA_MOVE_START_S = 4.1;
export const CAMERA_MOVE_END_S = 5.6;
/** With reduced motion the same change is one cut. */
export const CAMERA_CUT_S = 4.4;
/** Length of the show the camera drift is laid out for. */
export const SHOW_S = 12;
