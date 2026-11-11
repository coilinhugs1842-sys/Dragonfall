"""Shared toolbox for the Shattered Spires rock and prop builders (T-4.5).

Everything is authored procedurally (DECISIONS 36): a rock is a set of angular "shards"
(irregular prisms with planar cuts and chamfered edges), painted per face corner with a
hand-painted palette (facet tones, strata bands, baked AO, moss on up-facing faces, cream
chamfers), and exported as one GLB with LOD0..LOD2 nodes plus a JSON of convex collision hulls.

Run through the builders (build_rocks.py / build_props.py) in headless Blender:
  blender -b -P tools/blender/map/build_rocks.py

AXES: authored in Blender space (+Z up). The glTF exporter converts to +Y up; hull JSON is
written in glTF space already: (x, y, z)_gltf = (x, z, -y)_blender.
"""

import json
import math
import os
import random

import bmesh
import bpy
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

# --- Palette (docs/ART_DIRECTION.md, "Palette by role"), sRGB hex -> linear ----------------------


def lin(hex_color):
    def chan(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4

    return Vector((chan((hex_color >> 16) & 255), chan((hex_color >> 8) & 255), chan(hex_color & 255)))


STONE = lin(0x4E6A86)
STONE_LIGHT = lin(0x8199B5)
STONE_MID = lin(0x5A7A9C)
STONE_WARM = lin(0x8A8C96)
STONE_SHADOW = lin(0x2A3346)
STONE_VIOLET = lin(0x5B4C7A)
LIT_EDGE = lin(0xC9B79A)
CREAM = lin(0xF4E6CC)
MOSS = lin(0x3F8F7A)
MOSS_DEEP = lin(0x2C6B62)
MOSS_LIGHT = lin(0x8CC9A1)
MAGENTA = lin(0xFF3FA4)
MAGENTA_HOT = lin(0xFFB4DC)
MAGENTA_DEEP = lin(0x8E1F6B)
EMBER_GLOW = lin(0xFFB15C)
WOOD = lin(0x5A4636)
IRON = lin(0x343A48)
CLOTH = lin(0xE8E2D8)

# Face kinds (int face layer "kind").
K_STONE = 0
K_CHAMFER = 1
K_MOSS = 2  # forced moss (island tops)
K_GLOW = 3  # emissive (crystals, runes, flames)
K_TINT = 4  # team-tintable (banner cloth, gate trim) -> material "TeamTint"
K_DARK = 5  # iron / wood / dark trim
K_MASON = 6  # worked ruin masonry: lighter, warmer stone

# glTF material names (the renderer finds slots by these).
MAT_STONE = "Stone"
MAT_TINT = "TeamTint"


def mix(a, b, t):
    return a * (1.0 - t) + b * t


def clamp01(v):
    return 0.0 if v < 0.0 else 1.0 if v > 1.0 else v


def smoothstep(e0, e1, x):
    t = clamp01((x - e0) / (e1 - e0))
    return t * t * (3.0 - 2.0 * t)


def rot(rx=0.0, ry=0.0, rz=0.0):
    """Euler XYZ in degrees -> 4x4."""
    return (
        Matrix.Rotation(math.radians(rz), 4, "Z")
        @ Matrix.Rotation(math.radians(ry), 4, "Y")
        @ Matrix.Rotation(math.radians(rx), 4, "X")
    )


def xf(loc=(0, 0, 0), rx=0.0, ry=0.0, rz=0.0, scale=1.0):
    m = Matrix.Translation(Vector(loc)) @ rot(rx, ry, rz)
    if isinstance(scale, (int, float)):
        return m @ Matrix.Scale(scale, 4)
    return m @ Matrix.Diagonal(Vector((scale[0], scale[1], scale[2], 1.0)))


# --- Piece container -----------------------------------------------------------------------------


class Piece:
    """Accumulates polygons (any n-gons, later triangulated) and convex collision hulls."""

    def __init__(self, name, seed):
        self.name = name
        self.rng = random.Random(seed)
        self.verts = []
        self.faces = []
        self.kinds = []
        self.colors = []  # optional per-face base colour override (Vector) or None
        self.hulls = []  # list of (verts[Vector], tris[(a,b,c)]) in Blender space
        self.inside_tests = []  # per shard: (lo, hi, planes) for interior face removal
        self.face_owner = []
        self.owner_range = {}
        self._owner = 0
        self.meta = {}

    def add_bmesh(self, bm, matrix, hull=None, kind_override=None, color=None, solid=True):
        """Appends a bmesh (faces carry the int layer 'kind'). `hull`: (verts, tris) local."""
        layer = bm.faces.layers.int.get("kind")
        base = len(self.verts)
        bm.verts.index_update()
        bm.verts.ensure_lookup_table()
        zs = []
        for v in bm.verts:
            w = matrix @ v.co
            self.verts.append(w)
            zs.append(w.z)
        self.owner_range[self._owner] = (min(zs), max(zs)) if zs else (0.0, 1.0)
        flip = matrix.determinant() < 0
        for f in bm.faces:
            idx = [base + v.index for v in f.verts]
            if flip:
                idx.reverse()
            self.faces.append(idx)
            k = f[layer] if layer is not None else K_STONE
            if kind_override is not None and k in (K_STONE, K_CHAMFER):
                k = kind_override if k == K_STONE else k
            self.kinds.append(k)
            self.colors.append(color)
            self.face_owner.append(self._owner)
        if hull is not None:
            hv = [matrix @ v for v in hull[0]]
            ht = [tuple(reversed(t)) for t in hull[1]] if flip else list(hull[1])
            self.hulls.append((hv, ht))
            if solid:
                self.inside_tests.append((self._owner, hull_planes(hv, ht)))
        self._owner += 1


def hull_planes(verts, tris):
    planes = []
    lo = Vector((min(v.x for v in verts), min(v.y for v in verts), min(v.z for v in verts)))
    hi = Vector((max(v.x for v in verts), max(v.y for v in verts), max(v.z for v in verts)))
    for a, b, c in tris:
        n = (verts[b] - verts[a]).cross(verts[c] - verts[a])
        if n.length < 1e-9:
            continue
        n.normalize()
        planes.append((n, n.dot(verts[a])))
    return lo, hi, planes


# --- Shards ---------------------------------------------------------------------------------------


def convex_hull_of(points, target_tris=None):
    """Convex hull of points -> (verts, tris), optionally simplified to about target_tris."""
    bm = bmesh.new()
    for p in points:
        bm.verts.new(p)
    bmesh.ops.convex_hull(bm, input=bm.verts)
    # Drop interior points.
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bmesh.ops.triangulate(bm, faces=bm.faces)
    if target_tris is not None and len(bm.faces) > target_tris:
        # Merge the closest vertex pairs until small enough, then re-hull: stays convex.
        pts = [v.co.copy() for v in bm.verts]
        want_verts = max(5, target_tris // 2 + 2)
        while len(pts) > want_verts:
            best = None
            for i in range(len(pts)):
                for j in range(i + 1, len(pts)):
                    d = (pts[i] - pts[j]).length_squared
                    if best is None or d < best[0]:
                        best = (d, i, j)
            _, i, j = best
            # Keep the point further from the centroid (hull shrinks less).
            c = sum(pts, Vector()) / len(pts)
            drop = j if (pts[i] - c).length_squared >= (pts[j] - c).length_squared else i
            pts.pop(drop)
        bm.free()
        return convex_hull_of(pts, None)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.verts.ensure_lookup_table()
    bm.verts.index_update()
    verts = [v.co.copy() for v in bm.verts]
    tris = [tuple(v.index for v in f.verts) for f in bm.faces]
    bm.free()
    # Outward winding check (signed volume > 0).
    vol = 0.0
    for a, b, c in tris:
        vol += verts[a].dot(verts[b].cross(verts[c]))
    if vol < 0:
        tris = [(a, c, b) for a, b, c in tris]
    return verts, tris


def _fill_cut(bm, cut_geom):
    edges = [e for e in cut_geom if isinstance(e, bmesh.types.BMEdge)]
    if not edges:
        return
    try:
        bmesh.ops.edgeloop_fill(bm, edges=edges)
    except Exception:
        bmesh.ops.holes_fill(bm, edges=edges)


def plane_cut(bm, co, no):
    """Cuts away everything on the +no side of the plane and caps the hole."""
    geom = list(bm.verts) + list(bm.edges) + list(bm.faces)
    res = bmesh.ops.bisect_plane(
        bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no, clear_outer=True, clear_inner=False
    )
    _fill_cut(bm, res["geom_cut"])


SPIRE_PROFILE = None  # default linear taper


def make_shard(
    rng,
    radius,
    height,
    sides=6,
    taper=0.6,
    lean=(0.0, 0.0),
    irregular=0.22,
    rings=3,
    ring_jitter=0.07,
    strata=0.0,
    cuts=3,
    cut_depth=(0.7, 0.95),
    chips=5,
    top="slant",
    top_tilt=(18, 42),
    bevel=0.07,
    bevel_min=3.0,
    poke=0.5,
    profile=None,
    squash=1.0,
    hull_tris=18,
    detail=True,
):
    """One angular chunk, base centred at the origin, rising along +Z.

    profile: optional list of (u, radius multiplier) control points, u in 0..1 along the height;
    replaces the linear taper. Returns (bmesh, hull) with hull = (verts, tris) of the cut shape.
    """
    bm = bmesh.new()
    kind = bm.faces.layers.int.new("kind")

    def radius_at(u):
        if profile is None:
            return 1.0 + (taper - 1.0) * u
        for i in range(len(profile) - 1):
            u0, r0 = profile[i]
            u1, r1 = profile[i + 1]
            if u <= u1:
                t = 0.0 if u1 == u0 else (u - u0) / (u1 - u0)
                return r0 + (r1 - r0) * t
        return profile[-1][1]

    step = 2 * math.pi / sides
    angles = [i * step + rng.uniform(-0.3, 0.3) * step for i in range(sides)]
    radii = [radius * (1.0 + rng.uniform(-irregular, irregular)) for _ in range(sides)]
    # Bands of strata: each band has its own radius factor and centre offset, with a narrow
    # shelf (a step) between neighbouring bands.
    cuts_u = [0.0]
    for li in range(1, rings):
        cuts_u.append((li + rng.uniform(-0.28, 0.28)) / rings)
    cuts_u.append(1.0)
    eps = min(0.012, 0.25 / rings) if strata > 0 else 0.0
    ring_specs = []  # (u, factor, cx, cy)
    for k in range(rings):
        f = 1.0 + (rng.uniform(-1, 1) * (strata if strata > 0 else ring_jitter * 2.0) if rings > 1 else 0.0)
        jx = rng.uniform(-1, 1) * radius * ring_jitter if 0 < k else 0.0
        jy = rng.uniform(-1, 1) * radius * ring_jitter if 0 < k else 0.0
        u0 = cuts_u[k] + (eps if k > 0 else 0.0)
        u1 = cuts_u[k + 1] - (eps if k < rings - 1 else 0.0)
        if strata > 0:
            ring_specs.append((u0, f, jx, jy))
            ring_specs.append((u1, f, jx, jy))
        else:
            if k == 0:
                ring_specs.append((0.0, 1.0, 0.0, 0.0))
            ring_specs.append((cuts_u[k + 1], 1.0 if k == rings - 1 else f, 0.0 if k == rings - 1 else jx, 0.0 if k == rings - 1 else jy))
    ring_verts = []
    wobble = [[1.0 + rng.uniform(-1, 1) * ring_jitter * 0.5 for _ in range(sides)] for _ in ring_specs]
    for ri, (u, f, jx, jy) in enumerate(ring_specs):
        z = height * u
        cx = lean[0] * u + jx
        cy = lean[1] * u + jy
        rmul = radius_at(u) * f
        ring = []
        for si, (a, r) in enumerate(zip(angles, radii)):
            rr = max(r * rmul * wobble[ri][si], radius * 0.02)
            ring.append(bm.verts.new((cx + math.cos(a) * rr, (cy + math.sin(a) * rr) * squash, z)))
        ring_verts.append(ring)
    for li in range(len(ring_verts) - 1):
        lo, hi = ring_verts[li], ring_verts[li + 1]
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.faces.new(list(reversed(ring_verts[0])))
    bm.faces.new(ring_verts[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)

    top_center = Vector((lean[0], lean[1] * squash, height))
    top_r = radius * max(radius_at(1.0), 0.05)
    if top == "slant":
        tilt = math.radians(rng.uniform(*top_tilt))
        az = rng.uniform(0, 2 * math.pi)
        no = Vector((math.sin(tilt) * math.cos(az), math.sin(tilt) * math.sin(az), math.cos(tilt)))
        co = top_center - Vector((0, 0, top_r * math.tan(tilt) * rng.uniform(0.5, 0.95)))
        plane_cut(bm, co, no)
    elif top == "double":
        for _ in range(2):
            tilt = math.radians(rng.uniform(*top_tilt))
            az = rng.uniform(0, 2 * math.pi)
            no = Vector((math.sin(tilt) * math.cos(az), math.sin(tilt) * math.sin(az), math.cos(tilt)))
            co = top_center - Vector((0, 0, top_r * math.tan(tilt) * rng.uniform(0.3, 0.8)))
            plane_cut(bm, co, no)

    def side_cut(depth_range):
        u = rng.uniform(0.1, 0.94)
        az = rng.uniform(0, 2 * math.pi)
        r_here = radius * max(radius_at(u), 0.15)
        rho = r_here * rng.uniform(*depth_range)
        # Tilt limits: the plane must leave the shard's axis beyond both ends, or it would
        # chop the whole top (or bottom) off instead of shaving a side.
        hi_max = math.degrees(math.atan2(rho, height * (1.0 - u) + radius * 0.6))
        lo_max = math.degrees(math.atan2(rho, height * u + radius * 0.6))
        el = math.radians(rng.uniform(-min(lo_max, 30.0), min(hi_max, 30.0)))
        d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
        centre = Vector((lean[0] * u, lean[1] * u * squash, height * u))
        co = centre + Vector((math.cos(az), math.sin(az) * squash, 0)) * rho
        plane_cut(bm, co, d)

    for _ in range(cuts):
        side_cut(cut_depth)
    for _ in range(chips if detail else 0):
        side_cut((0.9, 1.04))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if len(bm.verts) < 4:
        return bm, ([], [])
    hull = convex_hull_of([v.co.copy() for v in bm.verts], hull_tris)
    if len(hull[0]) < 4:
        return bm, ([], [])

    if detail:
        if bevel > 0:
            width = radius * bevel
            edges = []
            for e in bm.edges:
                if len(e.link_faces) == 2:
                    ang = e.calc_face_angle(0.0)
                    if ang > math.radians(24) and e.calc_length() > width * bevel_min:
                        edges.append(e)
            if edges:
                before = set(bm.faces)
                res = bmesh.ops.bevel(
                    bm,
                    geom=edges,
                    offset=width * rng.uniform(0.8, 1.3),
                    offset_type="OFFSET",
                    segments=1,
                    profile=0.5,
                    affect="EDGES",
                    clamp_overlap=True,
                )
                for f in res["faces"]:
                    if f.is_valid and f not in before:
                        f[kind] = K_CHAMFER
                # bevel reports rebuilt neighbours too: keep only thin strips as chamfers.
                for f in bm.faces:
                    if f[kind] == K_CHAMFER:
                        per = sum(e.calc_length() for e in f.edges)
                        if per <= 0 or f.calc_area() / per > width * 0.9:
                            f[kind] = K_STONE
        if poke > 0:
            big = [
                f
                for f in bm.faces
                if f[kind] == K_STONE and f.calc_area() > (radius * 0.75) ** 2 and len(f.verts) >= 4
            ]
            chosen = [f for f in big if rng.random() < poke]
            if chosen:
                normals = {f: f.normal.copy() for f in chosen}
                centres = {f: f.calc_center_median() for f in chosen}
                res = bmesh.ops.poke(bm, faces=chosen)
                for v in res["verts"]:
                    # nearest source face centre
                    best = min(chosen_centres := list(centres.items()), key=lambda it: (it[1] - v.co).length_squared)
                    n = normals[best[0]]
                    pass
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm, hull


def add_shard(piece, matrix, flip=False, kind=None, color=None, collide=True, **params):
    """Builds a shard with the piece's RNG and adds it. `flip` points it down (-Z)."""
    bm = None
    for _attempt in range(4):
        bm, hull = make_shard(piece.rng, **params)
        if len(hull[0]) >= 4 and len(bm.faces) >= 4:
            break
        bm.free()
        bm = None
    if bm is None:
        print("SKIPPED degenerate shard in", piece.name)
        return
    m = matrix @ Matrix.Diagonal(Vector((1, -1, -1, 1))) if flip else matrix
    piece.add_bmesh(bm, m, hull if collide else None, kind_override=kind, color=color)
    if not collide:
        # still used for hidden-face removal
        hv = [m @ v for v in hull[0]]
        piece.inside_tests.append((piece._owner - 1, hull_planes(hv, hull[1])))
    bm.free()


FLOAT_PROFILE = [(0.0, 0.12), (0.3, 1.0), (0.62, 0.85), (1.0, 0.18)]
SPIKE_PROFILE = [(0.0, 1.0), (0.35, 0.72), (1.0, 0.06)]
BELLY_PROFILE = [(0.0, 0.8), (0.3, 1.0), (1.0, 0.5)]


def add_box(piece, matrix, size, kind=K_STONE, bevel=0.0, color=None, collide=True, jitter=0.0):
    """A (slightly irregular) block, centred on its base centre; size = (x, y, z)."""
    rng = piece.rng
    bm = bmesh.new()
    layer = bm.faces.layers.int.new("kind")
    sx, sy, sz = size[0] * 0.5, size[1] * 0.5, size[2]
    co = []
    for z in (0, sz):
        for x, y in ((-sx, -sy), (sx, -sy), (sx, sy), (-sx, sy)):
            j = jitter * min(size)
            co.append(bm.verts.new((x + rng.uniform(-j, j), y + rng.uniform(-j, j), z + (rng.uniform(-j, j) if z else 0))))
    quads = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for q in quads:
        f = bm.faces.new([co[i] for i in q])
        f[layer] = kind
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    hull = convex_hull_of([v.co.copy() for v in bm.verts]) if collide else None
    if bevel > 0:
        before = set(bm.faces)
        res = bmesh.ops.bevel(
            bm, geom=list(bm.edges), offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
            affect="EDGES", clamp_overlap=True,
        )
        for f in res["faces"]:
            if f.is_valid and f not in before:
                per = sum(e.calc_length() for e in f.edges)
                if per > 0 and f.calc_area() / per <= bevel * 0.9:
                    f[layer] = K_CHAMFER if kind in (K_STONE, K_MASON) else kind
                else:
                    f[layer] = kind
    piece.add_bmesh(bm, matrix, hull, color=color)
    bm.free()


def add_prism(piece, matrix, radius, height, sides=8, taper=1.0, kind=K_STONE, bevel=0.0, color=None,
              collide=True, cap=True, hull_tris=16):
    bm = bmesh.new()
    layer = bm.faces.layers.int.new("kind")
    lo = [bm.verts.new((math.cos(i * 2 * math.pi / sides) * radius, math.sin(i * 2 * math.pi / sides) * radius, 0)) for i in range(sides)]
    hi = [bm.verts.new((math.cos(i * 2 * math.pi / sides) * radius * taper, math.sin(i * 2 * math.pi / sides) * radius * taper, height)) for i in range(sides)]
    for i in range(sides):
        j = (i + 1) % sides
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))[layer] = kind
    if cap:
        bm.faces.new(list(reversed(lo)))[layer] = kind
        bm.faces.new(hi)[layer] = kind
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    hull = convex_hull_of([v.co.copy() for v in bm.verts], hull_tris) if collide else None
    if bevel > 0 and cap:
        before = set(bm.faces)
        ring = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-6]
        res = bmesh.ops.bevel(bm, geom=ring, offset=bevel, offset_type="OFFSET", segments=1, profile=0.5,
                              affect="EDGES", clamp_overlap=True)
        for f in res["faces"]:
            if f.is_valid and f not in before:
                per = sum(e.calc_length() for e in f.edges)
                if per > 0 and f.calc_area() / per <= bevel * 0.9:
                    f[layer] = K_CHAMFER if kind in (K_STONE, K_MASON) else kind
                else:
                    f[layer] = kind
    piece.add_bmesh(bm, matrix, hull, color=color)
    bm.free()


def add_moss_cap(piece, matrix, outline, lift=1.2, rings=3, rim_drop=1.6, bumps=1.0):
    """A gently rolling mossy top over a convex outline (list of (x, y)), z=0 at the rim plane."""
    rng = piece.rng
    bm = bmesh.new()
    layer = bm.faces.layers.int.new("kind")
    n = len(outline)
    centre = Vector((sum(p[0] for p in outline) / n, sum(p[1] for p in outline) / n, 0))
    seed_off = Vector((rng.uniform(0, 50), rng.uniform(0, 50), rng.uniform(0, 50)))
    loops = []
    for r in range(rings + 1):
        t = 1.0 - r / (rings + 0.35)  # 1 at the rim
        loop = []
        for x, y in outline:
            p = centre.lerp(Vector((x, y, 0)), t)
            size = (Vector((x, y, 0)) - centre).length
            h = noise.noise(Vector((p.x, p.y, 0)) * (2.2 / max(size, 1)) + seed_off) * bumps * lift
            p.z = lift * (1.0 - t * t) + h * (1.0 - t * 0.7) - (rim_drop if r == 0 else 0.0)
            if r == 0:
                p.x = centre.x + (x - centre.x) * 1.03
                p.y = centre.y + (y - centre.y) * 1.03
            loop.append(bm.verts.new(p))
        loops.append(loop)
    mid = bm.verts.new(centre + Vector((0, 0, lift * 1.05)))
    for r in range(rings):
        a, b = loops[r], loops[r + 1]
        for i in range(n):
            j = (i + 1) % n
            f = bm.faces.new((a[i], a[j], b[j], b[i]))
            f[layer] = K_MOSS
    last = loops[-1]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((last[i], last[j], mid))[layer] = K_MOSS
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    for f in bm.faces:
        if f.normal.z < 0:
            f.normal_flip()
    piece.add_bmesh(bm, matrix, None)
    bm.free()


def add_tube(piece, points, radius, sides=5, kind=K_STONE, taper=0.3, color=None):
    """A tapered bent tube along points (roots, chains' rods, poles). No collision."""
    bm = bmesh.new()
    layer = bm.faces.layers.int.new("kind")
    pts = [Vector(p) for p in points]
    loops = []
    for i, p in enumerate(pts):
        if i == 0:
            t = pts[1] - pts[0]
        elif i == len(pts) - 1:
            t = pts[-1] - pts[-2]
        else:
            t = pts[i + 1] - pts[i - 1]
        t.normalize()
        ref = Vector((1, 0, 0)) if abs(t.x) < 0.8 else Vector((0, 1, 0))
        u = t.cross(ref).normalized()
        v = t.cross(u)
        u_param = i / (len(pts) - 1)
        r = radius * (1.0 + (taper - 1.0) * u_param)
        loops.append([bm.verts.new(p + (u * math.cos(k * 2 * math.pi / sides) + v * math.sin(k * 2 * math.pi / sides)) * r) for k in range(sides)])
    for i in range(len(loops) - 1):
        a, b = loops[i], loops[i + 1]
        for k in range(sides):
            j = (k + 1) % sides
            bm.faces.new((a[k], a[j], b[j], b[k]))[layer] = kind
    bm.faces.new(list(reversed(loops[0])))[layer] = kind
    bm.faces.new(loops[-1])[layer] = kind
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    piece.add_bmesh(bm, Matrix.Identity(4), None, color=color)
    bm.free()


def add_quad(piece, corners, kind=K_STONE, color=None, double=True):
    """A flat polygon (banner cloth, cards); `double` adds the back face."""
    bm = bmesh.new()
    layer = bm.faces.layers.int.new("kind")
    vs = [bm.verts.new(c) for c in corners]
    bm.faces.new(vs)[layer] = kind
    if double:
        vs2 = [bm.verts.new(c) for c in corners]
        bm.faces.new(list(reversed(vs2)))[layer] = kind
    piece.add_bmesh(bm, Matrix.Identity(4), None, color=color)
    bm.free()


# --- Finishing: interior removal, painting, UVs, LODs, export ------------------------------------


def _remove_hidden_faces(piece):
    """Drops faces that lie completely inside another shard's convex hull."""
    keep = []
    margin = 0.02
    for fi, face in enumerate(piece.faces):
        owner = piece.face_owner[fi]
        pts = [piece.verts[i] for i in face]
        hidden = False
        for other, (lo, hi, planes) in piece.inside_tests:
            if other == owner:
                continue
            ok = True
            for p in pts:
                if p.x < lo.x or p.y < lo.y or p.z < lo.z or p.x > hi.x or p.y > hi.y or p.z > hi.z:
                    ok = False
                    break
            if not ok:
                continue
            inside = True
            for n, d in planes:
                for p in pts:
                    if n.dot(p) > d - margin:
                        inside = False
                        break
                if not inside:
                    break
            if inside:
                hidden = True
                break
        keep.append(not hidden)
    return keep


def _hemisphere_dirs(count):
    dirs = []
    golden = math.pi * (3 - math.sqrt(5))
    for i in range(count):
        z = (i + 0.5) / count
        r = math.sqrt(1 - z * z)
        dirs.append(Vector((math.cos(i * golden) * r, math.sin(i * golden) * r, z)))
    return dirs


AO_DIRS = _hemisphere_dirs(14)


def build_object(piece, ao_scale=0.28, moss=1.0, uv_scale=1.0 / 64.0, moss_threshold=0.62):
    """Piece -> Blender object with painted corner colours, `_MASKS`, UVs, sharp edges."""
    keep = _remove_hidden_faces(piece)
    bm = bmesh.new()
    kind_layer = bm.faces.layers.int.new("kind")
    tone_layer = bm.faces.layers.float.new("tone")
    g0_layer = bm.faces.layers.float.new("g0")
    g1_layer = bm.faces.layers.float.new("g1")
    used = {}
    face_colors = {}
    for fi, face in enumerate(piece.faces):
        if not keep[fi]:
            continue
        vs = []
        for i in face:
            if i not in used:
                used[i] = bm.verts.new(piece.verts[i])
            vs.append(used[i])
        if len(set(vs)) < 3:
            continue
        try:
            f = bm.faces.new(vs)
        except ValueError:
            continue
        f[kind_layer] = piece.kinds[fi]
        f[tone_layer] = piece.rng.random()
        zr = piece.owner_range[piece.face_owner[fi]]
        f[g0_layer] = zr[0]
        f[g1_layer] = zr[1]
        if piece.colors[fi] is not None:
            face_colors[f] = piece.colors[fi]
    # weld shared verts inside a shard is already implicit; triangulate for export
    color_by_index = {}
    bm.faces.index_update()
    for f, c in face_colors.items():
        color_by_index[f.index] = c
    res = bmesh.ops.triangulate(bm, faces=bm.faces)
    for new_face, old_face in res["face_map"].items():
        if old_face in face_colors:
            face_colors[new_face] = face_colors[old_face]
    for f in bm.faces:
        f.smooth = True
    bm.normal_update()
    mesh = bpy.data.meshes.new(piece.name)
    paint(bm, piece, face_colors, ao_scale, moss, uv_scale, moss_threshold)
    mark_sharp(bm)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(piece.name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    assign_materials(obj)
    return obj


def mark_sharp(bm, angle=26.0):
    limit = math.radians(angle)
    for e in bm.edges:
        if len(e.link_faces) == 2:
            e.smooth = e.calc_face_angle(0.0) < limit
        else:
            e.smooth = False


def paint(bm, piece, face_colors, ao_scale, moss_amount, uv_scale, moss_threshold):
    """Per-corner painted albedo (linear) + `_MASKS` (ao, moss, lit edge, glow) + box UVs."""
    kind_layer = bm.faces.layers.int["kind"]
    tone_layer = bm.faces.layers.float["tone"]
    g0_layer = bm.faces.layers.float["g0"]
    g1_layer = bm.faces.layers.float["g1"]
    col = bm.loops.layers.float_color.new("Color")
    masks = bm.loops.layers.float_color.new("_MASKS")
    uv = bm.loops.layers.uv.new("UVMap")

    zs = [v.co.z for v in bm.verts]
    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    z_lo, z_hi = min(zs), max(zs)
    extent = max(max(xs) - min(xs), max(ys) - min(ys), z_hi - z_lo, 1e-3)
    span = max(z_hi - z_lo, 1e-3)
    max_dist = extent * ao_scale
    tree = BVHTree.FromBMesh(bm, epsilon=0.0)
    seed = Vector((piece.rng.uniform(0, 100), piece.rng.uniform(0, 100), piece.rng.uniform(0, 100)))
    ao_cache = {}
    stone_kinds = (K_STONE, K_CHAMFER, K_MASON)

    def ao_at(co, n):
        key = (round(co.x, 3), round(co.y, 3), round(co.z, 3), round(n.x, 1), round(n.y, 1), round(n.z, 1))
        hit = ao_cache.get(key)
        if hit is not None:
            return hit
        ref = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
        t = n.cross(ref).normalized()
        b = n.cross(t)
        origin = co + n * (extent * 0.002 + 0.01)
        occ = 0.0
        for d in AO_DIRS:
            w = t * d.x + b * d.y + n * d.z
            loc, _, _, dist = tree.ray_cast(origin, w, max_dist)
            if loc is not None:
                occ += 1.0 - (dist / max_dist) ** 0.6
        value = 1.0 - occ / len(AO_DIRS)
        ao_cache[key] = value
        return value

    blotch_f = 3.2 / extent
    for f in bm.faces:
        n = f.normal
        k = f[kind_layer]
        tone = f[tone_layer]
        centre = f.calc_center_median()
        override = face_colors.get(f)
        g0 = f[g0_layer]
        g1 = max(f[g1_layer], g0 + 1e-3)
        up = n.z
        # Horizontal strata: tone bands along the height, wobbling a little sideways.
        band = noise.noise(Vector((centre.x * 0.012, centre.y * 0.012, centre.z * (13.0 / extent))) + seed)
        if k in stone_kinds:
            base = mix(STONE_LIGHT, STONE_MID, clamp01(0.55 + (tone - 0.5) * 0.9 - band * 0.7))
            if band > 0.3:
                base = mix(base, STONE_WARM, clamp01((band - 0.3) * 1.4))
            if tone > 0.85:
                base = mix(base, CREAM, 0.22)
            elif tone < 0.14:
                base = mix(base, STONE_VIOLET, 0.45)
            if k == K_MASON:
                base = mix(base, STONE_WARM, 0.5) * 1.15
        elif k == K_MOSS:
            base = mix(MOSS, MOSS_LIGHT, clamp01(0.1 + tone * 0.3))
        elif k == K_GLOW:
            base = mix(MAGENTA_DEEP, MAGENTA, clamp01(0.35 + tone * 0.9))
            if up > 0.25 or tone > 0.8:
                base = mix(base, MAGENTA_HOT, 0.3)
        elif k == K_TINT:
            base = Vector((0.86, 0.86, 0.86))
        else:
            base = mix(IRON, WOOD, tone * 0.4)
        if override is not None:
            if k == K_GLOW:
                base = mix(override * 0.55, override, clamp01(0.3 + tone))
                if up > 0.25 or tone > 0.8:
                    base = mix(base, Vector((1, 1, 1)), 0.1)
            else:
                base = override * (0.88 + tone * 0.24)
        for loop in f.loops:
            co = loop.vert.co
            h = (co.z - z_lo) / span
            hs = clamp01((co.z - g0) / (g1 - g0))  # height inside this shard
            ao = ao_at(co, n) if k != K_GLOW else 1.0
            c = base.copy()
            moss_m = 0.0
            edge_m = 0.0
            glow_m = 0.0
            if k in stone_kinds:
                # big soft brush blotches across facets
                blotch = noise.noise(co * blotch_f + seed * 0.7)
                if blotch > 0:
                    c = mix(c, mix(STONE_LIGHT, CREAM, 0.3), clamp01(blotch * 0.5))
                else:
                    c = mix(c, mix(STONE, STONE_VIOLET, 0.5), clamp01(-blotch * 0.6))
                # painted sky light: warm from above, cool violet from below
                c = c * (0.8 + 0.3 * (up * 0.5 + 0.5))
                if up > 0.15:
                    c = mix(c, LIT_EDGE, 0.3 * up)
                else:
                    c = mix(c, STONE_VIOLET * 0.8, 0.3 * clamp01(-up + 0.15))
                # each shard is painted lighter toward its crown, the whole rock toward its top
                c = c * (0.82 + 0.26 * hs)
                c = mix(mix(c, STONE, 0.5) * 0.72, c * 1.06, smoothstep(0.0, 0.55, h))
                if k == K_CHAMFER:
                    lit = clamp01(0.5 + up * 0.6)
                    edge_m = 0.3 + 0.7 * lit
                    c = mix(c, mix(STONE_LIGHT, CREAM * 0.95, lit), 0.45 + 0.5 * lit)
                # moss on up-facing faces, patchy
                if moss_amount > 0 and k != K_MASON:
                    patch = noise.noise(co * (5.0 / extent) + seed * 1.7)
                    m = smoothstep(moss_threshold, 0.9, up + patch * 0.22) * moss_amount
                    if m > 0:
                        mc = mix(MOSS_DEEP, MOSS, clamp01(0.5 + patch)) if tone < 0.6 else mix(MOSS, MOSS_LIGHT, 0.5)
                        c = mix(c, mc, clamp01(m))
                        moss_m = clamp01(m)
                        edge_m *= 1.0 - moss_m
            elif k == K_MOSS:
                patch = noise.noise(co * (7.0 / extent) + seed * 2.3)
                c = mix(c, MOSS_DEEP, clamp01(-patch * 1.3))
                c = mix(c, MOSS_LIGHT, clamp01(patch * 1.1) * 0.7)
                c = c * (0.82 + 0.3 * clamp01(up))
                moss_m = 1.0
            elif k == K_GLOW:
                glow_m = 1.0
                c = c * (0.8 + 0.35 * hs)
            elif k == K_TINT:
                c = c * (0.72 + 0.28 * (up * 0.5 + 0.5)) * (0.85 + 0.15 * hs)
            else:
                c = c * (0.7 + 0.4 * (up * 0.5 + 0.5))
            if k != K_GLOW:
                shade = clamp01(ao * 1.08) ** 1.9
                if k == K_TINT:
                    c = mix(c * 0.5, c, shade)
                else:
                    c = mix(mix(STONE_SHADOW, c * 0.4, 0.4), c, shade)
            loop[col] = (clamp01(c.x), clamp01(c.y), clamp01(c.z), 1.0)
            loop[masks] = (ao, moss_m, edge_m, glow_m)
            # box-projected UV in metres
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            if az >= ax and az >= ay:
                loop[uv].uv = (co.x * uv_scale, co.y * uv_scale)
            elif ax >= ay:
                loop[uv].uv = (co.y * uv_scale, co.z * uv_scale)
            else:
                loop[uv].uv = (co.x * uv_scale, co.z * uv_scale)


_materials = {}


def material(name):
    """Preview/export material: painted vertex colour as base colour (glTF COLOR_0)."""
    if name in _materials:
        return _materials[name]
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Color"
    nt.links.new(attr.outputs["Color"], bsdf.inputs["Base Color"])
    _materials[name] = mat
    return mat


def assign_materials(obj):
    """Slot 0 = Stone; faces of kind K_TINT go to slot TeamTint (only when present)."""
    mesh = obj.data
    mesh.materials.clear()
    mesh.materials.append(material(MAT_STONE))
    kinds = mesh.attributes.get("kind")
    if kinds is None:
        return
    has_tint = any(d.value == K_TINT for d in kinds.data)
    if has_tint:
        mesh.materials.append(material(MAT_TINT))
        for poly, d in zip(mesh.polygons, kinds.data):
            poly.material_index = 1 if d.value == K_TINT else 0


def tri_count(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def make_lod(obj, name, target_tris):
    """Collapse-decimated copy with about target_tris triangles."""
    current = tri_count(obj)
    copy = obj.copy()
    copy.data = obj.data.copy()
    copy.name = name
    bpy.context.scene.collection.objects.link(copy)
    if current <= target_tris:
        return copy
    mod = copy.modifiers.new("dec", "DECIMATE")
    mod.ratio = target_tris / current
    mod.use_collapse_triangulate = True
    dg = bpy.context.evaluated_depsgraph_get()
    new_mesh = bpy.data.meshes.new_from_object(copy.evaluated_get(dg))
    copy.modifiers.clear()
    old = copy.data
    copy.data = new_mesh
    bpy.data.meshes.remove(old)
    bm = bmesh.new()
    bm.from_mesh(new_mesh)
    for f in bm.faces:
        f.smooth = True
    mark_sharp(bm, 30.0)
    bm.to_mesh(new_mesh)
    bm.free()
    return copy


def strip_internal_attributes(obj):
    mesh = obj.data
    for name in ("kind", "tone", "g0", "g1"):
        a = mesh.attributes.get(name)
        if a is not None:
            mesh.attributes.remove(a)
    ca = mesh.color_attributes.get("Color")
    if ca is not None:
        mesh.color_attributes.active_color = ca
        mesh.color_attributes.render_color_index = list(mesh.color_attributes).index(ca)


def to_gltf_space(v):
    return [round(v.x, 3), round(v.z, 3), round(-v.y, 3)]


def export_asset(piece, lods, out_dir, hull_dir, extra_meta=None):
    """Writes <name>.glb (LOD nodes) and <name>.json (hulls + metadata)."""
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(hull_dir, exist_ok=True)
    tris = [tri_count(o) for o in lods]
    for o in bpy.context.scene.objects:
        o.select_set(False)
    for i, o in enumerate(lods):
        o.name = "LOD%d" % i
        o.data.name = "%s_LOD%d" % (piece.name, i)
        strip_internal_attributes(o)
        o.select_set(True)
    bpy.context.view_layer.objects.active = lods[0]
    path = os.path.join(out_dir, piece.name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=False,
        export_attributes=True,
        export_vertex_color="ACTIVE",
        export_all_vertex_colors=False,
        export_active_vertex_color_when_no_material=True,
        export_normals=True,
        export_texcoords=True,
        export_materials="EXPORT",
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_cameras=False,
        export_lights=False,
    )
    verts0 = [v.co for v in lods[0].data.vertices]
    lo = Vector((min(v.x for v in verts0), min(v.y for v in verts0), min(v.z for v in verts0)))
    hi = Vector((max(v.x for v in verts0), max(v.y for v in verts0), max(v.z for v in verts0)))
    radius = max(v.length for v in verts0)
    hulls = []
    hull_tris = 0
    for hv, ht in piece.hulls:
        hulls.append({"verts": [to_gltf_space(v) for v in hv], "tris": [list(t) for t in ht]})
        hull_tris += len(ht)
    meta = {
        "id": piece.name,
        "triangles": tris,
        "hasTint": any(len(o.data.materials) > 1 for o in lods),
        "boundsMin": [round(lo.x, 2), round(lo.z, 2), round(-hi.y, 2)],
        "boundsMax": [round(hi.x, 2), round(hi.z, 2), round(-lo.y, 2)],
        "radius": round(radius, 2),
        "hullTriangles": hull_tris,
        "hulls": hulls,
    }
    meta.update(piece.meta)
    if extra_meta:
        meta.update(extra_meta)
    with open(os.path.join(hull_dir, piece.name + ".json"), "w") as fh:
        json.dump(meta, fh, separators=(",", ":"))
    print("EXPORTED %s tris=%s hullTris=%d hulls=%d" % (piece.name, tris, hull_tris, len(hulls)))
    return meta


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for m in list(bpy.data.meshes):
        bpy.data.meshes.remove(m)


def finish(piece, out_dir, hull_dir, lod_targets, keep=False, **build):
    """build_object + LODs + export. Returns (lod objects, meta)."""
    obj = build_object(piece, **build)
    first = tri_count(obj)
    print("RAW %s tris=%d" % (piece.name, first))
    if first > lod_targets[0] * 1.03:
        full = obj
        obj = make_lod(full, piece.name + "_L0", lod_targets[0])
        bpy.data.objects.remove(full, do_unlink=True)
        first = tri_count(obj)
    lods = [obj]
    ratios = (1.0, 0.42, 0.14)
    for i, target in enumerate(lod_targets[1:], start=1):
        want = int(min(target, first * ratios[min(i, 2)]))
        lods.append(make_lod(obj, "%s_L%d" % (piece.name, i), max(want, 40)))
    meta = export_asset(piece, lods, out_dir, hull_dir)
    return lods, meta
