"""Builds the small test GLB for the pipeline tools (not a game asset).

  blender -b -P tools/pipeline/fixtures/make_test_glb.py -- <out.glb> [texture.png]

A skinned, textured, vertex-coloured tapered tube with 3 LOD nodes (LOD0..LOD2), a 4-bone chain,
3 materials (Hide, Membrane, Runes; Membrane and Runes have identical values on purpose, so a
careless dedup would merge them), an empty socket node "Muzzle" and 2 clips ("glide", "flap").
"""
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
out_path = os.path.abspath(argv[0])
texture_path = os.path.abspath(argv[1]) if len(argv) > 1 else None

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 30

BONES = ["Root", "Spine", "Neck", "Head"]
LENGTH = 4.0


def make_material(name, color, image):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Roughness"].default_value = 0.8
    if image is not None:
        tex = mat.node_tree.nodes.new("ShaderNodeTexImage")
        tex.image = image
        mat.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    return mat


image = bpy.data.images.load(texture_path) if texture_path else None
materials = [
    make_material("Hide", (0.8, 0.8, 0.8, 1.0), image),
    make_material("Membrane", (0.9, 0.4, 0.2, 1.0), None),
    make_material("Runes", (0.9, 0.4, 0.2, 1.0), None),
]

# Armature: a 4-bone chain along +Y.
arm_data = bpy.data.armatures.new("Rig")
arm_obj = bpy.data.objects.new("Rig", arm_data)
scene.collection.objects.link(arm_obj)
bpy.context.view_layer.objects.active = arm_obj
bpy.ops.object.mode_set(mode="EDIT")
parent = None
for i, name in enumerate(BONES):
    bone = arm_data.edit_bones.new(name)
    bone.head = Vector((0, i * LENGTH / len(BONES), 0))
    bone.tail = Vector((0, (i + 1) * LENGTH / len(BONES), 0))
    bone.parent = parent
    bone.use_connect = parent is not None
    parent = bone
bpy.ops.object.mode_set(mode="OBJECT")


def make_tube(name, segments, rings):
    verts, faces = [], []
    for r in range(rings + 1):
        t = r / rings
        radius = 0.5 * (1.0 - 0.6 * t)
        for s in range(segments):
            a = 2 * math.pi * s / segments
            verts.append((radius * math.cos(a), t * LENGTH, radius * math.sin(a)))
    for r in range(rings):
        for s in range(segments):
            a = r * segments + s
            b = r * segments + (s + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, [], faces)
    for mat in materials:
        mesh.materials.append(mat)
    uv_layer = mesh.uv_layers.new(name="UVMap")
    colors = mesh.color_attributes.new(name="Color", type="BYTE_COLOR", domain="CORNER")
    for poly in mesh.polygons:
        ring = poly.index // segments
        # Three bands along the length -> three material slots.
        poly.material_index = min(2, ring * 3 // rings)
        for loop_index in poly.loop_indices:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            angle = math.atan2(co.z, co.x) / (2 * math.pi) + 0.5
            uv_layer.data[loop_index].uv = (angle, co.y / LENGTH)
            shade = 0.35 + 0.65 * co.y / LENGTH
            colors.data[loop_index].color = (shade, shade * 0.8, 1.0 - shade * 0.5, 1.0)
    mesh.color_attributes.active_color = colors
    mesh.color_attributes.render_color_index = 0
    obj = bpy.data.objects.new(name, mesh)
    scene.collection.objects.link(obj)
    obj.parent = arm_obj
    for i, bone_name in enumerate(BONES):
        group = obj.vertex_groups.new(name=bone_name)
        for v in mesh.vertices:
            x = v.co.y / LENGTH * len(BONES) - 0.5
            weight = max(0.0, 1.0 - abs(x - i))
            if i == 0 and x < 0:
                weight = 1.0
            if i == len(BONES) - 1 and x > i:
                weight = 1.0
            if weight > 0:
                group.add([v.index], weight, "REPLACE")
    modifier = obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = arm_obj
    return obj


make_tube("LOD0", 24, 16)  # 768 triangles
make_tube("LOD1", 12, 8)  # 192
make_tube("LOD2", 6, 4)  # 48

socket = bpy.data.objects.new("Muzzle", None)
scene.collection.objects.link(socket)
socket.parent = arm_obj
socket.parent_type = "BONE"
socket.parent_bone = "Head"

# Two clips as NLA tracks: the track name becomes the glTF animation name.
arm_obj.animation_data_create()


def make_clip(name, frames, amplitude):
    action = bpy.data.actions.new(name)
    arm_obj.animation_data.action = action
    for pose_bone in arm_obj.pose.bones:
        pose_bone.rotation_mode = "QUATERNION"
    for frame in range(0, frames + 1):
        phase = 2 * math.pi * frame / frames
        for i, pose_bone in enumerate(arm_obj.pose.bones):
            angle = amplitude * math.sin(phase + i * 0.6)
            pose_bone.rotation_quaternion = (math.cos(angle / 2), math.sin(angle / 2), 0, 0)
            pose_bone.keyframe_insert("rotation_quaternion", frame=frame)
    arm_obj.animation_data.action = None
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = name
    track.strips.new(name, 0, action)
    for pose_bone in arm_obj.pose.bones:
        pose_bone.rotation_quaternion = (1, 0, 0, 0)


make_clip("glide", 60, 0.08)
make_clip("flap", 24, 0.35)

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    export_animations=True,
    export_animation_mode="NLA_TRACKS",
    export_skins=True,
    export_vertex_color="ACTIVE",
    export_all_vertex_colors=False,
    export_active_vertex_color_when_no_material=True,
    export_yup=True,
    export_image_format="AUTO",
)
print("wrote", out_path)
