"""Aureate: prism disruptor — faceted plates, crescent horns, shard-tail, citrine/gold."""

PARAMS = dict(
    name='aureate',
    seed=83,
    girth=1.08, torso_len=2.55,
    hips=(0.44, 0.43, 0.42), mid=(0.52, 0.5, 0.54), chest=(0.64, 0.6, 0.7),
    tail_len=4.6, tail_droop=0.15, tail_rise=0.85, tail_taper=0.95, tail_w=0.88, tail_tip_r=0.02,
    neck_len=2.05, neck_elev=18, neck_arch=0.06, neck_r=0.28,
    head_len=1.7, head_w=0.78, head_h=0.7, head_pitch=26,
    head_shape=dict(skull_w=0.52, brow_w=0.6, snout_w=0.34, nose_w=0.26, tip_w=0.16, snout_t=0.26, nose_t=0.24,
                    tip_t=0.14, shelf=(0.16, 0.35, 0.12, 0.0, 0.0)),
    scale_freq=4.2,
    leg_scale=0.92,
    leg_h=dict(pts=[(0.36, -0.05, -0.95), (0.58, -0.48, -0.55), (0.56, -0.64, -1.4), (0.48, -0.48, -2.05)],
               r=[0.3, 0.2, 0.11, 0.13], claw=0.38),
    leg_f=dict(pts=[(0.42, -0.22, 0.95), (0.6, -0.66, 0.45), (0.54, -0.86, 1.0), (0.46, -0.76, 1.35)],
               r=[0.24, 0.16, 0.1, 0.12], claw=0.34),
    wing=dict(sx=0.38, su=0.46, sf=0.74, dihedral=14, tip_droop=0.03,
              hum=1.4, hum_ang=28, fore=2.0, fore_ang=32, arm_r=0.15,
              rays=[dict(ang=18, len=3.4, curve=8, bone=1, r=0.07),
                    dict(ang=42, len=3.55, curve=10, bone=(1, 2, 0.5), r=0.048),
                    dict(ang=68, len=3.35, curve=8, bone=2, r=0.055),
                    dict(ang=94, len=2.95, curve=6, bone=3, r=0.05)],
              bx=0.38, bu=0.05, bf=-1.4, scallop=0.08, scallop_in=0.1, billow=0.12, panel_div=1.4,
              thumb=0.7),
    # Crystal scutes: few large angular plates, not Bastion's armour rows.
    plates=[
        dict(t0=11.2, t1=9.8, count=2, a=1.0, dt=0.5, da=0.4, lift=0.12, min=0.9),
        dict(t0=9.4, t1=7.6, count=3, a=0.85, dt=0.42, da=0.28, lift=0.1, min=0.8),
        dict(t0=7.2, t1=5.0, count=3, a=1.0, dt=0.45, da=0.22, lift=0.09, min=0.7),
        dict(t0=12.9, t1=12.9, count=1, a=1.0, dt=0.55, da=0.4, lift=0.1, min=1.0),
    ],
    spike_rows=[],
    surf_spikes=[
        # Facet brows / cheek crystals.
        dict(t=13.2, a=0.78, len=0.85, w=0.22, h=0.18, lean=2.6, name='facet_brow'),
        dict(t=12.6, a=0.5, len=0.55, w=0.18, h=0.22, lean=1.8, name='facet_cheek'),
        dict(t=12.35, a=0.3, len=0.4, w=0.14, h=0.16, lean=1.5, small=True, name='facet_cheek2'),
        dict(t=15.2, a=1.0, len=0.28, w=0.12, h=0.1, lean=1.2, name='nose_prism'),
        dict(t=0.6, a=0.5, len=0.45, w=0.16, h=0.35, lean=0.4, name='tail_shard'),
        dict(t=0.35, a=1.0, len=0.38, w=0.14, h=0.28, lean=0.5, name='tail_shard'),
        dict(t=0.35, a=0.0, len=0.38, w=0.14, h=0.28, lean=0.5, name='tail_shard'),
    ],
    horns=[
        # Crescent horns sweeping forward-out, not Talon's rear sweep.
        dict(t=12.4, a=0.86, dir=(0.55, 0.35, 0.55), len=1.4, r=0.09, bend=-42, taper=0.7, segs=8, rings=5),
        dict(t=12.25, a=0.7, dir=(0.7, 0.1, 0.35), len=0.85, r=0.06, bend=-30, taper=0.75, segs=6),
    ],
    fan_fins=[
        # Shard vane at the tip: geometric blades.
        dict(t=0.55, a=0.5, tips=[(0.08, 0.05, 0.35), (0.65, 0.08, -0.15), (0.5, 0.02, -0.75), (0.15, 0.0, -1.1), (0.02, 0.0, -0.5)],
             scallop=0.05, inner=0.35, face=(0, 1, 0), fine=True, name='shard_vane'),
        dict(t=1.6, a=0.5, tips=[(0.05, 0.03, 0.15), (0.4, 0.04, -0.2), (0.28, 0.02, -0.55), (0.05, 0.0, -0.4)],
             scallop=0.05, inner=0.4, face=(0, 1, 0), small=True, name='shard_vane2'),
    ],
    eye=dict(t=13.55, a=0.62, rx=0.12, ry=0.065, tilt=18),
    teeth=[dict(t0=14.2, t1=15.85, a=0.2, count=8, len=0.09, fangs=(5, 6), big=2.0),
           dict(t0=1.2, t1=2.8, a=0.80, count=5, len=0.07, fangs=(3,), big=1.7, jaw=True)],
    rider=dict(t=7.55, scale=1.0),
    palette=dict(
        back=(0.42, 0.28, 0.06), mid=(0.72, 0.52, 0.12), flank=(0.90, 0.72, 0.28), belly=(0.96, 0.90, 0.68),
        accent=(0.28, 0.18, 0.06), horn=(0.95, 0.88, 0.55), horn_dark=(0.40, 0.28, 0.12),
        plate=(0.78, 0.62, 0.22), plate_edge=(0.98, 0.9, 0.55),
        memb_dark=(0.35, 0.26, 0.08), memb_light=(0.82, 0.68, 0.28), memb_warm=(0.96, 0.86, 0.50),
        spike=(0.55, 0.4, 0.12), spike_tip=(0.98, 0.92, 0.6), eye=(1.0, 0.95, 0.55), pattern='blotch',
        saddle=(0.30, 0.22, 0.12), rider=(0.45, 0.32, 0.16),
    ),
)
