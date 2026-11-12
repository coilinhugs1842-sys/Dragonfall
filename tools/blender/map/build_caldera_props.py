"""Builds the Emberfall Caldera props, team gate and backdrops (T-6.4).

  blender -b -P tools/blender/map/build_caldera_props.py -- [--only id,id] [--preview]

Output: art-source/maps/caldera/props/<id>.glb + art-source/maps/caldera/hulls/<id>.json,
art-source/maps/caldera/props.blend, and with --preview one PNG per prop under
art-source/maps/caldera/_scratch/props/ plus art-source/maps/caldera/previews/props-sheet.png.

Banners, chains and the sky-well crystal are NOT rebuilt here: the map manifest points at the
Shattered Spires files for those (a prop set carries its own GLB path).

Colour rules on this map: magenta glow = "fly here" (heat-vent markers, like every pickup and
objective), crimson glow = lava (scenery), TeamTint = team cloth and trim. No orange flames: the
only orange in the caldera is team Ember.
"""

import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import build_caldera_rocks as cr
import preview
import rocklib
from rocklib import (
    K_DARK,
    K_GLOW,
    K_MASON,
    K_TINT,
    MAGENTA,
    MAGENTA_DEEP,
    MAGENTA_HOT,
    Piece,
    add_box,
    add_moss_cap,
    add_prism,
    add_quad,
    add_shard,
    add_tube,
    mix,
    rot,
    xf,
)

OUT_GLB = os.path.join(cr.CALDERA, "props")
OUT_HULL = cr.OUT_HULL
SCRATCH = os.path.join(cr.CALDERA, "_scratch", "props")

lean_xf = cr.lean_xf
polar = cr.polar


def crystal(p, loc, size, az=0.0, tilt=0.0, color=None):
    """A magenta crystal (same construction as the first map's)."""
    r = p.rng
    bm, _hull = rocklib.make_shard(
        r, radius=size * 0.3, height=size * 2.0, sides=6, irregular=0.08, rings=2, cuts=0, top="none",
        bevel=0.0, poke=0.0, profile=[(0.0, 0.75), (0.74, 1.0), (1.0, 0.04)], ring_jitter=0.0, hull_tris=10,
    )
    layer = bm.faces.layers.int["kind"]
    for f in bm.faces:
        f[layer] = K_GLOW
    c = color if color is not None else mix(MAGENTA_DEEP, MAGENTA, r.uniform(0.55, 1.0))
    p.add_bmesh(bm, lean_xf(loc, az, tilt, r.uniform(0, 360)), None, color=c, solid=False)
    bm.free()


# --- Recipes --------------------------------------------------------------------------------------


def vent_marker(p):
    """The sign of a heat vent: a broken magenta ring of upward chevrons, 10 m in radius, to be
    scaled to the vent and stacked up its column. Origin: ring centre. No collision."""
    r = p.rng
    segs = 8
    for i in range(segs):
        a0 = math.radians(i * 360 / segs + 6)
        a1 = math.radians((i + 1) * 360 / segs - 6)
        am = (a0 + a1) * 0.5
        lo0 = Vector((math.cos(a0) * 10.0, math.sin(a0) * 10.0, 0.0))
        lo1 = Vector((math.cos(a1) * 10.0, math.sin(a1) * 10.0, 0.0))
        hi0 = Vector((math.cos(a0) * 9.4, math.sin(a0) * 9.4, 1.5))
        hi1 = Vector((math.cos(a1) * 9.4, math.sin(a1) * 9.4, 1.5))
        tip = Vector((math.cos(am) * 8.7, math.sin(am) * 8.7, 4.4))
        c = mix(MAGENTA_DEEP, MAGENTA, r.uniform(0.6, 1.0))
        add_quad(p, [lo0, lo1, hi1, hi0], kind=K_GLOW, color=c)
        add_quad(p, [hi0, hi1, tip], kind=K_GLOW, color=mix(MAGENTA, MAGENTA_HOT, 0.45))
    for i in range(4):
        x, y, _ = polar(10.4, i * 90 + 22.5)
        crystal(p, (x, y, -1.2), r.uniform(1.5, 2.0), az=i * 90 + 22.5, tilt=r.uniform(8, 18))
    p.meta["kind"] = "prop"
    p.meta["anchor"] = "centre"


def caldera_gate(p):
    """The team aerie of the caldera: a landing deck on a raft of basalt pipes, two obsidian
    fangs leaning into a pointed arch behind it. Origin: centre of the deck top; riders launch
    toward Blender -Y (glTF +Z). Bands, cloth and the pennant are TeamTint."""
    r = p.rng
    add_shard(p, xf((0, 6, -9)), radius=46, height=9, sides=10, irregular=0.1, profile=[(0, 0.74), (0.5, 1.02), (1, 0.98)],
              rings=2, ring_jitter=0.03, cuts=3, cut_depth=(0.9, 0.99), top="flat", squash=0.78, bevel=0.03, chips=4,
              poke=0, hull_tris=24)
    add_box(p, xf((0, -4, -0.2)), (58, 46, 0.9), kind=K_MASON, bevel=0.3, collide=False)
    # the raft: pipes hanging under the deck
    for i in range(6):
        a = i * 60 + 15
        x, y, _ = polar(r.uniform(14, 26), a)
        cr.hex_column(p, (x, 6 + y * 0.75, -5), r.uniform(7.5, 10.5), r.uniform(20, 44), spin=r.uniform(0, 60), flip=True,
                      hull_tris=12)
    half, back = 26.0, 22.0
    tilt = 23.0
    fang_h = 66.0
    for side in (-1, 1):
        # pier of pipes with the team band
        for dx, dy, h, rad in ((0, 0, 24, 5.6), (-5.5, 3.5, 17, 4.2), (5.0, 4.0, 13, 4.0), (1.5, -6.0, 9, 3.6)):
            cr.hex_column(p, (side * (half + dx * side), back + dy, 0.2), rad, h + r.uniform(-1, 1), spin=r.uniform(0, 60),
                          collide=h > 20, hull_tris=12, slant=(4, 12))
        add_prism(p, xf((side * half, back, 13.0), rz=r.uniform(0, 60)), 6.3, 1.5, sides=6, kind=K_TINT, collide=False)
        # the fang
        cr.blade(p, lean_xf((side * (half - 1.0), back + 1.0, 4.0), 0 if side < 0 else 180, tilt, 90 + r.uniform(-8, 8)),
                 10.5, fang_h, hull_tris=14, squash=0.7)
        # hanging banner on the front of the pier
        bx, by = side * half, back - 6.4
        add_quad(p, [(bx - 2.8, by, 21), (bx + 2.8, by, 21), (bx + 2.8, by - 0.4, 9.5), (bx, by - 0.5, 6.2), (bx - 2.8, by - 0.4, 9.5)],
                 kind=K_TINT)
        add_tube(p, [(bx - 3.3, by + 0.2, 21.3), (bx + 3.3, by + 0.2, 21.3)], 0.28, sides=5, kind=K_DARK, taper=1.0)
        # front pylons: a short pipe, a team cap and a shard of obsidian
        cr.hex_column(p, (side * 25, -22, 0.2), 2.3, 6.4, spin=r.uniform(0, 60), hull_tris=12)
        add_prism(p, xf((side * 25, -22, 4.4), rz=r.uniform(0, 60)), 2.75, 0.9, sides=6, kind=K_TINT, collide=False)
        cr.blade(p, lean_xf((side * 25, -22, 5.6), side * 90, r.uniform(4, 10), r.uniform(0, 360)), 1.5, 8.5, collide=False)
        add_box(p, xf((side * 28.2, 0, 0.4)), (2.2, 36, 2.2), kind=K_MASON, bevel=0.22, jitter=0.01, collide=False)
    # the pennant under the point of the arch
    apex_z = 4.0 + math.cos(math.radians(tilt)) * fang_h - 6.0
    y = back - 2.4
    add_tube(p, [(-9.5, y + 0.3, apex_z - 13.6), (9.5, y + 0.3, apex_z - 13.6)], 0.3, sides=5, kind=K_DARK, taper=1.0)
    add_quad(p, [(-8.6, y, apex_z - 14), (8.6, y, apex_z - 14), (8.2, y - 0.4, apex_z - 24), (0, y - 0.7, apex_z - 33),
                 (-8.2, y - 0.4, apex_z - 24)], kind=K_TINT)
    # shards broken off the point
    cr.fragments(p, (0, back + 2, apex_z + 12), 4, 6, 2.6, rise=1.0, color=cr.OBSIDIAN)
    add_moss_cap(p, xf((0, 2, 0.75)), [polar(15, a)[:2] for a in range(0, 360, 45)], lift=0.5, rings=2, rim_drop=0.3)
    bvh = cr.piece_bvh(p)
    for i in range(5):
        a = -160 + 35 * i + r.uniform(-8, 8)
        x0, y0, _ = polar(120, a)
        am = math.radians(a)
        cr.fissure(p, bvh, (x0, 6 + y0, -1.5), (x0 * 0.98 + r.uniform(-5, 5), 6 + y0 * 0.98, -8.0),
                   (-math.cos(am), -math.sin(am), 0), width=0.9, step=1.6)
    p.meta["kind"] = "gate"
    p.meta["top"] = {"y": 0.7, "radius": 20.0}
    p.meta["opening"] = {"width": 34.0, "height": 40.0, "y": 0.0}


def basalt_pylon(p):
    """A short stand of basalt pipes: the caldera's standing stone."""
    r = p.rng
    for dx, dy, h, rad in ((0, 0, 15, 1.9), (2.9, 1.1, 10.5, 1.7), (-1.2, 2.9, 7, 1.6), (-2.6, -1.6, 4.4, 1.5), (1.6, -2.7, 2.6, 1.4)):
        cr.hex_column(p, (dx, dy, -0.4), rad, h + r.uniform(-0.5, 0.5), spin=r.uniform(0, 60), collide=h > 6, hull_tris=12,
                      slant=(4, 14))
    bvh = cr.piece_bvh(p)
    cr.fissure(p, bvh, (0.4, -30, 1.0), (-0.3, -30, 9.5), (0, 1, 0), width=0.5, step=1.0)
    p.meta["kind"] = "prop"


def obsidian_cluster(p):
    """A handful of obsidian blades growing out of a basalt knuckle."""
    r = p.rng
    add_shard(p, xf((0, 0, -0.5)), radius=3.4, height=2.6, sides=6, taper=0.6, rings=1, cuts=2, top="slant", bevel=0.08,
              chips=1, poke=0, hull_tris=10)
    cr.blade(p, lean_xf((0, 0, 0.6), 30, 9, r.uniform(0, 360)), 1.7, 11.5, hull_tris=10)
    for i, (h, rad) in enumerate(((7.5, 1.3), (6.0, 1.2), (4.4, 1.0), (3.4, 0.9))):
        a = i * 90 + r.uniform(-20, 20)
        x, y, _ = polar(1.9, a)
        cr.blade(p, lean_xf((x, y, 0.5), a, r.uniform(18, 36), r.uniform(0, 360)), rad, h, collide=False)
    p.meta["kind"] = "prop"


def fumarole(p):
    """A small smoking hole: a ring of clinker around a glowing throat."""
    r = p.rng
    for i in range(6):
        a = i * 60 + r.uniform(-12, 12)
        x, y, _ = polar(2.8, a)
        add_shard(p, lean_xf((x, y, -0.6), a + 180, r.uniform(10, 22), r.uniform(0, 360)), radius=r.uniform(1.5, 2.1),
                  height=r.uniform(2.4, 4.4), sides=5, taper=0.45, rings=1, cuts=2, top="slant", bevel=0.08, chips=1, poke=0,
                  hull_tris=8, collide=False)
    cr.lava_pool(p, (0, 0, 1.0), 2.5, sides=7)
    p.hulls.append(rocklib.convex_hull_of([Vector((math.cos(k * math.pi / 3) * 4.0, math.sin(k * math.pi / 3) * 4.0, zz))
                                           for k in range(6) for zz in (-0.6, 3.2)]))
    p.meta["kind"] = "prop"


def backdrop_ridge(p):
    """Far outside the arena: a length of the outer crater rim, a long broken ridge."""
    r = p.rng
    for i, (x, h, rad) in enumerate(((-300, 190, 120), (-190, 300, 125), (-70, 235, 130), (50, 330, 135), (170, 250, 125),
                                     (290, 170, 115))):
        add_shard(p, lean_xf((x, r.uniform(-20, 20), 0), 90, r.uniform(0, 5), -90 + r.uniform(-10, 10)), radius=rad, height=h,
                  sides=6, taper=r.uniform(0.45, 0.6), rings=3, cuts=4, top="double", top_tilt=(14, 34), squash=0.5, bevel=0,
                  chips=0, poke=0, collide=False)
    p.hulls = []
    p.meta["kind"] = "backdrop"


def backdrop_cone(p):
    """Far outside the arena: a neighbouring cone with a notched summit and lava down one flank
    (toward Blender -Y, glTF +Z: turn that side to the arena)."""
    r = p.rng
    add_shard(p, xf((0, 0, 0)), radius=330, height=430, sides=9, irregular=0.1, taper=0.2, rings=4, cuts=3,
              cut_depth=(0.86, 0.98), top="double", top_tilt=(16, 30), bevel=0, chips=0, poke=0, collide=False)
    for x, y, h, rad in ((-260, 60, 150, 120), (250, 90, 190, 130)):
        add_shard(p, lean_xf((x, y, 0), r.uniform(0, 360), r.uniform(0, 5), r.uniform(0, 360)), radius=rad, height=h, sides=6,
                  taper=0.35, rings=2, cuts=3, top="slant", bevel=0, chips=0, poke=0, collide=False)
    bvh = cr.piece_bvh(p)
    for x0, x1, z1 in ((-20, -90, 120), (30, 60, 200), (0, 150, 60)):
        cr.fissure(p, bvh, (x0, -900, 395), (x1, -900, z1), (0, 1, 0), width=16, step=36, wobble=0.5, lift=2.0, reach=2000.0)
    p.hulls = []
    p.meta["kind"] = "backdrop"


RECIPES = [
    # id, recipe, seed, uv scale, lava grade (False keeps magenta glow untouched)
    ("vent-marker", vent_marker, 401, 1 / 12, False),
    ("caldera-gate", caldera_gate, 409, 1 / 24, True),
    ("basalt-pylon", basalt_pylon, 419, 1 / 12, True),
    ("obsidian-cluster", obsidian_cluster, 421, 1 / 12, True),
    ("fumarole", fumarole, 431, 1 / 12, True),
    ("backdrop-ridge", backdrop_ridge, 433, 1 / 200, True),
    ("backdrop-cone", backdrop_cone, 439, 1 / 200, True),
]


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    only = set(argv[argv.index("--only") + 1].split(",")) if "--only" in argv else None
    cr.apply_caldera_palette()
    rocklib.clear_scene()
    built = {}
    for name, fn, seed, uv_scale, lava in RECIPES:
        if only is not None and name not in only:
            continue
        piece = Piece(name, seed)
        fn(piece)
        is_backdrop = piece.meta.get("kind") == "backdrop"
        lods, _meta = cr.caldera_finish(piece, OUT_GLB, OUT_HULL, (3000, 1200) if not is_backdrop else (3000,),
                                        under=0.5, low=0.4 if is_backdrop else 0.0, lava=lava, uv_scale=uv_scale,
                                        moss=0.0 if is_backdrop else 0.8, moss_threshold=0.8, ao_scale=0.35)
        for i, o in enumerate(lods):
            o.name = "%s_LOD%d" % (name, i)
        built[name] = lods
    if only is None:
        bpy.ops.wm.save_as_mainfile(filepath=os.path.join(cr.CALDERA, "props.blend"))
    if "--preview" in argv:
        mat = cr.caldera_material("CalderaProp", tex_scale=1 / 12.0)
        tint = preview.game_material("CalderaTint", emissive=False)
        tint_node = tint.node_tree.nodes.new("ShaderNodeRGB")
        tint_node.outputs[0].default_value = (1.0, 0.19, 0.01, 1)  # team Ember
        mul = tint.node_tree.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        vc = next(n for n in tint.node_tree.nodes if n.type == "VERTEX_COLOR" and n.layer_name == "Color")
        bsdf = next(n for n in tint.node_tree.nodes if n.type == "BSDF_DIFFUSE")
        tint.node_tree.links.new(vc.outputs["Color"], mul.inputs["A"])
        tint.node_tree.links.new(tint_node.outputs[0], mul.inputs["B"])
        tint.node_tree.links.new(mul.outputs["Result"], bsdf.inputs["Color"])

        def use(o):
            slots = [m.name for m in o.data.materials]
            for i, slot in enumerate(slots):
                o.data.materials[i] = tint if slot.startswith("TeamTint") or slot.startswith("CalderaTint") else mat

        cr.render_previews(built, SCRATCH, os.path.join(cr.PREVIEWS, "props-sheet.png") if only is None else None, 4, use,
                           elevation=12.0, lod_pair=False)


if __name__ == "__main__":
    main()
