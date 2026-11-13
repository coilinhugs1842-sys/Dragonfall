"""Pure-numpy geometry helpers for the procedural dragons (no bpy, no Pillow).

Coordinates are Blender's: X = the dragon's left, -Y = forward, Z = up. The glTF exporter turns
that into +Z forward / +Y up, which is the runtime convention (docs/ASSET_PIPELINE.md).
Use P(x, up, fwd) to write points in "design" order.
"""
import numpy as np

PI = np.pi
LEFT = np.array([1.0, 0.0, 0.0])
FWD = np.array([0.0, -1.0, 0.0])
UP = np.array([0.0, 0.0, 1.0])

MAT_HIDE, MAT_MEMBRANE, MAT_RUNES = 0, 1, 2
MAT_NAMES = ['Hide', 'Membrane', 'Runes']

ATLAS = 1024
# Atlas rectangles in pixels, top-left origin: x, y, w, h.
RECTS = {
    'body': (0, 0, 1024, 272),
    'tail': (0, 272, 600, 120),
    'jaw': (600, 272, 200, 120),
    'horn': (800, 272, 112, 60),
    'spike': (912, 272, 112, 60),
    'plate': (800, 332, 112, 60),
    'claw': (912, 332, 56, 60),
    'tooth': (968, 332, 56, 60),
    'membrane': (0, 392, 560, 440),
    'arm': (560, 392, 464, 200),
    'leg_f': (560, 592, 232, 120),
    'leg_h': (792, 592, 232, 120),
    'fin': (560, 712, 264, 120),
    'fin2': (824, 712, 200, 120),
    'rider': (0, 832, 160, 192),
    'cloak': (160, 832, 160, 192),
    'saddle': (320, 832, 160, 96),
    'eye': (320, 928, 64, 64),
    'mouth': (384, 928, 96, 96),
    'extra': (480, 832, 272, 192),
    'extra2': (752, 832, 272, 192),
    # The rider's limbs, armour and cloth: the top half of 'extra'. None of them may touch the
    # 'cloak' rect: the runtime makes every Membrane vertex inside it flutter (dragon-assets.ts).
    'rider_arm': (480, 832, 136, 48),
    'rider_leg': (616, 832, 136, 48),
    'rider_mantle': (480, 880, 136, 56),
    'rider_pauldron': (616, 880, 68, 56),
    'rider_grip': (684, 880, 68, 28),
    'rider_crest': (684, 908, 68, 28),
}

# Paint kinds (per vertex), used by the texture painter. Append only: the index is the key.
KINDS = ['body', 'jaw', 'leg', 'arm', 'membrane', 'horn', 'spike', 'plate', 'claw', 'tooth', 'eye',
         'fin', 'rider', 'cloak', 'saddle', 'mouth', 'club', 'rider_limb', 'rider_gear',
         'rider_cloth']
KIND = {k: i for i, k in enumerate(KINDS)}

# Paint attribute columns.
PA_ALONG, PA_AROUND, PA_Q, PA_THETA, PA_EXT, PA_AUX = range(6)
NPA = 6


def P(x, up, fwd):
    return np.array([x, -fwd, up], dtype=float)


def norm(v):
    v = np.asarray(v, float)
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(n, 1e-12)


def smoothstep(a, b, x):
    t = np.clip((np.asarray(x, float) - a) / (b - a + 1e-12), 0, 1)
    return t * t * (3 - 2 * t)


def lerp(a, b, t):
    return a + (b - a) * t


def cr(vals, t):
    """Catmull-Rom through `vals` at uniform knots 0..n-1, evaluated at t (array)."""
    vals = np.asarray(vals, float)
    n = len(vals)
    t = np.clip(np.asarray(t, float), 0, n - 1)
    i = np.minimum(t.astype(int), n - 2)
    u = t - i

    def g(j):
        return vals[np.clip(j, 0, n - 1)]
    p0, p1, p2, p3 = g(i - 1), g(i), g(i + 1), g(i + 2)
    if vals.ndim > 1:
        u = u[..., None]
    return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u
                  + (-p0 + 3 * p1 - 3 * p2 + p3) * u ** 3)


def rot_axis(axis, ang):
    """3x3 rotation matrix about `axis` by `ang` radians."""
    a = norm(axis)
    c, s = np.cos(ang), np.sin(ang)
    x, y, z = a
    return np.array([[c + x * x * (1 - c), x * y * (1 - c) - z * s, x * z * (1 - c) + y * s],
                     [y * x * (1 - c) + z * s, c + y * y * (1 - c), y * z * (1 - c) - x * s],
                     [z * x * (1 - c) - y * s, z * y * (1 - c) + x * s, c + z * z * (1 - c)]])


def rect_uv(rect, lu, lv, pad=3):
    """Local (lu, lv) in [0,1] -> atlas UV (Blender convention, v up). lv=0 is the top row."""
    x, y, w, h = RECTS[rect] if isinstance(rect, str) else rect
    px = x + pad + np.asarray(lu, float) * (w - 2 * pad)
    py = y + pad + np.asarray(lv, float) * (h - 2 * pad)
    return np.stack([px / ATLAS, 1.0 - py / ATLAS], axis=-1)


def sub_rect(rect, i, n, axis=1):
    """Row i of n (axis=1) or column i of n (axis=0) of a named rect."""
    x, y, w, h = RECTS[rect] if isinstance(rect, str) else rect
    if axis == 1:
        return (x, y + h * i / n, w, h / n)
    return (x + w * i / n, y, w / n, h)


class Part:
    """A chunk of mesh with everything the exporter and the painter need."""

    def __init__(self, kind, verts, tris, uv, weights, mat=MAT_HIDE, pa=None, crease=60.0,
                 fmat=None, name=''):
        self.kind = KIND[kind]
        self.name = name or kind
        self.verts = np.asarray(verts, float).reshape(-1, 3)
        self.tris = np.asarray(tris, int).reshape(-1, 3)
        self.uv = np.asarray(uv, float).reshape(-1, 2)
        n = len(self.verts)
        w = np.asarray(weights, float)
        if w.ndim == 1:
            w = np.tile(w, (n, 1))
        self.w = w
        self.fmat = np.full(len(self.tris), mat, int) if fmat is None else np.asarray(fmat, int)
        self.pa = np.zeros((n, NPA)) if pa is None else np.asarray(pa, float)
        self.crease = crease
        self.painted = True  # False on mirrored copies: the painter skips them
        self.group = self.name   # parts in one group do not occlude each other (painted AO)
        self.spheres = np.zeros((0, 4))  # x, y, z, r occluders for the painted AO
        assert len(self.uv) == n and len(self.w) == n and len(self.pa) == n, self.name

    def mirrored(self, swap):
        """Copy reflected across X. `swap` is the bone index permutation (L <-> R)."""
        p = Part.__new__(Part)
        p.kind, p.name, p.crease = self.kind, self.name + '_R', self.crease
        p.verts = self.verts * np.array([-1.0, 1.0, 1.0])
        p.tris = self.tris[:, ::-1].copy()
        p.uv, p.pa, p.fmat = self.uv, self.pa, self.fmat
        p.w = self.w[:, swap]
        p.painted = False
        p.group = self.group
        p.spheres = self.spheres * np.array([-1.0, 1.0, 1.0, 1.0])
        return p


def clean_tris(verts, tris, eps=1e-10):
    tris = np.asarray(tris, int).reshape(-1, 3)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    area = np.linalg.norm(np.cross(b - a, c - a), axis=1)
    return tris[area > eps]


def orient(verts, tris, centers=None, direction=None):
    """Flip all triangles if they face inward (toward `centers`) or against `direction`."""
    tris = np.asarray(tris, int).reshape(-1, 3)
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)
    if direction is not None:
        s = (fn @ np.asarray(direction, float)).sum()
    else:
        fc = (a + b + c) / 3
        s = ((fc - centers) * fn).sum()
    return tris[:, ::-1].copy() if s < 0 else tris


def grid_tris(nr, nc, wrap=False, flip=False):
    """Triangles for an nr x nc vertex grid (row-major). wrap closes the columns."""
    out = []
    cols = nc if wrap else nc - 1
    for i in range(nr - 1):
        for j in range(cols):
            a = i * nc + j
            b = i * nc + (j + 1) % nc
            c = (i + 1) * nc + j
            d = (i + 1) * nc + (j + 1) % nc
            if (i + j) % 2 == 0:
                out += [(a, b, d), (a, d, c)]
            else:
                out += [(a, b, c), (b, d, c)]
    t = np.array(out, int).reshape(-1, 3)
    return t[:, ::-1].copy() if flip else t


def frames_along(path, up_hint):
    """Parallel-transported (tangent, normal, binormal) along a polyline."""
    path = np.asarray(path, float)
    n = len(path)
    tan = np.zeros_like(path)
    tan[1:-1] = path[2:] - path[:-2]
    tan[0] = path[1] - path[0]
    tan[-1] = path[-1] - path[-2]
    tan = norm(tan)
    nrm = np.zeros_like(path)
    u = np.asarray(up_hint, float)
    u = u - tan[0] * (u @ tan[0])
    if np.linalg.norm(u) < 1e-6:
        u = np.cross(tan[0], [1, 0, 0])
    nrm[0] = norm(u)
    for i in range(1, n):
        v = nrm[i - 1] - tan[i] * (nrm[i - 1] @ tan[i])
        nrm[i] = norm(v)
    bin_ = np.cross(tan, nrm)
    return tan, nrm, bin_


def tube(path, radii, sides, up_hint=UP, squash=1.0, tip_start=False, tip_end=True, rect='horn',
         kind='horn', weights=None, mat=MAT_HIDE, crease=60.0, lu_range=(0, 1), lv_range=(0, 1),
         ext=None, name=''):
    """Tube along `path` with per-ring `radii`. A (sides+1)-column grid with a UV seam.

    squash scales the radius along the binormal (flattened limbs). tip_* closes the end with a
    single point. lu runs along the path, lv around it.
    """
    path = np.asarray(path, float)
    n = len(path)
    radii = np.broadcast_to(np.asarray(radii, float), (n,)).copy()
    tan, nrm, bin_ = frames_along(path, up_hint)
    ang = np.linspace(0, 2 * PI, sides + 1)
    ring = (np.cos(ang)[None, :, None] * nrm[:, None, :]
            + squash * np.sin(ang)[None, :, None] * bin_[:, None, :])
    verts = path[:, None, :] + radii[:, None, None] * ring
    if tip_start:
        verts[0] = path[0]
    if tip_end:
        verts[-1] = path[-1]
    seg = np.linalg.norm(np.diff(path, axis=0), axis=1)
    s = np.concatenate([[0], np.cumsum(seg)])
    rm = np.maximum((radii[1:] + radii[:-1]) / 2, 0.04)
    q = np.concatenate([[0], np.cumsum(seg / rm)])
    along = s / max(s[-1], 1e-9)
    lu = lu_range[0] + (lu_range[1] - lu_range[0]) * along
    lv = lv_range[0] + (lv_range[1] - lv_range[0]) * (ang / (2 * PI))
    LU, LV = np.meshgrid(lu, lv, indexing='ij')
    uv = rect_uv(rect, LU, LV).reshape(-1, 2)
    pa = np.zeros((n, sides + 1, NPA))
    pa[..., PA_ALONG] = along[:, None]
    pa[..., PA_AROUND] = (ang / (2 * PI))[None, :]
    pa[..., PA_Q] = q[:, None]
    pa[..., PA_THETA] = ang[None, :]
    pa[..., PA_EXT] = along[:, None] if ext is None else np.asarray(ext, float)[:, None]
    verts = verts.reshape(-1, 3)
    tris = clean_tris(verts, grid_tris(n, sides + 1))
    tris = orient(verts, tris, centers=np.repeat(path, 1, axis=0).mean(axis=0))
    # orient per-triangle against its own ring centre for bent tubes
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fc = (a + b + c) / 3
    ring_idx = tris[:, 0] // (sides + 1)
    ctr = (path[np.minimum(ring_idx, n - 1)] + path[np.minimum(ring_idx + 1, n - 1)]) / 2
    bad = ((fc - ctr) * np.cross(b - a, c - a)).sum(axis=1) < 0
    tris[bad] = tris[bad][:, ::-1]
    if weights is None:
        raise ValueError('tube needs weights')
    w = np.asarray(weights, float)
    if w.ndim == 2 and len(w) == n:
        w = np.repeat(w, sides + 1, axis=0)
    part = Part(kind, verts, tris, uv, w, mat=mat, pa=pa.reshape(-1, NPA), crease=crease, name=name)
    part.spheres = np.concatenate([path, radii[:, None] * 0.9], axis=1)[radii > 0.03]
    return part


def curve_path(base, direction, length, n, bend_axis=None, bend=0.0, bend_pow=1.0):
    """A path leaving `base` along `direction` that bends about `bend_axis` by `bend` radians."""
    d = norm(direction)
    pts = [np.asarray(base, float)]
    step = length / (n - 1)
    for i in range(1, n):
        t = (i - 0.5) / (n - 1)
        dd = d if bend_axis is None else rot_axis(bend_axis, bend * t ** bend_pow) @ d
        pts.append(pts[-1] + dd * step)
    return np.array(pts)


def compute_normals(verts, tris, crease_deg):
    """Per-corner area-weighted normals limited by a crease angle. Returns (ntris*3, 3)."""
    a, b, c = verts[tris[:, 0]], verts[tris[:, 1]], verts[tris[:, 2]]
    fn = np.cross(b - a, c - a)  # length = 2 * area, so sums are area-weighted
    fnu = norm(fn)
    key = np.round(verts * 2e4).astype(np.int64)
    _, weld = np.unique(key, axis=0, return_inverse=True)
    weld = weld.reshape(-1)
    corner_v = weld[tris.reshape(-1)]
    corner_f = np.repeat(np.arange(len(tris)), 3)
    order = np.argsort(corner_v, kind='stable')
    cv, cf = corner_v[order], corner_f[order]
    out = np.zeros((len(tris) * 3, 3))
    cosc = np.cos(np.radians(crease_deg))
    starts = np.flatnonzero(np.concatenate([[True], cv[1:] != cv[:-1], [True]]))
    for gi in range(len(starts) - 1):
        s, e = starts[gi], starts[gi + 1]
        faces = cf[s:e]
        if crease_deg >= 179:
            nsum = fn[faces].sum(axis=0)
            out[order[s:e]] = nsum
        else:
            dots = fnu[faces] @ fnu[faces].T
            m = dots >= cosc
            out[order[s:e]] = m @ fn[faces]
    return norm(out)


class Mesh:
    """Final arrays for one LOD."""

    def __init__(self, parts, nbones):
        vs, ts, uvs, ws, pas, kinds, fmats, nrms, painted = [], [], [], [], [], [], [], [], []
        off = 0
        self.groups = sorted(set(p.group for p in parts))
        self.spheres = [(self.groups.index(p.group), p.spheres) for p in parts if len(p.spheres)]
        tri_group = []
        for p in parts:
            if len(p.tris) == 0:
                continue
            tri_group.append(np.full(len(p.tris), self.groups.index(p.group)))
            cn = compute_normals(p.verts, p.tris, p.crease)
            # one vertex per corner, deduplicated below
            idx = p.tris.reshape(-1)
            vs.append(p.verts[idx])
            uvs.append(p.uv[idx])
            ws.append(p.w[idx])
            pas.append(p.pa[idx])
            nrms.append(cn)
            kinds.append(np.full(len(idx), p.kind))
            painted.append(np.full(len(p.tris), p.painted))
            fmats.append(p.fmat)
            ts.append(np.arange(len(idx)).reshape(-1, 3) + off)
            off += len(idx)
        v = np.concatenate(vs)
        n = np.concatenate(nrms)
        uv = np.concatenate(uvs)
        w = np.concatenate(ws)
        kind = np.concatenate(kinds)
        key = np.concatenate([np.round(v * 2e4), np.round(n * 200), np.round(uv * 8192),
                              np.round(w * 100), kind[:, None]], axis=1).astype(np.int64)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inv = inv.reshape(-1)
        self.verts = v[first]
        self.normals = n[first]
        self.uv = uv[first]
        self.pa = np.concatenate(pas)[first]
        self.kind = kind[first]
        self.tris = inv[np.concatenate(ts)]
        self.fmat = np.concatenate(fmats)
        self.painted = np.concatenate(painted)
        self.tri_group = np.concatenate(tri_group)
        # triangles that collapsed in the dedupe (two corners on one vertex) crash Blender
        t = self.tris
        ok = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
        self.tris, self.fmat, self.painted, self.tri_group = t[ok], self.fmat[ok], self.painted[ok], self.tri_group[ok]
        # skin weights: keep the 4 largest, normalise
        w = w[first]
        if w.shape[1] > 4:
            cut = np.sort(w, axis=1)[:, -4][:, None]
            w = np.where(w >= cut, w, 0)
        w[w < 0.02] = 0
        self.w = w / np.maximum(w.sum(axis=1, keepdims=True), 1e-9)
        assert self.w.shape[1] == nbones

    @property
    def ntris(self):
        return len(self.tris)
