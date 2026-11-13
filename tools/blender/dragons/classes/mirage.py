"""Mirage: phantom trickster — smooth eel body, forward crescents, ribbon frills (no tatters)."""

PARAMS = dict(
    name='mirage',
    seed=127,
    girth=0.86, torso_len=2.8,
    hips=(0.38, 0.4, 0.36), mid=(0.44, 0.44, 0.45), chest=(0.58, 0.56, 0.7),
    tail_len=5.8, tail_droop=0.28, tail_rise=0.45, tail_taper=1.05, tail_w=0.78, tail_tip_r=0.02,
    neck_len=2.85, neck_elev=12, neck_arch=0.13, neck_r=0.22,
    head_len=1.7, head_w=0.64, head_h=0.56, head_pitch=22,
    head_shape=dict(skull_w=0.5, brow_w=0.54, snout_w=0.3, nose_w=0.22, tip_w=0.14, snout_t=0.25, nose_t=0.23,
                    tip_t=0.13, shelf=(0.1, 0.25, 0.08, 0.0, 0.0)),
    scale_freq=5.0,
    leg_scale=0.88,
    leg_h=dict(pts=[(0.34, -0.05, -0.92), (0.56, -0.5, -0.5), (0.54, -0.66, -1.35), (0.46, -0.48, -2.0)],
               r=[0.28, 0.18, 0.09, 0.11], claw=0.48, claw_bend=70),
    leg_f=dict(pts=[(0.4, -0.24, 0.92), (0.58, -0.7, 0.4), (0.52, -0.9, 0.95), (0.44, -0.78, 1.28)],
               r=[0.21, 0.14, 0.085, 0.1], claw=0.44, claw_bend=70),
    # Smooth membrane — no Wraith tatter; soft scallop only.
    wing=dict(sx=0.34, su=0.44, sf=0.7, dihedral=8, tip_droop=0.05,
              hum=1.55, hum_ang=24, fore=2.2, fore_ang=30, arm_r=0.14,
              rays=[dict(ang=24, len=4.15, curve=16, bone=1, r=0.06),
                    dict(ang=50, len=4.0, curve=14, bone=(1, 2, 0.5), r=0.045),
                    dict(ang=78, len=3.6, curve=11, bone=2, r=0.052),
                    dict(ang=105, len=3.1, curve=8, bone=3, r=0.048)],
              bx=0.35, bu=0.05, bf=-1.4, scallop=0.22, scallop_in=0.2, billow=0.14, panel_div=0.7,
              thumb=0.55),
    spike_rows=[],
    surf_spikes=[
        dict(t=13.15, a=0.7, len=0.4, w=0.12, h=0.1, lean=2.0, name='brow'),
        dict(t=1.2, a=0.0, len=0.2, w=0.06, h=0.12, lean=1.2, jaw=True, small=True, name='chin'),
    ],
    # Forward-curving crescents — afterimage horns, opposite of Wraith's rear sweep.
    horns=[
        dict(t=12.4, a=0.86, dir=(0.2, 0.45, 0.85), len=1.55, r=0.07, bend=-38, taper=0.88, segs=8),
        dict(t=12.25, a=0.68, dir=(0.45, 0.25, 0.8), len=1.1, r=0.05, bend=-28, taper=0.88, segs=6),
    ],
    # Soft phantom ribbons from cheeks / hips / tail — clean edges, not ragged smoke.
    fan_fins=[
        dict(t=12.2, a=0.55, tips=[(0.1, 0.55, -0.3), (0.45, 0.5, -0.75), (0.55, 0.1, -0.9), (0.3, -0.25, -0.45)],
             scallop=0.2, inner=0.5, fine=True, base_dir=(0, 1, 0.4), base_len=0.28, name='veil_cheek'),
        dict(origin=(0.4, 0.15, -1.3), wt=5.4, tips=[(0.15, 0.2, -0.35), (0.45, 0.15, -1.0), (0.25, -0.05, -0.7), (0.5, 0.0, -0.4)],
             scallop=0.18, inner=0.5, face=(0, 1, 0), fine=True, seed=8, name='veil_hip'),
        dict(t=0.5, a=0.5, tips=[(0.12, 0.2, -0.2), (0.35, 0.15, -0.85), (0.15, 0.05, -1.5), (0.28, -0.1, -0.9), (0.08, -0.15, -0.35)],
             scallop=0.2, inner=0.5, fine=True, seed=9, name='veil_tail'),
        dict(t=1.8, a=0.5, tips=[(0.08, 0.1, -0.1), (0.28, 0.08, -0.65), (0.12, 0.0, -1.05)],
             scallop=0.18, inner=0.5, fine=True, seed=10, small=True, name='veil_tail2'),
    ],
    dorsal_fins=[
        # Thin phantom crest, low and continuous — not Wraith's ragged dorsal.
        dict(t0=11.5, t1=3.5, ribs=10, h=0.38, lean=0.6, scallop=0.2, skew=0.5, pw=0.5, rect='fin'),
    ],
    eye=dict(t=13.5, a=0.58, rx=0.125, ry=0.055, tilt=14),
    teeth=[dict(t0=14.15, t1=15.9, a=0.2, count=7, len=0.08, fangs=(5,), big=1.8),
           dict(t0=1.2, t1=2.8, a=0.80, count=5, len=0.065, fangs=(3,), big=1.6, jaw=True)],
    rider=dict(t=7.55, scale=0.98),
    palette=dict(
        back=(0.22, 0.14, 0.20), mid=(0.42, 0.28, 0.38), flank=(0.62, 0.42, 0.55), belly=(0.92, 0.86, 0.90),
        accent=(0.55, 0.22, 0.40), horn=(0.95, 0.82, 0.90), horn_dark=(0.35, 0.16, 0.28),
        memb_dark=(0.45, 0.18, 0.35), memb_light=(0.85, 0.55, 0.72), memb_warm=(0.98, 0.78, 0.88),
        spike=(0.28, 0.16, 0.24), spike_tip=(0.95, 0.75, 0.88), eye=(1.0, 0.85, 0.95), pattern='smoke', iri=0.75,
        memb_iri=True, mouth=(0.45, 0.12, 0.30),
        saddle=(0.28, 0.18, 0.24), rider=(0.40, 0.22, 0.34), rider_armor=(0.78, 0.58, 0.72),
    ),
)
