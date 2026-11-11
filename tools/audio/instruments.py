"""Synthesised orchestral-leaning instruments for the music and the musical stings (T-4.8).

Every instrument is a function (freq_hz, dur_s, vel 0..1, rng) -> stereo array that includes its
own release, so the sequencer only has to place it.
"""

from __future__ import annotations

import numpy as np

from dsp import (SR, TAU, asr, bp, colored, env, hp, lp, pan, partials, peaking, perc, pulse, reson, sat,
                 saw, secs, sine, smooth_noise, tline, white)


def _vibrato(n: int, rng: np.random.Generator, rate: float, depth: float, delay: float) -> np.ndarray:
    t = tline(n)
    onset = np.clip((t - delay) / 0.4, 0, 1)
    drift = smooth_noise(n, rng, 0.7) * 0.0015
    return 1.0 + depth * onset * np.sin(TAU * (rate * t + rng.uniform())) + drift


def strings(freq: float, dur: float, vel: float, rng: np.random.Generator, attack: float = 0.35,
            release: float = 0.7, bright: float = 1.0, voices: int = 6) -> np.ndarray:
    """A string section holding a note: detuned saws spread across the stereo field, slow bow."""
    n = secs(dur + release)
    out = np.zeros((n, 2))
    for v in range(voices):
        cents = rng.uniform(-11, 11)
        f = freq * 2 ** (cents / 1200) * _vibrato(n, rng, rng.uniform(4.8, 5.8), 0.003, 0.25)
        out += pan(saw(f, n, rng.uniform()), (v / max(1, voices - 1)) * 1.4 - 0.7)
    out /= np.sqrt(voices)
    cutoff = min(freq * 6, 700 + 2600 * vel * bright)
    out = lp(out, cutoff, 2)
    out = peaking(out, 300, 1.2, 3.0)
    out = peaking(out, 2600, 1.5, 2.0 * bright)
    e = np.minimum(np.clip(tline(n) / attack, 0, 1) ** 1.5, np.clip((dur + release - tline(n)) / release, 0, 1) ** 2)
    swell = 0.85 + 0.15 * np.sin(np.pi * np.clip(tline(n) / max(dur, 0.01), 0, 1))
    return out * (e * swell)[:, None] * vel * 0.5


def spiccato(freq: float, vel: float, rng: np.random.Generator, length: float = 0.16) -> np.ndarray:
    """A short bounced-bow string note: the driving ostinato sound."""
    n = secs(length + 0.12)
    out = np.zeros((n, 2))
    for v in range(4):
        f = freq * 2 ** (rng.uniform(-9, 9) / 1200)
        out += pan(saw(f, n, rng.uniform()), v / 3 * 1.0 - 0.5)
    out /= 2.0
    e = perc(n, 0.006, length * 0.45)
    bright = lp(out, min(freq * 9, 5200), 2)
    dark = lp(out, min(freq * 3, 1400), 2)
    body = dark + (bright - dark) * (e ** 0.7)[:, None] * (0.4 + 0.6 * vel)
    body = peaking(body, 280, 1.0, 4.0)
    bow = bp(white(n, rng), 1800, 5200) * perc(n, 0.002, 0.012) * 0.25 * vel
    return (body * e[:, None] + pan(bow, 0.0)) * vel * 0.6


def horn(freq: float, dur: float, vel: float, rng: np.random.Generator, players: int = 3,
         release: float = 0.22, attack: float = 0.05) -> np.ndarray:
    """French-horn-like section: saw+pulse whose brightness follows how hard it is blown."""
    n = secs(dur + release + 0.04)
    out = np.zeros((n, 2))
    t = tline(n)
    for p in range(players):
        offset = secs(rng.uniform(0, 0.014)) if p else 0
        scoop = 1.0 - 0.012 * np.exp(-t / 0.03)
        f = freq * 2 ** (rng.uniform(-5, 5) / 1200) * scoop * _vibrato(n, rng, rng.uniform(4.6, 5.4), 0.0025, 0.35)
        raw = saw(f, n, rng.uniform()) * 0.8 + pulse(f, n, 0.38, rng.uniform()) * 0.3
        e = np.minimum(np.clip(t / attack, 0, 1), np.clip((dur + release - t) / release, 0, 1))
        e = e ** 1.3 * (0.88 + 0.12 * np.exp(-t / 0.25))
        dark = lp(raw, min(freq * 2.2, 1200), 2)
        bright = lp(raw, min(freq * 7.0, 4200), 2)
        tone = dark + (bright - dark) * (e ** 2) * (0.15 + 0.75 * vel)
        tone = peaking(tone, 480, 1.4, 5.0)
        tone = peaking(tone, 1250, 2.0, 2.5)
        breath = bp(white(n, rng), 600, 2400) * perc(n, 0.01, 0.05) * 0.06
        voice = (tone + breath) * e
        voice = np.roll(voice, offset)
        voice[:offset] = 0
        out += pan(voice, (p - (players - 1) / 2) * 0.35)
    return sat(out / np.sqrt(players) * vel * 0.9, 1.4) * 0.6


def low_brass(freq: float, dur: float, vel: float, rng: np.random.Generator) -> np.ndarray:
    """Trombone/tuba weight under the horns: brighter rasp when loud."""
    n = secs(dur + 0.3)
    t = tline(n)
    out = np.zeros(n)
    for _ in range(2):
        f = freq * 2 ** (rng.uniform(-4, 4) / 1200) * _vibrato(n, rng, 4.5, 0.001, 0.5)
        out += saw(f, n, rng.uniform())
    e = np.minimum(np.clip(t / 0.04, 0, 1), np.clip((dur + 0.25 - t) / 0.25, 0, 1)) ** 1.2
    dark = lp(out, freq * 3, 2)
    bright = lp(out, min(freq * 12, 3800), 2)
    tone = dark + (bright - dark) * e ** 2 * (0.2 + 0.7 * vel)
    tone = peaking(tone, 520, 1.2, 4.0)
    return pan(sat(tone * e * vel * 0.55, 1.6), 0.15) * 0.75


FORMANTS = {
    "ah": [(730, 90, 1.0), (1090, 110, 0.55), (2440, 160, 0.3), (3400, 200, 0.12)],
    "oo": [(340, 70, 1.0), (780, 100, 0.35), (2400, 160, 0.12), (3300, 200, 0.05)],
    "oh": [(500, 80, 1.0), (880, 100, 0.5), (2500, 160, 0.2), (3300, 200, 0.08)],
}


def formant(x: np.ndarray, vowel: str, shift: float = 1.0) -> np.ndarray:
    out = np.zeros_like(x)
    for fc, bw, gain in FORMANTS[vowel]:
        out += reson(x, fc * shift, fc * shift / bw) * gain
    return out


def choir(freq: float, dur: float, vel: float, rng: np.random.Generator, vowel: str = "ah",
          voices: int = 6, attack: float = 0.45, release: float = 0.9) -> np.ndarray:
    """A wordless choir pad: glottal-ish pulses with each singer's own vibrato, through vowel
    formants, plus breath."""
    n = secs(dur + release)
    t = tline(n)
    out = np.zeros((n, 2))
    shift = 1.0 if freq < 400 else 1.12
    for v in range(voices):
        f = freq * 2 ** (rng.uniform(-14, 14) / 1200) * _vibrato(n, rng, rng.uniform(5.0, 6.2), 0.006, 0.2)
        src = saw(f, n, rng.uniform()) * 0.7 + pulse(f, n, 0.3, rng.uniform()) * 0.5
        src = lp(src, 3800, 1)
        src += white(n, rng) * 0.05
        out += pan(formant(src, vowel, shift), v / max(1, voices - 1) * 1.6 - 0.8)
    out /= np.sqrt(voices)
    e = np.minimum(np.clip(t / attack, 0, 1) ** 1.4, np.clip((dur + release - t) / release, 0, 1) ** 2)
    return out * e[:, None] * vel * 0.9


def harp(freq: float, dur: float, vel: float, rng: np.random.Generator, pan_pos: float | None = None) -> np.ndarray:
    """A plucked string: harmonics that die faster the higher they are."""
    n = secs(min(dur + 1.6, 4.0))
    hs = list(range(1, 13))
    base = 1.9 * (220.0 / freq) ** 0.45
    tone = partials(freq, n, [h * (1 + 0.0004 * h * h) for h in hs], [1.0 / h ** (1.5 - 0.5 * vel) for h in hs],
                    [base / (1 + 0.35 * (h - 1)) for h in hs], rng)
    pluck = bp(white(n, rng), freq * 2, min(freq * 8, 9000)) * perc(n, 0.001, 0.008) * 0.3
    tone = (tone + pluck) * np.clip(tline(n) / 0.002, 0, 1)
    p = pan_pos if pan_pos is not None else float(np.clip((np.log2(freq / 300.0)) * 0.35, -0.7, 0.7))
    return pan(tone, p) * vel * 0.4


def celesta(freq: float, dur: float, vel: float, rng: np.random.Generator) -> np.ndarray:
    """A soft glassy bell for doubling a melody."""
    n = secs(min(dur + 1.8, 4.0))
    tone = partials(freq, n, [1.0, 2.0, 3.01, 4.2, 5.43], [1.0, 0.35, 0.18, 0.1, 0.06],
                    [1.4, 0.8, 0.45, 0.25, 0.15], rng)
    tone *= np.clip(tline(n) / 0.003, 0, 1)
    return pan(tone, rng.uniform(-0.4, 0.4)) * vel * 0.35


def bell(freq: float, dur: float, vel: float, rng: np.random.Generator) -> np.ndarray:
    """A bronze bell: inharmonic partials with a long hum."""
    n = secs(dur)
    ratios = [0.5, 1.0, 1.19, 1.5, 2.0, 2.51, 3.01, 4.1, 5.4]
    amps = [0.25, 1.0, 0.5, 0.35, 0.6, 0.3, 0.25, 0.15, 0.1]
    taus = [dur * 0.5, dur * 0.35, dur * 0.25, dur * 0.2, dur * 0.18, dur * 0.12, dur * 0.1, dur * 0.07, dur * 0.05]
    tone = partials(freq, n, ratios, amps, taus, rng)
    tone *= np.clip(tline(n) / 0.002, 0, 1)
    return pan(tone, 0.0) * vel * 0.4


def taiko(vel: float, rng: np.random.Generator, pitch: float = 62.0, tau: float = 0.32) -> np.ndarray:
    """A big low drum: pitch-dropping skin tone, a body thump and a stick transient."""
    n = secs(tau * 5 + 0.1)
    t = tline(n)
    f = pitch * (1 + 1.3 * np.exp(-t / 0.018) * (0.5 + 0.5 * vel))
    skin = sine(f, n) * np.exp(-t / tau)
    skin += 0.45 * sine(f * 1.59, n) * np.exp(-t / (tau * 0.45))
    skin += 0.25 * sine(f * 2.14, n) * np.exp(-t / (tau * 0.3))
    thump = bp(white(n, rng), 70, 520) * perc(n, 0.002, 0.045) * 0.9
    stick = hp(white(n, rng), 1800) * perc(n, 0.0005, 0.006) * 0.35 * vel
    out = sat((skin + thump) * vel * 1.3, 1.5) + stick
    out *= np.clip(t / 0.001, 0, 1)
    return pan(out, rng.uniform(-0.12, 0.12)) * 0.75


def frame_drum(vel: float, rng: np.random.Generator) -> np.ndarray:
    """A small hand drum tap for quiet pulses."""
    n = secs(0.35)
    t = tline(n)
    tone = sine(170 * (1 + 0.5 * np.exp(-t / 0.01)), n) * np.exp(-t / 0.07)
    slap = bp(white(n, rng), 500, 3000) * perc(n, 0.001, 0.015) * 0.5
    return pan((tone + slap) * vel, rng.uniform(-0.3, 0.3)) * 0.5


def timpani(freq: float, vel: float, rng: np.random.Generator, tau: float = 1.1) -> np.ndarray:
    n = secs(tau * 3.5)
    tone = partials(freq, n, [1.0, 1.5, 1.99, 2.44, 2.89], [1.0, 0.55, 0.3, 0.16, 0.1],
                    [tau, tau * 0.6, tau * 0.4, tau * 0.3, tau * 0.22], rng)
    t = tline(n)
    tone *= 1 + 0.0  # the kettle's pitch is steady; the thump gives the attack
    thump = bp(white(n, rng), 60, 700) * perc(n, 0.002, 0.03) * 0.7
    out = sat((tone + thump) * vel, 1.3) * np.clip(t / 0.0015, 0, 1)
    return pan(out, -0.2) * 0.7


def timpani_roll(freq: float, dur: float, v0: float, v1: float, rng: np.random.Generator) -> np.ndarray:
    n = secs(dur + 2.5)
    out = np.zeros((n, 2))
    t = 0.0
    while t < dur:
        u = t / dur
        hit = timpani(freq, (v0 + (v1 - v0) * u ** 1.5) * rng.uniform(0.85, 1.0), rng, 0.7)
        k = int(t * SR)
        end = min(n, k + len(hit))
        out[k:end] += hit[: end - k]
        t += rng.uniform(0.058, 0.07)
    return out * 0.7


def cymbal_swell(dur: float, vel: float, rng: np.random.Generator, crash: bool = True) -> np.ndarray:
    """A suspended cymbal rolled up to a peak (and let ring)."""
    tail = 2.2 if crash else 0.5
    n = secs(dur + tail)
    t = tline(n)
    metal = np.zeros(n)
    for _ in range(26):
        f = rng.uniform(2200, 11000)
        metal += pulse(f * (1 + 0.002 * smooth_noise(n, rng, 3)), n, 0.5, rng.uniform())
    metal = hp(metal / 26 + colored(n, rng, 0.0) * 0.5, 2500)
    rise = np.clip(t / dur, 0, 1) ** 2.6
    fall = np.exp(-np.maximum(t - dur, 0) / (0.7 if crash else 0.12))
    e = rise * fall
    wide = np.stack([metal, np.roll(metal, 211)], axis=1)
    return wide * e[:, None] * vel * 0.33


def bass(freq: float, dur: float, vel: float, rng: np.random.Generator, short: bool = False) -> np.ndarray:
    """Cellos and basses: a bowed saw with a sine an octave under it."""
    release = 0.12 if short else 0.45
    n = secs(dur + release)
    t = tline(n)
    raw = saw(freq * (1 + 0.001 * smooth_noise(n, rng, 2)), n, rng.uniform()) + saw(freq * 1.004, n, rng.uniform())
    attack = 0.012 if short else 0.12
    e = np.minimum(np.clip(t / attack, 0, 1), np.clip((dur + release - t) / release, 0, 1))
    if short:
        e = e * np.exp(-t / max(dur * 0.8, 0.05))
    tone = lp(raw, min(freq * (5 + 6 * vel), 1800), 2) * 0.5
    tone = peaking(tone, 220, 1.0, 3.0)
    sub = sine(freq * 0.5 if freq > 70 else freq, n) * 0.45
    return pan((tone + sub) * e * vel * 0.8, 0.1)


def sub_boom(vel: float, f0: float = 58.0, f1: float = 30.0, tau: float = 0.9) -> np.ndarray:
    n = secs(tau * 4)
    t = tline(n)
    f = f1 + (f0 - f1) * np.exp(-t / 0.12)
    out = sine(f, n) * np.exp(-t / tau) * np.clip(t / 0.004, 0, 1)
    return pan(sat(out * vel * 1.4, 1.2), 0.0) * 0.8


def env_points(n: int, pts: list[tuple[float, float]]) -> np.ndarray:  # re-export for the sequencer
    return env(n, pts)


__all__ = [
    "strings", "spiccato", "horn", "low_brass", "choir", "harp", "celesta", "bell", "taiko", "frame_drum",
    "timpani", "timpani_roll", "cymbal_swell", "bass", "sub_boom", "formant", "asr",
]
