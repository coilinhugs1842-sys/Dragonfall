"""Tileable painterly textures for Shattered Spires (T-4.5), authored by script (DECISIONS 36).

  python tools/textures/make_textures.py [name ...] [--set spires|caldera]

Writes 1024 x 1024 seamless PNGs to art-source/textures-raw/ plus means.json (the linear-space
mean colour of each, so a shader can use `texture / mean` as a detail modulation on top of the
painted vertex colours). tools/textures/convert_ktx2.mjs turns them into KTX2.

Look: hand-painted, visible flat brush marks laid in layers (big blocking strokes, mid strokes,
small light and dark dabs), light painted in from the upper left, palette from
docs/ART_DIRECTION.md. Everything is drawn with wrap-around so the tile is seamless.
"""

import json
import math
import os
import random
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
SS = 2  # supersampling
W = SIZE * SS
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
OUT = os.path.join(REPO, "art-source", "textures-raw")


def rgb(hex_color):
    return np.array([(hex_color >> 16) & 255, (hex_color >> 8) & 255, hex_color & 255], dtype=np.float64)


STONE = rgb(0x4E6A86)
STONE_MID = rgb(0x5A7A9C)
STONE_LIGHT = rgb(0x8199B5)
STONE_SHADOW = rgb(0x2A3346)
STONE_DEEP = rgb(0x3A4A66)
VIOLET = rgb(0x5B4C7A)
LIT = rgb(0xC9B79A)
CREAM = rgb(0xF4E6CC)
WARM = rgb(0x8A8C96)
MOSS = rgb(0x3F8F7A)
MOSS_DEEP = rgb(0x2C6B62)
MOSS_DARK = rgb(0x1F4F50)
MOSS_LIGHT = rgb(0x8CC9A1)
MOSS_SUN = rgb(0xC4DC9A)


def lerp(a, b, t):
    return a + (b - a) * t


def ramp(stops, t):
    """Piecewise-linear colour ramp; stops = [(pos, colour)], t scalar in 0..1."""
    t = min(max(t, 0.0), 1.0)
    for i in range(len(stops) - 1):
        p0, c0 = stops[i]
        p1, c1 = stops[i + 1]
        if t <= p1:
            return lerp(c0, c1, 0.0 if p1 == p0 else (t - p0) / (p1 - p0))
    return stops[-1][1]


def tile_noise(n, beta, seed, min_cycles=3.0):
    """Periodic fractal noise in 0..1 (spectral synthesis: white noise shaped by 1/f^beta)."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((n, n))
    f = np.fft.fft2(white)
    fx = np.fft.fftfreq(n)[:, None]
    fy = np.fft.fftfreq(n)[None, :]
    radius = np.sqrt(fx * fx + fy * fy)
    radius[0, 0] = 1.0
    f *= 1.0 / radius ** beta
    # No variation slower than `min_cycles` per tile: big blotches make the repeat obvious.
    f[radius * n < min_cycles] = 0
    f[0, 0] = 0
    out = np.real(np.fft.ifft2(f))
    lo, hi = np.percentile(out, 1), np.percentile(out, 99)
    return np.clip((out - lo) / (hi - lo), 0, 1)


class Canvas:
    def __init__(self, base_color, seed):
        self.img = Image.new("RGB", (W, W), tuple(int(v) for v in base_color))
        self.draw = ImageDraw.Draw(self.img, "RGBA")
        self.rng = random.Random(seed)

    def poly(self, pts, color, alpha=255):
        """Polygon with wrap-around (drawn again shifted wherever it crosses an edge)."""
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        fill = (int(color[0]), int(color[1]), int(color[2]), int(alpha))
        shifts_x = [0]
        shifts_y = [0]
        if min(xs) < 0:
            shifts_x.append(W)
        if max(xs) >= W:
            shifts_x.append(-W)
        if min(ys) < 0:
            shifts_y.append(W)
        if max(ys) >= W:
            shifts_y.append(-W)
        for sx in shifts_x:
            for sy in shifts_y:
                self.draw.polygon([(x + sx, y + sy) for x, y in pts], fill=fill)

    def stroke(self, x, y, length, width, angle, color, alpha=255, taper=0.55, bristle=True):
        """One flat brush mark: a slightly tapered lozenge with a ragged tail and a bristle line."""
        rng = self.rng
        ca, sa = math.cos(angle), math.sin(angle)
        half = length * 0.5
        pts_local = []
        steps = 5
        for i in range(steps + 1):
            t = i / steps
            w = width * 0.5 * (1.0 - (1.0 - taper) * t) * (0.55 + 0.45 * math.sin(math.pi * min(t * 2.2 + 0.2, 1.0)))
            pts_local.append((-half + length * t, -w * rng.uniform(0.85, 1.1)))
        tail = []
        for i in range(steps + 1):
            t = 1.0 - i / steps
            w = width * 0.5 * (1.0 - (1.0 - taper) * t) * (0.55 + 0.45 * math.sin(math.pi * min(t * 2.2 + 0.2, 1.0)))
            tail.append((-half + length * t + (rng.uniform(-0.04, 0.04) * length if i == 0 else 0), w * rng.uniform(0.85, 1.1)))
        pts = [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in pts_local + tail]
        self.poly(pts, color, alpha)
        if bristle and width > 10 * SS:
            # a lighter streak along the upper side, a darker one along the lower: paint ridges
            for side, shade in ((-0.28, 1.1), (0.3, 0.9)):
                c = np.clip(color * shade, 0, 255)
                w2 = width * 0.07
                l2 = length * rng.uniform(0.45, 0.8)
                ox = rng.uniform(-0.1, 0.1) * length
                oy = side * width
                p = [(-l2 / 2 + ox, oy - w2), (l2 / 2 + ox, oy - w2 * 0.4), (l2 / 2 + ox, oy + w2 * 0.4), (-l2 / 2 + ox, oy + w2)]
                self.poly([(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in p], c, alpha * 0.55)

    def line(self, pts, color, width, alpha=255):
        """Polyline of quads with wrap-around."""
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            dx, dy = x1 - x0, y1 - y0
            d = math.hypot(dx, dy) or 1.0
            nx, ny = -dy / d * width * 0.5, dx / d * width * 0.5
            self.poly([(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)], color, alpha)

    def finish(self, soften=0.6):
        img = self.img.filter(ImageFilter.GaussianBlur(soften * SS)) if soften > 0 else self.img
        return img.resize((SIZE, SIZE), Image.LANCZOS)


def sample(field, x, y):
    n = field.shape[0]
    return field[int(y / W * n) % n, int(x / W * n) % n]


def paint_layers(canvas, color_at, angle_at, layers):
    """layers: (count, (len lo, len hi), (width lo, width hi), alpha, value jitter)."""
    rng = canvas.rng
    for count, length, width, alpha, jitter in layers:
        for _ in range(count):
            x = rng.uniform(0, W)
            y = rng.uniform(0, W)
            c = color_at(x, y) * (1.0 + rng.uniform(-jitter, jitter))
            canvas.stroke(
                x, y, rng.uniform(*length) * SS, rng.uniform(*width) * SS, angle_at(x, y) + rng.uniform(-0.35, 0.35),
                np.clip(c, 0, 255), alpha,
            )


def painted_light(img, strength=0.16, seed=1, beta=2.4):
    """Paints soft light in: brighter, warmer where a low-frequency height field faces the upper
    left, cooler and darker on the far side. Periodic, so the tile stays seamless."""
    h = tile_noise(SIZE, beta, seed, 4.0)
    gx = np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)
    gy = np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)
    light = -(gx + gy)
    light = light / (np.percentile(np.abs(light), 98) + 1e-9)
    light = np.clip(light, -1, 1)[..., None]
    a = np.asarray(img).astype(np.float64)
    warm = np.array([1.0, 0.93, 0.8])
    cool = np.array([0.82, 0.86, 1.0])
    a = np.where(light > 0, a * (1 + strength * light) * lerp(np.ones(3), warm, light * 0.35),
                 a * (1 + strength * 0.9 * light) * lerp(np.ones(3), cool, -light * 0.35))
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))


def cracks(canvas, count, dark, light, length=(160, 420), width=3.0, wobble=0.55, angle=None):
    rng = canvas.rng
    for _ in range(count):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        a = rng.uniform(0, 2 * math.pi) if angle is None else angle + rng.uniform(-0.3, 0.3)
        pts = [(x, y)]
        total = rng.uniform(*length) * SS
        step = 26 * SS
        for _ in range(int(total / step)):
            a += rng.uniform(-wobble, wobble)
            x += math.cos(a) * step * rng.uniform(0.6, 1.2)
            y += math.sin(a) * step * rng.uniform(0.6, 1.2)
            pts.append((x, y))
        w = width * SS * rng.uniform(0.7, 1.4)
        # painted highlight on the lit lip (below-right of the dark line: light from upper left)
        canvas.line([(px + w * 0.9, py + w * 0.9) for px, py in pts], light, w * 0.9, 150)
        canvas.line(pts, dark, w, 235)


# --- The five tiles ----------------------------------------------------------------------------------


def make_stone(seed=11):
    big = tile_noise(256, 2.6, seed)
    mid = tile_noise(256, 1.8, seed + 1)
    flow = tile_noise(128, 3.0, seed + 2)
    stops = [(0.0, STONE_DEEP), (0.28, STONE), (0.55, STONE_MID), (0.8, STONE_LIGHT), (1.0, lerp(STONE_LIGHT, CREAM, 0.35))]

    def color_at(x, y):
        t = sample(big, x, y) * 0.7 + sample(mid, x, y) * 0.3
        c = ramp(stops, t)
        v = sample(mid, x + 300, y + 700)
        if v > 0.72:
            c = lerp(c, VIOLET, (v - 0.72) * 1.4)
        elif v < 0.2:
            c = lerp(c, WARM, (0.2 - v) * 1.6)
        return c

    def angle_at(x, y):
        return -0.6 + (sample(flow, x, y) - 0.5) * 2.4

    canvas = Canvas(STONE, seed)
    paint_layers(canvas, color_at, angle_at, [
        (900, (150, 260), (56, 96), 255, 0.05),
        (1300, (80, 150), (32, 54), 225, 0.08),
        (800, (44, 84), (18, 30), 180, 0.12),
    ])
    rng = canvas.rng
    # light dabs (painted highlights) and dark accents
    for _ in range(360):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        t = sample(big, x, y)
        if t > 0.5:
            canvas.stroke(x, y, rng.uniform(30, 64) * SS, rng.uniform(9, 16) * SS, angle_at(x, y), lerp(STONE_LIGHT, CREAM, rng.uniform(0.2, 0.7)), 120, bristle=False)
        else:
            canvas.stroke(x, y, rng.uniform(30, 64) * SS, rng.uniform(9, 16) * SS, angle_at(x, y), lerp(STONE_SHADOW, VIOLET, rng.uniform(0.0, 0.5)), 110, bristle=False)
    cracks(canvas, 11, STONE_SHADOW, lerp(STONE_LIGHT, CREAM, 0.5))
    return painted_light(canvas.finish(), 0.2, seed + 5)


def make_cliff(seed=23):
    """Layered cliff strata: long horizontal marks, ledges with lit lips."""
    wob = tile_noise(256, 2.8, seed)
    mid = tile_noise(256, 1.7, seed + 1)
    rng0 = random.Random(seed)
    # periodic band profile along v
    bands = []
    y = 0.0
    while y < 1.0:
        h = rng0.uniform(0.035, 0.12)
        bands.append((y, min(y + h, 1.0), rng0.uniform(0.0, 1.0)))
        y += h
    stops = [(0.0, STONE_DEEP), (0.3, STONE), (0.55, STONE_MID), (0.78, WARM), (1.0, lerp(STONE_LIGHT, LIT, 0.4))]

    def band_at(x, y):
        v = (y / W + (sample(wob, x, y) - 0.5) * 0.09) % 1.0
        for y0, y1, tone in bands:
            if y0 <= v < y1:
                return tone, (v - y0) / (y1 - y0)
        return bands[-1][2], 0.5

    def color_at(x, y):
        tone, inside = band_at(x, y)
        t = tone * 0.75 + sample(mid, x, y) * 0.25
        c = ramp(stops, t)
        # each band is lit along its top, shaded under the ledge above
        return c * (1.12 - 0.26 * inside)

    def angle_at(x, y):
        return (sample(wob, x + 100, y) - 0.5) * 0.5

    canvas = Canvas(STONE, seed)
    paint_layers(canvas, color_at, angle_at, [
        (1100, (160, 300), (30, 56), 255, 0.05),
        (1700, (90, 170), (16, 28), 220, 0.08),
        (1500, (40, 90), (8, 14), 170, 0.12),
    ])
    rng = canvas.rng
    # ledge lines: dark crevice under each band boundary, cream lip above it
    for y0, _, _ in bands:
        x = 0.0
        pts_dark = []
        while x <= W + 40 * SS:
            yy = (y0 - (sample(wob, x % W, (y0 * W) % W) - 0.5) * 0.09) * W
            pts_dark.append((x, yy + rng.uniform(-2, 2) * SS))
            x += 40 * SS
        # break the line into dashes so it looks painted, not ruled
        i = 0
        while i < len(pts_dark) - 1:
            run = rng.randint(2, 6)
            seg = pts_dark[i:i + run + 1]
            if len(seg) >= 2 and rng.random() < 0.82:
                w = rng.uniform(2.5, 5.0) * SS
                canvas.line([(px, py - w) for px, py in seg], lerp(LIT, CREAM, rng.uniform(0.2, 0.7)), w * 0.9, 150)
                canvas.line(seg, STONE_SHADOW, w, 230)
            i += run
    cracks(canvas, 10, STONE_SHADOW, lerp(STONE_LIGHT, CREAM, 0.5), length=(60, 150), angle=math.pi / 2, wobble=0.35)
    return painted_light(canvas.finish(), 0.14, seed + 5)


def make_moss(seed=37):
    big = tile_noise(256, 2.4, seed)
    mid = tile_noise(256, 1.5, seed + 1)
    flow = tile_noise(128, 2.6, seed + 2)
    stops = [(0.0, MOSS_DARK), (0.3, MOSS_DEEP), (0.6, MOSS), (0.85, lerp(MOSS, MOSS_LIGHT, 0.6)), (1.0, MOSS_LIGHT)]

    def color_at(x, y):
        return ramp(stops, sample(big, x, y) * 0.65 + sample(mid, x, y) * 0.35)

    def angle_at(x, y):
        return (sample(flow, x, y) - 0.5) * 6.0

    canvas = Canvas(MOSS_DEEP, seed)
    paint_layers(canvas, color_at, angle_at, [
        (1000, (90, 150), (50, 80), 255, 0.06),
        (2200, (40, 80), (22, 38), 220, 0.1),
    ])
    rng = canvas.rng
    # clumps: short fat dabs, dark underneath, light on top (lit from the upper left)
    for _ in range(2600):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        t = sample(big, x, y)
        s = rng.uniform(9, 20) * SS
        a = angle_at(x, y)
        canvas.stroke(x + s * 0.25, y + s * 0.25, s * 1.5, s, a, lerp(MOSS_DARK, MOSS_DEEP, rng.uniform(0, 0.6)), 150, taper=0.8, bristle=False)
        canvas.stroke(x, y, s * 1.5, s, a, np.clip(color_at(x, y) * rng.uniform(1.0, 1.2), 0, 255), 235, taper=0.8, bristle=False)
        if t > 0.42 and rng.random() < 0.6:
            canvas.stroke(x - s * 0.22, y - s * 0.22, s * 0.8, s * 0.42, a, lerp(MOSS_LIGHT, MOSS_SUN, rng.uniform(0, 0.8)), 200, taper=0.8, bristle=False)
    for _ in range(260):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        canvas.stroke(x, y, rng.uniform(5, 9) * SS, rng.uniform(4, 7) * SS, rng.uniform(0, 6.28), lerp(MOSS_SUN, CREAM, rng.uniform(0.2, 0.7)), 190, taper=0.9, bristle=False)
    return painted_light(canvas.finish(0.5), 0.16, seed + 5)


def make_masonry(seed=41):
    """Ruin masonry: irregular courses of worn blocks, dark joints, lit top edges, a little moss."""
    rng0 = random.Random(seed)
    mid = tile_noise(256, 1.8, seed + 1)
    canvas = Canvas(STONE_SHADOW, seed)
    rng = canvas.rng
    rows = []
    y = 0
    heights = [150, 118, 170, 132, 156, 124, 174]
    scale = SIZE / sum(heights)
    heights = [h * scale * SS for h in heights]
    block_stops = [(0.0, STONE), (0.4, STONE_MID), (0.7, WARM), (1.0, lerp(STONE_LIGHT, LIT, 0.45))]
    joint = 7 * SS
    for h in heights:
        x = rng0.uniform(0, 200) * SS
        start = x
        while x < start + W - 1:
            w = rng0.uniform(150, 330) * SS
            if start + W - (x + w) < 120 * SS:
                w = start + W - x
            rows.append((x, y, w, h, rng0.random()))
            x += w
        y += h
    for bx, by, bw, bh, tone in rows:
        x0, y0, x1, y1 = bx + joint * 0.5, by + joint * 0.5, bx + bw - joint * 0.5, by + bh - joint * 0.5
        chip = rng.uniform(8, 26) * SS
        corners = [(x0 + (chip if rng.random() < 0.35 else 4 * SS), y0), (x1 - (chip if rng.random() < 0.3 else 4 * SS), y0),
                   (x1, y0 + 6 * SS), (x1, y1 - (chip if rng.random() < 0.3 else 5 * SS)),
                   (x1 - 6 * SS, y1), (x0 + (chip if rng.random() < 0.25 else 5 * SS), y1), (x0, y1 - 6 * SS), (x0, y0 + 8 * SS)]
        base = ramp(block_stops, tone * 0.8 + 0.1)
        canvas.poly(corners, base)
        # strokes inside the block
        n = int(bw * bh / (SS * SS) / 1400)
        for _ in range(n):
            px = rng.uniform(x0 + 22 * SS, x1 - 22 * SS)
            py = rng.uniform(y0 + 14 * SS, y1 - 14 * SS)
            t = tone * 0.6 + sample(mid, px, py) * 0.4 + rng.uniform(-0.12, 0.12)
            length = min(rng.uniform(50, 120) * SS, (x1 - x0) * 0.6)
            canvas.stroke(px, py, length, rng.uniform(14, 26) * SS, rng.uniform(-0.25, 0.25), ramp(block_stops, t), 215)
        # lit top and left edge, shaded bottom and right edge
        canvas.line([(x0 + 10 * SS, y0 + 5 * SS), (x1 - 10 * SS, y0 + 5 * SS)], lerp(LIT, CREAM, 0.5), 6 * SS, 170)
        canvas.line([(x0 + 5 * SS, y0 + 10 * SS), (x0 + 5 * SS, y1 - 10 * SS)], lerp(STONE_LIGHT, LIT, 0.5), 5 * SS, 130)
        canvas.line([(x0 + 10 * SS, y1 - 5 * SS), (x1 - 8 * SS, y1 - 5 * SS)], STONE_DEEP, 7 * SS, 170)
        canvas.line([(x1 - 5 * SS, y0 + 10 * SS), (x1 - 5 * SS, y1 - 10 * SS)], STONE_DEEP, 5 * SS, 130)
        if rng.random() < 0.3:
            cx, cy = rng.uniform(x0, x1), rng.uniform(y0 + bh * 0.2, y1 - bh * 0.2)
            pts = [(cx, cy)]
            a = rng.uniform(0, 6.28)
            for _ in range(rng.randint(2, 5)):
                a += rng.uniform(-0.6, 0.6)
                cx += math.cos(a) * 22 * SS
                cy += math.sin(a) * 22 * SS
                pts.append((min(max(cx, x0), x1), min(max(cy, y0), y1)))
            canvas.line([(px + 2 * SS, py + 2 * SS) for px, py in pts], lerp(STONE_LIGHT, CREAM, 0.4), 2.5 * SS, 140)
            canvas.line(pts, STONE_SHADOW, 3 * SS, 220)
    # moss creeping in the joints
    for bx, by, bw, bh, tone in rows:
        if tone < 0.45:
            for _ in range(rng.randint(2, 7)):
                px = bx + rng.uniform(0, bw)
                py = by + rng.uniform(-8, 10) * SS
                s = rng.uniform(8, 18) * SS
                canvas.stroke(px, py, s * 1.6, s, rng.uniform(-0.4, 0.4), lerp(MOSS_DEEP, MOSS, rng.uniform(0, 1)), 220, taper=0.8, bristle=False)
                if rng.random() < 0.5:
                    canvas.stroke(px - s * 0.2, py - s * 0.25, s * 0.8, s * 0.4, 0, lerp(MOSS, MOSS_LIGHT, rng.uniform(0.3, 1)), 200, taper=0.8, bristle=False)
    return painted_light(canvas.finish(), 0.1, seed + 5)


def make_brush(seed=53):
    """Greyscale brush-stroke detail map, mean about 0.5: multiply by 2 (or overlay) on anything."""
    big = tile_noise(256, 2.2, seed)
    flow = tile_noise(128, 3.0, seed + 2)

    def color_at(x, y):
        v = 96 + sample(big, x, y) * 64
        return np.array([v, v, v])

    def angle_at(x, y):
        return -0.5 + (sample(flow, x, y) - 0.5) * 3.0

    canvas = Canvas(np.array([128, 128, 128]), seed)
    paint_layers(canvas, color_at, angle_at, [
        (900, (140, 240), (50, 84), 255, 0.1),
        (1500, (70, 140), (28, 46), 215, 0.14),
        (900, (36, 76), (14, 24), 170, 0.18),
    ])
    img = canvas.finish(0.5)
    a = np.asarray(img).astype(np.float64)[..., 0]
    grain = (tile_noise(SIZE, 0.6, seed + 9) - 0.5) * 14
    a = a + grain
    a = (a - a.mean()) * 1.15 + 127.5
    g = np.clip(a, 0, 255).astype(np.uint8)
    return Image.fromarray(np.stack([g, g, g], axis=-1))


# --- Emberfall Caldera (T-6.4): three more tiles, same brush language, dusk-basalt palette -----------
#
# Additive: nothing above this line changed, every tile has its own seeds, so the five Shattered
# Spires tiles come out byte-identical. Build only these with
#   python tools/textures/make_textures.py --set caldera

BASALT_SHADOW = rgb(0x16141E)
BASALT_DEEP = rgb(0x24222E)
BASALT = rgb(0x3A3848)
BASALT_MID = rgb(0x4C4A5E)
BASALT_LIGHT = rgb(0x6C6A82)
BASALT_WARM = rgb(0x6A5560)
BASALT_VIOLET = rgb(0x40304E)
DUSK_LIT = rgb(0xB08A90)
ASH_DARK = rgb(0x403C46)
ASH_DEEP = rgb(0x5C585E)
ASH = rgb(0x8A8588)
ASH_LIGHT = rgb(0xB8B0AC)
ASH_PALE = rgb(0xD8C4BC)


def make_basalt(seed=61):
    """Dark vesicular basalt: blocky strokes, pale ash dabs, gas-bubble pits, fine cracks."""
    big = tile_noise(256, 2.6, seed)
    mid = tile_noise(256, 1.8, seed + 1)
    flow = tile_noise(128, 3.0, seed + 2)
    stops = [(0.0, lerp(BASALT_DEEP, BASALT, 0.55)), (0.3, BASALT), (0.58, BASALT_MID), (0.84, lerp(BASALT_MID, BASALT_LIGHT, 0.55)), (1.0, BASALT_LIGHT)]

    def color_at(x, y):
        t = sample(big, x, y) * 0.45 + sample(mid, x, y) * 0.55
        c = ramp(stops, t)
        v = sample(mid, x + 300, y + 700)
        if v > 0.72:
            c = lerp(c, BASALT_VIOLET, (v - 0.72) * 1.5)
        elif v < 0.2:
            c = lerp(c, BASALT_WARM, (0.2 - v) * 1.8)
        return c

    def angle_at(x, y):
        # blockier than the slate: strokes snap toward two directions
        a = (sample(flow, x, y) - 0.5) * 2.0
        return (0.25 if a > 0 else -1.2) + a * 0.5

    canvas = Canvas(BASALT, seed)
    paint_layers(canvas, color_at, angle_at, [
        (900, (130, 230), (60, 100), 255, 0.05),
        (1300, (70, 140), (34, 56), 225, 0.08),
        (900, (40, 80), (18, 30), 180, 0.12),
    ])
    rng = canvas.rng
    for _ in range(320):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        t = sample(big, x, y)
        if t > 0.52:
            canvas.stroke(x, y, rng.uniform(28, 60) * SS, rng.uniform(8, 15) * SS, angle_at(x, y), lerp(BASALT_LIGHT, ASH_PALE, rng.uniform(0.2, 0.7)), 115, bristle=False)
        else:
            canvas.stroke(x, y, rng.uniform(28, 60) * SS, rng.uniform(8, 15) * SS, angle_at(x, y), lerp(BASALT_DEEP, BASALT_VIOLET, rng.uniform(0.0, 0.6)), 100, bristle=False)
    # vesicles: small dark pits with a lit lower-right lip (light from the upper left)
    for _ in range(1500):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        if sample(mid, x + 90, y + 40) < 0.45:
            continue
        s = rng.uniform(3.0, 8.0) * SS
        a = rng.uniform(0, 6.28)
        canvas.stroke(x + s * 0.35, y + s * 0.35, s * 1.5, s * 1.1, a, lerp(BASALT_LIGHT, ASH_LIGHT, rng.uniform(0.1, 0.6)), 130, taper=0.9, bristle=False)
        canvas.stroke(x, y, s * 1.5, s * 1.1, a, lerp(BASALT_SHADOW, BASALT_DEEP, rng.uniform(0, 0.7)), 225, taper=0.9, bristle=False)
    cracks(canvas, 14, BASALT_SHADOW, lerp(BASALT_LIGHT, ASH_PALE, 0.4), length=(120, 360), width=2.6, wobble=0.75)
    return painted_light(canvas.finish(), 0.2, seed + 5)


def make_columnar(seed=73):
    """Columnar basalt for steep faces: upright columns of unequal width (U), broken by short
    cooling joints across them; V runs along world up."""
    wob = tile_noise(256, 2.8, seed)
    mid = tile_noise(256, 1.7, seed + 1)
    rng0 = random.Random(seed)
    cols = []
    x = 0.0
    while x < 1.0:
        w = rng0.uniform(0.045, 0.11)
        cols.append((x, min(x + w, 1.0), rng0.uniform(0.0, 1.0)))
        x += w
    stops = [(0.0, BASALT_DEEP), (0.32, BASALT), (0.58, BASALT_MID), (0.8, lerp(BASALT_MID, BASALT_WARM, 0.45)), (1.0, lerp(BASALT_LIGHT, DUSK_LIT, 0.15))]

    def col_at(x, y):
        u = (x / W + (sample(wob, x, y) - 0.5) * 0.035) % 1.0
        for x0, x1, tone in cols:
            if x0 <= u < x1:
                return tone, (u - x0) / (x1 - x0)
        return cols[-1][2], 0.5

    def color_at(x, y):
        tone, inside = col_at(x, y)
        t = tone * 0.72 + sample(mid, x, y) * 0.28
        # every column is a faceted prism: lit on its left flank, shaded on its right
        return ramp(stops, t) * (1.14 - 0.3 * inside)

    def angle_at(x, y):
        return math.pi / 2 + (sample(wob, x, y + 100) - 0.5) * 0.3

    canvas = Canvas(BASALT, seed)
    paint_layers(canvas, color_at, angle_at, [
        (1100, (160, 300), (30, 54), 255, 0.05),
        (1700, (90, 170), (16, 28), 220, 0.08),
        (1400, (40, 90), (8, 14), 170, 0.12),
    ])
    rng = canvas.rng
    # joints between columns: a dark seam with a pale lip on its lit (right-hand) side
    for x0, _, _ in cols:
        y = 0.0
        pts = []
        while y <= W + 40 * SS:
            xx = (x0 - (sample(wob, (x0 * W) % W, y % W) - 0.5) * 0.035) * W
            pts.append((xx + rng.uniform(-2, 2) * SS, y))
            y += 40 * SS
        i = 0
        while i < len(pts) - 1:
            run = rng.randint(3, 8)
            seg = pts[i:i + run + 1]
            if len(seg) >= 2 and rng.random() < 0.9:
                w = rng.uniform(3.0, 5.5) * SS
                canvas.line([(px + w, py) for px, py in seg], lerp(BASALT_LIGHT, ASH_PALE, rng.uniform(0.2, 0.6)), w * 0.9, 140)
                canvas.line(seg, BASALT_SHADOW, w, 235)
            i += run
    # cooling joints: short level breaks, each inside one column
    for x0, x1, _ in cols:
        for _ in range(rng.randint(3, 7)):
            y = rng.uniform(0, W)
            xa = (x0 + 0.006) * W
            xb = (x1 - 0.006) * W
            w = rng.uniform(2.0, 3.6) * SS
            dy = rng.uniform(-6, 6) * SS
            canvas.line([(xa, y + w), (xb, y + dy + w)], lerp(BASALT_LIGHT, ASH_PALE, 0.45), w * 0.9, 130)
            canvas.line([(xa, y), (xb, y + dy)], BASALT_SHADOW, w, 215)
    return painted_light(canvas.finish(), 0.14, seed + 5)


def make_ash(seed=89):
    """Settled volcanic ash: soft grey drifts, wind ripples, a scatter of dark cinders."""
    big = tile_noise(256, 2.6, seed)
    mid = tile_noise(256, 1.6, seed + 1)
    flow = tile_noise(128, 3.2, seed + 2)
    stops = [(0.0, ASH_DARK), (0.28, ASH_DEEP), (0.6, ASH), (0.86, ASH_LIGHT), (1.0, ASH_PALE)]

    def color_at(x, y):
        return ramp(stops, sample(big, x, y) * 0.7 + sample(mid, x, y) * 0.3)

    def angle_at(x, y):
        return 0.35 + (sample(flow, x, y) - 0.5) * 1.6

    canvas = Canvas(ASH_DEEP, seed)
    paint_layers(canvas, color_at, angle_at, [
        (900, (150, 260), (60, 96), 255, 0.04),
        (1500, (90, 160), (30, 50), 215, 0.07),
    ])
    rng = canvas.rng
    # wind ripples: long thin pairs, pale crest over a darker trough
    for _ in range(620):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        a = angle_at(x, y) + rng.uniform(-0.1, 0.1)
        length = rng.uniform(110, 240) * SS
        w = rng.uniform(7.0, 14.0) * SS
        ox, oy = -math.sin(a) * w * 0.9, math.cos(a) * w * 0.9
        canvas.stroke(x + ox, y + oy, length, w, a, lerp(ASH_DEEP, ASH, rng.uniform(0.0, 0.6)), 100, taper=0.7, bristle=False)
        canvas.stroke(x, y, length, w, a, lerp(ASH_LIGHT, ASH_PALE, rng.uniform(0.0, 0.7)), 115, taper=0.7, bristle=False)
    # cinders
    for _ in range(380):
        x, y = rng.uniform(0, W), rng.uniform(0, W)
        s = rng.uniform(3.5, 9.0) * SS
        a = rng.uniform(0, 6.28)
        canvas.stroke(x - s * 0.3, y - s * 0.3, s * 1.3, s, a, lerp(ASH_LIGHT, ASH_PALE, rng.uniform(0.3, 1.0)), 150, taper=0.85, bristle=False)
        canvas.stroke(x, y, s * 1.3, s, a, lerp(BASALT_SHADOW, BASALT, rng.uniform(0.0, 0.8)), 230, taper=0.85, bristle=False)
    return painted_light(canvas.finish(0.5), 0.15, seed + 5)


TILES = {
    "stone": make_stone,
    "cliff": make_cliff,
    "moss": make_moss,
    "masonry": make_masonry,
    "brush": make_brush,
    "basalt": make_basalt,
    "columnar": make_columnar,
    "ash": make_ash,
}

# `--set <name>` builds one map's tiles; with no arguments every tile is built.
SETS = {
    "spires": ["stone", "cliff", "moss", "masonry", "brush"],
    "caldera": ["basalt", "columnar", "ash"],
}


def linear_mean(img):
    a = np.asarray(img).astype(np.float64) / 255.0
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return [round(float(v), 4) for v in lin.reshape(-1, 3).mean(axis=0)]


def seam_error(img):
    """Mean absolute step across the wrap seam relative to the mean step inside the tile."""
    a = np.asarray(img).astype(np.float64)
    inner = np.abs(a[:, 1:] - a[:, :-1]).mean()
    seam = np.abs(a[:, 0] - a[:, -1]).mean()
    inner_v = np.abs(a[1:] - a[:-1]).mean()
    seam_v = np.abs(a[0] - a[-1]).mean()
    return round(float(seam / inner), 2), round(float(seam_v / inner_v), 2)


def main():
    names = []
    argv = sys.argv[1:]
    while argv:
        arg = argv.pop(0)
        if arg == "--set":
            names.extend(SETS[argv.pop(0)])
        else:
            names.append(arg)
    names = names or list(TILES)
    os.makedirs(OUT, exist_ok=True)
    means_path = os.path.join(OUT, "means.json")
    means = {}
    if os.path.exists(means_path):
        with open(means_path) as fh:
            means = json.load(fh)
    for name in names:
        img = TILES[name]()
        img.save(os.path.join(OUT, name + ".png"), optimize=True)
        means[name] = linear_mean(img)
        print(name, "mean(linear)", means[name], "seam ratio (h, v)", seam_error(img))
    with open(means_path, "w") as fh:
        json.dump(means, fh, indent=2)
        fh.write("\n")


if __name__ == "__main__":
    main()
