"""Parametric dragon builder: params (classes/<name>.py) -> skeleton + LOD meshes. Pure numpy.

Body station indices (the `t` used everywhere in the class files):
  0..4 tail (0 = tip, 4 = near hips), 5 hips, 6 mid (origin), 7 chest, 8 neck base,
  9 neck 1, 10 neck 2, 11 head base, 12 skull, 13 brow, 14 snout base, 15 nostril, 16 snout tip.
Around angle `a` is in units of pi: 0 = belly line, 0.5 = flank, 1 = dorsal line.
"""
import numpy as np
from .geom import (PI, LEFT, UP, P, norm, smoothstep, lerp, cr, rot_axis, rect_uv, sub_rect, Part,
                   clean_tris, orient, grid_tris, tube, curve_path, Mesh, MAT_HIDE, MAT_MEMBRANE,
                   MAT_RUNES, NPA, PA_ALONG, PA_AROUND, PA_Q, PA_THETA, PA_EXT, PA_AUX)

BONES = ['root', 'hips', 'chest', 'neck1', 'neck2', 'neck3', 'head', 'jaw',
         'tail1', 'tail2', 'tail3', 'tail4']
WING_BONES = ['wing_shoulder', 'wing_elbow', 'wing_wrist', 'wing_finger1', 'wing_finger2',
              'wing_finger3']
BONES += [b + '_L' for b in WING_BONES] + [b + '_R' for b in WING_BONES]
BI = {b: i for i, b in enumerate(BONES)}
NB = len(BONES)
SWAP = np.array([BI[b[:-2] + ('_R' if b.endswith('_L') else '_L')] if b[-2:] in ('_L', '_R')
                 else i for i, b in enumerate(BONES)])
PARENT = {'root': None, 'hips': 'root', 'chest': 'root', 'neck1': 'chest', 'neck2': 'neck1',
          'neck3': 'neck2', 'head': 'neck3', 'jaw': 'head', 'tail1': 'hips', 'tail2': 'tail1',
          'tail3': 'tail2', 'tail4': 'tail3'}
for _s in ('_L', '_R'):
    PARENT['wing_shoulder' + _s] = 'chest'
    PARENT['wing_elbow' + _s] = 'wing_shoulder' + _s
    PARENT['wing_wrist' + _s] = 'wing_elbow' + _s
    for _k in (1, 2, 3):
        PARENT['wing_finger%d%s' % (_k, _s)] = 'wing_wrist' + _s

T_TIP, T_HIPS, T_MID, T_CHEST, T_NECK0, T_N1, T_N2, T_HEAD0, T_H1, T_H2, T_H3, T_H4, T_H5 = \
    0, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16

LODS = {
    0: dict(K=20, seg=1.3, limb=10, arm=6, horn=6, memb=(9, 8), spike_step=1, teeth=True, claws=True,
            plates=True, small=True, rider=2, fin_sub=4),
    1: dict(K=12, seg=0.6, limb=6, arm=4, horn=4, memb=(5, 4), spike_step=1, teeth=False,
            claws=True, plates=True, small=False, rider=1, fin_sub=2),
    2: dict(K=6, seg=0.3, limb=4, arm=3, horn=3, memb=(2, 2), spike_step=2, teeth=False,
            claws=False, plates=False, small=False, rider=0, fin_sub=1),
}


def wv(**kw):
    w = np.zeros(NB)
    for k, v in kw.items():
        w[BI[k]] = v
    return w


class Stations:
    """A lofted, bilaterally symmetric body: rows of (fwd, up, rx, rt, rb, sq, ridge)."""

    def __init__(self, rows):
        self.A = np.array(rows, float)
        if self.A.shape[1] == 7:  # optional 8th column: brow shelf (upper half overhangs)
            self.A = np.concatenate([self.A, np.zeros((len(rows), 1))], axis=1)
        self.n = len(rows)

    def vals(self, t):
        v = cr(self.A, np.asarray(t, float))
        v[..., 2:5] = np.maximum(v[..., 2:5], 0.004)
        v[..., 5] = np.maximum(v[..., 5], 1.6)
        return v

    def center(self, t):
        v = cr(self.A[:, :2], np.asarray(t, float))
        return np.stack([np.zeros_like(v[..., 0]), -v[..., 0], v[..., 1]], axis=-1)

    def frame(self, t):
        t = np.asarray(t, float)
        d = self.center(np.minimum(t + 1e-3, self.n - 1)) - self.center(np.maximum(t - 1e-3, 0))
        T = norm(d)
        N = np.stack([np.zeros_like(T[..., 0]), T[..., 2], -T[..., 1]], axis=-1)
        return T, N

    def local(self, t, a):
        """Profile offsets (lx, ly) at angle a (radians, 0 = belly, pi = back, through +X)."""
        v = self.vals(t)
        rx, rt, rb, sq, ridge = v[..., 2], v[..., 3], v[..., 4], v[..., 5], v[..., 6]
        s, c = np.sin(a), -np.cos(a)
        e = 2.0 / sq
        lx = rx * np.sign(s) * np.abs(s) ** e
        shelf = v[..., 7]
        lx = lx * (1 + shelf * smoothstep(0.1, 0.5, c) - 0.6 * shelf * smoothstep(0.05, -0.55, c))
        ly = np.where(c >= 0, rt, rb) * np.sign(c) * np.abs(c) ** e
        ly = ly + ridge * np.maximum(c, 0) ** 12
        return lx, ly

    def surface(self, t, a, lift=0.0):
        """Point on the skin at (t, a in units of pi); `lift` moves it along the normal."""
        t = np.asarray(t, float)
        a = np.asarray(a, float) * PI
        C = self.center(t)
        _, N = self.frame(t)
        lx, ly = self.local(t, a)
        p = C + lx[..., None] * LEFT + ly[..., None] * N
        if np.any(np.asarray(lift) != 0):
            p = p + self.normal(t, a / PI) * np.asarray(lift)[..., None]
        return p

    def normal(self, t, a):
        t = np.asarray(t, float)
        a = np.asarray(a, float)
        dt, da = 0.02, 0.01
        pt = self.surface(np.minimum(t + dt, self.n - 1), a) - self.surface(np.maximum(t - dt, 0), a)
        pa = self.surface(t, a + da) - self.surface(t, a - da)
        n = norm(np.cross(pa, pt))
        # make it point away from the centre line
        out = self.surface(t, a) - self.center(t)
        sgn = np.sign((n * out).sum(axis=-1, keepdims=True))
        sgn[sgn == 0] = 1
        return n * sgn


def body_stations(p):
    g = p['girth']
    h = p['torso_len'] / 2
    tl = p['tail_len']
    rows = []
    tw = p.get('tail_w', 1.0)
    tr_tip = p.get('tail_tip_r', 0.035)
    club = p.get('tail_club', 0.0)
    for tt in (1.0, 0.8, 0.58, 0.36, 0.16):
        up = -p['tail_droop'] * np.sin(PI * min(tt * 0.95, 1)) + p['tail_rise'] * tt ** 2.2
        r = 0.43 * g * tw * (1 - tt) ** p.get('tail_taper', 0.85) + tr_tip
        if club:
            r += club * np.exp(-((tt - 0.9) / 0.11) ** 2)
        rows.append((-h - tl * tt, up, r * 0.95, r * 1.0, r * 0.92, 2.2, p.get('tail_ridge', 0.02) * (1 - tt)))
    hp = p.get('hips', (0.46, 0.45, 0.42))
    md = p.get('mid', (0.56, 0.50, 0.55))
    ch = p.get('chest', (0.64, 0.58, 0.68))
    rows.append((-h, 0.0, hp[0] * g, hp[1] * g, hp[2] * g, 2.2, 0.03))
    rows.append((0.0, -0.02, md[0] * g, md[1] * g, md[2] * g, 2.25, 0.035))
    rows.append((0.56 * h, 0.03, ch[0] * g, ch[1] * g, ch[2] * g, 2.3, 0.04))
    nr = p['neck_r']
    rows.append((h, 0.14, nr * 1.5, nr * 1.5, nr * 1.75, 2.2, 0.03))
    nl, ne = p['neck_len'], np.radians(p['neck_elev'])
    arch = p.get('neck_arch', 0.1)
    n0 = np.array([h, 0.14])
    nd = np.array([np.cos(ne), np.sin(ne)])
    npp = np.array([-nd[1], nd[0]])
    q1 = n0 + nd * nl * 0.36 + npp * nl * arch
    q2 = n0 + nd * nl * 0.70 + npp * nl * arch * 1.15
    q3 = n0 + nd * nl + npp * nl * arch * 0.5
    rows.append((q1[0], q1[1], nr * 1.12, nr * 1.15, nr * 1.3, 2.15, 0.03))
    rows.append((q2[0], q2[1], nr * 0.98, nr * 1.0, nr * 1.12, 2.1, 0.03))
    rows.append((q3[0], q3[1], nr * 0.95, nr * 0.98, nr * 1.08, 2.1, 0.02))
    hl, hw, hh = p['head_len'], p['head_w'], p['head_h']
    he = ne - np.radians(p['head_pitch'])
    hd = np.array([np.cos(he), np.sin(he)])
    hp_ = np.array([-hd[1], hd[0]])
    em = -0.12 * hh  # mouth line, relative to the head axis
    hs = p.get('head_shape', {})
    sh = hs.get('shelf', (0.10, 0.24, 0.10, 0.0, 0.0))
    spec = [
        (0.17, 0.02 * hh, hs.get('skull_w', 0.50), hs.get('skull_t', 0.44), hs.get('skull_b', 0.50), 2.4, sh[0]),
        (0.37, 0.04 * hh, hs.get('brow_w', 0.52), hs.get('brow_t', 0.54), hs.get('brow_b', 0.38), 2.9, sh[1]),
        (0.57, None, hs.get('snout_w', 0.40), hs.get('snout_t', 0.30), 0.09, 3.0, sh[2]),
        (0.83, None, hs.get('nose_w', 0.33), hs.get('nose_t', 0.31), 0.07, 3.0, sh[3]),
        (1.00, None, hs.get('tip_w', 0.22), hs.get('tip_t', 0.19), 0.05, 2.6, sh[4]),
    ]
    for d, e, wx, wt, wb, sq, shf in spec:
        if e is None:
            e = em + wb * hh
        c = q3 + hd * hl * d + hp_ * e
        rows.append((c[0], c[1], wx * hw, wt * hh, wb * hh, sq, 0.0, shf))
    rows = [tuple(r) + (0.0,) * (8 - len(r)) for r in rows]
    st = Stations(rows)
    # jaw: hinge under the brow, tip under the snout tip
    jrows = []
    js = p.get('jaw_shape', {})
    for d, wx, wb in ((0.33, 0.43, 0.19), (0.55, 0.37, js.get('mid_d', 0.17)),
                      (0.80, 0.29, js.get('fwd_d', 0.14)), (0.97, 0.19, js.get('tip_d', 0.09))):
        c = q3 + hd * hl * d + hp_ * (em - 0.035 * hh)
        jrows.append((c[0], c[1], wx * hw, 0.035 * hh, wb * hh, 2.7, 0.0))
    info = dict(head_origin=q3, head_dir=hd, head_perp=hp_, mouth=em)
    return st, Stations(jrows), info


class Builder:
    def __init__(self, p, lod):
        self.p = p
        self.lod = lod
        self.L = LODS[lod]
        self.st, self.jaw, self.info = body_stations(p)
        self.parts = []
        self._arc()

    # --- helpers ---------------------------------------------------------------------------
    def _arc(self):
        tt = np.linspace(0, self.st.n - 1, 400)
        c = self.st.center(tt)
        s = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(c, axis=0), axis=1))])
        v = self.st.vals(tt)
        rbar = np.maximum((v[:, 2] + (v[:, 3] + v[:, 4]) / 2) / 2, 0.09)
        q = np.concatenate([[0], np.cumsum(np.diff(s) / ((rbar[1:] + rbar[:-1]) / 2))])
        self._tt, self._s, self._q = tt, s, q

    def arc(self, t):
        return np.interp(t, self._tt, self._s)

    def qq(self, t):
        return np.interp(t, self._tt, self._q)

    def w_spine(self, t):
        """Skin weights for a point at body station t (scalar)."""
        chain = ['tail4', 'tail3', 'tail2', 'tail1', 'hips', 'chest', 'neck1', 'neck2', 'neck3',
                 'head']
        joints = [T_HIPS * 0.25, T_HIPS * 0.5, T_HIPS * 0.75, T_HIPS, T_MID, T_NECK0, T_N1, T_N2,
                  T_HEAD0]
        hw = [0.55, 0.55, 0.55, 0.5, 0.6, 0.5, 0.45, 0.45, 0.4]
        w = np.zeros(NB)
        rem = 1.0
        for i in range(len(joints) - 1, -1, -1):
            f = float(smoothstep(joints[i] - hw[i], joints[i] + hw[i], t))
            w[BI[chain[i + 1]]] = rem * f
            rem *= (1 - f)
        w[BI[chain[0]]] = rem
        return w

    def t_at_f(self, f):
        """Body station of a forward coordinate (torso/neck range)."""
        tt = np.linspace(T_HIPS - 1, T_HEAD0, 200)
        ff = -self.st.center(tt)[:, 1]
        return float(np.interp(f, ff, tt))

    def add(self, part, mirror=False):
        self.parts.append(part)
        if mirror:
            self.parts.append(part.mirrored(SWAP))

    # --- lofted bodies -------------------------------------------------------------------------
    def loft(self, st, ts, K, rect, kind, weight_fn, lu_weight=None, cap0=True, cap1=True,
             rune_fn=None, crease=62.0, q_fn=None, along_fn=None, ext_fn=None, name=''):
        ts = np.asarray(ts, float)
        R = len(ts)
        a = np.arange(K) * 2 * PI / K
        C = st.center(ts)
        T, N = st.frame(ts)
        lx, ly = st.local(ts[:, None], a[None, :])
        verts = (C[:, None, :] + lx[..., None] * LEFT + ly[..., None] * N[:, None, :]).reshape(-1, 3)
        around = np.where(a <= PI, a / PI, 2 - a / PI)
        seg = np.linalg.norm(np.diff(C, axis=0), axis=1)
        if lu_weight is not None:
            seg_w = seg * (lu_weight(ts[1:]) + lu_weight(ts[:-1])) / 2
        else:
            seg_w = seg
        lu = np.concatenate([[0], np.cumsum(seg_w)])
        lu = lu / lu[-1]
        s_loc = np.concatenate([[0], np.cumsum(seg)])
        LU, LV = np.meshgrid(lu, around, indexing='ij')
        pa = np.zeros((R, K, NPA))
        pa[..., PA_ALONG] = (along_fn(ts) if along_fn else s_loc / s_loc[-1])[:, None]
        pa[..., PA_AROUND] = around[None, :]
        if q_fn is not None:
            qv = q_fn(ts)
        else:
            v = st.vals(ts)
            rbar = np.maximum((v[:, 2] + (v[:, 3] + v[:, 4]) / 2) / 2, 0.05)
            qv = np.concatenate([[0], np.cumsum(seg / ((rbar[1:] + rbar[:-1]) / 2))])
        pa[..., PA_Q] = qv[:, None]
        pa[..., PA_THETA] = (around * PI)[None, :]
        pa[..., PA_EXT] = (ext_fn(ts) if ext_fn else np.zeros(R))[:, None]
        pa[..., PA_AUX] = ts[:, None]
        W = np.repeat(np.array([weight_fn(t) for t in ts]), K, axis=0)
        tris = grid_tris(R, K, wrap=True)
        verts_l = [verts]
        uv_l = [rect_uv(rect, LU, LV).reshape(-1, 2)]
        pa_l = [pa.reshape(-1, NPA)]
        W_l = [W]
        nv = R * K
        extra = []
        for end, on in ((0, cap0), (R - 1, cap1)):
            if not on:
                continue
            sign = -1 if end == 0 else 1
            v = st.vals(ts[end])
            tipc = C[end] + T[end] * sign * 0.35 * min(v[2], v[3] + v[4])
            # one cap vertex per ring column so UVs stay sane
            verts_l.append(np.tile(tipc, (K, 1)))
            uvt = rect_uv(rect, np.full(K, lu[end]), around)
            uv_l.append(uvt)
            pc = pa[end].copy()
            pa_l.append(pc)
            W_l.append(np.tile(weight_fn(ts[end]), (K, 1)))
            for k in range(K):
                extra.append((end * K + k, end * K + (k + 1) % K, nv + k))
            nv += K
        verts = np.concatenate(verts_l)
        tris = np.concatenate([tris, np.array(extra, int).reshape(-1, 3)])
        tris = clean_tris(verts, tris)
        # orient each triangle away from the centre line
        tc = verts[tris].mean(axis=1)
        ridx = np.clip(tris[:, 0] // K, 0, R - 1)
        ctr = np.where((tris[:, 2] >= R * K)[:, None], C.mean(axis=0)[None, :], C[ridx])
        fn = np.cross(verts[tris[:, 1]] - verts[tris[:, 0]], verts[tris[:, 2]] - verts[tris[:, 0]])
        bad = ((tc - ctr) * fn).sum(axis=1) < 0
        tris[bad] = tris[bad][:, ::-1]
        pa_all = np.concatenate(pa_l)
        fmat = np.zeros(len(tris), int)
        if rune_fn is not None:
            tm = pa_all[tris][:, :, PA_AUX]
            am = pa_all[tris][:, :, PA_AROUND]
            fmat[rune_fn(tm.min(axis=1), tm.max(axis=1), am.min(axis=1), am.max(axis=1))] = MAT_RUNES
        part = Part(kind, verts, tris, np.concatenate(uv_l), np.concatenate(W_l), pa=pa_all,
                    crease=crease, fmat=fmat, name=name or kind)
        vv = st.vals(ts)
        part.spheres = np.concatenate([C, ((vv[:, 2] + (vv[:, 3] + vv[:, 4]) / 2) / 2)[:, None] * 0.92], axis=1)
        if kind in ('body', 'jaw'):
            part.group = 'body'
        return part

    def ring_ts(self, t0, t1, per_gap):
        """Ring params from t0 to t1 with per-gap segment counts (dict or number), LOD scaled."""
        ts = [t0]
        i = int(np.floor(t0 + 1e-9))
        while ts[-1] < t1 - 1e-9:
            nxt = min(i + 1, t1)
            n = per_gap[i] if isinstance(per_gap, (list, tuple)) else per_gap
            n = max(1, int(round(n * self.L['seg'])))
            a = ts[-1]
            ts += list(a + (nxt - a) * (np.arange(1, n + 1) / n))
            i += 1
        return np.array(ts)

    def build_body(self):
        p, K = self.p, self.L['K']
        gaps = p.get('ring_gaps', [3, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2])
        total_s = self._s[-1]
        bands = p.get('rune_bands', [(T_HIPS + 0.3, T_CHEST + 0.2), (T_NECK0 + 0.3, T_HEAD0 - 0.1)])
        ra = p.get('rune_a', 0.565)

        def rune_fn(t0, t1, a0, a1):
            m = np.zeros(len(t0), bool)
            for b0, b1 in bands:
                m |= (t1 > b0) & (t0 < b1) & (a0 <= ra) & (a1 >= ra) & (a1 - a0 < 0.5)
            return m

        def ext_fn(ts):
            e_tail = smoothstep(2.6, 0.0, ts) * 0.9
            e_snout = smoothstep(T_H3 - 0.3, T_H5, ts) * 0.5
            return np.maximum(e_tail, e_snout)

        def along(ts):
            return self.arc(ts) / total_s
        common = dict(weight_fn=self.w_spine, q_fn=self.qq, along_fn=along, ext_fn=ext_fn)
        ts_tail = self.ring_ts(0.0, T_HIPS, gaps)
        self.add(self.loft(self.st, ts_tail, K, 'tail', 'body', cap0=True, cap1=False, name='tail',
                           rune_fn=rune_fn, **common))
        ts_body = self.ring_ts(T_HIPS, T_H5, gaps)
        self.add(self.loft(self.st, ts_body, K, 'body', 'body', cap0=False, cap1=True,
                           lu_weight=lambda t: 1.0 + 0.8 * smoothstep(T_HEAD0 - 0.5, T_H1, t),
                           rune_fn=rune_fn, name='body', **common))
        # jaw
        jt = self.ring_ts(0.0, 3.0, [3, 3, 2])
        wj = wv(jaw=1)
        self.add(self.loft(self.jaw, jt, max(6, K - 4) if self.lod < 2 else 6, 'jaw', 'jaw',
                           weight_fn=lambda t: wj, name='jaw',
                           ext_fn=lambda ts: smoothstep(1.0, 3.0, ts) * 0.4))

    # --- surface decorations -----------------------------------------------------------------
    def surf_spike(self, t, a, length, width, height, lean=0.3, side=0.0, kind='spike', rect='spike',
                   st=None, weights=None, mirror=None, sink=0.03, name='spike', lv=(0, 1), lu=(0, 1),
                   crease=35.0):
        """A four-sided blade standing on the skin at (t, a). length is along the body (metres)."""
        st = st or self.st
        c = st.surface(t, a)
        n = st.normal(t, a)
        T, _ = st.frame(t)
        T = norm(T - n * (T @ n))
        S = np.cross(n, T)
        base = c - n * sink
        front = base + T * length * 0.5
        back = base - T * length * 0.5
        l, r = base + S * width * 0.5, base - S * width * 0.5
        apex = base + n * height - T * lean * height + S * side * height
        verts = np.array([front, l, back, r, apex, apex, apex, apex])
        tris = np.array([(0, 1, 4), (1, 2, 5), (2, 3, 6), (3, 0, 7)])
        tris = orient(verts, tris, centers=base + n * height * 0.3)
        u0 = np.array([0.0, 0.5, 1.0, 0.5, 0.5 + lean * 0.4, 0.5 + lean * 0.4, 0.5 + lean * 0.4,
                       0.5 + lean * 0.4])
        v0 = np.array([1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0])
        uv = rect_uv(rect, lu[0] + (lu[1] - lu[0]) * np.clip(u0, 0, 1), lv[0] + (lv[1] - lv[0]) * v0)
        pa = np.zeros((8, NPA))
        pa[:, PA_ALONG] = 1 - v0
        pa[:, PA_AROUND] = u0
        pa[:, PA_EXT] = 1 - v0
        w = self.w_spine(t) if weights is None else weights
        part = Part(kind, verts, tris, uv, w, pa=pa, crease=crease, name=name)
        if mirror is None:
            mirror = 0.02 < a < 0.98
        self.add(part, mirror=mirror)

    def build_spikes(self):
        step = self.L['spike_step']
        for row in self.p.get('spike_rows', []):
            n = row['count']
            a = row.get('a', 1.0)
            for i in range(0, n, step):
                f = i / max(n - 1, 1)
                t = lerp(row['t0'], row['t1'], f)
                prof = np.sin(PI * np.clip(f * row.get('skew', 1.0), 0, 1) ** row.get('pw', 0.8)) \
                    if row.get('bell', True) else 1.0
                k = row.get('min', 0.35) + (1 - row.get('min', 0.35)) * prof
                if row.get('alt'):
                    k *= 1.0 if i % 2 == 0 else row['alt']
                if step > 1:
                    k *= 1.25
                self.surf_spike(t, a, row['len'] * k * (1.6 if step > 1 else 1), row.get('w', 0.12) * k,
                                row['h'] * k, lean=row.get('lean', 0.6), side=row.get('side', 0.0))

    def build_plates(self):
        if not self.L['plates']:
            return
        st = self.st
        for pl in self.p.get('plates', []):
            n = pl['count']
            for i in range(n):
                f = i / max(n - 1, 1)
                t = lerp(pl['t0'], pl['t1'], f)
                a = pl['a']
                k = pl.get('min', 0.6) + (1 - pl.get('min', 0.6)) * np.sin(PI * f) ** 0.7
                dt, da = pl['dt'] * k, pl['da'] * k
                lift = pl.get('lift', 0.07) * k
                # hexagon-ish scute pointing backward; front edge tucked, back edge raised
                shape = [(0.55, 0.0, 0.15), (0.25, 0.9, 0.5), (-0.45, 1.0, 0.9), (-1.0, 0.0, 1.15),
                         (-0.45, -1.0, 0.9), (0.25, -0.9, 0.5)]
                if a > 0.97:
                    aa = [1.0 - abs(s[1]) * da for s in shape]
                    sgn = [1 if s[1] >= 0 else -1 for s in shape]
                else:
                    aa = [a + s[1] * da for s in shape]
                    sgn = [1] * 6
                rim, skirt = [], []
                for s_, a_, sg in zip(shape, aa, sgn):
                    pt = st.surface(t + s_[0] * dt, a_, lift=lift * s_[2])
                    sk = st.surface(t + s_[0] * dt * 0.97, a_, lift=-0.03)
                    if sg < 0:
                        pt, sk = pt * [-1, 1, 1], sk * [-1, 1, 1]
                    rim.append(pt)
                    skirt.append(sk)
                ctr = st.surface(t - 0.2 * dt, a, lift=lift * 1.9)
                if a > 0.97:
                    ctr = ctr * [0, 1, 1]
                verts = np.array([ctr] + rim + rim + skirt)
                tris = []
                for j in range(6):
                    j2 = (j + 1) % 6
                    tris.append((0, 1 + j, 1 + j2))
                    tris.append((7 + j, 13 + j, 13 + j2))
                    tris.append((7 + j, 13 + j2, 7 + j2))
                if self.lod >= 1:
                    tris = tris[::3]
                tris = orient(verts, np.array(tris), centers=st.center(t))
                lu = np.array([0.5 - 0.2 * 0.25] + [0.5 - s[0] * 0.42 for s in shape] * 3)
                lvv = np.array([0.5] + [0.5 + s[1] * 0.42 for s in shape] * 2
                               + [0.5 + s[1] * 0.49 for s in shape])
                lu[13:] = np.array([0.5 - s[0] * 0.49 for s in shape])
                pa = np.zeros((19, NPA))
                pa[0, PA_ALONG] = 1.0
                pa[1:7, PA_ALONG] = 0.35
                pa[7:13, PA_ALONG] = 0.3
                pa[:, PA_AUX] = t
                part = Part('plate', verts, tris, rect_uv('plate', lu, lvv), self.w_spine(t), pa=pa,
                            crease=40.0, name='plate')
                self.add(part, mirror=(a <= 0.97))

    def build_surf_spikes(self):
        for s in self.p.get('surf_spikes', []):
            if s.get('small') and not self.L['small']:
                continue
            st = self.jaw if s.get('jaw') else self.st
            w = wv(jaw=1) if s.get('jaw') else None
            self.surf_spike(s['t'], s['a'], s['len'], s['w'], s['h'], lean=s.get('lean', 0.5),
                            side=s.get('side', 0.0), st=st, weights=w, kind=s.get('kind', 'spike'),
                            rect=s.get('rect', 'spike'), name=s.get('name', 'sspike'))

    def build_horns(self):
        sides = self.L['horn']
        for hdef in self.p.get('horns', []):
            if hdef.get('small') and not self.L['small']:
                continue
            st = self.jaw if hdef.get('jaw') else self.st
            base = st.surface(hdef['t'], hdef['a'])
            n = st.normal(hdef['t'], hdef['a'])
            d = norm(P(*hdef['dir']))
            base = base - n * hdef['r'] * 0.6
            bend_axis = P(*hdef['bend_axis']) if 'bend_axis' in hdef else np.cross(d, UP)
            nseg = max(3, int(round(hdef.get('segs', 6) * (1.0 if self.lod == 0 else 0.6))))
            path = curve_path(base, d, hdef['len'], nseg, bend_axis, np.radians(hdef.get('bend', 0)),
                              hdef.get('bend_pow', 1.0))
            f = np.linspace(0, 1, nseg)
            radii = hdef['r'] * (1 - f) ** hdef.get('taper', 0.8) + 0.004
            if hdef.get('rings') and self.lod == 0:
                radii = radii * (1 + 0.1 * np.cos(f * PI * hdef['rings'] * 2))
            w = wv(jaw=1) if hdef.get('jaw') else self.w_spine(hdef['t'])
            part = tube(path, radii, sides, up_hint=n, tip_end=True, rect='horn', kind='horn',
                        weights=w, crease=50.0, squash=hdef.get('squash', 1.0), name='horn')
            self.add(part, mirror=hdef.get('mirror', True))

    def build_eyes_teeth(self):
        p = self.p
        st = self.st
        e = p['eye']
        t, a = e['t'], e['a']
        c = st.surface(t, a)
        n = st.normal(t, a)
        T, _ = st.frame(t)
        T = norm(T - n * (T @ n))
        S = np.cross(n, T)
        tilt = np.radians(e.get('tilt', 18))
        A1 = T * np.cos(tilt) + S * np.sin(tilt)
        A2 = -T * np.sin(tilt) + S * np.cos(tilt)
        m = 8 if self.lod == 0 else 6 if self.lod == 1 else 4
        ang = np.arange(m) * 2 * PI / m
        ring = c[None] - n * 0.012 + np.cos(ang)[:, None] * A1 * e['rx'] + np.sin(ang)[:, None] * A2 * e['ry']
        ctr = c + n * e.get('bulge', 0.035)
        verts = np.concatenate([[ctr], ring])
        tris = orient(verts, np.array([(0, 1 + k, 1 + (k + 1) % m) for k in range(m)]), direction=n)
        lu = np.concatenate([[0.5], 0.5 + 0.47 * np.cos(ang)])
        lv = np.concatenate([[0.5], 0.5 - 0.47 * np.sin(ang)])
        pa = np.zeros((m + 1, NPA))
        self.add(Part('eye', verts, tris, rect_uv('eye', lu, lv), wv(head=1), mat=MAT_RUNES, pa=pa,
                      crease=180, name='eye'), mirror=True)
        if not self.L['teeth']:
            return
        hw = wv(head=1)
        jw = wv(jaw=1)
        for row in p.get('teeth', []):
            stt = self.jaw if row.get('jaw') else st
            for i in range(row['count']):
                f = i / max(row['count'] - 1, 1)
                tt = lerp(row['t0'], row['t1'], f)
                ln = row['len'] * (row.get('big', 1.0) if i in row.get('fangs', ()) else 1.0) \
                    * (0.75 + 0.25 * np.sin(i * 2.4))
                bc = stt.surface(tt, row['a'])
                Tt, Nn = stt.frame(tt)
                dirn = Nn * (1 if row.get('jaw') else -1)
                bc = bc - dirn * ln * 0.15 - np.array([np.sign(bc[0]) * 0.012, 0, 0])
                r = ln * 0.3
                ring = [bc + Tt * r, bc + LEFT * r * 0.8 - Tt * r * 0.6, bc - LEFT * r * 0.8 - Tt * r * 0.6]
                tip = bc + dirn * ln - Tt * ln * 0.12
                verts = np.array(ring + [tip])
                tris = orient(verts, np.array([(0, 1, 3), (1, 2, 3), (2, 0, 3)]), centers=bc)
                uv = rect_uv('tooth', [0.1, 0.5, 0.9, 0.5], [0.95, 0.95, 0.95, 0.05])
                pa = np.zeros((4, NPA))
                pa[3, PA_ALONG] = 1
                self.add(Part('tooth', verts, tris, uv, jw if row.get('jaw') else hw, pa=pa, crease=30,
                              name='tooth'), mirror=True)

    # --- legs ------------------------------------------------------------------------------------
    def build_legs(self):
        p, sides = self.p, self.L['limb']
        g = p['girth']
        for key, rect in (('leg_f', 'leg_f'), ('leg_h', 'leg_h')):
            lg = p[key]
            pts = np.array([P(x * g, u * g, f) for x, u, f in lg['pts']])
            radii = np.array(lg['r']) * g * p.get('leg_scale', 1.0)
            nsamp = {0: 12, 1: 8, 2: 5}[self.lod]
            tt = np.linspace(0, len(pts) - 1, nsamp)
            path = cr(pts, tt)
            rr = cr(radii, tt)
            w = self.w_spine(self.t_at_f(-pts[0][1]))
            ext = smoothstep(len(pts) - 2.2, len(pts) - 1, tt) * 0.8
            dl = norm(path[-1] - path[-2])
            path_c = np.concatenate([path, [path[-1] + dl * rr[-1] * 0.6]])
            part = tube(path_c, np.concatenate([rr, [0.0]]), sides, up_hint=LEFT,
                        squash=lg.get('squash', 0.85), tip_start=True, tip_end=True, rect=rect,
                        kind='leg', weights=w, crease=65, ext=np.concatenate([ext, [ext[-1]]]),
                        name=key)
            self.add(part, mirror=True)
            # toes / claws
            end, prev = path[-1], path[-2]
            d = norm(end - prev)
            if self.L['claws']:
                side_ax = norm(np.cross(d, UP))
                down = np.cross(side_ax, d)
                for j, sp in enumerate((-0.42, 0.0, 0.42)):
                    cd = norm(d + side_ax * sp * 0.9)
                    base = end - d * rr[-1] * 0.35 + side_ax * sp * rr[-1] * 0.9
                    cl = lg.get('claw', 0.34) * g
                    cpath = curve_path(base, cd, cl, 4, side_ax, np.radians(lg.get('claw_bend', 50)))
                    cr_ = rr[-1] * 0.62 * np.array([1.0, 0.8, 0.45, 0.0])
                    self.add(tube(cpath, cr_, 4 if self.lod else 5, up_hint=down, rect='claw',
                                  kind='claw', weights=w, crease=45, name='claw'), mirror=True)
            else:
                cpath = np.array([end - d * rr[-1] * 0.3, end + d * lg.get('claw', 0.34) * g * 0.8])
                self.add(tube(cpath, [rr[-1] * 0.9, 0], 3, rect='claw', kind='claw', weights=w,
                              crease=45, name='claw'), mirror=True)

    # --- wings -----------------------------------------------------------------------------------
    def wing_layout(self):
        w = self.p['wing']
        S = P(w['sx'], w['su'], w['sf'])
        dih = np.radians(w.get('dihedral', 6))
        span = w['hum'] + w['fore'] + max(r['len'] for r in w['rays'])

        def wp(o, f):
            o = np.asarray(o, float)
            hgt = o * np.tan(dih) - w.get('tip_droop', 0.06) * span * (np.maximum(o, 0) / span) ** 2.4
            return S + np.stack([o, -np.asarray(f, float), hgt], axis=-1)
        ha, fa = np.radians(w['hum_ang']), np.radians(w['fore_ang'])
        E2 = np.array([w['hum'] * np.cos(ha), -w['hum'] * np.sin(ha)])
        W2 = E2 + np.array([w['fore'] * np.cos(fa), w['fore'] * np.sin(fa)])
        rays = []
        for r in w['rays']:
            n = 24
            a0, cv = np.radians(r['ang']), np.radians(r.get('curve', 12))
            tau = (np.arange(n) + 0.5) / n
            ang = a0 + cv * tau
            d = np.stack([np.cos(ang), -np.sin(ang)], axis=1) * (r['len'] / n)
            pts2 = np.concatenate([[W2], W2 + np.cumsum(d, axis=0)])
            rays.append(dict(pts2=pts2, pts=wp(pts2[:, 0], pts2[:, 1]), bone=r['bone'],
                             tube=r.get('tube', True), r=r.get('r', 0.07), len=r['len']))
        B = P(w['bx'], w['bu'], w['bf'])
        return dict(S=S, E=wp(*E2), W=wp(*W2), E2=E2, W2=W2, rays=rays, B=B, wp=wp, span=span)

    @staticmethod
    def ray_at(ray, t):
        n = len(ray['pts']) - 1
        x = np.clip(np.asarray(t, float), 0, 1) * n
        i = np.minimum(x.astype(int), n - 1)
        u = (x - i)[..., None]
        return ray['pts'][i] * (1 - u) + ray['pts'][i + 1] * u

    def ray_w(self, ray):
        b = ray['bone']
        if isinstance(b, (tuple, list)):
            return wv(**{'wing_finger%d_L' % b[0]: 1 - b[2], 'wing_finger%d_L' % b[1]: b[2]})
        return wv(**{'wing_finger%d_L' % b: 1})

    def build_wings(self):
        p = self.p
        w = p['wing']
        lay = self.wing_layout()
        S, E, W, B = lay['S'], lay['E'], lay['W'], lay['B']
        rays = lay['rays']
        M, N = self.L['memb']
        # UV bounds from key points
        keys = np.concatenate([[S, E, W, B], np.concatenate([r['pts'] for r in rays])])
        xmin, xmax = keys[:, 0].min() - 0.1, keys[:, 0].max() + 0.1
        ymin, ymax = keys[:, 1].min() - 0.3, keys[:, 1].max() + 0.1  # y = -fwd

        def muv(pts):
            return rect_uv('membrane', (pts[:, 0] - xmin) / (xmax - xmin), (pts[:, 1] - ymin) / (ymax - ymin))
        ts = np.linspace(0, 1, N + 1)
        billow = w.get('billow', 0.22)
        rng = np.random.RandomState(p.get('seed', 7))
        tatter = w.get('tatter', 0.0)

        def scallop_edge(pa_, pb_, anchor, us, depth):
            base = pa_[None] * (1 - us[:, None]) + pb_[None] * us[:, None]
            k = depth * np.sin(PI * us) ** 0.85
            if tatter and len(us) > 3:
                jag = rng.uniform(-0.2, 1.0, len(us)) * tatter
                jag[0] = jag[-1] = 0
                jag[::2] *= 0.25
                k = k + jag * (0.6 + 0.4 * np.sin(PI * us))
            return base + (anchor[None] - base) * k[:, None]

        w_sh, w_el = wv(wing_shoulder_L=1), wv(wing_elbow_L=1)
        wS = wv(chest=0.6, wing_shoulder_L=0.4)
        wB = self.w_spine(self.t_at_f(w['bf']))
        panels = []
        # inner panel: arm (lead) -> body .. finger3 tip (trail)
        r_in = rays[-1]
        lenSE, lenEW = np.linalg.norm(E - S), np.linalg.norm(W - E)
        uE = lenSE / (lenSE + lenEW)
        m1 = max(1, int(round(M * uE)))
        m2 = max(1, M - m1) + (1 if self.lod == 0 else 0)
        us = np.concatenate([np.linspace(0, uE, m1 + 1), np.linspace(uE, 1, m2 + 1)[1:]])
        lead = np.array([lerp(S, E, u / uE) if u <= uE else lerp(E, W, (u - uE) / (1 - uE)) for u in us])
        tipc = r_in['pts'][-1]
        anchor = lerp(E, W, 0.3)
        trail = scallop_edge(B, tipc, anchor, us, w.get('scallop_in', 0.2))
        left = S[None] * (1 - ts[:, None]) + B[None] * ts[:, None]
        right = self.ray_at(r_in, ts)
        grid = np.zeros((len(ts), len(us), 3))
        wgt = np.zeros((len(ts), len(us), NB))
        wr = self.ray_w(r_in)
        for i, t in enumerate(ts):
            for j, u in enumerate(us):
                pt = (1 - t) * lead[j] + t * trail[j] + (1 - u) * left[i] + u * right[i] \
                    - ((1 - u) * (1 - t) * S + u * (1 - t) * W + (1 - u) * t * B + u * t * tipc)
                pt = pt + UP * billow * np.sin(PI * u) * t ** 0.8 * (1 - 0.3 * t) * 0.9
                grid[i, j] = pt
                wl = wS if j == 0 else (wr if j == len(us) - 1 else (w_sh if u < uE - 1e-6 else
                                                                     (0.5 * w_sh + 0.5 * w_el if abs(u - uE) < 1e-6 else w_el)))
                wt = lerp(wB, wr, u)
                wgt[i, j] = (1 - t) * wl + t * wt
        panels.append((grid, wgt, us, 0))
        # finger panels
        for k in range(len(rays) - 1, 0, -1):
            ra, rb = rays[k], rays[k - 1]
            usf = np.linspace(0, 1, max(2, int(round(M * w.get('panel_div', 0.7)))) + 1)
            ea, eb = ra['pts'][-1], rb['pts'][-1]
            trail = scallop_edge(ea, eb, W, usf, w.get('scallop', 0.2))
            left, right = self.ray_at(ra, ts), self.ray_at(rb, ts)
            grid = np.zeros((len(ts), len(usf), 3))
            wgt = np.zeros((len(ts), len(usf), NB))
            wa, wb_ = self.ray_w(ra), self.ray_w(rb)
            for i, t in enumerate(ts):
                for j, u in enumerate(usf):
                    pt = (1 - t) * W + t * trail[j] + (1 - u) * left[i] + u * right[i] \
                        - ((1 - u) * (1 - t) * W + u * (1 - t) * W + (1 - u) * t * ea + u * t * eb)
                    pt = pt + UP * billow * np.sin(PI * u) * t ** 0.9 * (1 - 0.3 * t) * \
                        min(1.0, np.linalg.norm(eb - ea) / 3.0)
                    grid[i, j] = pt
                    wgt[i, j] = (1 - u) * wa + u * wb_
            panels.append((grid, wgt, usf, len(rays) - k))
        # propatagium (front web between shoulder and wrist)
        if w.get('prop', True):
            npp = 5 if self.lod == 0 else 3 if self.lod == 1 else 2
            up_ = np.linspace(0, 1, npp)
            arm = np.array([lerp(S, E, u / uE) if u <= uE else lerp(E, W, (u - uE) / (1 - uE)) for u in up_])
            fr = S[None] * (1 - up_[:, None]) + W[None] * up_[:, None]
            fr = fr + (arm - fr) * (0.3 * np.sin(PI * up_))[:, None]
            grid = np.stack([fr, arm])
            wgt = np.zeros((2, npp, NB))
            for j, u in enumerate(up_):
                wa_ = w_sh if u < uE - 1e-6 else (0.5 * w_sh + 0.5 * w_el if abs(u - uE) < 1e-6 else w_el)
                wgt[1, j] = wa_
                wgt[0, j] = (1 - u) * w_sh + u * w_el
            panels.append((grid, wgt, up_, -1))
        for grid, wgt, us_, idx in panels:
            nr, nc = grid.shape[:2]
            verts = grid.reshape(-1, 3)
            tris = clean_tris(verts, grid_tris(nr, nc))
            tris = orient(verts, tris, direction=UP)
            pa = np.zeros((nr, nc, NPA))
            if idx == -1:
                pa[..., PA_ALONG] = 0.15
                pa[..., PA_AROUND] = 0.5
                pa[0, :, PA_AROUND] = 0.0
                pa[..., PA_AUX] = -1
            else:
                pa[..., PA_ALONG] = np.linspace(0, 1, nr)[:, None]
                pa[..., PA_AROUND] = us_[None, :]
                pa[..., PA_AUX] = idx
            self.add(Part('membrane', verts, tris, muv(verts), wgt.reshape(-1, NB), mat=MAT_MEMBRANE,
                          pa=pa.reshape(-1, NPA), crease=180, name='membrane'), mirror=True)
        # arm bones: shoulder -> elbow -> wrist -> leading finger, then the other fingers
        sides = self.L['arm']
        ar = w.get('arm_r', 0.2)
        lead_ray = rays[0]
        nf = {0: 7, 1: 4, 2: 3}[self.lod]
        tf = np.linspace(0, 1, nf)[1:]
        if self.lod == 0:
            path = [S - norm(E - S) * 0.15, S, lerp(S, E, 0.5), lerp(S, E, 0.88), E, lerp(E, W, 0.14),
                    lerp(E, W, 0.55), lerp(E, W, 0.9), W]
            rad = [ar * 1.25, ar * 1.3, ar * 0.82, ar * 0.72, ar * 0.86, ar * 0.66, ar * 0.5, ar * 0.5, ar * 0.62]
            wts = [wS, wS, w_sh, w_sh, 0.5 * w_sh + 0.5 * w_el, w_el, w_el, w_el, w_el]
        else:
            path = [S, lerp(S, E, 0.5), E, lerp(E, W, 0.5), W]
            rad = [ar * 1.3, ar * 0.85, ar * 0.86, ar * 0.55, ar * 0.62]
            wts = [wS, w_sh, 0.5 * w_sh + 0.5 * w_el, w_el, w_el]
        n_arm = len(path)
        wl = self.ray_w(lead_ray)
        fr_ = lead_ray['r']
        ext_len = 1.0 + w.get('tip_claw', 0.04)
        for t in tf:
            path.append(self.ray_at(lead_ray, t))
            rad.append(fr_ * (1 - t) ** 0.7 * 0.95 + 0.012)
            wts.append(wl)
        rad[-1] = 0.0
        tot = lenSE + lenEW + lead_ray['len']
        part = tube(np.array(path), rad, sides, up_hint=UP, tip_end=True, rect=sub_rect('arm', 0, 5),
                    kind='arm', weights=np.array(wts), mat=MAT_RUNES, crease=70, name='arm',
                    lv_range=(0, 2.0))
        # the main arm strip is two rows tall
        part.uv = None
        part_uv_rect = (560, 392, 464, 80)
        along = part.pa[:, PA_ALONG]
        part.uv = rect_uv(part_uv_rect, along, part.pa[:, PA_AROUND])
        part.pa[:, PA_AUX] = tot
        self.add(part, mirror=True)
        row = 0
        for k in range(1, len(rays)):
            ray = rays[k]
            if not ray['tube'] or (self.lod == 2 and not isinstance(ray['bone'], int)):
                continue
            tfr = np.linspace(0, 1, nf + (1 if self.lod == 0 else 0))
            pth = self.ray_at(ray, tfr)
            rd = ray['r'] * (1 - tfr) ** 0.7 * 0.9 + 0.012
            rd[0] = ray['r'] * 0.8
            rd[-1] = 0
            rect = (560, 472 + 40 * min(row, 1), 464, 40)
            fp = tube(pth, rd, sides, up_hint=UP, tip_end=True, rect=rect, kind='arm',
                      weights=self.ray_w(ray), mat=MAT_RUNES, crease=70, name='finger')
            fp.pa[:, PA_AUX] = ray['len']
            self.add(fp, mirror=True)
            row += 1
        # thumb claw at the wrist
        if self.lod < 2:
            d = norm(P(*w.get('thumb_dir', (0.25, 0.25, 1.0))))
            cp = curve_path(W - d * 0.05, d, w.get('thumb', 0.55), 4, LEFT, np.radians(-40))
            self.add(tube(cp, np.array([0.085, 0.07, 0.04, 0.0]) * w.get('thumb_r', 1.0), 4 if self.lod else 5,
                          up_hint=UP, rect=(560, 552, 232, 40), kind='claw', weights=w_el, crease=45,
                          name='thumb'), mirror=True)

    # --- fins --------------------------------------------------------------------------------
    def build_fins(self):
        sub = self.L['fin_sub']
        st = self.st
        for fdef in self.p.get('dorsal_fins', []):
            nrib = fdef['ribs']
            ncol = nrib * sub + 1
            f = np.linspace(0, 1, ncol)
            t = lerp(fdef['t0'], fdef['t1'], f)
            a = fdef.get('a', 1.0)
            base = st.surface(t, np.full(ncol, a), lift=-0.04)
            T, N = st.frame(t)
            nrm_ = N if a >= 0.97 else (-N if a <= 0.03 else st.normal(t, np.full(ncol, a)))
            env = np.sin(PI * np.clip(f, 0, 1) ** fdef.get('skew', 0.8)) ** fdef.get('pw', 0.6)
            env = fdef.get('min', 0.0) + (1 - fdef.get('min', 0.0)) * env
            ph = (np.arange(ncol) % sub) / sub
            sc = 1 - fdef.get('scallop', 0.3) * np.sin(PI * ph) ** 0.8
            if fdef.get('tatter'):
                rs = np.random.RandomState(fdef.get('seed', 3))
                sc = sc * (1 - fdef['tatter'] * rs.uniform(0, 1, ncol) * (ph > 0))
            hgt = fdef['h'] * env * sc
            lean = fdef.get('lean', 0.5)
            top = base + (nrm_ - T * lean) * hgt[:, None]
            mid = base + (nrm_ - T * lean * 0.4) * (hgt * 0.5)[:, None]
            rows = [base, mid, top] if self.lod == 0 else [base, top]
            verts = np.concatenate(rows)
            tris = clean_tris(verts, grid_tris(len(rows), ncol))
            hmax = fdef['h']
            rect = fdef.get('rect', 'fin')
            lvs = [np.ones(ncol), 1 - 0.5 * hgt / hmax, 1 - hgt / hmax] if self.lod == 0 else \
                [np.ones(ncol), 1 - hgt / hmax]
            uv = np.concatenate([rect_uv(rect, f, lv_) for lv_ in lvs])
            pa = np.zeros((len(rows), ncol, NPA))
            for ri in range(len(rows)):
                pa[ri, :, PA_ALONG] = f
                pa[ri, :, PA_AROUND] = ri / (len(rows) - 1)
                pa[ri, :, PA_AUX] = ph
            W_ = np.tile(np.array([self.w_spine(tt) for tt in t]), (len(rows), 1))
            self.add(Part('fin', verts, tris, uv, W_, mat=MAT_MEMBRANE, pa=pa.reshape(-1, NPA),
                          crease=180, name='fin'), mirror=(0.03 < a < 0.97))

        for fdef in self.p.get('fan_fins', []):
            if fdef.get('small') and not self.L['small']:
                continue
            if 't' in fdef:
                stt = self.jaw if fdef.get('jaw') else st
                origin = stt.surface(fdef['t'], fdef['a'], lift=-0.03)
                wgt = wv(jaw=1) if fdef.get('jaw') else self.w_spine(fdef['t'])
            else:
                origin = P(*fdef['origin'])
                wgt = self.w_spine(fdef['wt'])
            tips = np.array([P(*d) for d in fdef['tips']])
            nt = len(tips)
            sub2 = max(1, sub // (1 if fdef.get('fine') else 2)) if self.lod < 2 else 1
            cols = []
            aux = []
            rs = np.random.RandomState(fdef.get('seed', 5))
            for i in range(nt - 1):
                for s_ in range(sub2):
                    u = s_ / sub2
                    v = lerp(tips[i], tips[i + 1], u)
                    k = 1 - fdef.get('scallop', 0.3) * np.sin(PI * u) ** 0.8
                    if fdef.get('tatter') and s_ > 0:
                        k *= 1 - fdef['tatter'] * rs.uniform(0, 1)
                    cols.append(v * k)
                    aux.append(u)
            cols.append(tips[-1])
            aux.append(0.0)
            cols = np.array(cols)
            nc = len(cols)
            inner = fdef.get('inner', 0.45)
            base_w = P(*fdef['base_dir']) * fdef.get('base_len', 0.0) if 'base_dir' in fdef else np.zeros(3)
            fr = np.linspace(-0.5, 0.5, nc)[:, None]
            o_row = origin[None] + base_w[None] * fr
            verts = np.concatenate([o_row, o_row + cols * inner, o_row + cols])
            tris = clean_tris(verts, grid_tris(3, nc))
            if 'face' in fdef:
                tris = orient(verts, tris, direction=P(*fdef['face']))
            # planar UV in the fin's own plane
            e1 = norm(tips[0])
            nrm_ = norm(np.cross(tips[0], tips[-1])) if nt > 1 else UP
            e2 = np.cross(nrm_, e1)
            rel = verts - origin
            lu, lv = rel @ e1, rel @ e2
            lo_u, hi_u, lo_v, hi_v = lu.min(), lu.max(), lv.min(), lv.max()
            rect = fdef.get('rect', 'fin2')
            uv = rect_uv(rect, (lu - lo_u) / max(hi_u - lo_u, 1e-6), (lv - lo_v) / max(hi_v - lo_v, 1e-6))
            pa = np.zeros((3, nc, NPA))
            pa[0, :, PA_AROUND] = 0.0
            pa[1, :, PA_AROUND] = inner
            pa[2, :, PA_AROUND] = 1.0
            pa[:, :, PA_ALONG] = np.linspace(0, 1, nc)[None, :]
            pa[:, :, PA_AUX] = np.array(aux)[None, :]
            self.add(Part('fin', verts, tris, uv, wgt, mat=MAT_MEMBRANE, pa=pa.reshape(-1, NPA),
                          crease=180, name=fdef.get('name', 'fan')), mirror=fdef.get('mirror', True))

    # --- rider -----------------------------------------------------------------------------------
    def build_rider(self):
        """Saddle, rider and cape, all skinned to the bone under the seat.

        The rider is ours: a sky-rider in lamellar leather with a swept-back horned helm (its
        visor slit glows in the Runes slot, like the dragon's eyes), angular shoulder plates, a
        cowl, a helm crest and a swallow-tailed cape. Cowl, crest and cape are in the Membrane
        slot, so the rider carries the team colour like the wings do. Detail per LOD:
          LOD0  everything; LOD1 the same parts with fewer sides; LOD2 body, helm and cape only.
        """
        p = self.p
        r = p.get('rider', {})
        level = self.L['rider']
        t0 = r.get('t', 7.55)
        sc = r.get('scale', 1.0)
        st = self.st
        top = st.surface(t0, 1.0)
        f0, u0 = -top[1], top[2]
        T, N = st.frame(t0)
        w = self.w_spine(t0)
        w = wv(chest=1) if w[BI['chest']] > 0.5 else w
        bodyv = st.vals(t0)
        bw = bodyv[2]

        def loc(df, du):
            # offsets along the spine tangent / normal at the seat -> (fwd, up)
            return (f0 + (-T[1]) * df + (-N[1]) * du, u0 + T[2] * df + N[2] * du)

        def seat(x, df, du):
            """A point x to the left of the centre line, df ahead of and du above the seat."""
            f, u = loc(df * sc, du * sc)
            return P(x * sc, u, f)
        # saddle: a low blocky seat with a raised cantle and a pommel horn
        K = 8 if level else 4
        rows = []
        for df, du, rx, rt, rb in ((-0.58, 0.0, 0.18, 0.06, 0.14), (-0.46, 0.12, 0.27, 0.18, 0.28), (-0.28, 0.03, 0.33, 0.08, 0.34),
                                   (0.1, 0.02, 0.31, 0.08, 0.34), (0.32, 0.08, 0.2, 0.14, 0.28), (0.44, 0.0, 0.13, 0.05, 0.12)):
            f, u = loc(df * sc, du * sc)
            rows.append((f, u - 0.02, min(rx * sc, bw * 0.95), rt * sc, rb * sc, 3.2, 0))
        sst = Stations(rows)
        ts = np.linspace(0, 5, 6 if level == 0 else 9)
        self.add(self.loft(sst, ts, K, 'saddle', 'saddle', weight_fn=lambda t: w, crease=40, name='saddle'))

        # The rider leans into the wind. `body(h, b, x)`: h up the spine from the seat, b behind
        # it (square to the spine), x to the left.
        lean = np.radians(r.get('lean', 30))
        sd, cd = np.sin(lean), np.cos(lean)

        def body(h, b=0.0, x=0.0):
            return seat(x, -0.12 + h * sd - b * cd, 0.1 + h * cd + b * sd)
        axis = norm(body(1.0) - body(0.0))
        back = norm(body(0.0, 1.0) - body(0.0))

        # body and helm in one loft. Stations: 0 hips, 1 belt, 2 ribs, 3 chest, 4 shoulder top,
        # 5 neck, 6 helm rim, 7 brow, 8 crown, 9 the helm's swept-back point.
        rows = []
        for h, b, rx, rf, rbk, sq in ((0.0, 0.0, 0.2, 0.15, 0.16, 2.6), (0.14, 0.0, 0.17, 0.125, 0.13, 2.6),
                                      (0.30, 0.0, 0.215, 0.15, 0.15, 2.8), (0.46, 0.0, 0.29, 0.165, 0.17, 3.0),
                                      (0.555, 0.0, 0.24, 0.125, 0.14, 2.8), (0.615, 0.0, 0.085, 0.075, 0.085, 2.2),
                                      (0.675, 0.0, 0.118, 0.125, 0.12, 2.6), (0.79, 0.01, 0.128, 0.15, 0.15, 2.7),
                                      (0.90, 0.05, 0.1, 0.1, 0.15, 2.4), (0.99, 0.16, 0.03, 0.035, 0.06, 2.2)):
            c = body(h, b)
            # for a vertical path "up" of the profile points backward; rt=back, rb=front
            rows.append((-c[1], c[2], rx * sc, rbk * sc, rf * sc, sq, 0))
        rst = Stations(rows)
        if level == 2:
            ts = np.array([0, 1, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7, 7.5, 8, 9], float)
        elif level == 1:
            ts = np.arange(10.0)
        else:
            ts = np.array([0, 3, 4, 5, 7, 9], float)

        def visor(ta, tb, aa, ab):
            # the front of the helm between its rim and its brow glows through the emissive mask
            return (ta >= 6 - 1e-6) & (tb <= 7 + 1e-6) & (ab <= 0.5 + 1e-6)
        self.add(self.loft(rst, ts, 8 if level == 2 else 6 if level == 1 else 4, 'rider', 'rider',
                           weight_fn=lambda t: w, cap0=False, crease=50, name='rider',
                           rune_fn=visor if level >= 1 else None))
        if level >= 1:
            sides = 5 if level == 2 else 4
            # arms: shoulder, elbow, wrist, then a fist closed round the saddle grip
            shoulder, elbow = body(0.5, 0.0, 0.27), seat(0.36, 0.06, 0.25)
            if level == 2:
                ap = np.array([shoulder, elbow, seat(0.17, 0.3, 0.335), seat(0.135, 0.36, 0.335),
                               seat(0.11, 0.41, 0.33)])
                ar = np.array([0.085, 0.066, 0.055, 0.07, 0.0]) * sc
            else:
                ap = np.array([shoulder, elbow, seat(0.13, 0.38, 0.335)])
                ar = np.array([0.085, 0.066, 0.07]) * sc
            arm = tube(ap, ar, sides, rect='rider_arm', kind='rider_limb', weights=w,
                       tip_end=level == 2, crease=60, name='rider_arm')
            arm.pa[:, PA_AUX] = 1
            self.add(arm, mirror=True)
            # legs: hip, knee against the flank, ankle, toe
            hip, knee, foot = loc(-0.1 * sc, 0.12 * sc), loc(0.22 * sc, -0.02 * sc), loc(0.05 * sc, -0.48 * sc)
            kx, fx = min(0.4 * sc, bw + 0.08), min(0.46 * sc, bw + 0.12)
            lp = [P(0.14 * sc, hip[1], hip[0]), P(kx, knee[1], knee[0]), P(fx, foot[1], foot[0])]
            lr = [0.115, 0.095, 0.075]
            if level == 2:
                toe = loc(0.25 * sc, -0.53 * sc)
                lp.append(P(fx, toe[1], toe[0]))
                lr.append(0.0)
            leg = tube(np.array(lp), np.array(lr) * sc, sides, rect='rider_leg', kind='rider_limb',
                       weights=w, tip_end=level == 2, crease=60, name='rider_leg')
            leg.pa[:, PA_AUX] = 2
            self.add(leg, mirror=True)
            # the grip: a hoop standing on the pommel, one fist on each corner
            gp = np.array([seat(0.1, 0.37, 0.07), seat(0.125, 0.4, 0.33), seat(-0.125, 0.4, 0.33),
                           seat(-0.1, 0.37, 0.07)])
            grip = tube(gp, np.full(4, 0.03 * sc), 4 if level == 2 else 3, up_hint=LEFT,
                        rect='rider_grip', kind='rider_gear', weights=w, tip_end=False, crease=50,
                        name='rider_grip')
            grip.pa[:, PA_AUX] = 2
            self.add(grip)
            # shoulder plates: a swept-back point each, like the dragon's own scutes
            sh = body(0.5, 0.0, 0.27)
            base = [sh - back * 0.13 * sc - axis * 0.03 * sc, sh + LEFT * 0.13 * sc - axis * 0.11 * sc,
                    sh + back * 0.15 * sc - axis * 0.02 * sc, sh - LEFT * 0.1 * sc + axis * 0.07 * sc]
            apex = sh + (LEFT * 0.16 + axis * 0.13 + back * 0.15) * sc
            verts = np.array(base + [apex] * 4)
            tris = orient(verts, np.array([(0, 1, 4), (1, 2, 5), (2, 3, 6), (3, 0, 7)]), centers=sh)
            lu = np.array([0.0, 0.5, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5])
            lv = np.array([1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 0.0])
            pa = np.zeros((8, NPA))
            pa[:, PA_ALONG] = 1 - lv
            pa[:, PA_AROUND] = lu
            pa[:, PA_AUX] = 1
            self.add(Part('rider_gear', verts, tris, rect_uv('rider_pauldron', lu, lv), w, pa=pa,
                          crease=30, name='rider_pauldron'), mirror=True)
            # cowl: a collar of cloth from the neck out over the shoulders (team-tinted, no flutter)
            km = 8 if level == 2 else 6
            # rings: (height, half width, reach to the front, reach to the back), neck to hem
            ring_rows = ((0.605, 0.1, 0.095, 0.095), (0.585, 0.2, 0.165, 0.175), (0.5, 0.3, 0.215, 0.225)) \
                if level == 2 else ((0.605, 0.1, 0.095, 0.095), (0.5, 0.3, 0.215, 0.225))
            grid = np.zeros((len(ring_rows), km + 1, 3))
            pa = np.zeros((len(ring_rows), km + 1, NPA))
            for i, (h, rx, rfr, rbk) in enumerate(ring_rows):
                for j in range(km + 1):
                    a = 2 * PI * j / km
                    c = np.cos(a)
                    # the hem hangs lower over the chest and the back than on the shoulders
                    drop = 0.1 * c * c * (i / (len(ring_rows) - 1))
                    grid[i, j] = body(h - drop, -c * (rfr if c > 0 else rbk), np.sin(a) * rx)
                    pa[i, j, PA_ALONG] = i / (len(ring_rows) - 1)
                    pa[i, j, PA_AROUND] = j / km
            pa[..., PA_AUX] = 1
            verts = grid.reshape(-1, 3)
            tris = clean_tris(verts, grid_tris(len(ring_rows), km + 1))
            tris = orient(verts, tris, centers=body(0.4))
            LU, LV = np.meshgrid(np.linspace(0, 1, km + 1), np.linspace(0, 1, len(ring_rows)))
            self.add(Part('rider_cloth', verts, tris, rect_uv('rider_mantle', LU.reshape(-1), LV.reshape(-1)),
                          w, mat=MAT_MEMBRANE, pa=pa.reshape(-1, NPA), crease=180, name='rider_mantle'))
            # crest: a blade swept back from the brow over the crown (team-tinted, no flutter)
            cp = [(0.8, -0.13), (0.95, -0.05), (1.12, 0.2), (1.0, 0.36), (0.86, 0.17)]
            verts = np.array([body(h, b) for h, b in cp])
            tris = orient(verts, np.array([(0, 1, 4), (1, 2, 4), (2, 3, 4)]), direction=LEFT)
            lu = np.array([0.0, 0.3, 0.75, 1.0, 0.55])
            lv = np.array([1.0, 0.35, 0.0, 0.45, 1.0])
            pa = np.zeros((5, NPA))
            pa[:, PA_ALONG] = [0.0, 0.5, 1.0, 1.0, 0.0]
            pa[:, PA_AROUND] = lu
            pa[:, PA_AUX] = 2
            self.add(Part('rider_cloth', verts, tris, rect_uv('rider_crest', lu, lv), w, mat=MAT_MEMBRANE,
                          pa=pa, crease=180, name='rider_crest'))
        # cape: a swallow-tailed sheet streaming back from the shoulders (team-tinted, Membrane
        # slot; the runtime makes it flutter by its UV inside the 'cloak' rect)
        nr, nc = (7, 5) if level == 2 else (4, 3) if level == 1 else (3, 3)
        cl = r.get('cloak_len', 2.1) * sc
        grid = np.zeros((nr, nc, 3))
        pa = np.zeros((nr, nc, NPA))
        for i in range(nr):
            fi = i / (nr - 1)
            for j in range(nc):
                fj = j / (nc - 1) - 0.5
                width = (0.4 + 0.56 * fi ** 0.8) * sc
                # the middle of the free end stops short of the two tails
                notch = 0.3 * (1 - (abs(fj) * 2) ** 1.3) * smoothstep(0.45, 1.0, fi)
                df = (-0.14 + 0.5 * sd) * sc - 0.1 * sc - cl * fi * (1 - notch)
                du = (0.1 + 0.5 * cd) * sc + 0.02 - 0.22 * sc * np.sin(fi * 2.4) + 0.16 * sc * fi ** 2 \
                    - 0.3 * sc * abs(fj) ** 1.5 * (1 - 0.5 * fi) + 0.07 * sc * np.sin(fi * 5.5 + fj * 3.0) * fi
                f, u = loc(df, du)
                grid[i, j] = P(fj * width, u, f)
                pa[i, j, PA_ALONG] = fi
                pa[i, j, PA_AROUND] = fj + 0.5
        verts = grid.reshape(-1, 3)
        tris = orient(verts, grid_tris(nr, nc), direction=UP)
        LU, LV = np.meshgrid(np.linspace(0, 1, nc), np.linspace(0, 1, nr))
        self.add(Part('cloak', verts, tris, rect_uv('cloak', LU.reshape(-1), LV.reshape(-1)), w,
                      mat=MAT_MEMBRANE, pa=pa.reshape(-1, NPA), crease=180, name='cloak'))

    # --- all together ---------------------------------------------------------------------------
    def build(self):
        self.build_body()
        self.build_legs()
        self.build_wings()
        self.build_spikes()
        self.build_plates()
        self.build_surf_spikes()
        self.build_horns()
        self.build_eyes_teeth()
        self.build_fins()
        self.build_rider()
        return Mesh(self.parts, NB)


def skeleton(p):
    """[(name, parent, head, tail)] in Blender coordinates."""
    b = Builder(p, 0)
    st = b.st
    c = lambda t: st.center(np.array(float(t)))
    out = [('root', None, np.zeros(3), P(0, 0, 0.5))]
    out.append(('hips', 'root', c(T_MID), c(T_HIPS)))
    out.append(('chest', 'root', c(T_MID), c(T_NECK0)))
    out.append(('neck1', 'chest', c(T_NECK0), c(T_N1)))
    out.append(('neck2', 'neck1', c(T_N1), c(T_N2)))
    out.append(('neck3', 'neck2', c(T_N2), c(T_HEAD0)))
    out.append(('head', 'neck3', c(T_HEAD0), c(T_H5)))
    jc = lambda t: b.jaw.center(np.array(float(t)))
    hinge = jc(0.0) + np.array([0, 0, 0.035 * p['head_h']])
    out.append(('jaw', 'head', hinge, jc(3.0)))
    for k in range(4):
        out.append(('tail%d' % (k + 1), 'hips' if k == 0 else 'tail%d' % k,
                    c(T_HIPS * (1 - k / 4)), c(T_HIPS * (1 - (k + 1) / 4))))
    lay = b.wing_layout()
    rays = lay['rays']
    boned = {}
    for r in rays:
        if isinstance(r['bone'], int):
            boned[r['bone']] = r
    for s, sx in (('_L', 1.0), ('_R', -1.0)):
        m = np.array([sx, 1, 1])
        out.append(('wing_shoulder' + s, 'chest', lay['S'] * m, lay['E'] * m))
        out.append(('wing_elbow' + s, 'wing_shoulder' + s, lay['E'] * m, lay['W'] * m))
        hand = lay['W'] + norm(boned[1]['pts'][4] - lay['W']) * 0.4
        out.append(('wing_wrist' + s, 'wing_elbow' + s, lay['W'] * m, hand * m))
        for k in (1, 2, 3):
            out.append(('wing_finger%d%s' % (k, s), 'wing_wrist' + s, lay['W'] * m, boned[k]['pts'][-1] * m))
    assert [o[0] for o in out] == BONES
    info = dict(muzzle=c(T_H5) + st.frame(np.array(float(T_H5)))[0] * 0.25,
                wing_tip=max(r['pts'][:, 0].max() for r in rays), layout=lay)
    return out, info


def build_all(p):
    return {lod: Builder(p, lod).build() for lod in (0, 1, 2)}
