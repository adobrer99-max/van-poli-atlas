"""Fit each scan so its thick division-boundary lines land on street centrelines.

A distance-to-nearest-street raster is built once in world coordinates (5 m
cells). The scan's thick-line pixels are mapped into the world through the
candidate transform (north up: x scale, y scale, shift) and the truncated mean
distance is minimised. Boundaries along rivers and the coast sit on no street,
which the truncation lets them ignore."""
import json
import numpy as np
from PIL import Image
from scipy.ndimage import distance_transform_edt, binary_opening
from scipy.optimize import minimize
from shapely.geometry import shape
from pyproj import Transformer

T = Transformer.from_crs(4326, 26910, always_xy=True)
streets = json.load(open('streets.geojson'))['features']
segs = []
for f in streets:
    if not f['geometry'] or f['properties']['STR_TYPE'] in ('Lane', 'CulDeSac', 'Canada Line'):
        continue
    g = shape(f['geometry'])
    for part in getattr(g, 'geoms', [g]):
        segs.append(np.array([T.transform(x, y) for x, y, *_ in part.coords]))
allxy = np.vstack(segs)
CELL = 5.0
E0, N0 = allxy[:, 0].min() - 2000, allxy[:, 1].min() - 2000
E1, N1 = allxy[:, 0].max() + 2000, allxy[:, 1].max() + 2000
GW, GH = int((E1 - E0) / CELL) + 1, int((N1 - N0) / CELL) + 1
grid = np.zeros((GH, GW), bool)
for xy in segs:
    for (x0, y0), (x1, y1) in zip(xy[:-1], xy[1:]):
        n = max(2, int(np.hypot(x1 - x0, y1 - y0) / (CELL / 2)))
        xs = np.linspace(x0, x1, n); ys = np.linspace(y0, y1, n)
        grid[((ys - N0) / CELL).astype(int), ((xs - E0) / CELL).astype(int)] = True
dist = distance_transform_edt(~grid) * CELL  # metres

G = json.load(open('georef.json'))
for name, g in G.items():
    im = np.asarray(Image.open(g['image']).convert('L'))
    dark = im < 110
    thick = binary_opening(dark, structure=np.ones((5, 5)))
    ys, xs = np.nonzero(thick)
    # drop the page furniture: titles and footers sit outside the map frame
    sel = (ys > 600) & (ys < 2800)
    xs, ys = xs[sel][::3].astype(float), ys[sel][::3].astype(float)
    p0 = np.array(g['params'])
    m = abs(p0[0])
    def world(z):
        sx, sy = m * (1 + z[0] * 0.01), m * (1 + z[1] * 0.01)
        e, f = p0[4] + z[2] * 20, p0[5] + z[3] * 20
        return e + sx * xs, f - sy * ys, (sx, sy, e, f)
    def cost(z, cap):
        E, N, _ = world(z)
        gx = np.clip(((E - E0) / CELL).astype(int), 0, GW - 1)
        gy = np.clip(((N - N0) / CELL).astype(int), 0, GH - 1)
        return np.minimum(dist[gy, gx], cap).mean()
    z = np.zeros(4)
    for cap in (300, 150, 80, 40, 25):
        r = minimize(lambda v: cost(v, cap), z, method='Powell',
                     options={'xtol': 1e-4, 'ftol': 1e-7, 'maxiter': 20000})
        z = r.x
    E, N, (sx, sy, e, f) = world(z)
    gx = np.clip(((E - E0) / CELL).astype(int), 0, GW - 1)
    gy = np.clip(((N - N0) / CELL).astype(int), 0, GH - 1)
    d = dist[gy, gx]
    print(f'{name}: m/px {sx:.3f} x {sy:.3f}; thick pixels within 15 m of a street '
          f'{(d < 15).mean():.0%}, within 40 m {(d < 40).mean():.0%}; median {np.median(d):.0f} m')
    g['params'] = [sx, 0.0, 0.0, -sy, e, f]
json.dump(G, open('georef.json', 'w'), indent=1)
