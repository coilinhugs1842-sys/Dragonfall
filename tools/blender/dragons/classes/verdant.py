"""Verdant: canopy support — short thick neck, leaf-sail dorsals, antler horns, jade/amethyst."""

PARAMS = dict(
    name='verdant',
    seed=71,
    girth=1.18, torso_len=2.85,
    hips=(0.46, 0.46, 0.44), mid=(0.56, 0.52, 0.56), chest=(0.66, 0.62, 0.76),
    tail_len=4.4, tail_droop=0.18, tail_rise=0.65, tail_taper=0.75, tail_w=1.05, tail_tip_r=0.045,
    neck_len=1.85, neck_elev=16, neck_arch=0.08, neck_r=0.34,
    head_len=1.55, head_w=0.82, head_h=0.72, head_pitch=18,
    head_shape=dict(skull_w=0.54, brow_w=0.58, snout_w=0.42, nose_w=0.34, tip_w=0.24, snout_t=0.3, nose_t=0.28,
                    tip_t=0.2, shelf=(0.12, 0.22, 0.1, 0.0, 0.0)),
    scale_freq=2.6,
    leg_scale=1.0,
    leg_h=dict(pts=[(0.38, -0.05, -1.0), (0.62, -0.48, -0.58), (0.58, -0.64, -1.5), (0.5, -0.5, -2.15)],
               r=[0.34, 0.24, 0.13, 0.15], claw=0.36),
    leg_f=dict(pts=[(0.44, -0.22, 1.05), (0.64, -0.66, 0.52), (0.56, -0.86, 1.1), (0.48, -0.76, 1.48)],
               r=[0.27, 0.19, 0.12, 0.14], claw=0.32),
    wing=dict(sx=0.42, su=0.5, sf=0.82, dihedral=12, tip_droop=0.04,
              hum=1.65, hum_ang=18, fore=2.2, fore_ang=24, arm_r=0.2,
              rays=[dict(ang=22, len=3.7, curve=12, bone=1, r=0.085),
                    dict(ang=48, len=3.9, curve=14, bone=(1, 2, 0.4), r=0.06),
                    dict(ang=72, len=3.6, curve=11, bone=2, r=0.07),
                    dict(ang=98, len=3.2, curve=8, bone=3, r=0.06)],
              bx=0.44, bu=0.08, bf=-1.7, scallop=0.42, scallop_in=0.35, billow=0.22, panel_div=0.55,
              thumb=0.45),
    # Leaf canopy: broad overlapping dorsal sails, not Tempest's thin crest.
    dorsal_fins=[
        dict(t0=12.6, t1=9.2, ribs=7, h=1.05, lean=0.55, scallop=0.55, skew=0.35, pw=0.7, rect='fin'),
        dict(t0=9.0, t1=5.8, ribs=6, h=0.9, lean=0.5, scallop=0.5, skew=0.4, pw=0.65, rect='fin'),
        dict(t0=5.5, t1=2.8, ribs=5, h=0.7, lean=0.45, scallop=0.48, skew=0.5, pw=0.6, rect='fin'),
        dict(t0=2.6, t1=0.2, ribs=5, h=0.55, lean=0.7, scallop=0.4, skew=0.9, pw=0.55, rect='fin'),
    ],
    fan_fins=[
        # Cheek leaves.
        dict(t=12.1, a=0.58, tips=[(0.15, 0.7, -0.35), (0.55, 0.55, -0.7), (0.72, 0.15, -0.55), (0.4, -0.25, -0.3)],
             scallop=0.45, inner=0.45, fine=True, base_dir=(0, 1, 0.2), base_len=0.35, name='leaf_cheek'),
        # Hip foliage.
        dict(origin=(0.55, 0.25, -1.4), wt=5.5, tips=[(0.35, 0.35, -0.4), (0.75, 0.15, -0.85), (0.55, -0.2, -0.55)],
             scallop=0.4, inner=0.45, face=(0, 1, 0), name='leaf_hip'),
        # Tail leaf cluster.
        dict(t=0.9, a=0.5, tips=[(0.1, 0.15, 0.2), (0.55, 0.25, -0.35), (0.7, 0.05, -0.9), (0.35, -0.1, -0.7), (0.08, -0.05, -0.2)],
             scallop=0.4, inner=0.4, face=(0, 1, 0), fine=True, name='leaf_tail'),
    ],
    spike_rows=[],
    surf_spikes=[
        dict(t=13.0, a=0.7, len=0.35, w=0.2, h=0.12, lean=1.4, name='brow'),
        dict(t=1.4, a=0.0, len=0.2, w=0.08, h=0.1, lean=0.9, jaw=True, small=True, name='chin'),
    ],
    # Branching antlers, not Tempest's single backward horn.
    horns=[
        dict(t=12.5, a=0.82, dir=(0.35, 0.85, -0.35), len=1.15, r=0.07, bend=28, taper=0.82, segs=7),
        dict(t=12.35, a=0.72, dir=(0.55, 0.55, -0.55), len=0.75, r=0.05, bend=18, taper=0.85, segs=5, small=True),
        dict(t=12.2, a=0.88, dir=(0.15, 0.9, 0.1), len=0.55, r=0.04, bend=12, taper=0.9, segs=4, small=True),
    ],
    eye=dict(t=13.4, a=0.58, rx=0.14, ry=0.08, tilt=8),
    teeth=[dict(t0=14.1, t1=15.7, a=0.2, count=6, len=0.065, fangs=(4,), big=1.5),
           dict(t0=1.3, t1=2.7, a=0.80, count=4, len=0.05, fangs=(2,), big=1.4, jaw=True)],
    rider=dict(t=7.4, scale=1.0),
    palette=dict(
        back=(0.08, 0.28, 0.18), mid=(0.14, 0.48, 0.30), flank=(0.22, 0.62, 0.40), belly=(0.78, 0.90, 0.72),
        accent=(0.22, 0.10, 0.32), horn=(0.88, 0.82, 0.95), horn_dark=(0.28, 0.16, 0.40),
        memb_dark=(0.18, 0.08, 0.30), memb_light=(0.42, 0.28, 0.62), memb_warm=(0.70, 0.88, 0.55),
        spike=(0.10, 0.26, 0.18), spike_tip=(0.72, 0.90, 0.60), eye=(0.95, 0.98, 0.70), pattern='dapple',
        saddle=(0.22, 0.26, 0.18), rider=(0.32, 0.22, 0.38),
    ),
)
