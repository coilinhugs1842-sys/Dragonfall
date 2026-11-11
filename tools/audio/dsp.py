"""Offline DSP primitives for the Dragonfall audio build (T-4.8).

Everything is float64 numpy at SR. Mono signals are shape (n,), stereo (n, 2). All randomness
comes from a numpy Generator handed in by the caller, so a build is reproducible.
Needs numpy and scipy (scipy.signal for IIR filters and FFT convolution).
"""

from __future__ import annotations

import numpy as np
from scipy import signal

SR = 44100
TAU = 2.0 * np.pi


# --- basics ------------------------------------------------------------------------------------


def secs(t: float) -> int:
    return max(1, int(round(t * SR)))


def tline(n: int) -> np.ndarray:
    return np.arange(n) / SR


def db(x: float) -> float:
    return 10.0 ** (x / 20.0)


def note_hz(midi: float) -> float:
    return 440.0 * 2.0 ** ((midi - 69.0) / 12.0)


def mono(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 1 else x.mean(axis=1)


def stereo(x: np.ndarray) -> np.ndarray:
    return x if x.ndim == 2 else np.stack([x, x], axis=1)


def peak(x: np.ndarray) -> float:
    return float(np.max(np.abs(x))) if x.size else 0.0


def norm(x: np.ndarray, level: float = 0.9) -> np.ndarray:
    p = peak(x)
    return x * (level / p) if p > 1e-9 else x


def dc(x: np.ndarray) -> np.ndarray:
    return x - x.mean(axis=0)


def sat(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    """tanh saturation, unity gain for small signals."""
    return np.tanh(x * drive) / drive


def fade(x: np.ndarray, t_in: float = 0.002, t_out: float = 0.01) -> np.ndarray:
    y = x.copy()
    n = len(y)
    a = min(secs(t_in), n // 2)
    b = min(secs(t_out), n // 2)
    win_in = 0.5 - 0.5 * np.cos(np.pi * np.arange(a) / a)
    win_out = 0.5 + 0.5 * np.cos(np.pi * np.arange(b) / b)
    if y.ndim == 2:
        win_in = win_in[:, None]
        win_out = win_out[:, None]
    y[:a] *= win_in
    y[n - b :] *= win_out
    return y


def trim_tail(x: np.ndarray, floor_db: float = -46.0, t_out: float = 0.05) -> np.ndarray:
    """Cuts the silent end (below floor relative to the peak) and fades the cut."""
    level = np.abs(x) if x.ndim == 1 else np.abs(x).max(axis=1)
    p = level.max()
    if p <= 0:
        return x
    above = np.nonzero(level > p * db(floor_db))[0]
    end = min(len(x), int(above[-1]) + secs(t_out) + 1)
    return fade(x[:end], 0.0005, t_out)


def place(buf: np.ndarray, x: np.ndarray, t: float, gain: float = 1.0) -> None:
    """Adds x into buf starting at t seconds (clipped to the buffer)."""
    start = int(round(t * SR))
    if start < 0:
        x = x[-start:]
        start = 0
    end = min(len(buf), start + len(x))
    if end <= start:
        return
    part = x[: end - start]
    if buf.ndim == 2 and part.ndim == 1:
        part = part[:, None]
    elif buf.ndim == 1 and part.ndim == 2:
        part = part.mean(axis=1)
    buf[start:end] += part * gain


def resample(x: np.ndarray, ratio: float) -> np.ndarray:
    """Plays x `ratio` times faster (pitch and speed together), linear interpolation."""
    n = max(2, int(len(x) / ratio))
    pos = np.arange(n) * ratio
    if x.ndim == 1:
        return np.interp(pos, np.arange(len(x)), x)
    return np.stack([np.interp(pos, np.arange(len(x)), x[:, c]) for c in range(2)], axis=1)


# --- envelopes ---------------------------------------------------------------------------------


def env(n: int, points: list[tuple[float, float]], power: float = 1.0) -> np.ndarray:
    """Piecewise-linear envelope through (seconds, value) points; `power` bends it."""
    ts = np.array([p[0] for p in points])
    vs = np.array([p[1] for p in points])
    e = np.interp(tline(n), ts, vs)
    return e**power if power != 1.0 else e


def perc(n: int, attack: float, tau: float) -> np.ndarray:
    """Fast attack, exponential decay with time constant tau."""
    t = tline(n)
    a = np.clip(t / max(attack, 1e-5), 0.0, 1.0)
    return a * np.exp(-np.maximum(t - attack, 0.0) / tau)


def bell_env(n: int, centre: float, width: float, skew: float = 1.0) -> np.ndarray:
    """A smooth bump peaking at `centre` seconds; skew > 1 makes the fall slower than the rise."""
    t = tline(n)
    d = (t - centre) / width
    d = np.where(d > 0, d / skew, d)
    return np.exp(-0.5 * d * d * 6.0)


def asr(n: int, attack: float, release: float, power: float = 1.0) -> np.ndarray:
    t = tline(n)
    total = n / SR
    e = np.minimum(np.clip(t / max(attack, 1e-5), 0, 1), np.clip((total - t) / max(release, 1e-5), 0, 1))
    return (0.5 - 0.5 * np.cos(np.pi * e)) ** power


def periodic_lfo(n: int, rng: np.random.Generator, cycles: list[int], depth: float = 1.0) -> np.ndarray:
    """A wandering 0..1 curve that is exactly periodic over n samples (sum of whole-cycle sines)."""
    phase = np.arange(n) / n
    out = np.zeros(n)
    for c in cycles:
        out += np.sin(TAU * (c * phase + rng.uniform())) / np.sqrt(len(cycles))
    out = 0.5 + 0.5 * np.tanh(out * 1.2)
    return 1.0 - depth + depth * out


# --- noise ------------------------------------------------------------------------------------


def white(n: int, rng: np.random.Generator) -> np.ndarray:
    return rng.uniform(-1.0, 1.0, n)


def colored(n: int, rng: np.random.Generator, slope_db_oct: float = -3.0) -> np.ndarray:
    """Noise with a spectral tilt (-3 = pink, -6 = brown), unit peak."""
    spec = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / SR)
    f[0] = f[1] if n > 1 else 1.0
    spec *= (np.maximum(f, 20.0) / 1000.0) ** (slope_db_oct / 6.0206)
    spec[0] = 0
    return norm(np.fft.irfft(spec, n), 1.0)


def smooth_noise(n: int, rng: np.random.Generator, hz: float) -> np.ndarray:
    """Low-passed noise in about -1..1: a random modulator moving at roughly `hz`."""
    sos = signal.butter(2, min(hz, SR * 0.45), btype="low", fs=SR, output="sos")
    y = signal.sosfilt(sos, rng.standard_normal(n + SR // 2))[SR // 2 :]
    s = np.std(y)
    return np.clip(y / (2.5 * s), -1, 1) if s > 0 else y


# --- filters ----------------------------------------------------------------------------------


def _clampf(f: float) -> float:
    return float(min(max(f, 10.0), SR * 0.45))


def lp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, _clampf(fc), btype="low", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def hp(x: np.ndarray, fc: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, _clampf(fc), btype="high", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def bp(x: np.ndarray, lo: float, hi: float, order: int = 2) -> np.ndarray:
    sos = signal.butter(order, [_clampf(lo), _clampf(hi)], btype="band", fs=SR, output="sos")
    return signal.sosfilt(sos, x, axis=0)


def _rbj(kind: str, fc: float, q: float, gain_db: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    w = TAU * _clampf(fc) / SR
    alpha = np.sin(w) / (2.0 * q)
    c = np.cos(w)
    if kind == "bp":  # constant 0 dB peak gain
        b = np.array([alpha, 0.0, -alpha])
        a = np.array([1 + alpha, -2 * c, 1 - alpha])
    elif kind == "lp":
        b = np.array([(1 - c) / 2, 1 - c, (1 - c) / 2])
        a = np.array([1 + alpha, -2 * c, 1 - alpha])
    elif kind == "hp":
        b = np.array([(1 + c) / 2, -(1 + c), (1 + c) / 2])
        a = np.array([1 + alpha, -2 * c, 1 - alpha])
    elif kind == "peak":
        g = 10.0 ** (gain_db / 40.0)
        b = np.array([1 + alpha * g, -2 * c, 1 - alpha * g])
        a = np.array([1 + alpha / g, -2 * c, 1 - alpha / g])
    else:
        raise ValueError(kind)
    return b / a[0], a / a[0]


def reson(x: np.ndarray, fc: float, q: float) -> np.ndarray:
    """Resonant band-pass with 0 dB at the centre."""
    b, a = _rbj("bp", fc, q)
    return signal.lfilter(b, a, x, axis=0)


def peaking(x: np.ndarray, fc: float, q: float, gain_db: float) -> np.ndarray:
    b, a = _rbj("peak", fc, q, gain_db)
    return signal.lfilter(b, a, x, axis=0)


def sweep(x: np.ndarray, kind: str, fcurve: np.ndarray, q: float | np.ndarray = 1.0, block: int = 48) -> np.ndarray:
    """Time-varying biquad: `fcurve` (Hz per sample) is followed block by block with the filter
    state carried over."""
    n = len(x)
    out = np.empty(n)
    zi = np.zeros(2)
    qv = np.broadcast_to(np.asarray(q, dtype=float), (n,)) if np.ndim(q) else None
    for start in range(0, n, block):
        end = min(n, start + block)
        mid = (start + end) // 2
        qq = float(qv[mid]) if qv is not None else float(q)
        b, a = _rbj(kind, float(fcurve[min(mid, n - 1)]), qq)
        out[start:end], zi = signal.lfilter(b, a, x[start:end], zi=zi)
    return out


def glide(n: int, f0: float, f1: float, curve: float = 1.0) -> np.ndarray:
    """Exponential frequency glide f0 -> f1 over n samples; curve > 1 moves early."""
    u = np.linspace(0.0, 1.0, n) ** (1.0 / curve)
    return f0 * (f1 / f0) ** u


def comb(x: np.ndarray, delay_s: float, feedback: float) -> np.ndarray:
    d = max(1, int(round(delay_s * SR)))
    a = np.zeros(d + 1)
    a[0] = 1.0
    a[d] = -feedback
    return signal.lfilter([1.0], a, x)


def flange(x: np.ndarray, d0_ms: float, d1_ms: float, mix: float = 0.7) -> np.ndarray:
    """Swept short delay mixed back in: the hollow 'phasey' movement."""
    n = len(x)
    delay = np.linspace(d0_ms, d1_ms, n) * 0.001 * SR
    pos = np.arange(n) - delay
    return x + mix * np.interp(pos, np.arange(n), x, left=0.0)


# --- oscillators ------------------------------------------------------------------------------


def _phase(freq: np.ndarray | float, n: int, start: float = 0.0) -> np.ndarray:
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    return start + np.cumsum(f) / SR


def sine(freq: np.ndarray | float, n: int, start: float = 0.0) -> np.ndarray:
    return np.sin(TAU * _phase(freq, n, start))


def saw(freq: np.ndarray | float, n: int, start: float = 0.0) -> np.ndarray:
    """Band-limited (polyBLEP) sawtooth."""
    f = np.broadcast_to(np.asarray(freq, dtype=float), (n,))
    ph = _phase(f, n, start) % 1.0
    dt = np.maximum(f / SR, 1e-9)
    y = 2.0 * ph - 1.0
    lo = ph < dt
    t = ph[lo] / dt[lo]
    y[lo] -= t + t - t * t - 1.0
    hi = ph > 1.0 - dt
    t = (ph[hi] - 1.0) / dt[hi]
    y[hi] -= t * t + t + t + 1.0
    return y


def pulse(freq: np.ndarray | float, n: int, width: float = 0.5, start: float = 0.0) -> np.ndarray:
    return saw(freq, n, start) - saw(freq, n, start + width)


def fm(carrier: np.ndarray | float, ratio: float, index: np.ndarray | float, n: int) -> np.ndarray:
    """Two-operator FM: sin(carrier + index * sin(carrier * ratio))."""
    ph = _phase(carrier, n)
    return np.sin(TAU * ph + index * np.sin(TAU * ph * ratio))


def partials(freq: float, n: int, ratios: list[float], amps: list[float], taus: list[float],
             rng: np.random.Generator | None = None) -> np.ndarray:
    """Additive struck/plucked tone: each partial has its own decay."""
    t = tline(n)
    out = np.zeros(n)
    for ratio, amp, tau in zip(ratios, amps, taus):
        f = freq * ratio
        if f > SR * 0.45:
            continue
        ph = rng.uniform() if rng is not None else 0.0
        out += amp * np.sin(TAU * (f * t + ph)) * np.exp(-t / tau)
    return out


# --- space ------------------------------------------------------------------------------------


def pan(x: np.ndarray, p: float) -> np.ndarray:
    """Mono -> stereo, equal power, p in -1..1."""
    a = (p + 1.0) * np.pi / 4.0
    return np.stack([x * np.cos(a), x * np.sin(a)], axis=1)


def widen(x: np.ndarray, rng: np.random.Generator, amount: float = 0.5) -> np.ndarray:
    """Mono -> stereo by adding a decorrelated (all-pass smeared) side signal."""
    n = len(x)
    ir = rng.standard_normal(secs(0.018)) * np.exp(-tline(secs(0.018)) / 0.005)
    ir /= np.sqrt(np.sum(ir * ir))
    side = signal.fftconvolve(x, ir)[:n] * amount
    return np.stack([x + side, x - side], axis=1)


_IR_CACHE: dict[tuple, np.ndarray] = {}


def reverb_ir(decay: float, seed: int, lo: float = 150.0, hi: float = 6000.0, predelay: float = 0.012) -> np.ndarray:
    """A synthetic stereo room impulse: decaying noise, darker as it dies, with a few early taps."""
    key = (decay, seed, lo, hi, predelay)
    if key in _IR_CACHE:
        return _IR_CACHE[key]
    rng = np.random.default_rng(seed)
    n = secs(decay * 1.6 + predelay)
    t = tline(n)
    ir = np.zeros((n, 2))
    for c in range(2):
        body = rng.standard_normal(n) * np.exp(-t * (6.91 / decay))
        dark = lp(body, hi * 0.35) * np.exp(-t * (6.91 / (decay * 1.25)))
        bright = bp(body, lo, hi)
        mix = np.clip(t / (decay * 0.5), 0, 1)
        tail = bright * (1 - mix) + dark * mix * 1.6
        tail *= np.clip(t / 0.008, 0, 1)  # soft onset: diffuse, not a slap
        for _ in range(7):  # early reflections
            k = int(rng.uniform(0.004, 0.06) * SR)
            tail[k] += rng.uniform(0.3, 0.9) * rng.choice([-1, 1]) * 6.0
        ir[:, c] = np.concatenate([np.zeros(secs(predelay)), tail])[:n]
    ir /= np.sqrt(np.sum(ir * ir) / 2.0)
    _IR_CACHE[key] = ir
    return ir


def reverb(x: np.ndarray, decay: float = 1.5, wet: float = 0.25, seed: int = 7, lo: float = 150.0,
           hi: float = 6000.0, predelay: float = 0.012, tail: bool = True) -> np.ndarray:
    """Convolution reverb. Returns stereo; with `tail` the output is longer than the input."""
    ir = reverb_ir(decay, seed, lo, hi, predelay)
    xs = stereo(x)
    n = len(xs) + (len(ir) if tail else 0)
    out = np.zeros((n, 2))
    out[: len(xs)] = xs
    for c in range(2):
        w = signal.fftconvolve(xs[:, c], ir[:, c])[:n]
        out[: len(w), c] += w * wet
    return out


# --- granular ---------------------------------------------------------------------------------


def grains(src: np.ndarray, n: int, rng: np.random.Generator, count: int, grain_s: tuple[float, float],
           rate: tuple[float, float] = (1.0, 1.0), density_env: np.ndarray | None = None) -> np.ndarray:
    """A cloud of windowed, repitched snippets of `src` scattered over n samples."""
    out = np.zeros(n)
    if density_env is not None:
        cdf = np.cumsum(density_env)
        cdf /= cdf[-1]
    for _ in range(count):
        g = secs(rng.uniform(*grain_s))
        r = rng.uniform(*rate)
        need = int(g * r) + 2
        if need >= len(src):
            continue
        s0 = rng.integers(0, len(src) - need)
        snippet = np.interp(np.arange(g) * r, np.arange(need), src[s0 : s0 + need])
        snippet *= np.hanning(g)
        at = int(np.searchsorted(cdf, rng.uniform())) if density_env is not None else int(rng.integers(0, n))
        end = min(n, at + g)
        out[at:end] += snippet[: end - at] * rng.uniform(0.4, 1.0)
    return out


def crackle(n: int, rng: np.random.Generator, rate_hz: float | np.ndarray, f_lo: float, f_hi: float,
            q: float = 4.0) -> np.ndarray:
    """Random sharp ticks, each ringing a little at its own frequency (fire, sparks, static)."""
    rate = np.broadcast_to(np.asarray(rate_hz, dtype=float), (n,))
    hits = rng.uniform(size=n) < rate / SR
    idx = np.nonzero(hits)[0]
    out = np.zeros(n)
    for i in idx:
        f = np.exp(rng.uniform(np.log(f_lo), np.log(f_hi)))
        length = min(n - i, secs(q / f * 2.0 + 0.002))
        t = tline(length)
        out[i : i + length] += rng.uniform(0.3, 1.0) * rng.choice([-1, 1]) * np.sin(TAU * f * t) * np.exp(-t * f / q)
    return out


# --- loops ------------------------------------------------------------------------------------


def xfade_loop(x: np.ndarray, loop_n: int) -> np.ndarray:
    """Noise-like material rendered `loop_n + overlap` long -> a loop of loop_n: the overhang is
    cross-faded (equal power) over the start, so the end runs straight into the start."""
    over = len(x) - loop_n
    if over <= 0:
        return x[:loop_n]
    out = x[:loop_n].copy()
    u = np.arange(over) / over
    a = np.sin(u * np.pi / 2)
    b = np.cos(u * np.pi / 2)
    if x.ndim == 2:
        a = a[:, None]
        b = b[:, None]
    out[:over] = out[:over] * a + x[loop_n:] * b
    return out


def wrap_loop(x: np.ndarray, loop_n: int) -> np.ndarray:
    """Material with tails that ring past the loop end (music): the overhang is ADDED onto the
    start, exactly as it would sound if the loop had already been round once."""
    out = x[:loop_n].copy()
    rest = x[loop_n:]
    while len(rest) > 0:
        k = min(loop_n, len(rest))
        out[:k] += rest[:k]
        rest = rest[k:]
    return out


def pad_loop(x: np.ndarray, pad_n: int) -> np.ndarray:
    """Pre-roll and post-roll copied from the other side of the seam, so a lossy codec sees
    continuous audio through both loop points. Loop region = [pad_n, pad_n + len(x))."""
    return np.concatenate([x[-pad_n:], x, x[:pad_n]], axis=0)


# --- mastering --------------------------------------------------------------------------------

BALANCE_EDGES = (90.0, 300.0, 2500.0)


def _zero_phase_lp(x: np.ndarray, fc: float, periodic: bool) -> np.ndarray:
    sos = signal.butter(4, fc, btype="low", fs=SR, output="sos")
    if not periodic:
        return signal.sosfiltfilt(sos, x, axis=0)
    n = len(x)
    return signal.sosfiltfilt(sos, np.concatenate([x, x, x], axis=0), axis=0)[n : 2 * n]


def balance(x: np.ndarray, sub_max: float, low_max: float, high_min: float, periodic: bool = False,
            max_boost_db: float = 9.0) -> tuple[np.ndarray, dict]:
    """Static four-band tone balance, so every sound keeps energy a laptop speaker can play.

    Bands: sub < 90 Hz, low 90-300 Hz, mid 300-2500 Hz, high > 2500 Hz. The sub and low bands
    are turned down until they hold at most `sub_max` / `low_max` of the energy, and the high
    band is turned up (at most max_boost_db) until it holds `high_min`. The bands are split with
    zero-phase filters by subtraction, so they sum back to the input exactly and only their
    levels change: no dynamics, nothing time-varying, loops stay loops (`periodic`).
    """
    lp1 = _zero_phase_lp(x, BALANCE_EDGES[0], periodic)
    lp2 = _zero_phase_lp(x, BALANCE_EDGES[1], periodic)
    lp3 = _zero_phase_lp(x, BALANCE_EDGES[2], periodic)
    bands = [lp1, lp2 - lp1, lp3 - lp2, x - lp3]
    e = np.array([float(np.sum(b * b)) for b in bands]) + 1e-12
    g = np.ones(4)
    for _ in range(6):
        total = float(np.sum(g * g * e))
        for i, cap in ((0, sub_max), (1, low_max)):
            rest = total - g[i] ** 2 * e[i]
            if g[i] ** 2 * e[i] > cap * total and cap < 1.0:
                g[i] = np.sqrt(cap * rest / ((1.0 - cap) * e[i]))
                total = rest + g[i] ** 2 * e[i]
        rest = total - g[3] ** 2 * e[3]
        if high_min > 0 and g[3] ** 2 * e[3] < high_min * total:
            g[3] = min(db(max_boost_db), np.sqrt(high_min * rest / ((1.0 - high_min) * e[3])))
    out = sum(b * gain for b, gain in zip(bands, g))
    after = g * g * e
    info = {"before": [round(float(v), 3) for v in e / e.sum()], "after": [round(float(v), 3) for v in after / after.sum()],
            "gainsDb": [round(float(20 * np.log10(v)), 1) for v in g]}
    return out, info
