"""Richmond's 38 voting divisions from the bylaw schedule maps and the street network.

1. On each registered scan, the division lines are the large dark connected
   network (text and the faint street dots are small pieces and are dropped);
   the spaces between them are regions, each named by the division label
   seeded inside it.
2. The city is cut into faces along its street centrelines and its boundary.
3. Each face takes the division most of its interior samples fall in, on
   whichever scan labels it. Faces no scan labels take their neighbours'.
4. Faces are dissolved by division.

Writes richmond_divisions.geojson (lon/lat) and a check image per scan."""
import json
from collections import Counter, defaultdict
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import shape, mapping, Point, box
from shapely.ops import unary_union, polygonize
from shapely import transform as shp_transform, prepared
from pyproj import Transformer

TO = Transformer.from_crs(4326, 26910, always_xy=True)
BACK = Transformer.from_crs(26910, 4326, always_xy=True)
to_utm = lambda g: shp_transform(g, lambda a: np.column_stack(TO.transform(a[:, 0], a[:, 1])))
to_ll = lambda g: shp_transform(g, lambda a: np.column_stack(BACK.transform(a[:, 0], a[:, 1])))

SEEDS = {
    'centre': {'RC13': (1040, 1220), 'RC10': (1670, 1370), 'RC11': (1890, 1620), 'RC16': (1484, 1580),
               'RC15': (1618, 1656), 'RC01': (850, 1710), 'RC05': (1190, 1746), 'RC08': (1466, 1790),
               'RC14': (1682, 1768), 'RC07': (1324, 1864), 'RC12': (1730, 1860), 'RC02': (890, 1932),
               'RC09': (1440, 1930), 'RC06': (1180, 2080), 'RC03': (816, 2072), 'RC04': (1040, 2072)},
    'east': {'RE05': (980, 930), 'RE06': (1290, 1074), 'RE11': (1790, 1174), 'RE01': (718, 1344),
             'RE04': (850, 1400), 'RE02': (760, 1432), 'RE03': (806, 1526), 'RE07': (1210, 1442),
             'RE09': (926, 1700), 'RE08': (800, 1760), 'RE10': (1040, 1870)},
    'south': {'RS09': (1576, 876), 'RS01': (730, 1094), 'RS06': (1454, 1084), 'RS02': (694, 1304),
              'RS04': (1030, 1290), 'RS07': (1370, 1312), 'RS03': (694, 1590), 'RS11': (1030, 1540),
              'RS08': (1480, 1686), 'RS05': (1226, 1796), 'RS10': (1694, 1780)},
}

# Short strokes that close a gap the scan left in a division line, in scan pixels.
GROW = {'centre': 3, 'east': 13, 'south': 14}
PATCHES = {'east': [((1072, 868), (1072, 1042))], 'south': [((1580, 980), (1815, 980))]}

G = json.load(open('georef.json'))
maps = {}
for name, g in G.items():
    im = np.asarray(Image.open(g['image']).convert('L'))
    dark = im < 128
    if name in PATCHES:
        pim = Image.fromarray(dark.astype(np.uint8) * 255)
        dr = ImageDraw.Draw(pim)
        for a_, b_ in PATCHES[name]:
            dr.line([a_, b_], fill=255, width=7)
        dark = np.asarray(pim) > 0
    lab, n = ndimage.label(dark, structure=np.ones((3, 3)))
    sizes = ndimage.sum(dark, lab, index=np.arange(1, n + 1))
    barrier = np.isin(lab, 1 + np.nonzero(sizes > 4000)[0])
    barrier = ndimage.binary_dilation(barrier, iterations=GROW.get(name, 2))
    regions, nr = ndimage.label(~barrier)
    code_of = {}
    for code, (x, y) in SEEDS[name].items():
        # nearest open pixel to the seed: the seed may sit on the label's text
        best = None
        for r in range(0, 60, 2):
            win = regions[max(0, y - r):y + r + 1, max(0, x - r):x + r + 1]
            ids = win[win > 0]
            if ids.size:
                best = Counter(ids.tolist()).most_common(1)[0][0]
                break
        if best is None:
            raise SystemExit(f'{name}: no open pixel near {code}')
        if best in code_of:
            raise SystemExit(f'{name}: {code} and {code_of[best]} fell in one region -- a line has a gap')
        code_of[best] = code
    a, b, c, d, e, f = g['params']
    maps[name] = {'regions': regions, 'code_of': code_of, 'a': a, 'd': d, 'e': e, 'f': f,
                  'shape': regions.shape, 'image': g['image']}
    big = Counter(regions[regions > 0].tolist())
    print(name, f'{nr} regions; seeded {len(code_of)}; seeded sizes',
          {code_of[k]: big[k] for k in code_of})


def label_at(E, N):
    """The division a world point is drawn in, on any scan that labels it."""
    votes = []
    for m in maps.values():
        px = (E - m['e']) / m['a']
        py = (N - m['f']) / m['d']
        H, W = m['shape']
        ok = (px >= 0) & (py >= 0) & (px < W) & (py < H)
        out = np.full(E.shape, None, object)
        rid = np.zeros(E.shape, int)
        rid[ok] = m['regions'][py[ok].astype(int), px[ok].astype(int)]
        for i in np.nonzero(rid)[0]:
            out[i] = m['code_of'].get(rid[i])
        votes.append(out)
    return votes


city = to_utm(shape(json.load(open('city_boundary.geojson'))['features'][0]['geometry']))
# The boundary runs out into the river and the Sturgeon Bank flats; divisions
# are drawn on land only, which is the city's own island outlines inside it.
land = unary_union([to_utm(shape(f['geometry'])).buffer(0)
                    for f in json.load(open('islands.geojson'))['features']])
city = city.buffer(0).intersection(land)
city = unary_union([g for g in getattr(city, 'geoms', [city]) if g.area > 2000])
streets = json.load(open('streets.geojson'))['features']
lines = [to_utm(shape(f['geometry'])) for f in streets
         if f['geometry'] and f['properties']['STR_TYPE'] not in ('Lane', 'Canada Line', 'Tunnel')]
noded = unary_union(lines + [city.boundary])
faces = [p for p in polygonize(noded)]
cityp = prepared.prep(city)
faces = [p.intersection(city) if not cityp.contains(p) else p for p in faces if p.intersects(city)]
faces = [p for p in faces if not p.is_empty and p.area > 1]
# the city less the street faces: land the street network never encloses
rest = city.difference(unary_union(faces))
extra = [g for g in getattr(rest, 'geoms', [rest]) if g.area > 1]
faces += extra
print(f'{len(faces)} faces ({len(extra)} beyond the street network)')

assign = {}
for i, p in enumerate(faces):
    x0, y0, x1, y1 = p.bounds
    step = max(15.0, np.sqrt(p.area / 40))
    xs, ys = np.meshgrid(np.arange(x0 + step / 2, x1, step), np.arange(y0 + step / 2, y1, step))
    pp = prepared.prep(p)
    cand = [(x, y) for x, y in zip(xs.ravel(), ys.ravel()) if pp.contains(Point(x, y))]
    if not cand:
        rp = p.representative_point(); cand = [(rp.x, rp.y)]
    cand = np.array(cand)
    tally = Counter()
    labelled_pts = np.zeros(len(cand), bool)
    for vote in label_at(cand[:, 0], cand[:, 1]):
        tally.update(v for v in vote if v)
        labelled_pts |= np.array([v is not None for v in vote])
    # A face only part of which any scan labels -- the foreshore strip that
    # runs the length of the west dyke, say -- is not given whole to the one
    # division that labels its end. It is shared out cell by cell below.
    if tally and (labelled_pts.mean() >= 0.9 or (p.area < 150000 and labelled_pts.mean() >= 0.35)):
        assign[i] = tally.most_common(1)[0][0]

# Faces nobody labels -- foreshore outside the bylaw's lines, mostly -- are cut
# into 60 m cells and each cell goes to the nearest labelled face, so a long
# strip along the dyke is shared among the divisions beside it rather than
# handed whole to whichever touched it first.
from shapely.strtree import STRtree
labelled = [i for i in assign]
tree = STRtree([faces[i] for i in labelled])
pieces = []
for i in range(len(faces)):
    if i in assign:
        continue
    p = faces[i]
    x0, y0, x1, y1 = p.bounds
    for x in np.arange(x0, x1, 60.0):
        for y in np.arange(y0, y1, 60.0):
            cell = box(x, y, x + 60, y + 60).intersection(p)
            if cell.is_empty or cell.area < 1:
                continue
            rp = cell.representative_point()
            own = [v for vote in label_at(np.array([rp.x]), np.array([rp.y])) for v in vote if v]
            if own:
                pieces.append((Counter(own).most_common(1)[0][0], cell))
                continue
            j = labelled[tree.nearest(rp)]
            pieces.append((assign[j], cell))
print('unlabelled faces shared out:', len([i for i in range(len(faces)) if i not in assign]),
      'as', len(pieces), 'cells')

by = defaultdict(list)
for i, code in assign.items():
    by[code].append(faces[i])
for code, cell in pieces:
    by[code].append(cell)
merged = {code: unary_union(gs).buffer(0.5).buffer(-0.5) for code, gs in by.items()}
# A detached scrap of a division smaller than 2 ha -- a face the scans
# disagreed about -- joins whichever neighbour it shares most border with.
# Islands are kept: they are real land and belong where the bylaw puts them.
for _ in range(3):
    moved = 0
    for code in list(merged):
        g = merged[code]
        parts = sorted(getattr(g, 'geoms', [g]), key=lambda q: -q.area)
        keep = [parts[0]]
        for q in parts[1:]:
            if q.area >= 20000:
                keep.append(q); continue
            best, share = None, 0.0
            for other, og in merged.items():
                if other == code:
                    continue
                l = q.buffer(2).intersection(og).area
                if l > share:
                    best, share = other, l
            if best:
                merged[best] = unary_union([merged[best], q]).buffer(0.5).buffer(-0.5); moved += 1
            else:
                keep.append(q)
        merged[code] = unary_union(keep)
    if not moved:
        break
feats = []
for code in sorted(merged):
    g = merged[code].simplify(4.0)
    feats.append({'type': 'Feature', 'properties': {'id': code},
                  'geometry': mapping(to_ll(g))})
    print(code, round(g.area / 1e6, 2), 'km2', g.geom_type,
          len(getattr(g, 'geoms', [g])), 'parts')
json.dump({'type': 'FeatureCollection', 'features': feats}, open('richmond_divisions.geojson', 'w'))
print('wrote richmond_divisions.geojson; name each division with 5_name.py')
