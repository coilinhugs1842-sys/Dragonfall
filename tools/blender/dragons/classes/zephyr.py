"""Zephyr: wind scout — kite wings, sail crest, whisker horns, pearl/aquamarine."""

PARAMS = dict(
    name='zephyr',
    seed=97,
    girth=0.78, torso_len=2.25,
    hips=(0.34, 0.36, 0.32), mid=(0.4, 0.4, 0.4), chest=(0.5, 0.5, 0.62),
    tail_len=6.2, tail_droop=0.4, tail_rise=0.2, tail_taper=1.05, tail_w=0.7, tail_tip_r=0.015,
    neck_len=2.7, neck_elev=8, neck_arch=0.14, neck_r=0.19,
    head_len=1.4, head_w=0.58, head_h=0.5, head_pitch=16,
    head_shape=dict(skull_w=0.48, brow_w=0.5, snout_w=0.28, nose_w=0.2, tip_w=0.12, snout_t=0.24, nose_t=0.22,
                    tip_t=0.12, shelf=(0.06, 0.15, 0.05, 0.0, 0.0)),
    scale_freq=3.8,
    leg_scale=0.82,
    leg_h=dict(pts=[(0.3, -0.04, -0.8), (0.52, -0.45, -0.42), (0.5, -0.6, -1.2), (0.42, -0.42, -1.85)],
               r=[0.24, 0.15, 0.08, 0.1], claw=0.5, claw_bend=55),
    leg_f=dict(pts=[(0.36, -0.2, 0.8), (0.54, -0.62, 0.32), (0.48, -0.82, 0.85), (0.4, -0.7, 1.15)],
               r=[0.18, 0.12, 0.07, 0.09], claw=0.46, claw_bend=55),
    # Oversized kite wings — longest span of the roster.
    wing=dict(sx=0.3, su=0.38, sf=0.6, dihedral=16, tip_droop=0.02,
              hum=1.7, hum_ang=32, fore=2.4, fore_ang=38, arm_r=0.12,
              rays=[dict(ang=20, len=4.8, curve=22, bone=1, r=0.055),
                    dict(ang=40, len=4.6, curve=18, bone=(1, 2, 0.5), r=0.04),
                    dict(ang=62, len=4.3, curve=14, bone=2, r=0.048),
                    dict(ang=86, len=3.8, curve=10, bone=(2, 3, 0.5), r=0.038),
                    dict(ang=108, len=3.3, curve=7, bone=3, r=0.042)],
              bx=0.3, bu=0.04, bf=-1.2, scallop=0.18, scallop_in=0.2, billow=0.1, panel_div=0.9,
              thumb=0.4),
    # Single continuous sail crest — not Wraith spikes or Tempest multi-fins.
    dorsal_fins=[
        dict(t0=12.8, t1=0.4, ribs=14, h=0.95, lean=0.35, scallop=0.15, skew=0.25, pw=0.45, rect='fin'),
    ],
    spike_rows=[],
    surf_spikes=[
        dict(t=13.0, a=0.65, len=0.3, w=0.1, h=0.08, lean=1.8, small=True, name='brow'),
    ],
    # Whiskers forward: long thin horns pointing ahead of the snout.
    horns=[
        dict(t=12.5, a=0.7, dir=(0.25, 0.15, 1.0), len=1.8, r=0.035, bend=8, taper=0.92, segs=9),
        dict(t=12.35, a=0.55, dir=(0.4, -0.05, 1.0), len=1.35, r=0.028, bend=6, taper=0.92, segs=7, small=True),
    ],
    fan_fins=[
        # Forked ribbon streamers — clean, not ragged smoke.
        dict(t=0.25, a=0.5, tips=[(0.08, 0.15, -0.2), (0.25, 0.2, -0.9), (0.12, 0.05, -1.8), (0.02, 0.0, -1.0)],
             scallop=0.12, inner=0.55, fine=True, seed=2, name='ribbon1'),
        dict(t=0.25, a=0.5, tips=[(0.08, -0.12, -0.15), (0.22, -0.18, -0.85), (0.1, -0.05, -1.7), (0.02, 0.0, -0.9)],
             scallop=0.12, inner=0.55, fine=True, seed=3, name='ribbon2'),
        dict(t=1.5, a=0.5, tips=[(0.06, 0.08, -0.1), (0.18, 0.1, -0.7), (0.08, 0.0, -1.2)],
             scallop=0.1, inner=0.5, fine=True, seed=4, small=True, name='ribbon3'),
        # Elbow sails.
        dict(origin=(0.35, 0.15, -1.2), wt=4.8, tips=[(0.2, 0.25, -0.4), (0.55, 0.1, -1.1), (0.35, -0.05, -0.6)],
             scallop=0.15, inner=0.5, face=(0, 1, 0), small=True, name='elbow_sail'),
    ],
    eye=dict(t=13.35, a=0.55, rx=0.11, ry=0.05, tilt=10),
    teeth=[dict(t0=14.1, t1=15.7, a=0.2, count=6, len=0.055, fangs=(4,), big=1.5),
           dict(t0=1.2, t1=2.6, a=0.80, count=4, len=0.045, fangs=(2,), big=1.4, jaw=True)],
    rider=dict(t=7.45, scale=0.9),
    palette=dict(
        back=(0.72, 0.78, 0.82), mid=(0.86, 0.90, 0.92), flank=(0.94, 0.96, 0.97), belly=(0.98, 0.99, 1.0),
        accent=(0.28, 0.52, 0.55), horn=(0.92, 0.96, 0.98), horn_dark=(0.35, 0.48, 0.52),
        memb_dark=(0.22, 0.48, 0.52), memb_light=(0.55, 0.82, 0.84), memb_warm=(0.85, 0.95, 0.96),
        spike=(0.55, 0.62, 0.66), spike_tip=(0.75, 0.92, 0.94), eye=(0.55, 0.95, 1.0), pattern='smoke', iri=0.35,
        memb_iri=True, mouth=(0.35, 0.55, 0.58),
        saddle=(0.35, 0.42, 0.45), rider=(0.45, 0.55, 0.58),
    ),
)
