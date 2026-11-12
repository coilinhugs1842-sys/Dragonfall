"""Assembles the baked Emberfall Caldera layout in Blender and renders vistas (T-6.4).

  blender -b -P tools/blender/map/render_caldera_vista.py -- [--views name,name] [--out dir] [--size WxH]

Reads public/assets/maps/emberfall-caldera/manifest.json (placements, sky) and the meshes saved
by build_caldera_rocks.py / build_caldera_props.py (art-source/maps/caldera/rocks.blend,
props.blend), plus the three first-map props the caldera reuses (art-source/maps/props.blend,
read only). Instances every placement with a distance-picked LOD, adds the lava-lit ash sea, the
dusk light and exp2 fog like the game's, and writes PNGs (default:
art-source/maps/caldera/previews/vista-<name>.png). It writes nothing else.

This is a Blender approximation of the look (Lambert, vertex colours x tiling detail, emissive
mask, fog), not the game's renderer: it shows silhouettes, layout, palette and value structure.
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_caldera_rocks as cr
import preview

REPO = preview.REPO
MANIFEST = os.path.join(REPO, "public", "assets", "maps", "emberfall-caldera", "manifest.json")
EMBER = (1.0, 0.195, 0.01)
FROST = (0.05, 0.68, 1.0)

# glTF (+Y up) -> Blender (+Z up)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
C_INV = C.inverted()


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


def srgb(value):
    c = cr.lin(value)
    return (float(c[0]), float(c[1]), float(c[2]), 1.0)


def placement_matrix(p):
    ry = Matrix.Rotation(p["yaw"], 4, "Y")
    rx = Matrix.Rotation(p["pitch"], 4, "X")
    rz = Matrix.Rotation(p["roll"], 4, "Z")
    pos = p["position"]
    m = Matrix.Translation(Vector((pos["x"], pos["y"], pos["z"]))) @ ry @ rx @ rz @ Matrix.Scale(p["scale"], 4)
    return C @ m @ C_INV


def tint_material(name, color, base):
    mat = base.copy()
    mat.name = name
    nt = mat.node_tree
    vc = next(n for n in nt.nodes if n.type == "VERTEX_COLOR" and n.layer_name == "Color")
    target = [l for l in nt.links if l.from_node == vc]
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    mul.inputs["B"].default_value = (color[0], color[1], color[2], 1)
    sockets = [l.to_socket for l in target]
    nt.links.new(vc.outputs["Color"], mul.inputs["A"])
    for sock in sockets:
        nt.links.new(mul.outputs["Result"], sock)
    return mat


def fog_factor(nt, density):
    """exp(-(d * density)^2): 1 near the camera, 0 far away."""
    cam = nt.nodes.new("ShaderNodeCameraData")
    m1 = nt.nodes.new("ShaderNodeMath")
    m1.operation = "MULTIPLY"
    m1.inputs[1].default_value = density
    m1.label = "FogDensity"
    nt.links.new(cam.outputs["View Distance"], m1.inputs[0])
    m2 = nt.nodes.new("ShaderNodeMath")
    m2.operation = "POWER"
    m2.inputs[1].default_value = 2.0
    nt.links.new(m1.outputs[0], m2.inputs[0])
    m3 = nt.nodes.new("ShaderNodeMath")
    m3.operation = "MULTIPLY"
    m3.inputs[1].default_value = -1.0
    nt.links.new(m2.outputs[0], m3.inputs[0])
    m4 = nt.nodes.new("ShaderNodeMath")
    m4.operation = "EXPONENT"
    nt.links.new(m3.outputs[0], m4.inputs[0])
    return m4.outputs[0]


def ash_sea(sky, fog):
    """The ash sea at y = 0: grey-violet drifts, lit warm on their crests, with dim crimson lava
    showing through in broken veins. Unlit (emission), fogged like the rocks."""
    bpy.ops.mesh.primitive_plane_add(size=16000, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "AshSea"
    mat = bpy.data.materials.new("AshSea")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.0042
    noise.inputs["Detail"].default_value = 5.0
    noise.inputs["Roughness"].default_value = 0.62
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    crr = ramp.color_ramp
    crr.elements[0].position = 0.3
    crr.elements[0].color = srgb(sky["seaDeepColor"])
    crr.elements[1].position = 0.78
    crr.elements[1].color = srgb(sky["seaCrestColor"])
    crr.elements.new(0.47).color = srgb(sky["seaShadowColor"])
    crr.elements.new(0.64).color = srgb(sky["seaLitColor"])
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    # lava: thin cell edges, only where a second, larger noise opens the ash
    voro = nt.nodes.new("ShaderNodeTexVoronoi")
    voro.feature = "DISTANCE_TO_EDGE"
    voro.inputs["Scale"].default_value = 0.0075
    nt.links.new(coord.outputs["Object"], voro.inputs["Vector"])
    edge = nt.nodes.new("ShaderNodeMapRange")
    edge.inputs["From Min"].default_value = 0.0
    edge.inputs["From Max"].default_value = 0.05
    edge.inputs["To Min"].default_value = 1.0
    edge.inputs["To Max"].default_value = 0.0
    nt.links.new(voro.outputs["Distance"], edge.inputs["Value"])
    open_noise = nt.nodes.new("ShaderNodeTexNoise")
    open_noise.inputs["Scale"].default_value = 0.0016
    open_noise.inputs["Detail"].default_value = 2.0
    nt.links.new(coord.outputs["Object"], open_noise.inputs["Vector"])
    open_map = nt.nodes.new("ShaderNodeMapRange")
    open_map.inputs["From Min"].default_value = 0.5
    open_map.inputs["From Max"].default_value = 0.68
    nt.links.new(open_noise.outputs["Fac"], open_map.inputs["Value"])
    veins = nt.nodes.new("ShaderNodeMath")
    veins.operation = "MULTIPLY"
    nt.links.new(edge.outputs["Result"], veins.inputs[0])
    nt.links.new(open_map.outputs["Result"], veins.inputs[1])
    glow = srgb(sky["seaGlowColor"])
    lava = nt.nodes.new("ShaderNodeMix")
    lava.data_type = "RGBA"
    nt.links.new(veins.outputs[0], lava.inputs["Factor"])
    nt.links.new(ramp.outputs["Color"], lava.inputs["A"])
    lava.inputs["B"].default_value = (glow[0] * 1.7, glow[1] * 1.7, glow[2] * 1.7, 1)
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 0.62  # dusk: the sea is dimmer than the first map's clouds
    nt.links.new(lava.outputs["Result"], emit.inputs["Color"])
    fog_emit = nt.nodes.new("ShaderNodeEmission")
    fog_emit.inputs["Color"].default_value = (preview.FOG_COLOR[0], preview.FOG_COLOR[1], preview.FOG_COLOR[2], 1)
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(fog_factor(nt, fog), mix.inputs["Fac"])
    nt.links.new(fog_emit.outputs["Emission"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    plane.data.materials.append(mat)
    return plane


def load_meshes(needed):
    """{type: {lod: mesh}}; the caldera's own blends first, then the first map's props for the rest."""
    meshes = {}
    sources = (
        os.path.join(cr.CALDERA, "rocks.blend"),
        os.path.join(cr.CALDERA, "props.blend"),
        os.path.join(REPO, "art-source", "maps", "props.blend"),
    )
    for path in sources:
        if not os.path.exists(path):
            print("MISSING BLEND", path)
            continue
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = [
                n for n in src.objects
                if "_LOD" in n and n.rsplit("_LOD", 1)[0] in needed and n.rsplit("_LOD", 1)[0] not in meshes
            ]
        for obj in dst.objects:
            if obj is not None:
                name, lod = obj.name.rsplit("_LOD", 1)
                meshes.setdefault(name, {})[int(lod[0])] = obj.data
    return meshes


def build(manifest, eye_points, fog):
    kinds = {p["id"]: p.get("kind", "prop") for p in manifest["props"]}
    own = {p["id"] for p in manifest["props"] if "/emberfall-caldera/" in p["glb"]}
    meshes = load_meshes(set(kinds))
    basalt = cr.caldera_material("VistaBasalt", fog_density=fog)
    prop = cr.caldera_material("VistaProp", fog_density=fog, tex_scale=1 / 12.0)
    # caldera_material pushes the emission so the dim crimson lava reads in a still; the magenta
    # vent markers are bright already and would clip to white with it
    for node in prop.node_tree.nodes:
        if node.type == "EMISSION" and node.inputs["Color"].is_linked:
            node.inputs["Strength"].default_value = 1.2
    mason = preview.game_material("VistaMason", texture=preview.texture_path("masonry"), mean=preview.texture_mean("masonry"),
                                  tex_scale=1 / 12.0, fog_density=fog, detail_strength=0.6)
    plain = preview.game_material("VistaPlain", fog_density=fog, emissive=False)
    tints = {0: tint_material("VistaEmber", EMBER, plain), 1: tint_material("VistaFrost", FROST, plain)}
    variants = {}
    count = 0
    for p in manifest["placements"]:
        lods = meshes.get(p["type"])
        if not lods:
            print("MISSING", p["type"])
            continue
        m = placement_matrix(p)
        pos = m.translation
        dist = min((pos - e).length for e in eye_points) if eye_points else 0
        want = 0 if dist < 420 * p["scale"] else (1 if dist < 900 * p["scale"] else 2)
        lod = max(k for k in lods if k <= want) if any(k <= want for k in lods) else min(lods)
        team = p.get("team")
        key = (p["type"], lod, team)
        if key not in variants:
            mesh = lods[lod].copy()
            if p["type"] not in own:
                base = mason
            elif kinds.get(p["type"]) in ("rock", "backdrop"):
                base = basalt
            else:
                base = prop
            if len(mesh.materials) == 0:
                mesh.materials.append(base)
            for i, slot in enumerate(list(mesh.materials)):
                if slot is not None and slot.name.startswith("TeamTint"):
                    mesh.materials[i] = tints.get(team, plain)
                else:
                    mesh.materials[i] = base
            variants[key] = mesh
        obj = bpy.data.objects.new("%s_%d" % (p["type"], count), variants[key])
        obj.matrix_world = m
        bpy.context.scene.collection.objects.link(obj)
        count += 1
    print("INSTANCED", count)


VIEWS = {
    # name: (eye gltf xyz, target gltf xyz, lens)
    # what a player sees at launch: the lane, the duel perch below, the broken cone ahead
    "gate-launch": ((0, 312, -762), (0, 230, 0), 24),
    # from high above Ember's gate: the near half of the crater, rim curving away on both sides
    "crater": ((-150, 620, -960), (60, 40, -200), 20),
    # the broken cone, the main chimney and the sky-well from the duelling ring
    "cone": ((150, 300, -430), (0, 190, 0), 24),
    "inside-cone": ((46, 150, -150), (0, 250, 10), 18),
    # the trench on the right flank, flown low
    "trench": ((300, 62, -640), (500, 78, -480), 20),
    # the ash staircase on the left flank
    "staircase": ((-250, 330, -610), (-450, 200, -330), 26),
    "gate-back": ((80, 335, -620), (0, 285, -815), 30),
    "duel-perch": ((70, 300, -340), (0, 240, -455), 30),
    # a flank vent: chimney and marker rings
    "vent": ((-130, 290, -470), (-280, 190, -610), 28),
    # toward the low sun from the west (the intro flyby's line): silhouettes on the ember horizon
    "west-dusk": ((-640, 375, -60), (0, 250, 0), 24),
    # along the inner face of the crater wall
    "rim-wall": ((560, 240, -330), (700, 120, 60), 22),
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.join(cr.PREVIEWS)
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    names = argv[argv.index("--views") + 1].split(",") if "--views" in argv else list(VIEWS) + ["top"]
    size = (1280, 720)
    if "--size" in argv:
        w, h = argv[argv.index("--size") + 1].split("x")
        size = (int(w), int(h))
    with open(MANIFEST) as fh:
        manifest = json.load(fh)
    sky = manifest["sky"]
    fog = float(sky["fogDensity"])
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    preview.setup_scene(size[0], size[1])
    sun_dir = sky["sunDirection"]
    d = to_blender((sun_dir["x"], sun_dir["y"], sun_dir["z"]))
    cr.setup_dusk(azimuth_deg=math.degrees(math.atan2(d.y, d.x)), elevation_deg=math.degrees(math.asin(d.z)))
    eyes = [to_blender(VIEWS[n][0]) for n in names if n in VIEWS]
    build(manifest, eyes, fog)
    ash_sea(sky, fog)
    cam = preview.make_camera(clip_end=9000)
    # the map view switches the fog off, so it goes last
    names = [n for n in names if n != "top"] + (["top"] if "top" in names else [])
    for name in names:
        if name == "top":
            cam.data.type = "ORTHO"
            cam.data.ortho_scale = 2150
            cam.location = (0, 0, 3000)
            cam.rotation_euler = (0, 0, 0)
            bpy.context.scene.render.resolution_x = 1400
            bpy.context.scene.render.resolution_y = 1400
            for mat in bpy.data.materials:
                if mat.name.startswith("Vista") or mat.name == "AshSea":
                    for node in mat.node_tree.nodes:
                        if node.type == "MATH" and node.operation == "MULTIPLY" and abs(node.inputs[1].default_value - fog) < 1e-9:
                            node.inputs[1].default_value = 0.0
        else:
            eye, target, lens = VIEWS[name]
            cam.data.type = "PERSP"
            cam.data.lens = lens
            preview.look_at(cam, to_blender(eye), to_blender(target))
        preview.render(os.path.join(out, "vista-%s.png" % name))


main()
