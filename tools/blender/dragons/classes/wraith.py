"""Wraith: lean, tattered wing edges, smoky tail. Obsidian with an iridescent edge.
See dragonlib/dragon.py for the stations."""

PARAMS = dict(
    name='wraith',
    seed=53,
    girth=0.92, torso_len=2.5,
    hips=(0.40, 0.42, 0.38), mid=(0.46, 0.46, 0.46), chest=(0.60, 0.60, 0.72),
    tail_len=5.2, tail_droop=0.36, tail_rise=0.3, tail_taper=1.0, tail_w=0.85, tail_tip_r=0.025,
    neck_len=2.3, neck_elev=10, neck_arch=0.11, neck_r=0.235,
    head_len=1.6, head_w=0.68, head_h=0.58, head_pitch=20,
    head_shape=dict(skull_w=0.52, brow_w=0.56, snout_w=0.33, nose_w=0.26, tip_w=0.17, snout_t=0.27, nose_t=0.26,
                    tip_t=0.15, shelf=(0.14, 0.3, 0.1, 0.0, 0.0)),
    leg_scale=0.9,
    leg_h=dict(pts=[(0.36, -0.05, -0.9), (0.60, -0.52, -0.5), (0.58, -0.68, -1.4), (0.5, -0.5, -2.1)],
               r=[0.30, 0.20, 0.10, 0.125], claw=0.5, claw_bend=65),
    leg_f=dict(pts=[(0.42, -0.25, 0.9), (0.62, -0.72, 0.4), (0.56, -0.92, 0.95), (0.48, -0.8, 1.3)],
               r=[0.23, 0.155, 0.09, 0.115], claw=0.46, claw_bend=65),
    wing=dict(sx=0.33, su=0.42, sf=0.66, dihedral=5, tip_droop=0.1,
              hum=1.5, hum_ang=26, fore=2.05, fore_ang=32, arm_r=0.16,
              rays=[dict(ang=26, len=4.05, curve=20, bone=1, r=0.07),
                    dict(ang=58, len=3.6, curve=16, bone=2, r=0.058),
                    dict(ang=97, len=3.0, curve=10, bone=3, r=0.052)],
              bx=0.34, bu=0.06, bf=-1.35, scallop=0.26, scallop_in=0.24, billow=0.18, tatter=0.75,
              panel_div=1.0, thumb=0.75),
    spike_rows=[dict(t0=10.9, t1=3.0, count=14, h=0.34, len=0.34, w=0.09, lean=1.3, min=0.4, pw=0.6, alt=0.5)],
    surf_spikes=[
        dict(t=13.1, a=0.72, len=0.7, w=0.2, h=0.14, lean=2.4, name='brow'),
        dict(t=12.45, a=0.42, len=0.34, w=0.1, h=0.34, lean=1.6, name='cheek'),
        dict(t=12.2, a=0.27, len=0.3, w=0.09, h=0.28, lean=1.6, small=True, name='cheek2'),
        dict(t=1.3, a=0.0, len=0.3, w=0.07, h=0.2, lean=1.3, jaw=True, name='chin'),
        dict(t=2.2, a=0.0, len=0.22, w=0.06, h=0.14, lean=1.3, jaw=True, small=True, name='chin'),
    ],
    horns=[
        dict(t=12.35, a=0.84, dir=(0.16, 0.42, -1.0), len=1.5, r=0.085, bend=30, taper=0.85, segs=8),
        dict(t=12.2, a=0.66, dir=(0.5, 0.12, -1.0), len=1.05, r=0.065, bend=24, taper=0.85, segs=6),
        dict(t=12.1, a=0.5, dir=(0.62, -0.12, -1.0), len=0.6, r=0.05, bend=18, taper=0.85, segs=4, small=True),
    ],
    eye=dict(t=13.5, a=0.6, rx=0.13, ry=0.06, tilt=16),
    teeth=[dict(t0=14.15, t1=15.9, a=0.2, count=8, len=0.1, fangs=(5, 6), big=1.9),
           dict(t0=1.2, t1=2.9, a=0.80, count=6, len=0.085, fangs=(4,), big=1.7, jaw=True)],
    dorsal_fins=[
        dict(t0=2.9, t1=0.0, ribs=7, h=0.62, lean=1.5, scallop=0.45, skew=1.2, pw=0.6, tatter=0.5, seed=4, rect='fin'),
        dict(t0=2.5, t1=0.0, ribs=6, h=0.5, lean=1.5, scallop=0.45, skew=1.2, pw=0.6, tatter=0.5, seed=9, a=0.0,
             rect='fin'),
    ],
    fan_fins=[
        # smoky tail: ragged streamers trailing from the last third of the tail
        dict(t=0.35, a=0.5, tips=[(0.25, 0.3, -0.3), (0.5, 0.12, -1.0), (0.2, 0.0, -1.7), (0.34, -0.2, -0.9), (0.12, -0.3, -0.3)],
             scallop=0.5, tatter=0.35, inner=0.5, fine=True, seed=5, name='smoke1'),
        dict(t=1.3, a=0.5, tips=[(0.1, 0.1, -0.1), (0.34, 0.1, -0.8), (0.12, 0.0, -1.2), (0.2, -0.12, -0.5)],
             scallop=0.5, tatter=0.35, inner=0.5, fine=True, seed=6, small=True, name='smoke2'),
        # ragged elbow / hip wisps
        dict(origin=(0.42, 0.1, -1.35), wt=5.2, tips=[(0.15, 0.1, -0.3), (0.5, 0.05, -1.0), (0.3, -0.05, -0.5), (0.55, -0.1, -0.25)],
             scallop=0.5, tatter=0.3, inner=0.5, face=(0, 1, 0), seed=7, small=True, name='wisp'),
    ],
    rider=dict(t=7.6, scale=1.0),
    scale_freq=4.0,
    palette=dict(
        back=(0.065, 0.06, 0.10), mid=(0.115, 0.105, 0.17), flank=(0.18, 0.165, 0.26), belly=(0.33, 0.30, 0.42),
        accent=(0.03, 0.03, 0.05), horn=(0.62, 0.56, 0.72), horn_dark=(0.07, 0.06, 0.1),
        memb_dark=(0.05, 0.045, 0.085), memb_light=(0.19, 0.17, 0.28), memb_warm=(0.36, 0.28, 0.48),
        spike=(0.05, 0.05, 0.08), spike_tip=(0.5, 0.45, 0.66), eye=(0.95, 0.97, 1.0), pattern='smoke', iri=0.6,
        memb_iri=True, mouth=(0.30, 0.08, 0.26),
        # rider: night-violet leather, dusk-steel armour from the horn tones
        saddle=(0.16, 0.14, 0.18), rider=(0.22, 0.18, 0.28), rider_armor=(0.46, 0.42, 0.56),
    ),
)
