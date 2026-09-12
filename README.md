# van-poli-atlas

GeoJSON atlas for the City of Vancouver — a single self-contained HTML file for
comparing federal and provincial voting poll by poll.

`vancouver-boundary-atlas.html` opens straight from disk: no server, no build
step, no account. It carries the 2025 federal polling divisions (1,406 polygons,
Elections Canada) inline and draws provincial voting areas over them once you
load a boundary file. Boundaries, results and every analysis work offline; the
only thing the page fetches from the web is the street basemap, and that can be
switched off.

## Using it

Open the file in a browser, then work through the **Data** tab:

1. **Provincial voting-area boundaries** — from
   [Elections BC GIS spatial data](https://elections.bc.ca/resources/maps/gis-spatial-data/)
   or the [BC Data Catalogue](https://catalogue.data.gov.bc.ca/). A zipped
   shapefile (`.shp` + `.dbf` + `.prj`), `.kml`, `.kmz` or `.geojson` all work.
   BC Albers (EPSG:3005), UTM zone 10N and lon/lat are converted automatically.
2. **Federal results** — Elections Canada's
   `pollresults_resultatsbureau<riding>.csv`, one riding at a time or zipped.
3. **Provincial results** — Elections BC results by voting area, in either long
   (one row per candidate) or wide (one column per party) form.

Files are read in the browser tab. Nothing is uploaded anywhere.

The **Map** tab overlays the two geographies on a street basemap and reads out
the federal polling division and the provincial voting area at whatever point
you click. Each layer
is shaded by its own election's results — party share or turnout — and the
federal layer can also carry provincial results redistributed through the
crosswalk. The **Correlation** tab builds the crosswalk and plots one vote share
against the other. The **Turnout** tab ranks every area by turnout combined
across both elections, draws the "top X % of areas hold Y % of electors" curve,
pools any set of areas into a basket, and exports the ranking. The **Method**
tab states the assumptions; read it before quoting a coefficient.

## Basemap

The map is drawn with [Leaflet](https://leafletjs.com). Street tiles come from
CARTO's Positron (light) and Dark Matter basemaps, which follow the page's
light or dark theme, or from OpenStreetMap's standard style; all are built on
OpenStreetMap data. Tiles are requested from the provider while the page is
open and are never bundled. Each tile request is an ordinary web request to
the provider's servers: like any web request it carries your IP address,
browser identification and request headers, together with the coordinates of
the tile, which reveal the area and zoom level on screen. That data is handled
under the provider's privacy policy (CARTO, or the OpenStreetMap Foundation).
Nothing else is sent: your boundary and results files never leave the machine.
If the tiles do not load, the map says so and keeps working — choose **None**
under Basemap to make no requests at all and work fully offline. The
attribution in the map's corner is required by the providers' terms; leave it
in place.

## Turnout

Turnout is ballots cast (valid plus rejected) over electors, per poll or voting
area, computed on demand from counts that move through the crosswalk together —
so turnout on any common geography is the electors-weighted mean of the polls
that feed it. Three things Elections Canada's files do that the reader handles:

- **Merged polls** report both polls' ballots under the receiving poll. The
  merge group is pooled and spread back pro rata to each member's electors.
- **Void polls** and polls where no vote was held carry nothing and are
  excluded.
- **Advance polls and special ballots** have no boundary. By default they are
  left out (election-day turnout, which understates areas whose residents vote
  early). Optionally they are apportioned back onto each district's mapped polls,
  by ballots or by electors; both are labelled as estimates.

## Why there is a crosswalk

Federal polling divisions and provincial voting areas are drawn by different
agencies and share no boundaries, so results cannot be joined on a key. The
atlas samples a lattice of equal-area points to measure how much of each
federal division lies inside each voting area, then splits votes in those
proportions. That assumes votes are spread evenly within a poll — the standard
areal-interpolation assumption, and the main caveat on every figure it reports.

Three things the code handles that are easy to get wrong:

- **Mobile polls.** Elections Canada type M polls (numbered from 500) have
  token polygons a few metres across, not catchments. They are off the map by
  default. Any polygon too small for the lattice to sample reliably is assigned
  whole to the unit containing an interior point, so its votes are never
  silently dropped — without that, 48 downtown and care-home polls disappear.
- **Slivers.** Two agencies digitise the same street differently, producing
  hairline overlaps that hold no voters and that a lattice estimates worst.
  Overlaps below a threshold are dropped and the rest rescaled to carry exactly
  the vote mass the slivers held, so nothing leaks.
- **Advance polls.** They have no boundary in either geography. Whenever
  results load, the Data tab reports what fraction of the file's votes landed in
  a mapped poll. Quote that number alongside any correlation.

## Rebuilding

```sh
python3 build.py                     # writes vancouver-boundary-atlas.html
```

`boundaries/fed_polls.geojson` is the federal layer the build inlines. The
built file is committed, and CI fails when it is out of date, so rebuild before
committing a change under `src/` or `boundaries/`.

`src/` holds the parts: `a-geo.js` (projections, point-in-polygon, spatial
index), `b-text.js` (delimited text, XML, KML), `c-binary.js` (ZIP, DBF, SHP),
`d-ingest.js` (format dispatch and reprojection), `e-analysis.js` (crosswalk and
statistics), `f-results.js` (results joining), `f2-turnout.js` (turnout,
apportionment, ranking), `g1`–`g4` and `g9` (the application, one shared
scope), plus the shared stylesheet and two vendored libraries: d3 v7 for the
charts and Leaflet 1.9.4 for the map. The Leaflet files are the unmodified
`dist/leaflet.js` and `dist/leaflet.css` from `npm pack leaflet@1.9.4`; to
upgrade, repeat that and replace the two files.

## Tests

```sh
npm ci                               # Playwright, pinned in package-lock.json
npx playwright install chromium      # once per machine; only the browser suites need it
npm run fixtures                     # writes fixtures/: real SHP/DBF/PRJ/KMZ + e2e files
npm test                             # the node suites, then the two browser suites
```

`npm run test:node` runs only the node suites (no browser needed);
`npm run test:browser` only the Playwright ones; any single suite runs as
`node tests/test-geo.js` and so on. `tests/run.js` stops at the first failing
suite. GitHub Actions (`.github/workflows/ci.yml`) runs exactly these steps on
every pull request, plus a check that the committed
`vancouver-boundary-atlas.html` matches a fresh build.

330+ assertions. The browser suites drive the real page in Chromium through
Playwright: loading each boundary format, joining results, building the
crosswalk, ranking turnout, exporting CSV, dark mode, phone-width layout, and
the basemap with tile requests stubbed — including a run where every tile
fails, to check the atlas carries on without them.

The projection is checked against control points produced by an independent
forward implementation in `tests/make-fixtures.py`, and separately by the
equal-area property — planar area against geodesic area, computed by unrelated
code paths, agreeing to better than 0.05%.

## Licence

This repository is not under a single licence. See [NOTICE](NOTICE) for the
full statement.

- **Code** in `src/` (excluding the vendored `d3.js`, `leaflet.js` and
  `leaflet.css`), `build.py` and `tests/` — GPL v3, per [LICENSE](LICENSE).
- **`src/d3.js`** — D3 v7.9.0, © 2010–2023 Mike Bostock, ISC licence. Vendored
  unmodified; its copyright line is the first line of the file and is carried
  into the built HTML.
- **`src/leaflet.js`, `src/leaflet.css`** — Leaflet 1.9.4, © 2010–2023
  Volodymyr Agafonkin, © 2010–2011 CloudMade, BSD 2-Clause licence. Vendored
  unmodified; the copyright header is carried into the built HTML.
- **Street basemap tiles** — © OpenStreetMap contributors (ODbL), © CARTO.
  Fetched from the providers at runtime under their own terms; never
  redistributed here.
- **`boundaries/fed_polls.geojson`** — derived from Elections Canada, Polling
  Division Boundaries 2025, under the
  [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada).
  Not a GPL work.
- **Provincial boundaries and election results** are never redistributed here.
  They are loaded at runtime from files you download yourself, under whatever
  terms Elections BC and Elections Canada attach to them.
