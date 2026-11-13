"""Hand-painted-style texture painter: rasterises the LOD0 mesh into UV space and paints the
base-colour atlas (lighting, AO, scales, markings baked in) and the emissive/rune mask.
Pure numpy; Pillow is only used by paint_dragon.py to save the PNGs.
"""
import numpy as np
from .geom import (ATLAS, KIND, PA_ALONG, PA_AROUND, PA_Q, PA_THETA, PA_EXT, PA_AUX, PI, smoothstep)
from .dragon import Builder

sm = smoothstep


def mix(a, b, t):
    t = np.asarray(t, float)
    if np.ndim(a) > 0 and np.ndim(t) == 1:
        t = t[:, None]
    return np.asarray(a, float) * (1 - t) + np.asarray(b, float) * t


def col(c):
    return np.asarray(c, float)


def _hash(ix, iy, iz, seed):
    h = (ix.astype(np.int64) * 73856093) ^ (iy.astype(np.int64) * 19349663) ^ (iz.astype(np.int64) * 83492791) \
        ^ (int(seed) * 2654435761)
    h = (h ^ (h >> 13)) * 1274126177
    h = h ^ (h >> 16)
    return (h & 0xFFFF) / 65535.0


def noise3(p, freq, seed=0):
    """Value noise in [0, 1], p is (n, 3)."""
    q = p * freq
    i = np.floor(q).astype(np.int64)
    f = q - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * _hash(i[:, 0] + dx, i[:, 1] + dy, i[:, 2] + dz, seed)
    return out


def fbm(p, freq, octaves=4, seed=0):
    out, amp, tot = 0, 1.0, 0.0
    for o in range(octaves):
        out = out + amp * noise3(p, freq * 2 ** o, seed + o * 17)
        tot += amp
        amp *= 0.5
    return out / tot


def noise2(u, v, freq, seed=0):
    return noise3(np.stack([u, v, np.zeros_like(u)], axis=1), freq, seed)


def rasterize(mesh, size=ATLAS):
    """Per-texel interpolated attributes for every painted triangle."""
    H = W = size
    cov = np.zeros((H, W), bool)
    kind = np.zeros((H, W), np.int16)
    group = np.zeros((H, W), np.int16)
    pos = np.zeros((H, W, 3), np.float32)
    nrm = np.zeros((H, W, 3), np.float32)
    pa = np.zeros((H, W, mesh.pa.shape[1]), np.float32)
    px = mesh.uv[:, 0] * W - 0.5
    py = (1 - mesh.uv[:, 1]) * H - 0.5
    for ti in np.flatnonzero(mesh.painted):
        i0, i1, i2 = mesh.tris[ti]
        x0, y0, x1, y1, x2, y2 = px[i0], py[i0], px[i1], py[i1], px[i2], py[i2]
        den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
        if abs(den) < 1e-9:
            continue
        xa, xb = int(np.floor(min(x0, x1, x2))) - 1, int(np.ceil(max(x0, x1, x2))) + 1
        ya, yb = int(np.floor(min(y0, y1, y2))) - 1, int(np.ceil(max(y0, y1, y2))) + 1
        xa, ya, xb, yb = max(xa, 0), max(ya, 0), min(xb, W - 1), min(yb, H - 1)
        if xb < xa or yb < ya:
            continue
        gx, gy = np.meshgrid(np.arange(xa, xb + 1), np.arange(ya, yb + 1))
        l0 = ((y1 - y2) * (gx - x2) + (x2 - x1) * (gy - y2)) / den
        l1 = ((y2 - y0) * (gx - x2) + (x0 - x2) * (gy - y2)) / den
        l2 = 1 - l0 - l1
        eps = -0.6 / max(1.0, np.sqrt(abs(den)))  # slightly conservative: covers edge texels
        m = (l0 >= eps) & (l1 >= eps) & (l2 >= eps)
        if not m.any():
            continue
        inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
        sub = (slice(ya, yb + 1), slice(xa, xb + 1))
        # texels strictly inside always win; edge texels only fill what is still empty
        m = m & (inside | ~cov[sub])
        l0c, l1c, l2c = np.clip(l0[m], 0, 1), np.clip(l1[m], 0, 1), np.clip(l2[m], 0, 1)
        ssum = l0c + l1c + l2c
        l0c, l1c, l2c = l0c / ssum, l1c / ssum, l2c / ssum
        for buf, arr in ((pos, mesh.verts), (nrm, mesh.normals), (pa, mesh.pa)):
            buf[sub][m] = (l0c[:, None] * arr[i0] + l1c[:, None] * arr[i1] + l2c[:, None] * arr[i2])
        kind[sub][m] = mesh.kind[i0]
        group[sub][m] = mesh.tri_group[ti]
        cov[sub][m] = True
    return dict(cov=cov, kind=kind, group=group, pos=pos, nrm=nrm, pa=pa)


def dilate(img, cov, iters=10):
    """Bleed colours outward from covered texels (padding against mip/filter seams)."""
    img = img.copy()
    cov = cov.copy()
    for _ in range(iters):
        acc = np.zeros_like(img, dtype=np.float32)
        cnt = np.zeros(cov.shape, np.float32)
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)):
            sh = np.roll(np.roll(cov, dy, 0), dx, 1)
            acc += np.roll(np.roll(img, dy, 0), dx, 1) * sh[..., None]
            cnt += sh
        new = (~cov) & (cnt > 0)
        img[new] = acc[new] / cnt[new][:, None]
        cov |= new
    return img


def scales(q, th, freq, seed=0):
    """Overlapping scale pattern. Returns (d, rnd, shadow): d = 0 at a scale's root .. 1 at its
    free rim, rnd = per-scale random, shadow = 1 just outside an overlapping rim."""
    u = -q * freq  # free edge points toward the tail (decreasing q)
    v = th * freq
    i = np.floor(u)
    fu = u - i
    R = 1.02

    def cand(row, uu):
        off = 0.5 * (np.mod(row, 2))
        j = np.round(v - off)
        dv = v - off - j
        d = np.sqrt(uu * uu + dv * dv * 1.25)
        return d, _hash(row.astype(np.int64), j.astype(np.int64), np.zeros_like(j, dtype=np.int64), seed)
    dA, rA = cand(i, fu)           # scale rooted on this row line
    dB, rB = cand(i - 1, fu + 1)   # scale rooted one row back, overlapping from above
    inA = dA < R
    d = np.where(inA, dA / R, np.clip(dB / (R * 1.9), 0, 1))
    rnd = np.where(inA, rA, rB)
    shadow = np.where(inA, 0.0, np.exp(-((dA - R) / 0.16)))
    return d, rnd, shadow


def glyphs(x, y, seed=0, strokes=4):
    """Angular rune glyphs: x = cell coordinate along the band (one glyph per unit), y in [0, 1]
    across it. Returns a soft 0..1 mask."""
    cell = np.floor(x).astype(np.int64)
    fx = (x - cell - 0.5) * 1.5  # leave a gap between glyphs
    fy = (y - 0.5) * 1.25
    out = np.zeros_like(x)
    z = np.zeros_like(cell)
    for s_ in range(strokes):
        ax = (np.floor(_hash(cell, z + s_, z + 1, seed) * 3) - 1) * 0.3
        ay = (np.floor(_hash(cell, z + s_, z + 2, seed) * 4) - 1.5) * 0.25
        k = np.floor(_hash(cell, z + s_, z + 3, seed) * 5)
        ddx = np.select([k == 0, k == 1, k == 2, k == 3], [0.0, 0.3, 0.3, -0.3], 0.0)
        ddy = np.select([k == 0, k == 1, k == 2, k == 3], [0.5, 0.25, -0.25, 0.25], 0.25)
        bx, by = np.clip(ax + ddx, -0.32, 0.32), np.clip(ay + ddy, -0.42, 0.42)
        px_, py_ = fx - ax, fy - ay
        ex, ey = bx - ax, by - ay
        h = np.clip((px_ * ex + py_ * ey) / (ex * ex + ey * ey + 1e-6), 0, 1)
        dist = np.hypot(px_ - ex * h, py_ - ey * h)
        out = np.maximum(out, 1 - sm(0.045, 0.1, dist))
    inside = (np.abs(fx) < 0.5) & (np.abs(fy) < 0.6)
    return out * inside


def sphere_ao(pos, nrm, group, mesh, strength=1.0):
    occ = np.zeros(len(pos), np.float32)
    for g, sph in mesh.spheres:
        m = group != g
        if not m.any():
            continue
        p, n = pos[m], nrm[m]
        acc = np.zeros(len(p), np.float32)
        for cx, cy, cz, r in sph:
            d = np.array([cx, cy, cz], np.float32) - p
            l2 = (d * d).sum(axis=1)
            l = np.sqrt(l2) + 1e-6
            cosn = (d * n).sum(axis=1) / l
            # inside the sphere counts as fully occluded on the facing side
            acc += np.clip(r * r / np.maximum(l2, r * r), 0, 1) * np.clip(cosn * 0.75 + 0.25, 0, 1) \
                * np.clip(2.2 - l / r, 0, 1)
        occ[m] += acc
    return np.clip(1 - strength * 0.55 * (1 - np.exp(-occ * 0.9)), 0, 1)


def iridescence(phase):
    ph = phase[:, None] + np.array([0.0, 0.33, 0.67])[None, :]
    return 0.5 + 0.5 * np.cos(2 * PI * ph)


def paint(P, size=ATLAS, log=print):
    b = Builder(P, 0)
    mesh = b.build()
    total_arc = b._s[-1]
    buf = rasterize(mesh, size)
    cov = buf['cov']
    idx = np.nonzero(cov)
    kind = buf['kind'][idx]
    group = buf['group'][idx]
    pos = buf['pos'][idx].astype(np.float64)
    pos[:, 0] = np.abs(pos[:, 0])
    nrm = buf['nrm'][idx].astype(np.float64)
    nrm /= np.maximum(np.linalg.norm(nrm, axis=1, keepdims=True), 1e-6)
    pa = buf['pa'][idx].astype(np.float64)
    n = len(kind)
    pal = {k: (col(v) if isinstance(v, tuple) else v) for k, v in P['palette'].items()}
    seed = P.get('seed', 1)
    rgb = np.zeros((n, 3))
    emis = np.zeros(n)
    light_k = np.ones(n)       # how much of the baked light/AO a texel takes
    nz = nrm[:, 2]
    brush = fbm(pos, 1.3, 4, seed)              # broad painterly value variation
    brush2 = fbm(pos, 4.5, 3, seed + 50)        # finer dabs
    hide_kinds = [KIND['body'], KIND['jaw'], KIND['leg'], KIND['arm'], KIND['club']]

    # ---- hide: body, jaw, legs, wing arms ------------------------------------------------------
    m = np.isin(kind, hide_kinds)
    if m.any():
        k = kind[m]
        a = pa[m, PA_AROUND].copy()
        q, th, t, ext = pa[m, PA_Q], pa[m, PA_THETA], pa[m, PA_AUX], pa[m, PA_EXT]
        is_body = k == KIND['body']
        is_jaw = k == KIND['jaw']
        is_leg = k == KIND['leg']
        is_arm = k == KIND['arm']
        # limbs have no anatomical belly side: derive "around" from the surface normal
        nb = 0.5 + 0.5 * nz[m]
        a = np.where(is_leg, 0.25 + 0.6 * nb, a)
        a = np.where(is_arm, 0.55 + 0.4 * nb, a)
        a = np.where(is_jaw, 0.05 + 0.5 * sm(0.0, 0.75, a), a)
        aw = a + 0.05 * (brush[m] - 0.5) + 0.02 * (brush2[m] - 0.5)
        c = mix(pal['belly'], pal['flank'], sm(0.17, 0.33, aw))
        c = mix(c, pal['mid'], sm(0.36, 0.60, aw))
        c = mix(c, pal['back'], sm(0.64, 0.94, aw))
        # class markings
        pat = pal.get('pattern')
        if pat == 'stripes':
            wob = fbm(pos[m], 0.9, 3, seed + 7)
            s_ = np.sin(q * 1.55 + 5.0 * wob + a * 2.5)
            stripe = sm(0.35, 0.75, s_) * sm(0.42, 0.78, aw) * (1 - 0.6 * is_arm)
            c = mix(c, pal['accent'], stripe * 0.72)
            # a pale flank flash under the stripes
            c = mix(c, pal['flank'] * 1.12, sm(0.3, 0.7, -s_) * sm(0.30, 0.42, aw) * (1 - sm(0.5, 0.62, aw)) * 0.5)
        elif pat == 'dapple':
            d1 = fbm(pos[m], 2.2, 3, seed + 7)
            spot = sm(0.56, 0.66, d1) * sm(0.34, 0.5, aw) * (1 - sm(0.82, 0.95, aw))
            c = mix(c, pal['accent'], spot * 0.6)
            bar = sm(0.5, 0.8, np.sin(q * 2.4 + 3 * fbm(pos[m], 0.8, 2, seed + 9))) * sm(0.7, 0.9, aw)
            c = mix(c, pal['back'] * 0.55, bar * 0.5)
        elif pat == 'blotch':
            d1 = fbm(pos[m], 1.1, 4, seed + 7)
            c = mix(c, pal['accent'], sm(0.5, 0.68, d1) * sm(0.38, 0.6, aw) * 0.6)
        elif pat == 'smoke':
            d1 = fbm(pos[m] * np.array([1.0, 0.45, 1.0]), 1.6, 4, seed + 7)
            c = mix(c, pal['accent'], sm(0.42, 0.7, d1) * sm(0.3, 0.55, aw) * 0.55)
        # scales (fade out on the belly, the snout and the wing arms)
        fr = np.where(is_body, P.get('scale_freq', 3.6), np.where(is_leg, 2.4, 2.0))
        d, rnd, shadow = scales(q, th, fr, seed)
        sc_k = sm(0.20, 0.34, a) * np.where(is_body, 1 - 0.6 * sm(12.0, 14.5, t), 0.8) * np.where(is_arm, 0.5, 1.0)
        tone = 1 + (rnd - 0.5) * 0.22 * sc_k
        rim = sm(0.62, 0.9, d) * (1 - sm(0.93, 1.0, d))
        c = c * tone[:, None]
        c = mix(c, c * 1.28 + 0.03, rim * sc_k * 0.55)
        c = c * (1 - 0.42 * shadow * sc_k)[:, None]
        c = c * (1 - 0.14 * sm(0.0, 0.35, 1 - d) * sc_k)[:, None]
        # painted sheen along the upper flank and a paler cheek / brow on the head
        sheen = np.exp(-((a - 0.74) / 0.06) ** 2) * (0.55 + 0.9 * (brush[m] - 0.4)) * is_body
        c = c + (pal['flank'] * 0.5 + 0.08)[None] * np.clip(sheen, 0, 1)[:, None] * 0.32
        on_head = is_body * sm(11.6, 12.2, t)
        c = mix(c, mix(pal['flank'], pal['belly'], 0.35), on_head * np.exp(-((a - 0.36) / 0.1) ** 2) * 0.55)
        c = mix(c, pal['accent'], on_head * sm(0.84, 0.97, a) * sm(13.3, 14.2, t) * 0.3)
        # ventral plates
        bel = (1 - sm(0.19, 0.25, a)) * (is_body | is_jaw)
        fb = np.mod(q * 2.3, 1.0)
        plate = 0.84 + 0.2 * sm(0.0, 0.3, fb) - 0.1 * sm(0.75, 1.0, fb)
        crease = 1 - 0.5 * (1 - sm(0.0, 0.07, fb))
        c = c * (1 + bel * (plate * crease - 1))[:, None]
        edge = np.exp(-((a - 0.225) / 0.022) ** 2) * (is_body | is_jaw)
        c = c * (1 - 0.3 * edge)[:, None]
        # dorsal stripe
        c = mix(c, pal['accent'], sm(0.93, 0.99, a) * 0.5 * is_body)
        # extremities
        c = mix(c, pal['accent'], np.clip(ext, 0, 1) * 0.62)
        # mouth interior: palate under the snout and the top of the jaw
        mouth_col = col(pal.get('mouth', (0.36, 0.10, 0.20)))
        pal_m = is_body & (t > 13.55) & (pa[m, PA_AROUND] < 0.085)
        jaw_top = is_jaw & (pa[m, PA_AROUND] > 0.86)
        lip = (is_body & (t > 13.4) & (pa[m, PA_AROUND] < 0.16) & ~pal_m) | (is_jaw & (pa[m, PA_AROUND] > 0.72) & ~jaw_top)
        c = np.where(lip[:, None], c * 0.6, c)
        c = np.where((pal_m | jaw_top)[:, None], mouth_col[None] * (0.8 + 0.4 * brush[m][:, None]), c)
        # eye socket shadow and nostril
        eye_p = b.st.surface(P['eye']['t'], P['eye']['a'])
        de = np.linalg.norm(pos[m] - eye_p, axis=1) / max(P['eye']['rx'], 0.08)
        c = c * (1 - 0.55 * np.exp(-(de / 1.5) ** 2) * is_body)[:, None]
        nos_p = b.st.surface(15.45, 0.72)
        dn = np.linalg.norm(pos[m] - nos_p, axis=1)
        c = c * (1 - 0.75 * np.exp(-(dn / 0.045) ** 2) * is_body)[:, None]
        # rune grooves + emissive glyphs along the neck / flank band and the wing arms
        em = np.zeros(m.sum())
        ra = P.get('rune_a', 0.565)
        arc = pa[m, PA_ALONG] * total_arc
        band_y = (pa[m, PA_AROUND] - (ra - 0.05)) / 0.10
        in_band = is_body & (band_y > 0) & (band_y < 1)
        g = glyphs(arc / 0.3, np.clip(band_y, 0, 1), seed + 3) * in_band
        line = (1 - sm(0.03, 0.09, np.abs(band_y - 0.5))) * in_band * 0.0
        tmask = np.zeros(m.sum())
        for b0, b1 in P.get('rune_bands', [(5.3, 7.2), (8.3, 10.9)]):
            tmask = np.maximum(tmask, sm(b0, b0 + 0.25, t) * (1 - sm(b1 - 0.25, b1, t)))
        em = np.maximum(em, np.maximum(g, line) * tmask)
        # wing arm: chevrons marching toward the wing tip
        alen = pa[m, PA_ALONG] * np.maximum(t, 0.1)
        xa = alen / 0.34
        ya = np.abs(np.mod(pa[m, PA_AROUND] + 0.25, 1.0) - 0.5) * 2   # 0 on the top line of the bone
        dx = np.abs(np.mod(xa, 1.0) - 0.5)
        dia = dx * 1.0 + ya * 2.6                                   # small diamonds in a row
        ga = (1 - sm(0.2, 0.3, dia)) * is_arm
        ga = np.maximum(ga, (1 - sm(0.035, 0.07, ya)) * is_arm * 0.85)   # thin joining line
        ga = ga * (1 - sm(0.82, 0.97, pa[m, PA_ALONG])) * sm(0.02, 0.08, pa[m, PA_ALONG])
        em = np.maximum(em, ga)
        c = c * (1 - 0.6 * em)[:, None] + 0.18 * em[:, None] * col((1.0, 0.97, 0.9))[None]
        c = np.where(is_arm[:, None], c * 0.86, c)
        rgb[m] = c
        emis[m] = em

    # ---- membranes and fins ---------------------------------------------------------------------
    m = np.isin(kind, [KIND['membrane'], KIND['fin']])
    if m.any():
        is_fin = kind[m] == KIND['fin']
        t = pa[m, PA_ALONG]
        u = pa[m, PA_AROUND]
        aux = pa[m, PA_AUX]
        # distance to the nearest rib, 0..0.5
        ribd = np.where(aux >= 0.5, np.minimum(u, 1 - u), np.where(aux < -0.5, 0.5, 1 - u))
        ribd = np.where(is_fin, np.minimum(aux, 1 - aux), ribd)
        tt = np.where(is_fin, u, t)  # root -> free edge
        w3 = fbm(pos[m], 1.6, 3, seed + 21)
        lightk = sm(0.02, 0.32, ribd) * (0.25 + 0.75 * sm(0.05, 0.6, tt))
        c = mix(pal['memb_dark'], pal['memb_light'], lightk * (0.75 + 0.5 * (w3 - 0.5)))
        warm = sm(0.12, 0.4, ribd) * np.sin(PI * np.clip(tt, 0, 1)) ** 1.5
        c = mix(c, pal['memb_warm'], warm * 0.34)
        # stretch streaks running from the bones to the trailing edge
        streak = fbm(np.stack([u * 26.0, tt * 2.0, aux * 3.1], axis=1), 1.0, 3, seed + 23)
        c = c * (0.9 + 0.2 * streak)[:, None]
        # veins branching off the ribs
        vn = np.abs(fbm(np.stack([u * 7.0, tt * 5.0, aux * 5.7], axis=1), 1.0, 3, seed + 25) - 0.5)
        vein = (1 - sm(0.012, 0.045, vn)) * sm(0.02, 0.2, ribd) * (1 - sm(0.75, 1.0, tt))
        c = c * (1 - 0.28 * vein)[:, None]
        # darker rim along the free edge and next to the ribs
        c = mix(c, pal['memb_dark'] * 0.8, sm(0.86, 1.0, tt) * 0.65)
        c = c * (1 - 0.35 * np.exp(-ribd / 0.035))[:, None]
        if pal.get('pattern') == 'smoke' or pal.get('memb_iri'):
            ph = fbm(pos[m], 0.7, 3, seed + 31) * 1.6 + tt * 0.6
            c = c + iridescence(ph) * (0.16 * sm(0.55, 1.0, tt) + 0.05)[:, None]
        if pal.get('memb_spots'):
            sp = fbm(pos[m], 2.6, 2, seed + 33)
            c = mix(c, pal['memb_dark'] * 0.7, sm(0.6, 0.7, sp) * sm(0.45, 0.9, tt) * 0.6)
        rgb[m] = c
        emis[m] = np.clip(0.04 + 0.55 * np.exp(-ribd / 0.045) * (0.3 + 0.7 * tt) + 0.20 * tt ** 3
                          + 0.22 * vein, 0, 1)
        light_k[m] = 0.55

    # ---- horns, spikes, claws, teeth, plates ------------------------------------------------------
    m = kind == KIND['horn']
    if m.any():
        al = pa[m, PA_ALONG]
        c = mix(pal['horn_dark'], pal['horn'], sm(0.05, 0.75, al + 0.1 * (brush2[m] - 0.5)))
        ring = 0.5 + 0.5 * np.sin(al * 46 + 2 * brush[m])
        c = c * (0.88 + 0.16 * ring * (1 - al))[:, None]
        c = c * (0.8 + 0.25 * (0.5 + 0.5 * nz[m]))[:, None]
        rgb[m] = c
        light_k[m] = 0.45
    m = kind == KIND['spike']
    if m.any():
        al = pa[m, PA_ALONG]
        c = mix(pal['spike'], pal.get('spike_tip', pal['horn']), sm(0.2, 0.95, al) * 0.85)
        c = c * (0.9 + 0.2 * brush2[m])[:, None]
        rgb[m] = c
        light_k[m] = 0.6
    m = kind == KIND['claw']
    if m.any():
        al = pa[m, PA_ALONG]
        rgb[m] = mix(pal['horn_dark'] * 0.8, pal['horn'], sm(0.1, 0.9, al))
    m = kind == KIND['tooth']
    if m.any():
        al = pa[m, PA_ALONG]
        rgb[m] = mix(col((0.62, 0.52, 0.42)), col((0.98, 0.95, 0.86)), sm(0.0, 0.6, al))
        light_k[m] = 0.4
    m = kind == KIND['plate']
    if m.any():
        al = pa[m, PA_ALONG]  # 1 at the crown, ~0.3 at the rim
        pc = col(pal.get('plate', pal['back']))
        pe = col(pal.get('plate_edge', pal['horn']))
        c = mix(pc * 0.7, pc * 1.15, sm(0.3, 1.0, al))
        c = mix(c, pe, (1 - sm(0.32, 0.42, al)) * 0.75)       # worn bright rim
        c = c * (0.86 + 0.28 * brush2[m])[:, None]
        scratch = np.abs(fbm(pos[m] * np.array([3.0, 0.6, 3.0]), 5.0, 2, seed + 41) - 0.5)
        c = c * (1 + 0.22 * (1 - sm(0.0, 0.03, scratch)))[:, None]
        rgb[m] = c

    # ---- eye ---------------------------------------------------------------------------------------
    m = kind == KIND['eye']
    if m.any():
        py_, px_ = idx[0][m], idx[1][m]
        ex, ey, ew, eh = 320, 928, 64, 64
        x = (px_ + 0.5 - ex) / ew * 2 - 1
        y = (py_ + 0.5 - ey) / eh * 2 - 1
        r = np.hypot(x, y)
        pupil = (1 - sm(0.10, 0.2, np.abs(x))) * (1 - sm(0.5, 0.78, np.abs(y)))
        iris = mix(col(pal['eye']) * 0.95, col(pal['eye']) * 0.55, sm(0.2, 0.95, r))
        c = iris * (1 - 0.92 * pupil)[:, None]
        c = c * (1 - 0.8 * sm(0.8, 1.0, r))[:, None]
        rgb[m] = c
        emis[m] = np.clip((1 - pupil) * (1 - sm(0.7, 0.98, r)), 0, 1)
        light_k[m] = 0.0

    # ---- rider, saddle, cape ------------------------------------------------------------------------
    # The rider wears the dragon's own colours: leather per class, armour in the horn tones, gilt
    # trim, and dark cloth that the team colour lights up through the emissive mask.
    leather = col(pal.get('rider', (0.42, 0.33, 0.25)))
    armor = col(pal.get('rider_armor', mix(pal['horn_dark'], pal['horn'], 0.62)))
    trim = col(pal.get('rider_trim', (0.80, 0.70, 0.45)))
    dark = col(pal.get('rider_dark', (0.13, 0.115, 0.125)))
    cloth = col(pal.get('cloak', (0.15, 0.14, 0.16)))
    m = kind == KIND['rider']
    if m.any():
        t, a = pa[m, PA_AUX], pa[m, PA_AROUND]      # station (see build_rider); 0 front .. 1 back
        b1, b2 = brush[m], brush2[m]
        # lamellar cuirass: rows of leather plates with a lit rim, like the dragon's scales
        c = leather[None] * (0.74 + 0.3 * sm(0.0, 4.0, t) + 0.3 * (b2 - 0.5))[:, None]
        on_torso = sm(1.25, 1.4, t) * (1 - sm(3.75, 3.95, t))
        fb = np.mod(t * 2.6 + 0.12 * np.sin(a * 9.0), 1.0)
        plate = 0.84 + 0.24 * sm(0.0, 0.4, fb) - 0.1 * sm(0.8, 1.0, fb)
        seam = 1 - 0.5 * (1 - sm(0.0, 0.09, fb))
        c = c * (1 + on_torso * (plate * seam - 1))[:, None]
        c = mix(c, c * 1.3 + 0.035, sm(0.12, 0.2, fb) * (1 - sm(0.24, 0.34, fb)) * on_torso * 0.55)
        # the rows are split down the sides and down the front
        split = np.maximum(1 - sm(0.0, 0.035, np.abs(a - 0.5)), 1 - sm(0.0, 0.02, a))
        c = c * (1 - 0.45 * split * on_torso)[:, None]
        # belt with gilt edges and a buckle, a dark skirt below it
        belt = sm(0.72, 0.8, t) * (1 - sm(1.2, 1.28, t))
        c = mix(c, dark * 1.5, belt)
        edges = np.maximum(1 - sm(0.03, 0.06, np.abs(t - 0.78)), 1 - sm(0.03, 0.06, np.abs(t - 1.22)))
        c = mix(c, trim, belt * edges * 0.85)
        c = mix(c, trim * 1.05, belt * (1 - sm(0.07, 0.1, a)) * sm(0.84, 0.88, t) * (1 - sm(1.12, 1.16, t)))
        c = mix(c, dark[None] * (0.9 + 0.5 * b2)[:, None], (1 - sm(0.6, 0.74, t)) * 0.8)
        # shoulder yoke and neck: dark cloth under the cowl
        c = mix(c, dark[None] * (0.9 + 0.5 * b1)[:, None], sm(3.8, 4.1, t) * (1 - sm(5.55, 5.7, t)))
        # helm: burnished plate, darker toward the rim, a lit brow and comb, a gilt rim and point
        helm = sm(5.6, 5.72, t)
        hc = mix(armor * 0.5, armor * 1.08, sm(5.7, 8.3, t + 0.5 * (b1 - 0.5)))
        hc = hc * (0.88 + 0.26 * b2)[:, None]
        hc = mix(hc, hc * 1.35 + 0.05, np.exp(-((t - 7.08) / 0.09) ** 2) * (1 - sm(0.55, 0.75, a)) * 0.7)
        hc = mix(hc, hc * 1.3 + 0.04, (1 - sm(0.0, 0.05, np.minimum(a, 1 - a))) * sm(7.2, 7.6, t) * 0.6)
        cheek = np.exp(-((a - 0.5) / 0.05) ** 2) * sm(5.9, 6.2, t) * (1 - sm(6.9, 7.1, t))
        hc = hc * (1 - 0.35 * cheek)[:, None]
        hc = mix(hc, trim, np.maximum(1 - sm(0.06, 0.11, np.abs(t - 5.86)), sm(8.45, 8.7, t)) * 0.9)
        # visor: a slit under the brow and a notch down to the rim. The slit glows (Runes slot).
        slit = (1 - sm(0.1, 0.17, np.abs(t - 6.62))) * (1 - sm(0.36, 0.43, a))
        gap = (1 - sm(0.035, 0.07, a)) * sm(5.95, 6.05, t) * (1 - sm(6.5, 6.6, t))
        hc = mix(hc, col((0.035, 0.03, 0.045)), np.maximum(slit, gap))
        c = mix(c, hc, helm)
        rgb[m] = c
        emis[m] = np.clip((1 - sm(0.03, 0.11, np.abs(t - 6.62))) * (1 - sm(0.28, 0.4, a)) * 0.9, 0, 1)
        light_k[m] = 0.75
    m = kind == KIND['rider_limb']
    if m.any():
        al, b2 = pa[m, PA_ALONG], brush2[m]
        is_arm = pa[m, PA_AUX] < 1.5
        # arm: sleeve, bracer, glove.  leg: breeches, knee plate, boot with a gilt cuff
        p0, p1 = np.where(is_arm, 0.42, 0.3), np.where(is_arm, 0.7, 0.47)
        c = mix(leather * 0.8, dark * 1.3, np.where(is_arm, 0.55, 0.25)) * (0.8 + 0.4 * b2)[:, None]
        on_plate = sm(p0 - 0.02, p0 + 0.02, al) * (1 - sm(p1 - 0.02, p1 + 0.02, al))
        pc = mix(armor * 0.6, armor * 1.1, sm(p0, p1, al)) * (0.88 + 0.26 * b2)[:, None]
        rim = np.maximum(1 - sm(0.0, 0.03, np.abs(al - p0 - 0.035)), 1 - sm(0.0, 0.03, np.abs(al - p1 + 0.035)))
        pc = mix(pc, pc * 1.3 + 0.05, rim * 0.7)
        c = mix(c, pc, on_plate)
        c = mix(c, dark[None] * (0.85 + 0.5 * b2)[:, None], sm(p1 + 0.01, p1 + 0.05, al))
        c = mix(c, trim * 0.9, (1 - sm(0.0, 0.03, np.abs(al - p1 - 0.07))) * ~is_arm * 0.8)
        rgb[m] = c
        light_k[m] = 0.75
    m = kind == KIND['rider_gear']
    if m.any():
        al, b2 = pa[m, PA_ALONG], brush2[m]
        is_plate = pa[m, PA_AUX] < 1.5
        # shoulder plate: dark at the base, pale at the point, a worn gilt rim (like the scutes)
        c = mix(armor * 0.58, armor * 1.12, sm(0.05, 0.95, al))
        c = mix(c, trim, (1 - sm(0.1, 0.18, al)) * 0.85)
        scratch = np.abs(fbm(pos[m] * np.array([3.0, 0.6, 3.0]), 5.0, 2, seed + 43) - 0.5)
        c = c * (0.86 + 0.28 * b2)[:, None] * (1 + 0.2 * (1 - sm(0.0, 0.03, scratch)))[:, None]
        # grip: dark iron uprights, gilt corners, a leather wrap where the hands are
        g = dark[None] * 1.2 * (0.8 + 0.5 * b2)[:, None]
        g = mix(g, leather * 0.9, sm(0.37, 0.4, al) * (1 - sm(0.6, 0.63, al)) * 0.9)
        corners = np.maximum(1 - sm(0.0, 0.025, np.abs(al - 0.34)), 1 - sm(0.0, 0.025, np.abs(al - 0.66)))
        g = mix(g, trim, corners * 0.8)
        rgb[m] = np.where(is_plate[:, None], c, g)
        light_k[m] = 0.7
    m = kind == KIND['rider_cloth']
    if m.any():
        al, ar = pa[m, PA_ALONG], pa[m, PA_AROUND]
        is_cowl = pa[m, PA_AUX] < 1.5
        # cowl: folds falling from the collar, a gilt hem.  crest: streaks running to the tip
        fold = 0.5 + 0.5 * np.sin(ar * 2 * PI * 6 + 2.5 * brush[m] + al * 2)
        streak = 0.5 + 0.5 * np.sin(ar * 21 + al * 5 + 3 * brush2[m])
        f = np.where(is_cowl, fold, streak)
        c = cloth[None] * (0.7 + 0.5 * f)[:, None]
        hem = np.where(is_cowl, sm(0.84, 0.9, al), 0.0)
        collar = np.where(is_cowl, 1 - sm(0.04, 0.12, al), 0.0)
        c = mix(c, trim * 0.85, hem * 0.9)
        c = c * (1 - 0.5 * collar)[:, None]
        rgb[m] = c
        emis[m] = np.clip(np.where(is_cowl, (0.5 + 0.5 * f) * (1 - hem) * (1 - 0.6 * collar),
                                   0.45 + 0.55 * al * (0.6 + 0.4 * f)), 0, 1)
        light_k[m] = 0.5
    m = kind == KIND['saddle']
    if m.any():
        c = np.tile(col(pal.get('saddle', (0.36, 0.24, 0.16))), (m.sum(), 1))
        c = c * (0.75 + 0.5 * brush2[m])[:, None]
        trim_k = 1 - sm(0.03, 0.06, np.abs(pa[m, PA_AROUND] - 0.42))
        c = mix(c, trim, trim_k * 0.9)
        rgb[m] = c
    m = kind == KIND['cloak']
    if m.any():
        al, ar = pa[m, PA_ALONG], pa[m, PA_AROUND]
        edge = np.minimum(ar, 1 - ar)
        fold = 0.5 + 0.5 * np.sin(ar * 17 + al * 3 + 2.5 * brush[m])
        c = cloth[None] * (0.62 + 0.6 * fold)[:, None]
        # a gilt hem round the sides and both tails, a dark line inside it, two gilt chevrons
        hem = np.clip(sm(0.925, 0.96, al) + (1 - sm(0.035, 0.065, edge)), 0, 1)
        inner = np.clip(sm(0.87, 0.9, al) + (1 - sm(0.085, 0.11, edge)), 0, 1) * (1 - hem)
        s_ = al + 0.22 * np.abs(ar - 0.5)
        chev = np.maximum(1 - sm(0.0, 0.02, np.abs(s_ - 0.6) - 0.012),
                          1 - sm(0.0, 0.02, np.abs(s_ - 0.68) - 0.012)) * (1 - hem) * (1 - inner)
        c = mix(c, trim * 0.85, hem * 0.9)
        c = c * (1 - 0.45 * inner)[:, None]
        c = mix(c, trim * 0.7, chev * 0.75)
        rgb[m] = c
        emis[m] = np.clip((0.4 + 0.6 * fold) * (1 - hem) * (1 - 0.75 * inner) * (1 - 0.85 * chev), 0, 1)
        light_k[m] = 0.5

    # ---- baked light: sky from above, cool bounce from below, AO --------------------------------
    ao = sphere_ao(pos.astype(np.float32), nrm.astype(np.float32), group, mesh, P.get('ao', 1.0))
    top = 0.5 + 0.5 * nz
    lum = 0.66 + 0.42 * top ** 1.2
    tint = mix(col((0.80, 0.86, 1.10)), col((1.10, 1.03, 0.90)), top)
    lit = rgb * lum[:, None] * tint
    lit = lit * (ao[:, None] ** 1.0) * mix(col((0.78, 0.74, 1.0)), col((1, 1, 1)), ao)  # AO goes violet
    lit = lit * (0.93 + 0.14 * brush[:, None]) * (0.96 + 0.08 * brush2[:, None])
    rgb = rgb * (1 - light_k[:, None]) + lit * light_k[:, None]
    # obsidian sheen: iridescent edge light on upward-facing scale rims and ridges
    if pal.get('iri'):
        mh = np.isin(kind, hide_kinds + [KIND['spike'], KIND['horn'], KIND['plate']])
        ph = fbm(pos[mh], 0.55, 3, seed + 61) * 1.8 + pos[mh][:, 1] * 0.11 + nz[mh] * 0.35
        d, rnd, shadow = scales(pa[mh, PA_Q], pa[mh, PA_THETA], P.get('scale_freq', 3.6), seed)
        rimk = sm(0.6, 0.9, d) * (1 - sm(0.94, 1.0, d))
        isb = np.isin(kind[mh], hide_kinds)
        k = np.where(isb, rimk * 0.55 + 0.1, 0.25) * sm(-0.2, 0.7, nz[mh]) * pal['iri']
        k = k * (0.4 + 0.6 * sm(0.35, 0.7, fbm(pos[mh], 1.1, 2, seed + 63)))
        rgb[mh] = rgb[mh] + iridescence(ph) * k[:, None]
    rgb = np.clip(rgb, 0, 1)

    base = np.zeros((size, size, 3), np.float32)
    base[idx] = rgb
    base = dilate(base, cov, 12)
    # anything still empty gets the mean hide colour so mips never pull in black
    still = np.ones((size, size), bool)
    still[idx] = False
    filled = dilate(np.zeros((size, size, 1), np.float32) + cov[..., None], cov, 12)[..., 0] > 0
    base[~filled] = rgb[np.isin(kind, hide_kinds)].mean(axis=0)
    em_img = np.zeros((size, size, 1), np.float32)
    em_img[idx] = emis[:, None]
    em_img = dilate(em_img, cov, 4)
    log('painted %s: %d texels covered (%.0f%%)' % (P['name'], n, 100.0 * n / size / size))
    return (base * 255 + 0.5).astype(np.uint8), (np.clip(em_img[..., 0], 0, 1) * 255 + 0.5).astype(np.uint8), buf
