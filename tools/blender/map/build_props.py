"""Builds the Shattered Spires props, the aerie gate and the backdrop silhouettes (T-4.5).

  blender -b -P tools/blender/map/build_props.py -- [--only id,id] [--preview]

Output: art-source/maps/props/<id>.glb (LOD0, LOD1 nodes), art-source/maps/hulls/<id>.json,
art-source/maps/props.blend, previews under art-source/_scratch/props/.

Materials: "Stone" (painted vertex colour; `_MASKS.a` marks emissive faces: crystals, runes,
flames) and, where present, "TeamTint" (near-white, the renderer multiplies the team colour).
Axes: glTF +Z (Blender -Y) is the "front" of a prop; the gate launches toward it.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import importlib

import preview
import rocklib

importlib.reload(rocklib)
from rocklib import (
    EMBER_GLOW,
    FLOAT_PROFILE,
    K_DARK,
    K_GLOW,
    K_MASON,
    K_STONE,
    K_TINT,
    MAGENTA,
    MAGENTA_DEEP,
    MAGENTA_HOT,
    SPIKE_PROFILE,
    Piece,
    add_box,
    add_moss_cap,
    add_prism,
    add_quad,
    add_shard,
    add_tube,
    lin,
    mix,
    rot,
    xf,
)

REPO = preview.REPO
OUT_GLB = os.path.join(REPO, "art-source", "maps", "props")
OUT_HULL = os.path.join(REPO, "art-source", "maps", "hulls")
SCRATCH = os.path.join(REPO, "art-source", "_scratch", "props")
RUNE = lin(0xFF8FC8)
FLAME = lin(0xFF8A2A)
FLAME_HOT = lin(0xFFD070)


def lean_xf(loc, az=0.0, tilt=0.0, spin=0.0):
    return Matrix.Translation(Vector(loc)) @ rot(rz=az) @ rot(ry=tilt) @ rot(rz=spin)


def polar(r, a_deg, z=0.0):
    a = math.radians(a_deg)
    return (math.cos(a) * r, math.sin(a) * r, z)


def crystal(p, loc, size, az=0.0, tilt=0.0, color=None, collide=False):
    r = p.rng
    bm, hull = rocklib.make_shard(
        r, radius=size * 0.3, height=size * 2.0, sides=6, irregular=0.08, rings=2, cuts=0, top="none",
        bevel=0.0, poke=0.0, profile=[(0.0, 0.75), (0.74, 1.0), (1.0, 0.04)], ring_jitter=0.0, hull_tris=10,
    )
    layer = bm.faces.layers.int["kind"]
    for f in bm.faces:
        f[layer] = K_GLOW
    c = color if color is not None else mix(MAGENTA_DEEP, MAGENTA, r.uniform(0.55, 1.0))
    p.add_bmesh(bm, lean_xf(loc, az, tilt, r.uniform(0, 360)), hull if collide else None, color=c, solid=False)
    bm.free()


def rune(p, centre, normal_az, width, height, color=RUNE):
    """A glowing glyph: three short bars on a vertical face looking toward normal_az."""
    a = math.radians(normal_az)
    n = Vector((math.cos(a), math.sin(a), 0))
    t = Vector((-math.sin(a), math.cos(a), 0))
    c = Vector(centre) + n * 0.06
    bars = [(-0.3, 0.38, 0.6, 0.1), (0.0, 0.0, 0.14, 0.9), (0.26, -0.3, 0.5, 0.1), (-0.24, -0.1, 0.1, 0.4)]
    for bx, bz, bw, bh in bars:
        o = c + t * (bx * width) + Vector((0, 0, bz * height))
        hw, hh = bw * width * 0.5, bh * height * 0.5
        add_quad(p, [o - t * hw - Vector((0, 0, hh)), o + t * hw - Vector((0, 0, hh)),
                     o + t * hw + Vector((0, 0, hh)), o - t * hw + Vector((0, 0, hh))], kind=K_GLOW, color=color, double=False)


def flame(p, loc, size):
    for i, (s, c) in enumerate(((1.0, FLAME), (0.6, FLAME_HOT))):
        bm, _ = rocklib.make_shard(p.rng, radius=size * 0.42 * s, height=size * 1.5 * s, sides=5, irregular=0.2, rings=2,
                                   cuts=0, top="none", bevel=0.0, poke=0.0,
                                   profile=[(0.0, 0.5), (0.3, 1.0), (1.0, 0.03)], lean=(size * 0.12, 0), hull_tris=8)
        layer = bm.faces.layers.int["kind"]
        for f in bm.faces:
            f[layer] = K_GLOW
        p.add_bmesh(bm, xf((loc[0], loc[1], loc[2] + i * size * 0.1), rz=p.rng.uniform(0, 360)), None, color=c, solid=False)
        bm.free()


def drum(p, loc, radius, height, rx=0.0, ry=0.0, rz=0.0, collide=True, sides=10):
    add_prism(p, xf(loc, rx, ry, rz), radius, height, sides=sides, kind=K_MASON, bevel=radius * 0.08, collide=collide)


# --- Recipes --------------------------------------------------------------------------------------


def column_ruined(p):
    r = p.rng
    add_box(p, xf((0, 0, 0)), (6.4, 6.4, 1.6), kind=K_MASON, bevel=0.25, jitter=0.02)
    add_prism(p, xf((0, 0, 1.6)), 2.7, 1.0, sides=10, kind=K_MASON, bevel=0.2, collide=False)
    z = 2.6
    for i in range(4):
        h = r.uniform(3.4, 4.4)
        drum(p, (r.uniform(-0.12, 0.12), r.uniform(-0.12, 0.12), z), 2.15 - i * 0.06, h, rz=r.uniform(0, 36), collide=(i == 0))
        z += h
    # one hull for the whole shaft
    p.hulls.append(rocklib.convex_hull_of([Vector((math.cos(a) * 2.3, math.sin(a) * 2.3, zz)) for a in (0, 1.05, 2.1, 3.14, 4.19, 5.24) for zz in (0, z)]))
    # broken capital
    add_shard(p, xf((0.2, 0, z)), radius=3.1, height=2.2, sides=8, irregular=0.12, rings=1, cuts=2, top="slant",
              top_tilt=(16, 30), bevel=0.06, chips=2, poke=0, kind=K_MASON, collide=False, profile=[(0, 0.75), (1, 1.0)])
    p.meta["kind"] = "prop"


def column_broken(p):
    r = p.rng
    add_box(p, xf((0, 0, 0)), (6.4, 6.4, 1.6), kind=K_MASON, bevel=0.25, jitter=0.02)
    drum(p, (0, 0, 1.6), 2.15, 3.6)
    add_shard(p, xf((0, 0, 5.2)), radius=2.15, height=2.6, sides=10, irregular=0.04, rings=1, cuts=1, top="slant",
              top_tilt=(28, 42), bevel=0.05, chips=1, poke=0, kind=K_MASON, collide=False, taper=1.0)
    # fallen drums
    drum(p, (6.5, 1.5, 2.0), 2.05, 4.2, rx=90, rz=24)
    drum(p, (9.5, -4.2, 2.0), 2.0, 3.4, rx=90, rz=-38)
    drum(p, (-5.6, -3.4, 0.0), 2.0, 1.9, rx=8, rz=10, collide=False)
    p.meta["kind"] = "prop"


def wall_fragment(p):
    r = p.rng
    heights = (11.0, 13.5, 9.0, 6.0, 3.2)
    x = -11.0
    for i, h in enumerate(heights):
        w = 4.6
        z = 0.0
        while z < h - 0.1:
            bh = min(r.uniform(1.5, 2.2), h - z)
            off = r.uniform(-0.5, 0.5)
            add_box(p, xf((x + off * 0.3, r.uniform(-0.1, 0.1), z)), (w + r.uniform(-0.2, 0.5), 2.4, bh), kind=K_MASON,
                    bevel=0.16, jitter=0.012, collide=False)
            z += bh
        hull = rocklib.convex_hull_of([Vector((x + sx * w * 0.5, sy * 1.2, zz)) for sx in (-1, 1) for sy in (-1, 1) for zz in (0, h)])
        p.hulls.append(hull)
        x += w
    # buttress and rubble
    add_box(p, xf((-12.5, 0, 0), rz=4), (2.6, 4.2, 6.5), kind=K_MASON, bevel=0.2, jitter=0.02)
    for i in range(4):
        add_shard(p, xf((r.uniform(4, 13), r.uniform(-4, 4), -0.3), rz=r.uniform(0, 360), rx=r.uniform(-20, 20)), radius=r.uniform(0.9, 1.6),
                  height=r.uniform(1.2, 2.2), sides=5, rings=1, cuts=2, bevel=0.1, chips=0, poke=0, kind=K_MASON, collide=False)
    add_moss_cap(p, xf((-8.6, 0, 11.0)), [(-2.2, -1.1), (2.2, -1.1), (2.2, 1.1), (-2.2, 1.1)], lift=0.5, rings=1, rim_drop=0.2)
    p.meta["kind"] = "prop"


def bridge_span(p):
    """A broken bridge: deck from x = -24 to +14, arched underneath, the far end sheared off."""
    r = p.rng
    for i, x in enumerate(range(-24, 14, 6)):
        sag = -0.02 * (x + 4) ** 2 * 0.15
        thick = 2.2 + 0.012 * (x + 4) ** 2
        add_box(p, xf((x + 3, 0, sag - thick + 2.2), ry=r.uniform(-1.2, 1.2)), (6.3, 8.0, thick), kind=K_MASON, bevel=0.22,
                jitter=0.012)
        if i % 2 == 0:
            for side in (-1, 1):
                add_box(p, xf((x + 3, side * 3.5, sag + 2.2)), (1.3, 1.0, r.uniform(1.4, 2.6)), kind=K_MASON, bevel=0.14,
                        jitter=0.03, collide=False)
    # abutment pier at the standing end, pointing down like a root
    add_shard(p, xf((-22, 0, 0.5)), flip=True, radius=5.5, height=20, sides=6, profile=SPIKE_PROFILE, rings=2, cuts=2,
              bevel=0.07, chips=2, poke=0, kind=K_MASON, hull_tris=10)
    # sheared end: loose blocks drifting off
    for i in range(4):
        add_box(p, xf((16 + i * 3.6, r.uniform(-2.5, 2.5), r.uniform(-3.0, 1.5)), rx=r.uniform(-30, 30), ry=r.uniform(-30, 30),
                      rz=r.uniform(0, 90)), (r.uniform(1.8, 3.2), r.uniform(1.8, 3.0), r.uniform(1.2, 2.0)), kind=K_MASON,
                bevel=0.16, jitter=0.03, collide=False)
    p.meta["kind"] = "prop"


def stairs(p):
    steps = 9
    for i in range(steps):
        add_box(p, xf((0, -i * 1.5, 0)), (9.0 - (0.25 if i % 3 == 2 else 0), 1.6, (i + 1) * 0.75), kind=K_MASON, bevel=0.12,
                jitter=0.012, collide=False)
    profile = ((0.8, 0), (0.8, 0.75), (-steps * 1.5 + 0.8, steps * 0.75), (-steps * 1.5 + 0.8, 0))
    p.hulls.append(rocklib.convex_hull_of([Vector((sx * 4.5, yy, zz)) for sx in (-1, 1) for (yy, zz) in profile]))
    for side in (-1, 1):
        add_box(p, xf((side * 5.2, -6.0, 0), rx=0), (1.4, 14.0, 1.2), kind=K_MASON, bevel=0.14, collide=False)
        add_box(p, xf((side * 5.2, -12.6, 0)), (1.8, 1.8, 9.4), kind=K_MASON, bevel=0.18, jitter=0.02)
    p.meta["kind"] = "prop"


def standing_stone(p):
    add_shard(p, lean_xf((0, 0, -0.8), 20, 5, 0), radius=2.6, height=11.5, sides=4, irregular=0.1, taper=0.7, rings=2,
              cuts=2, cut_depth=(0.85, 0.98), top="slant", top_tilt=(18, 34), squash=0.55, bevel=0.07, chips=3, poke=0,
              hull_tris=12)
    for az, z in ((-90, 6.6), (90, 5.6)):
        rune(p, (0.35 if az < 0 else 0.3, -1.38 if az < 0 else 1.36, z), az, 2.4, 3.2)
    for i in range(3):
        add_shard(p, xf(polar(3.0, 40 + i * 120, -0.3), rz=i * 77), radius=p.rng.uniform(0.9, 1.4), height=p.rng.uniform(1.0, 1.8),
                  sides=5, rings=1, cuts=2, bevel=0.1, chips=0, poke=0, collide=False)
    p.meta["kind"] = "prop"


def crystal_cluster(p):
    r = p.rng
    add_shard(p, xf((0, 0, -1.2)), radius=4.2, height=2.6, sides=7, taper=0.7, rings=1, cuts=3, bevel=0.07, chips=3, poke=0,
              hull_tris=12)
    crystal(p, (0, 0, 0.6), 4.6, 0, 6, collide=True)
    for i in range(5):
        a = i * 72 + r.uniform(-20, 20)
        crystal(p, polar(r.uniform(1.4, 2.6), a, 0.6), r.uniform(1.6, 3.0), a, r.uniform(18, 42))
    p.meta["kind"] = "prop"


def crystal_core(p):
    """The sky-well: a great floating crystal with satellites. Origin at its centre."""
    r = p.rng
    for flip, s in ((False, 1.0), (True, 0.62)):
        bm, hull = rocklib.make_shard(r, radius=9.0, height=30 * s, sides=6, irregular=0.08, rings=2, cuts=0, top="none",
                                      bevel=0.0, poke=0.0, profile=[(0.0, 1.0), (0.2, 0.96), (1.0, 0.03)], ring_jitter=0.0,
                                      hull_tris=10)
        layer = bm.faces.layers.int["kind"]
        for f in bm.faces:
            f[layer] = K_GLOW
        m = xf((0, 0, 0)) @ (Matrix.Diagonal(Vector((1, -1, -1, 1))) if flip else Matrix.Identity(4))
        p.add_bmesh(bm, m, hull, color=MAGENTA, solid=False)
        bm.free()
    for i in range(6):
        a = i * 60 + r.uniform(-12, 12)
        z = r.uniform(-12, 14)
        crystal(p, polar(r.uniform(15, 21), a, z - 5), r.uniform(3.4, 5.6), a, r.uniform(-12, 14))
    # shattered stone cradle orbiting below
    for i in range(5):
        a = i * 72 + 20
        add_shard(p, lean_xf(polar(13, a, -26), a, -24, r.uniform(0, 360)), radius=r.uniform(3.4, 5.0), height=r.uniform(10, 15),
                  sides=5, profile=FLOAT_PROFILE, rings=2, cuts=2, bevel=0.08, chips=2, poke=0, hull_tris=8)
    p.meta["kind"] = "prop"


def banner_tall(p):
    add_box(p, xf((0, 0, 0)), (2.2, 2.2, 1.0), kind=K_MASON, bevel=0.14, collide=False)
    add_tube(p, [(0, 0, 1.0), (0, 0, 9.0), (0.1, 0, 17.0)], 0.32, sides=6, kind=K_DARK, taper=0.6)
    add_tube(p, [(0, 0, 16.0), (0, -3.4, 16.3)], 0.2, sides=5, kind=K_DARK, taper=0.8)
    # cloth: three panels with a swallow tail, hanging in the wind
    xs = (0.05, 0.3, 0.55, 0.45, 0.2)
    zs = (16.0, 13.0, 10.0, 7.0, 4.6)
    for i in range(4):
        add_quad(p, [(xs[i], -0.35, zs[i]), (xs[i], -3.25, zs[i]), (xs[i + 1], -3.25, zs[i + 1]), (xs[i + 1], -0.35, zs[i + 1])],
                 kind=K_TINT)
    for y0, y1, ym in ((-0.35, -1.8, -0.9), (-1.8, -3.25, -2.7)):
        add_quad(p, [(xs[4], y0, zs[4]), (xs[4], y1, zs[4]), (0.0, ym, 2.4)], kind=K_TINT)
    add_shard(p, xf((0.1, 0, 17.0)), radius=0.5, height=1.6, sides=4, profile=[(0, 0.3), (0.3, 1), (1, 0.05)], rings=2, cuts=0,
              top="none", bevel=0, chips=0, poke=0, kind=K_DARK, collide=False)
    p.meta["kind"] = "prop"


def banner_wide(p):
    for side in (-1, 1):
        add_box(p, xf((side * 6.0, 0, 0)), (2.0, 2.0, 1.0), kind=K_MASON, bevel=0.14, collide=False)
        add_tube(p, [(side * 6.0, 0, 1.0), (side * 6.0, 0, 13.0)], 0.3, sides=6, kind=K_DARK, taper=0.7)
    add_tube(p, [(-6.6, 0, 12.2), (0, 0, 11.8), (6.6, 0, 12.2)], 0.2, sides=5, kind=K_DARK, taper=1.0)
    cols = 6
    for i in range(cols):
        x0 = -5.4 + 10.8 * i / cols
        x1 = -5.4 + 10.8 * (i + 1) / cols
        sag0 = 11.9 - 0.012 * x0 * x0 * 0 + 0.0
        y0 = 0.25 * math.sin(i * 1.3)
        y1 = 0.25 * math.sin((i + 1) * 1.3)
        low = 5.4 if i % 2 == 0 else 6.6
        add_quad(p, [(x0, y0, sag0), (x1, y1, sag0), (x1, y1 + 0.3, 8.6), (x0, y0 + 0.3, 8.6)], kind=K_TINT)
        add_quad(p, [(x0, y0 + 0.3, 8.6), (x1, y1 + 0.3, 8.6), ((x0 + x1) / 2, (y0 + y1) / 2 + 0.5, low)], kind=K_TINT)
    p.meta["kind"] = "prop"


def brazier(p):
    add_box(p, xf((0, 0, 0)), (2.6, 2.6, 0.7), kind=K_MASON, bevel=0.12, collide=False)
    add_prism(p, xf((0, 0, 0.7)), 0.7, 2.6, sides=6, taper=0.7, kind=K_MASON, bevel=0.06, collide=False)
    add_prism(p, xf((0, 0, 3.3)), 0.9, 1.3, sides=8, taper=2.0, kind=K_DARK, bevel=0.0, collide=False)
    add_prism(p, xf((0, 0, 4.6)), 1.9, 0.3, sides=8, taper=1.0, kind=K_DARK, bevel=0.0, collide=False)
    flame(p, (0, 0, 4.5), 2.0)
    p.hulls.append(rocklib.convex_hull_of([Vector((sx * 1.3, sy * 1.3, zz)) for sx in (-1, 1) for sy in (-1, 1) for zz in (0, 4.9)]))
    p.meta["kind"] = "prop"


def chain(p):
    """A hanging chain, top at the origin, 24 m long, the last links broken and swinging out."""
    z = 0.0
    x = 0.0
    for i in range(13):
        sway = 0.0 if i < 8 else (i - 7) * 0.22
        x += sway
        turn = 0 if i % 2 == 0 else 90
        m = xf((x, 0, z), rz=turn, ry=(i - 7) * 3.0 if i > 7 else 0)
        for dx, dz, sx, sz in ((-0.48, -0.95, 0.24, 1.9), (0.48, -0.95, 0.24, 1.9), (0, 0.0, 1.2, 0.24), (0, -1.9, 1.2, 0.24)):
            add_box(p, m @ Matrix.Translation(Vector((dx, 0, dz - sz / 2 if sz > 1 else dz - 0.12))), (sx, 0.24, sz), kind=K_DARK,
                    collide=False)
        z -= 1.62
    add_shard(p, xf((0, 0, -0.2)), radius=1.3, height=1.6, sides=5, rings=1, cuts=2, bevel=0.1, chips=0, poke=0, collide=False)
    p.meta["kind"] = "prop"


def aerie_gate(p):
    """The team aerie: a landing terrace with a great ruined arch behind it. Origin: centre of
    the terrace top; riders launch toward Blender -Y (glTF +Z). Trim, cloth and the keystone
    glyph are TeamTint."""
    r = p.rng
    # terrace: an angular slab with a stepped front lip and teeth underneath
    add_shard(p, xf((0, 6, -9)), radius=46, height=9, sides=10, irregular=0.1, profile=[(0, 0.74), (0.5, 1.02), (1, 0.98)],
              rings=2, ring_jitter=0.03, cuts=3, cut_depth=(0.9, 0.99), top="flat", squash=0.78, bevel=0.03, chips=4,
              poke=0, hull_tris=24)
    add_box(p, xf((0, -4, -0.2)), (58, 46, 0.9), kind=K_MASON, bevel=0.3, collide=False)
    for i in range(5):
        a = i * 72 + 15
        add_shard(p, lean_xf((math.cos(math.radians(a)) * 24, 6 + math.sin(math.radians(a)) * 18, -5), a, -8, r.uniform(0, 360)),
                  flip=True, radius=r.uniform(8, 13), height=r.uniform(24, 46), sides=6, profile=SPIKE_PROFILE, rings=2, cuts=2,
                  bevel=0.07, chips=2, poke=0, hull_tris=10)
    # the arch, at the back (+Y): two piers and a ring of voussoirs
    half, pier_h, arc_r = 24.0, 26.0, 24.0
    back = 22.0
    for side in (-1, 1):
        add_box(p, xf((side * half, back, 0.4)), (9.5, 8.5, pier_h), kind=K_MASON, bevel=0.35, jitter=0.01)
        add_box(p, xf((side * half, back, 0.4)), (11.5, 10.5, 3.0), kind=K_MASON, bevel=0.3, collide=False)
        add_box(p, xf((side * half, back - 0.2, pier_h - 2.2)), (11.0, 10.0, 2.4), kind=K_MASON, bevel=0.3, collide=False)
        # team trim band and a hanging banner on each pier
        add_box(p, xf((side * half, back, pier_h * 0.56)), (10.1, 9.1, 1.3), kind=K_TINT, collide=False)
        add_quad(p, [(side * half - 2.6, back - 4.5, 19), (side * half + 2.6, back - 4.5, 19),
                     (side * half + 2.6, back - 4.9, 8.5), (side * half, back - 5.0, 5.5), (side * half - 2.6, back - 4.9, 8.5)],
                 kind=K_TINT)
        # brazier pylons at the front corners
        add_box(p, xf((side * 25, -22, 0.4)), (4.0, 4.0, 7.0), kind=K_MASON, bevel=0.25, jitter=0.01)
        add_prism(p, xf((side * 25, -22, 7.4)), 1.5, 1.6, sides=8, taper=1.8, kind=K_DARK, collide=False)
        flame(p, (side * 25, -22, 8.6), 3.2)
    count = 9
    for i in range(count):
        th = 180.0 * (i + 0.5) / count
        if i == 6:
            continue  # the gap: a ruin
        a = math.radians(th)
        size = (8.4, 8.2 if i != 4 else 9.4, 8.8 if i != 4 else 10.5)
        m = Matrix.Translation(Vector((math.cos(a) * arc_r, back, pier_h + math.sin(a) * arc_r))) @ rot(ry=90 - th)
        add_box(p, m @ Matrix.Translation(Vector((0, 0, -size[2] / 2))), (size[0] * 1.02, size[1], size[2]), kind=K_MASON,
                bevel=0.3, jitter=0.012)
    # keystone glyph (team) on the front face
    kz = pier_h + arc_r
    for bx, bz, bw, bh in ((0, 0.4, 0.9, 5.2), (-1.6, 1.2, 0.8, 2.6), (1.6, 1.2, 0.8, 2.6), (0, -2.6, 3.4, 0.8)):
        add_quad(p, [(bx - bw / 2, back - 4.78, kz + bz - bh / 2), (bx + bw / 2, back - 4.78, kz + bz - bh / 2),
                     (bx + bw / 2, back - 4.78, kz + bz + bh / 2), (bx - bw / 2, back - 4.78, kz + bz + bh / 2)], kind=K_TINT,
                 double=False)
    # horns on the crown and the drifting block from the gap
    for th in (40, 75, 105):
        a = math.radians(th)
        add_shard(p, lean_xf((math.cos(a) * (arc_r + 4), back, pier_h + math.sin(a) * (arc_r + 4)), 0, (90 - th) * 0.6, r.uniform(0, 360)),
                  radius=3.0, height=r.uniform(9, 15), sides=5, taper=0.2, rings=1, cuts=2, bevel=0.1, chips=1, poke=0, collide=False)
    a = math.radians(180.0 * 6.5 / count)
    add_box(p, Matrix.Translation(Vector((math.cos(a) * (arc_r + 7), back + 2, pier_h + math.sin(a) * (arc_r + 9)))) @ rot(22, 30, 14),
            (7.0, 7.0, 7.4), kind=K_MASON, bevel=0.3, jitter=0.02, collide=False)
    # low side walls and steps down the front
    for side in (-1, 1):
        add_box(p, xf((side * 28.2, 0, 0.4)), (2.2, 36, 2.6), kind=K_MASON, bevel=0.22, jitter=0.01, collide=False)
    add_moss_cap(p, xf((0, 2, 0.75)), [polar(15, a)[:2] for a in range(0, 360, 45)], lift=0.5, rings=2, rim_drop=0.3)
    p.meta["kind"] = "gate"
    p.meta["top"] = {"y": 0.7, "radius": 20.0}
    p.meta["opening"] = {"width": round((half - 4.75) * 2, 1), "height": round(pier_h + arc_r - 4.4, 1), "y": 0.0}


def backdrop(p, variant):
    """Far silhouettes outside the arena: a few plain shards, no chamfers, no collision."""
    r = p.rng
    spots = ((0, 0, 620, 120), (-150, 40, 430, 95), (140, -30, 500, 105), (60, 120, 300, 80), (-70, -110, 260, 85)) if variant == 0 else \
        ((0, 0, 380, 170), (-210, 30, 520, 110), (190, 60, 300, 120), (-60, 130, 240, 100))
    for x, y, h, rad in spots:
        add_shard(p, lean_xf((x, y, 0), r.uniform(0, 360), r.uniform(0, 6), r.uniform(0, 360)), radius=rad, height=h, sides=6,
                  taper=r.uniform(0.3, 0.5), rings=3, cuts=4, top="slant", bevel=0, chips=0, poke=0, collide=False)
    p.hulls = []
    p.meta["kind"] = "backdrop"


def backdrop_a(p):
    backdrop(p, 0)


def backdrop_b(p):
    backdrop(p, 1)


RECIPES = [
    ("column-ruined", column_ruined, 201, 1 / 12),
    ("column-broken", column_broken, 211, 1 / 12),
    ("wall-fragment", wall_fragment, 223, 1 / 12),
    ("bridge-span", bridge_span, 227, 1 / 12),
    ("stairs", stairs, 229, 1 / 12),
    ("standing-stone", standing_stone, 233, 1 / 12),
    ("crystal-cluster", crystal_cluster, 239, 1 / 12),
    ("crystal-core", crystal_core, 241, 1 / 24),
    ("banner-tall", banner_tall, 251, 1 / 12),
    ("banner-wide", banner_wide, 257, 1 / 12),
    ("brazier", brazier, 263, 1 / 12),
    ("chain", chain, 269, 1 / 12),
    ("aerie-gate", aerie_gate, 271, 1 / 24),
    ("backdrop-a", backdrop_a, 277, 1 / 200),
    ("backdrop-b", backdrop_b, 281, 1 / 200),
]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = set(argv[argv.index("--only") + 1].split(",")) if "--only" in argv else None
    rocklib.clear_scene()
    built = {}
    for name, fn, seed, uv_scale in RECIPES:
        if only is not None and name not in only:
            continue
        piece = Piece(name, seed)
        fn(piece)
        is_backdrop = piece.meta.get("kind") == "backdrop"
        lods, meta = rocklib.finish(piece, OUT_GLB, OUT_HULL, (3000, 1200) if not is_backdrop else (3000,),
                                    uv_scale=uv_scale, moss=0.0 if is_backdrop else 0.8, moss_threshold=0.8,
                                    ao_scale=0.35)
        for i, o in enumerate(lods):
            o.name = "%s_LOD%d" % (name, i)
        built[name] = lods
    if only is None:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REPO, "art-source", "maps", "props.blend"))
    if "--preview" in argv:
        preview.setup_scene(900, 700)
        preview.setup_world()
        preview.setup_sun()
        cam = preview.make_camera(lens=50)
        mat = preview.game_material("GameProp", texture=preview.texture_path("masonry"), mean=preview.texture_mean("masonry"),
                                    tex_scale=1 / 12.0, detail_strength=0.6)
        tint = preview.game_material("GameTint", emissive=False)
        tint_node = tint.node_tree.nodes.new("ShaderNodeRGB")
        tint_node.outputs[0].default_value = (1.0, 0.19, 0.01, 1)
        mul = tint.node_tree.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        vc = next(n for n in tint.node_tree.nodes if n.type == "VERTEX_COLOR" and n.layer_name == "Color")
        bsdf = next(n for n in tint.node_tree.nodes if n.type == "BSDF_DIFFUSE")
        tint.node_tree.links.new(vc.outputs["Color"], mul.inputs["A"])
        tint.node_tree.links.new(tint_node.outputs[0], mul.inputs["B"])
        tint.node_tree.links.new(mul.outputs["Result"], bsdf.inputs["Color"])
        for name, lods in built.items():
            for o in bpy.data.objects:
                if o.type == "MESH":
                    o.hide_render = True
            o = lods[0]
            o.hide_render = False
            slots = [m.name for m in o.data.materials]
            for i, slot in enumerate(slots):
                o.data.materials[i] = tint if slot.startswith("TeamTint") else mat
            bpy.context.view_layer.update()
            preview.frame_objects(cam, [o], azimuth_deg=-62, elevation_deg=12, margin=0.62)
            preview.render(os.path.join(SCRATCH, name + ".png"))


main()
