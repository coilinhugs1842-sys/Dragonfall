"""Golden-hour preview renders for the map assets (EEVEE, headless).

The preview material mimics what the game does on Medium: painted vertex colour (COLOR_0)
modulated by a box-projected tileable detail texture, one warm sun without world shadows,
hemisphere ambient and distance fog (docs/ART_DIRECTION.md, "Lighting recipe").
"""

import math
import os

import bpy
from mathutils import Vector

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
TEX_DIR = os.path.join(REPO, "art-source", "textures-raw")

FOG_COLOR = (0.815, 0.694, 0.527)  # #E9D9C0 linear
SUN_COLOR = (1.0, 0.694, 0.352)  # #FFD9A0 linear-ish


def setup_scene(width=1280, height=720, samples=16):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = width
    scene.render.resolution_y = height
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    try:
        scene.eevee.taa_render_samples = samples
    except Exception:
        pass
    for name in ("AgX", "Filmic", "Standard"):
        try:
            scene.view_settings.view_transform = name
            break
        except Exception:
            continue
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        try:
            scene.view_settings.look = "AgX - High Contrast"
        except Exception:
            pass
    return scene


def setup_world(strength=0.5):
    world = bpy.data.worlds.get("GoldenHour") or bpy.data.worlds.new("GoldenHour")
    bpy.context.scene.world = world
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    geo = nt.nodes.new("ShaderNodeNewGeometry")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    mapr = nt.nodes.new("ShaderNodeMapRange")
    mapr.inputs["From Min"].default_value = -0.25
    mapr.inputs["From Max"].default_value = 0.9
    nt.links.new(geo.outputs["Incoming"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], mapr.inputs["Value"])
    nt.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
    cr = ramp.color_ramp
    # looking down (cloud sea haze) -> horizon cream/peach -> dusk violet-blue overhead
    stops = [
        (0.0, (0.80, 0.62, 0.47, 1)),
        (0.2, (0.95, 0.78, 0.55, 1)),
        (0.27, (0.90, 0.60, 0.36, 1)),
        (0.45, (0.55, 0.50, 0.62, 1)),
        (1.0, (0.16, 0.18, 0.36, 1)),
    ]
    cr.elements[0].position = stops[0][0]
    cr.elements[0].color = stops[0][1]
    cr.elements[1].position = stops[-1][0]
    cr.elements[1].color = stops[-1][1]
    for pos, color in stops[1:-1]:
        e = cr.elements.new(pos)
        e.color = color
    # Incoming points from the surface to the camera, so flip the sign of Z.
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = -1.0
    nt.links.new(sep.outputs["Z"], mul.inputs[0])
    nt.links.new(mul.outputs[0], mapr.inputs["Value"])
    # Camera sees the sky gradient; lighting comes from a hemisphere like the game's
    # HemisphereLight (sky #9FB7D9, ground #3F5A55).
    hemi = nt.nodes.new("ShaderNodeMix")
    hemi.data_type = "RGBA"
    hmap = nt.nodes.new("ShaderNodeMapRange")
    hmap.inputs["From Min"].default_value = -1.0
    hmap.inputs["From Max"].default_value = 1.0
    nt.links.new(mul.outputs[0], hmap.inputs["Value"])
    nt.links.new(hmap.outputs["Result"], hemi.inputs["Factor"])
    hemi.inputs["A"].default_value = (0.05, 0.102, 0.091, 1)
    hemi.inputs["B"].default_value = (0.347, 0.474, 0.693, 1)
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
    amb.inputs["A"].default_value = strength * 1.6
    amb.inputs["B"].default_value = 1.0
    nt.links.new(amb.outputs["Result"], bg.inputs["Strength"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return world


def setup_sun(azimuth_deg=215.0, elevation_deg=18.0, strength=7.0, shadows=False):
    light = bpy.data.lights.new("Sun", "SUN")
    light.energy = strength
    light.color = SUN_COLOR
    light.angle = math.radians(3.0)
    try:
        light.use_shadow = shadows
    except Exception:
        pass
    obj = bpy.data.objects.new("Sun", light)
    bpy.context.scene.collection.objects.link(obj)
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    # direction TO the sun
    d = Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el)))
    obj.rotation_euler = d.to_track_quat("Z", "Y").to_euler()
    return obj, d


def game_material(name, texture=None, mean=(0.5, 0.5, 0.5), tex_scale=1.0 / 64.0, fog_density=0.0,
                  moss_texture=None, moss_mean=(0.5, 0.5, 0.5), emissive=True, detail_strength=0.75):
    """Vertex colour x (texture / mean), moss texture where `_MASKS.g`, glow where `_MASKS.a`,
    then exp2 fog toward FOG_COLOR. Output is emission + diffuse mix to stay close to Lambert."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfDiffuse")
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Color"
    masks = nt.nodes.new("ShaderNodeVertexColor")
    masks.layer_name = "_MASKS"
    color_out = col.outputs["Color"]

    def tex_node(path, mean_color):
        coord = nt.nodes.new("ShaderNodeTexCoord")
        mapping = nt.nodes.new("ShaderNodeMapping")
        mapping.inputs["Scale"].default_value = (tex_scale, tex_scale, tex_scale)
        nt.links.new(coord.outputs["Object"], mapping.inputs["Vector"])
        img = nt.nodes.new("ShaderNodeTexImage")
        img.image = bpy.data.images.load(path, check_existing=True)
        img.projection = "BOX"
        img.projection_blend = 0.25
        nt.links.new(mapping.outputs["Vector"], img.inputs["Vector"])
        div = nt.nodes.new("ShaderNodeMix")
        div.data_type = "RGBA"
        div.blend_type = "DIVIDE"
        div.inputs["Factor"].default_value = 1.0
        nt.links.new(img.outputs["Color"], div.inputs["A"])
        div.inputs["B"].default_value = (mean_color[0], mean_color[1], mean_color[2], 1)
        return div.outputs["Result"]

    if texture is not None and os.path.exists(texture):
        detail = tex_node(texture, mean)
        if moss_texture is not None and os.path.exists(moss_texture):
            moss_detail = tex_node(moss_texture, moss_mean)
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(masks.outputs["Color"], sep.inputs["Color"])
            pick = nt.nodes.new("ShaderNodeMix")
            pick.data_type = "RGBA"
            nt.links.new(sep.outputs["Green"], pick.inputs["Factor"])
            nt.links.new(detail, pick.inputs["A"])
            nt.links.new(moss_detail, pick.inputs["B"])
            detail = pick.outputs["Result"]
        fade = nt.nodes.new("ShaderNodeMix")
        fade.data_type = "RGBA"
        # no stone detail on emissive faces (crystals, runes, flames)
        keep = nt.nodes.new("ShaderNodeMath")
        keep.operation = "MULTIPLY_ADD"
        keep.inputs[1].default_value = -detail_strength
        keep.inputs[2].default_value = detail_strength
        nt.links.new(masks.outputs["Alpha"], keep.inputs[0])
        nt.links.new(keep.outputs[0], fade.inputs["Factor"])
        fade.inputs["A"].default_value = (1, 1, 1, 1)
        nt.links.new(detail, fade.inputs["B"])
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        nt.links.new(color_out, mul.inputs["A"])
        nt.links.new(fade.outputs["Result"], mul.inputs["B"])
        color_out = mul.outputs["Result"]

    nt.links.new(color_out, bsdf.inputs["Color"])
    shader = bsdf.outputs["BSDF"]
    if emissive:
        emit = nt.nodes.new("ShaderNodeEmission")
        emit.inputs["Strength"].default_value = 1.4
        nt.links.new(color_out, emit.inputs["Color"])
        mix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(masks.outputs["Alpha"], mix.inputs["Fac"])
        nt.links.new(shader, mix.inputs[1])
        nt.links.new(emit.outputs["Emission"], mix.inputs[2])
        shader = mix.outputs["Shader"]
    if fog_density > 0:
        cam = nt.nodes.new("ShaderNodeCameraData")
        sq = nt.nodes.new("ShaderNodeMath")
        sq.operation = "MULTIPLY"
        sq.inputs[1].default_value = fog_density
        nt.links.new(cam.outputs["View Distance"], sq.inputs[0])
        pw = nt.nodes.new("ShaderNodeMath")
        pw.operation = "POWER"
        pw.inputs[1].default_value = 2.0
        nt.links.new(sq.outputs[0], pw.inputs[0])
        neg = nt.nodes.new("ShaderNodeMath")
        neg.operation = "MULTIPLY"
        neg.inputs[1].default_value = -1.0
        nt.links.new(pw.outputs[0], neg.inputs[0])
        ex = nt.nodes.new("ShaderNodeMath")
        ex.operation = "EXPONENT"
        nt.links.new(neg.outputs[0], ex.inputs[0])
        fog = nt.nodes.new("ShaderNodeEmission")
        fog.inputs["Color"].default_value = (FOG_COLOR[0], FOG_COLOR[1], FOG_COLOR[2], 1)
        fog.inputs["Strength"].default_value = 1.0
        fmix = nt.nodes.new("ShaderNodeMixShader")
        nt.links.new(ex.outputs[0], fmix.inputs["Fac"])
        nt.links.new(fog.outputs["Emission"], fmix.inputs[1])
        nt.links.new(shader, fmix.inputs[2])
        shader = fmix.outputs["Shader"]
    nt.links.new(shader, out.inputs["Surface"])
    return mat


def texture_path(name):
    return os.path.join(TEX_DIR, name + ".png")


def texture_mean(name, fallback=(0.5, 0.5, 0.5)):
    import json

    path = os.path.join(TEX_DIR, "means.json")
    if os.path.exists(path):
        with open(path) as fh:
            data = json.load(fh)
        if name in data:
            return tuple(data[name])
    return fallback


def default_game_material(fog_density=0.0, tint=None):
    name = "GameStone" if tint is None else "GameTint"
    return game_material(
        name,
        texture=texture_path("stone"),
        mean=texture_mean("stone"),
        moss_texture=texture_path("moss"),
        moss_mean=texture_mean("moss"),
        fog_density=fog_density,
    )


def bounds_of(objects):
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for o in objects:
        for corner in o.bound_box:
            p = o.matrix_world @ Vector(corner)
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
    return lo, hi


def make_camera(name="Cam", lens=35.0, clip_end=6000.0):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.5
    cam.clip_end = clip_end
    obj = bpy.data.objects.new(name, cam)
    bpy.context.scene.collection.objects.link(obj)
    bpy.context.scene.camera = obj
    return obj


def look_at(cam, eye, target):
    cam.location = Vector(eye)
    d = Vector(target) - Vector(eye)
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def frame_objects(cam, objects, azimuth_deg=35.0, elevation_deg=8.0, margin=1.15):
    lo, hi = bounds_of(objects)
    centre = (lo + hi) * 0.5
    radius = (hi - lo).length * 0.5
    fov = 2 * math.atan(min(cam.data.sensor_width, cam.data.sensor_width * 9 / 16) / (2 * cam.data.lens))
    dist = radius * margin / math.sin(fov / 2)
    az = math.radians(azimuth_deg)
    el = math.radians(elevation_deg)
    eye = centre + Vector((math.cos(az) * math.cos(el), math.sin(az) * math.cos(el), math.sin(el))) * dist
    look_at(cam, eye, centre)


def render(path):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
