"""Assemble the standalone atlas. Everything is inlined so the file works
offline, from disk, with no network access of any kind."""
import json, os, io

SRC = "src"
def read(p):
    with io.open(p, encoding="utf-8") as fh:
        return fh.read()

design_css = read(SRC + "/design.css")
atlas_css  = read(SRC + "/i-atlas.css")
d3_js      = read(SRC + "/d3.js")
tabs_js    = read(SRC + "/tabs.js")
markup     = read(SRC + "/h-markup.html")

modules = ["a-geo.js", "b-text.js", "c-binary.js", "d-ingest.js",
           "e-analysis.js", "f-results.js", "f2-turnout.js"]
app     = ["g1-app-core.js", "g2-app-data.js", "g3-app-corr.js",
           "g4-app-turnout.js", "g9-app-start.js"]

# The federal boundaries, exactly as they came out of the original file.
geo = read("boundaries/fed_polls.geojson").strip()
assert json.loads(geo)["type"] == "FeatureCollection"
assert "</script" not in geo.lower()

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
{design_css}
{atlas_css}
</style>
</head>
<body>
{markup}

<script id="federal-polls" type="application/json">{geo}</script>

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

out = "vancouver-boundary-atlas.html"
with io.open(out, "w", encoding="utf-8") as fh:
    fh.write(html)
print(f"{out}: {os.path.getsize(out):,} bytes")
