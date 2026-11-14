"""Animation clips as pure functions: phase in [0, 1] -> pose.

A pose maps bone name -> 3x3 rotation expressed in armature (Blender) axes relative to the
parent's posed frame, plus an optional 'root_loc' offset in metres. build_dragon.py converts
that to bone-local quaternions and keys every frame at 30 fps.

Clip names are DRAGON_ANIM_CLIPS in src/shared/world-view.ts.
"""
import numpy as np
from .geom import rot_axis, LEFT, FWD, UP, PI

TAU = 2 * PI
MIRROR = np.diag([-1.0, 1.0, 1.0])
I3 = np.eye(3)


def rx(d):
    return rot_axis(LEFT, np.radians(d))


def rf(d):
    return rot_axis(FWD, np.radians(d))


def rz(d):
    return rot_axis(UP, np.radians(d))


def track(ph, keys):
    """Smooth piecewise interpolation through (phase, value) keys."""
    ks = sorted(keys)
    if ph <= ks[0][0]:
        return ks[0][1]
    for (a, va), (b, vb) in zip(ks, ks[1:]):
        if ph <= b:
            t = (ph - a) / (b - a)
            t = t * t * (3 - 2 * t)
            return va + (vb - va) * t
    return ks[-1][1]


def s(ph, cycles=1.0, lag=0.0):
    return np.sin(TAU * cycles * ph - lag)


def wing(pose, side, P, flap=0, sweep=0, twist=0, elbow=0, wrist=0, close=0, elbow_lag=0,
         wrist_lag=0, finger_lag=0, elbow_twist=0):
    """One wing. flap + = up, sweep + = back, twist + = leading edge down, elbow/wrist + = fold,
    close 0..1 = fingers gathered toward the leading finger, *_lag + = that segment bent upward."""
    rays = {r['bone']: r for r in P['wing']['rays'] if isinstance(r['bone'], int)}
    a1 = rays[1]['ang']
    L = {
        'wing_shoulder': rz(sweep) @ rf(flap) @ rx(twist),
        'wing_elbow': rz(-elbow) @ rf(elbow_lag) @ rx(elbow_twist),
        'wing_wrist': rz(wrist) @ rf(wrist_lag),
        'wing_finger1': rf(finger_lag) @ rz(-close * 6),
        'wing_finger2': rf(finger_lag * 1.1) @ rz(-(rays[2]['ang'] - a1) * close),
        'wing_finger3': rf(finger_lag * 1.2) @ rz(-(rays[3]['ang'] - a1) * close),
    }
    for k, R in L.items():
        pose[k + side] = R if side == '_L' else MIRROR @ R @ MIRROR


def wings(pose, P, **kw):
    wing(pose, '_L', P, **kw)
    wing(pose, '_R', P, **kw)


def spine(pose, root_pitch=0, root_roll=0, root_yaw=0, chest=0, hips=0, neck=(0, 0, 0), head=0,
          jaw=0, tail=(0, 0, 0, 0), neck_yaw=(0, 0, 0), head_yaw=0, tail_yaw=(0, 0, 0, 0),
          head_roll=0, chest_yaw=0, hips_yaw=0, loc=(0, 0, 0)):
    """Pitch + = nose/tail tip up. Yaw + = toward the dragon's left."""
    pose['root'] = rz(root_yaw) @ rx(-root_pitch) @ rf(root_roll)
    pose['chest'] = rz(chest_yaw) @ rx(-chest)
    pose['hips'] = rz(-hips_yaw) @ rx(hips)
    for i in range(3):
        pose['neck%d' % (i + 1)] = rz(neck_yaw[i]) @ rx(-neck[i])
    pose['head'] = rz(head_yaw) @ rx(-head) @ rf(head_roll)
    pose['jaw'] = rx(jaw)
    for i in range(4):
        pose['tail%d' % (i + 1)] = rz(-tail_yaw[i]) @ rx(tail[i])
    pose['root_loc'] = np.array([loc[0], -loc[2], loc[1]], float)  # (x, up, fwd) -> Blender
    return pose


def mirror_pose(pose):
    out = {}
    for k, v in pose.items():
        if k == 'root_loc':
            out[k] = v * np.array([-1.0, 1.0, 1.0])
            continue
        nk = k[:-2] + ('_R' if k.endswith('_L') else '_L') if k[-2:] in ('_L', '_R') else k
        out[nk] = MIRROR @ v @ MIRROR
    return out


# --- loops ---------------------------------------------------------------------------------------

def glide(ph, P):
    pose = {}
    b = s(ph)
    spine(pose, chest=0.8 * b, hips=0.8 * s(ph, lag=0.6),
          neck=(0.8 * s(ph, lag=0.5), 0.9 * s(ph, lag=0.9), 0.8 * s(ph, lag=1.3)),
          head=-1.6 * s(ph, lag=1.2),
          neck_yaw=(0.8 * s(ph, 1, 2.0), 0.6 * s(ph, 1, 2.4), 0),
          tail=tuple(1.8 * s(ph, lag=0.9 + 0.55 * k) for k in range(4)),
          tail_yaw=tuple((2.0 + 1.3 * k) * s(ph, 1, 0.3 + 0.7 * k) for k in range(4)),
          loc=(0, 0.05 * s(ph, lag=-0.4), 0))
    for side, off in (('_L', 0.0), ('_R', 0.35)):
        wing(pose, side, P, flap=2.6 * s(ph, lag=off), twist=1.2 * s(ph, 2, off),
             elbow=2 + 1.5 * s(ph, lag=off + 0.6), wrist=1.5 * s(ph, lag=off + 1.0),
             wrist_lag=2.4 * s(ph, lag=off + 0.9), finger_lag=3.0 * s(ph, 2, off + 1.5),
             close=0.02 + 0.02 * s(ph, lag=off + 2))
    return pose


def _flap_wings(pose, P, ph, amp=48.0, bias=6.0, fold=1.08, sweep=0.0, sweep_amp=9.0):
    th = TAU * ph
    f = max(0.0, -np.sin(th)) ** 1.25 * fold  # peaks mid upstroke
    wings(pose, P,
          flap=bias + amp * np.cos(th),
          sweep=sweep + sweep_amp * np.sin(th - 0.4) + 10 * f,
          twist=9 * np.sin(th) - 4 * f,
          elbow=7 + 30 * f,
          wrist=4 + 40 * f,
          close=0.04 + 0.3 * f,
          elbow_lag=amp * 0.30 * np.sin(th - 0.45),
          wrist_lag=amp * 0.42 * np.sin(th - 0.85),
          finger_lag=amp * 0.30 * np.sin(th - 1.3))


def flap(ph, P):
    pose = {}
    th = TAU * ph
    bob = -np.cos(th - 0.7)
    spine(pose, chest=3.2 * np.sin(th - 0.5), hips=3.5 * np.sin(th - 1.2),
          neck=(-2.6 * np.sin(th - 0.9), -2.2 * np.sin(th - 1.3), -1.2 * np.sin(th - 1.7)),
          head=3.0 * np.sin(th - 1.5),
          tail=tuple((4.0 + 1.8 * k) * np.sin(th - 1.4 - 0.65 * k) for k in range(4)),
          tail_yaw=tuple(1.5 * np.sin(th * 1 - 0.8 * k) for k in range(4)),
          loc=(0, 0.2 * bob, 0.04 * np.sin(th)))
    _flap_wings(pose, P, ph)
    return pose


def boost(ph, P):
    pose = {}
    th = TAU * ph
    spine(pose, chest=2.0 * np.sin(th - 0.5), hips=2.0 * np.sin(th - 1.2),
          neck=(-4 - 1.5 * np.sin(th - 0.9), -5 - 1.2 * np.sin(th - 1.3), -3),
          head=6 + 1.5 * np.sin(th - 1.5), jaw=3,
          tail=tuple((2.0 + 1.6 * k) * np.sin(th - 1.4 - 0.7 * k) + 1.5 for k in range(4)),
          tail_yaw=tuple(1.2 * np.sin(th - 0.8 * k) for k in range(4)),
          loc=(0, 0.1 * -np.cos(th - 0.7), 0.1 + 0.05 * np.sin(th)))
    _flap_wings(pose, P, ph, amp=25.0, bias=3.0, fold=0.7, sweep=16.0, sweep_amp=5.0)
    return pose


def _tuck(pose, P, k=1.0, flutter=0.0):
    wings(pose, P, flap=5 * k + flutter, sweep=58 * k, twist=-5 * k, elbow=72 * k, wrist=96 * k,
          close=0.9 * k, wrist_lag=flutter * 1.6, finger_lag=flutter * 2.2)


def dive(ph, P):
    pose = {}
    fl = 1.6 * s(ph, 4)
    spine(pose, root_pitch=-6, chest=-3, neck=(-8, -9 + 0.7 * s(ph, 2), -6), head=14 + 1.0 * s(ph, 2, 1.0), jaw=3,
          hips=-3.0,
          tail=tuple(3.6 + (1.0 + 0.6 * k) * s(ph, 3, 0.9 * k) for k in range(4)),
          tail_yaw=tuple((0.8 + 0.6 * k) * s(ph, 2, 0.5 + 0.9 * k) for k in range(4)),
          loc=(0.014 * s(ph, 4, 1.0), 0.025 * s(ph, 4), 0))
    _tuck(pose, P, 1.2, fl)
    return pose


def bank_l(ph, P):
    pose = {}
    b = s(ph)
    spine(pose, root_roll=-10, chest_yaw=8, neck_yaw=(9 + 0.8 * b, 10, 8), head_yaw=10 + 1.0 * s(ph, lag=1), head_roll=-14,
          neck=(2 + 0.8 * b, 2, 0), head=-3,
          hips_yaw=5,
          tail_yaw=tuple(-(7 + 2.6 * k) + 1.8 * s(ph, 1, 0.7 * k) for k in range(4)),
          tail=tuple(1.8 * s(ph, lag=0.9 + 0.5 * k) + 2.0 for k in range(4)),
          loc=(0, 0.05 * s(ph, lag=-0.4), 0))
    # inside (left) wing drops and gathers, outside wing lifts and reaches
    wing(pose, '_L', P, flap=-14 + 2 * b, sweep=18, twist=-6, elbow=28 + 3 * b, wrist=28, close=0.28,
         wrist_lag=-6 + 2.4 * s(ph, lag=0.9), finger_lag=-5 + 2.5 * s(ph, 2, 1.5))
    wing(pose, '_R', P, flap=16 + 2 * s(ph, lag=0.4), sweep=-5, twist=6, elbow=2, wrist=2, close=0.0,
         wrist_lag=6 + 2.4 * s(ph, lag=1.3), finger_lag=6 + 2.5 * s(ph, 2, 1.9))
    return pose


def bank_r(ph, P):
    return mirror_pose(bank_l(ph, P))


def hover(ph, P):
    pose = {}
    th = TAU * ph
    spine(pose, root_pitch=33, chest=4 + 2.5 * np.sin(th - 0.5), hips=-9 + 3 * np.sin(th - 1.2),
          neck=(-12 - 2 * np.sin(th - 0.9), -11 - 1.6 * np.sin(th - 1.3), -8), head=-4 + 2.5 * np.sin(th - 1.6),
          tail=tuple(-9 - 2 * k + (3.0 + 1.5 * k) * np.sin(th - 1.4 - 0.65 * k) for k in range(4)),
          tail_yaw=tuple(2.0 * np.sin(th - 0.8 * k) for k in range(4)),
          loc=(0, 0.22 * -np.cos(th - 0.7), 0))
    f = max(0.0, -np.sin(th)) ** 1.25
    wings(pose, P, flap=4 + 42 * np.cos(th), sweep=-6 - 14 * np.cos(th) + 12 * f, twist=-8 + 12 * np.sin(th) - 6 * f,
          elbow=8 + 34 * f, wrist=5 + 44 * f, close=0.04 + 0.34 * f,
          elbow_lag=11 * np.sin(th - 0.45), wrist_lag=16 * np.sin(th - 0.85), finger_lag=12 * np.sin(th - 1.3))
    return pose


def death_fall(ph, P):
    pose = {}
    b, c = s(ph), s(ph, 2)
    spine(pose, root_roll=9 * b, root_pitch=-14 + 4 * s(ph, lag=1.0), chest=6, hips=8 + 2 * c,
          neck=(13 + 3 * s(ph, lag=0.5), 15 + 3 * s(ph, lag=1.0), 12 + 3 * s(ph, lag=1.5)),
          head=10 + 5 * s(ph, lag=2.0), jaw=17 + 4 * c,
          neck_yaw=(5 * s(ph, lag=0.4), 6 * s(ph, lag=0.9), 6 * s(ph, lag=1.4)), head_yaw=8 * s(ph, lag=1.9),
          head_roll=10 * s(ph, lag=1.0),
          tail=tuple(12 + 3 * k + 4 * s(ph, lag=0.6 * k) for k in range(4)),
          tail_yaw=tuple(7 * s(ph, lag=0.8 + 0.7 * k) for k in range(4)),
          loc=(0.06 * b, 0.05 * c, 0))
    wing(pose, '_L', P, flap=46 + 7 * s(ph, lag=0.3), sweep=14, twist=-12, elbow=34 + 8 * s(ph, 2, 0.7), wrist=24 + 10 * s(ph, 2, 1.2),
         close=0.3, elbow_lag=10 + 5 * s(ph, 2, 0.9), wrist_lag=14 + 8 * s(ph, 2, 1.5), finger_lag=10 + 9 * s(ph, 3, 2.0))
    wing(pose, '_R', P, flap=38 + 9 * s(ph, lag=2.0), sweep=22, twist=-8, elbow=44 + 8 * s(ph, 2, 2.4), wrist=34 + 10 * s(ph, 2, 2.9),
         close=0.38, elbow_lag=12 + 5 * s(ph, 2, 2.6), wrist_lag=12 + 8 * s(ph, 2, 3.2), finger_lag=12 + 9 * s(ph, 3, 3.7))
    return pose


# --- one-shots (all start and end on the rest pose unless noted) ------------------------------------

def roar(ph, P):
    pose = {}
    rear = track(ph, [(0, 0), (0.18, -0.35), (0.34, 1.0), (0.72, 0.9), (1, 0)])  # -: wind up, +: thrust
    op = track(ph, [(0, 0), (0.2, 0.08), (0.34, 1.0), (0.70, 0.92), (0.86, 0.1), (1, 0)])
    shake = np.sin(TAU * 9 * ph) * track(ph, [(0, 0), (0.3, 0), (0.4, 1), (0.7, 1), (0.8, 0), (1, 0)])
    flare = track(ph, [(0, 0), (0.16, -0.3), (0.36, 1.0), (0.72, 0.85), (1, 0)])
    spine(pose, chest=7 * rear, hips=-3 * rear,
          neck=(9 * rear, 7 * rear + 0.6 * shake, -5 * rear), head=-13 * rear + 1.5 * shake, jaw=40 * op + 2 * shake * op,
          head_yaw=1.8 * shake, head_roll=2 * shake,
          tail=tuple((5 + 2 * k) * track(ph, [(0, 0), (0.25 + 0.05 * k, -0.5), (0.5 + 0.06 * k, 1), (1, 0)]) for k in range(4)),
          tail_yaw=tuple(5 * np.sin(TAU * 2 * ph - 0.8 * k) * flare for k in range(4)),
          loc=(0, 0.1 * flare, 0.06 * rear))
    wings(pose, P, flap=22 * flare + 1.4 * shake, sweep=-9 * flare, twist=-11 * flare, elbow=2 - 4 * flare, wrist=-4 * flare,
          wrist_lag=7 * flare + 2 * shake, finger_lag=6 * flare + 2.5 * shake)
    return pose


def _perched(pose, P, k):
    """Landed: body reared a little, wings folded against the flanks."""
    spine(pose, root_pitch=12 * k, chest=3 * k, hips=-4 * k, neck=(8 * k, 4 * k, -6 * k), head=-12 * k,
          tail=tuple(-(3 + 1.5 * i) * k for i in range(4)), loc=(0, -0.25 * k, 0))
    wings(pose, P, flap=16 * k, sweep=50 * k, twist=-4 * k, elbow=70 * k, wrist=96 * k, close=0.86 * k)


def blend(a, b, t):
    """Blend two poses (rotations via matrix lerp + re-orthonormalise; fine for these ranges)."""
    out = {}
    for k in set(a) | set(b):
        if k == 'root_loc':
            out[k] = a.get(k, np.zeros(3)) * (1 - t) + b.get(k, np.zeros(3)) * t
            continue
        m = a.get(k, I3) * (1 - t) + b.get(k, I3) * t
        u, _, vt = np.linalg.svd(m)
        out[k] = u @ vt
    return out


def land(ph, P):
    """Glide -> flare with braking beats -> settle into the perched pose (ends perched)."""
    flare = track(ph, [(0, 0), (0.22, 1), (0.62, 1), (0.85, 0), (1, 0)])
    settle = track(ph, [(0, 0), (0.6, 0), (1, 1)])
    th = TAU * 2.0 * min(ph / 0.7, 1.0)
    a = {}
    f = max(0.0, -np.sin(th)) ** 1.25
    spine(a, root_pitch=34 * flare, chest=5 * flare, hips=-10 * flare,
          neck=(-11 * flare, -10 * flare, -8 * flare), head=-3 * flare,
          tail=tuple((-8 - 3 * k) * flare + 4 * np.sin(th - 1.2 - 0.6 * k) * flare for k in range(4)),
          loc=(0, 0.15 * -np.cos(th - 0.7) * flare + 0.2 * flare, 0))
    wings(a, P, flap=(6 + 36 * np.cos(th)) * flare, sweep=(-10 - 10 * np.cos(th) + 10 * f) * flare,
          twist=(-12 + 10 * np.sin(th)) * flare, elbow=(6 + 30 * f) * flare, wrist=(4 + 38 * f) * flare,
          close=0.3 * f * flare, elbow_lag=11 * np.sin(th - 0.45) * flare, wrist_lag=15 * np.sin(th - 0.85) * flare,
          finger_lag=11 * np.sin(th - 1.3) * flare)
    b = {}
    _perched(b, P, 1.0)
    bounce = np.sin(PI * track(ph, [(0, 0), (0.78, 0), (1, 1)])) * 0.08
    out = blend(a, b, settle)
    out['root_loc'] = out['root_loc'] + np.array([0, 0, -bounce])
    return out


def takeoff(ph, P):
    """Perched -> crouch -> leap with two big beats -> rest pose (ends on glide's rest)."""
    perched = track(ph, [(0, 1), (0.16, 1), (0.42, 0), (1, 0)])
    crouch = track(ph, [(0, 0), (0.2, 1), (0.36, -0.5), (0.55, 0), (1, 0)])
    beat = track(ph, [(0, 0), (0.2, 0), (0.34, 1), (0.8, 1), (1, 0)])
    th = TAU * 2.0 * np.clip((ph - 0.2) / 0.8, 0, 1) + 0.25 * TAU
    a = {}
    f = max(0.0, -np.sin(th)) ** 1.25
    spine(a, root_pitch=18 * beat, chest=4 * beat * np.sin(th - 0.5), hips=-6 * beat,
          neck=(-7 * beat, -6 * beat, -4 * beat), head=-2 * beat,
          tail=tuple((-5 - 2 * k) * beat + 5 * np.sin(th - 1.3 - 0.6 * k) * beat for k in range(4)),
          loc=(0, 0.2 * -np.cos(th - 0.7) * beat, 0))
    wings(a, P, flap=(4 + 40 * np.cos(th)) * beat, sweep=(-4 + 6 * np.sin(th - 0.4) + 10 * f) * beat,
          twist=10 * np.sin(th) * beat, elbow=(6 + 32 * f) * beat, wrist=(4 + 40 * f) * beat, close=0.3 * f * beat,
          elbow_lag=11 * np.sin(th - 0.45) * beat, wrist_lag=15 * np.sin(th - 0.85) * beat,
          finger_lag=11 * np.sin(th - 1.3) * beat)
    b = {}
    _perched(b, P, 1.0)
    out = blend(a, b, perched)
    out['root_loc'] = out['root_loc'] + np.array([0, 0, -0.3 * crouch])
    return out


def hit(ph, P):
    pose = {}
    e = np.exp(-3.2 * ph) * (1 - ph) ** 0.8
    k = np.sin(TAU * 1.5 * ph) * e
    j = np.sin(TAU * 1.5 * ph - 0.9) * e
    jolt = track(ph, [(0, 0), (0.12, 1), (0.45, 0.2), (1, 0)])
    spine(pose, root_roll=7 * k, root_pitch=4 * jolt, chest=-5 * jolt, hips=5 * j,
          neck=(9 * jolt, 7 * j, 4 * j), head=-10 * jolt + 6 * j, jaw=14 * jolt,
          neck_yaw=(6 * k, 7 * j, 4 * j), head_yaw=9 * k, head_roll=8 * j,
          tail=tuple((6 + 2 * i) * np.sin(TAU * 1.5 * ph - 0.6 * i - 0.6) * e for i in range(4)),
          tail_yaw=tuple(8 * np.sin(TAU * 1.5 * ph - 0.7 * i - 0.3) * e for i in range(4)),
          loc=(0.08 * k, -0.12 * jolt, -0.1 * jolt))
    wing(pose, '_L', P, flap=15 * jolt + 6 * k, sweep=8 * jolt, elbow=14 * jolt, wrist=12 * jolt, close=0.1 * jolt,
         wrist_lag=10 * j, finger_lag=10 * j)
    wing(pose, '_R', P, flap=11 * jolt - 6 * k, sweep=10 * jolt, elbow=18 * jolt, wrist=14 * jolt, close=0.12 * jolt,
         wrist_lag=-8 * j + 8 * jolt, finger_lag=9 * j)
    return pose


CLIPS = [
    dict(name='glide', fn=glide, duration=4.0, loop=True),
    dict(name='flap', fn=flap, duration=1.0, loop=True),
    dict(name='boost', fn=boost, duration=0.6, loop=True),
    dict(name='dive', fn=dive, duration=2.0, loop=True),
    dict(name='bank_l', fn=bank_l, duration=3.0, loop=True),
    dict(name='bank_r', fn=bank_r, duration=3.0, loop=True),
    dict(name='hover', fn=hover, duration=1.2, loop=True),
    dict(name='roar', fn=roar, duration=2.2, loop=False),
    dict(name='land', fn=land, duration=1.6, loop=False),
    dict(name='takeoff', fn=takeoff, duration=1.4, loop=False),
    dict(name='hit', fn=hit, duration=0.5, loop=False),
    dict(name='death_fall', fn=death_fall, duration=2.0, loop=True),
]
