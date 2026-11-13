"""Granite: living boulder siege — squat body, stubby wings, paddle tail, dense neck plates."""

PARAMS = dict(
    name='granite',
    seed=109,
    girth=1.7, torso_len=2.7,
    hips=(0.58, 0.55, 0.54), mid=(0.7, 0.62, 0.68), chest=(0.78, 0.74, 0.8),
    # Short thick paddle, not Bastion's club.
    tail_len=3.2, tail_droop=0.08, tail_rise=0.15, tail_taper=0.45, tail_w=1.45, tail_tip_r=0.12,
    tail_ridge=0.08,
    neck_len=1.15, neck_elev=6, neck_arch=0.03, neck_r=0.52,
    head_len=2.05, head_w=1.25, head_h=1.05, head_pitch=10,
    head_shape=dict(skull_w=0.58, brow_w=0.62, snout_w=0.52, nose_w=0.48, tip_w=0.38, tip_t=0.3, nose_t=0.36,
                    snout_t=0.34, shelf=(0.14, 0.18, 0.1, 0.0, 0.0)),
    jaw_shape=dict(mid_d=0.28, fwd_d=0.26, tip_d=0.2),
    scale_freq=2.2,
    leg_scale=1.08,
    leg_h=dict(pts=[(0.48, -0.02, -1.05), (0.7, -0.42, -0.7), (0.66, -0.58, -1.55), (0.56, -0.48, -2.15)],
               r=[0.42, 0.32, 0.18, 0.2], claw=0.28),
    leg_f=dict(pts=[(0.52, -0.18, 1.1), (0.7, -0.58, 0.65), (0.64, -0.78, 1.15), (0.54, -0.68, 1.5)],
               r=[0.34, 0.26, 0.16, 0.18], claw=0.26),
    # Stubby broad wings — siege flyer, not Bastion's wide sails.
    wing=dict(sx=0.58, su=0.78, sf=1.0, dihedral=12, tip_droop=0.04,
              hum=1.55, hum_ang=14, fore=1.75, fore_ang=18, arm_r=0.3,
              rays=[dict(ang=24, len=2.7, curve=12, bone=1, r=0.13),
                    dict(ang=55, len=2.45, curve=9, bone=2, r=0.11),
                    dict(ang=84, len=2.1, curve=5, bone=3, r=0.1)],
              bx=0.66, bu=0.28, bf=-1.35, scallop=0.06, scallop_in=0.08, billow=0.35,
              thumb=0.9, thumb_r=1.7),
    # Densely plated neck-to-hips: overlapping slabs.
    plates=[
        dict(t0=11.5, t1=10.2, count=3, a=1.0, dt=0.28, da=0.35, lift=0.09, min=0.85),
        dict(t0=10.0, t1=8.2, count=4, a=1.0, dt=0.3, da=0.28, lift=0.1, min=0.8),
        dict(t0=8.0, t1=5.5, count=5, a=0.9, dt=0.32, da=0.22, lift=0.1, min=0.7),
        dict(t0=5.2, t1=3.0, count=4, a=0.85, dt=0.34, da=0.18, lift=0.08, min=0.65),
        dict(t0=12.8, t1=12.8, count=1, a=1.0, dt=0.55, da=0.4, lift=0.08, min=1.0),
        dict(t0=12.4, t1=12.4, count=1, a=0.7, dt=0.4, da=0.3, lift=0.06, min=0.9),
    ],
    spike_rows=[dict(t0=2.8, t1=0.8, count=5, h=0.22, len=0.28, w=0.24, lean=0.3, min=0.75)],
    surf_spikes=[
        dict(t=13.1, a=0.7, len=0.55, w=0.35, h=0.22, lean=1.0, name='brow_slab'),
        dict(t=12.4, a=0.4, len=0.45, w=0.28, h=0.28, lean=0.8, name='cheek_slab'),
        dict(t=1.4, a=0.0, len=0.35, w=0.18, h=0.18, lean=0.7, jaw=True, name='chin'),
    ],
    # Short horn stubs — rocky, not Bastion's swept horns.
    horns=[
        dict(t=12.2, a=0.8, dir=(0.4, 0.7, -0.3), len=0.45, r=0.16, bend=-8, taper=0.55, segs=4, rings=2),
        dict(t=12.05, a=0.55, dir=(0.6, 0.3, -0.4), len=0.35, r=0.12, bend=-5, taper=0.6, segs=3, small=True),
        dict(t=14.8, a=1.0, dir=(0.0, 0.8, -0.2), len=0.3, r=0.14, bend=5, taper=0.6, segs=3, mirror=False),
    ],
    eye=dict(t=13.4, a=0.55, rx=0.16, ry=0.09, tilt=4),
    teeth=[dict(t0=14.1, t1=15.8, a=0.2, count=5, len=0.14, fangs=(3,), big=1.6),
           dict(t0=1.2, t1=2.8, a=0.80, count=4, len=0.12, fangs=(2,), big=1.5, jaw=True)],
    rider=dict(t=7.35, scale=1.05),
    palette=dict(
        back=(0.22, 0.24, 0.26), mid=(0.38, 0.40, 0.44), flank=(0.52, 0.54, 0.58), belly=(0.72, 0.74, 0.76),
        accent=(0.14, 0.15, 0.17), horn=(0.78, 0.80, 0.84), horn_dark=(0.28, 0.30, 0.34),
        plate=(0.40, 0.42, 0.46), plate_edge=(0.72, 0.76, 0.82),
        memb_dark=(0.18, 0.20, 0.24), memb_light=(0.48, 0.52, 0.58), memb_warm=(0.68, 0.70, 0.72),
        spike=(0.30, 0.32, 0.36), spike_tip=(0.82, 0.84, 0.88), eye=(0.85, 0.92, 1.0), pattern='blotch',
        saddle=(0.22, 0.22, 0.24), rider=(0.30, 0.32, 0.36), rider_armor=(0.62, 0.66, 0.72),
    ),
)
