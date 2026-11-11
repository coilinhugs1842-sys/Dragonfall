import { describe, expect, it } from 'vitest';
import { AGE_BUCKET_S, MAX_VOICES, NO_VOICE, VoiceAllocator } from '../../src/audio';

/** request(sound, priority, distance, now, maxInstances, minRetriggerS) */
function fill(allocator: VoiceAllocator, count: number, priority: number, startS = 0): void {
  for (let i = 0; i < count; i++) {
    // A distinct sound per voice so instance caps and retrigger gaps stay out of the way.
    expect(allocator.request(i, priority, 10, startS, 8, 0)).toBe(i);
  }
}

describe('VoiceAllocator', () => {
  it('hands out free voices in order, up to the capacity', () => {
    const allocator = new VoiceAllocator(64, 16);
    fill(allocator, 16, 1);
    expect(allocator.activeVoices).toBe(16);
    expect(allocator.stolen).toBe(0);
  });

  it('clamps the capacity to 1..MAX_VOICES', () => {
    expect(new VoiceAllocator(4, 0).capacity).toBe(1);
    expect(new VoiceAllocator(4, 999).capacity).toBe(MAX_VOICES);
    expect(new VoiceAllocator(4).capacity).toBe(MAX_VOICES);
  });

  it('never exceeds the capacity however much is asked', () => {
    const allocator = new VoiceAllocator(200, 24);
    for (let i = 0; i < 200; i++) {
      allocator.request(i, i % 3, i, i * 0.01, 8, 0);
      expect(allocator.activeVoices).toBeLessThanOrEqual(24);
    }
    expect(allocator.activeVoices).toBe(24);
    for (let v = 24; v < MAX_VOICES; v++) expect(allocator.active[v]).toBe(0);
  });

  it('steals the lowest priority first', () => {
    const allocator = new VoiceAllocator(64, 4);
    allocator.request(0, 2, 10, 0, 8, 0);
    allocator.request(1, 0, 10, 1, 8, 0);
    allocator.request(2, 3, 10, 2, 8, 0);
    allocator.request(3, 1, 10, 3, 8, 0);
    const voice = allocator.request(4, 1, 10, 4, 8, 0);
    expect(voice).toBe(1);
    expect(allocator.wasStolen).toBe(true);
    expect(allocator.stolen).toBe(1);
    expect(allocator.sound[1]).toBe(4);
    expect(allocator.instancesOf(1)).toBe(0);
  });

  it('refuses a sound whose priority is below everything playing', () => {
    const allocator = new VoiceAllocator(64, 4);
    fill(allocator, 4, 2);
    expect(allocator.request(10, 1, 0, 5, 8, 0)).toBe(NO_VOICE);
    expect(allocator.refused).toBe(1);
    expect(allocator.stolen).toBe(0);
    // Equal priority may steal.
    expect(allocator.request(11, 2, 0, 5, 8, 0)).not.toBe(NO_VOICE);
  });

  it('at equal priority steals the oldest', () => {
    const allocator = new VoiceAllocator(64, 4);
    allocator.request(0, 1, 10, 3, 8, 0);
    allocator.request(1, 1, 500, 1, 8, 0);
    allocator.request(2, 1, 10, 0, 8, 0);
    allocator.request(3, 1, 10, 2, 8, 0);
    // Voice 2 is the oldest although voice 1 is much further away: age beats distance.
    expect(allocator.request(4, 1, 10, 4, 8, 0)).toBe(2);
  });

  it('at equal priority and about the same age steals the furthest', () => {
    const allocator = new VoiceAllocator(64, 4);
    const base = 10 * AGE_BUCKET_S;
    allocator.request(0, 1, 50, base + 0.01, 8, 0);
    allocator.request(1, 1, 300, base + 0.05, 8, 0);
    allocator.request(2, 1, 120, base + 0.02, 8, 0);
    allocator.request(3, 1, 20, base + 0.03, 8, 0);
    expect(allocator.request(4, 1, 10, base + 0.1, 8, 0)).toBe(1);
  });

  it('bumps the generation whenever a voice changes hands', () => {
    const allocator = new VoiceAllocator(8, 1);
    const voice = allocator.request(0, 1, 0, 0, 8, 0);
    const first = allocator.generation[voice];
    allocator.request(1, 1, 0, 1, 8, 0);
    expect(allocator.generation[voice]).not.toBe(first);
    const second = allocator.generation[voice];
    allocator.release(voice);
    expect(allocator.generation[voice]).not.toBe(second);
  });

  it('release frees the voice and is safe to repeat', () => {
    const allocator = new VoiceAllocator(8, 4);
    const voice = allocator.request(3, 1, 0, 0, 8, 0);
    allocator.release(voice);
    allocator.release(voice);
    expect(allocator.activeVoices).toBe(0);
    expect(allocator.instancesOf(3)).toBe(0);
    expect(allocator.request(3, 1, 0, 1, 8, 0)).toBe(voice);
  });

  describe('retrigger limiting', () => {
    it('drops a repeat inside the gap and lets one through after it', () => {
      const allocator = new VoiceAllocator(8, 16);
      expect(allocator.request(0, 1, 0, 1, 8, 0.06)).not.toBe(NO_VOICE);
      expect(allocator.request(0, 1, 0, 1.03, 8, 0.06)).toBe(NO_VOICE);
      expect(allocator.request(0, 1, 0, 1.059, 8, 0.06)).toBe(NO_VOICE);
      expect(allocator.request(0, 1, 0, 1.061, 8, 0.06)).not.toBe(NO_VOICE);
      expect(allocator.refused).toBe(2);
      // Another sound is not affected.
      expect(allocator.request(1, 1, 0, 1.061, 8, 0.06)).not.toBe(NO_VOICE);
    });

    it('rapid fire cannot eat the pool: ten shooters at 6 shots/s for 5 s', () => {
      const allocator = new VoiceAllocator(8, 16);
      const bolt = 0;
      const maxInstances = 4;
      let started = 0;
      for (let step = 0; step < 300; step++) {
        const now = step / 60;
        // Bolt sounds last 0.24 s.
        for (let v = 0; v < MAX_VOICES; v++) {
          if (allocator.active[v] === 1 && now - (allocator.startS[v] ?? 0) >= 0.24) {
            allocator.release(v);
          }
        }
        for (let shooter = 0; shooter < 10; shooter++) {
          if ((step + shooter * 3) % 10 !== 0) continue;
          if (allocator.request(bolt, 1, 40 + shooter * 20, now, maxInstances, 0.06) !== NO_VOICE) {
            started++;
          }
        }
        expect(allocator.instancesOf(bolt)).toBeLessThanOrEqual(maxInstances);
        expect(allocator.activeVoices).toBeLessThanOrEqual(maxInstances);
      }
      // 5 s at one per 60 ms at most.
      expect(started).toBeLessThanOrEqual(Math.ceil(5 / 0.06) + 1);
      expect(started).toBeGreaterThan(40);
    });
  });

  describe('instance cap', () => {
    it('replaces its own furthest instance, not another sound', () => {
      const allocator = new VoiceAllocator(8, 16);
      allocator.request(5, 0, 10, 0, 8, 0);
      const near = allocator.request(0, 1, 30, 0, 2, 0);
      const far = allocator.request(0, 1, 200, 0.1, 2, 0);
      const voice = allocator.request(0, 1, 60, 0.2, 2, 0);
      expect(voice).toBe(far);
      expect(allocator.wasStolen).toBe(true);
      expect(allocator.instancesOf(0)).toBe(2);
      expect(allocator.active[near]).toBe(1);
      expect(allocator.instancesOf(5)).toBe(1);
      expect(allocator.activeVoices).toBe(3);
    });

    it('refuses a copy further away than every playing one', () => {
      const allocator = new VoiceAllocator(8, 16);
      allocator.request(0, 1, 30, 0, 2, 0);
      allocator.request(0, 1, 50, 0.1, 2, 0);
      expect(allocator.request(0, 1, 400, 0.2, 2, 0)).toBe(NO_VOICE);
      expect(allocator.instancesOf(0)).toBe(2);
    });

    it('with equal distances (non-positional) replaces the oldest', () => {
      const allocator = new VoiceAllocator(8, 16);
      const first = allocator.request(0, 1, 0, 0, 2, 0);
      allocator.request(0, 1, 0, 0.1, 2, 0);
      expect(allocator.request(0, 1, 0, 0.2, 2, 0)).toBe(first);
    });
  });

  it('reset clears voices and retrigger timers', () => {
    const allocator = new VoiceAllocator(8, 4);
    allocator.request(0, 1, 0, 5, 8, 10);
    allocator.reset();
    expect(allocator.activeVoices).toBe(0);
    expect(allocator.request(0, 1, 0, 5.1, 8, 10)).not.toBe(NO_VOICE);
  });
});
