#!/usr/bin/env python3
"""Cut a GeoJSON boundary file down to the study area or to chosen districts.

Written for the Elections BC voting-area download ordered from the BC Data
Catalogue (WHSE_ADMIN_BOUNDARIES.EBC_VOTING_AREAS_BS11_POLY_SVW, delivered as a
.zip holding one .geojson for the whole province, about 100 MB), but any
GeoJSON FeatureCollection works. Standard library only.

    python3 tools/clip_geojson.py ORDER.zip --list
    python3 tools/clip_geojson.py ORDER.zip --study-area --out va_vancouver.geojson
    python3 tools/clip_geojson.py ORDER.zip --ed VHA VKE VLA VLM VNP --out five.geojson
    python3 tools/clip_geojson.py ORDER.zip --bbox -123.30 49.19 -123.02 49.32 --out box.geojson

--study-area keeps every area whose bounding box touches the City of
Vancouver federal ridings (the atlas's default study area) plus --pad-km;
--like does the same for the extent of any other GeoJSON. Filters given
together all have to pass. Properties and coordinates are written unchanged
unless --precision is given.
"""
import argparse
import collections
import json
import math
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
FED_POLLS = os.path.join(HERE, "..", "boundaries", "fed_polls.geojson")
# The federal electoral districts the atlas treats as the City of Vancouver
# (with UBC and the University Endowment Lands); the same set as the map's
# area filter.
VANCOUVER_FEDS = {"59035", "59036", "59037", "59038", "59039", "59040"}


def read_geojson(path):
    """The file itself, or the first .geojson (failing that, .json) inside a zip."""
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            names = [n for n in z.namelist() if not os.path.basename(n).startswith(".")]
            pick = (next((n for n in names if n.lower().endswith(".geojson")), None)
                    or next((n for n in names if n.lower().endswith(".json")), None))
            if not pick:
                sys.exit(f"{path}: no .geojson inside the archive (members: {', '.join(names[:8])})")
            with z.open(pick) as fh:
                return json.load(fh), pick
    with open(path, "rb") as fh:
        return json.load(fh), os.path.basename(path)


def walk(coords, out):
    if isinstance(coords[0], (int, float)):
        out.append(coords)
    else:
        for c in coords:
            walk(c, out)


def bbox(geometry):
    pts = []
    walk(geometry["coordinates"], pts)
    return (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))


def union(boxes):
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def touches(a, b):
    return a[2] >= b[0] and a[0] <= b[2] and a[3] >= b[1] and a[1] <= b[3]


def padded(box, km):
    dlat = km * 1000 / 110574
    dlon = km * 1000 / (111320 * math.cos(math.radians((box[1] + box[3]) / 2)))
    return (box[0] - dlon, box[1] - dlat, box[2] + dlon, box[3] + dlat)


def extent_of(path, feds=None):
    """Extent of a GeoJSON's polygons; with feds, only the federal ridings named."""
    with open(path, "rb") as fh:
        doc = json.load(fh)
    boxes = []
    for f in doc.get("features", []):
        if not f.get("geometry"):
            continue
        p = f.get("properties") or {}
        if feds is not None and (p.get("fed") not in feds or "jurisdiction" in p):
            continue
        boxes.append(bbox(f["geometry"]))
    if not boxes:
        sys.exit(f"{path}: no polygons to take an extent from")
    return union(boxes)


def rounded(coords, digits):
    if isinstance(coords[0], (int, float)):
        return [round(v, digits) for v in coords]
    return [rounded(c, digits) for c in coords]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter, epilog=__doc__)
    ap.add_argument("input", help="a .geojson, or a .zip holding one (a BC Data Catalogue order)")
    ap.add_argument("--out", help="where to write the clipped GeoJSON")
    ap.add_argument("--study-area", action="store_true",
                    help="keep areas touching the City of Vancouver federal ridings plus --pad-km")
    ap.add_argument("--like", metavar="GEOJSON", help="keep areas touching the extent of this file plus --pad-km")
    ap.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"),
                    help="keep areas touching this lon/lat box")
    ap.add_argument("--ed", nargs="+", metavar="CODE", help="keep these district codes (see --list)")
    ap.add_argument("--property", default="ED_ABBREVIATION", help="property holding the district code")
    ap.add_argument("--pad-km", type=float, default=2.0, help="padding around --study-area and --like (default 2)")
    ap.add_argument("--precision", type=int, metavar="DIGITS", help="round coordinates (7 is about 1 cm)")
    ap.add_argument("--list", action="store_true", help="print district codes with counts and extents, then stop")
    ap.add_argument("--fed-polls", default=FED_POLLS, help=argparse.SUPPRESS)
    a = ap.parse_args(argv)

    doc, member = read_geojson(a.input)
    feats = [f for f in doc.get("features", []) if f.get("geometry")]
    if not feats:
        sys.exit(f"{member}: no features with geometry")
    print(f"{member}: {len(feats):,} features")

    box = None
    if a.study_area:
        box = padded(extent_of(a.fed_polls, VANCOUVER_FEDS), a.pad_km)
    if a.like:
        b = padded(extent_of(a.like), a.pad_km)
        box = b if box is None else (max(box[0], b[0]), max(box[1], b[1]), min(box[2], b[2]), min(box[3], b[3]))
    if a.bbox:
        b = tuple(a.bbox)
        box = b if box is None else (max(box[0], b[0]), max(box[1], b[1]), min(box[2], b[2]), min(box[3], b[3]))
    if box:
        print("clip box: W {:.5f} S {:.5f} E {:.5f} N {:.5f}".format(*box))

    boxes = [bbox(f["geometry"]) for f in feats]
    codes = [str((f.get("properties") or {}).get(a.property, "")) for f in feats]

    if a.list:
        per = collections.defaultdict(list)
        for f, b, c in zip(feats, boxes, codes):
            per[c].append(b)
        print(f"{'code':<10}{'areas':>6}{'in box':>8}   extent (W S E N)")
        for c in sorted(per):
            inside = sum(1 for b in per[c] if box and touches(b, box))
            e = union(per[c])
            print(f"{c:<10}{len(per[c]):>6}{(inside if box else ''):>8}   {e[0]:.4f} {e[1]:.4f} {e[2]:.4f} {e[3]:.4f}")
        return 0

    wanted = set(a.ed) if a.ed else None
    kept = []
    for f, b, c in zip(feats, boxes, codes):
        if wanted is not None and c not in wanted:
            continue
        if box and not touches(b, box):
            continue
        kept.append(f)
    if not kept:
        sys.exit("nothing kept: no feature passes the filters (try --list to see the district codes)")
    if wanted:
        missing = sorted(wanted - set(codes))
        if missing:
            print(f"warning: no features carry {a.property} in {missing}", file=sys.stderr)
    if a.precision is not None:
        for f in kept:
            f["geometry"]["coordinates"] = rounded(f["geometry"]["coordinates"], a.precision)

    counts = collections.Counter(str((f.get("properties") or {}).get(a.property, "")) for f in kept)
    print(f"kept {len(kept):,} of {len(feats):,} features in {len(counts)} district(s): "
          + ", ".join(f"{c} {n}" for c, n in sorted(counts.items())))
    if not a.out:
        print("no --out given; nothing written")
        return 0
    out = {k: v for k, v in doc.items() if k != "features"}
    out["features"] = kept
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {a.out}: {os.path.getsize(a.out):,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
