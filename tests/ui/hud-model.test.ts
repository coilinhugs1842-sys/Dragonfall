import { describe, expect, it } from 'vitest';
import {
  BUTTON_PRIMARY,
  BUTTON_SECONDARY,
  NO_PLAYER,
  TEAM_EMBER,
  TEAM_FROST,
} from '../../src/shared';
import type { HudDamageArc, ScoreboardRow, TeamId } from '../../src/shared';
import { ABILITY_GLYPHS, ENVIRONMENT_GLYPHS, takedownGlyph } from '../../src/ui/hud/glyphs';
import {
  BANNER_COUNTDOWN,
  BANNER_DEFEAT,
  BANNER_DRAW,
  BANNER_EMBER_WINS,
  BANNER_FROST_WINS,
  BANNER_NONE,
  BANNER_ROUND_DRAW,
  BANNER_ROUND_LOST,
  BANNER_ROUND_WON,
  BANNER_TITLES,
  BANNER_VICTORY,
  BLIND_FADE_S,
  COMPASS_HALF_SPAN_RAD,
  COMPASS_LABEL_GAP,
  COMPASS_LABEL_GAP_BACK,
  COMPASS_LANE_FIRST,
  COMPASS_LANE_NONE,
  COMPASS_LANE_SECOND,
  COMPASS_STEPS,
  DAMAGE_ARC_LIFE_S,
  DEGREE_STRINGS,
  INT_STRINGS,
  KILLFEED_FADE_S,
  KILLFEED_LIFE_S,
  LOW_HEALTH_THRESHOLD,
  OPACITY_STEPS,
  OPACITY_STRINGS,
  PERCENT_STRINGS,
  RAPID_COOLDOWN_S,
  SLOT_ACTIVE,
  SLOT_CHARGING,
  SLOT_COOLING,
  SLOT_LOCKED,
  SLOT_READY,
  SLOT_STATE_NAMES,
  SWEEP_STEPS,
  TWO_DIGITS,
  UNIT_STEPS,
  UNIT_STRINGS,
  angleDegrees,
  bannerFor,
  blindLevel,
  clockMinutesString,
  clockSecondsString,
  clockTotalSeconds,
  compassLabelLanes,
  compassLabelRank,
  compassOffset,
  compassPinned,
  compassStep,
  cooldownSecondsShown,
  cooldownSweepStep,
  countdownSeconds,
  damageArcLive,
  damageArcOpacityStep,
  damageArcSlot,
  damageShown,
  deniedPress,
  distanceShown,
  findRow,
  formatClock,
  healthPoints,
  intString,
  killfeedOpacityStep,
  liveCount,
  lowHealthLevel,
  quantize,
  quantizeVisible,
  roundPipCount,
  scoreProgressStep,
  screenAngle,
  shownCooldown,
  slotState,
  sortTeamRows,
  teamKey,
  ultimatePercent,
  wrapAngle,
} from '../../src/ui/hud/hud-model';

function row(
  playerId: number,
  team: TeamId,
  takedowns: number,
  deaths = 0,
  assists = 0,
  damage = 0,
): ScoreboardRow {
  return {
    playerId,
    name: `P${playerId}`,
    team,
    classId: 'talon',
    takedowns,
    deaths,
    assists,
    damage,
    pingMs: 20,
    alive: true,
  };
}

describe('string tables and steps', () => {
  it('has one ready-made string per step', () => {
    expect(UNIT_STRINGS).toHaveLength(UNIT_STEPS + 1);
    expect(UNIT_STRINGS[0]).toBe('0');
    expect(UNIT_STRINGS[UNIT_STEPS]).toBe('1');
    expect(UNIT_STRINGS[UNIT_STEPS / 2]).toBe('0.5');
    expect(OPACITY_STRINGS).toHaveLength(OPACITY_STEPS + 1);
    expect(PERCENT_STRINGS[SWEEP_STEPS]).toBe('100%');
    expect(PERCENT_STRINGS[37]).toBe('37%');
    expect(TWO_DIGITS[7]).toBe('07');
    expect(TWO_DIGITS[59]).toBe('59');
    expect(DEGREE_STRINGS).toHaveLength(360);
    expect(DEGREE_STRINGS[270]).toBe('270deg');
    for (const value of UNIT_STRINGS) expect(Number(value)).toBeGreaterThanOrEqual(0);
  });

  it('quantizes 0..1 and survives junk', () => {
    expect(quantize(0, 100)).toBe(0);
    expect(quantize(1, 100)).toBe(100);
    expect(quantize(0.504, 100)).toBe(50);
    expect(quantize(-3, 100)).toBe(0);
    expect(quantize(7, 100)).toBe(100);
    expect(quantize(Number.NaN, 100)).toBe(0);
  });

  it('never rounds a sliver to empty or an almost-full value to full', () => {
    expect(quantizeVisible(0.0001, 200)).toBe(1);
    expect(quantizeVisible(0.9999, 200)).toBe(199);
    expect(quantizeVisible(0, 200)).toBe(0);
    expect(quantizeVisible(1, 200)).toBe(200);
    expect(quantizeVisible(0.5, 200)).toBe(100);
  });

  it('returns the same string object for the same number (no formatting per call)', () => {
    expect(intString(42)).toBe('42');
    expect(intString(42)).toBe(INT_STRINGS[42]);
    expect(intString(-5)).toBe('0');
    expect(intString(Number.NaN)).toBe('0');
    expect(intString(999)).toBe('999');
    expect(intString(2852)).toBe('2852');
    expect(intString(12.6)).toBe('13');
  });
});

describe('clock', () => {
  it('rounds up so the last second reads 00:01', () => {
    expect(formatClock(420)).toBe('07:00');
    expect(formatClock(419.2)).toBe('07:00');
    expect(formatClock(61)).toBe('01:01');
    expect(formatClock(0.4)).toBe('00:01');
    expect(formatClock(0)).toBe('00:00');
    expect(formatClock(-3)).toBe('00:00');
  });

  it('has no digits without a time limit and caps at 99:59', () => {
    expect(clockTotalSeconds(Infinity)).toBe(-1);
    expect(clockTotalSeconds(Number.NaN)).toBe(-1);
    expect(formatClock(Infinity)).toBe('--:--');
    expect(formatClock(1e9)).toBe('99:59');
  });

  it('only needs a DOM write when the whole second changes, and then reuses table strings', () => {
    // The same displayed second across a 60 fps second of frames.
    const first = clockTotalSeconds(125.99);
    for (let frame = 1; frame < 59; frame++) {
      expect(clockTotalSeconds(125.99 - frame / 60)).toBe(first);
    }
    expect(clockMinutesString(first)).toBe(TWO_DIGITS[2]);
    expect(clockSecondsString(first)).toBe(TWO_DIGITS[6]);
    expect(clockMinutesString(-1)).toBe('00');
  });

  it('counts a respawn down in whole seconds', () => {
    expect(countdownSeconds(5)).toBe(5);
    expect(countdownSeconds(4.01)).toBe(5);
    expect(countdownSeconds(0.2)).toBe(1);
    expect(countdownSeconds(0)).toBe(0);
    expect(countdownSeconds(Infinity)).toBe(-1);
    expect(countdownSeconds(500)).toBe(99);
  });
});

describe('ability slots', () => {
  it('maps the cooldown fraction to a sweep step that is never 0 while cooling', () => {
    expect(cooldownSweepStep(0)).toBe(0);
    expect(cooldownSweepStep(1)).toBe(SWEEP_STEPS);
    expect(cooldownSweepStep(0.5)).toBe(50);
    expect(cooldownSweepStep(0.001)).toBe(1);
    expect(cooldownSweepStep(0.999)).toBe(SWEEP_STEPS - 1);
  });

  it('draws a rapid-fire cooldown as ready instead of strobing', () => {
    // 0.2 s fire rate, 0.15 s left: three quarters of the way, but not worth a sweep.
    expect(shownCooldown(0.75, 0.15)).toBe(0);
    // An 8 s cooldown with 0.15 s left is still drawn.
    expect(shownCooldown(0.15 / 8, 0.15)).toBeCloseTo(0.15 / 8);
    expect(shownCooldown(0.5, 4)).toBe(0.5);
    // Exactly at the limit counts as a real cooldown.
    expect(shownCooldown(0.5, RAPID_COOLDOWN_S / 2)).toBe(0.5);
    // Unknown length: drawn as given.
    expect(shownCooldown(0.5, undefined)).toBe(0.5);
    expect(shownCooldown(0.5, 0)).toBe(0.5);
    expect(shownCooldown(0, 3)).toBe(0);
    expect(shownCooldown(4, 30)).toBe(1);
    expect(shownCooldown(Number.NaN, 1)).toBe(0);
  });

  it('prints whole seconds, and nothing for sub-second cooldowns', () => {
    expect(cooldownSecondsShown(7.2)).toBe(8);
    expect(cooldownSecondsShown(1)).toBe(1);
    expect(cooldownSecondsShown(0.9)).toBe(0);
    expect(cooldownSecondsShown(0.15)).toBe(0);
    expect(cooldownSecondsShown(0)).toBe(0);
    expect(cooldownSecondsShown(300)).toBe(99);
  });

  it('picks the slot state', () => {
    expect(SLOT_STATE_NAMES[SLOT_LOCKED]).toBe('locked');
    // Plain cooldown.
    expect(slotState(false, 0, 0, 1, true, false, false)).toBe(SLOT_READY);
    expect(slotState(false, 0.4, 0, 0, false, false, false)).toBe(SLOT_COOLING);
    // Winding up beats active beats the rest.
    expect(slotState(false, 0.4, 0, 0, false, true, true)).toBe(SLOT_CHARGING);
    expect(slotState(false, 0.4, 0, 0, false, true, false)).toBe(SLOT_ACTIVE);
    // A charge in store: ready although the next one is loading.
    expect(slotState(false, 0.6, 0, 1, undefined, false, false)).toBe(SLOT_READY);
    // Without the `ready` array: ready exactly when the cooldown is over.
    expect(slotState(false, 0, 0, 0, undefined, false, false)).toBe(SLOT_READY);
    expect(slotState(false, 0.2, 0, 0, undefined, false, false)).toBe(SLOT_COOLING);
    // Not ready for another reason (no stamina, mid-cast elsewhere): shown as unavailable.
    expect(slotState(false, 0, 0, 0, false, false, false)).toBe(SLOT_COOLING);
  });

  it('locks the ultimate until it is charged', () => {
    expect(slotState(true, 0, 0.99, 1, false, false, false)).toBe(SLOT_LOCKED);
    expect(slotState(true, 0, 1, 1, true, false, false)).toBe(SLOT_READY);
    expect(slotState(true, 0, 0.3, 1, false, true, false)).toBe(SLOT_ACTIVE);
    expect(ultimatePercent(0)).toBe(0);
    expect(ultimatePercent(0.999)).toBe(99);
    expect(ultimatePercent(1)).toBe(100);
    expect(ultimatePercent(0.375)).toBe(37);
    expect(ultimatePercent(Number.NaN)).toBe(0);
  });

  it('flashes "not ready" on the press edge only', () => {
    expect(deniedPress(BUTTON_SECONDARY, 0, BUTTON_SECONDARY, SLOT_COOLING)).toBe(true);
    expect(deniedPress(BUTTON_SECONDARY, 0, BUTTON_SECONDARY, SLOT_LOCKED)).toBe(true);
    // Still held: no second flash.
    expect(deniedPress(BUTTON_SECONDARY, BUTTON_SECONDARY, BUTTON_SECONDARY, SLOT_COOLING)).toBe(
      false,
    );
    expect(deniedPress(BUTTON_SECONDARY, 0, BUTTON_SECONDARY, SLOT_READY)).toBe(false);
    expect(deniedPress(BUTTON_SECONDARY, 0, BUTTON_SECONDARY, SLOT_ACTIVE)).toBe(false);
    // Another button went down.
    expect(deniedPress(BUTTON_PRIMARY, 0, BUTTON_SECONDARY, SLOT_COOLING)).toBe(false);
  });
});

describe('vitals', () => {
  it('prints HP rounded up, 0 only when down', () => {
    expect(healthPoints(1, 100)).toBe(100);
    expect(healthPoints(0.004, 100)).toBe(1);
    expect(healthPoints(0, 100)).toBe(0);
    expect(healthPoints(0.5, 180)).toBe(90);
    // A u8-quantised fraction of a whole HP value does not gain a point from float noise.
    expect(healthPoints(86 / 100, 100)).toBe(86);
    expect(healthPoints(1, 0)).toBe(0);
  });

  it('raises the low-health level below the threshold only', () => {
    expect(lowHealthLevel(1, true)).toBe(0);
    expect(lowHealthLevel(LOW_HEALTH_THRESHOLD, true)).toBe(0);
    expect(lowHealthLevel(LOW_HEALTH_THRESHOLD / 2, true)).toBeCloseTo(0.5);
    expect(lowHealthLevel(0, true)).toBe(1);
    expect(lowHealthLevel(0, false)).toBe(0);
    expect(lowHealthLevel(Number.NaN, true)).toBe(0);
  });

  it('holds the blind veil closed and lifts it at the end', () => {
    expect(blindLevel(0)).toBe(0);
    expect(blindLevel(3)).toBe(1);
    expect(blindLevel(BLIND_FADE_S / 2)).toBeCloseTo(0.5);
    expect(blindLevel(-1)).toBe(0);
  });
});

describe('angles', () => {
  it('wraps into (-PI, PI]', () => {
    expect(wrapAngle(0)).toBe(0);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(3 * Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1);
    expect(wrapAngle(-7 * Math.PI + 0.25)).toBeCloseTo(-Math.PI + 0.25);
    expect(wrapAngle(Number.NaN)).toBe(0);
    expect(wrapAngle(Infinity)).toBe(0);
  });

  it('turns a world offset into a screen angle (yaw 0 = +Z, +X is to the left)', () => {
    // Camera looking along +Z.
    expect(screenAngle(0, 10, 0)).toBeCloseTo(0);
    expect(screenAngle(0, -10, 0)).toBeCloseTo(Math.PI);
    // +X is on the left of a viewer looking along +Z with Y up: a negative (left) screen angle.
    expect(screenAngle(10, 0, 0)).toBeCloseTo(-Math.PI / 2);
    expect(screenAngle(-10, 0, 0)).toBeCloseTo(Math.PI / 2);
    // Camera turned to look along +X (yaw PI/2): +Z is now on the right.
    expect(screenAngle(10, 0, Math.PI / 2)).toBeCloseTo(0);
    expect(screenAngle(0, 10, Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(screenAngle(0, 0, 1)).toBe(0);
  });

  it('gives whole degrees 0..359', () => {
    expect(angleDegrees(0)).toBe(0);
    expect(angleDegrees(Math.PI / 2)).toBe(90);
    expect(angleDegrees(-Math.PI / 2)).toBe(270);
    expect(angleDegrees(Math.PI)).toBe(180);
    expect(angleDegrees(-0.001)).toBe(0);
    expect(angleDegrees(2 * Math.PI - 0.001)).toBe(0);
    for (let a = -10; a < 10; a += 0.37) {
      const degrees = angleDegrees(a);
      expect(degrees).toBeGreaterThanOrEqual(0);
      expect(degrees).toBeLessThan(360);
      expect(DEGREE_STRINGS[degrees]).toBeDefined();
    }
  });
});

describe('damage arcs', () => {
  const arc = (angle: number, ageS: number, strength = 1): HudDamageArc => ({
    angle,
    ageS,
    strength,
  });
  const dead = (): HudDamageArc => arc(0, Infinity, 0);

  it('fades from full to gone over its life', () => {
    expect(damageArcOpacityStep(0, 1)).toBe(OPACITY_STEPS);
    expect(damageArcOpacityStep(DAMAGE_ARC_LIFE_S / 4, 1)).toBe(OPACITY_STEPS);
    const late = damageArcOpacityStep(DAMAGE_ARC_LIFE_S * 0.9, 1);
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(OPACITY_STEPS / 2);
    expect(damageArcOpacityStep(DAMAGE_ARC_LIFE_S, 1)).toBe(0);
    expect(damageArcOpacityStep(Infinity, 1)).toBe(0);
    expect(damageArcOpacityStep(Number.NaN, 1)).toBe(0);
    // Never increases with age.
    let previous = OPACITY_STEPS;
    for (let age = 0; age < DAMAGE_ARC_LIFE_S; age += 0.01) {
      const step = damageArcOpacityStep(age, 0.6);
      expect(step).toBeLessThanOrEqual(previous);
      previous = step;
    }
  });

  it('draws a light hit fainter than a heavy one', () => {
    expect(damageArcOpacityStep(0, 0.1)).toBeLessThan(damageArcOpacityStep(0, 1));
    expect(damageArcOpacityStep(0, 0)).toBeGreaterThan(0);
  });

  it('uses a free entry first', () => {
    expect(damageArcSlot([dead(), dead(), dead(), dead()], 1)).toBe(0);
    expect(damageArcSlot([arc(0, 0.1), dead(), dead(), dead()], 2)).toBe(1);
  });

  it('refreshes the live arc pointing the same way', () => {
    const arcs = [arc(-1.5, 0.3), arc(1.5, 0.2), dead(), dead()];
    expect(damageArcSlot(arcs, 1.6)).toBe(1);
    expect(damageArcSlot(arcs, -1.45)).toBe(0);
    // Across the +-PI seam.
    expect(damageArcSlot([arc(Math.PI - 0.05, 0.2), dead()], -Math.PI + 0.05)).toBe(0);
    // An expired arc pointing the same way does not count as live.
    expect(damageArcLive(arc(1.5, DAMAGE_ARC_LIFE_S + 1))).toBe(false);
    expect(damageArcSlot([arc(2, 0.1), arc(1.5, DAMAGE_ARC_LIFE_S + 1)], 1.5)).toBe(1);
  });

  it('replaces the oldest when every entry is live and none is near', () => {
    const arcs = [arc(0, 0.2), arc(1.5, 0.9), arc(3, 0.5), arc(-1.5, 0.1)];
    expect(damageArcSlot(arcs, 0.8)).toBe(1);
  });
});

describe('compass', () => {
  it('projects the angle linearly across the strip', () => {
    expect(compassOffset(0)).toBe(0);
    expect(compassOffset(COMPASS_HALF_SPAN_RAD / 2)).toBeCloseTo(0.5);
    expect(compassOffset(-COMPASS_HALF_SPAN_RAD / 2)).toBeCloseTo(-0.5);
    expect(compassOffset(COMPASS_HALF_SPAN_RAD)).toBeCloseTo(1);
  });

  it('pins what is behind to the end of its side', () => {
    expect(compassOffset(Math.PI - 0.01)).toBe(1);
    expect(compassOffset(-Math.PI + 0.01)).toBe(-1);
    expect(compassPinned(Math.PI - 0.01)).toBe(true);
    expect(compassPinned(0.3)).toBe(false);
    // An unwrapped angle is wrapped first: 2 PI + a little is just right of centre.
    expect(compassOffset(2 * Math.PI + 0.1)).toBeCloseTo(0.1 / COMPASS_HALF_SPAN_RAD);
    expect(compassOffset(1, 0)).toBe(0);
  });

  it('turns it into a table step', () => {
    expect(compassStep(0)).toBe(COMPASS_STEPS / 2);
    expect(compassStep(Math.PI)).toBe(COMPASS_STEPS);
    expect(compassStep(-3)).toBe(0);
    expect(UNIT_STRINGS[compassStep(0.4)]).toBeDefined();
  });

  describe('distance figures of markers that are close together', () => {
    const lanesFor = (
      steps: number[],
      ranks: number[],
      figures: number[],
      before: number[] = [],
    ): number[] => {
      const lanes = new Uint8Array(8);
      lanes.set(before);
      compassLabelLanes(lanes, steps, ranks, figures, steps.length);
      return Array.from(lanes.subarray(0, steps.length));
    };

    it('leaves markers with room between them on the first line', () => {
      expect(lanesFor([20, 100, 180], [1, 2, 3], [280, 300, 90])).toEqual([0, 0, 0]);
      expect(lanesFor([100, 100 + COMPASS_LABEL_GAP], [1, 2], [280, 300])).toEqual([0, 0]);
      expect(lanesFor([], [], [])).toEqual([]);
    });

    it('staggers the second of two close markers onto the second line', () => {
      // "280 m" and "300 m" two steps apart: the nearer one keeps its place.
      expect(lanesFor([100, 102], [280, 300], [280, 300])).toEqual([
        COMPASS_LANE_FIRST,
        COMPASS_LANE_SECOND,
      ]);
      // Whatever order they arrive in, the rank decides.
      expect(lanesFor([102, 100], [300, 280], [300, 280])).toEqual([
        COMPASS_LANE_SECOND,
        COMPASS_LANE_FIRST,
      ]);
    });

    it('shares one figure between close markers that show the same number', () => {
      expect(lanesFor([100, 103], [1, 2], [280, 280])).toEqual([COMPASS_LANE_FIRST, COMPASS_LANE_NONE]);
    });

    it('prints nothing for a third marker in a crowd, and never overlaps on a line', () => {
      const steps = [100, 102, 104, 110, 150];
      const lanes = lanesFor(steps, [1, 2, 3, 4, 5], [100, 120, 140, 160, 180]);
      expect(lanes).toEqual([
        COMPASS_LANE_FIRST,
        COMPASS_LANE_SECOND,
        COMPASS_LANE_NONE,
        COMPASS_LANE_NONE,
        COMPASS_LANE_FIRST,
      ]);
      // A stack of team mates behind you (all pinned to the same end): two figures, not five.
      const stack = lanesFor([0, 0, 0, 0, 0], [5, 4, 3, 2, 1], [50, 60, 70, 80, 90]);
      expect(stack.filter((lane) => lane !== COMPASS_LANE_NONE)).toHaveLength(2);
      for (const result of [lanes, stack]) {
        const used = result === lanes ? steps : [0, 0, 0, 0, 0];
        for (let a = 0; a < used.length; a++) {
          for (let b = a + 1; b < used.length; b++) {
            if (result[a] === COMPASS_LANE_NONE || result[a] !== result[b]) continue;
            expect(Math.abs((used[a] ?? 0) - (used[b] ?? 0))).toBeGreaterThanOrEqual(COMPASS_LABEL_GAP);
          }
        }
      }
    });

    it('needs a little more room to come back to the first line than to stay on it', () => {
      const apart = [100, 100 + COMPASS_LABEL_GAP + 1];
      expect(lanesFor(apart, [1, 2], [280, 300])).toEqual([0, 0]);
      // It was staggered a moment ago: one step past the gap is not enough yet.
      expect(lanesFor(apart, [1, 2], [280, 300], [0, COMPASS_LANE_SECOND])).toEqual([
        COMPASS_LANE_FIRST,
        COMPASS_LANE_SECOND,
      ]);
      expect(
        lanesFor([100, 100 + COMPASS_LABEL_GAP_BACK], [1, 2], [280, 300], [0, COMPASS_LANE_SECOND]),
      ).toEqual([0, 0]);
    });

    it('resets the lanes of markers that are gone', () => {
      const lanes = new Uint8Array([2, 1, 2, 1, 0, 0, 0, 0]);
      compassLabelLanes(lanes, [100], [1], [50], 1);
      expect(Array.from(lanes)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    });

    it('gives shards their figure first, then the brazier, then riders; what is ahead before what is behind', () => {
      const shard = compassLabelRank('shard', false, 600);
      const brazier = compassLabelRank('brazier', false, 300);
      const objective = compassLabelRank('objective', false, 200);
      const mate = compassLabelRank('ally', false, 40);
      const nearer = compassLabelRank('ally', false, 20);
      const behind = compassLabelRank('shard', true, 10);
      expect(shard).toBeLessThan(brazier);
      expect(brazier).toBeLessThan(objective);
      expect(objective).toBeLessThan(mate);
      expect(nearer).toBeLessThan(mate);
      expect(mate).toBeLessThan(behind);
      expect(compassLabelRank('ally', false, Number.NaN)).toBe(compassLabelRank('ally', false, 0));
    });
  });

  it('rounds distances so they do not flicker', () => {
    expect(distanceShown(42.4)).toBe(40);
    expect(distanceShown(43)).toBe(45);
    expect(distanceShown(237)).toBe(240);
    expect(distanceShown(5000)).toBe(990);
    expect(distanceShown(-2)).toBe(0);
    expect(distanceShown(Number.NaN)).toBe(0);
  });
});

describe('killfeed', () => {
  it('stays solid, fades over the last second, then is gone', () => {
    expect(killfeedOpacityStep(0)).toBe(OPACITY_STEPS);
    expect(killfeedOpacityStep(KILLFEED_LIFE_S - KILLFEED_FADE_S)).toBe(OPACITY_STEPS);
    const fading = killfeedOpacityStep(KILLFEED_LIFE_S - KILLFEED_FADE_S / 2);
    expect(fading).toBeGreaterThan(0);
    expect(fading).toBeLessThan(OPACITY_STEPS);
    expect(killfeedOpacityStep(KILLFEED_LIFE_S)).toBe(0);
    expect(killfeedOpacityStep(Infinity)).toBe(0);
  });

  it('picks a glyph for the takedown', () => {
    expect(takedownGlyph('storm', null)).toBe(ENVIRONMENT_GLYPHS.storm);
    expect(takedownGlyph('terrain', 'talon')).toBe(ENVIRONMENT_GLYPHS.terrain);
    expect(takedownGlyph('ultimate', 'wraith')).toBe(ABILITY_GLYPHS.wraith.ultimate);
    expect(takedownGlyph(undefined, 'wraith')).toBe(takedownGlyph('primary', null));
  });

  it('has a distinct glyph for every class ability', () => {
    const seen = new Set<string>();
    for (const classGlyphs of Object.values(ABILITY_GLYPHS)) {
      for (const d of Object.values(classGlyphs)) {
        expect(d.startsWith('M')).toBe(true);
        seen.add(d);
      }
    }
    expect(seen.size).toBe(Object.keys(ABILITY_GLYPHS).length * 4);
  });
});

describe('scoreboard', () => {
  it('sorts a team by takedowns, then deaths, assists, damage, id', () => {
    const rows = [
      row(0, TEAM_EMBER, 2, 1),
      row(1, TEAM_FROST, 9),
      row(2, TEAM_EMBER, 5, 4),
      row(3, TEAM_EMBER, 5, 2),
      row(4, TEAM_EMBER, 2, 1, 3),
      row(5, TEAM_FROST, 1),
      row(6, TEAM_EMBER, 2, 1, 3, 500),
    ];
    const out = [0, 0, 0, 0, 0];
    expect(sortTeamRows(rows, rows.length, TEAM_EMBER, out)).toBe(5);
    expect(out.map((index) => rows[index]?.playerId)).toEqual([3, 2, 6, 4, 0]);
    expect(sortTeamRows(rows, rows.length, TEAM_FROST, out)).toBe(2);
    expect(out.slice(0, 2).map((index) => rows[index]?.playerId)).toEqual([1, 5]);
  });

  it('is stable for equal rows and honours the live count', () => {
    const rows = [row(4, TEAM_EMBER, 1), row(2, TEAM_EMBER, 1), row(9, TEAM_EMBER, 7)];
    const out = [0, 0, 0, 0, 0];
    expect(sortTeamRows(rows, 2, TEAM_EMBER, out)).toBe(2);
    expect(out.slice(0, 2).map((index) => rows[index]?.playerId)).toEqual([2, 4]);
    expect(sortTeamRows(rows, 0, TEAM_EMBER, out)).toBe(0);
    expect(sortTeamRows([], 5, TEAM_EMBER, out)).toBe(0);
  });

  it('keeps the best rows when a team has more riders than the pool', () => {
    const rows = [1, 6, 3, 8, 2, 7, 4].map((takedowns, id) => row(id, TEAM_FROST, takedowns));
    const out = [0, 0, 0];
    expect(sortTeamRows(rows, rows.length, TEAM_FROST, out)).toBe(3);
    expect(out.map((index) => rows[index]?.takedowns)).toEqual([8, 7, 6]);
  });

  it('works for 1 to 5 riders a side', () => {
    for (let size = 1; size <= 5; size++) {
      const rows: ScoreboardRow[] = [];
      for (let i = 0; i < size * 2; i++) {
        rows.push(row(i, i % 2 === 0 ? TEAM_EMBER : TEAM_FROST, (i * 3) % 5));
      }
      const out = [0, 0, 0, 0, 0];
      for (const team of [TEAM_EMBER, TEAM_FROST] as const) {
        const written = sortTeamRows(rows, rows.length, team, out);
        expect(written).toBe(size);
        for (let i = 1; i < written; i++) {
          const above = rows[out[i - 1] ?? -1];
          const below = rows[out[i] ?? -1];
          expect(above?.team).toBe(team);
          expect(above?.takedowns ?? 0).toBeGreaterThanOrEqual(below?.takedowns ?? 0);
        }
      }
    }
  });

  it('finds a rider and counts live entries', () => {
    const rows = [row(3, TEAM_EMBER, 0), row(7, TEAM_FROST, 0)];
    expect(findRow(rows, 2, 7)).toBe(1);
    expect(findRow(rows, 1, 7)).toBe(-1);
    expect(findRow(rows, 2, NO_PLAYER)).toBe(-1);
    expect(liveCount(5, undefined)).toBe(5);
    expect(liveCount(5, 3)).toBe(3);
    expect(liveCount(5, 9)).toBe(5);
    expect(liveCount(5, -1)).toBe(0);
    expect(damageShown(1234.4)).toBe(1234);
    expect(damageShown(-1)).toBe(0);
  });
});

describe('score header and banners', () => {
  it('shows round pips only in Duel', () => {
    expect(roundPipCount('duel', 3)).toBe(3);
    expect(roundPipCount('duel', 9)).toBe(5);
    expect(roundPipCount('duel', 0)).toBe(0);
    expect(roundPipCount('skirmish', 30)).toBe(0);
    expect(scoreProgressStep(15, 30)).toBe(UNIT_STEPS / 2);
    expect(scoreProgressStep(40, 30)).toBe(UNIT_STEPS);
    expect(scoreProgressStep(4, 0)).toBe(0);
  });

  it('picks the banner for a phase', () => {
    expect(bannerFor('playing', 0, null, TEAM_EMBER)).toBe(BANNER_NONE);
    expect(bannerFor('countdown', 3, null, TEAM_EMBER)).toBe(BANNER_COUNTDOWN);
    expect(bannerFor('countdown', 0, null, TEAM_EMBER)).toBe(BANNER_NONE);
    expect(bannerFor('roundEnd', 0, TEAM_EMBER, TEAM_EMBER)).toBe(BANNER_ROUND_WON);
    expect(bannerFor('roundEnd', 0, TEAM_FROST, TEAM_EMBER)).toBe(BANNER_ROUND_LOST);
    expect(bannerFor('roundEnd', 0, 'draw', TEAM_EMBER)).toBe(BANNER_ROUND_DRAW);
    expect(bannerFor('results', 0, TEAM_FROST, TEAM_FROST)).toBe(BANNER_VICTORY);
    expect(bannerFor('results', 0, TEAM_EMBER, TEAM_FROST)).toBe(BANNER_DEFEAT);
    expect(bannerFor('results', 0, 'draw', TEAM_FROST)).toBe(BANNER_DRAW);
    // No winner known yet: nothing, rather than a guess.
    expect(bannerFor('results', 0, null, TEAM_FROST)).toBe(BANNER_NONE);
    expect(bannerFor('roundEnd', 0, undefined, TEAM_FROST)).toBe(BANNER_NONE);
  });

  it('names the winner for a spectator instead of "victory" or "defeat"', () => {
    expect(bannerFor('results', 0, TEAM_EMBER, null)).toBe(BANNER_EMBER_WINS);
    expect(bannerFor('roundEnd', 0, TEAM_FROST, null)).toBe(BANNER_FROST_WINS);
    expect(bannerFor('results', 0, 'draw', null)).toBe(BANNER_DRAW);
    expect(BANNER_TITLES[BANNER_VICTORY]).toBe('Victory');
    expect(BANNER_TITLES[BANNER_FROST_WINS]).toBe('Frost Order');
    expect(BANNER_TITLES).toHaveLength(10);
  });

  it('keys teams for CSS', () => {
    expect(teamKey(TEAM_EMBER)).toBe('ember');
    expect(teamKey(TEAM_FROST)).toBe('frost');
    expect(teamKey(null)).toBe('none');
  });
});
