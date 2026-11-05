"""Cut one city's federal polling divisions out of the Metro Vancouver layer.

    python3 tools/city_from_metro.py --muni Coquitlam --city "City of Coquitlam" \
        --out boundaries/coquitlam/fed_polls.geojson

Keeps every division of every riding that reaches into the municipality, as
city_polls.py does for a city cut from Elections Canada's file directly, and
tags each division outside it with `jurisdiction` and `locality` (the
municipality it is in), which is all the app reads to keep it out of city
figures. The municipality of a division is the `muni` that
boundaries/metro/fed_polls.geojson already carries. Prints the ridings, so
they can go in the city's CITIES entry.

Standard library only."""
import argparse, collections, json, os


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--metro", default=os.path.join(os.path.dirname(__file__), "..", "boundaries", "metro",
                                                   "fed_polls.geojson"))
    ap.add_argument("--muni", required=True, help='the name in the Metro layer, e.g. "Coquitlam"')
    ap.add_argument("--city", required=True, help='e.g. "City of Coquitlam"')
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    feats = json.load(open(a.metro, encoding="utf-8"))["features"]
    feds = sorted({f["properties"]["fed"] for f in feats if f["properties"].get("muni") == a.muni})
    if not feds:
        raise SystemExit(f'No division has muni "{a.muni}".')
    out, outside = [], collections.Counter()
    for f in feats:
        p = dict(f["properties"])
        if p["fed"] not in feds:
            continue
        where = p.pop("muni", None)
        if where != a.muni:
            where = where or p.get("locality") or "Outside"
            p["jurisdiction"] = f"{where} — outside {a.city}"
            p["locality"] = where
            outside[where] += 1
        out.append({"type": "Feature", "properties": p, "geometry": f["geometry"]})
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    with open(a.out, "w", encoding="utf-8") as fh:
        json.dump({"type": "FeatureCollection", "features": out}, fh, separators=(",", ":"))
    print(f"{a.out}: {len(out)} divisions in {len(feds)} ridings ({', '.join(feds)}); "
          f"{sum(outside.values())} outside {a.city}: "
          + ", ".join(f"{k} {v}" for k, v in outside.most_common()))


if __name__ == "__main__":
    main()
