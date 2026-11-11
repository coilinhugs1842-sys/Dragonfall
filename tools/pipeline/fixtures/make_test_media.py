"""Generates the test PNGs and WAVs for the pipeline tools (not game assets).

  python tools/pipeline/fixtures/make_test_media.py <out dir>

Writes color_1024.png (colour noise), color_256.png, normal_512.png, big_2048x1024.png (2:1),
sfx.wav (0.4 s decaying chirp, quiet, mono) and music.wav (12 s chord pad, stereo).
"""
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image

out = Path(sys.argv[1])
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(7)


def fbm(width, height, octaves=5):
    total = np.zeros((height, width))
    for o in range(octaves):
        cells = 4 * 2**o
        grid = rng.random((cells + 1, cells + 1))
        img = Image.fromarray((grid * 255).astype(np.uint8)).resize((width, height), Image.BICUBIC)
        total += np.asarray(img, dtype=np.float64) / 255 / 2**o
    return total / total.max()


def color_map(width, height):
    n = fbm(width, height)
    warm = np.array([0.95, 0.62, 0.30])
    cool = np.array([0.20, 0.30, 0.48])
    rgb = cool + (warm - cool) * n[..., None]
    rgb += (fbm(width, height, 3)[..., None] - 0.5) * 0.15
    return Image.fromarray((np.clip(rgb, 0, 1) * 255).astype(np.uint8))


def normal_map(size):
    h = fbm(size, size)
    dy, dx = np.gradient(h * 24)
    n = np.stack([-dx, -dy, np.ones_like(h)], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    return Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8))


color_map(1024, 1024).save(out / "color_1024.png")
color_map(256, 256).save(out / "color_256.png")
normal_map(512).save(out / "normal_512.png")
color_map(2048, 1024).save(out / "big_2048x1024.png")


def write_wav(path, samples, rate=48000):
    data = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as f:
        f.setnchannels(data.shape[1] if data.ndim > 1 else 1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes(data.tobytes())


rate = 48000
t = np.arange(int(0.4 * rate)) / rate
chirp = np.sin(2 * np.pi * (900 * t - 900 * t * t)) * np.exp(-t * 9) * 0.2
write_wav(out / "sfx.wav", chirp, rate)

t = np.arange(12 * rate) / rate
pad = sum(np.sin(2 * np.pi * f * t) for f in (110.0, 164.81, 220.0, 277.18)) / 4
pad *= 0.35 * (0.6 + 0.4 * np.sin(2 * np.pi * 0.25 * t))
stereo = np.stack([pad, np.roll(pad, 240)], axis=1)
write_wav(out / "music.wav", stereo, rate)
print("wrote test media to", out)
