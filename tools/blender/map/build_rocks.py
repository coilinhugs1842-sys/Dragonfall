"""Builds the Shattered Spires hero rocks (T-4.5).

  blender -b -P tools/blender/map/build_rocks.py -- [--only id,id] [--preview] [--no-export]

Output: art-source/maps/rocks/<id>.glb (raw, LOD0..2 nodes), art-source/maps/hulls/<id>.json
(convex collision hulls + metadata), art-source/maps/rocks.blend, and with --preview one PNG per
rock under art-source/_scratch/rocks/.
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
    BELLY_PROFILE,
    FLOAT_PROFILE,
    K_GLOW,
    K_STONE,
    MAGENTA,
    MAGENTA_DEEP,
    MAGENTA_HOT,
    MOSS_DEEP,
    SPIKE_PROFILE,
    Piece,
    add_moss_cap,
    add_shard,
    add_tube,
    mix,
    rot,
    xf,
)

REPO = preview.REPO
OUT_GLB = os.path.join(REPO, "art-source", "maps", "rocks")
OUT_HULL = os.path.join(REPO, "art-source", "maps", "hulls")
SCRATCH = os.path.join(REPO, "art-source", "_scratch", "rocks")
LOD_TARGETS = (8000, 3000, 800)


def lean_xf(loc, az=0.0, tilt=0.0, spin=0.0):
    """Base at loc, +Z tilted `tilt` degrees toward azimuth `az`, spun about its own axis."""
    return Matrix.Translation(Vector(loc)) @ rot(rz=az) @ rot(ry=tilt) @ rot(rz=spin)


def polar(r, a_deg, z=0.0):
    a = math.radians(a_deg)
    return (math.cos(a) * r, math.sin(a) * r, z)


def fragments(p, centre, count, spread, size, axis_az=0.0, axis_tilt=0.0, rise=1.0):
    """Floating broken-off pieces drifting apart around `centre`, roughly sharing one axis."""
    r = p.rng
    for i in range(count):
        a = r.uniform(0, 360)
        d = spread * math.sqrt(r.uniform(0.05, 1.0))
        s = size * r.uniform(0.45, 1.0) * (1.0 - 0.35 * i / max(count - 1, 1))
        loc = (
            centre[0] + math.cos(math.radians(a)) * d,
            centre[1] + math.sin(math.radians(a)) * d,
            centre[2] + r.uniform(-0.4, 1.0) * spread * rise,
        )
        add_shard(
            p,
            lean_xf(loc, axis_az + r.uniform(-40, 40), axis_tilt + r.uniform(-22, 22), r.uniform(0, 360)),
            radius=s,
            height=s * r.uniform(2.2, 3.6),
            sides=r.choice((5, 5, 6)),
            profile=FLOAT_PROFILE,
            rings=2,
            cuts=2,
            top="slant",
            bevel=0.07,
            poke=0.0,
            hull_tris=10,
            collide=s > 3.0,
        )


def buttresses(p, count, ring, radius, height, tilt=(3, 10), start=0.0, arc=360.0, z=0.0, rings=4):
    r = p.rng
    for i in range(count):
        a = start + arc * (i + r.uniform(-0.25, 0.25)) / count
        d = r.uniform(*ring)
        rad = r.uniform(*radius)
        add_shard(
            p,
            lean_xf(polar(d, a, z + r.uniform(-4, 0)), a, r.uniform(*tilt), r.uniform(0, 360)),
            radius=rad,
            height=r.uniform(*height),
            sides=r.choice((5, 6, 6, 7)),
            taper=r.uniform(0.35, 0.6),
            rings=rings,
            cuts=3,
            top=r.choice(("slant", "double")),
            bevel=0.06,
            poke=0.6,
            hull_tris=14,
        )


def ledge(p, loc, az, radius, thick):
    """A broken slab sticking out sideways: a mossy step on a spire."""
    add_shard(
        p,
        lean_xf(loc, az, p.rng.uniform(-6, 8), p.rng.uniform(0, 360)),
        radius=radius,
        height=thick,
        sides=6,
        taper=0.82,
        rings=1,
        cuts=2,
        cut_depth=(0.7, 0.92),
        top="flat",
        squash=0.72,
        bevel=0.07,
        poke=0.0,
        hull_tris=12,
    )


def crystals(p, loc, count, size, az=0.0, tilt=0.0, spread=0.6):
    """A cluster of magenta crystals (emissive)."""
    r = p.rng
    for i in range(count):
        s = size * (1.0 if i == 0 else r.uniform(0.35, 0.75))
        a = r.uniform(0, 360)
        off = (0, 0, 0) if i == 0 else polar(size * spread * r.uniform(0.5, 1.0), a)
        t = tilt if i == 0 else tilt + r.uniform(14, 38)
        color = mix(MAGENTA_DEEP, MAGENTA, r.uniform(0.5, 1.0))
        bm, hull = rocklib.make_shard(
            r, radius=s * 0.32, height=s * 2.0, sides=6, irregular=0.1, rings=2, cuts=0, top="none",
            bevel=0.0, poke=0.0, profile=[(0.0, 0.8), (0.72, 1.0), (1.0, 0.04)], ring_jitter=0.0,
            hull_tris=10,
        )
        layer = bm.faces.layers.int["kind"]
        for f in bm.faces:
            f[layer] = K_GLOW
        m = lean_xf((loc[0] + off[0], loc[1] + off[1], loc[2] + off[2]), az if i == 0 else a, t, r.uniform(0, 360))
        p.add_bmesh(bm, m, hull if (i == 0 and size > 6) else None, color=color, solid=False)
        bm.free()


# --- Recipes --------------------------------------------------------------------------------------


def cluster(p, count, ring, radius, height, lean_az, lean_tilt, start=0.0, arc=360.0, z=0.0, rings=4,
            taper=(0.55, 0.78), fan=6.0):
    """Shards hugging a core: they share the core's lean and fan outward a little."""
    r = p.rng
    for i in range(count):
        a = start + arc * (i + r.uniform(-0.3, 0.3)) / count
        d = r.uniform(*ring)
        rad = r.uniform(*radius)
        m = (Matrix.Translation(Vector(polar(d, a, z + r.uniform(-4, 0)))) @ rot(rz=lean_az) @ rot(ry=lean_tilt)
             @ rot(rz=a - lean_az) @ rot(ry=r.uniform(0.3, 1.0) * fan) @ rot(rz=r.uniform(0, 360)))
        add_shard(p, m, radius=rad, height=r.uniform(*height), sides=r.choice((5, 6, 6, 7)),
                  taper=r.uniform(*taper), rings=rings, cuts=4, top="slant", top_tilt=(14, 34),
                  bevel=0.085, poke=0.6, hull_tris=14)


def spire_tall(p):
    add_shard(p, lean_xf((0, 0, -6), 20, 3.0, 10), radius=31, height=226, sides=7, taper=0.55,
              rings=6, cuts=7, top="slant", top_tilt=(24, 36), bevel=0.075, poke=0.7, hull_tris=30)
    cluster(p, 3, (19, 25), (17, 23), (118, 172), 20, 3.0, start=40, rings=5, fan=3.5)
    cluster(p, 6, (30, 39), (14, 20), (52, 112), 20, 3.0, start=10, rings=4, fan=8)
    cluster(p, 5, (42, 50), (9, 13), (22, 48), 20, 3.0, start=0, rings=2, fan=12)
    ledge(p, polar(31, 205, 108), 205, 21, 7)
    ledge(p, polar(26, 60, 150), 60, 16, 6)
    ledge(p, polar(40, 320, 62), 320, 20, 7)
    # the tip, broken off and drifting
    add_shard(p, lean_xf((14, 4, 226), 20, 9, 0), radius=11, height=30, sides=6, profile=FLOAT_PROFILE,
              rings=2, cuts=3, top="slant", bevel=0.09, poke=0.0, hull_tris=12)
    fragments(p, (20, 2, 262), 5, 12, 7, axis_az=20, axis_tilt=8, rise=1.0)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def spire_twin(p):
    r = p.rng
    add_shard(p, lean_xf((0, 0, -6), 0, 0, 0), radius=44, height=62, sides=8, taper=0.72,
              rings=3, cuts=4, top="double", bevel=0.05, poke=0.7, hull_tris=24)
    add_shard(p, lean_xf((-15, 2, 16), 180, 7.5, 0), radius=23, height=205, sides=6, taper=0.36,
              rings=6, cuts=5, top="double", bevel=0.055, poke=0.7, hull_tris=26)
    add_shard(p, lean_xf((17, -3, 14), 8, 10, 40), radius=19, height=148, sides=6, taper=0.4,
              rings=5, cuts=4, top="slant", bevel=0.055, poke=0.7, hull_tris=22)
    buttresses(p, 5, (30, 42), (12, 18), (40, 96), tilt=(4, 11), start=20)
    buttresses(p, 2, (20, 26), (11, 14), (95, 130), tilt=(6, 9), start=150, arc=120, z=10)
    # the wedged boulder between the prongs
    add_shard(p, lean_xf((-1, 0, 96), 0, 78, 0), radius=9, height=26, sides=6, profile=FLOAT_PROFILE,
              rings=2, cuts=2, bevel=0.08, poke=0.0, hull_tris=12)
    ledge(p, (-36, 6, 120), 175, 15, 6)
    ledge(p, (42, -6, 84), 0, 14, 6)
    fragments(p, (-44, 4, 236), 5, 11, 7, axis_az=180, axis_tilt=10, rise=1.5)
    fragments(p, (44, -4, 170), 3, 8, 5, axis_az=8, axis_tilt=12, rise=1.3)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def spire_lean(p):
    add_shard(p, lean_xf((-10, 0, -6), 0, 15, 0), radius=29, height=196, sides=7, taper=0.5,
              rings=6, cuts=5, top="slant", bevel=0.05, poke=0.7, hull_tris=28)
    # the overhanging head
    add_shard(p, lean_xf((37, 0, 168), 0, 28, 30), radius=25, height=52, sides=7, profile=BELLY_PROFILE,
              rings=3, cuts=4, top="double", bevel=0.06, poke=0.6, hull_tris=20)
    buttresses(p, 4, (20, 34), (14, 22), (60, 130), tilt=(8, 16), start=110, arc=140)
    buttresses(p, 3, (26, 36), (12, 16), (30, 70), tilt=(4, 10), start=-60, arc=120)
    ledge(p, (30, 14, 110), 20, 17, 7)
    ledge(p, (-22, -20, 70), 220, 18, 7)
    fragments(p, (58, 0, 232), 5, 12, 7.5, axis_az=0, axis_tilt=30, rise=1.2)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def stump_broken(p):
    r = p.rng
    top_z = 86.0
    add_shard(p, lean_xf((0, 0, -6), 0, 0, 0), radius=50, height=top_z + 6, sides=9, taper=0.82,
              irregular=0.12, rings=4, cuts=3, cut_depth=(0.88, 0.98), top="flat", bevel=0.045, poke=0.7,
              hull_tris=30)
    outline = [polar(35 * (1 + r.uniform(-0.1, 0.1)), a) [:2] for a in range(0, 360, 30)]
    add_moss_cap(p, xf((0, 0, top_z - 0.4)), outline, lift=2.2, rings=3, rim_drop=1.0)
    # broken teeth around the rim
    for i in range(7):
        a = i * 360 / 7 + r.uniform(-12, 12)
        if i in (2, 5):
            continue
        add_shard(p, lean_xf(polar(r.uniform(39, 45), a, 30), a, r.uniform(-3, 6), r.uniform(0, 360)),
                  radius=r.uniform(11, 16), height=r.uniform(72, 112), sides=r.choice((5, 6)),
                  taper=r.uniform(0.3, 0.5), rings=4, cuts=3, top="double", bevel=0.06, poke=0.5,
                  hull_tris=14)
    buttresses(p, 6, (46, 58), (13, 19), (30, 64), tilt=(5, 12), start=15)
    # the missing top, hovering in pieces
    fragments(p, (4, 0, 150), 8, 26, 12, axis_az=40, axis_tilt=8, rise=0.9)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"
    p.meta["top"] = {"y": top_z, "radius": 26.0}


def island(p, radius, thick, depth, spikes, roots, sides=11):
    """Origin at the centre of the mossy top (z = 0)."""
    r = p.rng
    add_shard(p, xf((0, 0, -thick)), radius=radius, height=thick, sides=sides, irregular=0.14,
              profile=[(0.0, 0.66), (0.5, 1.02), (1.0, 0.97)], rings=2, ring_jitter=0.035, cuts=3,
              cut_depth=(0.86, 0.97), top="flat", bevel=0.03, poke=0.5, hull_tris=30)
    outline = [polar(radius * 0.86 * (1 + r.uniform(-0.07, 0.07)), a)[:2] for a in range(0, 360, 360 // 14)]
    add_moss_cap(p, xf((0, 0, -0.5)), outline, lift=radius * 0.045, rings=4, rim_drop=1.2)
    # underside: one great tooth and a ring of lesser ones
    add_shard(p, lean_xf((r.uniform(-4, 4), r.uniform(-4, 4), -thick * 0.55), r.uniform(0, 360), r.uniform(0, 5), 0),
              flip=True, radius=radius * 0.62, height=depth, sides=7, profile=SPIKE_PROFILE, rings=4,
              cuts=4, top="none", bevel=0.045, poke=0.6, hull_tris=22)
    for i in range(spikes):
        a = i * 360 / spikes + r.uniform(-16, 16)
        d = radius * r.uniform(0.42, 0.74)
        add_shard(p, lean_xf(polar(d, a, -thick * 0.5), a, r.uniform(-14, 6), r.uniform(0, 360)), flip=True,
                  radius=radius * r.uniform(0.2, 0.32), height=depth * r.uniform(0.3, 0.72), sides=r.choice((5, 6)),
                  profile=SPIKE_PROFILE, rings=3, cuts=3, top="none", bevel=0.06, poke=0.4, hull_tris=12)
    # rim boulders breaking the outline of the top
    for i in range(4):
        a = r.uniform(0, 360)
        add_shard(p, lean_xf(polar(radius * r.uniform(0.82, 0.95), a, -thick * 0.5), a, r.uniform(0, 14), r.uniform(0, 360)),
                  radius=radius * r.uniform(0.1, 0.17), height=thick * r.uniform(0.9, 1.5), sides=5,
                  taper=0.55, rings=2, cuts=2, top="slant", bevel=0.08, poke=0.0, hull_tris=10)
    for i in range(roots):
        a = r.uniform(0, 360)
        d = radius * r.uniform(0.5, 0.92)
        x, y, _ = polar(d, a)
        length = depth * r.uniform(0.3, 0.6)
        pts = [(x, y, -thick * 0.6)]
        sway = radius * 0.06
        for k in range(1, 5):
            pts.append((x + r.uniform(-sway, sway) * k * 0.5, y + r.uniform(-sway, sway) * k * 0.5,
                        -thick * 0.6 - length * k / 4))
        add_tube(p, pts, radius * 0.022 + 0.35, sides=4, kind=K_STONE, taper=0.15, color=MOSS_DEEP * 0.7)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "top"
    p.meta["top"] = {"y": 0.0, "radius": round(radius * 0.72, 1)}


def island_large(p):
    island(p, 72, 17, 105, 7, 6, sides=12)


def island_small(p):
    island(p, 36, 11, 74, 5, 5, sides=9)


def arch(p, broken):
    r = p.rng
    half, leg_h, arc_r = 55.0, 46.0, 55.0
    for side in (-1, 1):
        add_shard(p, lean_xf((side * half, 0, -4), 0 if side > 0 else 180, r.uniform(-3, 2), r.uniform(0, 360)),
                  radius=19, height=leg_h + 14, sides=6, taper=0.86, rings=3, cuts=3, top="flat", bevel=0.055,
                  poke=0.6, hull_tris=18)
        add_shard(p, lean_xf((side * (half + 2), 0, 4), 0, 0, r.uniform(0, 360)), flip=True, radius=17, height=58,
                  sides=6, profile=SPIKE_PROFILE, rings=3, cuts=3, top="none", bevel=0.06, poke=0.5, hull_tris=14)
    count = 8
    for i in range(count):
        th0 = 180.0 * i / count
        th1 = 180.0 * (i + 1) / count
        mid = (th0 + th1) * 0.5
        if broken and i in (3, 4):
            continue
        rad = r.uniform(14.5, 18.5) * (0.82 if broken and i in (2, 5) else 1.0)
        a0 = math.radians(th0 - 5)
        base = (math.cos(a0) * arc_r, r.uniform(-2.5, 2.5), leg_h + math.sin(a0) * arc_r)
        length = 2 * arc_r * math.sin(math.radians((th1 - th0) * 0.5 + 5)) * 1.02
        add_shard(p, Matrix.Translation(Vector(base)) @ rot(ry=-mid) @ rot(rz=r.uniform(0, 360)),
                  radius=rad, height=length, sides=6, profile=[(0.0, 0.84), (0.5, 1.0), (1.0, 0.84)], rings=2,
                  cuts=2, cut_depth=(0.78, 0.95), top="flat", bevel=0.06, poke=0.5, hull_tris=14)
    # crest: spikes standing on the span
    crest = (35, 62, 118, 146) if broken else (38, 70, 92, 121, 150)
    for th in crest:
        a = math.radians(th)
        add_shard(p, lean_xf((math.cos(a) * (arc_r + 8), r.uniform(-3, 3), leg_h + math.sin(a) * (arc_r + 8)),
                             0, (90 - th) * 0.55, r.uniform(0, 360)),
                  radius=r.uniform(7, 10.5), height=r.uniform(20, 40), sides=5, taper=0.3, rings=2, cuts=2,
                  top="slant", bevel=0.08, poke=0.0, hull_tris=10)
    if broken:
        fragments(p, (0, 0, leg_h + arc_r - 2), 6, 13, 7.5, axis_az=0, axis_tilt=80, rise=0.5)
    inner = arc_r - 17.0
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"
    # the hole to thread: centre line along local Z (glTF), i.e. Blender Y
    p.meta["opening"] = {"width": round(inner * 2, 1), "height": round(leg_h + inner, 1), "y": round((leg_h + inner) * 0.5, 1)}


def arch_great(p):
    arch(p, False)


def arch_broken(p):
    arch(p, True)


def crown_claw(p):
    """A great claw curving toward +X as it rises: six stand around the sky-well."""
    r = p.rng

    def curve(s):
        return Vector((92.0 * s ** 2.4, 0.0, 268.0 * (s - 0.16 * s * s)))

    segs = 7
    for i in range(segs):
        s0 = i / segs
        s1 = (i + 1) / segs
        a = curve(s0)
        b = curve(min(s1 + 0.035, 1.0))
        d = b - a
        tilt = math.degrees(math.atan2(d.x, d.z))
        rad = 31.0 * (1 - s0) ** 0.8 + 6.0
        add_shard(p, lean_xf((a.x, a.y + r.uniform(-1.5, 1.5), a.z - (6 if i == 0 else 0)), 0, tilt, r.uniform(0, 360)),
                  radius=rad, height=d.length + (6 if i == 0 else 0), sides=6, taper=0.74 if i < segs - 1 else 0.12,
                  rings=3, cuts=3, top="slant" if i == segs - 1 else "flat", squash=0.74, bevel=0.055, poke=0.6,
                  hull_tris=18)
    # dorsal spines on the outer side
    for s in (0.2, 0.36, 0.52, 0.68, 0.8):
        c = curve(s)
        rad = 9.5 * (1 - s) + 4
        add_shard(p, lean_xf((c.x - (22 * (1 - s) + 5), r.uniform(-4, 4), c.z), 180, r.uniform(28, 52) - 60 * s, r.uniform(0, 360)),
                  radius=rad, height=rad * r.uniform(2.6, 3.8), sides=5, taper=0.2, rings=2, cuts=2, top="slant",
                  bevel=0.08, poke=0.0, hull_tris=10)
    buttresses(p, 3, (26, 38), (14, 20), (40, 96), tilt=(5, 12), start=100, arc=160)
    tip = curve(1.0)
    fragments(p, (tip.x + 12, 0, tip.z + 5), 2, 7, 6.0, axis_az=0, axis_tilt=62, rise=0.5)
    crystals(p, (curve(0.3).x + 17, 6, curve(0.3).z), 3, 9.0, az=0, tilt=64)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def crown_base(p):
    """A crescent of the broken basin around the sky-well (two make the ring). Origin: ring centre."""
    r = p.rng
    ring = 66.0
    for i in range(6):
        a = -75 + 150 * i / 5 + r.uniform(-5, 5)
        add_shard(p, lean_xf(polar(ring + r.uniform(-5, 5), a, -30), a, r.uniform(2, 12), r.uniform(0, 360)),
                  radius=r.uniform(21, 27), height=r.uniform(44, 76), sides=r.choice((6, 7)), taper=0.62, rings=3,
                  cuts=3, top="double", bevel=0.055, poke=0.6, hull_tris=18)
        add_shard(p, lean_xf(polar(ring + r.uniform(-6, 4), a + r.uniform(-6, 6), -22), a, r.uniform(-12, 4), r.uniform(0, 360)),
                  flip=True, radius=r.uniform(17, 24), height=r.uniform(46, 96), sides=6, profile=SPIKE_PROFILE,
                  rings=3, cuts=3, top="none", bevel=0.06, poke=0.5, hull_tris=14)
    # inner terrace
    for i in range(4):
        a = -58 + 116 * i / 3 + r.uniform(-6, 6)
        add_shard(p, lean_xf(polar(ring - 26, a, -26), a, r.uniform(-4, 4), r.uniform(0, 360)),
                  radius=r.uniform(16, 21), height=r.uniform(20, 30), sides=6, taper=0.8, rings=2, cuts=2,
                  top="flat", bevel=0.06, poke=0.5, hull_tris=14)
    crystals(p, polar(ring - 24, -30, -1), 4, 11.0, az=150, tilt=18)
    crystals(p, polar(ring - 20, 34, 2), 3, 8.0, az=210, tilt=24)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "centre"


def shard_cluster(p):
    r = p.rng
    add_shard(p, lean_xf((0, 0, -24), 30, 14, 0), radius=13, height=52, sides=6, profile=FLOAT_PROFILE, rings=3,
              cuts=3, top="slant", bevel=0.06, poke=0.5, hull_tris=16)
    spots = [(-24, 8, 6, 9), (20, -14, -12, 8), (10, 22, 20, 6.5), (-12, -22, -22, 6), (28, 12, 16, 5),
             (-30, -8, -16, 4.5), (4, -4, 36, 5), (-6, 26, -6, 4)]
    for x, y, z, s in spots:
        add_shard(p, lean_xf((x, y, z - s * 1.4), 30 + r.uniform(-50, 50), 14 + r.uniform(-26, 26), r.uniform(0, 360)),
                  radius=s, height=s * r.uniform(2.6, 3.8), sides=r.choice((5, 6)), profile=FLOAT_PROFILE, rings=2,
                  cuts=2, top="slant", bevel=0.07, poke=0.0, hull_tris=10)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "centre"


def cliff_wall(p):
    """A long slab of cliff along X for canyon sides. Base at z = 0."""
    r = p.rng
    xs = (-74, -44, -14, 17, 47, 76)
    hs = (96, 132, 118, 146, 108, 84)
    for x, h in zip(xs, hs):
        add_shard(p, lean_xf((x + r.uniform(-4, 4), r.uniform(-5, 5), -6), 90 * r.choice((-1, 1)), r.uniform(0, 5), r.uniform(-20, 20)),
                  radius=r.uniform(24, 30), height=h + r.uniform(-8, 8), sides=6, taper=0.62, rings=4, cuts=4,
                  top="double", squash=0.7, bevel=0.05, poke=0.7, hull_tris=18)
    for i in range(7):
        x = -80 + 160 * i / 6 + r.uniform(-8, 8)
        side = r.choice((-1, 1))
        add_shard(p, lean_xf((x, side * r.uniform(15, 22), -4), 90 * side, r.uniform(4, 11), r.uniform(0, 360)),
                  radius=r.uniform(12, 17), height=r.uniform(34, 82), sides=r.choice((5, 6)), taper=0.4, rings=3,
                  cuts=3, top="slant", bevel=0.06, poke=0.5, hull_tris=12)
    ledge(p, (-30, 16, 66), 90, 18, 7)
    ledge(p, (34, -17, 88), 270, 17, 6)
    fragments(p, (20, 0, 164), 4, 12, 7, axis_az=0, axis_tilt=6, rise=1.2)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


RECIPES = [
    ("spire-tall", spire_tall, 11),
    ("spire-twin", spire_twin, 23),
    ("spire-lean", spire_lean, 37),
    ("stump-broken", stump_broken, 41),
    ("island-large", island_large, 53),
    ("island-small", island_small, 67),
    ("arch-great", arch_great, 71),
    ("arch-broken", arch_broken, 83),
    ("crown-claw", crown_claw, 97),
    ("crown-base", crown_base, 101),
    ("shard-cluster", shard_cluster, 113),
    ("cliff-wall", cliff_wall, 127),
]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = None
    if "--only" in argv:
        only = set(argv[argv.index("--only") + 1].split(","))
    do_preview = "--preview" in argv
    rocklib.clear_scene()
    built = {}
    for name, fn, seed in RECIPES:
        if only is not None and name not in only:
            continue
        piece = Piece(name, seed)
        fn(piece)
        lods, meta = rocklib.finish(piece, OUT_GLB, OUT_HULL, LOD_TARGETS)
        for i, o in enumerate(lods):
            o.name = "%s_LOD%d" % (name, i)
        built[name] = lods
    if only is None:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(REPO, "art-source", "maps", "rocks.blend"))
    if do_preview:
        scene = preview.setup_scene(1100, 800)
        preview.setup_world()
        preview.setup_sun()
        cam = preview.make_camera(lens=50)
        mat = preview.default_game_material()
        for name, lods in built.items():
            for o in bpy.data.objects:
                if o.type == "MESH":
                    o.hide_render = True
            x = 0.0
            shown = []
            for o in (lods[0], lods[-1]):
                o.hide_render = False
                o.data.materials.clear()
                o.data.materials.append(mat)
                o.location.x = x
                lo, hi = preview.bounds_of([o])
                x += (hi.x - lo.x) * 1.15
                shown.append(o)
            bpy.context.view_layer.update()
            preview.frame_objects(cam, shown, azimuth_deg=-70, elevation_deg=6, margin=0.6)
            preview.render(os.path.join(SCRATCH, name + ".png"))
            for o in lods:
                o.location.x = 0.0


main()
