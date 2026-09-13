"""Assemble the standalone atlas. Everything is inlined -- the libraries, the
stylesheet, the federal boundaries -- so the file works from disk. The only
thing it ever fetches is street-basemap tiles, and it works without them.

    python3 build.py                          the atlas, as committed
    python3 build.py --payload payload/       with data baked in
    python3 build.py --out share/atlas.html   written somewhere else
    python3 build.py --carto-key KEY          opens on a street basemap
    python3 build.py --stamp                  with a build date and commit id

--payload names a directory written by tools/make-payload.js, holding one
subdirectory per dataset. Without it nothing is baked in and every dataset is
loaded from the Data tab as before. Together the two flags build a copy for
people who should not have to prepare data before they can read a map, without
disturbing the committed build."""
import json, os, io, sys, subprocess, datetime

SRC = "src"
def read(p):
    with io.open(p, encoding="utf-8") as fh:
        return fh.read()

def arg(name, fallback=None):
    return sys.argv[sys.argv.index(name) + 1] if name in sys.argv[:-1] else fallback

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
# g9-app-start.js closes the application IIFE that g1 opens, so it stays last
# whatever is added; everything before it shares that one scope.
app     = ["g1-app-core.js", "g2-app-data.js", "g3-app-corr.js",
           "g4-app-turnout.js", "g5-app-census.js", "g6-app-results.js",
           "g7-app-points.js", "g8-app-municipal.js", "ga-app-overview.js",
           "g9-app-start.js"]

# The federal boundaries, exactly as they came out of the original file.
geo = read("boundaries/fed_polls.geojson").strip()
assert json.loads(geo)["type"] == "FeatureCollection"
assert "</script" not in geo.lower()

# Datasets baked into the build, if any have been prepared. Optional on
# purpose: none of this data is in the repository -- it belongs to Elections
# Canada, Elections BC, the City of Vancouver and Statistics Canada -- so a
# fresh clone builds a working atlas with nothing baked in, and every dataset
# is loaded from the Data tab as before.
#
# Run tools/make-payload.js to prepare a directory, then pass it with
# --payload. Each file is inlined with the key that says which loader reads it
# and the filename that loader sees, so a baked-in dataset takes exactly the
# route a file chosen by hand takes.
PAYLOAD_KEYS = ("prov-geo", "da-geo", "db-geo", "geo-attr", "census",
                "fed-results", "prov-results", "prov-electors",
                "muni-places", "muni-results")

def esc(text, where):
    if "</script" in text.lower():
        raise SystemExit(f"{where} contains a closing script tag and cannot be inlined.")
    return text

# A free CARTO key, if this build should open on a street map. Baking one in is
# what makes a copy handed to somebody else show streets without them having to
# get a key of their own; leave it out and the atlas opens on boundaries only,
# which is complete and correct, just plainer.
# A release stamp, so "which copy is this?" has an answer on the page rather
# than in somebody's memory of when they ran the build. The dirty flag is the
# point of it: a build made from a working tree with uncommitted changes cannot
# be reproduced from any commit, and the file should say so rather than carry a
# commit id that does not describe it.
#
# It is deliberately NOT in the committed build. A stamp carries the clock, so
# a build that has one can never be byte-identical to the next one, and CI
# checks that the committed vancouver-boundary-atlas.html still matches a fresh
# build -- a check that exists to catch a stale artifact and would be destroyed
# by a file that differs from itself every minute. A committed artifact needs
# no stamp in any case: it IS the commit, and whoever has it has the repository.
#
# What needs one is a copy handed to somebody, which is what --payload builds,
# so that implies it; --stamp asks for one on a build without a payload.
def _git(*args):
    try:
        out = subprocess.run(("git",) + args, capture_output=True, text=True, timeout=5)
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:
        return ""

want_stamp = "--stamp" in sys.argv or "--payload" in sys.argv
stamp = {
    "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
    "commit": _git("rev-parse", "--short", "HEAD"),
    "dirty": bool(_git("status", "--porcelain")),
}
stamp_block = ('\n<script id="build-stamp" type="application/json">'
               + json.dumps(stamp) + '</script>') if want_stamp else ""

carto_key = arg("--carto-key", "")
carto_block = (f'\n<script id="carto-key-payload" type="text/plain">{esc(carto_key, "--carto-key")}</script>'
               if carto_key else "")

payload_dir = arg("--payload")
payload_blocks, payload_report = "", []
if payload_dir:
    if not os.path.isdir(payload_dir):
        raise SystemExit(f"--payload {payload_dir} is not a directory. Run "
                         "tools/make-payload.js first; its --out is what this wants.")
    for key in PAYLOAD_KEYS:
        folder = os.path.join(payload_dir, key)
        if not os.path.isdir(folder):
            continue
        names = sorted(f for f in os.listdir(folder) if not f.startswith("."))
        for name in names:
            body = esc(read(os.path.join(folder, name)).strip(), f"{key}/{name}")
            payload_blocks += (f'\n<script type="application/json" data-payload="{key}" '
                               f'data-filename="{name}">{body}</script>')
        if names:
            payload_report.append(f"{key} ({len(names)} file{'s' if len(names) > 1 else ''})")
    if not payload_blocks:
        raise SystemExit(
            f"{payload_dir} holds nothing to bake in. It should contain a subdirectory "
            f"per dataset, named one of: {', '.join(PAYLOAD_KEYS)}.")

lib = "\n".join(read(os.path.join(SRC, m)) for m in modules)
# The app body is three files that share one IIFE, so they concatenate into one.
app_src = "\n".join(read(os.path.join(SRC, m)) for m in app)

html = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vancouver Election Atlas</title>
<style>
{leaflet_css}
{design_css}
{atlas_css}
</style>
</head>
<body>
{markup}

<script id="federal-polls" type="application/json">{geo}</script>{stamp_block}{carto_block}{payload_blocks}

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
      + (f"\n  baked in: {', '.join(payload_report)}" if payload_report
         else "\n  nothing baked in — see tools/make-payload.js to carry data inside the file"))
