"""Global registration: for each scale, the best translation by FFT
cross-correlation of the scan's dark pixels with the rasterised street network
(north up, no rotation), then a local affine polish. Writes georef.json."""
import json
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter
from scipy.signal import fftconvolve
from scipy.optimize import minimize
from shapely.geometry import shape
from pyproj import Transformer

T = Transformer.from_crs(4326, 26910, always_xy=True)
streets = json.load(open('streets.geojson'))['features']
pts, majpts = [], []
for f in streets:
    if not f['geometry']:
        continue
    g = shape(f['geometry'])
    for part in getattr(g, 'geoms', [g]):
        xy = np.array([T.transform(x, y) for x, y, *_ in part.coords])
        seg = np.diff(xy, axis=0)
        for (x0, y0), (dx, dy) in zip(xy[:-1], seg):
            n = max(1, int(np.hypot(dx, dy) / 10))
            for t in np.linspace(0, 1, n, endpoint=False):
                pts.append((x0 + t * dx, y0 + t * dy))
                if f['properties']['STR_TYPE'] == 'Major Collector':
                    majpts.append((x0 + t * dx, y0 + t * dy))
P = np.array(pts)
M = np.array(majpts)
E0, N1 = P[:, 0].min(), P[:, 1].max()

D = 4  # downsample
out = {}
from shapely.ops import unary_union
byname = {}
for f in streets:
    if f['geometry']:
        g = shape(f['geometry'])
        byname.setdefault(f['properties']['STREET_NAM'].strip(), []).append(g)
def meet(a, b):
    g = unary_union(byname[a]).intersection(unary_union(byname[b]))
    c = g.centroid
    return np.array(T.transform(c.x, c.y))
SEEDS = {'centre': ((1546, 1716), ('NO 3 RD', 'WESTMINSTER HWY')),
         'east': ((894, 1215), ('NO 4 RD', 'WESTMINSTER HWY')),
         'south': ((930, 1194), ('NO 1 RD', 'WILLIAMS RD'))}
for name, img, lo, hi in (('centre', 'byl-000.png', 5.3, 6.2),
                          ('east', 'byl-001.png', 7.6, 10.0),
                          ('south', 'byl-002.png', 3.0, 4.0)):
    (sx, sy), roads = SEEDS[name]
    wE, wN = meet(*roads)
    im = np.asarray(Image.open(img).convert('L')).astype(float)
    H, W = im.shape
    small = (im < 128).reshape(H // D, D, W // D, D).mean(axis=(1, 3)) if H % D == 0 and W % D == 0 \
        else (im[:H - H % D, :W - W % D] < 128).reshape(H // D, D, W // D, D).mean(axis=(1, 3))
    tgt = gaussian_filter(small, 1.5)
    tgt -= tgt.mean()
    best = None
    for mpp in np.arange(lo, hi, 0.02):
        s = mpp * D
        # rasterise streets at this scale with origin at (E0, N1)
        cx = ((M[:, 0] - E0) / s).astype(int)
        cy = ((N1 - M[:, 1]) / s).astype(int)
        w, h = cx.max() + 1, cy.max() + 1
        r = np.zeros((h, w))
        np.add.at(r, (cy, cx), 1.0)
        r = gaussian_filter(np.minimum(r, 1.0), 1.5)
        cc = fftconvolve(tgt, r[::-1, ::-1], mode='full')
        # expected raster offset from the seed: seed world point must land on seed pixel
        ex = int(round(sx / D - (wE - E0) / s)); ey = int(round(sy / D - (N1 - wN) / s))
        kx0, ky0 = ex + (w - 1), ey + (h - 1)
        R = 12
        win = cc[max(0, ky0 - R):ky0 + R + 1, max(0, kx0 - R):kx0 + R + 1]
        kk = np.unravel_index(np.argmax(win), win.shape)
        k = (kk[0] + max(0, ky0 - R), kk[1] + max(0, kx0 - R))
        val = cc[k] / r.sum()
        if best is None or val > best[0]:
            # offset: raster pixel (0,0) lands at image pixel (k - (h-1, w-1))
            oy, ox = k[0] - (h - 1), k[1] - (w - 1)
            best = (val, mpp, ox * D, oy * D)
    val, mpp, ox, oy = best
    # world = E0 + (px - ox)*mpp ; N = N1 - (py - oy)*mpp
    p = np.array([mpp, 0.0, 0.0, -mpp, E0 - ox * mpp, N1 + oy * mpp])
    soft = gaussian_filter((im < 128).astype(float), 2.5)
    def to_pix(q, world):
        a, b, c, d, e, f = q
        L = np.array([[a, c], [b, d]])
        return (world - np.array([e, f])) @ np.linalg.inv(L)
    def score(q):
        pix = to_pix(q, P)
        x, y = pix[:, 0], pix[:, 1]
        ok = (x >= 0) & (y >= 0) & (x < W - 1) & (y < H - 1)
        return -soft[y[ok].astype(int), x[ok].astype(int)].mean() if ok.sum() > 500 else 0.0
    s0 = -score(p)
    scl = np.array([mpp * 0.003] * 4 + [8.0, 8.0])
    res = minimize(lambda z: score(p + z * scl), np.zeros(6), method='Nelder-Mead',
                   options={'xatol': 1e-3, 'fatol': 1e-7, 'maxiter': 3000})
    p = p + res.x * scl
    print(f'{name}: coarse mpp {mpp:.2f} offset ({ox},{oy}); score {s0:.4f} -> {-res.fun:.4f}')
    out[name] = {'image': img, 'params': p.tolist()}
json.dump(out, open('georef.json', 'w'), indent=1)
