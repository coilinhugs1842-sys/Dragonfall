"""Blender (headless) build of one dragon class: meshes, rig, clips, GLB export, preview renders.

  blender -b -P tools/blender/dragons/build_dragon.py -- <class> [--no-export] [--no-render]
          [--views a,b,c] [--clay] [--out <dir>]

Reads   art-source/dragons/<class>/<class>_base.png and _emissive.png (from paint_dragon.py)
Writes  art-source/dragons/<class>/<class>.glb          (raw export, PNG textures)
        art-source/dragons/<class>/<class>_info.json    (bones, clips, triangle counts)
        art-source/_scratch/dragons/<class>_*.png       (previews; final ones are copied by make_sheets.py)
"""
import importlib
import json
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
sys.path.insert(0, HERE)

from dragonlib import dragon as D  # noqa: E402
from dragonlib import anim as A  # noqa: E402
from dragonlib.geom import MAT_NAMES  # noqa: E402

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
CLS = argv[0]
FLAGS = set(a for a in argv[1:] if a.startswith('--'))


def opt(name, default=None):
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


PARAMS = importlib.import_module('classes.' + CLS).PARAMS
SRC = os.path.join(REPO, 'art-source', 'dragons', CLS)
SCRATCH = opt('--out', os.path.join(REPO, 'art-source', '_scratch', 'dragons'))
os.makedirs(SRC, exist_ok=True)
os.makedirs(SCRATCH, exist_ok=True)
FPS = 30
TEAM = {'ember': (1.0, 0.478, 0.102), 'frost': (0.247, 0.843, 1.0)}


def srgb_lin(c):
    return tuple(((x + 0.055) / 1.055) ** 2.4 if x > 0.04045 else x / 12.92 for x in c)


# --- scene -----------------------------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.unit_settings.system = 'METRIC'


def load_image(suffix, colorspace):
    path = os.path.join(SRC, '%s_%s.png' % (CLS, suffix))
    if not os.path.exists(path):
        return None
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = colorspace
    return img


img_base = None if '--clay' in FLAGS else load_image('base', 'sRGB')
img_emis = None if '--clay' in FLAGS else load_image('emissive', 'sRGB')
CLAY = {'Hide': (0.55, 0.55, 0.55, 1), 'Membrane': (0.75, 0.5, 0.35, 1), 'Runes': (0.3, 0.6, 0.8, 1)}


def make_material(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.85 if name != 'Hide' else 0.72
    bsdf.inputs['Metallic'].default_value = 0.0
    if img_base is not None:
        tex = nt.nodes.new('ShaderNodeTexImage')
        tex.image = img_base
        tex.name = 'BaseTex'
        nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    else:
        bsdf.inputs['Base Color'].default_value = CLAY[name]
    if name != 'Hide' and img_emis is not None:
        et = nt.nodes.new('ShaderNodeTexImage')
        et.image = img_emis
        et.name = 'EmisTex'
        nt.links.new(et.outputs['Color'], bsdf.inputs['Emission Color'])
        bsdf.inputs['Emission Strength'].default_value = 1.0
    m.use_backface_culling = name != 'Membrane'
    return m


mats = [make_material(n) for n in MAT_NAMES]

# --- meshes ----------------------------------------------------------------------------------
meshes = D.build_all(PARAMS)
skel, skinfo = D.skeleton(PARAMS)


def make_object(name, mesh):
    me = bpy.data.meshes.new(name)
    me.from_pydata(mesh.verts.tolist(), [], mesh.tris.tolist())
    me.update()
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set('material_index', mesh.fmat.astype(np.int32))
    me.polygons.foreach_set('use_smooth', np.ones(len(mesh.tris), bool))
    uvl = me.uv_layers.new(name='UVMap')
    uvl.data.foreach_set('uv', mesh.uv[mesh.tris.reshape(-1)].astype(np.float32).ravel())
    me.normals_split_custom_set_from_vertices(mesh.normals.tolist())
    me.update()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    for bi, bname in enumerate(D.BONES):
        idx = np.flatnonzero(mesh.w[:, bi] > 0)
        if len(idx) == 0:
            continue
        vg = ob.vertex_groups.new(name=bname)
        for i in idx:
            vg.add([int(i)], float(mesh.w[i, bi]), 'REPLACE')
    return ob


lod_obs = [make_object('LOD%d' % i, meshes[i]) for i in (0, 1, 2)]

# --- armature ------------------------------------------------------------------------------------
arm_data = bpy.data.armatures.new(CLS + '_rig')
arm = bpy.data.objects.new(CLS, arm_data)
scene.collection.objects.link(arm)
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
for name, parent, head, tail in skel:
    eb = arm_data.edit_bones.new(name)
    eb.head = Vector(head)
    eb.tail = Vector(tail)
    d = (eb.tail - eb.head).normalized()
    eb.align_roll(Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((0, -1, 0)))
    if parent:
        eb.parent = arm_data.edit_bones[parent]
        eb.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')
for ob in lod_obs:
    ob.parent = arm
    mod = ob.modifiers.new('Armature', 'ARMATURE')
    mod.object = arm

REST = {b.name: np.array(b.matrix_local.to_3x3()) for b in arm_data.bones}
for pb in arm.pose.bones:
    pb.rotation_mode = 'QUATERNION'


def apply_pose(pose):
    """pose: {bone: 3x3 rotation in armature axes}, optional 'root_loc' (armature-space offset)."""
    for pb in arm.pose.bones:
        R = pose.get(pb.name)
        Rb = REST[pb.name]
        if R is None:
            pb.rotation_quaternion = Quaternion((1, 0, 0, 0))
        else:
            pb.rotation_quaternion = Matrix((Rb.T @ R @ Rb).tolist()).to_quaternion()
        pb.location = Vector((0, 0, 0))
    loc = pose.get('root_loc')
    if loc is not None:
        arm.pose.bones['root'].location = Vector((REST['root'].T @ np.asarray(loc)).tolist())


clip_info = {}
if '--no-anim' not in FLAGS:
    arm.animation_data_create()
    for clip in A.CLIPS:
        nfr = int(round(clip['duration'] * FPS))
        act = bpy.data.actions.new(clip['name'])
        arm.animation_data.action = act
        prev = {}
        for f in range(nfr + 1):
            ph = f / nfr
            pose = clip['fn'](0.0 if (clip['loop'] and f == nfr) else ph, PARAMS)
            apply_pose(pose)
            for pb in arm.pose.bones:
                q = pb.rotation_quaternion.copy()
                if pb.name in prev and prev[pb.name].dot(q) < 0:
                    q.negate()
                    pb.rotation_quaternion = q
                prev[pb.name] = q
                pb.keyframe_insert('rotation_quaternion', frame=f)
            arm.pose.bones['root'].keyframe_insert('location', frame=f)
        clip_info[clip['name']] = dict(duration=nfr / FPS, loop=clip['loop'], frames=nfr + 1)
        arm.animation_data.action = None
        tr = arm.animation_data.nla_tracks.new()
        tr.name = clip['name']
        st = tr.strips.new(clip['name'], 0, act)
        st.name = clip['name']
        tr.mute = True
    apply_pose({})

# --- export --------------------------------------------------------------------------------------
tri_counts = [int(meshes[i].ntris) for i in (0, 1, 2)]
glb_path = os.path.join(SRC, CLS + '.glb')
if '--no-export' not in FLAGS:
    for tr in (arm.animation_data.nla_tracks if arm.animation_data else []):
        tr.mute = False
    kw = dict(filepath=glb_path, export_format='GLB', export_yup=True, export_apply=False,
              export_animations=True, export_animation_mode='NLA_TRACKS', export_skins=True,
              export_tangents=False, export_normals=True, export_texcoords=True,
              export_materials='EXPORT', export_image_format='AUTO', export_cameras=False,
              export_lights=False, export_force_sampling=True, export_frame_range=False,
              export_optimize_animation_size=True, export_optimize_animation_keep_anim_armature=True,
              export_reset_pose_bones=True, export_morph=False, export_def_bones=False,
              export_all_influences=False, export_extras=False, export_nla_strips=True)
    try:
        bpy.ops.export_scene.gltf(**kw)
    except TypeError as e:
        print('EXPORT retry without optional args:', e)
        for k in ('export_optimize_animation_keep_anim_armature', 'export_all_influences',
                  'export_nla_strips', 'export_frame_range'):
            kw.pop(k, None)
        bpy.ops.export_scene.gltf(**kw)
    for tr in (arm.animation_data.nla_tracks if arm.animation_data else []):
        tr.mute = True
    xs = meshes[0].verts[:, 0]
    info = dict(
        classId=CLS, triangles=tri_counts, vertices=[int(len(meshes[i].verts)) for i in (0, 1, 2)],
        bones=D.BONES, parents=D.PARENT, clips=clip_info,
        wingspan=round(float(xs.max() - xs.min()), 2),
        length=round(float(meshes[0].verts[:, 1].max() - meshes[0].verts[:, 1].min()), 2),
        height=round(float(meshes[0].verts[:, 2].max() - meshes[0].verts[:, 2].min()), 2),
        # glTF space: x = left, y = up, z = forward
        muzzle=[round(float(skinfo['muzzle'][0]), 3), round(float(skinfo['muzzle'][2]), 3),
                round(float(-skinfo['muzzle'][1]), 3)],
        raw_glb_bytes=os.path.getsize(glb_path),
    )
    with open(os.path.join(SRC, CLS + '_info.json'), 'w') as fh:
        json.dump(info, fh, indent=1)
    print('EXPORTED', glb_path, info['raw_glb_bytes'], 'bytes', 'tris', tri_counts)
else:
    print('TRIS', tri_counts, 'VERTS', [len(meshes[i].verts) for i in (0, 1, 2)])

# --- preview renders ---------------------------------------------------------------------------
if '--no-render' in FLAGS:
    sys.exit(0)

team = opt('--team', 'ember')
tcol = srgb_lin(TEAM[team])
for m in mats:
    nt = m.node_tree
    et = nt.nodes.get('EmisTex')
    if et is None:
        continue
    bsdf = nt.nodes['Principled BSDF']
    mix = nt.nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.blend_type = 'MULTIPLY'
    mix.inputs[0].default_value = 1.0
    nt.links.new(et.outputs['Color'], mix.inputs[6])
    mix.inputs[7].default_value = (*tcol, 1)
    nt.links.new(mix.outputs[2], bsdf.inputs['Emission Color'])
    bsdf.inputs['Emission Strength'].default_value = 2.5 if m.name == 'Runes' else 0.75

silhouette = '--silhouette' in FLAGS
world = bpy.data.worlds.new('W')
scene.world = world
world.use_nodes = True
wn = world.node_tree
bg = wn.nodes['Background']
if silhouette:
    bg.inputs[0].default_value = (1, 1, 1, 1)
    bg.inputs[1].default_value = 1.0
else:
    tc = wn.nodes.new('ShaderNodeTexCoord')
    sep = wn.nodes.new('ShaderNodeSeparateXYZ')
    ramp = wn.nodes.new('ShaderNodeValToRGB')
    mp = wn.nodes.new('ShaderNodeMapRange')
    wn.links.new(tc.outputs['Generated'], sep.inputs[0])
    wn.links.new(sep.outputs['Z'], mp.inputs[0])
    mp.inputs[1].default_value = -1
    mp.inputs[2].default_value = 1
    wn.links.new(mp.outputs[0], ramp.inputs[0])
    el = ramp.color_ramp.elements
    el[0].position = 0.0
    el[0].color = (*srgb_lin((0.25, 0.35, 0.34)), 1)
    el[1].position = 1.0
    el[1].color = (*srgb_lin((0.42, 0.55, 0.80)), 1)
    e = el.new(0.5)
    e.color = (*srgb_lin((0.957, 0.83, 0.70)), 1)
    e2 = el.new(0.62)
    e2.color = (*srgb_lin((0.80, 0.78, 0.84)), 1)
    wn.links.new(ramp.outputs[0], bg.inputs[0])
    # the camera sees the sky at full strength; the dragon is lit by a dimmer cool hemisphere
    lp = wn.nodes.new('ShaderNodeLightPath')
    mx = wn.nodes.new('ShaderNodeMix')
    mx.inputs[2].default_value = float(opt('--ambient', '0.55'))
    mx.inputs[3].default_value = 1.0
    wn.links.new(lp.outputs['Is Camera Ray'], mx.inputs[0])
    wn.links.new(mx.outputs[0], bg.inputs[1])
    sun_d = bpy.data.lights.new('Sun', 'SUN')
    sun_d.energy = float(opt('--sun', '4.0'))
    sun_d.color = srgb_lin((1.0, 0.85, 0.63))
    sun_d.angle = math.radians(3)
    sun = bpy.data.objects.new('Sun', sun_d)
    scene.collection.objects.link(sun)
    # low warm sun from the front-left, 22 degrees above the horizon
    sun.rotation_euler = (math.radians(68), 0, math.radians(215))

for eng in ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'):
    try:
        scene.render.engine = eng
        break
    except TypeError:
        pass
if silhouette:
    for m in mats:
        nt = m.node_tree
        nt.nodes.clear()
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        em = nt.nodes.new('ShaderNodeEmission')
        em.inputs[0].default_value = (0, 0, 0, 1)
        nt.links.new(em.outputs[0], out.inputs[0])
        m.use_backface_culling = False
try:
    scene.view_settings.view_transform = 'Standard' if silhouette else opt('--vt', 'Filmic')
    scene.view_settings.look = 'None' if silhouette else 'Medium High Contrast'
except Exception as ex:  # noqa: BLE001
    print('view settings:', ex)
scene.render.film_transparent = False
W_, H_ = (int(v) for v in opt('--res', '960x640').split('x'))
scene.render.resolution_x, scene.render.resolution_y = W_, H_
scene.render.image_settings.file_format = 'PNG'
try:
    scene.eevee.taa_render_samples = 24
except Exception:  # noqa: BLE001
    pass

cam_d = bpy.data.cameras.new('Cam')
cam = bpy.data.objects.new('Cam', cam_d)
scene.collection.objects.link(cam)
scene.camera = cam
cam_d.lens = 60
cam_d.clip_end = 2000

lod_show = int(opt('--lod', '0'))
for i, ob in enumerate(lod_obs):
    ob.hide_render = i != lod_show


def look(az, el, dist, target=(0, 0, 0), ortho=None):
    """az 0 = camera in front of the dragon, 90 = on its left side; el = elevation in degrees."""
    a, e = math.radians(az), math.radians(el)
    pos = Vector((math.sin(a) * math.cos(e) * dist, -math.cos(a) * math.cos(e) * dist, math.sin(e) * dist))
    tgt = Vector(target)
    cam.location = tgt + pos
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    if ortho:
        cam_d.type = 'ORTHO'
        cam_d.ortho_scale = ortho
    else:
        cam_d.type = 'PERSP'


length = PARAMS['torso_len'] + PARAMS['tail_len'] + PARAMS['neck_len'] + PARAMS['head_len']
ctr = (0, (PARAMS['tail_len'] - PARAMS['neck_len'] - PARAMS['head_len']) / 2 * 0.6, 0.1)
VIEWS = {
    'front34': dict(az=38, el=16, dist=24, target=ctr),
    'side': dict(az=90, el=4, dist=24, target=ctr),
    'top': dict(az=0.01, el=89, dist=31, target=ctr),
    'back34': dict(az=150, el=22, dist=23, target=ctr),
    'below': dict(az=30, el=-35, dist=23, target=ctr),
    'hero': dict(az=35, el=12, dist=14.5, target=(0, -1.6, 0.4)),
    'head': dict(az=55, el=8, dist=8.5, target=(0, -(PARAMS['torso_len'] / 2 + PARAMS['neck_len'] * 0.8), 0.7)),
    'rider': dict(az=120, el=24, dist=11, target=(0, -0.6, 0.9)),
}
POSES = {
    'rest': None,
    'flap0': ('flap', 0.0), 'flap1': ('flap', 0.25), 'flap2': ('flap', 0.5), 'flap3': ('flap', 0.75),
    'dive': ('dive', 0.3), 'bank': ('bank_l', 0.3), 'hover': ('hover', 0.2), 'roar': ('roar', 0.45),
    'boost': ('boost', 0.3), 'hit': ('hit', 0.25), 'death': ('death_fall', 0.4), 'land': ('land', 0.7),
    'takeoff': ('takeoff', 0.35), 'glide': ('glide', 0.5),
}
CLIPMAP = {c['name']: c for c in A.CLIPS}
shots = opt('--views', 'front34,side,top,back34').split(',')
tag = opt('--tag', '')
for shot in shots:
    if ':' in shot:
        vname, pname = shot.split(':')
    else:
        vname, pname = shot, 'rest'
    ps = POSES[pname]
    apply_pose({} if ps is None else CLIPMAP[ps[0]]['fn'](ps[1], PARAMS))
    v = VIEWS[vname]
    if silhouette:
        look(v['az'], v['el'], 200, v['target'], ortho=24)
    else:
        look(v['az'], v['el'], v['dist'], v['target'])
    scene.render.filepath = os.path.join(SCRATCH, '%s_%s_%s%s.png' % (CLS, vname, pname, tag))
    bpy.ops.render.render(write_still=True)
    print('RENDERED', scene.render.filepath)
