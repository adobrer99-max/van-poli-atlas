"""Make a city's federal polling divisions file, the base layer the atlas draws.

    python3 tools/city_polls.py --polls polls.geojson --boundary city.geojson \
        --city "City of Richmond" --out boundaries/richmond/fed_polls.geojson

--polls is Elections Canada's 2025 polling divisions for the city's ridings,
already cut down and converted to lon/lat GeoJSON, for example with

    mapshaper PD_CA_2025_EN.shp -filter 'FED_NUM==59027||FED_NUM==59028' \
        -proj wgs84 -clip land.geojson -simplify 12% keep-shapes \
        -o format=geojson precision=0.00001 polls.geojson

Elections Canada's divisions run out over the water; land.geojson is the land
to keep (for Richmond, the City of Richmond's island outlines, which include
the Vancouver shore for Marpole).

--boundary is the city's own outline as GeoJSON in lon/lat.

Each division is written the way boundaries/fed_polls.geojson writes them:
`fed`, `poll` ("125-0"), `type` and, where Elections Canada gives one, `adv`
(the advance poll it reported to). A division whose representative point falls
outside the city boundary is tagged with `jurisdiction` and `locality`, which
is all the app reads to keep it out of city figures. For Richmond that is
Marpole, which shares Richmond Centre--Marpole but is in Vancouver.

--localities names the parts of the area (Metro Vancouver's municipalities):
each division inside the boundary gets `muni`, the locality holding its
representative point, so the Area control can show one city at a time.

Standard library only, so it runs anywhere the build does."""
import argparse, json, os


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"]]
    if geom["type"] == "MultiPolygon":
        return geom["coordinates"]
    return []


def in_ring(x, y, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def in_geom(x, y, geom):
    for poly in rings_of(geom):
        if poly and in_ring(x, y, poly[0]) and not any(in_ring(x, y, h) for h in poly[1:]):
            return True
    return False


def inner_point(geom):
    """A point inside the polygon: the middle of the widest run of a horizontal
    line through the bounding box's centre, tried at a few heights."""
    polys = rings_of(geom)
    ys = [p[1] for poly in polys for p in poly[0]]
    xs = [p[0] for poly in polys for p in poly[0]]
    if not ys:
        return None
    y0, y1 = min(ys), max(ys)
    best = None
    for t in (0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8):
        y = y0 + (y1 - y0) * t
        cuts = []
        for poly in polys:
            for ring in poly:
                for i in range(len(ring) - 1):
                    (ax, ay), (bx, by) = ring[i][:2], ring[i + 1][:2]
                    if (ay > y) != (by > y):
                        cuts.append(ax + (y - ay) * (bx - ax) / (by - ay))
        cuts.sort()
        for i in range(0, len(cuts) - 1, 2):
            w = cuts[i + 1] - cuts[i]
            if best is None or w > best[0]:
                best = (w, ((cuts[i] + cuts[i + 1]) / 2, y))
        if best:
            return best[1]
    return ((min(xs) + max(xs)) / 2, (y0 + y1) / 2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--polls", required=True)
    ap.add_argument("--boundary", required=True)
    ap.add_argument("--city", required=True, help='e.g. "City of Richmond"')
    ap.add_argument("--outside-locality", default="",
                    help="the municipality the outside divisions are in, e.g. Vancouver")
    ap.add_argument("--outside-label", default="",
                    help='e.g. "Marpole"; the readout prints "<label> — outside <city>"')
    ap.add_argument("--outside-by-fed", default="",
                    help='per-riding names for the outside divisions, e.g. '
                         '"59032=White Rock,59011=Delta"; the rest use --outside-label')
    ap.add_argument("--localities", default="",
                    help="GeoJSON of named areas inside the boundary (for Metro Vancouver, its "
                         "municipalities); each division inside the boundary gets `muni`, the name "
                         "of the one holding its representative point")
    ap.add_argument("--locality-field", default="name")
    ap.add_argument("--unnamed", default="",
                    help='`muni` for a division inside the boundary but in no locality, e.g. '
                         '"Electoral Area A and reserves"')
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    with open(a.polls, encoding="utf-8") as fh:
        polls = json.load(fh)["features"]
    with open(a.boundary, encoding="utf-8") as fh:
        city = [f["geometry"] for f in json.load(fh)["features"]]

    parts = []
    if a.localities:
        with open(a.localities, encoding="utf-8") as fh:
            parts = [(f["properties"][a.locality_field], f["geometry"]) for f in json.load(fh)["features"]]
    by_fed = dict(kv.split("=", 1) for kv in a.outside_by_fed.split(",") if "=" in kv)
    out, outside = [], 0
    for f in polls:
        p = f["properties"]
        props = {"fed": str(p["FED_NUM"]), "poll": str(p["PD_NUM_SFX"]), "type": str(p["PD_TYPE"])}
        adv = str(p.get("ADV_POLL_N") or "").strip()
        if adv:
            props["adv"] = adv
        pt = inner_point(f["geometry"])
        if pt and not any(in_geom(pt[0], pt[1], g) for g in city):
            outside += 1
            named = by_fed.get(str(p["FED_NUM"]))
            label = named or a.outside_label or a.outside_locality or "Outside"
            props["jurisdiction"] = f"{label} \u2014 outside {a.city}"
            if named or a.outside_locality:
                props["locality"] = named or a.outside_locality
        elif pt and parts:
            hit = next((n for n, g in parts if in_geom(pt[0], pt[1], g)), None)
            if hit or a.unnamed:
                props["muni"] = hit or a.unnamed
        out.append({"type": "Feature", "properties": props, "geometry": f["geometry"]})

    out.sort(key=lambda f: (f["properties"]["fed"], int(f["properties"]["poll"].split("-")[0]),
                            f["properties"]["poll"]))
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": out}, fh, separators=(",", ":"))
    print(f"{a.out}: {len(out)} divisions, {outside} outside {a.city}, "
          f"{os.path.getsize(a.out):,} bytes")


if __name__ == "__main__":
    main()
