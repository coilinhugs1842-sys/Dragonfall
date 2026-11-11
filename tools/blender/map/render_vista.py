"""Assembles the baked Shattered Spires layout in Blender and renders vistas (T-4.5).

  blender -b -P tools/blender/map/render_vista.py -- [--views name,name] [--out dir] [--size WxH]

Reads public/assets/maps/shattered-spires/manifest.json (placements) and the meshes saved by
build_rocks.py / build_props.py (art-source/maps/rocks.blend, props.blend), instances every
placement with a distance-picked LOD, adds a cloud sea, golden-hour light and exp2 fog like the
game's, and writes PNGs (default: art-source/maps/previews/).
"""

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import preview

REPO = preview.REPO
MANIFEST = os.path.join(REPO, "public", "assets", "maps", "shattered-spires", "manifest.json")
FOG = 0.0012
EMBER = (1.0, 0.195, 0.01)
FROST = (0.05, 0.68, 1.0)

# glTF (+Y up) -> Blender (+Z up)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
C_INV = C.inverted()


def to_blender(p):
    return Vector((p[0], -p[2], p[1]))


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


def cloud_sea():
    bpy.ops.mesh.primitive_plane_add(size=16000, location=(0, 0, 0))
    plane = bpy.context.active_object
    plane.name = "CloudSea"
    mat = bpy.data.materials.new("CloudSea")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    coord = nt.nodes.new("ShaderNodeTexCoord")
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.0045
    noise.inputs["Detail"].default_value = 5.0
    noise.inputs["Roughness"].default_value = 0.6
    nt.links.new(coord.outputs["Object"], noise.inputs["Vector"])
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements[0].position = 0.32
    cr.elements[0].color = (0.50, 0.36, 0.42, 1)
    cr.elements[1].position = 0.7
    cr.elements[1].color = (1.0, 0.86, 0.66, 1)
    e = cr.elements.new(0.5)
    e.color = (0.90, 0.62, 0.42, 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    # same exp2 fog as the rocks
    cam = nt.nodes.new("ShaderNodeCameraData")
    m1 = nt.nodes.new("ShaderNodeMath")
    m1.operation = "MULTIPLY"
    m1.inputs[1].default_value = FOG
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
    fog = nt.nodes.new("ShaderNodeEmission")
    fog.inputs["Color"].default_value = (preview.FOG_COLOR[0], preview.FOG_COLOR[1], preview.FOG_COLOR[2], 1)
    mix = nt.nodes.new("ShaderNodeMixShader")
    nt.links.new(m4.outputs[0], mix.inputs["Fac"])
    nt.links.new(fog.outputs["Emission"], mix.inputs[1])
    nt.links.new(emit.outputs["Emission"], mix.inputs[2])
    nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
    plane.data.materials.append(mat)
    return plane


def load_meshes():
    meshes = {}
    for blend in ("rocks.blend", "props.blend"):
        path = os.path.join(REPO, "art-source", "maps", blend)
        with bpy.data.libraries.load(path) as (src, dst):
            dst.objects = [n for n in src.objects if "_LOD" in n]
        for obj in dst.objects:
            if obj is not None:
                name, lod = obj.name.rsplit("_LOD", 1)
                meshes.setdefault(name, {})[int(lod[0])] = obj.data
    return meshes


def build(manifest, eye_points, fog=FOG):
    meshes = load_meshes()
    stone = preview.game_material("VistaStone", texture=preview.texture_path("stone"), mean=preview.texture_mean("stone"),
                                  moss_texture=preview.texture_path("moss"), moss_mean=preview.texture_mean("moss"),
                                  fog_density=fog, detail_strength=0.75)
    mason = preview.game_material("VistaMason", texture=preview.texture_path("masonry"), mean=preview.texture_mean("masonry"),
                                  tex_scale=1 / 12.0, fog_density=fog, detail_strength=0.6)
    plain = preview.game_material("VistaPlain", fog_density=fog, emissive=False)
    tints = {0: tint_material("VistaEmber", EMBER, plain), 1: tint_material("VistaFrost", FROST, plain)}
    kinds = {p["id"]: p.get("kind", "prop") for p in manifest["props"]}
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
            base = stone if kinds.get(p["type"]) in ("rock", "backdrop") else mason
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
    "gate-launch": ((0, 312, -762), (0, 240, 0), 24),
    "crown": ((60, 300, -380), (0, 250, 0), 24),
    "inside-crown": ((30, 230, -150), (0, 290, 20), 18),
    "canyon": ((300, 60, -712), (470, 80, -530), 22),
    "ruin-island": ((-360, 300, -230), (-455, 262, -150), 30),
    "gate-back": ((70, 330, -640), (0, 280, -820), 30),
    "duel-perch": ((60, 290, -350), (0, 250, -455), 30),
    "flank-arch": ((-110, 250, -440), (-292, 215, -300), 26),
    "high-pass": ((-300, 470, -470), (0, 200, 0), 22),
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    out = os.path.join(REPO, "art-source", "maps", "previews")
    if "--out" in argv:
        out = argv[argv.index("--out") + 1]
    names = argv[argv.index("--views") + 1].split(",") if "--views" in argv else list(VIEWS) + ["top"]
    size = (1600, 900)
    if "--size" in argv:
        w, h = argv[argv.index("--size") + 1].split("x")
        size = (int(w), int(h))
    with open(MANIFEST) as fh:
        manifest = json.load(fh)
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    preview.setup_scene(size[0], size[1])
    preview.setup_world()
    sun_dir = manifest["sky"]["sunDirection"]
    d = to_blender((sun_dir["x"], sun_dir["y"], sun_dir["z"]))
    preview.setup_sun(math.degrees(math.atan2(d.y, d.x)), math.degrees(math.asin(d.z)))
    eyes = [to_blender(VIEWS[n][0]) for n in names if n in VIEWS]
    build(manifest, eyes)
    cloud_sea()
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
                if mat.name.startswith("Vista") or mat.name == "CloudSea":
                    for node in mat.node_tree.nodes:
                        if node.type == "MATH" and node.operation == "MULTIPLY" and abs(node.inputs[1].default_value - FOG) < 1e-9:
                            node.inputs[1].default_value = 0.0
        else:
            eye, target, lens = VIEWS[name]
            cam.data.type = "PERSP"
            cam.data.lens = lens
            preview.look_at(cam, to_blender(eye), to_blender(target))
        preview.render(os.path.join(out, "vista-%s.png" % name))


main()
