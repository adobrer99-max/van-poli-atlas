"""Assemble the standalone atlas. Everything is inlined -- the libraries, the
stylesheet, the federal boundaries -- so the file works from disk. The only
thing it ever fetches is street-basemap tiles, and it works without them.

    python3 build.py                      the atlas, as committed
    python3 build.py --census census-payload/   with a census layer baked in
    python3 build.py --out share/atlas.html     written somewhere else

--census names a directory holding census_da.geojson and census_starter.csv,
as written by tools/make-census-payload.js. Without it the census layer is
loaded from the Data tab as before. Together the two flags build a copy for
people who should not have to prepare data before they can read a map, without
disturbing the committed build."""
import json, os, io, sys

SRC = "src"
def read(p):
    with io.open(p, encoding="utf-8") as fh:
        return fh.read()

leaflet_css = read(SRC + "/leaflet.css")
leaflet_js  = read(SRC + "/leaflet.js")
design_css = read(SRC + "/design.css")
atlas_css  = read(SRC + "/i-atlas.css")
d3_js      = read(SRC + "/d3.js")
tabs_js    = read(SRC + "/tabs.js")
markup     = read(SRC + "/h-markup.html")

modules = ["a-geo.js", "b-text.js", "c-binary.js", "d-ingest.js",
           "e-analysis.js", "f-results.js", "f2-turnout.js", "f3-census.js",
           "f4-places.js", "f5-summary.js", "f6-points.js", "f7-municipal.js"]
app     = ["g1-app-core.js", "g2-app-data.js", "g3-app-corr.js",
           "g4-app-turnout.js", "g5-app-census.js", "g6-app-results.js",
           "g7-app-points.js", "g8-app-municipal.js", "g9-app-start.js"]

# The federal boundaries, exactly as they came out of the original file.
geo = read("boundaries/fed_polls.geojson").strip()
assert json.loads(geo)["type"] == "FeatureCollection"
assert "</script" not in geo.lower()

# The census layer, if it has been prepared. Optional on purpose: the boundary
# and profile downloads are Statistics Canada's and are not in this repository,
# so a fresh clone builds a working atlas without them and the census layer is
# loaded from the Data tab as before. Run tools/make-census-payload.js to bake
# it in, and everyone who opens the file gets it without loading anything.
def arg(name, fallback=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else fallback

def optional(path):
    return read(path).strip() if os.path.exists(path) else None

census_dir = arg("--census", "boundaries")
census_geo = optional(os.path.join(census_dir, "census_da.geojson"))
census_starter = optional(os.path.join(census_dir, "census_starter.csv"))
census_blocks = ""
if census_geo and census_starter:
    assert json.loads(census_geo)["type"] == "FeatureCollection"
    for name, payload in (("census_da.geojson", census_geo), ("census_starter.csv", census_starter)):
        assert "</script" not in payload.lower(), f"{name} contains a closing script tag"
    census_blocks = (
        f'\n<script id="census-da" type="application/json">{census_geo}</script>'
        f'\n<script id="census-starter" type="text/csv">{census_starter}</script>')
elif census_geo or census_starter:
    missing = "census_starter.csv" if census_geo else "census_da.geojson"
    raise SystemExit(
        f"{os.path.join(census_dir, missing)} is missing, so the census layer was NOT baked in.\n"
        "Both halves are needed -- boundaries with no variables draw an empty map, and\n"
        "variables with no boundaries have nothing to join to. Run:\n"
        "    node tools/make-census-payload.js --in census/")

lib = "\n".join(read(os.path.join(SRC, m)) for m in modules)
# The app body is three files that share one IIFE, so they concatenate into one.
app_src = "\n".join(read(os.path.join(SRC, m)) for m in app)

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vancouver federal &amp; provincial poll atlas</title>
<style>
{leaflet_css}
{design_css}
{atlas_css}
</style>
</head>
<body>
{markup}

<script id="federal-polls" type="application/json">{geo}</script>{census_blocks}

<script>{leaflet_js}</script>
<script>{d3_js}</script>
<script>
{lib}
</script>
<script>
{tabs_js}
</script>
<script>
{app_src}
</script>
</body>
</html>
"""

out = arg("--out", "vancouver-boundary-atlas.html")
os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
with io.open(out, "w", encoding="utf-8") as fh:
    fh.write(html)
print(f"{out}: {os.path.getsize(out):,} bytes"
      + (f" (census layer baked in: {len(census_geo):,} + {len(census_starter):,} bytes)"
         if census_blocks else " (no census layer: run tools/make-census-payload.js to bake one in)"))
