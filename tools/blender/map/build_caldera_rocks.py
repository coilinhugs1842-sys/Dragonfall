"""Builds the Emberfall Caldera hero rocks (T-6.4), with the Shattered Spires toolbox (rocklib.py).

  blender -b -P tools/blender/map/build_caldera_rocks.py -- [--only id,id] [--preview]

Output: art-source/maps/caldera/rocks/<id>.glb (raw, LOD0..2 nodes),
art-source/maps/caldera/hulls/<id>.json (convex collision hulls + metadata),
art-source/maps/caldera/rocks.blend, and with --preview one PNG per rock under
art-source/maps/caldera/_scratch/rocks/ plus art-source/maps/caldera/previews/rocks-sheet.png.

HOW IT DIFFERS FROM THE SPIRES (same pipeline, other silhouette language and palette):
- rocklib.py is used unchanged. Its palette lives in module globals that `paint()` reads when it
  runs, so `apply_caldera_palette()` swaps them for this process only: dark basalt for the slate,
  dusty rose for the lit edges, ash grey in the moss slot (`_MASKS.g` means "ash" on this map).
- `fissure()` lays glowing cracks on a piece: thin `K_GLOW` strips projected onto the surface
  (`_MASKS.a`, the same emissive mask as crystals and flames). Lava is deep crimson, NOT orange:
  team Ember's molten orange has to stay the only orange on screen, so the lava sits at a hue
  between the hazard magenta and red, and is painted dim.
- `grade()` paints the glow from below into the vertex colours after rocklib's own painting:
  down-facing faces and the foot of rooted rocks take a dark crimson bounce.

AXES: authored in Blender space (+Z up); glTF +Z (the "front") is Blender -Y, glTF +X is +X.
This module is also imported by build_caldera_props.py (it only builds when run as a script).
"""

import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import preview
import rocklib
from rocklib import (
    K_CHAMFER,
    K_DARK,
    K_GLOW,
    K_MASON,
    K_MOSS,
    K_STONE,
    Piece,
    add_moss_cap,
    add_prism,
    add_quad,
    add_shard,
    lin,
    rot,
    xf,
)

REPO = preview.REPO
CALDERA = os.path.join(REPO, "art-source", "maps", "caldera")
OUT_GLB = os.path.join(CALDERA, "rocks")
OUT_HULL = os.path.join(CALDERA, "hulls")
SCRATCH = os.path.join(CALDERA, "_scratch", "rocks")
PREVIEWS = os.path.join(CALDERA, "previews")
LOD_TARGETS = (8000, 3000, 800)

# --- Palette (docs/ART_DIRECTION.md: Emberfall Caldera, dusk) -------------------------------------

BASALT = lin(0x3A3848)
BASALT_LIGHT = lin(0x6C6A82)
BASALT_MID = lin(0x4C4A5E)
BASALT_WARM = lin(0x6A5560)
BASALT_SHADOW = lin(0x16141E)
BASALT_VIOLET = lin(0x40304E)
DUSK_LIT = lin(0xB08A90)
ASH_PALE = lin(0xD8C4BC)
ASH = lin(0x8A8588)
ASH_DEEP = lin(0x5C585E)
ASH_LIGHT = lin(0xB8B0AC)
OBSIDIAN = lin(0x24202E)
# Lava: crimson toward magenta, far from team Ember's #FF7A1A; `LAVA_HOT` only in pool centres.
LAVA_DEEP = lin(0x6E0F30)
LAVA = lin(0xB81E46)
LAVA_HOT = lin(0xE8405A)
# What the glow from below adds to stone (linear): a dark crimson.
UNDER_GLOW = np.array([0.150, 0.020, 0.034], dtype=np.float32)


def apply_caldera_palette():
    """Swaps rocklib's module-level palette for the caldera's (this Blender process only)."""
    rocklib.STONE = BASALT
    rocklib.STONE_LIGHT = BASALT_LIGHT
    rocklib.STONE_MID = BASALT_MID
    rocklib.STONE_WARM = BASALT_WARM
    rocklib.STONE_SHADOW = BASALT_SHADOW
    rocklib.STONE_VIOLET = BASALT_VIOLET
    rocklib.LIT_EDGE = DUSK_LIT
    rocklib.CREAM = ASH_PALE
    # the "moss" slot is ash here; a step paler than the texture so dunes read against basalt at dusk
    rocklib.MOSS = lin(0xA39C9C)
    rocklib.MOSS_DEEP = lin(0x6E686C)
    rocklib.MOSS_LIGHT = lin(0xCFC4BE)


# --- Small helpers (same conventions as build_rocks.py) -------------------------------------------


def lean_xf(loc, az=0.0, tilt=0.0, spin=0.0):
    """Base at loc, +Z tilted `tilt` degrees toward azimuth `az`, spun about its own axis."""
    return Matrix.Translation(Vector(loc)) @ rot(rz=az) @ rot(ry=tilt) @ rot(rz=spin)


def polar(r, a_deg, z=0.0):
    a = math.radians(a_deg)
    return (math.cos(a) * r, math.sin(a) * r, z)


def fragments(p, centre, count, spread, size, axis_az=0.0, axis_tilt=0.0, rise=1.0, color=None):
    """Broken-off pieces drifting apart around `centre`."""
    r = p.rng
    for i in range(count):
        a = r.uniform(0, 360)
        d = spread * math.sqrt(r.uniform(0.05, 1.0))
        s = size * r.uniform(0.45, 1.0) * (1.0 - 0.35 * i / max(count - 1, 1))
        loc = (centre[0] + math.cos(math.radians(a)) * d, centre[1] + math.sin(math.radians(a)) * d,
               centre[2] + r.uniform(-0.4, 1.0) * spread * rise)
        add_shard(p, lean_xf(loc, axis_az + r.uniform(-40, 40), axis_tilt + r.uniform(-22, 22), r.uniform(0, 360)),
                  radius=s, height=s * r.uniform(2.2, 3.6), sides=r.choice((5, 5, 6)), profile=rocklib.FLOAT_PROFILE,
                  rings=2, cuts=2, top="slant", bevel=0.07, poke=0.0, hull_tris=10, collide=s > 3.0, color=color)


def buttresses(p, count, ring, radius, height, tilt=(3, 10), start=0.0, arc=360.0, z=0.0, rings=3, centre=(0.0, 0.0),
               strata=0.05, hull_tris=12):
    """Lower shards leaning against a core, on a ring around `centre`."""
    r = p.rng
    for i in range(count):
        a = start + arc * (i + r.uniform(-0.25, 0.25)) / count
        x, y, _ = polar(r.uniform(*ring), a)
        add_shard(p, lean_xf((centre[0] + x, centre[1] + y, z + r.uniform(-4, 0)), a + 180, r.uniform(*tilt), r.uniform(0, 360)),
                  radius=r.uniform(*radius), height=r.uniform(*height), sides=r.choice((5, 6, 6, 7)),
                  taper=r.uniform(0.35, 0.6), rings=rings, strata=strata, cuts=3, top=r.choice(("slant", "double")),
                  bevel=0.06, poke=0.5, hull_tris=hull_tris)


def ledge(p, loc, az, radius, thick):
    add_shard(p, lean_xf(loc, az, p.rng.uniform(-6, 8), p.rng.uniform(0, 360)), radius=radius, height=thick, sides=6,
              taper=0.82, rings=1, cuts=2, cut_depth=(0.7, 0.92), top="flat", squash=0.72, bevel=0.07, poke=0.0,
              hull_tris=12)


def blade(p, m, radius, height, floating=False, collide=True, hull_tris=10, squash=0.42):
    """An obsidian blade: thin, glassy black, its chamfers catching the light."""
    profile = [(0.0, 0.05), (0.3, 1.0), (0.66, 0.6), (1.0, 0.03)] if floating else [(0.0, 0.62), (0.2, 1.0), (0.62, 0.6), (1.0, 0.03)]
    add_shard(p, m, radius=radius, height=height, sides=5, irregular=0.12, rings=2, ring_jitter=0.03, cuts=2,
              cut_depth=(0.78, 0.96), chips=0, top="none", profile=profile, squash=squash, bevel=0.1, bevel_min=2.5,
              poke=0.0, hull_tris=hull_tris, color=OBSIDIAN, collide=collide)


def hex_column(p, loc, radius, height, spin=0.0, lean_az=0.0, lean=0.0, flip=False, collide=True, hull_tris=20,
               slant=(3, 13)):
    """One basalt column: a six-sided prism with a slightly slanted, chipped head."""
    add_shard(p, Matrix.Translation(Vector(loc)) @ rot(rz=lean_az) @ rot(ry=lean) @ rot(rz=spin), flip=flip,
              radius=radius, height=height, sides=6, taper=1.0, irregular=0.04, rings=1, ring_jitter=0.0, cuts=0,
              chips=1, top="slant", top_tilt=slant, bevel=0.07, bevel_min=2.0, poke=0.0, hull_tris=hull_tris,
              collide=collide)


def hex_columns(p, centre, rings_n, radius, hmax, falloff, z0=-6.0, step=14.0, lean_az=0.0, lean=0.0, skip=0.0,
                flip=False, hull_tris=20, collide_min=0.0):
    """A bundle of columns on a hexagonal grid, tallest in the middle, stepped down outward."""
    r = p.rng
    pitch = radius * 1.6
    for q in range(-rings_n, rings_n + 1):
        for s in range(-rings_n, rings_n + 1):
            if abs(q + s) > rings_n:
                continue
            x = pitch * (q + s * 0.5)
            y = pitch * s * 0.866
            d = math.hypot(x, y) / (pitch * max(rings_n, 1))
            if d > 0.5 and r.random() < skip:
                continue
            h = hmax * (1.0 - falloff * d ** 1.3) * r.uniform(0.8, 1.1)
            h = max(step, round(h / step) * step + r.uniform(-2.5, 2.5))
            hex_column(p, (centre[0] + x + r.uniform(-1, 1), centre[1] + y + r.uniform(-1, 1), z0),
                       radius * r.uniform(0.95, 1.07), h, spin=r.uniform(0, 60), lean_az=lean_az, lean=lean, flip=flip,
                       collide=h >= collide_min, hull_tris=hull_tris)


# --- Glowing fissures -----------------------------------------------------------------------------


def piece_bvh(p):
    """Ray-castable snapshot of what the piece holds so far (call after the solid shards)."""
    return BVHTree.FromPolygons([v.copy() for v in p.verts], p.faces, all_triangles=False, epsilon=0.0)


def fissure(p, bvh, a, b, direction, width=1.6, color=None, wobble=0.42, lift=0.22, reach=500.0, step=None):
    """A glowing crack: walks from `a` to `b` (points in the air outside the rock) and drops every
    step onto the surface along `direction`. The strip is `width` wide at its middle and tapers."""
    r = p.rng
    a = Vector(a)
    b = Vector(b)
    d = Vector(direction).normalized()
    length = (b - a).length
    step = step or max(width * 1.7, 2.6)
    steps = max(3, int(length / step))
    side = d.cross(b - a)
    if side.length < 1e-6:
        return 0
    side.normalize()
    pts = []
    for i in range(steps + 1):
        t = i / steps
        off = r.uniform(-1, 1) * step * wobble if 0 < i < steps else 0.0
        hit, n, _idx, _dist = bvh.ray_cast(a.lerp(b, t) + side * off, d, reach)
        if hit is None:
            pts.append(None)
            continue
        if n.dot(d) > 0:
            n = -n
        pts.append((hit + n * lift, n.normalized(), t))
    c = color if color is not None else LAVA
    made = 0
    for i in range(len(pts) - 1):
        p0, p1 = pts[i], pts[i + 1]
        if p0 is None or p1 is None:
            continue
        seg = p1[0] - p0[0]
        if seg.length > step * 3.2 or seg.length < 1e-3:
            continue  # jumped across a gap between shards
        t = seg.normalized()
        corners = []
        for (pos, n, u) in (p0, p1):
            s = n.cross(t)
            if s.length < 1e-4:
                s = side.copy()
            s.normalize()
            w = width * 0.5 * (0.3 + 0.7 * math.sin(math.pi * min(max(u, 0.0), 1.0)))
            corners.append((pos - s * w, pos + s * w))
        (a0, b0), (a1, b1) = corners
        add_quad(p, [a0, a1, b1, b0], kind=K_GLOW, color=c * r.uniform(0.75, 1.1), double=False)
        made += 1
    return made


def side_fissures(p, bvh, count, x_range, z_range, face=-1, depth=260.0, width=1.8, slant=0.35):
    """Cracks running up a wall face. `face` -1: the -Y (front) face, +1: the +Y face."""
    r = p.rng
    for i in range(count):
        x0 = x_range[0] + (x_range[1] - x_range[0]) * (i + r.uniform(0.15, 0.85)) / count
        z0 = r.uniform(z_range[0], z_range[0] + (z_range[1] - z_range[0]) * 0.35)
        z1 = r.uniform(z_range[0] + (z_range[1] - z_range[0]) * 0.55, z_range[1])
        x1 = x0 + (z1 - z0) * r.uniform(-slant, slant)
        fissure(p, bvh, (x0, face * depth, z0), (x1, face * depth, z1), (0, -face, 0), width=width * r.uniform(0.7, 1.2))
        if r.random() < 0.6:
            zb = z0 + (z1 - z0) * r.uniform(0.3, 0.7)
            xb = x0 + (x1 - x0) * (zb - z0) / max(z1 - z0, 1e-3)
            fissure(p, bvh, (xb, face * depth, zb), (xb + r.choice((-1, 1)) * r.uniform(10, 24), face * depth, zb + r.uniform(4, 16)),
                    (0, -face, 0), width=width * 0.6)


def radial_fissures(p, bvh, count, r_out, z_top, z_low, centre=(0.0, 0.0), width=1.6, start=0.0, twist=14.0):
    """Cracks running down the flank of something round (a chimney), cast toward its axis."""
    r = p.rng
    for i in range(count):
        a0 = start + 360.0 * (i + r.uniform(0.2, 0.8)) / count
        a1 = a0 + r.uniform(-twist, twist)
        pa = polar(r_out, a0, z_top + r.uniform(-6, 0))
        pb = polar(r_out, a1, z_low + r.uniform(0, 10))
        am = math.radians((a0 + a1) * 0.5)
        fissure(p, bvh, (centre[0] + pa[0], centre[1] + pa[1], pa[2]), (centre[0] + pb[0], centre[1] + pb[1], pb[2]),
                (-math.cos(am), -math.sin(am), 0), width=width * r.uniform(0.7, 1.2))


def under_fissures(p, bvh, count, radius, z_from=-300.0, width=1.5):
    """Cracks across an underside, cast straight up from below."""
    r = p.rng
    for i in range(count):
        a = 360.0 * (i + r.uniform(0.1, 0.9)) / count
        pa = polar(radius * r.uniform(0.12, 0.3), a + r.uniform(-30, 30), z_from)
        pb = polar(radius * r.uniform(0.72, 0.96), a, z_from)
        fissure(p, bvh, pa, pb, (0, 0, 1), width=width * r.uniform(0.7, 1.2), wobble=0.7)


def lava_pool(p, loc, radius, sides=9, color=None):
    """A glowing disc (the throat of a vent): hot in the middle, crusted toward the rim."""
    r = p.rng
    rim = [Vector((loc[0] + math.cos(i * 2 * math.pi / sides) * radius * r.uniform(0.9, 1.08),
                   loc[1] + math.sin(i * 2 * math.pi / sides) * radius * r.uniform(0.9, 1.08), loc[2])) for i in range(sides)]
    mid = [Vector((loc[0] + (v.x - loc[0]) * 0.5, loc[1] + (v.y - loc[1]) * 0.5, loc[2] + radius * 0.03)) for v in rim]
    centre = Vector((loc[0], loc[1], loc[2] + radius * 0.05))
    for i in range(sides):
        j = (i + 1) % sides
        add_quad(p, [rim[i], rim[j], mid[j], mid[i]], kind=K_GLOW, color=(color or LAVA) * r.uniform(0.55, 0.9), double=False)
        add_quad(p, [mid[i], mid[j], centre], kind=K_GLOW, color=LAVA_HOT * r.uniform(0.8, 1.0), double=False)


# --- Finishing: rocklib's build + the glow from below ----------------------------------------------


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def grade(obj, under=0.55, low=0.3, lava=True):
    """Paints the lava's light from below into `Color`: down-facing stone, and the foot of the
    piece (`low` > 0: rooted rocks), take a dark crimson bounce. Glow and team-tint faces are left."""
    me = obj.data
    loops = len(me.loops)
    if loops == 0:
        return
    col_attr = me.attributes["Color"]
    col = np.empty(loops * 4, dtype=np.float32)
    col_attr.data.foreach_get("color", col)
    col = col.reshape(loops, 4)
    masks = np.empty(loops * 4, dtype=np.float32)
    me.attributes["_MASKS"].data.foreach_get("color", masks)
    masks = masks.reshape(loops, 4)
    vert_of = np.empty(loops, dtype=np.int32)
    me.loops.foreach_get("vertex_index", vert_of)
    co = np.empty(len(me.vertices) * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    polys = len(me.polygons)
    normal = np.empty(polys * 3, dtype=np.float32)
    me.polygons.foreach_get("normal", normal)
    normal = normal.reshape(-1, 3)
    totals = np.empty(polys, dtype=np.int32)
    me.polygons.foreach_get("loop_total", totals)
    poly_of = np.repeat(np.arange(polys), totals)
    kinds = np.zeros(polys, dtype=np.int32)
    kind_attr = me.attributes.get("kind")
    if kind_attr is not None:
        kind_attr.data.foreach_get("value", kinds)
    nz = normal[poly_of, 2]
    z = co[vert_of, 2]
    z_lo, z_hi = float(z.min()), float(z.max())
    h = (z - z_lo) / max(z_hi - z_lo, 1e-3)
    k = under * _smooth(0.0, 1.0, (0.15 - nz) / 0.85)
    if low > 0:
        k = np.maximum(k, low * (1.0 - _smooth(0.0, 0.32, h)) * (0.45 + 0.55 * np.clip(0.5 - 0.5 * nz, 0.0, 1.0)))
    k = k * (0.45 + 0.55 * masks[:, 0])
    paintable = np.isin(kinds[poly_of], (K_STONE, K_CHAMFER, K_MASON, K_MOSS, K_DARK)) & (masks[:, 3] < 0.5)
    k = np.where(paintable, k, 0.0)[:, None]
    rgb = col[:, :3]
    col[:, :3] = np.clip(rgb * (1.0 - k) + (rgb * 0.5 + UNDER_GLOW[None, :]) * k, 0.0, 1.0)
    if lava:
        # Glow faces: one dim crimson ramp (rocklib lifts glow colours toward white, which turns
        # red into pink). Heat follows the painted brightness; only pool centres reach LAVA_HOT.
        heat = np.clip(col[:, 0] / 0.62, 0.0, 1.0)
        deep = np.array(LAVA_DEEP, dtype=np.float32)[None, :]
        mid = np.array(LAVA, dtype=np.float32)[None, :]
        hot = np.array(LAVA_HOT, dtype=np.float32)[None, :]
        t = _smooth(0.25, 0.85, heat)[:, None]
        ramp = deep * (1.0 - t) + mid * t
        t2 = _smooth(0.86, 1.0, heat)[:, None]
        ramp = ramp * (1.0 - t2) + hot * t2
        glowing = (masks[:, 3] > 0.5)[:, None]
        col[:, :3] = np.where(glowing, ramp, col[:, :3])
    col_attr.data.foreach_set("color", col.reshape(-1))
    me.update()


def caldera_finish(piece, out_dir, hull_dir, lod_targets, under=0.55, low=0.3, lava=True, **build):
    """rocklib.finish with the caldera grade between painting and the LODs."""
    obj = rocklib.build_object(piece, **build)
    grade(obj, under=under, low=low, lava=lava)
    first = rocklib.tri_count(obj)
    print("RAW %s tris=%d" % (piece.name, first))
    if first > lod_targets[0] * 1.03:
        full = obj
        obj = rocklib.make_lod(full, piece.name + "_L0", lod_targets[0])
        bpy.data.objects.remove(full, do_unlink=True)
        first = rocklib.tri_count(obj)
    lods = [obj]
    ratios = (1.0, 0.42, 0.14)
    for i, target in enumerate(lod_targets[1:], start=1):
        want = int(min(target, first * ratios[min(i, 2)]))
        lods.append(rocklib.make_lod(obj, "%s_L%d" % (piece.name, i), max(want, 40)))
    meta = rocklib.export_asset(piece, lods, out_dir, hull_dir)
    return lods, meta


# --- Recipes --------------------------------------------------------------------------------------


def crater_wall_body(p, heights):
    """A slab of crater rim along X: a sheer inner face toward -Y (glTF +Z, the arena), two
    lower steps of talus behind it (+Y), a broken crest. Base at z = 0."""
    r = p.rng
    n = len(heights)
    xs = [-92 + 184 * i / (n - 1) for i in range(n)]
    for x, h in zip(xs, heights):
        # wide along X, thin along Y, reclining a few degrees outward: neighbours overlap
        add_shard(p, lean_xf((x + r.uniform(-4, 4), r.uniform(-4, 4), -6), 90, r.uniform(3, 7), -90 + r.uniform(-7, 7)),
                  radius=r.uniform(46, 54), height=h + r.uniform(-6, 6), sides=7, taper=r.uniform(0.74, 0.86), rings=4,
                  strata=0.05, cuts=3, cut_depth=(0.8, 0.96), top="double", top_tilt=(8, 24), squash=0.5, bevel=0.04,
                  poke=0.6, hull_tris=22)
    # first step of talus: about two thirds of the wall
    for i in range(4):
        x = -80 + 160 * i / 3 + r.uniform(-8, 8)
        h = heights[min(max(int(round((x + 92) / 184 * (n - 1))), 0), n - 1)]
        add_shard(p, lean_xf((x, 30 + r.uniform(-3, 3), -6), 90, r.uniform(4, 9), -90 + r.uniform(-8, 8)),
                  radius=r.uniform(46, 56), height=h * r.uniform(0.56, 0.7), sides=6, taper=0.7, rings=3, strata=0.05,
                  cuts=3, top="slant", top_tilt=(12, 26), squash=0.5, bevel=0.045, poke=0.5, hull_tris=14)
    # second step: the foot of the outer slope
    for i in range(3):
        x = -66 + 132 * i / 2 + r.uniform(-10, 10)
        add_shard(p, lean_xf((x, 58 + r.uniform(-3, 3), -6), 90, r.uniform(6, 12), -90 + r.uniform(-10, 10)),
                  radius=r.uniform(46, 54), height=min(heights) * r.uniform(0.3, 0.42), sides=6, taper=0.6, rings=2,
                  cuts=3, top="slant", top_tilt=(14, 28), squash=0.5, bevel=0.05, poke=0.4, hull_tris=12)
    # rubble at the foot of the inner face
    for i in range(4):
        x = -84 + 168 * i / 3 + r.uniform(-12, 12)
        add_shard(p, lean_xf((x, -r.uniform(25, 31), -5), 90, r.uniform(2, 10), r.uniform(0, 360)),
                  radius=r.uniform(11, 16), height=r.uniform(22, 48), sides=5, taper=0.45, rings=2, cuts=3, top="slant",
                  bevel=0.07, poke=0.4, hull_tris=10)
    # crest teeth on the tallest slabs
    for x, h in zip(xs, heights):
        if h < max(heights) * 0.8:
            continue
        add_shard(p, lean_xf((x + r.uniform(-22, 22), r.uniform(2, 10), h * 0.92), 90, r.uniform(0, 10), r.uniform(0, 360)),
                  radius=r.uniform(9, 13), height=r.uniform(22, 38), sides=5, taper=0.25, rings=2, cuts=2, top="slant",
                  bevel=0.08, poke=0.0, hull_tris=10)


def crater_wall(p):
    heights = (150, 186, 164, 204, 176)
    crater_wall_body(p, heights)
    bvh = piece_bvh(p)
    side_fissures(p, bvh, 6, (-110, 110), (12, 132), face=-1, width=2.4)
    side_fissures(p, bvh, 2, (-70, 70), (8, 44), face=1, width=1.8)
    fragments(p, (40, 4, 236), 4, 13, 7.5, axis_az=90, axis_tilt=6, rise=1.1)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def crater_breach(p):
    """The rim where it broke: two shoulders and a low saddle between them."""
    heights = (176, 118, 62, 108, 168)
    crater_wall_body(p, heights)
    bvh = piece_bvh(p)
    side_fissures(p, bvh, 6, (-110, 110), (10, 84), face=-1, width=2.4)
    side_fissures(p, bvh, 2, (-30, 30), (8, 40), face=1, width=1.8)
    # what fell out of the gap still hangs above it
    fragments(p, (0, 0, 122), 7, 30, 11, axis_az=90, axis_tilt=10, rise=0.7)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"
    p.meta["opening"] = {"width": 60.0, "height": 100.0, "y": 120.0}


def rim_tooth(p):
    """A broken fang of the rim, hooked toward +X."""
    r = p.rng
    add_shard(p, lean_xf((0, 0, -6), 0, 13, 20), radius=41, height=206, sides=7,
              profile=[(0.0, 1.0), (0.22, 0.82), (0.6, 0.5), (1.0, 0.2)], rings=6, strata=0.06, cuts=5, top="slant",
              top_tilt=(30, 44), squash=0.7, bevel=0.05, poke=0.6, hull_tris=28)
    # the hook
    add_shard(p, lean_xf((43, 0, 186), 0, 46, 30), radius=17, height=62, sides=6,
              profile=[(0.0, 0.9), (0.3, 1.0), (1.0, 0.05)], rings=3, cuts=3, top="none", squash=0.75, bevel=0.06,
              poke=0.4, hull_tris=14)
    for y, h, tilt in ((-30, 124, 9), (31, 96, 7)):
        add_shard(p, lean_xf((r.uniform(-6, 6), y, -5), 0, tilt + r.uniform(-2, 4), r.uniform(0, 360)), radius=r.uniform(19, 23),
                  height=h + r.uniform(-8, 8), sides=6, profile=[(0.0, 1.0), (0.5, 0.6), (1.0, 0.08)], rings=4, strata=0.05,
                  cuts=3, top="none", squash=0.8, bevel=0.06, poke=0.5, hull_tris=14)
    buttresses(p, 5, (34, 46), (13, 19), (34, 78), tilt=(5, 13), start=70, arc=220)
    ledge(p, (-26, 8, 84), 180, 18, 7)
    bvh = piece_bvh(p)
    for a in (-35, 20, 150, 215):
        x, y, _ = polar(260, a)
        fissure(p, bvh, (x, y, r.uniform(8, 20)), (x * 0.96 + r.uniform(-8, 8), y * 0.96 + r.uniform(-8, 8), r.uniform(90, 150)),
                (-math.cos(math.radians(a)), -math.sin(math.radians(a)), 0), width=2.0)
    fragments(p, (86, 0, 246), 4, 11, 7, axis_az=0, axis_tilt=50, rise=0.9)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def cone_wall(p):
    """A segment of the broken cone around the main vent: slabs on an arc along Y, leaning
    inward (+X) with the cone, the inner face cracked and glowing. Four stand around the throat."""
    r = p.rng
    ys = (-68, -34, 0, 34, 68)
    hs = (150, 214, 248, 204, 138)
    for y, h in zip(ys, hs):
        x = y * y / 300.0
        add_shard(p, lean_xf((x + r.uniform(-3, 3), y + r.uniform(-3, 3), -6), 0, r.uniform(14, 18), 90 + r.uniform(-8, 8)),
                  radius=r.uniform(40, 46), height=h + r.uniform(-8, 8), sides=7, taper=r.uniform(0.62, 0.74), rings=5,
                  strata=0.06, cuts=3, cut_depth=(0.8, 0.96), top="double", top_tilt=(12, 30), squash=0.52, bevel=0.045,
                  poke=0.6, hull_tris=22)
    # outer foot: the old slope of the cone
    for i in range(6):
        y = -70 + 140 * i / 5 + r.uniform(-8, 8)
        add_shard(p, lean_xf((y * y / 300.0 - r.uniform(26, 36), y, -5), 0, r.uniform(18, 28), 90 + r.uniform(-20, 20)),
                  radius=r.uniform(22, 30), height=r.uniform(56, 124), sides=r.choice((5, 6)), taper=0.5, rings=3,
                  strata=0.05, cuts=3, top="slant", squash=0.6, bevel=0.06, poke=0.5, hull_tris=12)
    # broken crest
    for y, h in zip(ys[1:4], hs[1:4]):
        add_shard(p, lean_xf((y * y / 300.0 + h * 0.25 + r.uniform(-4, 4), y + r.uniform(-14, 14), h * 0.9), 0, r.uniform(14, 30), r.uniform(0, 360)),
                  radius=r.uniform(8, 12), height=r.uniform(28, 46), sides=5, taper=0.22, rings=2, cuts=2, top="slant",
                  bevel=0.08, poke=0.0, hull_tris=10)
    bvh = piece_bvh(p)
    # inner face: long cracks, hottest low down
    for i in range(6):
        y0 = -70 + 140 * (i + r.uniform(0.2, 0.8)) / 6
        z0 = r.uniform(6, 40)
        z1 = r.uniform(96, 190)
        fissure(p, bvh, (300, y0, z0), (300, y0 + r.uniform(-22, 22), z1), (-1, 0, 0), width=r.uniform(2.0, 3.0))
        if r.random() < 0.7:
            zb = r.uniform(z0 + 20, z1 - 20)
            fissure(p, bvh, (300, y0, zb), (300, y0 + r.choice((-1, 1)) * r.uniform(12, 26), zb + r.uniform(6, 22)), (-1, 0, 0), width=1.5)
    for i in range(2):
        y0 = r.uniform(-50, 50)
        fissure(p, bvh, (-300, y0, r.uniform(10, 30)), (-300, y0 + r.uniform(-14, 14), r.uniform(70, 110)), (1, 0, 0), width=1.7)
    fragments(p, (72, 6, 268), 5, 15, 8, axis_az=0, axis_tilt=24, rise=1.0)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def basalt_columns(p):
    """A stand of basalt columns: organ pipes, stepped down from the middle."""
    r = p.rng
    hex_columns(p, (0, 0), 2, 11.0, 178, 0.62, skip=0.22, collide_min=40, hull_tris=14)
    # a fallen pipe and broken stubs around the foot
    for i in range(5):
        a = i * 72 + r.uniform(-20, 20)
        x, y, _ = polar(r.uniform(44, 52), a)
        hex_column(p, (x, y, -6), r.uniform(7, 9.5), r.uniform(20, 46), spin=r.uniform(0, 60), hull_tris=12, slant=(8, 22))
    bvh = piece_bvh(p)
    radial_fissures(p, bvh, 4, 260, 96, 10, width=1.6)
    fragments(p, (r.uniform(-8, 8), r.uniform(-8, 8), 206), 3, 9, 6, axis_tilt=4, rise=1.2)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def basalt_tall(p):
    """A tall leaning bundle of columns: this map's answer to a spire, never a single needle."""
    r = p.rng
    hex_columns(p, (0, 0), 1, 13.5, 286, 0.3, step=22.0, lean_az=30, lean=4.0, hull_tris=14)
    hex_columns(p, (6, -4), 2, 13.0, 96, 0.5, step=16.0, skip=0.45, hull_tris=12, collide_min=46)
    for z, a in ((148, 200), (206, 40)):
        x, y, _ = polar(24, a)
        ledge(p, (x + z * 0.06, y + z * 0.035, z), a, 14, 6)
    bvh = piece_bvh(p)
    radial_fissures(p, bvh, 3, 260, 150, 12, width=1.5, twist=6)
    fragments(p, (20, 12, 300), 4, 10, 6.5, axis_az=30, axis_tilt=8, rise=1.3)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def obsidian_shards(p):
    """Drifting obsidian: a spray of black blades all pointing roughly one way. Origin: centre."""
    r = p.rng
    blade(p, lean_xf((0, 0, -30), 20, 18, 30), 12.5, 74, floating=True, hull_tris=14)
    spots = [(-22, 10, -4, 8.5), (19, -15, -20, 8), (12, 23, 8, 6.5), (-13, -23, -26, 6), (30, 9, 6, 5.5),
             (-31, -6, -14, 5), (5, -6, 26, 5), (-7, 28, -12, 4.5), (24, -30, 2, 4)]
    for x, y, z, s in spots:
        blade(p, lean_xf((x, y, z - s * 2.2), 20 + r.uniform(-28, 28), 18 + r.uniform(-16, 16), r.uniform(0, 360)), s,
              s * r.uniform(4.6, 6.4), floating=True, collide=s >= 5.0)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "centre"


def obsidian_fan(p):
    """A fan of great obsidian blades splayed out of a basalt root. Base at z = 0."""
    r = p.rng
    add_shard(p, lean_xf((0, 0, -6), 0, 0, 0), radius=40, height=52, sides=8, taper=0.6, rings=3, strata=0.05, cuts=4,
              top="double", bevel=0.05, poke=0.6, hull_tris=22)
    fan = ((-52, 28, 118, 15), (-27, 16, 168, 18), (-4, 4, 214, 21), (22, 15, 176, 18), (47, 30, 126, 15), (68, 44, 84, 12))
    for ang, tilt, h, rad in fan:
        # blades stand in the XZ plane and splay along X
        tilt_az = 0 if ang >= 0 else 180
        blade(p, lean_xf((ang * 0.42, r.uniform(-7, 7), 6), tilt_az, tilt + r.uniform(-3, 3), r.uniform(-20, 20)), rad,
              h + r.uniform(-8, 8), hull_tris=14, squash=0.5)
    for i in range(5):
        a = i * 72 + r.uniform(-25, 25)
        x, y, _ = polar(r.uniform(26, 38), a)
        blade(p, lean_xf((x, y, 2), a, r.uniform(20, 42), r.uniform(0, 360)), r.uniform(6, 9), r.uniform(38, 70), hull_tris=10)
    buttresses(p, 5, (38, 48), (11, 16), (22, 50), tilt=(6, 14), start=30)
    bvh = piece_bvh(p)
    radial_fissures(p, bvh, 5, 260, 46, 6, width=1.8)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"


def ash_island(p, radius, thick, depth, rings_n, col_radius, boulders):
    """A drifting island: ash dunes on top, basalt pipes hanging underneath, the belly cracked
    and lit from below. Origin at the centre of the top (z = 0)."""
    r = p.rng
    add_shard(p, xf((0, 0, -thick)), radius=radius, height=thick, sides=10, irregular=0.16,
              profile=[(0.0, 0.7), (0.45, 1.03), (1.0, 0.95)], rings=2, ring_jitter=0.035, cuts=3, cut_depth=(0.86, 0.97),
              top="flat", bevel=0.03, poke=0.5, hull_tris=28)
    outline = [polar(radius * 0.84 * (1 + r.uniform(-0.08, 0.08)), a)[:2] for a in range(0, 360, 24)]
    # dune: 7 % of the radius high in the middle (src/shared/maps/emberfall-caldera.ts stands props on it)
    add_moss_cap(p, xf((0, 0, -0.6)), outline, lift=radius * 0.07, rings=4, rim_drop=1.6, bumps=1.3)
    # underside: hanging pipes, longest in the middle (the island tore off a column field)
    hex_columns(p, (r.uniform(-3, 3), r.uniform(-3, 3)), rings_n, col_radius, depth, 0.7, z0=-thick * 0.6, step=depth / 6.0,
                flip=True, skip=0.25, hull_tris=14, collide_min=depth * 0.28)
    for i in range(boulders):
        a = r.uniform(0, 360)
        x, y, _ = polar(radius * r.uniform(0.8, 0.94), a)
        add_shard(p, lean_xf((x, y, -thick * 0.5), a, r.uniform(0, 16), r.uniform(0, 360)), radius=radius * r.uniform(0.1, 0.16),
                  height=thick * r.uniform(1.0, 1.7), sides=5, taper=0.5, rings=2, cuts=2, top="slant", bevel=0.08,
                  poke=0.0, hull_tris=10)
    bvh = piece_bvh(p)
    under_fissures(p, bvh, 7, radius, width=radius * 0.03 + 0.5)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "top"
    p.meta["top"] = {"y": 0.0, "radius": round(radius * 0.7, 1)}


def ash_island_large(p):
    ash_island(p, 74, 16, 92, 2, 12.0, 5)


def ash_island_small(p):
    ash_island(p, 37, 11, 62, 1, 10.5, 4)


def vent_chimney(p):
    """A lava-vent chimney: a stubby hollow cone of staves around a glowing throat. Base z = 0."""
    r = p.rng
    count = 8
    top = 0.0
    for i in range(count):
        a = i * 360 / count + r.uniform(-8, 8)
        h = r.uniform(84, 108) if i % 3 else r.uniform(60, 74)
        top = max(top, h)
        x, y, _ = polar(34, a)
        # wide along the ring, leaning in toward the throat
        add_shard(p, lean_xf((x, y, -6), a + 180, r.uniform(7, 10), 90 + r.uniform(-12, 12)), radius=r.uniform(16, 19),
                  height=h, sides=6, taper=0.6, rings=3, strata=0.06, cuts=3, top="slant", top_tilt=(16, 36), squash=0.6,
                  bevel=0.055, poke=0.5, hull_tris=14)
    buttresses(p, 6, (44, 54), (12, 17), (26, 56), tilt=(8, 16), start=20)
    # the throat: a plug nobody can fly into, with the pool on top of it
    pool_z = 56.0
    p.hulls.append(rocklib.convex_hull_of([Vector((math.cos(k * math.pi / 4) * 24, math.sin(k * math.pi / 4) * 24, zz))
                                           for k in range(8) for zz in (-6.0, pool_z - 1.0)]))
    lava_pool(p, (0, 0, pool_z), 27, sides=10)
    bvh = piece_bvh(p)
    radial_fissures(p, bvh, 7, 260, 74, 8, width=2.0)
    fragments(p, (0, 0, top + 34), 5, 16, 5.5, rise=1.0)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"
    p.meta["throat"] = {"y": pool_z, "radius": 24.0}


def lava_arch(p):
    """Two fangs that fell against each other: a pointed arch to thread, along glTF Z. It
    floats, so each foot ends in a tooth pointing down. Origin: between the feet."""
    r = p.rng
    half = 66.0
    for side in (-1, 1):
        add_shard(p, lean_xf((side * half, r.uniform(-3, 3), -4), 0 if side < 0 else 180, 27 + r.uniform(-1.5, 1.5), r.uniform(-12, 12)),
                  radius=25, height=152, sides=6, profile=[(0.0, 1.0), (0.3, 0.86), (0.75, 0.62), (1.0, 0.36)], rings=5,
                  strata=0.06, cuts=4, top="slant", top_tilt=(14, 30), squash=0.82, bevel=0.05, poke=0.6, hull_tris=22)
        add_shard(p, lean_xf((side * (half + 3), 0, 6), 0, 0, r.uniform(0, 360)), flip=True, radius=21, height=64, sides=6,
                  profile=rocklib.SPIKE_PROFILE, rings=3, cuts=3, top="none", bevel=0.06, poke=0.5, hull_tris=14)
        add_shard(p, lean_xf((side * (half + 22), r.uniform(-6, 6), -2), 0 if side < 0 else 180, r.uniform(8, 16), r.uniform(0, 360)),
                  radius=r.uniform(13, 16), height=r.uniform(50, 72), sides=5, taper=0.4, rings=3, cuts=3, top="slant",
                  bevel=0.06, poke=0.4, hull_tris=12)
    # keystone wedge and crest
    add_shard(p, lean_xf((0, 0, 112), 0, r.uniform(-6, 6), r.uniform(0, 360)), radius=21, height=56, sides=6,
              profile=[(0.0, 0.7), (0.3, 1.0), (1.0, 0.1)], rings=3, cuts=3, top="none", squash=0.8, bevel=0.06, poke=0.4,
              hull_tris=14)
    for x, tilt in ((-30, -24), (27, 22)):
        add_shard(p, lean_xf((x, r.uniform(-3, 3), 96 - abs(x) * 0.5), 0, tilt, r.uniform(0, 360)), radius=r.uniform(8, 11),
                  height=r.uniform(26, 40), sides=5, taper=0.25, rings=2, cuts=2, top="slant", bevel=0.08, poke=0.0, hull_tris=10)
    bvh = piece_bvh(p)
    # the inner faces glow where the fangs ground together
    for side in (-1, 1):
        for i in range(3):
            y0 = r.uniform(-14, 14)
            fissure(p, bvh, (0, y0, r.uniform(4, 22)), (0, y0 + r.uniform(-8, 8), r.uniform(56, 84)), (side, 0, 0), width=r.uniform(1.8, 2.6))
    fissure(p, bvh, (-12, -200, 104), (14, -200, 132), (0, 1, 0), width=2.2)
    fissure(p, bvh, (12, 200, 100), (-10, 200, 130), (0, -1, 0), width=2.2)
    p.meta["kind"] = "rock"
    p.meta["anchor"] = "base"
    # clear triangle between the fangs: about 84 m wide at the feet, closing 87 m up
    p.meta["opening"] = {"width": 60.0, "height": 84.0, "y": 34.0}


RECIPES = [
    # id, recipe, seed, under-glow strength, foot-glow strength
    ("crater-wall", crater_wall, 311, 0.5, 0.34),
    ("crater-breach", crater_breach, 317, 0.5, 0.34),
    ("rim-tooth", rim_tooth, 331, 0.5, 0.32),
    ("cone-wall", cone_wall, 337, 0.6, 0.45),
    ("basalt-columns", basalt_columns, 347, 0.5, 0.36),
    ("basalt-tall", basalt_tall, 349, 0.5, 0.3),
    ("obsidian-shards", obsidian_shards, 353, 0.6, 0.0),
    ("obsidian-fan", obsidian_fan, 359, 0.5, 0.34),
    ("ash-island-large", ash_island_large, 367, 0.75, 0.0),
    ("ash-island-small", ash_island_small, 373, 0.75, 0.0),
    ("vent-chimney", vent_chimney, 379, 0.6, 0.5),
    ("lava-arch", lava_arch, 383, 0.65, 0.0),
]


# --- Dusk preview (what the game's Emberfall lighting recipe roughly gives) ------------------------


def setup_dusk(sun_strength=5.0, azimuth_deg=215.0, elevation_deg=12.0, ambient=0.9):
    """Violet sky to an ember horizon, hemisphere ambient sky #6B5A8C / ground #4A2A20, low
    orange sun (ART_DIRECTION "Lighting recipe", Emberfall column)."""
    preview.SUN_COLOR = (1.0, 0.323, 0.107)  # #FF9A5C
    preview.FOG_COLOR = (0.195, 0.076, 0.102)  # #7A4E5A
    world = bpy.data.worlds.get("Dusk") or bpy.data.worlds.new("Dusk")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    neg = nt.nodes.new("ShaderNodeMath")
    neg.operation = "MULTIPLY"
    neg.inputs[1].default_value = -1.0
    nt.links.new(geo.outputs["Incoming"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], neg.inputs[0])
    mapr = nt.nodes.new("ShaderNodeMapRange")
    mapr.inputs["From Min"].default_value = -0.25
    mapr.inputs["From Max"].default_value = 0.9
    nt.links.new(neg.outputs[0], mapr.inputs["Value"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    nt.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
    stops = [
        (0.0, (0.07, 0.016, 0.026, 1)),  # down: the lava-lit ash sea haze
        (0.18, (0.17, 0.045, 0.05, 1)),
        (0.235, (0.62, 0.2, 0.075, 1)),  # ember-orange horizon
        (0.32, (0.3, 0.11, 0.17, 1)),
        (0.5, (0.1, 0.06, 0.17, 1)),
        (1.0, (0.02, 0.016, 0.06, 1)),   # deep violet overhead
    ]
    cr = ramp.color_ramp
    cr.elements[0].position = stops[0][0]
    cr.elements[0].color = stops[0][1]
    cr.elements[1].position = stops[-1][0]
    cr.elements[1].color = stops[-1][1]
    for pos, color in stops[1:-1]:
        cr.elements.new(pos).color = color
    hemi = nt.nodes.new("ShaderNodeMix")
    hemi.data_type = "RGBA"
    hmap = nt.nodes.new("ShaderNodeMapRange")
    hmap.inputs["From Min"].default_value = -1.0
    hmap.inputs["From Max"].default_value = 1.0
    nt.links.new(neg.outputs[0], hmap.inputs["Value"])
    nt.links.new(hmap.outputs["Result"], hemi.inputs["Factor"])
    hemi.inputs["A"].default_value = (0.215, 0.045, 0.03, 1)   # ground: lava-lit, a little above #4A2A20
    hemi.inputs["B"].default_value = (0.147, 0.102, 0.262, 1)  # sky #6B5A8C
    path = nt.nodes.new("ShaderNodeLightPath")
    pick = nt.nodes.new("ShaderNodeMix")
    pick.data_type = "RGBA"
    nt.links.new(path.outputs["Is Camera Ray"], pick.inputs["Factor"])
    nt.links.new(hemi.outputs["Result"], pick.inputs["A"])
    nt.links.new(ramp.outputs["Color"], pick.inputs["B"])
    nt.links.new(pick.outputs["Result"], bg.inputs["Color"])
    amb = nt.nodes.new("ShaderNodeMix")
    amb.data_type = "FLOAT"
    nt.links.new(path.outputs["Is Camera Ray"], amb.inputs["Factor"])
    amb.inputs["A"].default_value = ambient * 1.6
    amb.inputs["B"].default_value = 1.0
    nt.links.new(amb.outputs["Result"], bg.inputs["Strength"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return preview.setup_sun(azimuth_deg, elevation_deg, strength=sun_strength)


def caldera_material(name="CalderaStone", fog_density=0.0, tex="basalt", tex_scale=1.0 / 64.0, emissive=True):
    mat = preview.game_material(name, texture=preview.texture_path(tex), mean=preview.texture_mean(tex),
                                moss_texture=preview.texture_path("ash"), moss_mean=preview.texture_mean("ash"),
                                tex_scale=tex_scale, fog_density=fog_density, emissive=emissive)
    for node in mat.node_tree.nodes:
        if node.type == "EMISSION" and node.inputs["Color"].is_linked:
            node.inputs["Strength"].default_value = 2.4  # the dim crimson has to read as a glow in a still
    return mat


def make_sheet(paths, out_path, cols, cell=(560, 420)):
    """Tiles rendered PNGs into one contact sheet (numpy, no PIL inside Blender)."""
    rows = (len(paths) + cols - 1) // cols
    sheet = np.zeros((rows * cell[1], cols * cell[0], 4), dtype=np.float32)
    sheet[..., 3] = 1.0
    for i, path in enumerate(paths):
        img = bpy.data.images.load(path, check_existing=False)
        img.scale(cell[0], cell[1])
        px = np.empty(cell[0] * cell[1] * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(cell[1], cell[0], 4)
        row = rows - 1 - i // cols  # image rows run bottom-up
        col = i % cols
        sheet[row * cell[1]:(row + 1) * cell[1], col * cell[0]:(col + 1) * cell[0]] = px
        bpy.data.images.remove(img)
    out = bpy.data.images.new("sheet", cols * cell[0], rows * cell[1], alpha=False)
    out.pixels.foreach_set(sheet.reshape(-1))
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    out.filepath_raw = out_path
    out.file_format = "PNG"
    out.save()
    bpy.data.images.remove(out)


def render_previews(built, scratch, sheet_path, cols, material_for, size=(1120, 840), elevation=7.0, lod_pair=True):
    preview.setup_scene(size[0], size[1])
    setup_dusk()
    cam = preview.make_camera(lens=50)
    paths = []
    for name, lods in built.items():
        for o in bpy.data.objects:
            if o.type == "MESH":
                o.hide_render = True
        x = 0.0
        shown = []
        for o in ((lods[0], lods[-1]) if lod_pair and len(lods) > 1 else (lods[0],)):
            o.hide_render = False
            material_for(o)
            o.location.x = x
            lo, hi = preview.bounds_of([o])
            x += (hi.x - lo.x) * 1.15
            shown.append(o)
        bpy.context.view_layer.update()
        preview.frame_objects(cam, shown, azimuth_deg=-70, elevation_deg=elevation, margin=0.6)
        path = os.path.join(scratch, name + ".png")
        preview.render(path)
        paths.append(path)
        for o in lods:
            o.location.x = 0.0
    if sheet_path and paths:
        make_sheet(paths, sheet_path, cols)


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = set(argv[argv.index("--only") + 1].split(",")) if "--only" in argv else None
    apply_caldera_palette()
    rocklib.clear_scene()
    built = {}
    for name, fn, seed, under, low in RECIPES:
        if only is not None and name not in only:
            continue
        piece = Piece(name, seed)
        fn(piece)
        lods, _meta = caldera_finish(piece, OUT_GLB, OUT_HULL, LOD_TARGETS, under=under, low=low, moss=0.85,
                                     moss_threshold=0.7)
        for i, o in enumerate(lods):
            o.name = "%s_LOD%d" % (name, i)
        built[name] = lods
    if only is None:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(CALDERA, "rocks.blend"))
    if "--preview" in argv:
        mat = caldera_material()

        def use(o):
            o.data.materials.clear()
            o.data.materials.append(mat)

        render_previews(built, SCRATCH, os.path.join(PREVIEWS, "rocks-sheet.png") if only is None else None, 4, use)


if __name__ == "__main__":
    main()
