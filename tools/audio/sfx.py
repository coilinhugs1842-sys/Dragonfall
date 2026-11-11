"""Dragonfall's sound effects, designed in code (T-4.8).

Each function renders one variation: (rng, v) -> mono or stereo float array at dsp.SR. `v` is the
variation number; the rng is seeded from the sound's name and v, so builds are reproducible.
The registry at the bottom says how many variations each sound has, whether it is positional
(mono) and its loop length.
"""

from __future__ import annotations

import numpy as np

import instruments as ins
from dsp import (SR, TAU, asr, bell_env, bp, colored, comb, crackle, env, fade, flange, fm, glide, grains, hp,
                 lp, mono, norm, note_hz, pan, partials, peaking, perc, periodic_lfo, place, pulse, reson,
                 reverb, sat, saw, secs, sine, smooth_noise, stereo, sweep, tline, white, widen, xfade_loop)

Rng = np.random.Generator


def jit(rng: Rng, amount: float) -> float:
    """A factor near 1: the per-variation spread."""
    return float(2.0 ** rng.uniform(-amount, amount))


# --- building blocks -----------------------------------------------------------------------------


def whoosh(rng: Rng, dur: float, f0: float, f1: float, centre: float, width: float, q: float = 1.5,
           skew: float = 1.5, tilt: float = -3.0) -> np.ndarray:
    """Air moving past: tilted noise through a swept resonant band, swelling and dying."""
    n = secs(dur)
    y = sweep(colored(n, rng, tilt), "bp", glide(n, f0, f1), q)
    return y * bell_env(n, centre, width, skew)


def thump(dur: float, f0: float, f1: float, tau: float, drop: float = 0.03) -> np.ndarray:
    """A pitch-dropping sine: the body of a hit."""
    n = secs(dur)
    t = tline(n)
    f = f1 + (f0 - f1) * np.exp(-t / drop)
    return sine(f, n) * np.exp(-t / tau) * np.clip(t / 0.002, 0, 1)


def fire_bed(rng: Rng, n: int, lo: float = 140.0, hi: float = 2400.0, flutter: float = 22.0) -> np.ndarray:
    """A burning roar: band noise that billows, with crackle and hiss on top."""
    roar = bp(colored(n, rng, -4.0), lo, hi)
    billow = 0.55 + 0.45 * smooth_noise(n, rng, flutter)
    slow = 0.75 + 0.25 * smooth_noise(n, rng, 3.0)
    hiss = hp(white(n, rng), 4500) * 0.12 * (0.6 + 0.4 * smooth_noise(n, rng, 9.0))
    crk = crackle(n, rng, 55.0, 900, 5200, 3.0) * 0.5
    return roar * billow * slow * 2.2 + hiss + crk


def zap(rng: Rng, dur: float, buzz_hz: float, f_hi: float = 7000.0, f_lo: float = 900.0) -> np.ndarray:
    """An electric arc: band noise chopped at mains-like rate, with sparks."""
    n = secs(dur)
    body = sweep(white(n, rng), "bp", glide(n, f_hi, f_lo, 2.0), 1.2)
    chop = 0.35 + 0.65 * (pulse(buzz_hz * (1 + 0.04 * smooth_noise(n, rng, 30)), n, 0.3) > 0)
    sparks = crackle(n, rng, 900.0, 2500, 9000, 2.5)
    return (body * chop * 1.6 + sparks * 0.7) * perc(n, 0.001, dur * 0.3)


def growl(rng: Rng, n: int, f0: np.ndarray, rough_hz: float, rough: float, breath: float) -> np.ndarray:
    """The raw throat of a dragon before its formants: a jittery saw with a sub-octave, roughened
    by amplitude flutter, plus breath noise."""
    jitter = 1 + 0.02 * smooth_noise(n, rng, 45.0) + 0.03 * smooth_noise(n, rng, 6.0)
    f = f0 * jitter
    src = saw(f, n, rng.uniform()) + 0.6 * pulse(f * 0.5, n, 0.35, rng.uniform()) + 0.3 * saw(f * 1.006, n, rng.uniform())
    flutter = 1 - rough + rough * (0.5 + 0.5 * np.sign(sine(rough_hz * (1 + 0.15 * smooth_noise(n, rng, 8)), n)) * 0.9)
    src = src * lp(flutter, 400, 1)
    return src + colored(n, rng, -2.0) * breath * 3.0


def vocal_tract(x: np.ndarray, formants: list[tuple[np.ndarray | float, float, float]]) -> np.ndarray:
    """Parallel resonances (centre Hz or curve, Q, gain); curves make the mouth open and close."""
    out = np.zeros(len(x))
    for fc, q, gain in formants:
        if np.ndim(fc):
            out += sweep(x, "bp", np.asarray(fc), q) * gain
        else:
            out += reson(x, float(fc), q) * gain
    return out


def roar(rng: Rng, dur: float, pitch: list[tuple[float, float]], f1: tuple[float, float, float],
         f2: tuple[float, float, float], f3: float, rough_hz: float, rough: float, breath: float,
         drive: float = 3.0) -> np.ndarray:
    """A full roar: growl source through an opening-then-closing mouth, driven hard."""
    n = secs(dur)
    f0 = env(n, pitch)
    mouth = env(n, [(0, 0), (dur * 0.18, 1), (dur * 0.6, 0.85), (dur, 0.15)])
    src = growl(rng, n, f0, rough_hz, rough, breath)
    tract = vocal_tract(src, [
        (f1[0] + (f1[1] - f1[0]) * mouth, 5.0, 1.0),
        (f2[0] + (f2[1] - f2[0]) * mouth, 6.0, f2[2]),
        (f3, 5.0, 0.35),
    ])
    chest = lp(src, f1[0] * 0.6, 2) * f1[2]
    amp = env(n, [(0, 0), (dur * 0.07, 0.8), (dur * 0.22, 1.0), (dur * 0.65, 0.75), (dur, 0)], 1.3)
    y = sat((tract + chest) * amp * drive / max(1e-6, np.std(tract + chest) * 3), 1.0)
    return y


def metal_ring(rng: Rng, dur: float, base: float, count: int = 9, spread: float = 4.2, tau: float = 0.3) -> np.ndarray:
    """Struck metal/crystal: inharmonic partials, the high ones dying first."""
    n = secs(dur)
    ratios = sorted([1.0] + [float(rng.uniform(1.2, spread)) for _ in range(count - 1)])
    amps = [1.0 / (1 + i * 0.5) for i in range(count)]
    taus = [tau / (1 + i * 0.45) for i in range(count)]
    return partials(base, n, ratios, amps, taus, rng) * np.clip(tline(n) / 0.0008, 0, 1)


def room(x: np.ndarray, decay: float, wet: float, seed: int = 5) -> np.ndarray:
    """Mono in, mono out: the open-sky slap and tail that makes a dry layer sit in a place."""
    return mono(reverb(x, decay=decay, wet=wet, seed=seed, lo=200, hi=5000))


def fit(x: np.ndarray, n: int) -> np.ndarray:
    """x cut or zero-padded to n samples."""
    return x[:n] if len(x) >= n else np.pad(x, (0, n - len(x)))


def stack(n: int, *layers: tuple[np.ndarray, float, float]) -> np.ndarray:
    """Sums (signal, start seconds, gain) layers into a mono buffer of n samples."""
    out = np.zeros(n)
    for x, t, g in layers:
        place(out, x, t, g)
    return out


# --- flight --------------------------------------------------------------------------------------


def _flap(rng: Rng, size: float) -> np.ndarray:
    """One wing beat. size 0 = small and quick, 1 = huge and slow."""
    dur = (0.2 + 0.26 * size) * jit(rng, 0.12)
    n = secs(dur + 0.12)
    hi = (620 - 330 * size) * jit(rng, 0.15)
    lo_f = (170 - 105 * size) * jit(rng, 0.15)
    down = sweep(colored(n, rng, -4.5), "bp", glide(n, hi, lo_f, 1.4), 0.9) * bell_env(n, dur * 0.38, dur * 0.42, 1.8)
    press = lp(colored(n, rng, -6.0), 110 - 40 * size) * bell_env(n, dur * 0.45, dur * 0.5, 1.5) * (1.2 + 1.6 * size)
    snap_at = dur * rng.uniform(0.04, 0.1)
    snap = bp(white(n, rng), 900 - 300 * size, 3200 - 1200 * size) * bell_env(n, snap_at, 0.022 + 0.012 * size) * (0.16 - 0.05 * size)
    leather = grains(bp(white(SR, rng), 300, 1500), n, rng, int(10 + 14 * size), (0.008, 0.03), (0.6, 1.4),
                     bell_env(n, dur * 0.3, dur * 0.3)) * 0.1
    tailflick = whoosh(rng, dur + 0.12, lo_f * 2.2, hi * 1.5, dur * 0.85, dur * 0.25, 1.2) * 0.18
    return down * 2.6 + press + snap + leather + tailflick[:n]


def flapSmall(rng: Rng, v: int) -> np.ndarray:
    return _flap(rng, 0.05)


def flap(rng: Rng, v: int) -> np.ndarray:
    return _flap(rng, 0.5)


def flapLarge(rng: Rng, v: int) -> np.ndarray:
    return _flap(rng, 1.0)


def _stereo_noise_loop(rng: Rng, dur: float, make) -> np.ndarray:
    """Renders `make(rng, n_total, n_loop)` once per channel and closes the loop by cross-fade."""
    n_loop = secs(dur)
    n = n_loop + secs(0.5)
    return np.stack([xfade_loop(make(rng, n, n_loop), n_loop) for _ in range(2)], axis=1)


def _tile(curve: np.ndarray, n: int) -> np.ndarray:
    """A loop-periodic control curve extended over the cross-fade overhang."""
    return np.concatenate([curve, curve[: n - len(curve)]])


def windLoop(rng: Rng, v: int) -> np.ndarray:
    """The rider's own airstream: two wandering bands of pink noise that gust."""
    def make(r: Rng, n: int, n_loop: int) -> np.ndarray:
        gust = _tile(periodic_lfo(n_loop, r, [1, 2, 3, 5], 0.45), n)
        f_lo = 380 * 2 ** (0.5 * (_tile(periodic_lfo(n_loop, r, [1, 3], 1.0), n) - 0.5))
        f_hi = 1700 * 2 ** (0.7 * (_tile(periodic_lfo(n_loop, r, [2, 3, 4], 1.0), n) - 0.5))
        src = colored(n, r, -3.0)
        low = sweep(src, "bp", f_lo, 0.8)
        high = sweep(src, "bp", f_hi, 1.6) * 0.5
        rumble = lp(colored(n, r, -6.0), 90) * 1.2
        air = hp(white(n, r), 5000) * 0.03
        return (low + high + air) * gust + rumble * 0.6
    return _stereo_noise_loop(rng, 6.0, make)


def boostLoop(rng: Rng, v: int) -> np.ndarray:
    """Boost held: a torn, fluttering rush over a low roar."""
    def make(r: Rng, n: int, n_loop: int) -> np.ndarray:
        flutter = 0.6 + 0.4 * smooth_noise(n, r, 16.0)
        f = 1500 * 2 ** (0.5 * (_tile(periodic_lfo(n_loop, r, [2, 5], 1.0), n) - 0.5))
        rush = sweep(colored(n, r, -2.0), "bp", f, 1.1) * flutter
        tear = bp(white(n, r), 2800, 7000) * (0.5 + 0.5 * smooth_noise(n, r, 30.0)) * 0.25
        low = bp(colored(n, r, -5.0), 60, 240) * (0.7 + 0.3 * smooth_noise(n, r, 7.0)) * 1.6
        return rush + tear + low
    return _stereo_noise_loop(rng, 4.0, make)


def diveLoop(rng: Rng, v: int) -> np.ndarray:
    """A steep dive: the air starts to whistle and scream over buffeting."""
    def make(r: Rng, n: int, n_loop: int) -> np.ndarray:
        f = 2500 * 2 ** (0.35 * (_tile(periodic_lfo(n_loop, r, [1, 2, 4], 1.0), n) - 0.5))
        src = white(n, r)
        whistle = sweep(src, "bp", f, 9.0) * 0.9 + sweep(src, "bp", f * 1.52, 12.0) * 0.4
        hiss = bp(src, 1200, 8000) * 0.22
        buffet = lp(colored(n, r, -6.0), 140) * (0.5 + 0.5 * smooth_noise(n, r, 11.0)) * 2.0
        return (whistle + hiss) * _tile(periodic_lfo(n_loop, r, [3, 7], 0.3), n) + buffet
    return _stereo_noise_loop(rng, 4.0, make)


def boostStart(rng: Rng, v: int) -> np.ndarray:
    """The kick of a boost: a pressure thump and an up-rushing whoosh that streaks away."""
    n = secs(0.95)
    up = whoosh(rng, 0.95, 220 * jit(rng, 0.1), 3400 * jit(rng, 0.1), 0.2, 0.14, 1.3, 3.0)
    away = whoosh(rng, 0.95, 2600, 500, 0.42, 0.22, 1.0, 2.0) * 0.5
    kick = thump(0.5, 130, 48, 0.12) * 0.9
    snap = bp(white(n, rng), 1500, 6000) * perc(n, 0.001, 0.02) * 0.2
    return room(stack(n, (up, 0, 1.6), (away, 0, 1.0), (kick, 0.03, 1.0), (snap, 0.04, 1.0)), 0.9, 0.12)


# --- Talon ---------------------------------------------------------------------------------------


def fireBolt(rng: Rng, v: int) -> np.ndarray:
    """Ember bolt: a spat fireball. Punch, a falling 'fwoosh', and sizzle."""
    n = secs(0.42)
    k = jit(rng, 0.08)
    punch = fm(glide(n, 260 * k, 85 * k, 3.0), 1.41, env(n, [(0, 5), (0.05, 1), (0.2, 0)]), n) * perc(n, 0.001, 0.045)
    fwoosh = sweep(colored(n, rng, -2.0), "bp", glide(n, 3400 * k, 520 * k, 1.8), 1.3) * perc(n, 0.004, 0.085)
    sizzle = hp(white(n, rng), 4200) * perc(n, 0.002, 0.11) * 0.22 * (0.5 + 0.5 * smooth_noise(n, rng, 60))
    sparks = crackle(n, rng, env(n, [(0, 260), (0.3, 20)]), 2200, 8000, 2.5) * perc(n, 0.003, 0.14) * 0.35
    y = sat((punch * 1.1 + fwoosh * 2.4) * 1.3, 1.0) + sizzle + sparks
    return room(y, 0.5, 0.07)


def dashWhoosh(rng: Rng, v: int) -> np.ndarray:
    """Searing dash: the dragon tears past wrapped in flame."""
    dur = 0.8
    n = secs(dur)
    k = jit(rng, 0.08)
    passby = whoosh(rng, dur, 500 * k, 4200 * k, 0.2, 0.13, 1.6, 2.6)
    doppler = whoosh(rng, dur, 3000 * k, 320 * k, 0.3, 0.2, 2.2, 2.4, -2.0)
    burn = fire_bed(rng, n, 300, 3800, 40.0) * bell_env(n, 0.24, 0.2, 2.0)
    sub = thump(0.5, 150, 42, 0.16)
    y = stack(n, (passby, 0, 1.5), (doppler, 0, 1.3), (burn, 0, 0.45), (sub, 0.1, 0.8))
    return room(sat(y * 1.4, 1.0), 0.8, 0.1)


def afterburn(rng: Rng, v: int) -> np.ndarray:
    """Afterburn: a 'whoomp' of ignition, then a jet of flame that gutters out."""
    dur = 1.25
    n = secs(dur)
    ignite = lp(colored(n, rng, -4.0), 900) * perc(n, 0.012, 0.07) * 2.0
    boom = thump(0.6, 120 * jit(rng, 0.1), 44, 0.17)
    jet = fire_bed(rng, n, 220, 3000, 34.0) * env(n, [(0, 0), (0.06, 1), (0.35, 0.7), (dur, 0)], 1.6)
    tone = sweep(colored(n, rng, -1.0), "bp", glide(n, 420, 240), 6.0) * env(n, [(0, 0), (0.08, 0.6), (dur, 0)]) * 0.5
    y = stack(n, (ignite, 0, 1.0), (boom, 0, 1.0), (jet, 0.02, 0.8), (tone, 0.02, 1.0))
    return room(sat(y * 1.3, 1.0), 0.8, 0.1)


def meteorDrop(rng: Rng, v: int) -> np.ndarray:
    """Meteor strafe: burning stones let go, whistling down."""
    dur = 1.5
    n = secs(dur)
    k = jit(rng, 0.06)
    fall = glide(n, 2600 * k, 520 * k, 0.8)
    whistle = sweep(white(n, rng), "bp", fall, 14.0) * 1.4 + sine(fall * 0.5, n) * 0.06
    whistle *= env(n, [(0, 0), (0.12, 0.5), (dur * 0.8, 1.0), (dur, 0)], 1.5)
    trail = fire_bed(rng, n, 260, 3200, 30.0) * env(n, [(0, 0), (0.2, 0.5), (dur * 0.85, 1), (dur, 0)])
    release = whoosh(rng, 0.5, 300, 1800, 0.08, 0.07, 1.2) * 0.8
    launch = thump(0.4, 140, 55, 0.1)
    y = stack(n, (whistle, 0, 0.8), (trail, 0, 0.5), (release, 0, 1.0), (launch, 0, 0.7))
    return room(y, 1.2, 0.14)


def blast(rng: Rng, v: int) -> np.ndarray:
    """A meteor lands: crack, boom, a wash of fire and falling debris."""
    dur = 1.7
    n = secs(dur)
    k = jit(rng, 0.1)
    crack = hp(white(n, rng), 1200) * perc(n, 0.0005, 0.012)
    boom = fit(thump(1.4, 150 * k, 34 * k, 0.38, 0.05), n)
    body = sweep(colored(n, rng, -3.0), "lp", glide(n, 7000, 180, 2.5), 0.8) * perc(n, 0.003, 0.22)
    rumble = lp(colored(n, rng, -6.0), 160) * perc(n, 0.02, 0.5) * 2.5
    debris = crackle(n, rng, env(n, [(0, 0), (0.08, 240), (1.2, 8)]), 500, 4200, 3.5) * env(n, [(0, 0), (0.1, 1), (dur, 0)])
    y = sat((crack * 0.9 + boom * 1.5 + body * 2.2 + rumble) * 1.6, 1.0) + debris * 0.3
    return room(y, 1.6, 0.2, seed=9)


# --- Bastion -------------------------------------------------------------------------------------


def flameStart(rng: Rng, v: int) -> np.ndarray:
    """The flame cone catches: a deep 'whoof' rising into roar."""
    dur = 0.7
    n = secs(dur)
    whoof = lp(colored(n, rng, -4.0), 700 * jit(rng, 0.1)) * perc(n, 0.02, 0.09) * 2.4
    rise = fire_bed(rng, n, 150, 2600, 24.0) * env(n, [(0, 0), (0.1, 1.0), (0.35, 0.8), (dur, 0)], 1.4)
    sub = thump(0.5, 95, 40, 0.16)
    return room(sat(stack(n, (whoof, 0, 1), (rise, 0, 0.8), (sub, 0, 0.9)) * 1.3, 1.0), 0.6, 0.08)


def flameLoop(rng: Rng, v: int) -> np.ndarray:
    """The flame cone held: a heavy, billowing torrent of fire."""
    n_loop = secs(3.0)
    n = n_loop + secs(0.5)
    bed = fire_bed(rng, n, 120, 2200, 20.0)
    low = lp(colored(n, rng, -6.0), 130) * (0.6 + 0.4 * smooth_noise(n, rng, 6.0)) * 2.2
    jet = bp(colored(n, rng, -1.0), 700, 1900) * (0.5 + 0.5 * smooth_noise(n, rng, 14.0)) * 0.6
    return xfade_loop(sat((bed + low + jet) * 0.9, 1.0), n_loop)


def shieldUp(rng: Rng, v: int) -> np.ndarray:
    """Wing shield raised: wings snap round, and a hard shell rings into place."""
    dur = 1.0
    n = secs(dur)
    k = jit(rng, 0.05)
    wing = whoosh(rng, 0.4, 260, 1200, 0.1, 0.09, 1.0) * 1.6
    rise = np.zeros(n)
    for ratio in (1.0, 1.5, 2.0, 2.67, 3.0):
        f = glide(n, 210 * k * ratio, 420 * k * ratio, 3.0)
        rise += fm(f, 2.01, 1.2, n) / ratio
    rise *= env(n, [(0, 0), (0.12, 1), (0.3, 0.5), (dur, 0)], 1.5) * 0.3
    lock = metal_ring(rng, 0.8, 520 * k, 8, 3.6, 0.28)
    hum = sine(105 * k, n) * env(n, [(0, 0), (0.2, 0.5), (dur, 0)]) * 0.5
    y = stack(n, (wing, 0, 1), (rise, 0.03, 1), (lock, 0.2, 0.55), (hum, 0.1, 1), (thump(0.3, 160, 70, 0.08), 0.2, 0.8))
    return room(y, 1.0, 0.16)


def hitShield(rng: Rng, v: int) -> np.ndarray:
    """A blow stopped by the wing shield: hard, bright and ringing, with weight behind it."""
    n = secs(0.6)
    k = jit(rng, 0.12)
    ring = metal_ring(rng, 0.55, 640 * k, 9, 4.5, 0.2)
    tick = hp(white(n, rng), 2500) * perc(n, 0.0004, 0.006)
    thud = thump(0.3, 190 * k, 75, 0.07)
    spray = bp(white(n, rng), 3000, 9000) * perc(n, 0.002, 0.05) * 0.3
    return room(stack(n, (ring, 0, 0.5), (tick, 0, 0.7), (thud, 0, 1.0), (spray, 0, 1.0)), 0.7, 0.12)


def healShimmer(rng: Rng, v: int) -> np.ndarray:
    """Rally roar: a short, proud bellow with a warm rising glow that mends allies."""
    dur = 1.4
    n = secs(dur)
    call = roar(rng, 0.9, [(0, 70), (0.2, 96), (0.6, 88), (0.9, 62)], (300, 620, 0.9), (800, 1300, 0.6), 2300, 26, 0.5, 0.15)
    glow = np.zeros(n)
    for i, m in enumerate([62, 66, 69, 74, 78, 81]):
        note = partials(note_hz(m), secs(1.0), [1, 2, 3, 4.02], [1, 0.4, 0.2, 0.1], [0.5, 0.35, 0.25, 0.15], rng)
        place(glow, note * np.clip(tline(len(note)) / 0.01, 0, 1), 0.25 + i * 0.07, 0.3)
    air = whoosh(rng, dur, 500, 2600, 0.5, 0.35, 0.9) * 0.5
    return room(stack(n, (call, 0, 1.0), (glow, 0, 1.0), (air, 0, 1.0)), 1.4, 0.2)


def bulwarkWave(rng: Rng, v: int) -> np.ndarray:
    """Bulwark charge: mass gathering, then a gong-like slam and a rolling shockwave."""
    dur = 2.2
    n = secs(dur)
    gather = lp(colored(n, rng, -5.0), 260) * env(n, [(0, 0), (0.45, 1), (0.5, 0)], 2.0) * 2.5
    gather += sweep(colored(n, rng, -2.0), "bp", glide(n, 150, 900), 3.0) * env(n, [(0, 0), (0.45, 1), (0.5, 0)], 2.5)
    slam = thump(1.5, 170, 36, 0.45, 0.06) * 1.6
    gong = metal_ring(rng, 1.6, 138, 11, 5.5, 0.7) * 0.6
    wave = whoosh(rng, 1.6, 2400, 200, 0.12, 0.3, 0.9, 2.5) * 1.6
    crack = hp(white(n, rng), 900) * perc(n, 0.0005, 0.015)
    y = stack(n, (gather, 0, 1.0), (slam, 0.5, 1.0), (gong, 0.5, 1.0), (wave, 0.5, 1.0), (crack, 0.5, 0.8))
    return room(sat(y * 1.3, 1.0), 1.8, 0.22, seed=11)


def windup(rng: Rng, v: int) -> np.ndarray:
    """A dragon drawing breath before it lets fly."""
    dur = 0.55
    n = secs(dur)
    k = jit(rng, 0.1)
    air = colored(n, rng, -2.0)
    inhale = vocal_tract(air, [(glide(n, 380 * k, 900 * k), 3.0, 1.0), (glide(n, 1100 * k, 2300 * k), 4.0, 0.7), (3200, 4.0, 0.3)])
    inhale *= env(n, [(0, 0), (dur * 0.7, 1), (dur, 0)], 1.7)
    chest = sine(glide(n, 70, 110), n) * env(n, [(0, 0), (dur * 0.8, 0.4), (dur, 0)])
    return inhale + chest * 0.15


# --- Tempest -------------------------------------------------------------------------------------


def lightningCharge(rng: Rng, v: int) -> np.ndarray:
    """Lightning lance charging: static gathers into a rising, tightening whine."""
    dur = 1.0
    n = secs(dur)
    k = jit(rng, 0.06)
    rise = glide(n, 380 * k, 2700 * k, 0.7)
    whine = fm(rise, 0.5, env(n, [(0, 0.5), (dur, 4.0)]), n) * 0.35 + sine(rise * 1.5, n) * 0.12
    buzz = pulse(glide(n, 55, 120), n, 0.2) * (0.5 + 0.5 * sine(glide(n, 18, 60), n))
    buzz = bp(buzz, 300, 3600) * 0.6
    static = crackle(n, rng, env(n, [(0, 30), (dur, 900)]), 2500, 10000, 2.0) * 0.6
    amp = env(n, [(0, 0), (dur * 0.9, 1.0), (dur, 0)], 2.0)
    return room((whine + buzz + static) * amp, 0.6, 0.1)


def lightningCrack(rng: Rng, v: int) -> np.ndarray:
    """Lightning lance released: a dry, splitting crack, the arc's buzz, then thunder close by."""
    dur = 1.1
    n = secs(dur)
    k = jit(rng, 0.1)
    crack = white(n, rng) * perc(n, 0.0003, 0.004) + hp(white(n, rng), 3000) * perc(n, 0.0005, 0.02) * 0.8
    arc = zap(rng, 0.3, 110 * k, 8000, 1100 * k)
    tear = sweep(white(n, rng), "bp", glide(n, 5000, 600, 3.0), 0.9) * perc(n, 0.002, 0.07)
    boom = fit(thump(0.8, 120 * k, 40, 0.2, 0.04), n)
    rumble = lp(colored(n, rng, -6.0), 220) * perc(n, 0.03, 0.3) * (0.5 + 0.5 * smooth_noise(n, rng, 14)) * 3.0
    y = sat((crack * 1.4 + tear * 1.6 + boom * 1.2 + rumble) * 1.5, 1.0)
    place(y, arc, 0.004, 0.9)
    return room(y, 1.3, 0.2, seed=13)


def mineLaunch(rng: Rng, v: int) -> np.ndarray:
    """A static mine thrown: a springy 'thwip' and a fizzing spark trailing off."""
    dur = 0.45
    n = secs(dur)
    k = jit(rng, 0.1)
    thwip = sine(glide(n, 1150 * k, 300 * k, 2.5), n) * perc(n, 0.002, 0.06) * 0.6
    pop = thump(0.2, 220, 90, 0.04)
    air = whoosh(rng, dur, 900, 2800, 0.07, 0.06, 1.5) * 1.2
    fizz = zap(rng, 0.35, 140 * k, 9000, 3000) * 0.35
    return room(stack(n, (thwip, 0, 1), (pop, 0, 0.8), (air, 0, 1), (fizz, 0.05, 1)), 0.5, 0.08)


def mineArm(rng: Rng, v: int) -> np.ndarray:
    """A static mine goes off: a cage of arcs snaps shut around whoever is near."""
    dur = 0.95
    n = secs(dur)
    k = jit(rng, 0.08)
    y = np.zeros(n)
    place(y, hp(white(n, rng), 2000) * perc(n, 0.0004, 0.008), 0, 1.0)
    for i in range(5):
        place(y, zap(rng, rng.uniform(0.12, 0.3), rng.uniform(90, 180) * k, 9000, rng.uniform(900, 2500)), i * rng.uniform(0.05, 0.11), 0.8)
    place(y, thump(0.5, 150, 50, 0.13), 0, 1.1)
    hum = pulse(100 * k, n, 0.25) * (0.5 + 0.5 * sine(31, n))
    place(y, bp(hum, 200, 2400) * env(n, [(0, 0.8), (dur, 0)], 2.0), 0, 0.35)
    return room(sat(y * 1.2, 1.0), 0.8, 0.14)


def updraft(rng: Rng, v: int) -> np.ndarray:
    """Updraft: a column of air surges upward and lifts everything in it."""
    dur = 1.2
    n = secs(dur)
    k = jit(rng, 0.08)
    surge = whoosh(rng, dur, 140 * k, 2100 * k, 0.45, 0.32, 0.8, 1.6)
    high = whoosh(rng, dur, 900 * k, 5200 * k, 0.55, 0.3, 1.4, 1.4) * 0.5
    low = lp(colored(n, rng, -6.0), 120) * bell_env(n, 0.3, 0.3, 2.0) * 2.4
    lift = np.zeros(n)
    for ratio in (1.0, 1.26, 1.5):
        lift += sine(glide(n, 180 * k * ratio, 420 * k * ratio), n)
    lift *= bell_env(n, 0.5, 0.35) * 0.1
    return room(stack(n, (surge, 0, 2.0), (high, 0, 1.0), (low, 0, 1.0), (lift, 0, 1.0)), 1.2, 0.16)


def thunder(rng: Rng, v: int) -> np.ndarray:
    """Thunderhead: the sky splits overhead and the roll goes on and on."""
    dur = 3.4
    n = secs(dur)
    y = np.zeros(n)
    crackn = secs(0.5)
    split = white(crackn, rng) * perc(crackn, 0.0004, 0.006) + sweep(white(crackn, rng), "bp", glide(crackn, 6000, 500, 3), 0.8) * perc(crackn, 0.002, 0.09) * 1.5
    place(y, split, 0.0, 1.2)
    place(y, zap(rng, 0.35, 95, 8000, 800), 0.01, 0.6)
    roll = lp(colored(n, rng, -6.0), 300 * jit(rng, 0.1))
    strikes = np.zeros(n)
    t = 0.02
    while t < 2.4:
        place(strikes, perc(secs(0.6), 0.015, rng.uniform(0.12, 0.3)), t, rng.uniform(0.4, 1.0) * np.exp(-t / 1.4))
        t += rng.uniform(0.09, 0.3)
    place(y, roll * strikes * 5.0, 0, 1.0)
    place(y, thump(1.6, 110, 30, 0.5, 0.08), 0.01, 1.4)
    mid = bp(colored(n, rng, -3.0), 200, 1200) * strikes * 1.2
    place(y, mid, 0, 1.0)
    return room(sat(y * 1.3, 1.0), 2.6, 0.3, seed=17)


def slowZap(rng: Rng, v: int) -> np.ndarray:
    """Static clings and drags: a sagging, sticky buzz."""
    dur = 0.5
    n = secs(dur)
    k = jit(rng, 0.1)
    sag = pulse(glide(n, 240 * k, 70 * k, 1.5), n, 0.3) * (0.5 + 0.5 * sine(glide(n, 45, 14), n))
    sag = bp(sag, 250, 3200) * perc(n, 0.004, 0.16)
    return room(sag * 0.8 + zap(rng, dur, 120, 8000, 1500)[:n] * 0.6, 0.5, 0.1)


def stormZap(rng: Rng, v: int) -> np.ndarray:
    """The storm wall bites: a hard sting of static on the hide."""
    dur = 0.38
    n = secs(dur)
    k = jit(rng, 0.15)
    sting = zap(rng, dur, 150 * k, 9000, 1800 * k)
    snap = hp(white(n, rng), 3500) * perc(n, 0.0004, 0.006)
    body = thump(0.2, 260 * k, 110, 0.035) * 0.7
    return room(stack(n, (sting, 0, 1), (snap, 0, 0.8), (body, 0, 1)), 0.4, 0.08)


# --- Wraith --------------------------------------------------------------------------------------


def _whisper(rng: Rng, n: int, k: float) -> np.ndarray:
    """Breath with a voice half inside it: noise through slowly moving mouth shapes."""
    air = colored(n, rng, -1.0)
    m = smooth_noise(n, rng, 2.5)
    return vocal_tract(air, [
        (650 * k * 2 ** (0.5 * m), 5.0, 1.0),
        (1700 * k * 2 ** (0.35 * smooth_noise(n, rng, 3.0)), 7.0, 0.8),
        (3400 * k, 5.0, 0.5),
    ]) + hp(air, 5500) * 0.15


def shadeHiss(rng: Rng, v: int) -> np.ndarray:
    """Shade breath, one gout: a cold exhaled hiss with something whispering in it."""
    dur = 0.7
    n = secs(dur)
    k = jit(rng, 0.1)
    hiss = _whisper(rng, n, k) * env(n, [(0, 0), (0.06, 1), (0.25, 0.6), (dur, 0)], 1.5)
    under = (sine(glide(n, 150 * k, 92 * k), n) + sine(glide(n, 157 * k, 99 * k), n)) * perc(n, 0.02, 0.2) * 0.1
    suck = whoosh(rng, dur, 2600, 500, 0.08, 0.08, 2.0) * 0.6
    return room(hiss * 1.4 + under + suck[:n], 1.1, 0.2, seed=21)


def shadeLoop(rng: Rng, v: int) -> np.ndarray:
    """Shade breath held: a stream of cold whispering dark over a beating, hollow drone."""
    n_loop = secs(3.0)
    n = n_loop + secs(0.5)
    hiss = xfade_loop(_whisper(rng, n, 1.0) * (0.7 + 0.3 * smooth_noise(n, rng, 5.0)), n_loop)
    t = tline(n_loop)
    drone = np.zeros(n_loop)
    for cycles in (270, 277, 405, 418):  # whole cycles per loop: 90 / 92.3 / 135 / 139.3 Hz, beating
        drone += np.sin(TAU * (cycles * t / 3.0 + rng.uniform()))
    drone *= 0.03 * periodic_lfo(n_loop, rng, [2, 3], 0.5)
    return hiss * 1.2 + drone


def veil(rng: Rng, v: int) -> np.ndarray:
    """Veil in: the dragon folds into shadow. Sound is drawn inward and cut off."""
    dur = 1.0
    n = secs(dur)
    k = jit(rng, 0.06)
    swell = mono(reverb(_whisper(rng, secs(0.25), k) * perc(secs(0.25), 0.002, 0.06), 1.2, 0.9, seed=23))[:n][::-1]
    swell = np.pad(swell, (0, max(0, n - len(swell))))[:n]
    fall = np.zeros(n)
    for ratio in (1.0, 1.498, 2.37):
        fall += sine(glide(n, 900 * k * ratio, 240 * k * ratio, 0.6), n) / ratio
    fall *= env(n, [(0, 0), (dur * 0.8, 1), (dur * 0.9, 0)], 2.0) * 0.12
    shut = thump(0.18, 140, 60, 0.03)
    y = swell * 1.0 + fall
    y[-secs(0.01):] *= np.linspace(1, 0, secs(0.01))
    return stack(n + secs(0.2), (y, 0, 1.0), (shut, dur - 0.02, 0.5))


def veilOut(rng: Rng, v: int) -> np.ndarray:
    """Veil out: shadow tears open and the dragon is there."""
    dur = 0.8
    n = secs(dur)
    k = jit(rng, 0.06)
    burst = _whisper(rng, n, 1.2 * k) * perc(n, 0.004, 0.14)
    bloom = whoosh(rng, dur, 400, 3600, 0.07, 0.1, 1.0, 3.0) * 1.2
    rise = (sine(glide(n, 240 * k, 620 * k, 2.0), n) + sine(glide(n, 360 * k, 934 * k, 2.0), n)) * perc(n, 0.01, 0.16) * 0.14
    return room(stack(n, (burst, 0, 1.3), (bloom, 0, 1), (rise, 0, 1), (thump(0.25, 150, 60, 0.06), 0, 0.6)), 1.2, 0.22, seed=23)


def phaseDive(rng: Rng, v: int) -> np.ndarray:
    """Phase dive: the dragon drops out of the world with a hollow, sucking 'voomp'."""
    dur = 1.0
    n = secs(dur)
    k = jit(rng, 0.06)
    air = colored(n, rng, -3.0) * bell_env(n, 0.22, 0.2, 2.4)
    hollow = flange(sweep(air, "bp", glide(n, 2400 * k, 180 * k, 1.5), 1.2), 0.3, 7.0, 0.85)
    drop = sine(glide(n, 330 * k, 38, 1.6), n) * env(n, [(0, 0), (0.05, 1), (dur * 0.7, 0.5), (dur, 0)], 1.3) * 0.7
    shimmer = (sine(glide(n, 1900, 700), n) * sine(glide(n, 2330, 610), n)) * bell_env(n, 0.15, 0.12, 2.0) * 0.12
    return room(hollow * 2.4 + drop + shimmer, 1.2, 0.2, seed=25)


def nightTerror(rng: Rng, v: int) -> np.ndarray:
    """Night terror: light dies; a choir of wrong notes and a scream out of the dark."""
    dur = 2.8
    n = secs(dur)
    cluster = np.zeros(n)
    for m in (50, 51, 56, 57, 62.5, 63, 69.3):
        f = note_hz(m) * (1 + 0.006 * smooth_noise(n, rng, 0.8))
        cluster += ins.formant(saw(f, n, rng.uniform()) + 0.05 * white(n, rng), "oh")
    cluster *= env(n, [(0, 0), (1.0, 1.0), (1.9, 0.8), (dur, 0)], 1.6) * 0.1
    scream = roar(rng, 1.7, [(0, 210), (0.5, 330), (1.2, 290), (1.7, 150)], (500, 1000, 0.3), (1500, 2600, 0.9), 3600, 47, 0.35, 0.5)
    rev = hp(colored(secs(1.2), rng, 0.0), 1500) * (tline(secs(1.2)) / 1.2) ** 3
    sub = sine(41, n) * (0.5 + 0.5 * sine(5.5, n)) * env(n, [(0, 0), (0.6, 1), (2.2, 0.7), (dur, 0)]) * 0.5
    hit = thump(1.0, 120, 34, 0.35, 0.06)
    y = stack(n, (cluster, 0, 1.0), (scream, 0.75, 0.8), (rev, 0.0, 0.3), (sub, 0, 1.0), (hit, 1.2, 1.2))
    return room(sat(y * 1.2, 1.0), 2.6, 0.32, seed=27)


def blindSwell(rng: Rng, v: int) -> np.ndarray:
    """Blinded: the world drops away under a dark swell and a thin ringing."""
    dur = 1.2
    n = secs(dur)
    swell = lp(colored(n, rng, -4.0), 500) * bell_env(n, 0.3, 0.25, 2.5) * 2.0
    ring = (sine(3150, n) + 0.5 * sine(3163, n)) * env(n, [(0, 0), (0.25, 1), (dur, 0)], 2.0) * 0.07
    drop = sine(glide(n, 220, 60), n) * bell_env(n, 0.25, 0.2, 2.0) * 0.4
    return room(swell + ring + drop, 1.4, 0.25, seed=29)


def burnIgnite(rng: Rng, v: int) -> np.ndarray:
    """Hide catches fire: a quick 'fwuf' and spitting embers."""
    dur = 0.6
    n = secs(dur)
    k = jit(rng, 0.1)
    fwuf = sweep(colored(n, rng, -3.0), "bp", glide(n, 300 * k, 1500 * k), 1.0) * perc(n, 0.015, 0.07) * 2.5
    embers = fire_bed(rng, n, 500, 4500, 30.0) * env(n, [(0, 0), (0.05, 0.8), (dur, 0)], 1.5) * 0.5
    spit = crackle(n, rng, 160, 1500, 7000, 3.0) * env(n, [(0, 1), (dur, 0)]) * 0.5
    return room(fwuf + embers + spit, 0.5, 0.08)


# --- dragons -------------------------------------------------------------------------------------


def roarTalon(rng: Rng, v: int) -> np.ndarray:
    """Talon: lean and fast. A high, tearing shriek."""
    k = jit(rng, 0.05)
    y = roar(rng, 1.25, [(0, 170 * k), (0.2, 300 * k), (0.7, 265 * k), (1.25, 140 * k)], (620, 1250, 0.25), (1700, 2900, 0.9), 4200, 58, 0.4, 0.25, 3.5)
    return room(y, 1.6, 0.22, seed=31)


def roarBastion(rng: Rng, v: int) -> np.ndarray:
    """Bastion: a wall of muscle. A slow roar from the bottom of the chest."""
    k = jit(rng, 0.05)
    y = roar(rng, 1.9, [(0, 52 * k), (0.4, 84 * k), (1.2, 72 * k), (1.9, 44 * k)], (260, 640, 1.2), (760, 1250, 0.6), 2300, 23, 0.6, 0.18, 4.0)
    n = len(y)
    y = y + lp(colored(n, rng, -6.0), 90) * env(n, [(0, 0), (0.4, 1), (1.9, 0)]) * 1.2
    return room(y, 2.0, 0.24, seed=33)


def roarTempest(rng: Rng, v: int) -> np.ndarray:
    """Tempest: the storm's own voice. A ringing roar with static crawling over it."""
    k = jit(rng, 0.05)
    y = roar(rng, 1.5, [(0, 100 * k), (0.25, 165 * k), (0.9, 150 * k), (1.5, 82 * k)], (430, 900, 0.5), (1250, 2100, 0.8), 3300, 37, 0.45, 0.2, 3.2)
    n = len(y)
    y = flange(y, 1.2, 4.5, 0.5)
    y += crackle(n, rng, env(n, [(0, 100), (0.5, 700), (1.5, 50)]), 2500, 9000, 2.2) * env(n, [(0, 0.2), (0.4, 1), (1.5, 0)]) * 0.35
    return room(y, 1.9, 0.26, seed=35)


def roarWraith(rng: Rng, v: int) -> np.ndarray:
    """Wraith: more breath than voice. A hollow, doubled howl from somewhere behind you."""
    k = jit(rng, 0.05)
    a = roar(rng, 1.7, [(0, 150 * k), (0.4, 126 * k), (1.1, 118 * k), (1.7, 88 * k)], (380, 760, 0.3), (1900, 2700, 0.7), 3800, 9, 0.2, 0.9, 2.2)
    b = roar(rng, 1.7, [(0, 226 * k), (0.4, 190 * k), (1.1, 176 * k), (1.7, 131 * k)], (420, 800, 0.2), (2000, 2900, 0.7), 4100, 11, 0.2, 0.9, 2.0)
    y = a + 0.6 * b
    pre = mono(reverb(y[: secs(0.4)], 1.0, 0.9, seed=37))[::-1][-secs(0.5):]
    return room(np.concatenate([pre * 0.35, y]), 2.4, 0.34, seed=37)


# --- combat --------------------------------------------------------------------------------------


def hitFlesh(rng: Rng, v: int) -> np.ndarray:
    """A blow on dragon hide: a thick, leathery thwack."""
    n = secs(0.34)
    k = jit(rng, 0.15)
    slap = bp(white(n, rng), 180 * k, 1400 * k) * perc(n, 0.001, 0.028) * 1.8
    body = thump(0.3, 175 * k, 62 * k, 0.065, 0.02)
    crunch = grains(bp(white(SR // 2, rng), 600, 3500), n, rng, 14, (0.004, 0.016), (0.6, 1.6), perc(n, 0.002, 0.03)) * 0.35
    scale = metal_ring(rng, 0.2, 1400 * k, 5, 3.0, 0.03) * 0.12
    return room(sat(stack(n, (slap, 0, 1), (body, 0, 1.2), (crunch, 0.003, 1), (scale, 0, 1)) * 1.4, 1.0), 0.4, 0.08)


def hitRock(rng: Rng, v: int) -> np.ndarray:
    """A dragon clips stone: a crack, a heavy scrape and grit falling away."""
    n = secs(0.8)
    k = jit(rng, 0.12)
    crack = hp(white(n, rng), 900) * perc(n, 0.0004, 0.01)
    knock = np.zeros(n)
    for _ in range(4):
        f = rng.uniform(380, 1500) * k
        place(knock, partials(f, secs(0.12), [1, 1.72, 2.9], [1, 0.5, 0.3], [0.03, 0.02, 0.012], rng), rng.uniform(0, 0.05), rng.uniform(0.5, 1))
    thud = thump(0.4, 130 * k, 48, 0.09)
    scrape = bp(colored(n, rng, -2.0), 500, 3200) * (0.5 + 0.5 * smooth_noise(n, rng, 50)) * perc(n, 0.01, 0.1) * 0.9
    grit = crackle(n, rng, env(n, [(0, 0), (0.06, 220), (0.7, 5)]), 900, 6000, 3.0) * 0.35
    return room(sat(stack(n, (crack, 0, 0.8), (knock, 0, 0.8), (thud, 0, 1.3), (scrape, 0.01, 1), (grit, 0, 1)) * 1.3, 1.0), 0.9, 0.16, seed=9)


def takedownBoom(rng: Rng, v: int) -> np.ndarray:
    """A dragon is brought down: a chest-deep detonation that rolls out across the sky."""
    dur = 2.2
    n = secs(dur)
    k = jit(rng, 0.08)
    crack = hp(white(n, rng), 1000) * perc(n, 0.0005, 0.014)
    boom = fit(thump(1.8, 170 * k, 30, 0.5, 0.07), n)
    body = sweep(colored(n, rng, -3.0), "lp", glide(n, 8000, 150, 2.5), 0.8) * perc(n, 0.004, 0.3)
    roll = lp(colored(n, rng, -6.0), 180) * perc(n, 0.04, 0.7) * (0.6 + 0.4 * smooth_noise(n, rng, 9)) * 3.0
    ring = fit(metal_ring(rng, 1.2, 190 * k, 7, 3.2, 0.5), n) * 0.12
    scatter = crackle(n, rng, env(n, [(0, 0), (0.1, 180), (1.6, 4)]), 700, 5000, 3.0) * 0.25
    y = sat((crack + boom * 1.7 + body * 2.4 + roll + ring) * 1.6, 1.0) + scatter
    return room(y, 2.2, 0.26, seed=11)


def deathFall(rng: Rng, v: int) -> np.ndarray:
    """A beaten dragon falls: a cry that drops away with it, wind whistling past limp wings."""
    dur = 2.3
    n = secs(dur)
    k = jit(rng, 0.1)
    cry = roar(rng, dur, [(0, 260 * k), (0.25, 310 * k), (1.2, 170 * k), (dur, 70 * k)], (520, 880, 0.4), (1500, 2100, 0.8), 3300, 31, 0.4, 0.35, 2.6)
    cry *= env(n, [(0, 1), (0.5, 0.9), (dur, 0.15)])
    wind = sweep(white(n, rng), "bp", glide(n, 2800, 700, 0.8), 7.0) * env(n, [(0, 0), (0.6, 0.6), (1.8, 1), (dur, 0)]) * 0.9
    flutter = bp(colored(n, rng, -4.0), 120, 700) * (0.5 + 0.5 * sine(glide(n, 13, 7), n)) * env(n, [(0, 0), (0.5, 1), (dur, 0)]) * 1.4
    return room(cry + wind + flutter, 1.8, 0.24, seed=13)


def spawnChime(rng: Rng, v: int) -> np.ndarray:
    """Respawn: wings open on the gate's updraft; a warm chord blooms."""
    dur = 1.4
    n = secs(dur)
    bloom = whoosh(rng, dur, 300, 3200, 0.25, 0.22, 0.9, 2.5) * 1.2
    chord = np.zeros(n)
    for i, m in enumerate([62, 69, 74, 76, 81]):
        note = partials(note_hz(m), secs(1.1), [1, 2, 3, 4.03, 5.1], [1, 0.45, 0.2, 0.1, 0.05], [0.55, 0.4, 0.28, 0.2, 0.12], rng)
        place(chord, note * np.clip(tline(len(note)) / 0.012, 0, 1), 0.08 + i * 0.045, 0.3)
    lift = sine(glide(n, 90, 180), n) * bell_env(n, 0.2, 0.18, 2.0) * 0.4
    return room(bloom + chord + lift, 1.5, 0.24, seed=39)


# --- local feedback and loops (stereo) -----------------------------------------------------------


def hitConfirm(rng: Rng, v: int) -> np.ndarray:
    """Your hit landed: a tight, dry tick that cuts through without annoying."""
    n = secs(0.12)
    k = jit(rng, 0.03)
    tick = partials(1750 * k, n, [1, 2.02, 3.3], [1, 0.5, 0.2], [0.018, 0.012, 0.008], rng)
    wood = bp(white(n, rng), 1200, 5200) * perc(n, 0.0004, 0.006) * 0.6
    low = thump(0.1, 420, 220, 0.015) * 0.4
    return widen(stack(n, (tick, 0, 1), (wood, 0, 1), (low, 0, 1)), rng, 0.2)


def takedownConfirm(rng: Rng, v: int) -> np.ndarray:
    """Your takedown: a drum, and two horns leaping a fifth with a glint on top."""
    n = secs(1.6)
    out = np.zeros((n, 2))
    place(out, ins.taiko(1.0, rng, 60, 0.3), 0, 0.9)
    place(out, ins.horn(note_hz(62), 0.14, 1.0, rng, players=3, attack=0.02), 0.0, 1.0)
    place(out, ins.horn(note_hz(69), 0.5, 1.0, rng, players=3, attack=0.02), 0.15, 1.0)
    place(out, ins.horn(note_hz(57), 0.5, 0.8, rng, players=2, attack=0.02), 0.15, 0.7)
    for i, m in enumerate([81, 86, 93]):
        place(out, ins.celesta(note_hz(m), 0.8, 0.6, rng), 0.15 + i * 0.05, 0.6)
    return reverb(out, 1.3, 0.2, seed=41)


def assist(rng: Rng, v: int) -> np.ndarray:
    """Your assist: two soft rising bell notes."""
    n = secs(0.9)
    out = np.zeros((n, 2))
    place(out, ins.celesta(note_hz(74), 0.4, 0.7, rng), 0.0, 1.0)
    place(out, ins.celesta(note_hz(81), 0.6, 0.7, rng), 0.11, 1.0)
    place(out, ins.harp(note_hz(62), 0.5, 0.5, rng, 0.0), 0.0, 0.8)
    return reverb(out, 1.0, 0.18, seed=41)


def objective(rng: Rng, v: int) -> np.ndarray:
    """An objective changes hands: a horn call, two notes."""
    n = secs(1.3)
    out = np.zeros((n, 2))
    place(out, ins.horn(note_hz(57), 0.2, 0.8, rng, players=2), 0.0, 1.0)
    place(out, ins.horn(note_hz(64), 0.55, 0.85, rng, players=2), 0.22, 1.0)
    place(out, ins.frame_drum(0.8, rng), 0.0, 0.8)
    place(out, ins.frame_drum(0.9, rng), 0.22, 0.8)
    return reverb(out, 1.3, 0.22, seed=41)


def heartbeat(rng: Rng, v: int) -> np.ndarray:
    """Low health: your own pulse, close. Lub-dub."""
    n = secs(0.55)
    k = jit(rng, 0.03)

    def beat(f: float, gain: float) -> np.ndarray:
        m = secs(0.3)
        body = thump(0.3, f * 2.6, f, 0.075, 0.03)
        knock = bp(colored(m, rng, -3.0), 110, 420) * perc(m, 0.004, 0.03) * 2.0
        return sat((body + knock) * 2.2 * gain, 1.0)

    y = stack(n, (beat(74 * k, 1.0), 0.0, 1.0), (beat(64 * k, 0.8), 0.17, 1.0))
    return widen(lp(y, 700, 2), rng, 0.1)


def stormLoop(rng: Rng, v: int) -> np.ndarray:
    """The storm wall: a huge low hum that beats against itself, wind, and mains-like static."""
    dur = 5.0
    n_loop = secs(dur)
    t = tline(n_loop)
    chans = []
    for c in range(2):
        hum = np.zeros(n_loop)
        for cycles, amp in ((275, 1.0), (277, 0.9), (550, 0.4), (553, 0.35), (826, 0.2), (1100, 0.1)):  # 55 Hz and up, beating
            hum += amp * np.sin(TAU * (cycles * t / dur + rng.uniform()))
        hum *= 0.16 * periodic_lfo(n_loop, rng, [1, 2, 3], 0.4)
        n = n_loop + secs(0.5)
        wind = bp(colored(n, rng, -3.0), 250, 2400) * (0.5 + 0.5 * smooth_noise(n, rng, 1.5))
        static = crackle(n, rng, 180.0, 2000, 9000, 2.2) * (0.4 + 0.6 * (smooth_noise(n, rng, 4.0) > 0.2)) * 0.5
        chop = bp(white(n, rng), 1800, 6000) * (0.5 + 0.5 * np.sign(np.sin(TAU * 100 * tline(n)))) * 0.12 * (0.5 + 0.5 * smooth_noise(n, rng, 2.0))
        chans.append(hum + xfade_loop(wind * 0.8 + static + chop, n_loop))
    return np.stack(chans, axis=1)


# --- match flow (stereo) -------------------------------------------------------------------------


def countdownTick(rng: Rng, v: int) -> np.ndarray:
    """3, 2, 1: a drum tap with a clear pitch on it."""
    n = secs(0.6)
    out = np.zeros((n, 2))
    place(out, ins.frame_drum(1.0, rng), 0, 1.0)
    place(out, ins.celesta(note_hz(69), 0.25, 0.9, rng), 0, 0.9)
    place(out, ins.harp(note_hz(57), 0.3, 0.8, rng, 0.0), 0, 0.9)
    return reverb(out, 0.7, 0.12, seed=41)


def countdownGo(rng: Rng, v: int) -> np.ndarray:
    """Round start: drums and horns throw the gates open."""
    n = secs(1.9)
    out = np.zeros((n, 2))
    place(out, ins.taiko(1.0, rng, 54, 0.4), 0, 1.0)
    place(out, ins.sub_boom(0.8), 0, 0.7)
    for m, vel in ((50, 1.0), (57, 1.0), (62, 1.0), (69, 0.8)):
        place(out, ins.horn(note_hz(m), 0.85, vel, rng, players=3, attack=0.025), 0.0, 0.8)
    place(out, ins.celesta(note_hz(81), 0.8, 0.7, rng), 0, 0.7)
    place(out, ins.cymbal_swell(0.12, 0.8, rng), -0.0, 0.8)
    return reverb(out, 1.6, 0.24, seed=41)


def roundEnd(rng: Rng, v: int) -> np.ndarray:
    """Round over: two falling horn chords and a drum, settling."""
    n = secs(2.2)
    out = np.zeros((n, 2))
    place(out, ins.taiko(0.9, rng, 56, 0.4), 0, 0.9)
    for m in (57, 62, 65):
        place(out, ins.horn(note_hz(m), 0.45, 0.8, rng, players=2), 0.0, 0.8)
    for m in (50, 57, 62):
        place(out, ins.horn(note_hz(m), 0.9, 0.7, rng, players=2, release=0.5), 0.5, 0.8)
    place(out, ins.taiko(0.7, rng, 50, 0.5), 0.5, 0.9)
    return reverb(out, 1.8, 0.26, seed=41)


# --- interface (stereo) --------------------------------------------------------------------------


def uiHover(rng: Rng, v: int) -> np.ndarray:
    """Pointer over a control: a breath of a tick."""
    n = secs(0.07)
    k = jit(rng, 0.04)
    tick = partials(2300 * k, n, [1, 1.5], [1, 0.4], [0.01, 0.007], rng) * 0.6
    air = bp(white(n, rng), 2500, 7000) * perc(n, 0.001, 0.008) * 0.5
    return widen(tick + air, rng, 0.25)


def uiClick(rng: Rng, v: int) -> np.ndarray:
    """A press: a small carved-wood knock with a clean pitch."""
    n = secs(0.14)
    k = jit(rng, 0.03)
    knock = partials(880 * k, n, [1, 2.4, 4.1], [1, 0.45, 0.2], [0.028, 0.014, 0.008], rng)
    click = hp(white(n, rng), 3000) * perc(n, 0.0003, 0.003) * 0.5
    low = thump(0.1, 300, 150, 0.02) * 0.5
    return widen(stack(n, (knock, 0, 1), (click, 0, 1), (low, 0, 1)), rng, 0.2)


def uiReady(rng: Rng, v: int) -> np.ndarray:
    """Ready: a bright rising pair with a little glow."""
    n = secs(1.0)
    out = np.zeros((n, 2))
    place(out, ins.celesta(note_hz(74), 0.3, 0.8, rng), 0, 1.0)
    place(out, ins.celesta(note_hz(78), 0.3, 0.8, rng), 0.09, 1.0)
    place(out, ins.celesta(note_hz(81), 0.6, 0.9, rng), 0.18, 1.0)
    place(out, ins.harp(note_hz(62), 0.5, 0.6, rng, 0.0), 0, 0.9)
    return reverb(out, 1.0, 0.2, seed=41)


def uiError(rng: Rng, v: int) -> np.ndarray:
    """No: two dull, slightly sour knocks."""
    n = secs(0.4)

    def knock() -> np.ndarray:
        m = secs(0.16)
        return (partials(277, m, [1, 1.06, 2.3], [1, 0.8, 0.3], [0.05, 0.05, 0.02], rng)
                + lp(white(m, rng), 900) * perc(m, 0.001, 0.012) * 0.6)

    return widen(stack(n, (knock(), 0, 1.0), (knock(), 0.13, 0.85)), rng, 0.15)


# --- ambience (stereo loops) ---------------------------------------------------------------------


def ambWind(rng: Rng, v: int) -> np.ndarray:
    """High-altitude wind bed: wide, slow, with thin whistling over rock far below."""
    def make(r: Rng, n: int, n_loop: int) -> np.ndarray:
        gust = _tile(periodic_lfo(n_loop, r, [1, 2, 3, 5, 8], 0.55), n)
        f_lo = 260 * 2 ** (0.6 * (_tile(periodic_lfo(n_loop, r, [1, 2, 5], 1.0), n) - 0.5))
        f_hi = 1100 * 2 ** (0.9 * (_tile(periodic_lfo(n_loop, r, [2, 3, 7], 1.0), n) - 0.5))
        src = colored(n, r, -3.5)
        body = sweep(src, "bp", f_lo, 0.7) + sweep(src, "bp", f_hi, 2.2) * 0.4 * _tile(periodic_lfo(n_loop, r, [3, 4], 0.8), n)
        whistle = sweep(white(n, r), "bp", 2100 * 2 ** (0.2 * (_tile(periodic_lfo(n_loop, r, [2, 5], 1.0), n) - 0.5)), 30.0)
        whistle *= _tile(periodic_lfo(n_loop, r, [1, 4, 6], 1.0), n) ** 4 * 0.5
        deep = lp(colored(n, r, -6.0), 70) * 1.0
        return body * gust + whistle + deep
    return _stereo_noise_loop(rng, 24.0, make)


def ambThunder(rng: Rng, v: int) -> np.ndarray:
    """Distant thunder: a long, mostly quiet loop with three far rolls in it."""
    dur = 36.0
    n_loop = secs(dur)
    out = np.zeros((n_loop + secs(8.0), 2))
    for at_s, level in ((3.0, 1.0), (15.5, 0.6), (26.0, 0.85)):
        n = secs(6.0)
        roll = lp(colored(n, rng, -6.0), rng.uniform(140, 220))
        strikes = np.zeros(n)
        t = 0.0
        while t < 4.0:
            place(strikes, perc(secs(1.2), 0.08, rng.uniform(0.25, 0.6)), t, rng.uniform(0.3, 1.0) * np.exp(-((t - 0.8) ** 2) / 3.0))
            t += rng.uniform(0.15, 0.5)
        y = roll * strikes
        wet = reverb(pan(y, rng.uniform(-0.6, 0.6)), 3.0, 0.6, seed=43, lo=40, hi=900)
        place(out, wet, at_s, level)
    from dsp import wrap_loop
    return wrap_loop(out, n_loop)


def ambAerie(rng: Rng, v: int) -> np.ndarray:
    """Aerie lobby: sheltered wind in a high stone hall, banners, a far wind-chime, a brazier."""
    dur = 24.0
    n_loop = secs(dur)

    def make(r: Rng, n: int, n_loop_: int) -> np.ndarray:
        gust = _tile(periodic_lfo(n_loop_, r, [1, 2, 3], 0.5), n)
        src = colored(n, r, -4.0)
        hall = sweep(src, "bp", 220 * 2 ** (0.5 * (_tile(periodic_lfo(n_loop_, r, [1, 3], 1.0), n) - 0.5)), 0.8)
        moan = sweep(src, "bp", 480 * 2 ** (0.25 * (_tile(periodic_lfo(n_loop_, r, [2, 3], 1.0), n) - 0.5)), 12.0)
        moan *= _tile(periodic_lfo(n_loop_, r, [1, 2, 5], 1.0), n) ** 3 * 0.35
        brazier = (bp(colored(n, r, -4.0), 200, 1800) * (0.6 + 0.4 * smooth_noise(n, r, 12.0)) * 0.25
                   + crackle(n, r, 9.0, 900, 4500, 3.0) * 0.25)
        cloth = bp(colored(n, r, -3.0), 300, 2200) * np.clip(smooth_noise(n, r, 5.0), 0, 1) ** 2 * gust * 0.5
        return hall * gust * 1.4 + moan + brazier + cloth

    bed = _stereo_noise_loop(rng, dur, make)
    chimes = np.zeros((n_loop + secs(5.0), 2))
    for at_s in (2.2, 2.9, 9.4, 15.8, 16.3, 17.1, 21.6):
        m = rng.choice([86, 88, 90, 93, 95, 98])
        note = partials(note_hz(m), secs(2.5), [1, 2.76, 5.4], [1, 0.3, 0.1], [0.9, 0.4, 0.2], rng) * 0.02
        place(chimes, reverb(pan(note, rng.uniform(-0.7, 0.7)), 2.5, 0.8, seed=45), at_s, 1.0)
    from dsp import wrap_loop
    return bed + wrap_loop(chimes, n_loop)


# --- registry ------------------------------------------------------------------------------------
# id -> (function, variations, loop seconds or None). Channel count comes from the render itself.

SFX = {
    "fireBolt": (fireBolt, 4, None), "dashWhoosh": (dashWhoosh, 2, None), "afterburn": (afterburn, 2, None),
    "meteorDrop": (meteorDrop, 2, None), "flameStart": (flameStart, 2, None), "flameLoop": (flameLoop, 1, 3.0),
    "shieldUp": (shieldUp, 2, None), "healShimmer": (healShimmer, 2, None), "bulwarkWave": (bulwarkWave, 1, None),
    "lightningCharge": (lightningCharge, 2, None), "lightningCrack": (lightningCrack, 3, None),
    "mineLaunch": (mineLaunch, 2, None), "mineArm": (mineArm, 2, None), "updraft": (updraft, 2, None),
    "thunder": (thunder, 2, None), "shadeHiss": (shadeHiss, 3, None), "shadeLoop": (shadeLoop, 1, 3.0),
    "veil": (veil, 2, None), "veilOut": (veilOut, 2, None), "phaseDive": (phaseDive, 2, None),
    "nightTerror": (nightTerror, 1, None), "windup": (windup, 2, None), "hitFlesh": (hitFlesh, 4, None),
    "hitShield": (hitShield, 3, None), "hitRock": (hitRock, 3, None), "stormZap": (stormZap, 3, None),
    "slowZap": (slowZap, 2, None), "burnIgnite": (burnIgnite, 2, None), "blindSwell": (blindSwell, 1, None),
    "blast": (blast, 3, None), "takedownBoom": (takedownBoom, 2, None), "deathFall": (deathFall, 2, None),
    "spawnChime": (spawnChime, 1, None), "flapSmall": (flapSmall, 4, None), "flap": (flap, 4, None),
    "flapLarge": (flapLarge, 4, None), "boostStart": (boostStart, 2, None),
    "roarTalon": (roarTalon, 2, None), "roarBastion": (roarBastion, 2, None), "roarTempest": (roarTempest, 2, None),
    "roarWraith": (roarWraith, 2, None),
    "hitConfirm": (hitConfirm, 2, None), "takedownConfirm": (takedownConfirm, 1, None), "assist": (assist, 1, None),
    "objective": (objective, 1, None), "heartbeat": (heartbeat, 2, None),
    "windLoop": (windLoop, 1, 6.0), "boostLoop": (boostLoop, 1, 4.0), "diveLoop": (diveLoop, 1, 4.0),
    "stormLoop": (stormLoop, 1, 5.0),
    "countdownTick": (countdownTick, 1, None), "countdownGo": (countdownGo, 1, None), "roundEnd": (roundEnd, 1, None),
    "uiHover": (uiHover, 2, None), "uiClick": (uiClick, 3, None), "uiReady": (uiReady, 1, None), "uiError": (uiError, 1, None),
}

AMBIENCE = {
    "windBed": (ambWind, 24.0), "thunder": (ambThunder, 36.0), "aerie": (ambAerie, 24.0),
}

# Tone-balance targets per sound: (most sub < 90 Hz, most low 90-300 Hz, least high > 2.5 kHz), as
# fractions of the energy (dsp.balance). The defaults keep a sound audible on laptop speakers;
# the exceptions are sounds that are meant to be heavy, dark or pure.
BALANCE_DEFAULT = (0.18, 0.36, 0.05)
BALANCE = {
    "blast": (0.3, 0.38, 0.04), "takedownBoom": (0.3, 0.38, 0.04), "thunder": (0.3, 0.4, 0.03),
    "bulwarkWave": (0.28, 0.38, 0.04), "roarBastion": (0.25, 0.42, 0.03), "flapLarge": (0.28, 0.4, 0.03),
    "heartbeat": (0.3, 0.6, 0.0), "blindSwell": (0.25, 0.5, 0.0), "uiError": (0.1, 0.7, 0.0),
    "stormLoop": (0.25, 0.36, 0.05), "phaseDive": (0.22, 0.45, 0.03), "nightTerror": (0.25, 0.36, 0.05),
    "assist": (1, 1, 0), "uiReady": (1, 1, 0), "uiHover": (1, 1, 0), "uiClick": (1, 1, 0), "hitConfirm": (1, 1, 0),
    "spawnChime": (1, 1, 0), "countdownTick": (0.1, 0.5, 0.0), "objective": (0.1, 0.4, 0.0),
    "takedownConfirm": (0.2, 0.36, 0.02), "countdownGo": (0.22, 0.36, 0.03), "roundEnd": (0.22, 0.36, 0.02),
    "victory": (0.14, 0.34, 0.03), "defeat": (0.2, 0.4, 0.015),
    "lobby": (0.12, 0.34, 0.025), "matchLow": (0.14, 0.36, 0.02), "matchHigh": (0.16, 0.34, 0.035),
    "windBed": (0.1, 0.3, 0.04), "aerie": (0.08, 0.34, 0.03),
}
